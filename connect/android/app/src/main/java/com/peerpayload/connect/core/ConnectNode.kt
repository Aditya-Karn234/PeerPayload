package com.peerpayload.connect.core

import com.peerpayload.connect.net.MailboxClient
import com.peerpayload.connect.net.MailboxException
import com.peerpayload.connect.net.postEnvelope
import com.peerpayload.connect.protocol.Identity
import com.peerpayload.connect.protocol.Message
import com.peerpayload.connect.protocol.Opened
import com.peerpayload.connect.protocol.contactCard
import com.peerpayload.connect.protocol.encodeInviteLink
import com.peerpayload.connect.protocol.parseInviteLink
import com.peerpayload.connect.protocol.parseMessage
import com.peerpayload.connect.protocol.seal
import com.peerpayload.connect.protocol.verifyCard
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import java.io.File
import java.security.SecureRandom
import java.util.Base64
import java.util.concurrent.TimeUnit

// One Connect device: identity, contacts, pairing, mailbox connection and
// transfers, wired together (the Kotlin twin of connect/core/node.js). The
// Android UI is a view over this; nothing here knows about Activities.
//
//   dir         where this device keeps its identity, contacts and history
//   incomingDir where incoming transfers are staged while they run
//   deliver     moves a finished transfer's files out of staging (Downloads)

private const val INVITE_TTL_MS = 24 * 60 * 60 * 1000L
private val SEND_RETRY_DELAYS_MS = listOf(1000L, 2000L, 4000L, 8000L)

// How often unanswered pair requests are sent again (and on every mailbox
// reconnect), until answered or the invite expires.
private const val PAIR_RETRY_MS = 60_000L

data class NodeStatus(val hasIdentity: Boolean, val name: String?, val fingerprint: String?, val connected: Boolean)

data class InviteLink(val link: String, val expiresAt: Long)

