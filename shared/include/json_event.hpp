#pragma once

#include <cstdint>
#include <cstdio>
#include <iostream>
#include <mutex>
#include <string>

// The pipelined sender has multiple threads (reader/hasher/sender/ack
// listener) that can each emit an event; std::cout itself isn't safe against
// interleaved writes from separate threads, so every emit() serializes
// through this one mutex. Uncontended in the single-threaded receiver, cheap
// either way next to a socket round trip.
inline std::mutex &jsonEventMutex()
{
    static std::mutex mutex;

    return mutex;
}

// stdout is the entire bridge to whatever spawns this process: one
// newline-delimited JSON object per event, nothing else. Anything meant for
// a human running the binary directly belongs on stderr instead, since a
// stray plain-text line on stdout breaks a line-oriented JSON parser on the
// other end.
inline std::string escapeJsonString(const std::string &value)
{
    std::string out;

    out.reserve(value.size());

    for (unsigned char c : value)
    {
        switch (c)
        {
        case '"':
            out += "\\\"";
            break;
        case '\\':
            out += "\\\\";
            break;
        case '\b':
            out += "\\b";
            break;
        case '\f':
            out += "\\f";
            break;
        case '\n':
            out += "\\n";
            break;
        case '\r':
            out += "\\r";
            break;
        case '\t':
            out += "\\t";
            break;
        default:
            if (c < 0x20)
            {
                char buf[8];

                std::snprintf(buf, sizeof(buf), "\\u%04x", c);

                out += buf;
            }
            else
            {
                out += static_cast<char>(c);
            }
        }
    }

    return out;
}

// Builds one flat JSON object and writes it as a single line. Field order is
// insertion order, which keeps output deterministic and easy to eyeball.
class JsonEvent
{
public:
    explicit JsonEvent(const std::string &eventName)
    {
        body_ = "\"event\":\"" + escapeJsonString(eventName) + "\"";
    }

    JsonEvent &field(const std::string &key, const std::string &value)
    {
        append(key, "\"" + escapeJsonString(value) + "\"");
        return *this;
    }

    JsonEvent &field(const std::string &key, const char *value)
    {
        return field(key, std::string(value));
    }

    JsonEvent &field(const std::string &key, uint64_t value)
    {
        append(key, std::to_string(value));
        return *this;
    }

    JsonEvent &field(const std::string &key, uint32_t value)
    {
        return field(key, static_cast<uint64_t>(value));
    }

    JsonEvent &field(const std::string &key, int value)
    {
        append(key, std::to_string(value));
        return *this;
    }

    JsonEvent &field(const std::string &key, bool value)
    {
        append(key, value ? std::string("true") : std::string("false"));
        return *this;
    }

    // Flushed immediately: stdout to a pipe is fully buffered by default, and
    // a consumer waiting on live progress can't wait for process exit.
    void emit() const
    {
        std::lock_guard<std::mutex> lock(jsonEventMutex());

        std::cout << "{" << body_ << "}\n"
                   << std::flush;
    }

private:
    void append(const std::string &key, const std::string &jsonValue)
    {
        body_ += ",\"" + escapeJsonString(key) + "\":" + jsonValue;
    }

    std::string body_;
};
