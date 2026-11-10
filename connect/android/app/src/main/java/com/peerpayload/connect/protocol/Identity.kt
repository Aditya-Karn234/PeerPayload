package com.peerpayload.connect.protocol

import org.bouncycastle.crypto.params.Ed25519PrivateKeyParameters
import org.bouncycastle.crypto.params.X25519PrivateKeyParameters
import org.bouncycastle.crypto.util.PrivateKeyFactory
import java.security.SecureRandom

/**
 * This device's keys, as the protocol needs them:
 *
 *  - [certDer] / [signingKey]: the Ed25519 identity (made by the engine's
 *    keygen; device.crt / device.key). Used for mutual TLS by the engine
 *    and to sign envelopes, tokens and tickets.
 *  - [boxPrivate]: the X25519 key envelopes are encrypted to. Ed25519 can
 *    only sign, so encryption needs its own key; the public half travels
 *    in the contact card.
 */
class Identity(
    val name: String,
    val certDer: ByteArray,
    val signingKey: Ed25519PrivateKeyParameters,
    val boxPrivate: X25519PrivateKeyParameters,
) {
    val fingerprint: String = fingerprintOfDer(certDer)
    val boxPublic: String = b64url(boxPrivate.generatePublicKey().encoded)

    companion object {
        /** From ppkeygen's PEM files plus the raw 32-byte X25519 private key. */
        fun fromPem(name: String, certPem: String, keyPem: String, boxPrivateRaw: ByteArray): Identity =
            Identity(
                name = name,
                certDer = pemBody(certPem),
                signingKey = PrivateKeyFactory.createKey(pemBody(keyPem)) as? Ed25519PrivateKeyParameters
                    ?: throw ProtocolException("device.key is not an Ed25519 key"),
                boxPrivate = X25519PrivateKeyParameters(boxPrivateRaw, 0),
            )

        fun newBoxKey(): X25519PrivateKeyParameters = X25519PrivateKeyParameters(SecureRandom())

        internal fun pemBody(pem: String): ByteArray =
            fromB64(pem.lines().filterNot { it.startsWith("-----") }.joinToString(""))
    }
}
