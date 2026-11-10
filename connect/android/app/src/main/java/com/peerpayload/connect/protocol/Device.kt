package com.peerpayload.connect.protocol

import kotlinx.serialization.json.Json
import org.bouncycastle.asn1.edec.EdECObjectIdentifiers
import org.bouncycastle.cert.X509CertificateHolder
import org.bouncycastle.crypto.params.Ed25519PublicKeyParameters
import java.security.MessageDigest
import java.util.Base64

// Device IDs and encodings: the Kotlin side of protocol/device.js. A
// device's identity is an Ed25519 key with a self-signed certificate (made
// by the engine's keygen); its ID ("fingerprint") is the SHA-256 of that
// certificate's DER, as lowercase hex.

internal val json = Json { ignoreUnknownKeys = true; explicitNulls = false }

internal fun b64url(bytes: ByteArray): String = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
internal fun fromB64url(s: String): ByteArray = Base64.getUrlDecoder().decode(s)
internal fun b64(bytes: ByteArray): String = Base64.getEncoder().encodeToString(bytes)
internal fun fromB64(s: String): ByteArray = Base64.getMimeDecoder().decode(s)

internal fun sha256(bytes: ByteArray): ByteArray = MessageDigest.getInstance("SHA-256").digest(bytes)
internal fun hex(bytes: ByteArray): String = bytes.joinToString("") { "%02x".format(it) }

private val FINGERPRINT = Regex("^[0-9a-f]{64}$")

fun isFingerprint(s: String?): Boolean = s != null && FINGERPRINT.matches(s)

fun fingerprintOfDer(der: ByteArray): String = hex(sha256(der))

class ProtocolException(message: String) : Exception(message)

private const val MAX_CERT_B64 = 4096

/**
 * The Ed25519 public key in a certificate (base64 DER), if that certificate
 * really is device [fingerprint]. Otherwise null.
 */
fun deviceKey(certB64: String, fingerprint: String): Ed25519PublicKeyParameters? {
    if (certB64.length > MAX_CERT_B64)
        return null

    val der = try {
        fromB64(certB64)
    } catch (e: IllegalArgumentException) {
        return null
    }

    return deviceKey(der, fingerprint)
}

fun deviceKey(der: ByteArray, fingerprint: String): Ed25519PublicKeyParameters? {
    if (fingerprintOfDer(der) != fingerprint)
        return null

    return try {
        val spki = X509CertificateHolder(der).subjectPublicKeyInfo

        // Device identities are Ed25519; accept nothing else.
        if (spki.algorithm.algorithm != EdECObjectIdentifiers.id_Ed25519)
            null
        else
            Ed25519PublicKeyParameters(spki.publicKeyData.bytes, 0)
    } catch (e: Exception) {
        null
    }
}

/**
 * Short code two people compare to be sure they paired the right devices.
 * Same on both sides (protocol: connect/core identity.js safetyCode).
 */
fun safetyCode(fpA: String, fpB: String): String {
    val digest = sha256(listOf(fpA, fpB).sorted().joinToString(":").toByteArray())

    return (0 until 6).joinToString(" ") { i ->
        val n = ((digest[i * 4].toLong() and 0xff) shl 24) or
            ((digest[i * 4 + 1].toLong() and 0xff) shl 16) or
            ((digest[i * 4 + 2].toLong() and 0xff) shl 8) or
            (digest[i * 4 + 3].toLong() and 0xff)

        (n % 100000).toString().padStart(5, '0')
    }
}
