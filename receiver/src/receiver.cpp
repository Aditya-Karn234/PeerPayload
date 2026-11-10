#include <iostream>
#include <fstream>
#include <cstring>
#include <cstdlib>
#include <algorithm>
#include <cctype>
#include <chrono>
#include <string>
#include <vector>
#include <filesystem>

#include "platform_socket.hpp"
#include "hashing.hpp"
#include "network_utils.hpp"
#include "transport.hpp"
#include "protocol.hpp"
#include "path_utils.hpp"
#include "transfer_state.hpp"
#include "json_event.hpp"
#include "transfer_id.hpp"
#include "bench_latency.hpp"
#include "engine_entry.hpp"
#include "run_context.hpp"

namespace fs = std::filesystem;

namespace
{

// See sender/src/main.cpp: per-call, so it only has to outlast one chunk.
constexpr int DEFAULT_IDLE_TIMEOUT_SEC = 120;

struct Options
{
    int port = DEFAULT_PORT;
    fs::path outputDir = ".";
    std::string transferId;
    bool noTls = false;
    std::string token;
    int idleTimeoutSec = DEFAULT_IDLE_TIMEOUT_SEC;
    int listenTimeoutSec = 0;
    int maxRetries = 0;
    // This device's lasting identity (ppkeygen) instead of a throwaway
    // per-run certificate, so senders can pin a stable fingerprint.
    std::string certPath;
    std::string keyPath;
    // Mutual TLS: only senders presenting one of these certificate
    // fingerprints get past the handshake. Empty: anyone (as before).
    std::vector<std::string> allowedPeers;
};

bool isHexSha256(const std::string &text)
{
    if (text.size() != 64)
        return false;

    for (char c : text)
    {
        if (!std::isxdigit(static_cast<unsigned char>(c)))
            return false;
    }

    return true;
}

struct FileOutcome
{
    bool ok = false;
    std::string reason;
    std::string relPath;
};

// stdout carries only the JSON event stream (see json_event.hpp); anything
// meant for a human belongs here.
void printUsage()
{
    std::cerr
        << "Usage: receiver [options]\n"
        << "\n"
        << "Options:\n"
        << "  -p, --port <port>        port to listen on (default " << DEFAULT_PORT << ")\n"
        << "  -o, --out <dir>          directory to write into (default .)\n"
        << "      --transfer-id <id>   tag emitted events with this id (default: generated)\n"
        << "      --no-tls             skip the TLS handshake (debug/benchmark only —\n"
        << "                           the sender must be started with --no-tls too)\n"
        << "      --token <string>     require senders to present this shared secret\n"
        << "                           (max " << (TOKEN_LEN - 1) << " bytes). Omit to accept any sender —\n"
        << "                           only safe on a trusted network for a short-lived\n"
        << "                           listen window.\n"
        << "      --idle-timeout <sec> drop a connection whose sender goes silent this\n"
        << "                           long (default " << DEFAULT_IDLE_TIMEOUT_SEC << ", 0 = never)\n"
        << "      --listen-timeout <sec> give up if no sender connects within this long\n"
        << "                           (and again after each retryable failure;\n"
        << "                           default 0 = wait forever)\n"
        << "      --max-retries <n>    after a session fails for a network reason (link\n"
        << "                           dropped, peer timeout, corrupted chunk), keep\n"
        << "                           listening so the sender can reconnect and resume,\n"
        << "                           up to n times (default 0 = exit on first failure)\n"
        << "      --cert <file>        this device's certificate (from ppkeygen) and\n"
        << "      --key <file>         key, instead of a throwaway one per run\n"
        << "      --peer-sha256 <hex>  only accept senders presenting a certificate with\n"
        << "                           this fingerprint (mutual TLS); repeat for each\n"
        << "                           allowed device\n"
        << "      --help               show this message\n"
        << "\n"
        << "Resume state lives in <dir>/transfer.state and is removed once a\n"
        << "session finishes cleanly.\n"
        << "\n"
        << "The connection is TLS-encrypted by default, using a self-signed\n"
        << "certificate generated once per run. Its SHA-256 fingerprint is in the\n"
        << "\"listening\" event; pass it to sender --pin-sha256 to authenticate this\n"
        << "receiver.\n"
        << "\n"
        << "Progress is reported as newline-delimited JSON on stdout, one\n"
        << "object per event; diagnostics for a human go to stderr.\n";
}

bool parsePort(const std::string &text, int &out)
{
    try
    {
        size_t consumed = 0;

        int value = std::stoi(text, &consumed);

        if (consumed != text.size() || value < 1 || value > 65535)
            return false;

        out = value;

        return true;
    }
    catch (const std::exception &)
    {
        return false;
    }
}

bool parseNonNegativeInt(const std::string &text, int &out)
{
    try
    {
        size_t consumed = 0;

        int value = std::stoi(text, &consumed);

        if (consumed != text.size() || value < 0)
            return false;

        out = value;

        return true;
    }
    catch (const std::exception &)
    {
        return false;
    }
}

bool parseArgs(int argc, char **argv, Options &options)
{
    for (int i = 1; i < argc; i++)
    {
        std::string arg = argv[i];

        if (arg == "--help")
        {
            printUsage();
            return false;
        }

        if (arg == "-p" || arg == "--port")
        {
            if (++i >= argc)
            {
                std::cerr << "Missing value for " << arg << '\n';
                return false;
            }

            if (!parsePort(argv[i], options.port))
            {
                std::cerr << "Invalid port: " << argv[i] << '\n';
                return false;
            }

            continue;
        }

        if (arg == "-o" || arg == "--out")
        {
            if (++i >= argc)
            {
                std::cerr << "Missing value for " << arg << '\n';
                return false;
            }

            options.outputDir = argv[i];

            continue;
        }

        if (arg == "--transfer-id" || arg == "--id")
        {
            if (++i >= argc)
            {
                std::cerr << "Missing value for " << arg << '\n';
                return false;
            }

            options.transferId = argv[i];

            continue;
        }

        if (arg == "--no-tls")
        {
            options.noTls = true;

            continue;
        }

        if (arg == "--cert" || arg == "--key")
        {
            if (++i >= argc)
            {
                std::cerr << "Missing value for " << arg << '\n';
                return false;
            }

            (arg == "--cert" ? options.certPath : options.keyPath) = argv[i];

            continue;
        }

        if (arg == "--peer-sha256")
        {
            if (++i >= argc)
            {
                std::cerr << "Missing value for " << arg << '\n';
                return false;
            }

            std::string fingerprint = argv[i];

            if (!isHexSha256(fingerprint))
            {
                std::cerr << "Invalid --peer-sha256: expected 64 hex characters\n";
                return false;
            }

            for (char &c : fingerprint)
                c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));

            options.allowedPeers.push_back(fingerprint);

            continue;
        }

