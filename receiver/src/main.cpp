#include "engine_entry.hpp"

// The command-line receiver: the engine's receiver run with stdout as its
// event stream. All logic lives in receiver.cpp (shared with the library).
int main(int argc, char **argv)
{
    return runReceiverMain(argc, argv);
}
