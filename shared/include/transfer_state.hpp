#pragma once

#include <cstdint>
#include <fstream>
#include <map>
#include <sstream>
#include <string>
#include <filesystem>

#include "protocol.hpp"

// Resume bookkeeping for a whole session.
//
// Stage 8 stored a bare chunk number, which meant resuming with a different
// file happily wrote new chunks into an old file's tail. Entries are keyed by
// relative path and only reused when the sender reports the same file size,
// so a changed file restarts from zero instead of producing a hybrid.
class TransferState
{
public:
    explicit TransferState(std::filesystem::path path)
        : path_(std::move(path))
    {
    }

    void load()
    {
        entries_.clear();

        std::ifstream in(path_);

        if (!in)
            return;

        std::string header;

        if (!std::getline(in, header))
            return;

        std::istringstream headerStream(header);

        std::string tag;
        uint32_t version = 0;

        headerStream >> tag >> version;

        // An unrecognised or older state file is discarded rather than
        // guessed at; a wrong resume offset corrupts data silently.
        if (tag != "DTS-STATE" || version != PROTOCOL_VERSION)
            return;

        std::string line;

        while (std::getline(in, line))
        {
            if (line.empty())
                continue;

            std::istringstream lineStream(line);

            uint64_t fileSize = 0;
            uint32_t chunkSize = 0;
            uint64_t nextChunkId = 0;

            if (!(lineStream >> fileSize >> chunkSize >> nextChunkId))
                continue;

            std::string relPath;

            std::getline(lineStream, relPath);

            if (!relPath.empty() && relPath.front() == ' ')
                relPath.erase(0, 1);

            if (relPath.empty())
                continue;

            entries_[relPath] = {fileSize, chunkSize, nextChunkId};
        }
    }

    // Returns the chunk to resume from, or 0 when there is no usable entry.
    // A chunk-size mismatch invalidates resume the same way a file-size
    // mismatch does: --chunk-size can differ between runs, and reusing an
    // offset computed under a different chunk size would seek to the wrong
    // byte.
    uint64_t nextChunkFor(
        const std::string &relPath,
        uint64_t fileSize,
        uint32_t chunkSize) const
    {
        auto it = entries_.find(relPath);

        if (it == entries_.end())
            return 0;

        if (it->second.fileSize != fileSize || it->second.chunkSize != chunkSize)
            return 0;

        // A stored offset past the end of the file means the state and the
        // file on disk disagree. Restart rather than seek into nowhere.
        uint64_t chunkCount =
            (fileSize + chunkSize - 1) / chunkSize;

        if (it->second.nextChunkId > chunkCount)
            return 0;

        return it->second.nextChunkId;
    }

    void record(
        const std::string &relPath,
        uint64_t fileSize,
        uint32_t chunkSize,
        uint64_t nextChunkId)
    {
        entries_[relPath] = {fileSize, chunkSize, nextChunkId};
    }

    void forget(const std::string &relPath)
    {
        entries_.erase(relPath);
    }

    bool empty() const
    {
        return entries_.empty();
    }

    // Written to a temp file and renamed so a crash mid-write leaves the
    // previous state intact instead of a truncated one.
    bool save() const
    {
        std::filesystem::path tmp = path_;

        tmp += ".tmp";

        {
            std::ofstream out(tmp, std::ios::trunc);

            if (!out)
                return false;

            out << "DTS-STATE " << PROTOCOL_VERSION << '\n';

            for (const auto &entry : entries_)
            {
                out << entry.second.fileSize
                    << ' '
                    << entry.second.chunkSize
                    << ' '
                    << entry.second.nextChunkId
                    << ' '
                    << entry.first
                    << '\n';
            }

            out.flush();

            if (!out)
                return false;
        }

        std::error_code ec;

        std::filesystem::rename(tmp, path_, ec);

        if (ec)
        {
            std::filesystem::remove(tmp, ec);
            return false;
        }

        return true;
    }

    void discard() const
    {
        std::error_code ec;

        std::filesystem::remove(path_, ec);
    }

private:
    struct Entry
    {
        uint64_t fileSize;
        uint32_t chunkSize;
        uint64_t nextChunkId;
    };

    std::filesystem::path path_;
    std::map<std::string, Entry> entries_;
};