        if (arg == "--idle-timeout" || arg == "--listen-timeout" || arg == "--max-retries")
        {
            if (++i >= argc)
            {
                std::cerr << "Missing value for " << arg << '\n';
                return false;
            }

            int &target =
                arg == "--idle-timeout" ? options.idleTimeoutSec
                : arg == "--listen-timeout" ? options.listenTimeoutSec
                : options.maxRetries;

            if (!parseNonNegativeInt(argv[i], target))
            {
                std::cerr << "Invalid value for " << arg << ": " << argv[i] << '\n';
                return false;
            }

            continue;
        }

        if (arg == "--token")
        {
            if (++i >= argc)
            {
                std::cerr << "Missing value for " << arg << '\n';
                return false;
            }

            options.token = argv[i];

            if (options.token.size() >= TOKEN_LEN)
            {
                std::cerr
                    << "Token too long: " << options.token.size()
                    << " bytes (max " << (TOKEN_LEN - 1) << ")\n";
                return false;
            }

            continue;
        }

        std::cerr << "Unexpected argument: " << arg << '\n';

        return false;
    }

    if (options.certPath.empty() != options.keyPath.empty())
    {
        std::cerr << "--cert and --key go together\n";
        return false;
    }

    if (options.noTls && (!options.certPath.empty() || !options.allowedPeers.empty()))
    {
        std::cerr << "--cert/--key/--peer-sha256 require TLS; they can't be combined with --no-tls\n";
        return false;
    }

    return true;
}

// See sender/src/main.cpp: "peer_timeout" when the idle timeout expired.
const char *ioFailureReason(const char *reason)
{
    return lastIoTimedOut() ? "peer_timeout" : reason;
}

// A run cancelled through the library API fails with "cancelled" whatever
// error the interrupted call happened to produce.
void emitTransferFailed(
    const std::string &transferId,
    const std::string &reason,
    const std::string &relPath = "")
{
    JsonEvent event("transfer_failed");

    event.field("transferId", transferId).field("reason", cancelRequested() ? std::string("cancelled") : reason);

    if (!relPath.empty())
        event.field("relPath", relPath);

    event.emit();
}

// Deliberately not transfer_failed: a rejected handshake (bad magic/version,
// wrong token, implausible count/chunk size) means one connection attempt
// was refused, not that the transfer is over — the receiver keeps listening
// for the real sender afterward. A dashboard treating this as terminal would
// mark the whole transfer failed the moment a port scanner poked it once.
void emitConnectionRejected(const std::string &transferId, const std::string &reason)
{
    JsonEvent("connection_rejected")
        .field("transferId", transferId)
        .field("reason", reason)
        .emit();
}

