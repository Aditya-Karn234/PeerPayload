#include <iostream>
#include <fstream>
#include <cstring>
#include <cstdlib>
#include <chrono>
#include <string>
#include <vector>
#include <algorithm>
#include <array>
#include <cctype>
#include <atomic>
#include <mutex>
#include <thread>
#include <filesystem>

#include "platform_socket.hpp"
#include "hashing.hpp"
#include "network_utils.hpp"
#include "transport.hpp"
#include "protocol.hpp"
#include "path_utils.hpp"
#include "json_event.hpp"
#include "transfer_id.hpp"
#include "bounded_queue.hpp"
#include "ack_tracker.hpp"
#include "bench_log.hpp"

namespace fs = std::filesystem;

namespace
{

// Chunks in flight at once. 16 is a reasonable default: at a 64 KiB chunk
// size that's 1 MiB of unacked data outstanding, enough to keep a
// non-trivial-latency link busy without the socket buffers needing to be
// huge. Larger windows help more as RTT grows.
constexpr uint32_t DEFAULT_WINDOW = 16;

// Seconds a single send/recv may block before the peer is treated as gone.
// Per call, not per transfer, so it only has to exceed the time for one
// chunk's ack to come back: 120 s covers an 8 MiB chunk on a ~0.5 Mbit/s
// link. 0 disables it.
constexpr int DEFAULT_IDLE_TIMEOUT_SEC = 120;

struct Options
{
    std::string host = "127.0.0.1";
    int port = DEFAULT_PORT;
    std::string transferId;
    uint32_t chunkSize = DEFAULT_CHUNK_SIZE;
    uint32_t window = DEFAULT_WINDOW;
    std::string benchPath;
    bool noTls = false;
    std::string token;
    int idleTimeoutSec = DEFAULT_IDLE_TIMEOUT_SEC;
    std::string pinSha256;
    std::vector<std::string> inputs;
};

// A file queued for transfer: where to read it, and what to call it on the
// far end.
struct QueuedFile
{
    fs::path localPath;
    std::string relPath;
    uint64_t size = 0;
};

struct SendResult
{
    bool ok = false;
    std::string reason;
};

// stdout carries only the JSON event stream (see json_event.hpp); anything
// meant for a human belongs here.
void printUsage()
{
    std::cerr
        << "Usage: sender [options] <file-or-directory>...\n"
        << "\n"
        << "Options:\n"
        << "  -h, --host <address>     receiver address (default 127.0.0.1)\n"
        << "  -p, --port <port>        receiver port (default " << DEFAULT_PORT << ")\n"
        << "      --transfer-id <id>   tag emitted events with this id (default: generated)\n"
        << "      --chunk-size <bytes> bytes per chunk (default " << DEFAULT_CHUNK_SIZE
        << ", range " << MIN_CHUNK_SIZE << "-" << MAX_CHUNK_SIZE << ")\n"
        << "      --window <n>         chunks in flight at once (default " << DEFAULT_WINDOW << ")\n"
        << "      --bench <path>       write per-chunk stage timings to this CSV\n"
        << "      --no-tls             skip the TLS handshake (debug/benchmark only —\n"
        << "                           the receiver must be started with --no-tls too)\n"
        << "      --token <string>     shared secret to present to the receiver (max "
        << (TOKEN_LEN - 1) << " bytes).\n"
        << "                           Only meaningful if the receiver was started with\n"
        << "                           --token too; a receiver with no token set ignores\n"
        << "                           this and accepts any sender.\n"
        << "      --idle-timeout <sec> give up if the receiver goes silent this long\n"
        << "                           (default " << DEFAULT_IDLE_TIMEOUT_SEC << ", 0 = never)\n"
        << "      --pin-sha256 <hex>   require the receiver's certificate to have this\n"
        << "                           SHA-256 fingerprint (from its \"listening\" event)\n"
        << "      --help               show this message\n"
        << "\n"
        << "Directories are sent recursively; the directory name is kept as\n"
        << "the top level of each path on the receiver.\n"
        << "\n"
        << "The connection is TLS-encrypted by default. The receiver's certificate\n"
        << "is self-signed and generated fresh each run. Without --pin-sha256 this\n"
        << "protects against passive eavesdropping but not an active machine-in-the-\n"
        << "middle; with it, the sender refuses any certificate but the pinned one.\n"
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

bool parseUInt32(const std::string &text, uint32_t &out)
{
    try
    {
        size_t consumed = 0;

        unsigned long value = std::stoul(text, &consumed);

        if (consumed != text.size() || value == 0 || value > 0xFFFFFFFFUL)
            return false;

        out = static_cast<uint32_t>(value);

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

        if (arg == "-h" || arg == "--host")
        {
            if (++i >= argc)
            {
                std::cerr << "Missing value for " << arg << '\n';
                return false;
            }

            options.host = argv[i];

            continue;
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

        if (arg == "--chunk-size")
        {
            if (++i >= argc)
            {
                std::cerr << "Missing value for " << arg << '\n';
                return false;
            }

            if (!parseUInt32(argv[i], options.chunkSize) ||
                options.chunkSize < MIN_CHUNK_SIZE ||
                options.chunkSize > MAX_CHUNK_SIZE)
            {
                std::cerr
                    << "Invalid chunk size: " << argv[i]
                    << " (must be " << MIN_CHUNK_SIZE << "-" << MAX_CHUNK_SIZE << ")\n";
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

            // Must leave room for at least the field's zero-padding to be
            // unambiguous, and strictly fit alongside a null terminator.
            if (options.token.size() >= TOKEN_LEN)
            {
                std::cerr
                    << "Token too long: " << options.token.size()
                    << " bytes (max " << (TOKEN_LEN - 1) << ")\n";
                return false;
            }

            continue;
        }

        if (arg == "--window")
        {
            if (++i >= argc)
            {
                std::cerr << "Missing value for " << arg << '\n';
                return false;
            }

            if (!parseUInt32(argv[i], options.window))
            {
                std::cerr << "Invalid window size: " << argv[i] << '\n';
                return false;
            }

            continue;
        }

        if (arg == "--bench")
        {
            if (++i >= argc)
            {
                std::cerr << "Missing value for " << arg << '\n';
                return false;
            }

            options.benchPath = argv[i];

            continue;
        }

        if (arg == "--no-tls")
        {
            options.noTls = true;

            continue;
        }

        if (arg == "--idle-timeout")
        {
            if (++i >= argc)
            {
                std::cerr << "Missing value for " << arg << '\n';
                return false;
            }

            if (!parseNonNegativeInt(argv[i], options.idleTimeoutSec))
            {
                std::cerr << "Invalid idle timeout: " << argv[i] << '\n';
                return false;
            }

            continue;
        }

        if (arg == "--pin-sha256")
        {
            if (++i >= argc)
            {
                std::cerr << "Missing value for " << arg << '\n';
                return false;
            }

            options.pinSha256 = argv[i];

            if (!isHexSha256(options.pinSha256))
            {
                std::cerr << "Invalid --pin-sha256: expected 64 hex characters\n";
                return false;
            }

            for (char &c : options.pinSha256)
                c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));

            continue;
        }

        if (!arg.empty() && arg[0] == '-' && arg != "-")
        {
            std::cerr << "Unknown option: " << arg << '\n';
            return false;
        }

        options.inputs.push_back(arg);
    }

    if (options.inputs.empty())
    {
        std::cerr << "No input files given.\n\n";
        printUsage();
        return false;
    }

    if (options.noTls && !options.pinSha256.empty())
    {
        std::cerr << "--pin-sha256 requires TLS; it can't be combined with --no-tls\n";
        return false;
    }

    return true;
}

// Expand each CLI argument into concrete files. Directories keep their own
// name as the top-level path component so "sender docs/" lands in
// "<out>/docs/..." rather than scattering loose files into the output root.
bool collectFiles(
    const std::vector<std::string> &inputs,
    std::vector<QueuedFile> &files)
{
    for (const auto &input : inputs)
    {
        fs::path path(input);
        std::error_code ec;

        auto status = fs::status(path, ec);

        if (ec || !fs::exists(status))
        {
            std::cerr << "No such file or directory: " << input << '\n';
            return false;
        }

        if (fs::is_directory(status))
        {
            fs::path base = fs::absolute(path, ec).lexically_normal();

            if (ec)
            {
                std::cerr << "Cannot resolve " << input << '\n';
                return false;
            }

            // Relative to the parent, so the directory name survives.
            fs::path root = base.parent_path();

            for (fs::recursive_directory_iterator it(path, ec), end;
                 it != end;
                 it.increment(ec))
            {
                if (ec)
                {
                    std::cerr
                        << "Error walking " << input
                        << ": " << ec.message() << '\n';
                    return false;
                }

                if (!it->is_regular_file(ec) || ec)
                    continue;

                fs::path absolute = fs::absolute(it->path(), ec).lexically_normal();

                if (ec)
                    continue;

                QueuedFile file;

                file.localPath = it->path();
                file.relPath = toRelPath(absolute, root);
                file.size = static_cast<uint64_t>(fs::file_size(it->path(), ec));

                if (ec)
                {
                    std::cerr
                        << "Cannot size " << it->path().string()
                        << ": " << ec.message() << '\n';
                    return false;
                }

                files.push_back(std::move(file));
            }

            continue;
        }

        if (!fs::is_regular_file(status))
        {
            std::cerr << "Not a regular file: " << input << '\n';
            return false;
        }

        QueuedFile file;

        file.localPath = path;
        file.relPath = path.filename().generic_string();
        file.size = static_cast<uint64_t>(fs::file_size(path, ec));

        if (ec)
        {
            std::cerr
                << "Cannot size " << input
                << ": " << ec.message() << '\n';
            return false;
        }

        files.push_back(std::move(file));
    }

    if (files.empty())
    {
        std::cerr << "Nothing to send (no regular files found).\n";
        return false;
    }

    // The receiver rejects anything that would escape its output directory;
    // catching it here means failing before the transfer starts rather than
    // partway through.
    for (const auto &file : files)
    {
        if (file.relPath.size() >= MAX_PATH_LEN)
        {
            std::cerr
                << "Path too long for the protocol ("
                << file.relPath.size() << " >= " << MAX_PATH_LEN
                << "): " << file.relPath << '\n';
            return false;
        }

        char raw[MAX_PATH_LEN] = {};

        std::memcpy(raw, file.relPath.c_str(), file.relPath.size());

        std::string cleaned;
        std::string error;

        if (!sanitizeRelPath(raw, cleaned, error))
        {
            std::cerr
                << "Refusing to send " << file.localPath.string()
                << ": " << error << '\n';
            return false;
        }
    }

    return true;
}

SOCKET connectToReceiver(const Options &options)
{
    addrinfo hints{};

    hints.ai_family = AF_INET;
    hints.ai_socktype = SOCK_STREAM;
    hints.ai_protocol = IPPROTO_TCP;

    addrinfo *results = nullptr;

    std::string portText = std::to_string(options.port);

    int rc =
        getaddrinfo(
            options.host.c_str(),
            portText.c_str(),
            &hints,
            &results);

    if (rc != 0)
    {
        std::cerr
            << "Cannot resolve " << options.host
            << ": " << socketErrorText(rc) << '\n';
        return INVALID_SOCKET;
    }

    SOCKET sock = INVALID_SOCKET;
    int lastError = 0;

    for (addrinfo *it = results; it != nullptr; it = it->ai_next)
    {
        sock = socket(it->ai_family, it->ai_socktype, it->ai_protocol);

        if (sock == INVALID_SOCKET)
        {
            lastError = lastSocketError();
            continue;
        }

        if (connect(sock, it->ai_addr, static_cast<int>(it->ai_addrlen)) == 0)
            break;

        // Capture before closesocket()/freeaddrinfo(), either of which can
        // succeed and reset the thread-local error code out from under us.
        lastError = lastSocketError();

        closesocket(sock);

        sock = INVALID_SOCKET;
    }

    freeaddrinfo(results);

    if (sock == INVALID_SOCKET)
    {
        std::cerr
            << "Connection to " << options.host << ':' << options.port
            << " failed: " << socketErrorText(lastError) << '\n';
    }

    return sock;
}

const char *sessionRejectionText(uint8_t reason)
{
    switch (reason)
    {
    case SESSION_BAD_MAGIC:
        return "peer did not recognise the protocol";
    case SESSION_BAD_VERSION:
        return "protocol version mismatch";
    case SESSION_BAD_COUNT:
        return "file count rejected";
    case SESSION_LOCAL_ERROR:
        return "receiver hit a local error";
    case SESSION_BAD_CHUNK_SIZE:
        return "chunk size rejected";
    case SESSION_AUTH_FAILED:
        return "token rejected — check --token matches the receiver's";
    default:
        return "unspecified reason";
    }
}

const char *sessionRejectionCode(uint8_t reason)
{
    switch (reason)
    {
    case SESSION_BAD_MAGIC:
        return "session_bad_magic";
    case SESSION_BAD_VERSION:
        return "session_bad_version";
    case SESSION_BAD_COUNT:
        return "session_bad_count";
    case SESSION_LOCAL_ERROR:
        return "session_local_error";
    case SESSION_BAD_CHUNK_SIZE:
        return "session_bad_chunk_size";
    case SESSION_AUTH_FAILED:
        return "session_auth_failed";
    default:
        return "session_rejected";
    }
}

// Reason code for a failed network call: "peer_timeout" when the idle
// timeout expired (the peer went silent), otherwise the caller's specific
// reason. Must run on the thread whose call failed.
const char *ioFailureReason(const char *reason)
{
    return lastIoTimedOut() ? "peer_timeout" : reason;
}

void emitTransferFailed(
    const std::string &transferId,
    const std::string &reason,
    const std::string &relPath = "")
{
    JsonEvent event("transfer_failed");

    event.field("transferId", transferId).field("reason", reason);

    if (!relPath.empty())
        event.field("relPath", relPath);

    event.emit();
}

// ---- Pipeline -------------------------------------------------------------
//
// Four stages, each its own thread, connected by bounded queues:
//   disk reader -> hasher -> network sender -> (socket) -> ack listener
//
// The reader only touches the file; the hasher is pure CPU; only the sender
// thread calls send() and only the ack listener calls recv(), which is what
// makes it safe for them to share one socket concurrently (one writer, one
// reader, on independent directions of a full-duplex connection).
//
// A hash mismatch is treated as fatal for the session rather than retried
// in place: once multiple chunks are in flight, chunks after a bad one may
// already be sent or received by the time its nack arrives, so a clean
// single-chunk retry isn't possible without a reorder buffer on the
// receiver. Aborting and relying on the existing resume protocol is far
// less code and mismatches should be rare — TCP already checksums the byte
// stream, so this mostly catches logic bugs, not routine transit noise.

struct ReadChunk
{
    uint64_t chunkId;
    std::vector<char> data;
};

struct HashedChunk
{
    uint64_t chunkId;
    std::vector<char> data;
    std::array<unsigned char, 32> hash;
};

struct PipelineContext
{
    BoundedQueue<ReadChunk> readQueue;
    BoundedQueue<HashedChunk> sendQueue;
    BoundedQueue<uint32_t> sentSizes;
    AckTracker ackTracker;
    std::atomic<bool> aborted{false};
    std::mutex reasonMutex;
    std::string reason;

    PipelineContext(size_t queueCapacity, uint32_t windowSize)
        : readQueue(queueCapacity)
        , sendQueue(queueCapacity)
        , sentSizes(queueCapacity)
        , ackTracker(windowSize)
    {
    }

    // Safe to call from any thread, any number of times; only the first
    // reason sticks, but every call still unblocks every waiter.
    void abort(const std::string &why)
    {
        bool expected = false;

        if (aborted.compare_exchange_strong(expected, true))
        {
            std::lock_guard<std::mutex> lock(reasonMutex);

            reason = why;
        }

        readQueue.close();
        sendQueue.close();
        sentSizes.close();
        ackTracker.fail();
    }
};

void readerThreadFn(
    std::ifstream &input,
    uint32_t chunkSize,
    uint64_t startChunkId,
    uint64_t chunkCount,
    PipelineContext &ctx,
    BenchLog &bench)
{
    uint64_t chunkId = startChunkId;

    while (chunkId < chunkCount)
    {
        auto readStart = std::chrono::steady_clock::now();

        std::vector<char> buf(chunkSize);

        input.read(buf.data(), chunkSize);

        std::streamsize n = input.gcount();

        auto readEnd = std::chrono::steady_clock::now();

        if (n <= 0)
        {
            ctx.abort("short_read");
            return;
        }

        buf.resize(static_cast<size_t>(n));

        bench.record(chunkId, "read", readStart, readEnd);

        if (!ctx.readQueue.push({chunkId, std::move(buf)}))
            return;

        chunkId++;
    }

    ctx.readQueue.close();
}

void hasherThreadFn(PipelineContext &ctx, BenchLog &bench)
{
    while (true)
    {
        auto item = ctx.readQueue.pop();

        if (!item)
            break;

        auto hashStart = std::chrono::steady_clock::now();

        auto hash = computeSHA256(item->data.data(), item->data.size());

        auto hashEnd = std::chrono::steady_clock::now();

        bench.record(item->chunkId, "hash", hashStart, hashEnd);

        // Test-only fault injection: flip a byte after hashing so the sent
        // data no longer matches its own hash, simulating corruption in
        // transit. Used to verify the disconnect-and-resume path actually
        // works now that in-place retry is gone. No-op unless set.
        static const long corruptChunkId = [] {
            const char *raw = std::getenv("DTS_CORRUPT_CHUNK");
            return raw ? std::atol(raw) : -1;
        }();

        if (corruptChunkId >= 0 && item->chunkId == static_cast<uint64_t>(corruptChunkId) && !item->data.empty())
            item->data[0] ^= 0xFF;

        if (!ctx.sendQueue.push({item->chunkId, std::move(item->data), hash}))
            return;
    }

    ctx.sendQueue.close();
}

void senderThreadFn(const Transport &transport, PipelineContext &ctx, BenchLog &bench)
{
    while (true)
    {
        auto item = ctx.sendQueue.pop();

        if (!item)
            break;

        if (!ctx.ackTracker.acquireSlot())
            return;

        ChunkHeader chunkHeader{};

        chunkHeader.chunkId = item->chunkId;
        chunkHeader.chunkSize = static_cast<uint32_t>(item->data.size());

        std::memcpy(chunkHeader.hash, item->hash.data(), sizeof(chunkHeader.hash));

        auto sendStart = std::chrono::steady_clock::now();

        bool ok =
            transportSendStruct(transport, chunkHeader) &&
            transportSendAll(transport, item->data.data(), static_cast<int>(item->data.size()));

        auto sendEnd = std::chrono::steady_clock::now();

        bench.record(item->chunkId, "send", sendStart, sendEnd);

        if (!ok)
        {
            ctx.abort(ioFailureReason("chunk_send_failed"));
            return;
        }

        // Handed off in the same order chunks are sent, so the ack listener
        // can pop sizes in lockstep with the acks it receives — acks arrive
        // in that same order too, since TCP preserves it end to end.
        if (!ctx.sentSizes.push(chunkHeader.chunkSize))
            return;
    }
}

void ackListenerThreadFn(
    const Transport &transport,
    const std::string &transferId,
    const std::string &relPath,
    uint64_t startChunkId,
    uint64_t chunksThisRun,
    PipelineContext &ctx,
    BenchLog &bench)
{
    uint64_t nextExpectedAck = startChunkId;
    uint64_t received = 0;

    while (received < chunksThisRun)
    {
        ChunkAck ack{};

        auto ackStart = std::chrono::steady_clock::now();

        bool received_ok = transportRecvStruct(transport, ack);

        auto ackEnd = std::chrono::steady_clock::now();

        bench.record(nextExpectedAck, "ack", ackStart, ackEnd);

        if (!received_ok)
        {
            ctx.abort(ioFailureReason("ack_receive_failed"));
            return;
        }

        if (ack.chunkId != nextExpectedAck)
        {
            ctx.abort("ack_mismatch");
            return;
        }

        if (!ack.success)
        {
            ctx.abort("chunk_mismatch");
            return;
        }

        auto sizeOpt = ctx.sentSizes.pop();

        if (!sizeOpt)
        {
            ctx.abort("ack_receive_failed");
            return;
        }

        ctx.ackTracker.onAcked(*sizeOpt);

        received++;
        nextExpectedAck++;

        JsonEvent("chunk_verified")
            .field("transferId", transferId)
            .field("relPath", relPath)
            .field("chunkId", ack.chunkId)
            .field("bytes", *sizeOpt)
            .emit();
    }
}

SendResult sendOneFile(
    const Transport &transport,
    const std::string &transferId,
    size_t fileIndex,
    size_t fileCount,
    const QueuedFile &file,
    uint32_t chunkSize,
    uint32_t window,
    uint64_t &sessionBytesDone,
    BenchLog &bench)
{
    std::ifstream input(file.localPath, std::ios::binary);

    if (!input)
    {
        std::cerr
            << "Cannot open " << file.localPath.string() << '\n';
        return {false, "cannot_open_file"};
    }

    FileHeader fileHeader{};

    fileHeader.fileSize = file.size;

    std::memcpy(
        fileHeader.relPath,
        file.relPath.c_str(),
        file.relPath.size());

    if (!transportSendStruct(transport, fileHeader))
    {
        std::cerr << "FileHeader send failed\n";
        return {false, ioFailureReason("file_header_send_failed")};
    }

    ResumeInfo resume{};

    if (!transportRecvStruct(transport, resume))
    {
        std::cerr << "Resume handshake failed\n";
        return {false, ioFailureReason("resume_handshake_failed")};
    }

    uint64_t chunkCount =
        (file.size + chunkSize - 1) / chunkSize;

    if (resume.nextChunkId > chunkCount)
    {
        std::cerr
            << "Receiver asked to resume at chunk " << resume.nextChunkId
            << " but the file only has " << chunkCount << " chunks\n";
        return {false, "resume_offset_invalid"};
    }

    uint64_t resumedBytes = resume.nextChunkId * static_cast<uint64_t>(chunkSize);

    if (resumedBytes > file.size)
        resumedBytes = file.size;

    JsonEvent("file_start")
        .field("transferId", transferId)
        .field("relPath", file.relPath)
        .field("fileSize", file.size)
        .field("fileIndex", static_cast<uint64_t>(fileIndex))
        .field("fileCount", static_cast<uint64_t>(fileCount))
        .field("resumeChunk", resume.nextChunkId)
        .emit();

    input.seekg(
        static_cast<std::streamoff>(resumedBytes),
        std::ios::beg);

    if (!input)
    {
        std::cerr
            << "Failed to seek to byte " << resumedBytes
            << " in " << file.localPath.string() << '\n';
        return {false, "seek_failed"};
    }

    sessionBytesDone += resumedBytes;

    uint64_t chunksThisRun = chunkCount - resume.nextChunkId;

    if (chunksThisRun > 0)
    {
        size_t queueCapacity = window;

        PipelineContext ctx(queueCapacity, window);

        std::thread readerThread(
            readerThreadFn,
            std::ref(input), chunkSize, resume.nextChunkId, chunkCount,
            std::ref(ctx), std::ref(bench));

        std::thread hasherThread(hasherThreadFn, std::ref(ctx), std::ref(bench));

        std::thread senderThread(senderThreadFn, std::cref(transport), std::ref(ctx), std::ref(bench));

        std::thread ackThread(
            ackListenerThreadFn,
            std::cref(transport), transferId, file.relPath, resume.nextChunkId, chunksThisRun,
            std::ref(ctx), std::ref(bench));

        readerThread.join();
        hasherThread.join();
        senderThread.join();
        ackThread.join();

        if (ctx.aborted.load())
        {
            std::string reason;

            {
                std::lock_guard<std::mutex> lock(ctx.reasonMutex);

                reason = ctx.reason.empty() ? "pipeline_failed" : ctx.reason;
            }

            std::cerr << "Pipeline aborted: " << reason << '\n';

            return {false, reason};
        }

        if (ctx.ackTracker.ackedCount() != chunksThisRun)
        {
            std::cerr
                << "Expected " << chunksThisRun << " acked chunks, got "
                << ctx.ackTracker.ackedCount() << '\n';
            return {false, "short_read"};
        }

        sessionBytesDone += ctx.ackTracker.ackedBytes();
    }

    ChunkHeader terminator{};

    terminator.chunkSize = 0;
    terminator.chunkId = chunkCount;

    if (!transportSendStruct(transport, terminator))
    {
        std::cerr << "End-of-file marker send failed\n";
        return {false, ioFailureReason("eof_marker_send_failed")};
    }

    FileDone done{};

    if (!transportRecvStruct(transport, done))
    {
        std::cerr << "End-of-file confirmation failed\n";
        return {false, ioFailureReason("eof_confirmation_failed")};
    }

    if (!done.ok)
    {
        std::cerr
            << "Receiver reported a failure finalizing "
            << file.relPath << '\n';
        return {false, "receiver_finalize_failed"};
    }

    JsonEvent("file_complete")
        .field("transferId", transferId)
        .field("relPath", file.relPath)
        .field("bytes", file.size)
        .field("fileIndex", static_cast<uint64_t>(fileIndex))
        .field("fileCount", static_cast<uint64_t>(fileCount))
        .emit();

    return {true, ""};
}

} // namespace

int main(int argc, char **argv)
{
    // A peer closing mid-write must be an error, not process death.
    ignoreSigpipe();

    Options options;

    if (!parseArgs(argc, argv, options))
        return 1;

    std::string transferId =
        options.transferId.empty() ? generateTransferId() : options.transferId;

    std::vector<QueuedFile> files;

    if (!collectFiles(options.inputs, files))
    {
        emitTransferFailed(transferId, "invalid_input");
        return 1;
    }

    uint64_t sessionBytesTotal = 0;

    for (const auto &file : files)
        sessionBytesTotal += file.size;

    std::string startupError;

    if (!platformSocketStartup(startupError))
    {
        std::cerr << startupError << '\n';
        emitTransferFailed(transferId, "wsastartup_failed");
        return 1;
    }

    SOCKET sock = connectToReceiver(options);

    if (sock == INVALID_SOCKET)
    {
        emitTransferFailed(transferId, "connection_failed");
        platformSocketCleanup();
        return 1;
    }

    uint64_t windowBytes =
        static_cast<uint64_t>(options.window) * static_cast<uint64_t>(options.chunkSize);

    constexpr uint64_t MAX_SOCKET_BUFFER = 64 * 1024 * 1024;

    tuneSocketForPipelining(
        sock,
        static_cast<int>(std::min(windowBytes, MAX_SOCKET_BUFFER)));

    // Set before the TLS handshake so a receiver that accepts the TCP
    // connection but never answers can't hang the handshake either.
    setSocketTimeouts(sock, options.idleTimeoutSec * 1000);
    enableKeepalive(sock);

    SSL_CTX *tlsCtx = nullptr;
    SSL *tlsConn = nullptr;

    if (!options.noTls)
    {
        std::string tlsError;

        tlsCtx = createClientTlsContext(tlsError);

        if (!tlsCtx)
        {
            std::cerr << "TLS context setup failed: " << tlsError << '\n';
            emitTransferFailed(transferId, "tls_context_failed");
            closesocket(sock);
            platformSocketCleanup();
            return 1;
        }

        tlsConn = performClientHandshake(tlsCtx, sock, tlsError);

        if (!tlsConn)
        {
            std::cerr << "TLS handshake failed: " << tlsError << '\n';
            emitTransferFailed(transferId, "tls_handshake_failed");
            SSL_CTX_free(tlsCtx);
            closesocket(sock);
            platformSocketCleanup();
            return 1;
        }

        if (!options.pinSha256.empty())
        {
            std::string presented = peerCertificateSha256(tlsConn);

            if (presented != options.pinSha256)
            {
                std::cerr
                    << "Receiver certificate does not match --pin-sha256 (got "
                    << (presented.empty() ? "none" : presented) << ")\n";
                emitTransferFailed(transferId, "tls_pin_mismatch");
                closeTlsConnection(tlsConn);
                SSL_CTX_free(tlsCtx);
                closesocket(sock);
                platformSocketCleanup();
                return 1;
            }
        }
    }

    Transport transport{sock, tlsConn};

    SessionHeader session{};

    session.magic = PROTOCOL_MAGIC;
    session.version = PROTOCOL_VERSION;
    session.fileCount = files.size();
    session.totalBytes = sessionBytesTotal;
    session.chunkSize = options.chunkSize;

    // session{} already zero-initialized session.token; only overwrite the
    // prefix, leaving the rest (and the case where no --token was given at
    // all) as zero-padding.
    std::memcpy(session.token, options.token.data(), options.token.size());

    int exitCode = 0;
    BenchLog bench(options.benchPath);

    if (!transportSendStruct(transport, session))
    {
        std::cerr << "SessionHeader send failed\n";
        emitTransferFailed(transferId, ioFailureReason("session_send_failed"));
        exitCode = 1;
    }
    else
    {
        SessionAck ack{};

        if (!transportRecvStruct(transport, ack))
        {
            std::cerr << "No session response from receiver\n";
            emitTransferFailed(transferId, ioFailureReason("no_session_response"));
            exitCode = 1;
        }
        else if (!ack.accepted)
        {
            std::cerr
                << "Receiver rejected the session: "
                << sessionRejectionText(ack.reason) << '\n';
            emitTransferFailed(transferId, sessionRejectionCode(ack.reason));
            exitCode = 1;
        }
        else
        {
            JsonEvent sessionStartEvent("session_start");

            sessionStartEvent
                .field("transferId", transferId)
                .field("host", options.host)
                .field("port", options.port)
                .field("fileCount", static_cast<uint64_t>(files.size()))
                .field("totalBytes", sessionBytesTotal)
                .field("chunkSize", options.chunkSize)
                .field("window", options.window)
                .field("tls", tlsConn != nullptr);

            if (tlsConn)
            {
                sessionStartEvent
                    .field("tlsSummary", tlsConnectionSummary(tlsConn))
                    .field("certSha256", peerCertificateSha256(tlsConn))
                    .field("pinned", !options.pinSha256.empty());
            }

            sessionStartEvent.emit();

            auto startTime = std::chrono::steady_clock::now();

            uint64_t sessionBytesDone = 0;

            for (size_t i = 0; i < files.size(); i++)
            {
                SendResult result =
                    sendOneFile(
                        transport,
                        transferId,
                        i + 1,
                        files.size(),
                        files[i],
                        options.chunkSize,
                        options.window,
                        sessionBytesDone,
                        bench);

                if (!result.ok)
                {
                    emitTransferFailed(transferId, result.reason, files[i].relPath);
                    exitCode = 1;
                    break;
                }
            }

            if (exitCode == 0)
            {
                auto elapsed =
                    std::chrono::duration_cast<std::chrono::milliseconds>(
                        std::chrono::steady_clock::now() - startTime);

                JsonEvent("transfer_complete")
                    .field("transferId", transferId)
                    .field("totalBytes", sessionBytesDone)
                    .field("elapsedMs", static_cast<uint64_t>(elapsed.count()))
                    .emit();
            }
        }
    }

    if (!bench.save())
        std::cerr << "Failed to write bench log to " << options.benchPath << '\n';

    if (tlsConn)
        closeTlsConnection(tlsConn);

    if (tlsCtx)
        SSL_CTX_free(tlsCtx);

    closesocket(sock);

    platformSocketCleanup();

    return exitCode;
}
