#pragma once

// The one header that knows the difference between Winsock2 and POSIX
// sockets. Everything else in this codebase writes SOCKET/INVALID_SOCKET/
// closesocket()/send()/recv()/setsockopt() and doesn't care which platform
// it's actually running on — this header makes those names resolve to the
// right thing on each side.

#ifdef _WIN32

#include <winsock2.h>
#include <ws2tcpip.h>
#include <string>

#pragma comment(lib, "ws2_32.lib")

inline bool platformSocketStartup(std::string &error)
{
    WSADATA wsa;

    int rc = WSAStartup(MAKEWORD(2, 2), &wsa);

    if (rc != 0)
    {
        error = "WSAStartup failed";
        return false;
    }

    return true;
}

inline void platformSocketCleanup()
{
    WSACleanup();
}

inline int lastSocketError()
{
    return WSAGetLastError();
}

// Winsock's accept()/getsockname() take int* for the address-length
// out-param; POSIX's take socklen_t* (unsigned). Named distinctly rather
// than defining our own `socklen_t` on Windows, to avoid any risk of
// colliding with a definition ws2tcpip.h might add in a future SDK.
using platform_socklen_t = int;

#else // POSIX

#include <sys/socket.h>
#include <sys/types.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <arpa/inet.h>
#include <netdb.h>
#include <sys/select.h>
#include <sys/time.h>
#include <fcntl.h>
#include <unistd.h>
#include <cerrno>
#include <string>

// Mirrors the handful of Winsock names the rest of the codebase already
// uses, so call sites (send/recv/setsockopt/bind/listen/accept/connect/
// getaddrinfo — all POSIX-standard too) don't need touching.
using SOCKET = int;
constexpr SOCKET INVALID_SOCKET = -1;
constexpr int SOCKET_ERROR = -1;

inline int closesocket(SOCKET s)
{
    return ::close(s);
}

inline bool platformSocketStartup(std::string &)
{
    return true; // nothing to initialize on POSIX
}

inline void platformSocketCleanup()
{
}

inline int lastSocketError()
{
    return errno;
}

using platform_socklen_t = socklen_t;

#endif

// On POSIX, writing to a connection the peer has already closed raises
// SIGPIPE, whose default action kills the whole process — no
// transfer_failed event, no exit code worth reading, and in library use
// (Android) the host app dies with it. Ignoring it turns that into an
// ordinary EPIPE error that's reported and retried like any dropped link.
// Process-wide, as networking code generally requires; Android's runtime
// already ignores SIGPIPE in app processes. Idempotent; no-op on Windows.
#ifndef _WIN32
#include <csignal>
#include <mutex>
#endif

inline void ignoreSigpipe()
{
#ifndef _WIN32
    static std::once_flag once;

    std::call_once(once, [] { std::signal(SIGPIPE, SIG_IGN); });
#endif
}

// send() flag that suppresses SIGPIPE per call where the platform has it.
#if defined(MSG_NOSIGNAL)
constexpr int PLATFORM_SEND_FLAGS = MSG_NOSIGNAL;
#else
constexpr int PLATFORM_SEND_FLAGS = 0;
#endif

// True when a failed send()/recv() gave up because SO_SNDTIMEO/SO_RCVTIMEO
// expired, as opposed to the peer closing or resetting the connection.
inline bool isTimeoutError(int code)
{
#ifdef _WIN32
    return code == WSAETIMEDOUT || code == WSAEWOULDBLOCK;
#else
    return code == EAGAIN || code == EWOULDBLOCK || code == ETIMEDOUT;
#endif
}

// Set by every send/recv helper (raw and TLS) when its last failure was an
// idle timeout. Per-thread because the sender pipeline's network thread and
// ack-listener thread fail independently, and each maps its own failure to
// a reason code.
inline bool &lastIoTimedOutFlag()
{
    thread_local bool flag = false;

    return flag;
}

inline bool lastIoTimedOut()
{
    return lastIoTimedOutFlag();
}
