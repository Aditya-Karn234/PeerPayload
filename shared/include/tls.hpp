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
// The receiver generates one self-signed certificate per process and
// publishes its SHA-256 fingerprint in its "listening" event. A sender run
// with --pin-sha256 checks the presented certificate against that
// fingerprint, which closes the machine-in-the-middle gap as long as the
// fingerprint reaches the sender over a channel it already trusts (the
// apps relay it through the backend over HTTPS). Without --pin-sha256 the
// sender accepts any certificate (SSL_VERIFY_NONE): encryption against
// passive eavesdropping, but no receiver authentication.
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

// Loads a device identity (PEM certificate + PEM private key, e.g. from
// ppkeygen) into a context, replacing the throwaway per-run certificate.
// With a lasting identity the certificate's fingerprint is a stable device
// ID that peers can pin and allow-list.
inline bool loadIdentity(SSL_CTX *ctx, const std::string &certPath, const std::string &keyPath, std::string &error)
{
    if (SSL_CTX_use_certificate_file(ctx, certPath.c_str(), SSL_FILETYPE_PEM) != 1)
    {
        error = "cannot load certificate " + certPath + ": " + tlsErrorText();
        return false;
    }

    if (SSL_CTX_use_PrivateKey_file(ctx, keyPath.c_str(), SSL_FILETYPE_PEM) != 1)
    {
        error = "cannot load private key " + keyPath + ": " + tlsErrorText();
        return false;
    }

    if (SSL_CTX_check_private_key(ctx) != 1)
    {
        error = "private key does not match certificate";
        return false;
    }

    return true;
}

// Mutual TLS: the peer must present a certificate. These are self-signed
// device certificates with no CA to chain to, so OpenSSL is told to accept
// any certificate during the handshake; the caller then checks the
// presented certificate's fingerprint against its allow-list, which is the
// actual authentication.
inline int acceptAnyPeerCertificate(int, X509_STORE_CTX *)
{
    return 1;
}

inline void requirePeerCertificate(SSL_CTX *ctx)
{
    SSL_CTX_set_verify(ctx, SSL_VERIFY_PEER | SSL_VERIFY_FAIL_IF_NO_PEER_CERT, acceptAnyPeerCertificate);
}

// certPath/keyPath empty: no client certificate (the default, as before).
// Given: presented when the receiver asks for one (receiver --peer-sha256).
inline SSL_CTX *createClientTlsContext(std::string &error, const std::string &certPath = "", const std::string &keyPath = "")
{
    SSL_CTX *ctx = SSL_CTX_new(TLS_client_method());

    if (!ctx)
    {
        error = tlsErrorText();
        return nullptr;
    }

    SSL_CTX_set_min_proto_version(ctx, TLS1_2_VERSION);

    // The receiver's certificate is self-signed, so there's no trust anchor
    // to verify it against here; --pin-sha256 checks it after the
    // handshake instead. See the file-level comment.
    SSL_CTX_set_verify(ctx, SSL_VERIFY_NONE, nullptr);

    if (!certPath.empty() && !loadIdentity(ctx, certPath, keyPath, error))
    {
        SSL_CTX_free(ctx);
        return nullptr;
    }

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

// certPath/keyPath empty: a throwaway certificate for this run (as before).
// Given: the device's lasting identity, so its fingerprint stays the same
// across runs.
inline SSL_CTX *createServerTlsContext(std::string &error, const std::string &certPath = "", const std::string &keyPath = "")
{
    SSL_CTX *ctx = SSL_CTX_new(TLS_server_method());

    if (!ctx)
    {
        error = tlsErrorText();
        return nullptr;
    }

    SSL_CTX_set_min_proto_version(ctx, TLS1_2_VERSION);

    if (!certPath.empty())
    {
        if (!loadIdentity(ctx, certPath, keyPath, error))
        {
            SSL_CTX_free(ctx);
            return nullptr;
        }

        return ctx;
    }

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

// Lowercase hex SHA-256 of the certificate's DER encoding, the same value
// `openssl x509 -fingerprint -sha256` prints (without the colons).
inline std::string certificateSha256(X509 *cert)
{
    unsigned char digest[EVP_MAX_MD_SIZE];
    unsigned int length = 0;

    if (!cert || X509_digest(cert, EVP_sha256(), digest, &length) != 1)
        return "";

    static const char *hex = "0123456789abcdef";

    std::string out;

    for (unsigned int i = 0; i < length; i++)
    {
        out += hex[digest[i] >> 4];
        out += hex[digest[i] & 0x0f];
    }

    return out;
}

inline std::string serverCertificateSha256(SSL_CTX *ctx)
{
    return certificateSha256(SSL_CTX_get0_certificate(ctx));
}

inline std::string peerCertificateSha256(SSL *ssl)
{
#if OPENSSL_VERSION_NUMBER >= 0x30000000L
    X509 *cert = SSL_get1_peer_certificate(ssl);
#else
    X509 *cert = SSL_get_peer_certificate(ssl);
#endif

    std::string fingerprint = certificateSha256(cert);

    X509_free(cert);

    return fingerprint;
}

inline std::string tlsConnectionSummary(SSL *ssl)
{
    return std::string(SSL_get_version(ssl)) + " " + SSL_get_cipher(ssl);
}

// -- send/recv over TLS, mirroring network_utils.hpp's raw-socket versions --

// On a blocking socket with SO_RCVTIMEO/SO_SNDTIMEO set, an expired timeout
// surfaces from OpenSSL as WANT_READ/WANT_WRITE (the socket BIO saw
// EAGAIN/WSAETIMEDOUT and asked to be retried), or as SYSCALL with the
// timeout still in the socket error.
inline bool tlsFailureWasTimeout(SSL *ssl, int ret)
{
    int err = SSL_get_error(ssl, ret);

    if (err == SSL_ERROR_WANT_READ || err == SSL_ERROR_WANT_WRITE)
        return true;

    return err == SSL_ERROR_SYSCALL && isTimeoutError(lastSocketError());
}

inline bool tlsSendAll(SSL *ssl, const char *data, int size)
{
    if (size < 0)
        return false;

    lastIoTimedOutFlag() = false;

    int total = 0;

    while (total < size)
    {
        int sent = SSL_write(ssl, data + total, size - total);

        if (sent <= 0)
        {
            lastIoTimedOutFlag() = tlsFailureWasTimeout(ssl, sent);
            return false;
        }

        total += sent;
    }

    return true;
}

inline bool tlsRecvAll(SSL *ssl, char *data, int size)
{
    if (size < 0)
        return false;

    lastIoTimedOutFlag() = false;

    int total = 0;

    while (total < size)
    {
        int received = SSL_read(ssl, data + total, size - total);

        if (received <= 0)
        {
            lastIoTimedOutFlag() = tlsFailureWasTimeout(ssl, received);
            return false;
        }

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
