package com.peerpayload.connect.protocol

import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import org.bouncycastle.crypto.signers.Ed25519Signer

// Device-signed tokens (protocol/signedToken.js, inboxToken.js,
// relayTickets.js): base64url(JSON payload) "." base64url(Ed25519 signature
// over the first part). Field order matches the JavaScript objects, so a
// token made here is byte-identical to one made there (Ed25519 signatures
// are deterministic) — the tests check exactly that.

@Serializable
private data class InboxPayload(val v: Int, val purpose: String, val f: String, val e: Long, val c: String)

@Serializable
private data class TicketPayload(val v: Int, val t: String, val r: String, val f: String, val p: String, val e: Long, val c: String)

private fun signToken(identity: Identity, payloadJson: String): String {
    val payloadPart = b64url(payloadJson.toByteArray())
    val signer = Ed25519Signer()

    signer.init(true, identity.signingKey)
    payloadPart.toByteArray().let { signer.update(it, 0, it.size) }

    return "$payloadPart.${b64url(signer.generateSignature())}"
}

/** Proves to the mailbox that this device holds its key, to collect its inbox. */
fun issueInboxToken(identity: Identity, ttlSec: Long = 600, now: Long = System.currentTimeMillis()): String =
    signToken(identity, json.encodeToString(InboxPayload(1, "inbox", identity.fingerprint, now / 1000 + ttlSec, b64(identity.certDer))))

/** Permission to meet [peerFingerprint] on the relay for one transfer. */
fun issueDeviceTicket(
    identity: Identity,
    sessionId: String,
    role: String,
    peerFingerprint: String,
    ttlSec: Long = 600,
    now: Long = System.currentTimeMillis(),
): String {
    require(role == "sender" || role == "receiver")

    return signToken(
        identity,
        json.encodeToString(TicketPayload(2, sessionId, role, identity.fingerprint, peerFingerprint.lowercase(), now / 1000 + ttlSec, b64(identity.certDer))),
    )
}
