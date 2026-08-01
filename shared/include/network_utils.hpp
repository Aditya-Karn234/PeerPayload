#pragma once

#include "platform_socket.hpp"
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
            return false;

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
            return false;

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