// Dual-stack listener: one IPv6 socket with IPV6_V6ONLY off accepts both
// IPv6 and IPv4 (as IPv4-mapped addresses) on the same port. Mobile
// networks are often IPv6-only, so this is what lets a phone reach the
// receiver at all. Returns INVALID_SOCKET (without reporting) when IPv6
// isn't available here, so the caller falls back to plain IPv4.
SOCKET openDualStackListener(int port)
{
    SOCKET listener = socket(AF_INET6, SOCK_STREAM, 0);

    if (listener == INVALID_SOCKET)
        return INVALID_SOCKET;

    int off = 0;
    int reuse = 1;

    setsockopt(listener, IPPROTO_IPV6, IPV6_V6ONLY, reinterpret_cast<const char *>(&off), sizeof(off));
    setsockopt(listener, SOL_SOCKET, SO_REUSEADDR, reinterpret_cast<const char *>(&reuse), sizeof(reuse));

    sockaddr_in6 address{};

    address.sin6_family = AF_INET6;
    address.sin6_port = htons(static_cast<u_short>(port));
    address.sin6_addr = in6addr_any;

    if (bind(listener, reinterpret_cast<sockaddr *>(&address), sizeof(address)) == SOCKET_ERROR ||
        listen(listener, SOMAXCONN) == SOCKET_ERROR)
    {
        closesocket(listener);
        return INVALID_SOCKET;
    }

    return listener;
}

// "1.2.3.4" for IPv4 and IPv4-mapped peers (so events look the same as
// before for IPv4 senders), the IPv6 address otherwise.
std::string peerAddressText(const sockaddr_storage &peer)
{
    char text[INET6_ADDRSTRLEN] = {};

    if (peer.ss_family == AF_INET6)
    {
        const auto *v6 = reinterpret_cast<const sockaddr_in6 *>(&peer);

        if (IN6_IS_ADDR_V4MAPPED(&v6->sin6_addr))
        {
            in_addr v4{};

            std::memcpy(&v4, &v6->sin6_addr.s6_addr[12], sizeof(v4));
            inet_ntop(AF_INET, &v4, text, sizeof(text));
        }
        else
        {
            inet_ntop(AF_INET6, &v6->sin6_addr, text, sizeof(text));
        }
    }
    else
    {
        inet_ntop(AF_INET, &reinterpret_cast<const sockaddr_in *>(&peer)->sin_addr, text, sizeof(text));
    }

    return text;
}

SOCKET openListener(const std::string &transferId, int port, bool &dualStack)
{
    dualStack = false;

    SOCKET dual = openDualStackListener(port);

    if (dual != INVALID_SOCKET)
    {
        dualStack = true;
        return dual;
    }

    SOCKET listener = socket(AF_INET, SOCK_STREAM, 0);

    if (listener == INVALID_SOCKET)
    {
        std::cerr << "Socket creation failed: " << socketErrorText() << '\n';
        emitTransferFailed(transferId, "socket_creation_failed");
        return INVALID_SOCKET;
    }

    // Without this, restarting the receiver while the previous socket sits in
    // TIME_WAIT fails to bind.
    int reuse = 1;

    setsockopt(
        listener,
        SOL_SOCKET,
        SO_REUSEADDR,
        reinterpret_cast<const char *>(&reuse),
        sizeof(reuse));

    sockaddr_in address{};

    address.sin_family = AF_INET;
    address.sin_port = htons(static_cast<u_short>(port));
    address.sin_addr.s_addr = INADDR_ANY;

    if (bind(
            listener,
            reinterpret_cast<sockaddr *>(&address),
            sizeof(address)) == SOCKET_ERROR)
    {
        std::cerr
            << "Bind to port " << port
            << " failed: " << socketErrorText() << '\n';
        emitTransferFailed(transferId, "bind_failed");
        closesocket(listener);
        return INVALID_SOCKET;
    }

    if (listen(listener, SOMAXCONN) == SOCKET_ERROR)
    {
        std::cerr << "Listen failed: " << socketErrorText() << '\n';
        emitTransferFailed(transferId, "listen_failed");
        closesocket(listener);
        return INVALID_SOCKET;
    }

    return listener;
}

// Open the destination for read/write without truncating, creating it (and
// any parent directories) if needed. Read/write matters because resume seeks
// into an existing partial file.
bool openForWrite(
    const fs::path &path,
    std::fstream &out,
    std::string &error)
{
    std::error_code ec;

    if (path.has_parent_path())
    {
        fs::create_directories(path.parent_path(), ec);

        if (ec)
        {
            error = "cannot create " + path.parent_path().string() +
                    ": " + ec.message();
            return false;
        }
    }

    out.open(
        path,
        std::ios::binary | std::ios::in | std::ios::out);

    if (!out)
    {
        std::ofstream create(path, std::ios::binary | std::ios::app);

        if (!create)
        {
            error = "cannot create " + path.string();
            return false;
        }

        create.close();

        out.clear();

        out.open(
            path,
            std::ios::binary | std::ios::in | std::ios::out);

        if (!out)
        {
            error = "cannot open " + path.string();
            return false;
        }
    }

    return true;
}

