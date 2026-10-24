package com.peerpayload.connect.protocol

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put

// Connect messages (protocol/messages.js): the payloads inside envelopes,
// with the same rules. parseMessage returns null for anything unknown or
// malformed; Message.toJson builds what parseMessage on the other side
// (JavaScript or Kotlin) accepts. Unknown extra fields are ignored.

const val MAX_OFFER_NAMES = 50

private val TRANSFER_ID = Regex("^[A-Za-z0-9_-]{8,64}$")
private val SECRET = Regex("^[A-Za-z0-9_-]+$")
private val URL = Regex("^https?://\\S+$")
private val IPV4 = Regex("^((25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)\\.){3}(25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)$")
private val IPV6_CHARS = Regex("^[0-9A-Fa-f:.]+$")
private val REVERSE_KEY = Regex("^[0-9a-f]{64}$")

data class FileSummary(val name: String, val size: Long, val files: Long)

sealed class Message {
    abstract val type: String

    data class PairRequest(val secret: String, val card: VerifiedCard, val mailbox: String?) : Message() {
        override val type = "pair-request"
    }

    data object PairAccept : Message() {
        override val type = "pair-accept"
    }

    data class Offer(val transferId: String, val files: List<FileSummary>, val fileCount: Long, val totalBytes: Long, val resume: Boolean = false) : Message() {
        override val type = "offer"
    }

    data class Accept(val transferId: String, val token: String, val port: Int, val addresses: List<String>, val relay: Boolean) : Message() {
        override val type = "accept"
    }

    data class Decline(val transferId: String) : Message() {
        override val type = "decline"
    }

    /** [paused]: stays resumable. [removed]: the sender deleted it (or never had it); end it for good. */
    data class Cancel(val transferId: String, val paused: Boolean = false, val removed: Boolean = false) : Message() {
        override val type = "cancel"
    }

    data class ResumeRequest(val transferId: String) : Message() {
        override val type = "resume-request"
    }

    /** The sender couldn't reach us: dial one of [addresses]:[port] and open with [key] (hex). */
    data class Reverse(val transferId: String, val addresses: List<String>, val port: Int, val key: String) : Message() {
        override val type = "reverse"
    }

    fun toJson(): JsonObject = buildJsonObject {
        put("type", type)
        when (val m = this@Message) {
            is PairRequest -> {
                put("secret", m.secret)
                put("card", json.encodeToJsonElement(m.card.card))
                m.mailbox?.let { put("mailbox", it) }
            }
            PairAccept -> {}
            is Offer -> {
                put("transferId", m.transferId)
                put("files", buildJsonArray {
                    m.files.forEach { f -> add(buildJsonObject { put("name", f.name); put("size", f.size); put("files", f.files) }) }
                })
                put("fileCount", m.fileCount)
                put("totalBytes", m.totalBytes)
                if (m.resume) put("resume", true)
            }
            is Accept -> {
                put("transferId", m.transferId)
                put("token", m.token)
                put("port", m.port)
                put("addresses", buildJsonArray { m.addresses.forEach { add(JsonPrimitive(it)) } })
                put("relay", m.relay)
            }
            is Decline -> put("transferId", m.transferId)
            is Cancel -> {
                put("transferId", m.transferId)
                if (m.paused) put("paused", true)
                if (m.removed) put("removed", true)
            }
            is ResumeRequest -> put("transferId", m.transferId)
            is Reverse -> {
                put("transferId", m.transferId)
                put("addresses", buildJsonArray { m.addresses.forEach { add(JsonPrimitive(it)) } })
                put("port", m.port)
                put("key", m.key)
            }
        }
    }.also {
        // Fail loudly here rather than be silently dropped by the receiver.
        if (parseMessage(it) == null) throw ProtocolException("invalid $type message")
    }
}

// ---- field checks: return null when invalid ----

private fun JsonObject.str(key: String, max: Int, pattern: Regex? = null): String? {
    val p = this[key] as? JsonPrimitive ?: return null

    if (!p.isString || p.content.isEmpty() || p.content.length > max || (pattern != null && !pattern.matches(p.content)))
        return null

    return p.content
}

private fun JsonElement?.integer(min: Long, max: Long = 9007199254740991L): Long? {
    val p = this as? JsonPrimitive ?: return null

    if (p.isString)
        return null

    val n = p.longOrNull ?: return null

    return if (n in min..max) n else null
}

