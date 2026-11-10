package com.peerpayload.connect.net

import okhttp3.OkHttpClient
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okio.ByteString
import okio.ByteString.Companion.encodeUtf8
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Test
import java.net.Inet4Address
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.TimeUnit

// The relay bridges against a stand-in relay that pairs at once. The
// engines reach the bridges on IPv4 loopback ("-h 127.0.0.1"), which the
// first Android build got wrong (it listened on ::1).
class RelayBridgeTest {
    private val relay = MockWebServer()
    private val http = OkHttpClient.Builder().readTimeout(0, TimeUnit.MILLISECONDS).build()

    @After
    fun stop() {
        // A relay socket may still be closing; that's not what these tests check.
        runCatching { relay.shutdown() }
    }

    private fun access() = RelayAccess(relay.url("/v1/connect").toString().replaceFirst("http", "ws"), "ticket")

    /** A relay that says "paired" then hands each binary message to [onBytes]. */
    private fun pairingRelay(onOpen: (WebSocket) -> Unit = {}, onBytes: (WebSocket, ByteString) -> Unit) =
        relay.enqueue(MockResponse().withWebSocketUpgrade(object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                webSocket.send("""{"type":"paired"}""")
                onOpen(webSocket)
            }

            override fun onMessage(webSocket: WebSocket, bytes: ByteString) = onBytes(webSocket, bytes)
        }))

    @Test
    fun `sender bridge listens on 127_0_0_1 and carries bytes both ways`() {
        pairingRelay { ws, bytes -> ws.send(bytes) } // echo
        SenderBridge(http, ::access).use { bridge ->
            Socket("127.0.0.1", bridge.port).use { engine ->
                engine.soTimeout = 5000
                engine.getOutputStream().write("hello".toByteArray())

                val back = ByteArray(5)
                var n = 0
                while (n < 5) n += engine.getInputStream().read(back, n, 5 - n)
                assertEquals("hello", String(back))
                assertEquals(true, engine.inetAddress is Inet4Address)
            }
        }
    }

    @Test
    fun `receiver bridge connects to the engine on 127_0_0_1`() {
        ServerSocket(0, 1, java.net.InetAddress.getByName("127.0.0.1")).use { engine ->
            engine.soTimeout = 5000
            pairingRelay(onOpen = { it.send("from the sender".encodeUtf8()) }) { _, _ -> }

            ReceiverBridge(http, engine.localPort, ::access).use {
                engine.accept().use { conn ->
                    conn.soTimeout = 5000
                    val got = ByteArray(15)
                    var n = 0
                    while (n < 15) n += conn.getInputStream().read(got, n, 15 - n)
                    assertEquals("from the sender", String(got))
                }
            }
        }
    }
}
