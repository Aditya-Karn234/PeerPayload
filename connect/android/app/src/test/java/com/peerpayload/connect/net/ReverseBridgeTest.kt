package com.peerpayload.connect.net

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket

// The reverse bridges on their own (connect/core/test/reverse.test.js in
// Kotlin): the key gate, and bytes both ways between the two "engines".
class ReverseBridgeTest {
    @Test
    fun `a dialer with the key is spliced to the sender engine`() {
        val key = newReverseKey()

        ReverseBridge(key).use { bridge ->
            // The receiver engine: answers what it gets, uppercased.
            ServerSocket(0, 1, InetAddress.getByName("127.0.0.1")).use { receiverEngine ->
                ReverseDialer(listOf("127.0.0.1"), bridge.port, key, receiverEngine.localPort).use {
                    assertTrue("the receiver dialed back", bridge.arrived(3000))

                    Socket("127.0.0.1", bridge.localPort).use { senderEngine ->
                        senderEngine.soTimeout = 5000
                        senderEngine.getOutputStream().write("hello".toByteArray())

                        receiverEngine.soTimeout = 5000
                        receiverEngine.accept().use { conn ->
                            val got = ByteArray(5)
                            conn.getInputStream().read(got)
                            conn.getOutputStream().write(String(got).uppercase().toByteArray())
                        }

                        val back = ByteArray(5)
                        var n = 0
                        while (n < 5) n += senderEngine.getInputStream().read(back, n, 5 - n)
                        assertEquals("HELLO", String(back))
                    }
                }
            }
        }
    }

    @Test
    fun `a connection without the right key never counts`() {
        ReverseBridge(newReverseKey()).use { bridge ->
            Socket("127.0.0.1", bridge.port).use { it.getOutputStream().write(ByteArray(32) { 7 }) }
            assertFalse(bridge.arrived(700))
        }
    }
}
