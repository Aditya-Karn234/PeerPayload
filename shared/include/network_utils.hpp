#pragma once

#include "platform_socket.hpp"
#include "run_context.hpp"
#include <string>
#include <cstring>
#include <mutex>

inline bool sendAll(
    SOCKET sock,
    const char *data,
    int size)
{
    if (size < 0)
        return false;

    lastIoTimedOutFlag() = false;

    int total = 0;

    while (total < size)
    {
        int sent =
            send(
                sock,
                data + total,
                size - total,
                0);

        if (sent <= 0)
        {
            lastIoTimedOutFlag() = sent < 0 && isTimeoutError(lastSocketError());
            return false;
        }

        total += sent;
    }

    return true;
}

inline bool recvAll(
    SOCKET sock,
    char *data,
    int size)
{
    if (size < 0)
        return false;

    lastIoTimedOutFlag() = false;

    int total = 0;

    while (total < size)
    {
        int received =
            recv(
                sock,
                data + total,
                size - total,
                0);

        if (received <= 0)
        {
            lastIoTimedOutFlag() = received < 0 && isTimeoutError(lastSocketError());
            return false;
        }

        total += received;
    }

    return true;
}

// Thin wrappers so call sites stop repeating the reinterpret_cast/sizeof pair,
// which is where a mismatched length would hide.
template <typename T>
inline bool sendStruct(SOCKET sock, const T &value)
{
    return sendAll(
        sock,
        reinterpret_cast<const char *>(&value),
        static_cast<int>(sizeof(T)));
}

template <typename T>
inline bool recvStruct(SOCKET sock, T &value)
{
    return recvAll(
        sock,
        reinterpret_cast<char *>(&value),
        static_cast<int>(sizeof(T)));
}

// With stop-and-wait, a small default send/recv buffer never mattered — only
// one chunk was ever in flight. Pipelining puts several chunks in flight at
// once, and the header+data+ack pattern is exactly the small-message
// request/response shape Nagle's algorithm and delayed ACKs were designed
// to batch — which fights pipelining instead of helping it. windowBytes
// should cover a full send window (chunks in flight * chunk size) so the OS
// doesn't itself become the bottleneck.
inline void tuneSocketForPipelining(SOCKET sock, int windowBytes)
{
    // Plain int rather than Windows' BOOL/TRUE: setsockopt takes a raw byte
    // buffer either way, and an int-sized 1 is what both platforms expect
    // for a boolean sockopt.
    int noDelay = 1;

    setsockopt(
        sock,
        IPPROTO_TCP,
        TCP_NODELAY,
        reinterpret_cast<const char *>(&noDelay),
        sizeof(noDelay));

    setsockopt(
        sock,
        SOL_SOCKET,
        SO_SNDBUF,
        reinterpret_cast<const char *>(&windowBytes),
        sizeof(windowBytes));

    setsockopt(
        sock,
        SOL_SOCKET,
        SO_RCVBUF,
        reinterpret_cast<const char *>(&windowBytes),
        sizeof(windowBytes));
}

// Bounds every blocking send()/recv() on this socket. Without it, a peer
// that vanishes without a FIN/RST (laptop asleep, Wi-Fi or VPN dropped, NAT
// entry expired) leaves the other side blocked in recv() forever. The
// timeout is per call, not per transfer: a slow but live link keeps each
// call returning, so only a genuinely silent peer trips it. 0 disables it.
inline void setSocketTimeouts(SOCKET sock, int timeoutMs)
{
    if (timeoutMs <= 0)
        return;

#ifdef _WIN32
    DWORD value = static_cast<DWORD>(timeoutMs);
#else
    timeval value{};

    value.tv_sec = timeoutMs / 1000;
    value.tv_usec = (timeoutMs % 1000) * 1000;
#endif

    setsockopt(sock, SOL_SOCKET, SO_RCVTIMEO, reinterpret_cast<const char *>(&value), sizeof(value));
    setsockopt(sock, SOL_SOCKET, SO_SNDTIMEO, reinterpret_cast<const char *>(&value), sizeof(value));
}

// TCP keepalive with short probe intervals, so NAT/firewall state for a
// long transfer isn't expired as idle and a dead path is noticed by the OS
// within about a minute rather than the default two hours. Best-effort:
// the per-option knobs are skipped where the platform headers lack them.
inline void enableKeepalive(SOCKET sock)
{
    int on = 1;

    setsockopt(sock, SOL_SOCKET, SO_KEEPALIVE, reinterpret_cast<const char *>(&on), sizeof(on));

#if defined(TCP_KEEPIDLE)
    int idle = 30;
    setsockopt(sock, IPPROTO_TCP, TCP_KEEPIDLE, reinterpret_cast<const char *>(&idle), sizeof(idle));
#endif
#if defined(TCP_KEEPINTVL)
    int interval = 10;
    setsockopt(sock, IPPROTO_TCP, TCP_KEEPINTVL, reinterpret_cast<const char *>(&interval), sizeof(interval));
#endif
#if defined(TCP_KEEPCNT)
    int count = 3;
    setsockopt(sock, IPPROTO_TCP, TCP_KEEPCNT, reinterpret_cast<const char *>(&count), sizeof(count));
#endif
}