FileOutcome receiveOneFile(
    const Transport &transport,
    const std::string &transferId,
    size_t fileIndex,
    size_t fileCount,
    uint32_t chunkSize,
    const Options &options,
    TransferState &state)
{
    FileHeader header{};

    if (!transportRecvStruct(transport, header))
    {
        std::cerr << "FileHeader receive failed\n";
        return {false, ioFailureReason("file_header_receive_failed"), ""};
    }

    std::string relPath;
    std::string pathError;

    if (!sanitizeRelPath(header.relPath, relPath, pathError))
    {
        std::cerr << "Rejected file: " << pathError << '\n';
        return {false, "invalid_path", ""};
    }

    fs::path destination = options.outputDir / fs::path(relPath);

    uint64_t chunkCount =
        (header.fileSize + chunkSize - 1) / chunkSize;

    uint64_t nextChunkId = state.nextChunkFor(relPath, header.fileSize, chunkSize);

    std::error_code ec;

    // Resume is only valid if the partial file is still on disk and at least
    // as long as the offset we claim to have. Otherwise start over.
    if (nextChunkId > 0)
    {
        uint64_t existing =
            static_cast<uint64_t>(fs::file_size(destination, ec));

        if (ec || existing < nextChunkId * static_cast<uint64_t>(chunkSize))
        {
            nextChunkId = 0;
            state.forget(relPath);
        }
        else
        {
            // The persisted checkpoint is only a hint and can fall behind
            // the file's true durable contents — e.g. a session killed
            // (crash, container restart) before its last few state.save()
            // calls landed. The file itself, written via seekp+flush per
            // chunk, is the actual source of truth once we already know (via
            // the fileSize/chunkSize match above) it belongs to this
            // transfer: never resume from less than what's already
            // physically on disk.
            uint64_t chunksOnDisk = existing / static_cast<uint64_t>(chunkSize);

            if (chunksOnDisk > chunkCount)
                chunksOnDisk = chunkCount;

            if (chunksOnDisk > nextChunkId)
                nextChunkId = chunksOnDisk;

            // Heal the on-disk checkpoint immediately rather than waiting
            // for the next chunk write, since a fully-resumed file may not
            // write any further chunks this session.
            state.record(relPath, header.fileSize, chunkSize, nextChunkId);
            state.save();
        }
    }

    ResumeInfo resume{};

    resume.nextChunkId = nextChunkId;

    if (!transportSendStruct(transport, resume))
    {
        std::cerr << "Resume handshake failed\n";
        return {false, ioFailureReason("resume_handshake_failed"), relPath};
    }

    std::fstream out;
    std::string openError;

    if (!openForWrite(destination, out, openError))
    {
        std::cerr << openError << '\n';
        return {false, "open_destination_failed", relPath};
    }

    JsonEvent("file_start")
        .field("transferId", transferId)
        .field("relPath", relPath)
        .field("fileSize", header.fileSize)
        .field("fileIndex", static_cast<uint64_t>(fileIndex))
        .field("fileCount", static_cast<uint64_t>(fileCount))
        .field("resumeChunk", nextChunkId)
        .emit();

    uint64_t expectedChunkId = nextChunkId;

    std::vector<char> buffer(chunkSize);

    while (true)
    {
        ChunkHeader chunk{};

        if (!transportRecvStruct(transport, chunk))
        {
            std::cerr << "Chunk header receive failed\n";
            return {false, ioFailureReason("chunk_header_receive_failed"), relPath};
        }

        if (chunk.chunkSize == 0)
            break;

        // Stage 8 read chunkSize bytes into a fixed 64 KiB stack buffer with
        // no check, so a corrupt or hostile header past the negotiated size
        // smashed the stack. Bound it before it reaches recv.
        if (chunk.chunkSize > chunkSize)
        {
            std::cerr
                << "Chunk " << chunk.chunkId
                << " declares " << chunk.chunkSize
                << " bytes, over the " << chunkSize << " limit\n";
            return {false, "chunk_size_over_limit", relPath};
        }

        if (chunk.chunkId != expectedChunkId)
        {
            std::cerr
                << "Chunk order error. Expected " << expectedChunkId
                << " got " << chunk.chunkId << '\n';
            return {false, "chunk_order_error", relPath};
        }

        if (!transportRecvAll(
                transport,
                buffer.data(),
                static_cast<int>(chunk.chunkSize)))
        {
            std::cerr << "Chunk receive failed\n";
            return {false, ioFailureReason("chunk_receive_failed"), relPath};
        }

        auto calculated =
            computeSHA256(
                buffer.data(),
                static_cast<size_t>(chunk.chunkSize));

        ChunkAck ack{};

        ack.chunkId = chunk.chunkId;

        if (std::memcmp(
                calculated.data(),
                chunk.hash,
                sizeof(chunk.hash)) != 0)
        {
            ack.success = 0;

            simulateAckLatency();

            transportSendStruct(transport, ack);

            std::cerr
                << "Hash mismatch on chunk " << chunk.chunkId
                << ", aborting session\n";

            JsonEvent("chunk_mismatch")
                .field("transferId", transferId)
                .field("relPath", relPath)
                .field("chunkId", chunk.chunkId)
                .emit();

            // With chunks pipelined, chunks after this one may already be
            // sent or received by the time the sender sees this nack, so an
            // in-place single-chunk retry isn't safe anymore — abort and let
            // the resume protocol pick up from the last durable chunk.
            return {false, "chunk_mismatch", relPath};
        }

        // Write and flush before acknowledging: an ACK the sender acts on is
        // a promise the bytes are durable enough to resume past.
        out.seekp(
            static_cast<std::streamoff>(chunk.chunkId * static_cast<uint64_t>(chunkSize)));

        out.write(buffer.data(), static_cast<std::streamsize>(chunk.chunkSize));

        out.flush();

        if (!out)
        {
            std::cerr
                << "Write failed at chunk " << chunk.chunkId << '\n';
            return {false, "chunk_write_failed", relPath};
        }

        expectedChunkId++;

        state.record(relPath, header.fileSize, chunkSize, expectedChunkId);
        state.save();

        ack.success = 1;

        simulateAckLatency();

        if (!transportSendStruct(transport, ack))
        {
            std::cerr << "ACK send failed\n";
            return {false, ioFailureReason("ack_send_failed"), relPath};
        }

        JsonEvent("chunk_verified")
            .field("transferId", transferId)
            .field("relPath", relPath)
            .field("chunkId", chunk.chunkId)
            .field("bytes", chunk.chunkSize)
            .emit();
    }

    if (expectedChunkId != chunkCount)
    {
        std::cerr
            << "Sender ended after chunk " << expectedChunkId
            << " but the file needs " << chunkCount << '\n';
        return {false, "chunk_count_mismatch", relPath};
    }

    out.flush();
    out.close();

    // A leftover longer file at the same path would keep its tail, since
    // writes are positional and never truncate.
    fs::resize_file(destination, header.fileSize, ec);

    if (ec)
    {
        std::cerr
            << "Cannot size " << destination.string()
            << ": " << ec.message() << '\n';

        FileDone failure{};

        failure.ok = 0;

        transportSendStruct(transport, failure);

        return {false, "resize_failed", relPath};
    }

    state.forget(relPath);
    state.save();

    FileDone done{};

    done.ok = 1;

    if (!transportSendStruct(transport, done))
    {
        std::cerr << "Completion notice send failed\n";
        return {false, ioFailureReason("completion_notice_send_failed"), relPath};
    }

    JsonEvent("file_complete")
        .field("transferId", transferId)
        .field("relPath", relPath)
        .field("bytes", header.fileSize)
        .field("fileIndex", static_cast<uint64_t>(fileIndex))
        .field("fileCount", static_cast<uint64_t>(fileCount))
        .emit();

    return {true, "", relPath};
}