class ConnectNode(
    dir: File,
    private val incomingDir: File,
    private val mailboxUrl: String,
    private val relayUrl: String?,
    private val scope: CoroutineScope,
    private val deliver: (File) -> List<String>,
    val log: (String) -> Unit = {},
) {
    private val device = DeviceFiles(dir)
    // No read timeout: the inbox and relay sockets sit idle for long stretches.
    private val http = OkHttpClient.Builder()
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .pingInterval(25, TimeUnit.SECONDS)
        .build()

    private var identity: Identity? = null
    private var contacts: Contacts? = null
    private var transferManager: Transfers? = null
    private var client: MailboxClient? = null
    private var pairJob: kotlinx.coroutines.Job? = null

    private val _status = MutableStateFlow(NodeStatus(false, null, null, false))
    val status: StateFlow<NodeStatus> = _status.asStateFlow()

    private val _contacts = MutableStateFlow<List<Contact>>(emptyList())
    val contactList: StateFlow<List<Contact>> = _contacts.asStateFlow()

    /** Set when a pairing completes, for the UI to announce. */
    val paired = MutableStateFlow<Contact?>(null)

    private val _transfers = MutableStateFlow<List<Transfer>>(emptyList())
    val transfers: StateFlow<List<Transfer>> = _transfers.asStateFlow()

    private fun requireStarted(): Identity = identity ?: throw IllegalStateException("this device has no identity yet")

    private fun contactsChanged() {
        _contacts.value = contacts?.list() ?: emptyList()
    }

    // Contacts may collect their messages at a different mailbox from ours.
    private suspend fun sendMessage(card: com.peerpayload.connect.protocol.VerifiedCard, message: Message) {
        val url = contacts?.get(card.fp)?.mailbox ?: mailboxUrl

        val envelope = seal(requireStarted(), card, message.toJson())

        // Android cuts an app's network while another app's screen (the QR
        // scanner, a file picker) is in front, and restores it a moment
        // after we're back: retry network errors for a few seconds. The
        // envelope keeps its id, so a duplicate delivery is ignored.
        for (delayMs in SEND_RETRY_DELAYS_MS) {
            try {
                return postEnvelope(http, url, envelope)
            } catch (e: MailboxException) {
                throw e // the mailbox answered: retrying won't change it
            } catch (e: java.io.IOException) {
                log("sending ${message.type} failed (${e.message}); retrying")
                delay(delayMs)
            }
        }

        postEnvelope(http, url, envelope)
    }

    private suspend fun sendTo(fp: String, message: Message) =
        sendMessage(contacts!!.card(fp) ?: throw IllegalStateException("unknown contact"), message)

    private suspend fun handlePairing(opened: Opened) {
        val message = parseMessage(opened.payload) ?: return
        val contacts = contacts!!
        val from = opened.from

        when (message) {
            is Message.PairRequest -> {
                if (message.card.fp != from)
                    return

                // Already paired (e.g. our answer was lost): just answer again.
                if (contacts.get(from)?.status != "paired") {
                    if (!contacts.consumeInvite(message.secret, from))
                        return log("ignored a pair request from ${message.card.name}: invite unknown, used or expired")

                    contacts.upsert(message.card.card, "paired", message.mailbox)
                    contactsChanged()
                    paired.value = contacts.get(from)
                }

                sendTo(from, Message.PairAccept)
            }

            Message.PairAccept -> {
                // Only someone whose invite we answered can accept.
                val contact = contacts.get(from)

                if (contact?.status != "pending")
                    return

                contacts.upsert(contacts.card(from)!!.card, "paired")
                contactsChanged()
                paired.value = contacts.get(from)
            }

            else -> {}
        }
    }

    private fun pairRequest(secret: String) = Message.PairRequest(secret, verifyCard(contactCard(requireStarted())), mailboxUrl)

    // The other device answers a repeated request again without needing the
    // invite twice (see handlePairing), so resending is harmless.
    private fun resendPairRequests() {
        val c = contacts ?: return

        for ((fp, pairing) in c.pendingPairings()) {
            val card = c.card(fp) ?: continue

            scope.launch {
                runCatching { sendMessage(card, pairRequest(pairing.secret)) }
                    .onFailure { log("pair request to ${fp.take(8)} not sent yet: ${it.message}") }
            }
        }
    }

    private suspend fun onEnvelope(opened: Opened) {
        if (!transferManager!!.handleEnvelope(opened))
            handlePairing(opened)
    }

    @Synchronized fun start() {
        if (identity != null || !device.exists())
            return

        val id = device.load()
        val c = Contacts(device.dir, id.fingerprint)

        identity = id
        contacts = c
        transferManager = Transfers(id, device, c, http, scope, ::sendTo, relayUrl, incomingDir, deliver, log)
            .also { tm -> scope.launch { tm.list.collect { _transfers.value = it } } }
        contactsChanged()

        client = MailboxClient(
            http, mailboxUrl, id, scope,
            onEnvelope = ::onEnvelope,
            onConnected = { connected ->
                _status.value = _status.value.copy(connected = connected)
                if (connected) resendPairRequests()
            },
            log = log,
        ).also { it.start() }

        pairJob = scope.launch {
            while (true) {
                delay(PAIR_RETRY_MS)
                resendPairRequests()
            }
        }

        _status.value = NodeStatus(true, id.name, id.fingerprint, false)
    }

    @Synchronized fun stop() {
        pairJob?.cancel()
        pairJob = null
        client?.stop()
        client = null
    }

    /** The network came back or the app is in front again: reconnect now rather than after the backoff. */
    fun reconnectNow() = client?.reconnectNow()

    /** Creates this device's identity (once) and starts it. */
    suspend fun setup(name: String) {
        device.create(name)
        start()
    }

    /** A one-time link (24 h) for someone to add this device. */
    fun createInvite(): InviteLink {
        val id = requireStarted()
        val secret = Base64.getUrlEncoder().withoutPadding().encodeToString(ByteArray(16).also(SecureRandom()::nextBytes))
        val expiresAt = System.currentTimeMillis() + INVITE_TTL_MS

        contacts!!.addInvite(hashSecret(secret), expiresAt)

        return InviteLink(encodeInviteLink(id, secret, mailboxUrl, expiresAt), expiresAt)
    }

    /** Adds the device behind someone's invite link and asks it to pair; "pending" until it accepts. */
    suspend fun addContact(link: String): Contact {
        val id = requireStarted()
        val invite = parseInviteLink(link)

        if (invite.card.fp == id.fingerprint)
            throw IllegalArgumentException("that's this device's own invite link")

        // Kept until answered, so a request that's lost or can't be sent
        // right now goes again (resendPairRequests).
        val contact = contacts!!.upsert(invite.card.card, "pending", invite.mailbox, PendingPairing(invite.secret, invite.expiresAt))

        contactsChanged()
        runCatching { sendMessage(invite.card, pairRequest(invite.secret)) }
            .onFailure { log("pair request not sent yet, will retry: ${it.message}") }

        return contact
    }

    fun removeContact(fp: String) {
        contacts?.remove(fp)
        contactsChanged()
    }

    fun send(fp: String, paths: List<File>, outgoingDir: File?) = transferManager!!.send(fp, paths, outgoingDir)
    fun accept(id: String) = transferManager!!.accept(id)
    fun decline(id: String) = transferManager!!.decline(id)
    fun cancelOffer(id: String) = transferManager!!.cancelOffer(id)
    fun pause(id: String) = transferManager!!.pause(id)
    fun resume(id: String) = transferManager!!.resume(id)
    fun forget(id: String) = transferManager!!.forget(id)
    fun clearFinished() = transferManager!!.clearFinished()
}
