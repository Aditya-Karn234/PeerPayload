#pragma once

#include <filesystem>
#include <string>

#include <openssl/bio.h>
#include <openssl/bn.h>
#include <openssl/evp.h>
#include <openssl/pem.h>
#include <openssl/rand.h>
#include <openssl/x509.h>

#include "tls.hpp"

#ifndef _WIN32
#include <sys/stat.h>
#endif

// Device identities for PeerPayload Connect: an Ed25519 key pair and a
// self-signed certificate for it, generated on the device and never sent
// anywhere. The certificate's SHA-256 fingerprint is the device's ID —
// what a contact pins (sender --pin-sha256) or allow-lists
// (receiver --peer-sha256) after pairing.
//
// The certificate is self-signed and never expires on purpose: nothing
// chains to a certificate authority, so trust comes only from contacts
// having pinned this exact certificate. Reissuing it would change the
// device ID and break every pairing.

struct IdentityFiles
{
    std::filesystem::path certPath;
    std::filesystem::path keyPath;
};

inline IdentityFiles identityPaths(const std::filesystem::path &dir)
{
    return {dir / "device.crt", dir / "device.key"};
}

inline bool writePem(const std::filesystem::path &path, bool privateKey, X509 *cert, EVP_PKEY *key, std::string &error)
{
    BIO *bio = BIO_new_file(path.string().c_str(), "wb");

    if (!bio)
    {
        error = "cannot write " + path.string() + ": " + tlsErrorText();
        return false;
    }

    bool ok = privateKey
                  ? PEM_write_bio_PrivateKey(bio, key, nullptr, nullptr, 0, nullptr, nullptr) == 1
                  : PEM_write_bio_X509(bio, cert) == 1;

    BIO_free(bio);

    if (!ok)
        error = "cannot write " + path.string() + ": " + tlsErrorText();

    return ok;
}

// Creates <dir>/device.crt and <dir>/device.key. Refuses to replace an
// existing identity unless overwrite is set, since that would silently
// change the device ID. On success sets fingerprint (lowercase hex).
inline bool generateIdentity(
    const std::filesystem::path &dir,
    const std::string &name,
    bool overwrite,
    std::string &fingerprint,
    std::string &error)
{
    IdentityFiles files = identityPaths(dir);
    std::error_code ec;

    if (!overwrite && (std::filesystem::exists(files.certPath, ec) || std::filesystem::exists(files.keyPath, ec)))
    {
        error = "an identity already exists in " + dir.string() + " (use --force to replace it; this changes the device ID)";
        return false;
    }

    std::filesystem::create_directories(dir, ec);

    if (ec)
    {
        error = "cannot create " + dir.string() + ": " + ec.message();
        return false;
    }

    EVP_PKEY *key = EVP_PKEY_Q_keygen(nullptr, nullptr, "ED25519");

    if (!key)
    {
        error = "key generation failed: " + tlsErrorText();
        return false;
    }

    X509 *cert = X509_new();
    bool ok = cert != nullptr;

    if (ok)
    {
        X509_set_version(cert, 2); // X.509v3

        // Random serial: two devices' certificates must never be identical.
        unsigned char serial[16];

        RAND_bytes(serial, sizeof(serial));
        serial[0] &= 0x7f; // keep it positive

        BIGNUM *bn = BN_bin2bn(serial, sizeof(serial), nullptr);

        BN_to_ASN1_INTEGER(bn, X509_get_serialNumber(cert));
        BN_free(bn);

        X509_gmtime_adj(X509_getm_notBefore(cert), -60 * 60 * 24); // tolerate clock skew
        // RFC 5280's "no well-defined expiration date".
        ASN1_TIME_set_string_X509(X509_getm_notAfter(cert), "99991231235959Z");

        X509_set_pubkey(cert, key);

        X509_NAME *subject = X509_get_subject_name(cert);
        std::string commonName = name.empty() ? "PeerPayload device" : name;

        X509_NAME_add_entry_by_txt(
            subject, "CN", MBSTRING_UTF8,
            reinterpret_cast<const unsigned char *>(commonName.c_str()), -1, -1, 0);
        X509_set_issuer_name(cert, subject);

        // Ed25519 signs without a separate digest.
        ok = X509_sign(cert, key, nullptr) > 0;

        if (!ok)
            error = "certificate signing failed: " + tlsErrorText();
    }
    else
    {
        error = "certificate allocation failed";
    }

    ok = ok &&
         writePem(files.keyPath, true, nullptr, key, error) &&
         writePem(files.certPath, false, cert, nullptr, error);

#ifndef _WIN32
    // Only the owner may read the private key. (On Windows the per-user
    // profile/app-data ACLs do the same job.)
    if (ok)
        chmod(files.keyPath.string().c_str(), S_IRUSR | S_IWUSR);
#endif

    if (ok)
        fingerprint = certificateSha256(cert);

    X509_free(cert);
    EVP_PKEY_free(key);

    return ok;
}

// Fingerprint of a PEM certificate file, or "" if it can't be read.
inline std::string certificateFileSha256(const std::filesystem::path &certPath, std::string *commonName = nullptr)
{
    BIO *bio = BIO_new_file(certPath.string().c_str(), "rb");

    if (!bio)
        return "";

    X509 *cert = PEM_read_bio_X509(bio, nullptr, nullptr, nullptr);

    BIO_free(bio);

    if (!cert)
        return "";

    if (commonName)
    {
        char buf[256] = {};

        X509_NAME_get_text_by_NID(X509_get_subject_name(cert), NID_commonName, buf, sizeof(buf));
        *commonName = buf;
    }

    std::string fingerprint = certificateSha256(cert);

    X509_free(cert);

    return fingerprint;
}
