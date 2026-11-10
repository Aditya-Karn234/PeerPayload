package com.peerpayload.connect.core

import com.peerpayload.connect.engine.EngineException
import com.peerpayload.connect.engine.EngineRun
import com.peerpayload.connect.engine.Program
import com.peerpayload.connect.engine.event
import com.peerpayload.connect.protocol.Identity
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonPrimitive
import java.io.File

// This device's identity on disk (the Android side of
// connect/core/identity.js), in the app's private storage:
//
//   device.crt / device.key  Ed25519 identity, made by the engine's keygen
//   box.key                  raw 32-byte X25519 private key for envelopes
//   profile.json             the display name
//
// Nothing here leaves the device except the public halves, in the card.

internal val store = Json { ignoreUnknownKeys = true; explicitNulls = false; prettyPrint = true }

@Serializable
private data class Profile(val name: String, val createdAt: Long)

class DeviceFiles(val dir: File) {
    val cert = File(dir, "device.crt")
    val key = File(dir, "device.key")
    private val box = File(dir, "box.key")
    private val profile = File(dir, "profile.json")

    fun exists() = listOf(cert, key, box, profile).all { it.isFile }

    fun load(): Identity =
        Identity.fromPem(
            store.decodeFromString<Profile>(profile.readText()).name,
            cert.readText(),
            key.readText(),
            box.readBytes(),
        )

    /** Creates the identity (refuses if one exists). */
    suspend fun create(name: String): Identity {
        val trimmed = name.trim()

        require(!exists()) { "this device already has an identity" }
        require(trimmed.isNotEmpty() && trimmed.toByteArray().size <= 64) { "name must be 1-64 bytes" }

        dir.mkdirs()

        val final = EngineRun(Program.KEYGEN, listOf("--out", dir.path, "--name", trimmed, "--force")).run()

        if (final.event != "identity_created")
            throw EngineException("couldn't create the device identity (${final["reason"]?.jsonPrimitive?.content})")

        writeAtomically(box, Identity.newBoxKey().encoded)
        writeAtomically(profile, store.encodeToString(Profile(trimmed, System.currentTimeMillis())).toByteArray())

        return load()
    }
}

/** Write to a temp file then rename, so a crash never leaves half a file. */
internal fun writeAtomically(file: File, bytes: ByteArray) {
    val tmp = File(file.parentFile, "${file.name}.tmp")

    tmp.writeBytes(bytes)

    if (!tmp.renameTo(file)) {
        file.delete()
        check(tmp.renameTo(file)) { "couldn't write ${file.name}" }
    }
}
