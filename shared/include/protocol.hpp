#pragma once

#include <cstdint>

constexpr int DEFAULT_PORT = 8080;

// Default chunk size when the sender doesn't override it with --chunk-size.
// The actual value used for a session travels in SessionHeader::chunkSize —
// nothing in the wire format is tied to this constant anymore.
constexpr uint32_t DEFAULT_CHUNK_SIZE = 64 * 1024;
constexpr uint32_t MIN_CHUNK_SIZE = 4 * 1024;
constexpr uint32_t MAX_CHUNK_SIZE = 8 * 1024 * 1024;

// "DTS1" on the wire. Guards against a peer that speaks something else
// entirely connecting to the port and being read as a valid session.
constexpr uint32_t PROTOCOL_MAGIC = 0x44545331;
// v10: SessionHeader negotiates a per-session chunk size instead of every
// build sharing one compile-time constant, and a hash mismatch now aborts
// the session (relying on resume) rather than retrying the chunk in place —
// both required once chunks can be pipelined instead of stop-and-wait.
// v11: the connection is TLS from the first byte (see shared/include/tls.hpp)
// — every struct below still has the same layout, but an old v10 peer
// sends/expects these bytes in plaintext immediately after connect(), so it
// can't complete a handshake with a v11 peer at all. That's caught at the
// TLS layer (handshake failure) rather than by the magic/version check this
// field normally enables, since a v10 sender's first bytes look like
// garbage to a v11 receiver's TLS stack, not like a parseable SessionHeader.
// v12: SessionHeader grows a fixed-size token field for optional receiver-
// side authentication (--token on the receiver). A v11 peer's SessionHeader
// is a different size, so the version check below now also acts as a size
// guard against that mismatch.
constexpr uint32_t PROTOCOL_VERSION = 12;

constexpr uint32_t MAX_PATH_LEN = 256;

// Fixed-size, zero-padded shared-secret field on SessionHeader. Not a
// cryptographic credential exchange — just enough to stop an open port from
// accepting literally anyone, for a receiver deliberately left listening for
// a specific sender it already shared this string with out of band.
constexpr uint32_t TOKEN_LEN = 64;

// Sanity bounds for values that arrive off the socket. Anything past these
// is a corrupt or hostile peer, not a big transfer.
constexpr uint64_t MAX_FILE_COUNT = 1000000;

// Structs go on the wire byte for byte, so pin the layout instead of
// trusting both ends to pick the same padding.
#pragma pack(push, 1)

// One per connection, first thing the sender writes.
struct SessionHeader
{
    uint32_t magic;
    uint32_t version;
    uint64_t fileCount;
    uint64_t totalBytes;
    uint32_t chunkSize;
    // Zero-padded; all zero bytes means "no token supplied". A receiver
    // started without --token ignores this field entirely.
    char token[TOKEN_LEN];
};

enum : uint8_t
{
    SESSION_OK = 0,
    SESSION_BAD_MAGIC = 1,
    SESSION_BAD_VERSION = 2,
    SESSION_BAD_COUNT = 3,
    SESSION_LOCAL_ERROR = 4,
    SESSION_BAD_CHUNK_SIZE = 5,
    SESSION_AUTH_FAILED = 6,
};

struct SessionAck
{
    uint8_t accepted;
    uint8_t reason;
};

// One per file. relPath is the path relative to the transfer root and is
// always '/'-separated; the receiver must sanitize it before touching disk.
struct FileHeader
{
    uint64_t fileSize;
    char relPath[MAX_PATH_LEN];
};

struct ResumeInfo
{
    uint64_t nextChunkId;
};

struct ChunkHeader
{
    uint64_t chunkId;
    uint32_t chunkSize;
    unsigned char hash[32];
};

struct ChunkAck
{
    uint64_t chunkId;
    uint8_t success;
};

// Sent by the receiver once a file's terminator chunk has been handled and
// the file is flushed and sized correctly on disk.
struct FileDone
{
    uint8_t ok;
};

#pragma pack(pop)
