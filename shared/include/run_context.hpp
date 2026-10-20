#pragma once

#include <algorithm>
#include <atomic>
#include <functional>
#include <mutex>
#include <string>
#include <vector>

#include "platform_socket.hpp"

// One sender or receiver run when the engine is used as a library (see
// engine/include/peerpayload.h). The command-line binaries never create
// one: with no current run, events go to stdout exactly as before and
// nothing can cancel.
//
// A run is "current" per thread. The library entry point sets it on the
// calling thread, and the sender's pipeline threads inherit it, so events
// reach the right callback even with several transfers in one process.
struct RunContext
{
    // Receives each event as one JSON object (no trailing newline).
    std::function<void(const std::string &)> onEvent;
    // Serializes onEvent: the sender's threads emit concurrently.
    std::mutex eventMutex;

    std::atomic<bool> cancelled{false};

    std::mutex socketsMutex;
    std::vector<SOCKET> sockets;
};

inline RunContext *&currentRun()
{
    thread_local RunContext *run = nullptr;

    return run;
}

inline bool cancelRequested()
{
    RunContext *run = currentRun();

    return run && run->cancelled.load();
}

// Cancels a run from any thread: marks it, then shuts down every socket it
// has registered, which makes any send/recv blocked on them return at once.
// Loops that wait without a socket (accepting, connecting) poll
// cancelRequested() instead.
inline void cancelRun(RunContext &run)
{
    run.cancelled.store(true);

    std::lock_guard<std::mutex> lock(run.socketsMutex);

    for (SOCKET s : run.sockets)
    {
#ifdef _WIN32
        shutdown(s, SD_BOTH);
#else
        shutdown(s, SHUT_RDWR);
#endif
    }
}

// Registers a connected socket with the current run (if any) for as long as
// this object lives, so cancelRun() can interrupt it. Must be destroyed
// before the socket is closed.
class RunSocketGuard
{
public:
    explicit RunSocketGuard(SOCKET sock)
        : run_(currentRun())
        , sock_(sock)
    {
        if (!run_)
            return;

        std::lock_guard<std::mutex> lock(run_->socketsMutex);

        run_->sockets.push_back(sock_);

        // Cancelled before we registered: honour it now.
        if (run_->cancelled.load())
        {
#ifdef _WIN32
            shutdown(sock_, SD_BOTH);
#else
            shutdown(sock_, SHUT_RDWR);
#endif
        }
    }

    ~RunSocketGuard()
    {
        release();
    }

    // Unregisters now; call right before closing the socket on an early
    // exit path, so a concurrent cancel never touches a closed handle.
    void release()
    {
        if (!run_)
            return;

        std::lock_guard<std::mutex> lock(run_->socketsMutex);

        run_->sockets.erase(std::remove(run_->sockets.begin(), run_->sockets.end(), sock_), run_->sockets.end());
        run_ = nullptr;
    }

    RunSocketGuard(const RunSocketGuard &) = delete;
    RunSocketGuard &operator=(const RunSocketGuard &) = delete;

private:
    RunContext *run_;
    SOCKET sock_;
};
