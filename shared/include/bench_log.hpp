#pragma once

#include <chrono>
#include <fstream>
#include <mutex>
#include <string>
#include <vector>

// Per-chunk stage timing for --bench: when and how long each pipeline stage
// (disk read, hash, network send) took for each chunk, relative to the
// transfer's start. This is the diagnostic view — "where did the time go" —
// as opposed to the single before/after throughput number the benchmark
// harness (tools/benchmark.ps1) already gets from the transfer_complete
// event. A no-op (and effectively free) when no path is given.
class BenchLog
{
public:
    explicit BenchLog(std::string path)
        : path_(std::move(path))
        , enabled_(!path_.empty())
        , start_(std::chrono::steady_clock::now())
    {
    }

    bool enabled() const
    {
        return enabled_;
    }

    void record(
        uint64_t chunkId,
        const char *stage,
        std::chrono::steady_clock::time_point stageStart,
        std::chrono::steady_clock::time_point stageEnd)
    {
        if (!enabled_)
            return;

        Sample sample;

        sample.chunkId = chunkId;
        sample.stage = stage;
        sample.startMs = std::chrono::duration<double, std::milli>(stageStart - start_).count();
        sample.endMs = std::chrono::duration<double, std::milli>(stageEnd - start_).count();

        std::lock_guard<std::mutex> lock(mutex_);

        samples_.push_back(std::move(sample));
    }

    bool save() const
    {
        if (!enabled_)
            return true;

        std::ofstream out(path_, std::ios::trunc);

        if (!out)
            return false;

        out << "chunkId,stage,startMs,endMs\n";

        std::lock_guard<std::mutex> lock(mutex_);

        for (const auto &sample : samples_)
        {
            out << sample.chunkId << ','
                << sample.stage << ','
                << sample.startMs << ','
                << sample.endMs << '\n';
        }

        return static_cast<bool>(out);
    }

private:
    struct Sample
    {
        uint64_t chunkId;
        std::string stage;
        double startMs;
        double endMs;
    };

    std::string path_;
    bool enabled_;
    std::chrono::steady_clock::time_point start_;
    mutable std::mutex mutex_;
    std::vector<Sample> samples_;
};
