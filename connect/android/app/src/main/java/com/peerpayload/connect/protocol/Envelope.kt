package com.peerpayload.connect.protocol

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.bouncycastle.crypto.agreement.X25519Agreement
import org.bouncycastle.crypto.digests.SHA256Digest
import org.bouncycastle.crypto.generators.HKDFBytesGenerator
import org.bouncycastle.crypto.params.Ed25519PublicKeyParameters
import org.bouncycastle.crypto.params.HKDFParameters
import org.bouncycastle.crypto.params.X25519PrivateKeyParameters
import org.bouncycastle.crypto.params.X25519PublicKeyParameters
import org.bouncycastle.crypto.signers.Ed25519Signer
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

// Envelopes (protocol/envelope.js + connect/core/envelope.js): a small
// message from one device to another through the (untrusted) mailbox.
//
//   {v: 1, to, from, ts, id, epk, iv, ct, cert, sig}
//
//   encrypted  to the recipient's X25519 key: a fresh ephemeral key (epk)
//              per envelope, ECDH, HKDF-SHA256 -> AES-256-GCM (ct = data + tag)
//   signed     (sig) by the sender's Ed25519 device key over every other field

const val ENVELOPE_VERSION = 1
const val MAX_PAYLOAD_BYTES = 32 * 1024

private val ENVELOPE_ID = Regex("^[A-Za-z0-9_-]{16,64}$")
private val random = SecureRandom()

@Serializable
data class Envelope(
    val v: Int,
    val to: String,
    val from: String,
    val ts: Long,
    val id: String,
    val epk: String,
    val iv: String,
    val ct: String,
    val cert: String,
    val sig: String = "",
)

/** An envelope that verified and decrypted. */
class Opened(val from: String, val id: String, val ts: Long, val cert: String, val payload: JsonObject)

// Everything the signature covers, in a fixed order.
private fun signedText(e: Envelope) = listOf(e.v, e.to, e.from, e.ts, e.id, e.epk, e.iv, e.ct, e.cert).joinToString(".")

private fun aad(e: Envelope) = "${e.v}|${e.from}|${e.to}|${e.id}|${e.ts}".toByteArray()

private fun deriveKey(shared: ByteArray, e: Envelope): ByteArray {
    val out = ByteArray(32)
    val hkdf = HKDFBytesGenerator(SHA256Digest())

    hkdf.init(HKDFParameters(shared, fromB64url(e.id), "peerpayload-envelope-v1|${e.from}|${e.to}".toByteArray()))
    hkdf.generateBytes(out, 0, out.size)

    return out
}

private fun x25519(priv: X25519PrivateKeyParameters, pub: X25519PublicKeyParameters): ByteArray {
    val out = ByteArray(32)
    val agreement = X25519Agreement()

    agreement.init(priv)
    agreement.calculateAgreement(pub, out, 0)

    return out
}

private fun aesGcm(mode: Int, key: ByteArray, iv: ByteArray, aad: ByteArray, input: ByteArray): ByteArray {
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")

    cipher.init(mode, SecretKeySpec(key, "AES"), GCMParameterSpec(128, iv))
    cipher.updateAAD(aad)

    return cipher.doFinal(input)
}

private fun randomBytes(n: Int) = ByteArray(n).also { random.nextBytes(it) }

/** Encrypts [payload] (a JSON object) to [recipient] and signs it as [identity]. */
fun seal(identity: Identity, recipient: VerifiedCard, payload: JsonObject, now: Long = System.currentTimeMillis()): Envelope {
    val plaintext = payload.toString().toByteArray()

    if (plaintext.size > MAX_PAYLOAD_BYTES)
        throw ProtocolException("envelope payload too large (${plaintext.size} bytes)")

    val ephemeral = X25519PrivateKeyParameters(random)
    val unsigned = Envelope(
        v = ENVELOPE_VERSION,
        to = recipient.fp,
        from = identity.fingerprint,
        ts = now / 1000,
        id = b64url(randomBytes(16)),
        epk = b64url(ephemeral.generatePublicKey().encoded),
        iv = b64url(randomBytes(12)),
        ct = "",
        cert = b64(identity.certDer),
    )
    val key = deriveKey(x25519(ephemeral, recipient.boxKey), unsigned)
    val withCt = unsigned.copy(ct = b64url(aesGcm(Cipher.ENCRYPT_MODE, key, fromB64url(unsigned.iv), aad(unsigned), plaintext)))
    val signer = Ed25519Signer()

    signer.init(true, identity.signingKey)
    signedText(withCt).toByteArray().let { signer.update(it, 0, it.size) }

    return withCt.copy(sig = b64url(signer.generateSignature()))
}

/** Checks shape, that the certificate is the claimed sender's, and the signature. */
fun verifyEnvelopeSignature(e: Envelope): Ed25519PublicKeyParameters {
    if (e.v != ENVELOPE_VERSION)
        throw ProtocolException("unsupported envelope")

    if (!isFingerprint(e.to) || !isFingerprint(e.from))
        throw ProtocolException("bad to/from")

    if (listOf(e.id, e.epk, e.iv, e.ct, e.sig, e.cert).any { it.isEmpty() })
        throw ProtocolException("missing field")

    if (!ENVELOPE_ID.matches(e.id))
        throw ProtocolException("bad id")

    val key = deviceKey(e.cert, e.from) ?: throw ProtocolException("sender certificate does not match sender ID")
    val verifier = Ed25519Signer()
    val valid = try {
        verifier.init(false, key)
        signedText(e).toByteArray().let { verifier.update(it, 0, it.size) }
        verifier.verifySignature(fromB64url(e.sig))
    } catch (ex: IllegalArgumentException) {
        false
    }

    if (!valid)
        throw ProtocolException("bad envelope signature")

    return key
}

/** Verifies and decrypts an envelope addressed to [identity]. */
fun open(e: Envelope, identity: Identity): Opened {
    verifyEnvelopeSignature(e)

    if (e.to != identity.fingerprint)
        throw ProtocolException("envelope is not addressed to this device")

    val key = deriveKey(x25519(identity.boxPrivate, X25519PublicKeyParameters(fromB64url(e.epk), 0)), e)
    val data = fromB64url(e.ct)

    if (data.size < 16)
        throw ProtocolException("ciphertext too short")

    val plaintext = try {
        aesGcm(Cipher.DECRYPT_MODE, key, fromB64url(e.iv), aad(e), data)
    } catch (ex: Exception) {
        throw ProtocolException("envelope could not be decrypted")
    }

    return Opened(e.from, e.id, e.ts, e.cert, json.parseToJsonElement(String(plaintext)).jsonObject)
}
