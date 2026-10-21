package com.peerpayload.connect.net

import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.toByteString
import java.io.IOException
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.URLEncoder
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

// Local bridges between an engine and the relay (relay/src/server.js), the
// Kotlin twin of client-core/relayBridge.js. The engines are unchanged: the
// sender engine connects to a local port, the receiver engine gets a local
// connection, and the bridges carry the bytes over a WebSocket. Those bytes
// are the engines' own TLS stream (pinned by the sender), so the relay in
// the middle only ever sees ciphertext.

private const val HIGH_WATER = 4L * 1024 * 1024 // stop reading TCP above this many queued bytes
private const val PAIR_TIMEOUT_MS = 30_000L

/** Where to connect: the relay's ws(s) URL and a device-signed ticket. */
data class RelayAccess(val url: String, val ticket: String)

private fun relayRequest(access: RelayAccess) =
    Request.Builder().url("${access.url}?ticket=${URLEncoder.encode(access.ticket, "UTF-8")}").build()

private fun isPaired(text: String) = runCatching { org.json.JSONObject(text).optString("type") == "paired" }.getOrDefault(false)

/**
 * One relay socket: waits for "paired", then forwards bytes both ways with
 * [tcp] until either side ends. Blocking writes to the TCP socket on
 * OkHttp's reader thread are the back-pressure for relay -> engine; for
 * engine -> relay, reading stops while the send queue is above HIGH_WATER.
 */
private class Splice(private val tcpProvider: () -> Socket) : WebSocketListener() {
    val paired = CountDownLatch(1)
    val closed = CountDownLatch(1)

    @Volatile var tcp: Socket? = null
    @Volatile var failure: String? = null

    override fun onMessage(webSocket: WebSocket, text: String) {
        if (tcp == null && isPaired(text)) {
            try {
                val socket = tcpProvider()

                tcp = socket
                thread(name = "relay-up", isDaemon = true) { pump(socket, webSocket) }
            } catch (e: IOException) {
                failure = "local engine connection failed (${e.message})"
                webSocket.cancel()
            }
            paired.countDown()
        }
    }

    override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
        val socket = tcp ?: return

        try {
            bytes.write(socket.getOutputStream())
        } catch (e: IOException) {
            webSocket.cancel()
        }
    }

    override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
        webSocket.close(1000, null)
        finish()
    }

    override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = finish()

    override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
        failure = failure ?: (t.message ?: t.javaClass.simpleName)
        finish()
    }

    private fun finish() {
        // shutdownOutput rather than close so bytes already written (the
        // receiver's last FileDone, say) still reach the engine.
        runCatching { tcp?.shutdownOutput() }
        paired.countDown()
        closed.countDown()
    }

    // engine -> relay
    private fun pump(socket: Socket, ws: WebSocket) {
        val buf = ByteArray(256 * 1024)

        try {
            val input = socket.getInputStream()

            while (true) {
                val n = input.read(buf)

                if (n < 0)
                    break

                while (ws.queueSize() > HIGH_WATER)
                    Thread.sleep(5)

                if (!ws.send(buf.toByteString(0, n)))
                    break
            }
        } catch (_: Exception) {
        }

        ws.close(1000, null)
        runCatching { socket.close() }
    }
}

/** Sender side: a local port for the sender engine. Each engine connection gets its own relay socket. */
class SenderBridge(private val http: OkHttpClient, private val getAccess: () -> RelayAccess) : AutoCloseable {
    private val server = ServerSocket(0, 8, InetAddress.getLoopbackAddress())
    private val live = mutableSetOf<Socket>()

    val port: Int get() = server.localPort

    init {
        thread(name = "relay-sender-accept", isDaemon = true) {
            while (!server.isClosed) {
                val engine = try {
                    server.accept()
                } catch (_: IOException) {
                    break
                }

                synchronized(live) { live.add(engine) }
                thread(name = "relay-sender", isDaemon = true) { serve(engine) }
            }
        }
    }

    private fun serve(engine: Socket) {
        // The engine's first bytes (its TLS ClientHello) wait in the socket
        // until the relay has paired us with the receiver.
        val splice = Splice { engine }

        try {
            val ws = http.newWebSocket(relayRequest(getAccess()), splice)

            if (!splice.paired.await(PAIR_TIMEOUT_MS, TimeUnit.MILLISECONDS) || splice.tcp == null) {
                ws.cancel()
                runCatching { engine.close() }
            }

            splice.closed.await()
        } catch (_: Exception) {
            runCatching { engine.close() }
        } finally {
            synchronized(live) { live.remove(engine) }
        }
    }

    override fun close() {
        runCatching { server.close() }
        synchronized(live) { live.forEach { runCatching { it.close() } } }
    }
}

/**
 * Receiver side: keeps one relay socket waiting for the sender; when it
 * pairs, connects to the local receiver engine and splices. When that
 * session ends (done, or a dropped link the sender will retry) it waits
 * again, until [close] (once the receiver engine has exited).
 */
class ReceiverBridge(
    private val http: OkHttpClient,
    private val enginePort: Int,
    private val getAccess: () -> RelayAccess,
    private val log: (String) -> Unit = {},
) : AutoCloseable {
    @Volatile private var stopped = false
    @Volatile private var current: Pair<WebSocket, Splice>? = null

    init {
        thread(name = "relay-receiver", isDaemon = true) {
            var backoff = 1000L

            while (!stopped) {
                val splice = Splice { Socket().apply { connect(InetSocketAddress(InetAddress.getLoopbackAddress(), enginePort), 5000) } }

                try {
                    val ws = http.newWebSocket(relayRequest(getAccess()), splice)

                    current = ws to splice
                    splice.closed.await()
                    current = null

                    if (splice.tcp == null && splice.failure != null)
                        throw IOException(splice.failure)

                    backoff = 1000
                    Thread.sleep(200)
                } catch (e: Exception) {
                    if (stopped)
                        break

                    log("relay: ${e.message}; retrying in ${backoff / 1000}s")
                    Thread.sleep(backoff)
                    backoff = minOf(backoff * 2, 10_000)
                }
            }
        }
    }

    override fun close() {
        stopped = true
        current?.let { (ws, splice) ->
            runCatching { splice.tcp?.close() }
            ws.cancel()
        }
    }
}

/** True if a TCP connection to host:port succeeds within [timeoutMs]. */
fun probeTcp(host: String, port: Int, timeoutMs: Int = 3000): Boolean =
    try {
        Socket().use { it.connect(InetSocketAddress(host, port), timeoutMs) }
        true
    } catch (_: Exception) {
        false
    }
