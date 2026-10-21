package com.peerpayload.connect.engine

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

// The transfer engine (engine/, libpeerpayload.so) through its C API and
// the JNI bridge in connect/android/engine/jni/pp_jni.cpp. A run takes the
// same arguments as the sender/receiver/ppkeygen programs and reports the
// same JSON events.

fun interface EventListener {
    fun onEvent(json: String)
}

internal object NativeEngine {
    init {
        System.loadLibrary("peerpayload")
    }

    external fun protocolVersion(): Int
    external fun newRun(listener: EventListener): Long
    external fun runSender(handle: Long, args: Array<String>): Int
    external fun runReceiver(handle: Long, args: Array<String>): Int
    external fun runKeygen(handle: Long, args: Array<String>): Int
    external fun cancel(handle: Long)
    external fun free(handle: Long)
}

enum class Program { SENDER, RECEIVER, KEYGEN }

class EngineException(message: String) : Exception(message)

private val eventJson = Json { ignoreUnknownKeys = true }

val JsonObject.event: String? get() = this["event"]?.jsonPrimitive?.content

/**
 * One engine run. [run] blocks a dedicated thread until the engine is done
 * and returns its final event (transfer_complete / transfer_failed, or the
 * keygen's last event). [cancel] is safe from any thread, before, during
 * or after the run.
 */
class EngineRun(private val program: Program, private val args: List<String>, private val onEvent: (JsonObject) -> Unit = {}) {
    private val lock = Any()
    private var handle = 0L
    private var cancelled = false

    suspend fun run(): JsonObject = withContext(Dispatchers.IO) {
        var final: JsonObject? = null
        val h = NativeEngine.newRun { text ->
            val event = runCatching { eventJson.parseToJsonElement(text).jsonObject }.getOrNull() ?: return@newRun

            if (event.event in FINAL_EVENTS)
                final = event

            onEvent(event)
        }

        synchronized(lock) {
            handle = h
            if (cancelled) NativeEngine.cancel(h)
        }

        try {
            val argv = args.toTypedArray()
            val rc = when (program) {
                Program.SENDER -> NativeEngine.runSender(h, argv)
                Program.RECEIVER -> NativeEngine.runReceiver(h, argv)
                Program.KEYGEN -> NativeEngine.runKeygen(h, argv)
            }

            final ?: throw EngineException("engine ended (code $rc) without a final event")
        } finally {
            synchronized(lock) {
                handle = 0L
                NativeEngine.free(h)
            }
        }
    }

    fun cancel() = synchronized(lock) {
        cancelled = true
        if (handle != 0L) NativeEngine.cancel(handle)
    }

    companion object {
        private val FINAL_EVENTS = setOf("transfer_complete", "transfer_failed", "identity_created", "identity", "identity_failed")
    }
}
