package com.peerpayload.connect.protocol

import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString

// Pairing links (protocol/pairingLink.js):
//   peerpayload://pair#<base64url JSON {v: 1, card, secret, mailbox, exp}>
// card: the inviter's card; secret: 16 random bytes (base64url) the
// invitee returns in its pair-request; mailbox: where the inviter collects
// messages; exp: unix seconds.

const val LINK_PREFIX = "peerpayload://pair#"
private const val INVITE_VERSION = 1
private const val SECRET_BYTES = 16

@Serializable
private data class InviteBody(val v: Int, val card: Card, val secret: String, val mailbox: String, val exp: Long)

class Invite(val card: VerifiedCard, val secret: String, val mailbox: String, val expiresAt: Long)

private fun isMailboxUrl(s: String) = s.startsWith("http://") || s.startsWith("https://")

fun encodeInviteLink(identity: Identity, secret: String, mailbox: String, expiresAt: Long): String {
    if (!isMailboxUrl(mailbox))
        throw ProtocolException("an http(s) mailbox URL is required")

    val body = InviteBody(INVITE_VERSION, contactCard(identity), secret, mailbox, expiresAt / 1000)

    return LINK_PREFIX + b64url(json.encodeToString(body).toByteArray())
}

/** Parses and verifies a link (or its bare base64 part). Throws if bad or expired. */
fun parseInviteLink(link: String, now: Long = System.currentTimeMillis()): Invite {
    val text = link.trim()
    val encoded = if (text.startsWith(LINK_PREFIX)) text.removePrefix(LINK_PREFIX) else text
    val body = try {
        json.decodeFromString<InviteBody>(String(fromB64url(encoded)))
    } catch (e: Exception) {
        throw ProtocolException("not a PeerPayload pairing link")
    }

    if (body.v != INVITE_VERSION)
        throw ProtocolException("unsupported pairing link")

    val secretBytes = try {
        fromB64url(body.secret)
    } catch (e: IllegalArgumentException) {
        null
    }

    if (secretBytes?.size != SECRET_BYTES)
        throw ProtocolException("pairing link has no valid secret")

    if (!isMailboxUrl(body.mailbox))
        throw ProtocolException("pairing link has no valid mailbox")

    if (body.exp * 1000 < now)
        throw ProtocolException("this pairing link has expired; ask for a new one")

    return Invite(verifyCard(body.card), body.secret, body.mailbox, body.exp * 1000)
}
