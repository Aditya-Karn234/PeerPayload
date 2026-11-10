package com.peerpayload.connect.core

import com.peerpayload.connect.engine.EngineRun
import com.peerpayload.connect.engine.Program
import com.peerpayload.connect.engine.event
import com.peerpayload.connect.net.ReceiverBridge
import com.peerpayload.connect.net.ReverseBridge
import com.peerpayload.connect.net.ReverseDialer
import com.peerpayload.connect.net.newReverseKey
import com.peerpayload.connect.net.RelayAccess
import com.peerpayload.connect.net.SenderBridge
import com.peerpayload.connect.net.probeTcp
import com.peerpayload.connect.protocol.FileSummary
import com.peerpayload.connect.protocol.Identity
import com.peerpayload.connect.protocol.MAX_OFFER_NAMES
import com.peerpayload.connect.protocol.Message
import com.peerpayload.connect.protocol.Opened
import com.peerpayload.connect.protocol.issueDeviceTicket
import com.peerpayload.connect.protocol.parseMessage
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.Serializable
import kotlinx.serialization.Transient
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import kotlinx.serialization.json.longOrNull
import okhttp3.OkHttpClient
import java.io.File
import java.net.Inet4Address
import java.net.Inet6Address
import java.net.NetworkInterface
import java.net.ServerSocket
import java.security.SecureRandom
import java.util.Base64

// Connect file transfers between paired devices: the Kotlin port of
// connect/core/transfers.js, speaking the same messages
// (protocol/messages.js) and keeping the same states, so Android and
// desktop interoperate:
//
//   sender   -> offer (resume: true to continue an interrupted one)
//   receiver -> accept (where to connect, engine token) | decline
//   sender   -> cancel (gave up)
//   either   -> cancel { paused: true } (stopped a running transfer; resumable)
//   either   -> cancel { removed: true } (deleted it, or never had it: the
//               other side ends its copy for good)
//   receiver -> resume-request (one nobody answers goes back to interrupted)
//   sender   -> reverse (couldn't reach the receiver: it dials out to the
//               sender instead, see net/ReverseBridge.kt)
//
// The bytes go engine to engine, mutually authenticated with the two
// device certificates: direct when an advertised address answers,
// otherwise through the relay. History is kept in transfers.json.
//
// Android specifics are passed in: outgoing files are app-private copies
// (the app copies what the user picked; [Transfer.outgoingDir] is deleted
// once the transfer can't be resumed), and [deliver] moves a finished
// incoming transfer out of its staging folder (into Downloads).

const val OFFER_TIMEOUT_MS = 10 * 60 * 1000L

// How long a sender waits for the receiver to dial back after a `reverse`
// message before using the relay (transfers.js REVERSE_WAIT_MS).
private const val REVERSE_WAIT_MS = 8000L
private const val CHUNK_SIZE = 1024 * 1024 // see transfers.js: ~7x faster than 64 KiB on a LAN
private const val MAX_HISTORY = 200

// client-core/transferPolicy.js
private const val MAX_SEND_ATTEMPTS = 4
private const val RECEIVER_MAX_RETRIES = MAX_SEND_ATTEMPTS - 1
private const val RECEIVER_LISTEN_TIMEOUT_SEC = 120
private val RETRY_DELAYS_MS = listOf(2000L, 5000L, 10000L)
private const val DIRECT_PROBE_TIMEOUT_MS = 3000
private val RETRYABLE_REASONS = setOf(
    "peer_timeout", "ack_receive_failed", "chunk_send_failed", "chunk_mismatch", "file_header_send_failed",
    "resume_handshake_failed", "eof_marker_send_failed", "eof_confirmation_failed", "session_send_failed", "no_session_response",
)
private val RETRYABLE_AFTER_CONNECT = setOf("connection_failed", "tls_handshake_failed")
private val SWITCH_TO_RELAY_REASONS = setOf("connection_failed", "tls_pin_mismatch", "tls_handshake_failed")

