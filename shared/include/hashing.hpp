#pragma once

#include <array>
#include <openssl/sha.h>

inline std::array<unsigned char, SHA256_DIGEST_LENGTH>
computeSHA256(const char* data, size_t size)
{
    std::array<unsigned char, SHA256_DIGEST_LENGTH> hash;

    SHA256(
        reinterpret_cast<const unsigned char*>(data),
        size,
        hash.data()
    );

    return hash;
}