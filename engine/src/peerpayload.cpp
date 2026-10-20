#include "peerpayload.h"

#include <string>
#include <vector>

#include "engine_entry.hpp"
#include "protocol.hpp"
#include "run_context.hpp"

struct pp_run
{
    RunContext context;
};

namespace
{

// Runs one of the engine's main functions in-process with `run` as the
// calling thread's current run, so its events go to the callback and it
// can be cancelled. argv gets the program name the parsers expect.
int callEngine(pp_run *run, int (*entry)(int, char **), const char *program, int argc, const char *const *argv)
{
    if (!run || argc < 0 || (argc > 0 && !argv))
        return 1;

    std::vector<std::string> storage;

    storage.reserve(static_cast<size_t>(argc) + 1);
    storage.emplace_back(program);

    for (int i = 0; i < argc; i++)
        storage.emplace_back(argv[i] ? argv[i] : "");

    std::vector<char *> args;

    for (auto &arg : storage)
        args.push_back(&arg[0]);

    args.push_back(nullptr);

    RunContext *previous = currentRun();

    currentRun() = &run->context;

    int rc = entry(static_cast<int>(storage.size()), args.data());

    currentRun() = previous;

    return rc;
}

} // namespace

extern "C" {

PP_API pp_run *pp_run_new(pp_event_fn on_event, void *user_data)
{
    auto *run = new pp_run;

    if (on_event)
    {
        run->context.onEvent = [on_event, user_data](const std::string &line) {
            on_event(line.c_str(), user_data);
        };
    }
    else
    {
        // Must not fall back to stdout: a library caller didn't ask for it.
        run->context.onEvent = [](const std::string &) {};
    }

    return run;
}

PP_API int pp_run_sender(pp_run *run, int argc, const char *const *argv)
{
    return callEngine(run, runSenderMain, "sender", argc, argv);
}

PP_API int pp_run_receiver(pp_run *run, int argc, const char *const *argv)
{
    return callEngine(run, runReceiverMain, "receiver", argc, argv);
}

PP_API void pp_run_cancel(pp_run *run)
{
    if (run)
        cancelRun(run->context);
}

PP_API void pp_run_free(pp_run *run)
{
    delete run;
}

PP_API int pp_protocol_version(void)
{
    return static_cast<int>(PROTOCOL_VERSION);
}

} // extern "C"