private fun JsonElement?.bool(): Boolean? = (this as? JsonPrimitive)?.takeIf { !it.isString }?.booleanOrNull

private fun isIp(s: String): Boolean =
    IPV4.matches(s) || (s.contains(':') && IPV6_CHARS.matches(s) && runCatching { java.net.InetAddress.getByName(s) is java.net.Inet6Address }.getOrDefault(false))

/** An optional field: absent is fine, present must pass [check]. Returns (ok, value). */
private inline fun <T> JsonObject.optional(key: String, check: (JsonElement) -> T?): Pair<Boolean, T?> {
    val v = this[key] ?: return true to null

    if (v is JsonNull)
        return false to null

    val parsed = check(v)

    return (parsed != null) to parsed
}

/** Payload received in an envelope -> a message, or null if unknown/malformed. */
fun parseMessage(payload: JsonObject): Message? {
    val type = (payload["type"] as? JsonPrimitive)?.takeIf { it.isString }?.content ?: return null

    return when (type) {
        "pair-request" -> {
            val secret = payload.str("secret", 64, SECRET) ?: return null
            val cardJson = payload["card"] as? JsonObject ?: return null
            val card = runCatching { verifyCard(json.decodeFromJsonElement<Card>(cardJson)) }.getOrNull() ?: return null
            val (ok, mailbox) = payload.optional("mailbox") { (it as? JsonPrimitive)?.takeIf { p -> p.isString && p.content.length <= 512 && URL.matches(p.content) }?.content }

            if (!ok) null else Message.PairRequest(secret, card, mailbox)
        }
        "pair-accept" -> Message.PairAccept
        "offer" -> {
            val id = payload.str("transferId", 64, TRANSFER_ID) ?: return null
            val filesJson = payload["files"] as? JsonArray ?: return null

            if (filesJson.size > MAX_OFFER_NAMES)
                return null

            val files = filesJson.map { f ->
                val o = f as? JsonObject ?: return null

                FileSummary(o.str("name", 255) ?: return null, o["size"].integer(0) ?: return null, o["files"].integer(0) ?: return null)
            }
            val fileCount = payload["fileCount"].integer(0) ?: return null
            val totalBytes = payload["totalBytes"].integer(0) ?: return null
            val (ok, resume) = payload.optional("resume") { it.bool() }

            if (!ok) null else Message.Offer(id, files, fileCount, totalBytes, resume ?: false)
        }
        "accept" -> {
            val id = payload.str("transferId", 64, TRANSFER_ID) ?: return null
            val token = payload.str("token", 63) ?: return null
            val port = payload["port"].integer(1, 65535) ?: return null
            val addressesJson = payload["addresses"] as? JsonArray ?: return null

            if (addressesJson.size > 16)
                return null

            val addresses = addressesJson.map { a -> (a as? JsonPrimitive)?.takeIf { it.isString && isIp(it.content) }?.content ?: return null }
            val relay = payload["relay"].bool() ?: return null

            // The sender needs some way to reach the receiver.
            if (addresses.isEmpty() && !relay) null else Message.Accept(id, token, port.toInt(), addresses, relay)
        }
        "decline" -> Message.Decline(payload.str("transferId", 64, TRANSFER_ID) ?: return null)
        "cancel" -> {
            val id = payload.str("transferId", 64, TRANSFER_ID) ?: return null
            val (okPaused, paused) = payload.optional("paused") { it.bool() }
            val (okRemoved, removed) = payload.optional("removed") { it.bool() }

            if (!okPaused || !okRemoved) null else Message.Cancel(id, paused ?: false, removed ?: false)
        }
        "resume-request" -> Message.ResumeRequest(payload.str("transferId", 64, TRANSFER_ID) ?: return null)
        "reverse" -> {
            val id = payload.str("transferId", 64, TRANSFER_ID) ?: return null
            val addressesJson = payload["addresses"] as? JsonArray ?: return null

            if (addressesJson.isEmpty() || addressesJson.size > 16)
                return null

            val addresses = addressesJson.map { a -> (a as? JsonPrimitive)?.takeIf { it.isString && isIp(it.content) }?.content ?: return null }
            val port = payload["port"].integer(1, 65535) ?: return null
            val key = payload.str("key", 64, REVERSE_KEY) ?: return null

            Message.Reverse(id, addresses, port.toInt(), key)
        }
        else -> null
    }
}