// Constant-time over the full fixed-size field so a mismatching token takes
// the same time to reject regardless of where the first differing byte is —
// cheap to do, no reason not to, even though the bigger gap here is that
// this is a shared secret over the wire rather than a real credential
// exchange.
bool tokenMatches(const char (&received)[TOKEN_LEN], const std::string &expected)
{
    char expectedBuf[TOKEN_LEN] = {};

    std::memcpy(expectedBuf, expected.data(), expected.size());

    unsigned char diff = 0;

    for (uint32_t i = 0; i < TOKEN_LEN; i++)
        diff |= static_cast<unsigned char>(received[i]) ^ static_cast<unsigned char>(expectedBuf[i]);

    return diff == 0;
}

// retryable: true means this rejection is about the peer, not about us —
// bad magic/version/token/count/chunk-size are exactly what an exposed port
// gets from scanners, health-checks, or a sender with the wrong details, and
// none of that means the transfer this receiver was started for is over.
// false means a local problem (e.g. can't create the output directory) that
// will keep failing every future connection too; the caller reports it as
// the transfer's final failure instead of silently absorbing every attempt.
void rejectSession(
    const Transport &transport,
    const std::string &transferId,
    uint8_t reason,
    const char *reasonCode,
    const char *message,
    bool retryable)
{
    std::cerr << message << '\n';

    if (retryable)
        emitConnectionRejected(transferId, reasonCode);

    SessionAck ack{};

    ack.accepted = 0;
    ack.reason = reason;

    transportSendStruct(transport, ack);
}

