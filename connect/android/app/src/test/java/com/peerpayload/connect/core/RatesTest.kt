package com.peerpayload.connect.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class RatesTest {
    private fun running(bytes: Long, total: Long = 100_000_000) =
        Transfer("abcdefgh12", "in", "f".repeat(64), "PC", emptyList(), 1, total, "receiving", createdAt = 0, progress = Progress(bytes, total))

    @Test
    fun `measures, then reports speed and time left, then a stall`() {
        val meter = RateMeter()

        assertEquals(Rate.Measuring, meter.update(listOf(running(0)), now = 0)["abcdefgh12"])
        assertEquals(Rate.Measuring, meter.update(listOf(running(1_000_000)), now = 1000)["abcdefgh12"])

        // 2 MB over 2 s = 1 MB/s; 98 MB left = 98 s.
        val speed = meter.update(listOf(running(2_000_000)), now = 2000)["abcdefgh12"] as Rate.Speed
        assertEquals(1_000_000.0, speed.bytesPerSec, 1.0)
        assertEquals(98.0, speed.secondsLeft!!, 0.01)

        // Same bytes, 4+ s later: stalled.
        assertEquals(Rate.Stalled, meter.update(listOf(running(2_000_000)), now = 6500)["abcdefgh12"])
    }

    @Test
    fun `forgets transfers that stopped running`() {
        val meter = RateMeter()

        meter.update(listOf(running(0)), now = 0)
        assertTrue(meter.update(emptyList(), now = 1000).isEmpty())
        assertEquals(Rate.Measuring, meter.update(listOf(running(5)), now = 2000)["abcdefgh12"])
    }

    @Test
    fun `time left reads like the desktop`() {
        assertEquals("42 s", formatRemaining(42.0))
        assertEquals("3 min 20 s", formatRemaining(200.0))
        assertEquals("2 min", formatRemaining(120.0))
        assertEquals("1 h 5 min", formatRemaining(3900.0))
    }
}
