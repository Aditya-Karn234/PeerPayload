#pragma once

#include <iomanip>
#include <random>
#include <sstream>
#include <string>

// A backend spawning sender/receiver as a matched pair passes the same
// --transfer-id to both, so their independent JSON event streams can be
// correlated back to one row in a transfers table. Standalone runs (no
// backend) still need every event tagged with something, so generate one
// when it's not given.
inline std::string generateTransferId()
{
    std::random_device seed;
    std::mt19937_64 rng(seed());

    std::ostringstream out;

    out << std::hex << std::setfill('0')
        << std::setw(16) << rng()
        << std::setw(16) << rng();

    return out.str();
}
