#pragma once

#include "network_utils.hpp"
#include "tls.hpp"

// Dispatches to TLS or the raw socket depending on which was negotiated,
// so call sites don't need two copies of every send/recv. ssl == nullptr
// means --no-tls (see sender/receiver --help) — a matched-pair debug flag
// for local benchmarking, not a supported production mode.
struct Transport
{
    SOCKET sock = INVALID_SOCKET;
    SSL *ssl = nullptr;
};

inline bool transportSendAll(const Transport &t, const char *data, int size)
{
    return t.ssl ? tlsSendAll(t.ssl, data, size) : sendAll(t.sock, data, size);
}

inline bool transportRecvAll(const Transport &t, char *data, int size)
{
    return t.ssl ? tlsRecvAll(t.ssl, data, size) : recvAll(t.sock, data, size);
}

template <typename T>
inline bool transportSendStruct(const Transport &t, const T &value)
{
    return transportSendAll(
        t,
        reinterpret_cast<const char *>(&value),
        static_cast<int>(sizeof(T)));
}

template <typename T>
inline bool transportRecvStruct(const Transport &t, T &value)
{
    return transportRecvAll(
        t,
        reinterpret_cast<char *>(&value),
        static_cast<int>(sizeof(T)));
}
