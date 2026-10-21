package com.peerpayload.connect.net

import com.peerpayload.connect.protocol.Envelope
import com.peerpayload.connect.protocol.Identity
import com.peerpayload.connect.protocol.Opened
import com.peerpayload.connect.protocol.issueInboxToken
import com.peerpayload.connect.protocol.open
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.io.IOException
import java.net.URLEncoder
import kotlin.coroutines.resume

// Talks to a Connect mailbox (connect/mailbox), like
// connect/core/mailboxClient.js: sends envelopes, and keeps an inbox
// connection that verifies + decrypts what arrives, hands it to the app,
// then acknowledges it so the mailbox can delete it.

private val wire = Json { ignoreUnknownKeys = true; explicitNulls = false }

class MailboxException(message: String, val status: Int) : IOException(message)

/** Posts one envelope to a mailbox (any mailbox: contacts may use different ones). */
suspend fun postEnvelope(http: OkHttpClient, url: String, envelope: Envelope) = withContext(Dispatchers.IO) {
    val request = Request.Builder()
        .url("${url.trimEnd('/')}/v1/messages")
        .post(wire.encodeToString(envelope).toRequestBody("application/json".toMediaType()))
        .build()

    http.newCall(request).execute().use { res ->
        if (!res.isSuccessful) {
            val error = runCatching { wire.parseToJsonElement(res.body!!.string()).jsonObject["error"]?.jsonPrimitive?.content }.getOrNull()

            throw MailboxException(error ?: "mailbox refused the envelope (${res.code})", res.code)
        }
    }
}

/**
 * [onEnvelope] receives each envelope addressed to us that verifies and
 * decrypts; it's acknowledged (deleted from the mailbox) once that returns.
 * If it throws, the envelope is left for redelivery on the next connection.
 * Envelopes that fail verification are acknowledged and dropped.
 */
class MailboxClient(
    private val http: OkHttpClient,
    url: String,
    private val identity: Identity,
    private val scope: CoroutineScope,
    private val onEnvelope: suspend (Opened) -> Unit,
    private val onConnected: (Boolean) -> Unit = {},
    private val log: (String) -> Unit = {},
) {
    private val base = url.trimEnd('/')
    private val wsBase = base.replaceFirst(Regex("^http"), "ws")
    private val seen = mutableSetOf<String>() // ids handled this session (redelivery is idempotent)
    private var job: Job? = null
    private val wake = kotlinx.coroutines.channels.Channel<Unit>(kotlinx.coroutines.channels.Channel.CONFLATED)

    @Volatile private var hurry = false // reconnect without waiting, once

    @Volatile private var ws: WebSocket? = null

    @Volatile var connected = false
        private set

    suspend fun send(envelope: Envelope) = postEnvelope(http, base, envelope)

    private fun ack(ids: List<String>) {
        if (ids.isNotEmpty())
            ws?.send(buildJsonObject { put("type", "ack"); put("ids", buildJsonArray { ids.forEach { add(kotlinx.serialization.json.JsonPrimitive(it)) } }) }.toString())
    }

    private suspend fun handle(raw: JsonObject) {
        val id = raw["id"]?.jsonPrimitive?.content ?: return

        if (synchronized(seen) { id in seen })
            return ack(listOf(id))

        val opened = try {
            open(wire.decodeFromJsonElement<Envelope>(raw), identity)
        } catch (e: Exception) {
            log("dropping envelope $id: ${e.message}")
            return ack(listOf(id))
        }

        try {
            onEnvelope(opened)
            synchronized(seen) { seen.add(id) }
            ack(listOf(id))
        } catch (e: Exception) {
            log("envelope $id not handled, will be redelivered: ${e.message}")
        }
    }

    private fun setConnected(value: Boolean) {
        if (value != connected) {
            connected = value
            onConnected(value)
        }
    }

    // One inbox connection, until it closes. Messages are handled one at a
    // time, in order, on the scope.
    private suspend fun connectOnce() = suspendCancellableCoroutine { cont ->
        val token = URLEncoder.encode(issueInboxToken(identity), "UTF-8")
        val request = Request.Builder().url("$wsBase/v1/inbox?token=$token").build()
        val queue = kotlinx.coroutines.channels.Channel<JsonObject>(kotlinx.coroutines.channels.Channel.UNLIMITED)
        val worker = scope.launch { for (raw in queue) handle(raw) }

        fun done() {
            queue.close()
            setConnected(false)
            if (cont.isActive) cont.resume(Unit)
        }

        val socket = http.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) = setConnected(true)

            override fun onMessage(webSocket: WebSocket, text: String) {
                val msg = runCatching { wire.parseToJsonElement(text).jsonObject }.getOrNull() ?: return

                if (msg["type"]?.jsonPrimitive?.content == "envelope")
                    (msg["envelope"] as? JsonObject)?.let { queue.trySend(it) }
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(1000, null)
                done()
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = done()

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                log(if (response != null) "mailbox refused the inbox connection (${response.code})" else "mailbox: ${t.message}")
                done()
            }
        })

        ws = socket
        cont.invokeOnCancellation {
            socket.cancel()
            worker.cancel()
        }
    }

    fun start() {
        if (job != null)
            return

        job = scope.launch {
            var backoff = 1000L

            while (isActive) {
                val started = System.currentTimeMillis()

                connectOnce()
                ws = null

                if (hurry) {
                    hurry = false
                    backoff = 1000
                    continue
                }

                // A connection that lasted a while resets the backoff.
                backoff = if (System.currentTimeMillis() - started > 30_000) 1000 else minOf(backoff * 2, 30_000)
                kotlinx.coroutines.withTimeoutOrNull(backoff) { wake.receive() }
            }
        }
    }

    /**
     * Start a fresh connection now (the network came back, the app is in
     * front again): the old one may look open but be dead, and a reconnect
     * costs little since the mailbox redelivers anything pending.
     */
    fun reconnectNow() {
        if (job == null)
            return

        val current = ws

        if (current == null) {
            wake.trySend(Unit) // waiting between attempts: try now
        } else {
            hurry = true
            current.cancel()
        }
    }

    fun stop() {
        job?.cancel()
        job = null
        ws?.close(1000, null)
        ws = null
        setConnected(false)
    }
}
