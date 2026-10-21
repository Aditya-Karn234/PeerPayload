package com.peerpayload.connect.protocol

import kotlinx.serialization.Serializable
import org.bouncycastle.crypto.params.Ed25519PublicKeyParameters
import org.bouncycastle.crypto.params.X25519PublicKeyParameters

// Contact cards (protocol/card.js): what one device gives another, inside
// a pairing link or a pair-request, so it can verify and encrypt to it.
//   {v: 1, name, fp: device ID, cert: base64 DER, box: base64url raw X25519 public key}

const val CARD_VERSION = 1
const val MAX_NAME_LENGTH = 64

@Serializable
data class Card(val v: Int, val name: String, val fp: String, val cert: String, val box: String)

/** A card that passed [verifyCard], with its keys parsed. */
class VerifiedCard(val card: Card, val verifyKey: Ed25519PublicKeyParameters, val boxKey: X25519PublicKeyParameters) {
    val fp get() = card.fp
    val name get() = card.name

    // The keys are derived from the card, so the card alone decides equality.
    override fun equals(other: Any?) = other is VerifiedCard && other.card == card
    override fun hashCode() = card.hashCode()
}

fun contactCard(identity: Identity) =
    Card(v = CARD_VERSION, name = identity.name, fp = identity.fingerprint, cert = b64(identity.certDer), box = identity.boxPublic)

/** Validates someone else's card; throws [ProtocolException] on anything wrong. */
fun verifyCard(card: Card): VerifiedCard {
    if (card.v != CARD_VERSION)
        throw ProtocolException("unsupported contact card")

    if (card.name.isBlank() || card.name.length > MAX_NAME_LENGTH)
        throw ProtocolException("bad name in contact card")

    if (!isFingerprint(card.fp))
        throw ProtocolException("bad device ID in contact card")

    val verifyKey = deviceKey(card.cert, card.fp)
        ?: throw ProtocolException("contact card certificate does not match its device ID")

    val box = try {
        fromB64url(card.box)
    } catch (e: IllegalArgumentException) {
        throw ProtocolException("bad encryption key in contact card")
    }

    if (box.size != 32)
        throw ProtocolException("bad encryption key in contact card")

    return VerifiedCard(card, verifyKey, X25519PublicKeyParameters(box, 0))
}