enum class SessionResult
{
    // Refused before committing (scanner, wrong token, bad header): not
    // about this transfer, keep listening.
    Rejected,
    Completed,
    // Committed session (or a local setup step) failed; see retryable.
    Failed,
};

struct SessionOutcome
{
    SessionResult result = SessionResult::Rejected;
    // Failed only: true when the cause is the connection or the peer
    // (dropped link, timeout, corrupted chunk) so a reconnecting sender can
    // resume; false when it's local or a protocol violation that a retry
    // would just repeat (disk, bad path, out-of-order chunks).
    bool retryable = false;
    std::string reason;
    std::string relPath;
};

bool isRetryableReason(const std::string &reason)
{
    static const char *retryable[] = {
        "peer_timeout",
        "file_header_receive_failed",
        "resume_handshake_failed",
        "chunk_header_receive_failed",
        "chunk_receive_failed",
        "chunk_mismatch",
        "ack_send_failed",
        "completion_notice_send_failed",
        "session_ack_send_failed",
    };

    for (const char *r : retryable)
    {
        if (reason == r)
            return true;
    }

    return false;
}

SessionOutcome runSession(
    const Transport &transport,
    const std::string &transferId,
    const Options &options)
{
    SessionOutcome outcome;

    SessionHeader session{};

    if (!transportRecvStruct(transport, session))
    {
        // Not necessarily a real sender — a bare TCP connect-then-drop (scan,
        // health-check) looks identical from here. Nothing to ack; the peer
        // is already gone.
        std::cerr << "SessionHeader receive failed\n";
        emitConnectionRejected(transferId, ioFailureReason("session_header_receive_failed"));
        return outcome;
    }

    if (session.magic != PROTOCOL_MAGIC)
    {
        rejectSession(
            transport,
            transferId,
            SESSION_BAD_MAGIC,
            "session_bad_magic",
            "Peer is not speaking this protocol",
            true);
        return outcome;
    }

    if (session.version != PROTOCOL_VERSION)
    {
        std::cerr
            << "Peer speaks protocol version " << session.version
            << ", this build speaks " << PROTOCOL_VERSION << '\n';

        rejectSession(
            transport,
            transferId,
            SESSION_BAD_VERSION,
            "session_bad_version",
            "Refusing mismatched protocol version",
            true);
        return outcome;
    }

    // Checked before anything else about the request's content — an
    // unauthenticated peer shouldn't learn whether its fileCount/chunkSize
    // would otherwise have been accepted. No-op if this receiver wasn't
    // started with --token, matching every other opt-in flag here.
    if (!options.token.empty() && !tokenMatches(session.token, options.token))
    {
        rejectSession(
            transport,
            transferId,
            SESSION_AUTH_FAILED,
            "session_auth_failed",
            "Rejected sender: token did not match",
            true);
        return outcome;
    }

    if (session.fileCount == 0 || session.fileCount > MAX_FILE_COUNT)
    {
        rejectSession(
            transport,
            transferId,
            SESSION_BAD_COUNT,
            "session_bad_count",
            "Implausible file count in session header",
            true);
        return outcome;
    }

    if (session.chunkSize < MIN_CHUNK_SIZE || session.chunkSize > MAX_CHUNK_SIZE)
    {
        rejectSession(
            transport,
            transferId,
            SESSION_BAD_CHUNK_SIZE,
            "session_bad_chunk_size",
            "Implausible chunk size in session header",
            true);
        return outcome;
    }

    // The sender doesn't tell us its window size, so this can't match its
    // socket buffer exactly — it only needs to be generously sized so the
    // OS buffer isn't the bottleneck on this side either.
    constexpr uint64_t MAX_SOCKET_BUFFER = 64 * 1024 * 1024;
    uint64_t windowBytes = static_cast<uint64_t>(session.chunkSize) * 32;

    tuneSocketForPipelining(
        transport.sock,
        static_cast<int>(std::min(windowBytes, MAX_SOCKET_BUFFER)));

    std::error_code ec;

    fs::create_directories(options.outputDir, ec);

    if (ec && !fs::is_directory(options.outputDir))
    {
        // Not retryable: a permissions/disk problem here will fail every
        // future connection identically, so looping just hides a real
        // operator-facing problem behind silent rejections.
        rejectSession(
            transport,
            transferId,
            SESSION_LOCAL_ERROR,
            "session_local_error",
            "Cannot create the output directory",
            false);

        outcome.result = SessionResult::Failed;
        outcome.reason = "session_local_error";
        return outcome;
    }

    // Every handshake check passed — this session is happening. Anything
    // that goes wrong from here is a real failure to report, not noise to
    // shrug off and keep listening past.
    outcome.result = SessionResult::Failed;

    SessionAck ack{};

    ack.accepted = 1;
    ack.reason = SESSION_OK;

    if (!transportSendStruct(transport, ack))
    {
        std::cerr << "Session acknowledgement failed\n";
        outcome.reason = ioFailureReason("session_ack_send_failed");
        outcome.retryable = true;
        return outcome;
    }

    TransferState state(options.outputDir / "transfer.state");

    state.load();

    JsonEvent sessionStartEvent("session_start");

    sessionStartEvent
        .field("transferId", transferId)
        .field("fileCount", session.fileCount)
        .field("totalBytes", session.totalBytes)
        .field("chunkSize", session.chunkSize)
        .field("outputDir", fs::absolute(options.outputDir).lexically_normal().string())
        .field("tls", transport.ssl != nullptr);

    if (transport.ssl)
    {
        sessionStartEvent.field("tlsSummary", tlsConnectionSummary(transport.ssl));

        // Which device is sending, when it presented a certificate (mutual
        // TLS): lets the app attribute the transfer to a contact.
        std::string peer = peerCertificateSha256(transport.ssl);

        if (!peer.empty())
            sessionStartEvent.field("peerCertSha256", peer);
    }

    sessionStartEvent.emit();

    auto startTime = std::chrono::steady_clock::now();

    for (uint64_t i = 0; i < session.fileCount; i++)
    {
        FileOutcome file =
            receiveOneFile(
                transport,
                transferId,
                static_cast<size_t>(i + 1),
                static_cast<size_t>(session.fileCount),
                session.chunkSize,
                options,
                state);

        if (!file.ok)
        {
            state.save();

            outcome.reason = file.reason;
            outcome.relPath = file.relPath;
            outcome.retryable = isRetryableReason(file.reason);
            return outcome;
        }
    }

    // Everything landed, so there is nothing left to resume.
    state.discard();

    auto elapsed =
        std::chrono::duration_cast<std::chrono::milliseconds>(
            std::chrono::steady_clock::now() - startTime);

    JsonEvent("transfer_complete")
        .field("transferId", transferId)
        .field("totalBytes", session.totalBytes)
        .field("elapsedMs", static_cast<uint64_t>(elapsed.count()))
        .emit();

    outcome.result = SessionResult::Completed;
    return outcome;
}

} // namespace

