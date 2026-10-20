#include "engine_entry.hpp"

// The command-line sender: the engine's sender run with stdout as its
// event stream. All logic lives in sender.cpp (shared with the library).
int main(int argc, char **argv)
{
    return runSenderMain(argc, argv);
}
