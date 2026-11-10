package com.peerpayload.connect.core

// Transfer speed and time remaining, measured from reported progress
// (never estimated from anything else): the Kotlin twin of
// packages/ui/src/useRates.js. A rate is shown only once there are at
// least 1.5 s of samples; if no new bytes arrive for 4 s the transfer
// counts as stalled.

private const val WINDOW_MS = 5000L
private const val MIN_SPAN_MS = 1500L
private const val STALL_MS = 4000L

sealed class Rate {
    data object Measuring : Rate()
    data object Stalled : Rate()
    data class Speed(val bytesPerSec: Double, val secondsLeft: Double?) : Rate()
}

class RateMeter {
    private class Sample(val t: Long, val bytes: Long)

    private val samples = HashMap<String, ArrayDeque<Sample>>()

    /** Records the running transfers' progress and returns their rates. Call on every change and about once a second. */
    @Synchronized
    fun update(transfers: List<Transfer>, now: Long = System.currentTimeMillis()): Map<String, Rate> {
        val running = transfers.filter { it.state == "sending" || it.state == "receiving" }

        for (t in running) {
            val bytes = t.progress?.bytes ?: continue
            val list = samples.getOrPut(t.transferId) { ArrayDeque() }

            if (list.isEmpty() || list.last().bytes != bytes)
                list.addLast(Sample(now, bytes))

            while (list.size > 2 && now - list.first().t > WINDOW_MS)
                list.removeFirst()
        }

        samples.keys.retainAll(running.map { it.transferId }.toSet())

        return running.associate { t ->
            val list = samples[t.transferId]

            t.transferId to when {
                list == null || list.size < 2 -> Rate.Measuring
                now - list.last().t > STALL_MS -> Rate.Stalled
                list.last().t - list.first().t < MIN_SPAN_MS -> Rate.Measuring
                else -> {
                    val perSec = (list.last().bytes - list.first().bytes).toDouble() / (list.last().t - list.first().t) * 1000
                    val remaining = (t.totalBytes - list.last().bytes).coerceAtLeast(0)

                    Rate.Speed(perSec, if (perSec > 0) remaining / perSec else null)
                }
            }
        }
    }
}

/** Time left, readable: "42 s", "3 min 20 s", "1 h 5 min" (formatRemaining in useRates.js). */
fun formatRemaining(seconds: Double): String {
    val s = maxOf(1L, Math.round(seconds))

    return when {
        s < 60 -> "$s s"
        s < 3600 -> "${s / 60} min" + if (s % 60 != 0L) " ${s % 60} s" else ""
        else -> "${s / 3600} h" + if ((s % 3600) / 60 != 0L) " ${(s % 3600) / 60} min" else ""
    }
}