// Blocks until the socket is readable (e.g. a listener has a pending
// connection) or timeoutMs passes. Returns false on timeout or error.
inline bool waitReadable(SOCKET sock, int timeoutMs)
{
    fd_set readSet;

    FD_ZERO(&readSet);
    FD_SET(sock, &readSet);

    timeval tv{};

    tv.tv_sec = timeoutMs / 1000;
    tv.tv_usec = (timeoutMs % 1000) * 1000;

    // The first argument is ignored by Winsock and is nfds on POSIX.
    int rc = select(static_cast<int>(sock) + 1, &readSet, nullptr, nullptr, &tv);

    return rc > 0;
}

inline bool setBlocking(SOCKET sock, bool blocking)
{
#ifdef _WIN32
    u_long nonBlocking = blocking ? 0 : 1;

    return ioctlsocket(sock, FIONBIO, &nonBlocking) == 0;
#else
    int flags = fcntl(sock, F_GETFL, 0);

    if (flags < 0)
        return false;

    flags = blocking ? (flags & ~O_NONBLOCK) : (flags | O_NONBLOCK);

    return fcntl(sock, F_SETFL, flags) == 0;
#endif
}

enum class ConnectResult
{
    Connected,
    Failed,   // refused, unreachable, or timed out; errorCode says which
    Cancelled // cancelRequested() became true while waiting
};

// connect() that a library caller can cancel and that gives up after
// timeoutMs. A plain blocking connect() can't be interrupted, so the
// socket is made non-blocking, polled in short slices that check for
// cancellation, then made blocking again for the rest of the protocol.
inline ConnectResult connectWithCancel(SOCKET sock, const sockaddr *addr, int addrLen, int timeoutMs, int &errorCode)
{
    errorCode = 0;

    if (!setBlocking(sock, false))
    {
        errorCode = lastSocketError();
        return ConnectResult::Failed;
    }

    if (connect(sock, addr, addrLen) == 0)
    {
        setBlocking(sock, true);
        return ConnectResult::Connected;
    }

    int err = lastSocketError();

#ifdef _WIN32
    bool inProgress = err == WSAEWOULDBLOCK || err == WSAEINPROGRESS;
#else
    bool inProgress = err == EINPROGRESS;
#endif

    if (!inProgress)
    {
        errorCode = err;
        return ConnectResult::Failed;
    }

    for (int waited = 0; timeoutMs <= 0 || waited < timeoutMs; waited += 200)
    {
        if (cancelRequested())
            return ConnectResult::Cancelled;

        fd_set writeSet;
        fd_set errorSet;

        FD_ZERO(&writeSet);
        FD_ZERO(&errorSet);
        FD_SET(sock, &writeSet);
        FD_SET(sock, &errorSet);

        timeval tv{};

        tv.tv_usec = 200 * 1000;

        // Winsock reports a failed connect through the error set, POSIX
        // through writability plus SO_ERROR; checking both covers either.
        int rc = select(static_cast<int>(sock) + 1, nullptr, &writeSet, &errorSet, &tv);

        if (rc < 0)
        {
            errorCode = lastSocketError();
            return ConnectResult::Failed;
        }

        if (rc == 0)
            continue;

        int soError = 0;
        platform_socklen_t len = sizeof(soError);

        getsockopt(sock, SOL_SOCKET, SO_ERROR, reinterpret_cast<char *>(&soError), &len);

        if (soError != 0 || FD_ISSET(sock, &errorSet))
        {
            errorCode = soError ? soError : lastSocketError();
            return ConnectResult::Failed;
        }

        setBlocking(sock, true);
        return ConnectResult::Connected;
    }

#ifdef _WIN32
    errorCode = WSAETIMEDOUT;
#else
    errorCode = ETIMEDOUT;
#endif

    return ConnectResult::Failed;
}

#ifdef _WIN32

inline std::string socketErrorText(int code = lastSocketError())
{
    char *buffer = nullptr;

    DWORD length =
        FormatMessageA(
            FORMAT_MESSAGE_ALLOCATE_BUFFER |
                FORMAT_MESSAGE_FROM_SYSTEM |
                FORMAT_MESSAGE_IGNORE_INSERTS,
            nullptr,
            static_cast<DWORD>(code),
            0,
            reinterpret_cast<char *>(&buffer),
            0,
            nullptr);

    if (length == 0 || buffer == nullptr)
        return "error " + std::to_string(code);

    std::string message(buffer, length);

    LocalFree(buffer);

    while (!message.empty() &&
           (message.back() == '\n' || message.back() == '\r'))
    {
        message.pop_back();
    }

    return message + " (" + std::to_string(code) + ")";
}

#else

// strerror() isn't guaranteed thread-safe (it may return a pointer to a
// shared static buffer), and this codebase does have multiple threads that
// could hit a socket error around the same time — serialize with a mutex
// rather than fight strerror_r's two incompatible platform signatures.
inline std::string socketErrorText(int code = lastSocketError())
{
    static std::mutex mutex;

    std::lock_guard<std::mutex> lock(mutex);

    return std::string(strerror(code)) + " (" + std::to_string(code) + ")";
}

#endif
