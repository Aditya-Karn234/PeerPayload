#pragma once

#include <cstdlib>
#include <chrono>
#include <thread>

// A deterministic, reproducible substitute for a real WAN emulator: reads
// DTS_BENCH_LATENCY_MS once and sleeps that long every time it's called.
// Localhost RTT is near-zero, which hides exactly the stop-and-wait
// bottleneck this is meant to expose — this lets an A/B benchmark simulate
// real network latency without installing a separate emulation tool.
// No-op (and effectively free) when the env var is unset.
inline void simulateAckLatency()
{
    static const int delayMs = [] {
        const char *raw = std::getenv("DTS_BENCH_LATENCY_MS");

        return raw ? std::atoi(raw) : 0;
    }();

    if (delayMs > 0)
        std::this_thread::sleep_for(std::chrono::milliseconds(delayMs));
}