private val ACTIVE_STATES = setOf("offered", "sending", "receiving")

@Serializable
data class StoredFile(val name: String, val size: Long, val files: Long)

@Serializable
data class Progress(val bytes: Long, val total: Long, val resumedBytes: Long = 0)

@Serializable
data class Transfer(
    val transferId: String,
    val direction: String, // "in" | "out"
    val peer: String,
    val peerName: String,
    val files: List<StoredFile>,
    val fileCount: Long,
    val totalBytes: Long,
    val state: String,
    val error: String? = null,
    val createdAt: Long,
    val updatedAt: Long = createdAt,
    val started: Boolean = false,
    val ended: Boolean = false, // ended for good: the other side removed it
    val path: String? = null, // "direct" | "relay"
    val paths: List<String> = emptyList(), // sender: what the engine sends
    val outgoingDir: String? = null, // sender: app-private copies, deleted when done
    val stagingDir: String? = null, // receiver: where the engine writes
    val savedAs: List<String>? = null,
    @Transient val progress: Progress? = null,
    @Transient val retry: String? = null,
) {
    /** Got going but didn't finish, and nobody said no: can be picked up again. */
    val resumable: Boolean get() = started && !ended && state in setOf("failed", "cancelled", "interrupted", "waiting")
    val active: Boolean get() = state in ACTIVE_STATES || state == "waiting"
}

class TransferException(message: String) : Exception(message)

private class Answer(val message: Message)
private class OfferCancelled : Exception("cancelled")

