package com.peerpayload.connect.net

import java.io.IOException
import java.io.InputStream
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Collections
import java.util.concurrent.CountDownLatch
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import kotlin.concurrent.thread

// Reversed connections, the Kotlin twin of connect/core/reverse.js: when
// the sender can't reach the receiver but the receiver can reach the
// sender, the receiver dials out instead. The engines don't change: as
// with the relay, each talks to a local bridge, and the bridges carry the
// bytes over the one TCP connection the receiver opened.
//
// The engines' TLS (pinned to the paired device certificates) runs end to
// end through this. On top, the dialer must open with a one-time key, sent
// only inside the encrypted `reverse` message, or the sender drops the
// connection before its engine sees it.

private const val KEY_BYTES = 32
private const val KEY_TIMEOUT_MS = 5000
private const val MAX_WAITING = 4
private const val ENGINE_WAIT_MS = 30_000L

fun newReverseKey(): String = ByteArray(KEY_BYTES).also(SecureRandom()::nextBytes).joinToString("") { "%02x".format(it) }

private fun hexBytes(hex: String) = ByteArray(hex.length / 2) { i -> hex.substring(i * 2, i * 2 + 2).toInt(16).toByte() }

private fun InputStream.readExactly(n: Int): ByteArray? {
    val out = ByteArray(n)
    var got = 0

    while (got < n) {
        val r = read(out, got, n - got)

        if (r < 0)
            return null

        got += r
    }

    return out
}

/** Bytes both ways until either side ends; then both are closed. [first] is sent to [b] before the rest of [a]'s bytes. */
private fun splice(a: Socket, b: Socket, first: ByteArray? = null) {
    fun pump(from: Socket, to: Socket, head: ByteArray?) = thread(isDaemon = true, name = "reverse-pump") {
        try {
            val out = to.getOutputStream()

            head?.let { out.write(it) }
            from.getInputStream().copyTo(out, 256 * 1024)
        } catch (_: IOException) {
        } finally {
            runCatching { from.close() }
            runCatching { to.close() }
        }
    }

    pump(a, b, first)
    pump(b, a, null)
}

/**
 * Sender side: listens publicly ([port]) for the receiver's dial and
 * locally ([localPort]) for the sender engine, and pairs each engine
 * connection with the next verified incoming one.
 */
class ReverseBridge(key: String, private val log: (String) -> Unit = {}) : AutoCloseable {
    private val expected = hexBytes(key)
    private val publicServer = ServerSocket(0)
    private val localServer = ServerSocket(0, 8, LOCALHOST)
    private val ready = LinkedBlockingQueue<Socket>()
    private val firstArrival = CountDownLatch(1)
    private val live = Collections.synchronizedSet(mutableSetOf<Socket>())

    val port: Int get() = publicServer.localPort
    val localPort: Int get() = localServer.localPort

    init {
        thread(isDaemon = true, name = "reverse-public") {
            while (!publicServer.isClosed) {
                val socket = try {
                    publicServer.accept()
                } catch (_: IOException) {
                    break
                }

                live.add(socket)
                thread(isDaemon = true, name = "reverse-verify") { verify(socket) }
            }
        }

        thread(isDaemon = true, name = "reverse-local") {
            while (!localServer.isClosed) {
                val engine = try {
                    localServer.accept()
                } catch (_: IOException) {
                    break
                }

                live.add(engine)
                thread(isDaemon = true, name = "reverse-engine") {
                    // The engine's first bytes (TLS ClientHello) wait in its socket.
                    val remote = ready.poll(ENGINE_WAIT_MS, TimeUnit.MILLISECONDS)

                    if (remote == null) runCatching { engine.close() } else splice(engine, remote)
                }
            }
        }
    }

    private fun verify(socket: Socket) {
        try {
            if (ready.size >= MAX_WAITING)
                throw IOException("too many waiting")

            socket.soTimeout = KEY_TIMEOUT_MS
            val got = socket.getInputStream().readExactly(KEY_BYTES)

            if (got == null || !MessageDigest.isEqual(got, expected))
                throw IOException("wrong key")

            socket.soTimeout = 0
            ready.put(socket)
            firstArrival.countDown()
        } catch (e: IOException) {
            log("reverse: dropped a connection (${e.message})")
            runCatching { socket.close() }
        }
    }

    /** True once a verified connection has arrived, false after [ms]. */
    fun arrived(ms: Long): Boolean = firstArrival.await(ms, TimeUnit.MILLISECONDS)

    override fun close() {
        firstArrival.countDown()
        runCatching { publicServer.close() }
        runCatching { localServer.close() }
        synchronized(live) { live.forEach { runCatching { it.close() } } }
    }
}

/** The first of [addresses] accepting a connection on [port] within [timeoutMs] (all tried at once), or null. */
private fun dialFirst(addresses: List<String>, port: Int, timeoutMs: Int): Socket? {
    val winner = AtomicReference<Socket?>(null)
    val done = CountDownLatch(1)
    val left = java.util.concurrent.atomic.AtomicInteger(addresses.size)

    for (host in addresses)
        thread(isDaemon = true, name = "reverse-dial") {
            val s = Socket()

            try {
                s.connect(InetSocketAddress(host, port), timeoutMs)

                if (winner.compareAndSet(null, s)) done.countDown() else s.close()
            } catch (_: IOException) {
                runCatching { s.close() }
            } finally {
                if (left.decrementAndGet() == 0) done.countDown()
            }
        }

    done.await(timeoutMs + 500L, TimeUnit.MILLISECONDS)

    return winner.get()
}

/**
 * Receiver side: dials the sender, proves the key, and once the sender's
 * bytes start arriving connects them to the local receiver engine. When a
 * session ends it dials again (the sender may retry), until [close].
 */
class ReverseDialer(
    private val addresses: List<String>,
    private val port: Int,
    key: String,
    private val enginePort: Int,
    private val onConnected: () -> Unit = {},
    private val log: (String) -> Unit = {},
) : AutoCloseable {
    private val keyBytes = hexBytes(key)
    private val current = Collections.synchronizedSet(mutableSetOf<Socket>())

    @Volatile private var stopped = false

    init {
        thread(isDaemon = true, name = "reverse-dialer") {
            var backoff = 500L

            while (!stopped) {
                val ok = runCatching { oneSession() }.getOrDefault(false)

                if (stopped)
                    break

                backoff = if (ok) 500 else minOf(backoff * 2, 5000)
                Thread.sleep(backoff)
            }
        }
    }

    private fun oneSession(): Boolean {
        val remote = dialFirst(addresses, port, 3000) ?: return false

        current.add(remote)

        try {
            remote.getOutputStream().write(keyBytes)

            // Connect to the engine only when the sender's engine starts
            // talking, so the receiver engine doesn't sit on an idle socket.
            val buf = ByteArray(64 * 1024)
            val n = remote.getInputStream().read(buf)

            if (n < 0 || stopped)
                return true

            val engine = Socket().apply { connect(InetSocketAddress(LOCALHOST, enginePort), 5000) }

            current.add(engine)
            onConnected()
            splice(remote, engine, buf.copyOf(n))

            // Until this session ends.
            while (!remote.isClosed && !engine.isClosed && !stopped)
                Thread.sleep(200)
        } catch (e: IOException) {
            log("reverse: ${e.message}")
            runCatching { remote.close() }
        } finally {
            synchronized(current) { current.removeAll { it.isClosed } }
        }

        return true
    }

    override fun close() {
        stopped = true
        synchronized(current) { current.forEach { runCatching { it.close() } } }
    }
}
