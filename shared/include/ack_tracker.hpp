#pragma once

#include <condition_variable>
#include <cstdint>
#include <mutex>

// Coordinates the sender thread (which wants to send the next chunk) and the
// ack-listener thread (which frees up window slots as acks arrive) without
// either one touching the socket the other owns. Acks arrive in the same
// order chunks were sent — TCP preserves ordering on a single connection,
// and the receiver processes strictly in order — so this only needs a
// count, not a per-chunk map.
class AckTracker
{
public:
    explicit AckTracker(uint32_t windowSize)
        : windowSize_(windowSize)
    {
    }

    // Sender thread: blocks until a window slot is free. Returns false if
    // the transfer has already failed, in which case the caller should stop
    // sending rather than wait for a slot that will never open.
    bool acquireSlot()
    {
        std::unique_lock<std::mutex> lock(mutex_);

        cv_.wait(lock, [&] { return inFlight_ < windowSize_ || failed_; });

        if (failed_)
            return false;

        inFlight_++;

        return true;
    }

    // Ack-listener thread: called once per confirmed chunk.
    void onAcked(uint64_t bytes)
    {
        {
            std::lock_guard<std::mutex> lock(mutex_);

            inFlight_--;
            ackedCount_++;
            ackedBytes_ += bytes;
        }

        cv_.notify_all();
    }

    // Any thread, on a fatal condition (hash mismatch, socket error, an ack
    // for the wrong chunk id): wakes every waiter so the pipeline unwinds
    // instead of hanging.
    void fail()
    {
        {
            std::lock_guard<std::mutex> lock(mutex_);

            failed_ = true;
        }

        cv_.notify_all();
    }

    bool failed() const
    {
        std::lock_guard<std::mutex> lock(mutex_);

        return failed_;
    }

    // Sender thread, after the last chunk has been handed off: waits for
    // every outstanding ack before the terminator chunk is sent, since the
    // terminator and FileDone respond outside the ack window entirely.
    bool waitForDrain()
    {
        std::unique_lock<std::mutex> lock(mutex_);

        cv_.wait(lock, [&] { return inFlight_ == 0 || failed_; });

        return !failed_;
    }

    uint64_t ackedCount() const
    {
        std::lock_guard<std::mutex> lock(mutex_);

        return ackedCount_;
    }

    uint64_t ackedBytes() const
    {
        std::lock_guard<std::mutex> lock(mutex_);

        return ackedBytes_;
    }

private:
    mutable std::mutex mutex_;
    std::condition_variable cv_;
    uint32_t windowSize_;
    uint32_t inFlight_ = 0;
    uint64_t ackedCount_ = 0;
    uint64_t ackedBytes_ = 0;
    bool failed_ = false;
};