class Transfers(
    private val identity: Identity,
    private val device: DeviceFiles,
    private val contacts: Contacts,
    private val http: OkHttpClient,
    private val scope: CoroutineScope,
    private val sendMessage: suspend (fp: String, Message) -> Unit,
    private val relayUrl: String?,
    private val incomingRoot: File,
    private val deliver: (staging: File) -> List<String>,
    private val log: (String) -> Unit = {},
) {
    private val file = File(device.dir, "transfers.json")
    private val records = LinkedHashMap<String, Transfer>()
    private val waiters = HashMap<String, CompletableDeferred<Answer>>()
    private val engines = HashMap<String, EngineRun>() // running engine per transfer
    private val pausing = HashSet<String>()
    private val probeNotes = HashMap<String, String>() // transferId -> what the direct probe found, for failures
    private val enginePorts = HashMap<String, Int>() // receiver engine port, while receiving
    private val dialers = HashMap<String, ReverseDialer>() // reverse dialers, while receiving
    private val resumeWaits = HashMap<String, kotlinx.coroutines.Job>() // resume-requests waiting for an offer
    private val random = SecureRandom()

    private val _list = MutableStateFlow<List<Transfer>>(emptyList())
    val list: StateFlow<List<Transfer>> = _list

    init {
        val stored = runCatching { store.decodeFromString<List<Transfer>>(file.readText()) }.getOrDefault(emptyList())

        for (t in stored)
            records[t.transferId] =
                if (t.active) t.copy(state = "interrupted", error = "PeerPayload Connect was closed during the transfer") else t

        publish()
    }

    // ---- records ----

    private fun publish() {
        _list.value = records.values.sortedByDescending { it.createdAt }
    }

    private fun save() {
        val keep = records.values.sortedByDescending { it.createdAt }.take(MAX_HISTORY)

        runCatching { writeAtomically(file, store.encodeToString(keep).toByteArray()) }
            .onFailure { log("couldn't save transfer history: ${it.message}") }
    }

    private fun get(id: String) = synchronized(records) { records[id] }

    private fun update(id: String, persist: Boolean = true, change: (Transfer) -> Transfer): Transfer? = synchronized(records) {
        val t = records[id] ?: return null
        val next = change(t).copy(updatedAt = System.currentTimeMillis())

        records[id] = next
        if (persist) save()
        publish()

        // Copies made for sending go once they can't be needed again.
        if (next.direction == "out" && !next.active && !next.resumable && next.outgoingDir != null)
            File(next.outgoingDir).deleteRecursively()

        next
    }

    private fun add(t: Transfer) = synchronized(records) {
        records[t.transferId] = t
        save()
        publish()
    }

    // ---- helpers ----

    private fun newId(bytes: Int) = Base64.getUrlEncoder().withoutPadding().encodeToString(ByteArray(bytes).also(random::nextBytes))

    private fun relayAccess(transferId: String, role: String, peer: String): (() -> RelayAccess)? =
        relayUrl?.let { url -> { RelayAccess(url, issueDeviceTicket(identity, transferId, role, peer)) } }

    private fun identityArgs() = listOf("--cert", device.cert.path, "--key", device.key.path)

    private fun requirePaired(fp: String): Contact {
        val contact = contacts.get(fp)

        if (contact?.status != "paired")
            throw TransferException("can only send to a paired contact")

        return contact
    }

    private fun send(fp: String, message: Message) = scope.launch {
        runCatching { sendMessage(fp, message) }.onFailure { log("couldn't send ${message.type}: ${it.message}") }
    }

    /** Bytes done so far from engine events (transfers.js progressTracker). */
    private fun progressTracker(total: Long): (JsonObject) -> Progress? {
        val perFile = HashMap<String, Long>()
        var chunkSize = 0L
        var resumed = 0L

        fun num(e: JsonObject, k: String) = e[k]?.jsonPrimitive?.longOrNull ?: 0L

        return { e ->
            val rel = e["relPath"]?.jsonPrimitive?.content ?: ""
            var changed = true

            when (e.event) {
                "session_start" -> { chunkSize = num(e, "chunkSize"); changed = false }
                "file_start" -> {
                    val already = minOf(num(e, "resumeChunk") * chunkSize, num(e, "fileSize"))

                    perFile[rel] = already
                    resumed += already
                }
                "chunk_verified" -> perFile[rel] = (perFile[rel] ?: 0) + num(e, "bytes")
                "file_complete" -> perFile[rel] = num(e, "bytes")
                else -> changed = false
            }

            if (changed) Progress(minOf(perFile.values.sum(), total), total, resumed) else null
        }
    }

    private fun localAddresses(): List<String> {
        val v4 = mutableListOf<String>()
        val v6 = mutableListOf<String>()

        runCatching {
            for (iface in NetworkInterface.getNetworkInterfaces()) {
                if (!iface.isUp || iface.isLoopback)
                    continue

                for (addr in iface.inetAddresses) {
                    when {
                        addr is Inet4Address -> v4.add(addr.hostAddress!!)
                        addr is Inet6Address && !addr.isLinkLocalAddress -> v6.add(addr.hostAddress!!.substringBefore('%'))
                    }
                }
            }
        }

        return (v4 + v6 + "127.0.0.1").take(16)
    }

    private fun freePort() = ServerSocket(0).use { it.localPort }

    // ---- sender ----

    /** Offers files to a paired contact. [paths] are the files/folders to send (app-private copies in [outgoingDir]). */
    fun send(peer: String, paths: List<File>, outgoingDir: File?): Transfer {
        val contact = requirePaired(peer)

        if (paths.isEmpty())
            throw TransferException("nothing to send")

        val files = paths.take(MAX_OFFER_NAMES).map { p ->
            val all = p.walkTopDown().filter { it.isFile }.toList()

            StoredFile(p.name, all.sumOf { it.length() }, all.size.toLong())
        }
        val everything = paths.flatMap { p -> p.walkTopDown().filter { it.isFile }.toList() }
        val t = Transfer(
            transferId = newId(12),
            direction = "out",
            peer = peer,
            peerName = contact.name,
            files = files,
            fileCount = everything.size.toLong(),
            totalBytes = everything.sumOf { it.length() },
            state = "offered",
            createdAt = System.currentTimeMillis(),
            paths = paths.map { it.absolutePath },
            outgoingDir = outgoingDir?.absolutePath,
        )

        add(t)
        scope.launch { runOutgoing(t.transferId, resume = false) }

        return t
    }

    private suspend fun runOutgoing(id: String, resume: Boolean) {
        val t = get(id) ?: return
        val waiter = CompletableDeferred<Answer>()

        synchronized(waiters) { waiters[id] = waiter }

        val answer = try {
            sendMessage(t.peer, Message.Offer(id, t.files.map { FileSummary(it.name, it.size, it.files) }, t.fileCount, t.totalBytes, resume))
            withTimeout(OFFER_TIMEOUT_MS) { waiter.await() }.message
        } catch (e: Exception) {
            // Ended for good meanwhile (the other side removed it): keep that.
            if (get(id)?.ended == true)
                return

            val state = when {
                resume -> "interrupted" // an unanswered resume stays resumable
                e is TimeoutCancellationException -> "timed_out"
                e is OfferCancelled -> "cancelled"
                else -> "failed"
            }

            if (e is TimeoutCancellationException)
                send(t.peer, Message.Cancel(id))

            update(id) { it.copy(state = state, error = if (e is TimeoutCancellationException) "no answer from the other device" else e.message) }
            return
        } finally {
            synchronized(waiters) { waiters.remove(id) }
        }

        if (answer !is Message.Accept) {
            update(id) { it.copy(state = "declined", error = null) }
            return
        }

        update(id) { it.copy(state = "sending", started = true, error = null, retry = null) }

        val (final, path) = try {
            runSender(id, answer)
        } catch (e: Exception) {
            null to null
        }

        if (synchronized(pausing) { pausing.remove(id) }) {
            update(id) { it.copy(state = "interrupted", error = it.error ?: "paused", retry = null) }
            return
        }

        val ok = final?.event == "transfer_complete"

        if (!ok && get(id)?.ended == true)
            return

        val probeNote = synchronized(probeNotes) { probeNotes.remove(id) }

        // The receiver would otherwise keep listening until its own timeout.
        if (!ok)
            send(t.peer, Message.Cancel(id))

        update(id) {
            it.copy(
                state = if (ok) "complete" else "failed",
                // A failure says what the route attempts found, so a
                // screenshot is enough to tell a firewall from a bug.
                error = if (ok) null else listOfNotNull(
                    final?.get("reason")?.jsonPrimitive?.content ?: "the transfer engine stopped unexpectedly",
                    path?.let { "last tried via $it" },
                    probeNote,
                ).joinToString(" · "),
                path = path ?: it.path,
                retry = null,
                progress = if (ok) Progress(it.totalBytes, it.totalBytes, it.progress?.resumedBytes ?: 0) else it.progress,
            )
        }
    }

    // client-core/transferPolicy.js runSender: direct when the advertised
    // address answers, else the relay; retryable failures re-run the engine,
    // which resumes from the receiver's saved state.
    private suspend fun runSender(id: String, answer: Message.Accept): Pair<JsonObject?, String?> {
        val t = get(id)!!
        val relay = if (answer.relay) relayAccess(id, "sender", t.peer) else null
        val track = progressTracker(t.totalBytes)
        // A relay-only answer has no address to try directly.
        val candidates = answer.addresses.ifEmpty { listOf("127.0.0.1") }
        val answered = withContext(Dispatchers.IO) {
            candidates.map { host -> async { host to probeTcp(host, answer.port, DIRECT_PROBE_TIMEOUT_MS) } }.awaitAll()
        }
        val target = answered.firstOrNull { it.second }?.first
        // Unreachable: let the receiver dial us before settling for the relay.
        val reversed = if (target == null) tryReverse(t) else null
        val directHost = if (reversed != null) "127.0.0.1" else target ?: candidates[0]
        val directPort = reversed?.localPort ?: answer.port

        val probeNote = "direct: " + answered.joinToString { (host, ok) -> "$host ${if (ok) "answered" else "no answer"}" } +
            if (target == null) "; reversed: ${if (reversed != null) "receiver dialed back" else "no dial-back"}" else ""

        synchronized(probeNotes) { probeNotes[id] = probeNote }
        log("transfer $id: port ${answer.port}, $probeNote")
        var path = if (target == null && reversed == null && relay != null) "relay" else "direct"
        var bridge: SenderBridge? = null
        var connected = false
        var switched = false
        var failures = 0
        var attempts = 0

        update(id) { it.copy(path = path) }

        try {
            while (true) {
                if (path == "direct" && attempts > 0 && relay != null && !probeTcp(directHost, directPort, DIRECT_PROBE_TIMEOUT_MS)) {
                    path = "relay"
                    update(id) { it.copy(path = path) }
                }

                var host = directHost
                var port = directPort

                if (path == "relay") {
                    bridge = bridge ?: withContext(Dispatchers.IO) { SenderBridge(http, relay!!) }
                    host = "127.0.0.1"
                    port = bridge.port
                }

                attempts++

                var startedThisAttempt = false
                val args = listOf("-h", host, "-p", port.toString(), "--token", answer.token, "--transfer-id", id, "--chunk-size", CHUNK_SIZE.toString()) +
                    identityArgs() + listOf("--pin-sha256", t.peer) + t.paths
                val run = EngineRun(Program.SENDER, args) { e ->
                    if (e.event == "session_start") {
                        connected = true
                        startedThisAttempt = true
                    }
                    track(e)?.let { p -> update(id, persist = false) { it.copy(progress = p) } }
                }

                synchronized(engines) { engines[id] = run }

                if (synchronized(pausing) { id in pausing })
                    run.cancel()

                val final = try {
                    run.run()
                } finally {
                    synchronized(engines) { engines.remove(id) }
                }

                if (final.event == "transfer_complete" || synchronized(pausing) { id in pausing })
                    return final to path

                val reason = final["reason"]?.jsonPrimitive?.content

                log("transfer $id: engine via $path ($host:$port) ended: $reason")

                if (path == "direct" && relay != null && !switched && !startedThisAttempt && reason in SWITCH_TO_RELAY_REASONS) {
                    switched = true
                    path = "relay"
                    update(id) { it.copy(path = path) }
                    continue
                }

                val retryable = reason in RETRYABLE_REASONS || (connected && reason in RETRYABLE_AFTER_CONNECT)

                failures++

                if (!retryable || failures >= MAX_SEND_ATTEMPTS)
                    return final to path

                update(id, persist = false) { it.copy(retry = "connection dropped ($reason); retrying, attempt ${attempts + 1}") }
                delay(RETRY_DELAYS_MS[minOf(failures - 1, RETRY_DELAYS_MS.size - 1)])
            }
        } finally {
            bridge?.close()
            reversed?.close()
        }
    }

    /** Opens a port for the receiver to dial and asks it to; the bridge if it dials in time, else null. */
    private suspend fun tryReverse(t: Transfer): ReverseBridge? = withContext(Dispatchers.IO) {
        val key = newReverseKey()
        val bridge = ReverseBridge(key, log)

        try {
            sendMessage(t.peer, Message.Reverse(t.transferId, localAddresses(), bridge.port, key))

            if (bridge.arrived(REVERSE_WAIT_MS))
                return@withContext bridge

            log("transfer ${t.transferId}: ${t.peerName} didn't dial back; using the relay")
        } catch (e: Exception) {
            log("transfer ${t.transferId}: reverse connection not possible: ${e.message}")
        }

        bridge.close()
        null
    }

    // ---- receiver ----

    /** Accepts an incoming offer: starts the engine and tells the sender where it is. */
    fun accept(id: String) {
        val t = get(id)

        if (t == null || t.direction != "in" || t.state != "offered")
            throw TransferException("no such pending offer")

        val staging = t.stagingDir?.let(::File) ?: File(incomingRoot, id)

        staging.mkdirs()
        update(id) { it.copy(state = "receiving", started = true, stagingDir = staging.absolutePath, error = null) }
        scope.launch { runIncoming(id, staging) }
    }

    private suspend fun runIncoming(id: String, staging: File) {
        val t = get(id) ?: return
        val token = ByteArray(24).also(random::nextBytes).joinToString("") { "%02x".format(it) }
        val port = freePort()
        val track = progressTracker(t.totalBytes)
        val listening = CompletableDeferred<Unit>()
        val args = listOf(
            "-p", port.toString(), "-o", staging.path, "--token", token, "--transfer-id", id,
        ) + identityArgs() + listOf(
            "--peer-sha256", t.peer, "--max-retries", RECEIVER_MAX_RETRIES.toString(), "--listen-timeout", RECEIVER_LISTEN_TIMEOUT_SEC.toString(),
        )
        val run = EngineRun(Program.RECEIVER, args) { e ->
            if (e.event == "listening")
                listening.complete(Unit)

            track(e)?.let { p -> update(id, persist = false) { it.copy(progress = p) } }
        }

        synchronized(engines) { engines[id] = run }

        val engine = scope.async { run.run() }
        var bridge: ReceiverBridge? = null

        val final = try {
            engine.invokeOnCompletion { listening.complete(Unit) } // ended before listening: await below sees why

            listening.await()
            synchronized(enginePorts) { enginePorts[id] = port }

            if (engine.isCompleted)
                engine.await()
            else {
                val relay = relayAccess(id, "receiver", t.peer)

                if (relay != null)
                    bridge = withContext(Dispatchers.IO) {
                        // The sender couldn't reach this phone directly (the UI explains why).
                        ReceiverBridge(http, port, relay, log) {
                            if (get(id)?.path != "relay") update(id) { it.copy(path = "relay") }
                        }
                    }

                sendMessage(t.peer, Message.Accept(id, token, port, localAddresses(), relay != null))
                engine.await()
            }
        } catch (e: Exception) {
            run.cancel()

            if (synchronized(pausing) { pausing.remove(id) })
                update(id) { it.copy(state = "interrupted", error = it.error ?: "paused") }
            else if (get(id)?.state != "cancelled" && get(id)?.ended != true)
                update(id) { it.copy(state = "failed", error = e.message) }

            return
        } finally {
            synchronized(engines) { engines.remove(id) }
            synchronized(enginePorts) { enginePorts.remove(id) }
            synchronized(dialers) { dialers.remove(id) }?.close()
            bridge?.close()
        }

        if (synchronized(pausing) { pausing.remove(id) }) {
            update(id) { it.copy(state = "interrupted", error = it.error ?: "paused") }
            return
        }

        if (final.event != "transfer_complete") {
            // A sender's cancel already set "cancelled"; keep it.
            if (get(id)?.state != "cancelled" && get(id)?.ended != true)
                update(id) { it.copy(state = "failed", error = final["reason"]?.jsonPrimitive?.content) }
            return
        }

        try {
            val saved = withContext(Dispatchers.IO) { deliver(staging) }

            staging.deleteRecursively()
            update(id) {
                it.copy(state = "complete", savedAs = saved, stagingDir = null, progress = Progress(it.totalBytes, it.totalBytes, it.progress?.resumedBytes ?: 0))
            }
        } catch (e: Exception) {
            update(id) { it.copy(state = "failed", error = "received, but couldn't save the files: ${e.message}") }
        }
    }

    fun decline(id: String) {
        val t = get(id)

        if (t == null || t.direction != "in" || t.state != "offered")
            throw TransferException("no such pending offer")

        update(id) { it.copy(state = "declined") }
        send(t.peer, Message.Decline(id))
    }

    // ---- pause / resume ----

    private fun stopRunning(t: Transfer, by: String): Boolean {
        val run = synchronized(engines) { engines[t.transferId] } ?: return false

        synchronized(pausing) { pausing.add(t.transferId) }
        update(t.transferId, persist = false) { it.copy(error = by) }
        run.cancel()

        return true
    }

    /** Stops a running transfer on both sides; it stays resumable. */
    fun pause(id: String) {
        val t = get(id)

        if (t == null || (t.state != "sending" && t.state != "receiving"))
            throw TransferException("only a running transfer can be paused")

        send(t.peer, Message.Cancel(id, paused = true))

        if (!stopRunning(t, "paused"))
            throw TransferException("this transfer isn't running here")
    }

    /** Picks an interrupted transfer up again: the sender re-offers, the receiver asks the sender to. */
    fun resume(id: String) {
        val t = get(id)

        if (t == null || !t.resumable)
            throw TransferException("this transfer can't be resumed")

        requirePaired(t.peer)

        if (t.direction == "out") {
            t.paths.firstOrNull { !File(it).exists() }?.let {
                throw TransferException("${File(it).name} is no longer there, so this can't be resumed; send it again")
            }

            update(id) { it.copy(state = "offered", error = null) }
            scope.launch { runOutgoing(id, resume = true) }
        } else {
            update(id) { it.copy(state = "waiting", error = null) }
            synchronized(resumeWaits) {
                resumeWaits.remove(id)?.cancel()
                resumeWaits[id] = scope.launch {
                    delay(OFFER_TIMEOUT_MS)
                    if (get(id)?.state == "waiting")
                        update(id) { it.copy(state = "interrupted", error = "no answer from ${it.peerName}; try again when it's online") }
                }
            }
            send(t.peer, Message.ResumeRequest(id))
        }
    }

    /** Sender gives up waiting for an answer. */
    fun cancelOffer(id: String): Boolean {
        val waiter = synchronized(waiters) { waiters[id] } ?: return false
        val t = get(id) ?: return false

        send(t.peer, Message.Cancel(id))
        waiter.completeExceptionally(OfferCancelled())

        return true
    }

    /** Ends a transfer for good: stops whatever runs for it; not resumable any more. */
    private fun endForGood(t: Transfer, reason: String) {
        synchronized(resumeWaits) { resumeWaits.remove(t.transferId)?.cancel() }
        update(t.transferId) { it.copy(state = "cancelled", ended = true, error = reason) }
        synchronized(waiters) { waiters[t.transferId] }?.completeExceptionally(OfferCancelled())
        synchronized(engines) { engines[t.transferId] }?.cancel()
    }

    /**
     * Removes a transfer that isn't running, and any partial files it left.
     * Unless it finished, the other device is told, so it stops waiting to
     * resume it.
     */
    fun forget(id: String) = synchronized(records) {
        val t = records[id] ?: return

        if (t.state in ACTIVE_STATES)
            throw TransferException("stop the transfer first")

        if (t.state != "complete" && t.state != "declined" && contacts.get(t.peer) != null)
            send(t.peer, Message.Cancel(id, removed = true))

        synchronized(resumeWaits) { resumeWaits.remove(id)?.cancel() }
        records.remove(id)
        t.outgoingDir?.let { File(it).deleteRecursively() }
        t.stagingDir?.let { File(it).deleteRecursively() }
        save()
        publish()
    }

    /** Forgets finished transfers (not running or resumable ones). */
    fun clearFinished() = synchronized(records) {
        records.values.removeAll { it.state !in ACTIVE_STATES && !it.resumable }
        save()
        publish()
    }

    // ---- incoming messages ----

    /** Feed every opened envelope here. True if it was a transfer message (handled or deliberately ignored). */
    fun handleEnvelope(opened: Opened): Boolean {
        val type = opened.payload["type"]?.jsonPrimitive?.content

        if (type !in setOf("offer", "accept", "decline", "cancel", "resume-request", "reverse"))
            return false

        val message = parseMessage(opened.payload)
        val contact = contacts.get(opened.from)

        if (message == null || contact?.status != "paired")
            return true

        val from = opened.from

        when (message) {
            is Message.Offer -> {
                val t = get(message.transferId)

                if (t != null) {
                    // The sender resuming something we already accepted:
                    // accept again into the same staging folder, without asking.
                    if (message.resume && t.direction == "in" && t.peer == from && t.resumable) {
                        synchronized(resumeWaits) { resumeWaits.remove(t.transferId)?.cancel() }
                        update(t.transferId) { it.copy(state = "offered") }
                        runCatching { accept(t.transferId) }.onFailure { log("resuming ${t.transferId} failed: ${it.message}") }
                    }
                    return true // otherwise a redelivery
                }

                add(
                    Transfer(
                        transferId = message.transferId,
                        direction = "in",
                        peer = from,
                        peerName = contact.name,
                        files = message.files.map { StoredFile(it.name, it.size, it.files) },
                        fileCount = message.fileCount,
                        totalBytes = message.totalBytes,
                        state = "offered",
                        createdAt = System.currentTimeMillis(),
                    ),
                )
            }

            is Message.Accept, is Message.Decline -> {
                val id = if (message is Message.Accept) message.transferId else (message as Message.Decline).transferId
                val t = get(id)
                val waiter = synchronized(waiters) { waiters[id] }

                // Only the device we offered to can answer.
                if (t != null && t.direction == "out" && t.peer == from && waiter != null)
                    waiter.complete(Answer(message))
            }

            is Message.Cancel -> {
                val t = get(message.transferId)

                if (t == null || t.peer != from)
                    return true

                // The other side paused: stop our engine too, resumable.
                if (message.paused && (t.state == "sending" || t.state == "receiving")) {
                    stopRunning(t, "paused by ${t.peerName}")
                    return true
                }

                // The other side deleted it: nothing left to resume from.
                if (message.removed) {
                    if (t.state != "complete")
                        endForGood(t, "${t.peerName} removed this transfer")
                    return true
                }

                if (t.direction != "in")
                    return true

                if (t.state == "offered")
                    update(t.transferId) { it.copy(state = "cancelled") }
                else if (t.state == "receiving") {
                    // The sender gave up; stop listening for it.
                    update(t.transferId) { it.copy(state = "cancelled", error = "the sender stopped the transfer") }
                    synchronized(engines) { engines[t.transferId] }?.cancel()
                }
            }

            is Message.Reverse -> {
                val t = get(message.transferId)
                val enginePort = synchronized(enginePorts) { enginePorts[message.transferId] }

                // Only the sender of a transfer we're receiving right now.
                if (t == null || t.direction != "in" || t.peer != from || t.state != "receiving" || enginePort == null)
                    return true

                val dialer = ReverseDialer(message.addresses, message.port, message.key, enginePort, log = log, onConnected = {
                    if (get(t.transferId)?.path != "direct") update(t.transferId) { it.copy(path = "direct") }
                })

                synchronized(dialers) { dialers.put(t.transferId, dialer) }?.close()
            }

            is Message.ResumeRequest -> {
                val t = get(message.transferId)

                if (t != null && t.direction == "out" && t.peer == from && t.resumable)
                    runCatching { resume(t.transferId) }.onFailure { log("resume of ${t.transferId} requested, but: ${it.message}") }
                // Deleted here (or finished, or never ours): say so, or the
                // other side waits for an offer that will never come.
                else if (t == null || (t.peer == from && t.direction == "out"))
                    send(from, Message.Cancel(message.transferId, removed = true))
            }

            else -> {}
        }

        return true
    }
}
