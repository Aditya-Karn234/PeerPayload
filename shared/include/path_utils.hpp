#pragma once

#include <string>
#include <filesystem>
#include <cctype>

#include "protocol.hpp"

// Turn a filesystem path into the '/'-separated relative form that goes in
// FileHeader::relPath. `base` is the directory the path is relative to.
inline std::string toRelPath(
    const std::filesystem::path &full,
    const std::filesystem::path &base)
{
    std::error_code ec;

    auto rel =
        std::filesystem::relative(full, base, ec);

    if (ec || rel.empty())
        return full.filename().generic_string();

    return rel.generic_string();
}

inline bool isReservedWindowsName(const std::string &component)
{
    // Compare against the stem only: "COM1.txt" is just as reserved as "COM1".
    std::string stem = component.substr(0, component.find('.'));

    for (auto &c : stem)
        c = static_cast<char>(std::toupper(static_cast<unsigned char>(c)));

    if (stem == "CON" || stem == "PRN" || stem == "AUX" || stem == "NUL")
        return true;

    if (stem.size() == 4 &&
        (stem.compare(0, 3, "COM") == 0 || stem.compare(0, 3, "LPT") == 0) &&
        stem[3] >= '1' && stem[3] <= '9')
        return true;

    return false;
}

// Validate a relPath that arrived off the socket. Everything here is a
// rejection rather than a fixup: silently "repairing" a hostile path is how
// you end up writing outside the output directory.
inline bool sanitizeRelPath(
    const char raw[MAX_PATH_LEN],
    std::string &out,
    std::string &error)
{
    size_t len = 0;

    while (len < MAX_PATH_LEN && raw[len] != '\0')
        len++;

    if (len == MAX_PATH_LEN)
    {
        error = "path is not null-terminated";
        return false;
    }

    if (len == 0)
    {
        error = "path is empty";
        return false;
    }

    std::string path(raw, len);

    for (char &c : path)
    {
        auto uc = static_cast<unsigned char>(c);

        // Control characters would also corrupt the state file, which is
        // line-oriented with the path as the final field.
        if (uc < 0x20 || uc == 0x7F)
        {
            error = "path contains a control character";
            return false;
        }

        if (c == '\\')
            c = '/';
    }

    if (path.front() == '/')
    {
        error = "path is absolute";
        return false;
    }

    if (path.find(':') != std::string::npos)
    {
        error = "path contains a drive or stream separator";
        return false;
    }

    for (char c : {'<', '>', '"', '|', '?', '*'})
    {
        if (path.find(c) != std::string::npos)
        {
            error = std::string("path contains invalid character '") + c + "'";
            return false;
        }
    }

    std::string result;
    size_t start = 0;

    while (start <= path.size())
    {
        size_t slash = path.find('/', start);

        std::string component =
            path.substr(
                start,
                slash == std::string::npos
                    ? std::string::npos
                    : slash - start);

        if (component.empty())
        {
            error = "path has an empty component";
            return false;
        }

        if (component == "." || component == "..")
        {
            error = "path has a '" + component + "' component";
            return false;
        }

        // Windows silently strips these, so "evil. " and "evil" would land on
        // the same file.
        if (component.back() == ' ' || component.back() == '.')
        {
            error = "path component ends with a space or dot";
            return false;
        }

        if (isReservedWindowsName(component))
        {
            error = "path uses reserved name '" + component + "'";
            return false;
        }

        if (!result.empty())
            result += '/';

        result += component;

        if (slash == std::string::npos)
            break;

        start = slash + 1;
    }

    out = result;

    return true;
}