// The receiver's entire program, callable in-process (engine/, the library)
// as well as from receiver's own main(). Same flags, events and exit codes.
int runReceiverMain(int argc, char **argv)
{
    // A peer closing mid-write must be an error, not process death.
    ignoreSigpipe();

    Options options;

    if (!parseArgs(argc, argv, options))
        return 1;

    std::string transferId =
        options.transferId.empty() ? generateTransferId() : options.transferId;

    std::string startupError;

    if (!platformSocketStartup(startupError))
    {
        std::cerr << startupError << '\n';
        emitTransferFailed(transferId, "wsastartup_failed");
        return 1;
    }

    // One certificate for the whole process, made before listening: its
    // fingerprint has to be known up front so it can be published in the
    // "listening" event (and pinned by the sender), and a port scanner no
    // longer costs an RSA key generation per connection.
    SSL_CTX *tlsCtx = nullptr;
    std::string certSha256;

    if (!options.noTls)
    {
        std::string tlsError;

        tlsCtx = createServerTlsContext(tlsError, options.certPath, options.keyPath);

        if (!tlsCtx)
        {
            std::cerr << "TLS context setup failed: " << tlsError << '\n';
            emitTransferFailed(transferId, "tls_context_failed");
            platformSocketCleanup();
            return 1;
        }

        certSha256 = serverCertificateSha256(tlsCtx);

        // Mutual TLS: a sender without a certificate fails the handshake;
        // one with a certificate is checked against the allow-list below.
        if (!options.allowedPeers.empty())
            requirePeerCertificate(tlsCtx);
    }

    auto cleanup = [&](SOCKET listener) {
        if (listener != INVALID_SOCKET)
            closesocket(listener);

        if (tlsCtx)
            SSL_CTX_free(tlsCtx);

        platformSocketCleanup();
    };

    bool dualStack = false;
    SOCKET listener = openListener(transferId, options.port, dualStack);

    if (listener == INVALID_SOCKET)
    {
        cleanup(INVALID_SOCKET);
        return 1;
    }

    JsonEvent listeningEvent("listening");

    listeningEvent
        .field("transferId", transferId)
        .field("port", options.port)
        .field("ipv6", dualStack);

    if (tlsCtx)
        listeningEvent.field("certSha256", certSha256);

    listeningEvent.emit();

    using Clock = std::chrono::steady_clock;

    auto armDeadline = [&]() {
        return Clock::now() + std::chrono::seconds(options.listenTimeoutSec);
    };

    auto deadline = armDeadline();
    int failedSessions = 0;

    // Keeps accepting connections until one completes, a failure is final,
    // or the listen deadline passes. An exposed port gets scanned, health-
    // checked, and occasionally hit by a sender with the wrong token — none
    // of that should require the operator to notice and manually restart
    // the receiver before the real sender's connection can land.
    for (;;)
    {
        // Wait for a connection in short slices, so both the listen deadline
        // and a library caller's cancel are noticed promptly.
        for (;;)
        {
            if (cancelRequested())
            {
                emitTransferFailed(transferId, "cancelled");
                cleanup(listener);
                return 1;
            }

            int sliceMs = 250;

            if (options.listenTimeoutSec > 0)
            {
                auto remaining =
                    std::chrono::duration_cast<std::chrono::milliseconds>(deadline - Clock::now()).count();

                if (remaining <= 0)
                {
                    std::cerr
                        << "No sender connected within " << options.listenTimeoutSec << " s\n";
                    emitTransferFailed(transferId, "listen_timeout");
                    cleanup(listener);
                    return 1;
                }

                sliceMs = static_cast<int>(std::min<long long>(remaining, sliceMs));
            }

            if (waitReadable(listener, sliceMs))
                break;
        }

        sockaddr_storage peer{};

        platform_socklen_t peerLength = sizeof(peer);

        SOCKET client =
            accept(
                listener,
                reinterpret_cast<sockaddr *>(&peer),
                &peerLength);

        if (client == INVALID_SOCKET)
        {
            // The listening socket itself is broken, not something about
            // whoever just tried to connect — retrying accept() on it
            // wouldn't help.
            std::cerr << "Accept failed: " << socketErrorText() << '\n';
            emitTransferFailed(transferId, "accept_failed");
            cleanup(listener);
            return 1;
        }

        std::string peerText = peerAddressText(peer);

        JsonEvent("connection_accepted")
            .field("transferId", transferId)
            .field("peer", std::string(peerText))
            .emit();

        // Before the handshake, so a peer that connects and then says
        // nothing (slowloris, half-open scan) can't pin the receiver.
        setSocketTimeouts(client, options.idleTimeoutSec * 1000);
        enableKeepalive(client);

        // Lets a library caller's cancel interrupt this connection.
        RunSocketGuard clientGuard(client);

        SSL *tlsConn = nullptr;

        if (tlsCtx)
        {
            std::string tlsError;

            tlsConn = performServerHandshake(tlsCtx, client, tlsError);

            if (!tlsConn)
            {
                // Peer-dependent (garbage bytes, a non-TLS client, a
                // connection dropped mid-handshake) — exactly the kind of
                // noise an exposed port gets, not a reason to give up
                // listening for the real sender.
                std::cerr << "TLS handshake failed: " << tlsError << '\n';
                emitConnectionRejected(transferId, "tls_handshake_failed");
                clientGuard.release();
                closesocket(client);
                continue;
            }

            if (!options.allowedPeers.empty())
            {
                std::string presented = peerCertificateSha256(tlsConn);

                if (std::find(options.allowedPeers.begin(), options.allowedPeers.end(), presented) == options.allowedPeers.end())
                {
                    // A device we haven't paired with. Peer-caused, so keep
                    // listening for an allowed one.
                    std::cerr << "Rejected sender: certificate " << presented << " is not an allowed peer\n";
                    emitConnectionRejected(transferId, "tls_peer_not_allowed");
                    closeTlsConnection(tlsConn);
                    clientGuard.release();
                    closesocket(client);
                    continue;
                }
            }
        }

        SessionOutcome outcome;

        {
            Transport transport{client, tlsConn};

            outcome = runSession(transport, transferId, options);
        }

        if (tlsConn)
            closeTlsConnection(tlsConn);

        clientGuard.release();
        closesocket(client);

        if (outcome.result == SessionResult::Rejected)
            continue;

        if (outcome.result == SessionResult::Completed)
        {
            cleanup(listener);
            return 0;
        }

        if (outcome.retryable && failedSessions < options.maxRetries)
        {
            failedSessions++;

            std::cerr
                << "Session failed (" << outcome.reason << "); waiting for the sender to reconnect ("
                << (options.maxRetries - failedSessions) << " retries left after this one)\n";

            // Not transfer_failed: the transfer isn't over, the resume state
            // is saved, and the same sender can reconnect and continue.
            JsonEvent event("session_failed");

            event
                .field("transferId", transferId)
                .field("reason", outcome.reason)
                .field("attempt", failedSessions)
                .field("retriesLeft", options.maxRetries - failedSessions);

            if (!outcome.relPath.empty())
                event.field("relPath", outcome.relPath);

            event.emit();

            deadline = armDeadline();
            continue;
        }

        emitTransferFailed(transferId, outcome.reason, outcome.relPath);
        cleanup(listener);
        return 1;
    }
}
