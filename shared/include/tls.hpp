#pragma once

#include "platform_socket.hpp"

#include <openssl/ssl.h>
#include <openssl/err.h>
#include <openssl/x509.h>
#include <openssl/evp.h>

#include <string>

// Every byte of the protocol goes over TLS — there is no plaintext fallback
// in normal operation (see --no-tls in sender/receiver for the one
// exception, a matched-pair debug flag for local benchmarking only).
//
// This is encryption without receiver authentication: the receiver
// generates a fresh self-signed certificate every time it starts, and the
// sender accepts any certificate (SSL_VERIFY_NONE) rather than checking it
// against a trust anchor. There is no established identity to check it
// against — this is a peer-to-peer tool, not a service with a stable,
// publishable certificate. That protects the transfer against passive
// eavesdropping on the wire but NOT against an active machine-in-the-middle
// on the very first connection to a given receiver. Pinning the
// certificate's fingerprint on repeat connections (SSH-host-key style)
// would close that gap; it isn't implemented here.
//
// Threading note: exactly one thread may call the send-side functions here
// and, concurrently, exactly one (different) thread may call the recv-side
// functions on the same SSL* — that's OpenSSL's documented contract, and
// it's exactly the sender-thread/ack-listener-thread split the pipeline
// already uses for the raw socket.

inline std::string tlsErrorText()
{
    unsigned long code = ERR_get_error();

    if (code == 0)
        return "no OpenSSL error recorded";

    char buf[256];

    ERR_error_string_n(code, buf, sizeof(buf));

    return std::string(buf);
}

inline SSL_CTX *createClientTlsContext(std::string &error)
{
    SSL_CTX *ctx = SSL_CTX_new(TLS_client_method());

    if (!ctx)
    {
        error = tlsErrorText();
        return nullptr;
    }

    SSL_CTX_set_min_proto_version(ctx, TLS1_2_VERSION);

    // No trust anchor to check the receiver's ephemeral self-signed
    // certificate against — see the file-level comment.
    SSL_CTX_set_verify(ctx, SSL_VERIFY_NONE, nullptr);

    return ctx;
}

// Builds a throwaway self-signed certificate + key pair, valid for a couple
// of days (this process's lifetime is minutes, not days — the margin is
// just to avoid clock-skew edge cases, not because the cert is meant to
// outlive the run). Returns false and leaves *cert/*key untouched on
// failure.
inline bool generateEphemeralCertificate(X509 **outCert, EVP_PKEY **outKey, std::string &error)
{
    EVP_PKEY *pkey = EVP_RSA_gen(2048);

    if (!pkey)
    {
        error = tlsErrorText();
        return false;
    }

    X509 *cert = X509_new();

    if (!cert)
    {
        error = tlsErrorText();
        EVP_PKEY_free(pkey);
        return false;
    }

    X509_set_version(cert, 2); // X.509v3

    ASN1_INTEGER_set(X509_get_serialNumber(cert), 1);

    X509_gmtime_adj(X509_getm_notBefore(cert), 0);
    X509_gmtime_adj(X509_getm_notAfter(cert), 60 * 60 * 24 * 2);

    X509_set_pubkey(cert, pkey);

    X509_NAME *name = X509_get_subject_name(cert);

    X509_NAME_add_entry_by_txt(
        name, "CN", MBSTRING_ASC,
        reinterpret_cast<const unsigned char *>("data-transfer-sys (ephemeral)"),
        -1, -1, 0);

    X509_set_issuer_name(cert, name); // self-signed: issuer == subject

    if (!X509_sign(cert, pkey, EVP_sha256()))
    {
        error = tlsErrorText();
        X509_free(cert);
        EVP_PKEY_free(pkey);
        return false;
    }

    *outCert = cert;
    *outKey = pkey;

    return true;
}

inline SSL_CTX *createServerTlsContext(std::string &error)
{
    SSL_CTX *ctx = SSL_CTX_new(TLS_server_method());

    if (!ctx)
    {
        error = tlsErrorText();
        return nullptr;
    }

    SSL_CTX_set_min_proto_version(ctx, TLS1_2_VERSION);

    X509 *cert = nullptr;
    EVP_PKEY *pkey = nullptr;

    if (!generateEphemeralCertificate(&cert, &pkey, error))
    {
        SSL_CTX_free(ctx);
        return nullptr;
    }

    // SSL_CTX_use_certificate/use_PrivateKey take their own reference, so
    // our copies are released right after handing them over.
    bool ok =
        SSL_CTX_use_certificate(ctx, cert) == 1 &&
        SSL_CTX_use_PrivateKey(ctx, pkey) == 1;

    X509_free(cert);
    EVP_PKEY_free(pkey);

    if (!ok)
    {
        error = tlsErrorText();
        SSL_CTX_free(ctx);
        return nullptr;
    }

    return ctx;
}

inline SSL *performClientHandshake(SSL_CTX *ctx, SOCKET sock, std::string &error)
{
    SSL *ssl = SSL_new(ctx);

    if (!ssl)
    {
        error = tlsErrorText();
        return nullptr;
    }

    SSL_set_fd(ssl, static_cast<int>(sock));

    if (SSL_connect(ssl) != 1)
    {
        error = tlsErrorText();
        SSL_free(ssl);
        return nullptr;
    }

    return ssl;
}

inline SSL *performServerHandshake(SSL_CTX *ctx, SOCKET sock, std::string &error)
{
    SSL *ssl = SSL_new(ctx);

    if (!ssl)
    {
        error = tlsErrorText();
        return nullptr;
    }

    SSL_set_fd(ssl, static_cast<int>(sock));

    if (SSL_accept(ssl) != 1)
    {
        error = tlsErrorText();
        SSL_free(ssl);
        return nullptr;
    }

    return ssl;
}

inline void closeTlsConnection(SSL *ssl)
{
    if (!ssl)
        return;

    SSL_shutdown(ssl);
    SSL_free(ssl);
}

inline std::string tlsConnectionSummary(SSL *ssl)
{
    return std::string(SSL_get_version(ssl)) + " " + SSL_get_cipher(ssl);
}

// -- send/recv over TLS, mirroring network_utils.hpp's raw-socket versions --

inline bool tlsSendAll(SSL *ssl, const char *data, int size)
{
    if (size < 0)
        return false;

    int total = 0;

    while (total < size)
    {
        int sent = SSL_write(ssl, data + total, size - total);

        if (sent <= 0)
            return false;

        total += sent;
    }

    return true;
}

inline bool tlsRecvAll(SSL *ssl, char *data, int size)
{
    if (size < 0)
        return false;

    int total = 0;

    while (total < size)
    {
        int received = SSL_read(ssl, data + total, size - total);

        if (received <= 0)
            return false;

        total += received;
    }

    return true;
}

template <typename T>
inline bool tlsSendStruct(SSL *ssl, const T &value)
{
    return tlsSendAll(
        ssl,
        reinterpret_cast<const char *>(&value),
        static_cast<int>(sizeof(T)));
}

template <typename T>
inline bool tlsRecvStruct(SSL *ssl, T &value)
{
    return tlsRecvAll(
        ssl,
        reinterpret_cast<char *>(&value),
        static_cast<int>(sizeof(T)));
}
