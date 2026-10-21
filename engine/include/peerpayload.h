#ifndef PEERPAYLOAD_H
#define PEERPAYLOAD_H

/*
 * PeerPayload transfer engine as a library.
 *
 * For apps that can't spawn the sender/receiver programs (Android) or would
 * rather not. A run takes exactly the command-line arguments the programs
 * take (see `sender --help`, `receiver --help`) and reports exactly the
 * same JSON events, one per callback, instead of on stdout. Exit codes are
 * the same too: 0 on success, 1 on failure.
 *
 *   pp_run *run = pp_run_new(on_event, my_data);
 *   const char *args[] = { "-p", "8080", "-o", "/data/received" };
 *   int rc = pp_run_receiver(run, 4, args);   // blocks until done
 *   pp_run_free(run);
 *
 * pp_run_sender / pp_run_receiver block the calling thread, so call them
 * from a worker thread. pp_run_cancel may be called from any other thread
 * at any time; the run then ends promptly with a transfer_failed event
 * whose reason is "cancelled". Several runs may be active at once (e.g.
 * sending and receiving simultaneously); each reports only its own events.
 *
 * Diagnostics meant for humans still go to stderr.
 *
 * On Linux/Android the engine sets SIGPIPE to "ignore" for the process
 * (once, on the first run). Otherwise a peer closing the connection while
 * the engine is writing would kill the whole host process instead of
 * ending the run with transfer_failed. Android's runtime already ignores
 * SIGPIPE in app processes, so this changes nothing there.
 */

#ifdef __cplusplus
extern "C" {
#endif

#if defined(_WIN32) && defined(PEERPAYLOAD_BUILDING_DLL)
#define PP_API __declspec(dllexport)
#elif defined(_WIN32) && defined(PEERPAYLOAD_USING_DLL)
#define PP_API __declspec(dllimport)
#elif defined(__GNUC__)
#define PP_API __attribute__((visibility("default")))
#else
#define PP_API
#endif

typedef struct pp_run pp_run;

/* Called once per event with one JSON object (UTF-8, no newline). Called
 * from engine threads, possibly not the thread that started the run; calls
 * for one run never overlap. The string is only valid during the call. */
typedef void (*pp_event_fn)(const char *json_event, void *user_data);

PP_API pp_run *pp_run_new(pp_event_fn on_event, void *user_data);

/* argv excludes the program name: { "-h", "10.0.0.5", "-p", "8080", "file" }. */
PP_API int pp_run_sender(pp_run *run, int argc, const char *const *argv);
PP_API int pp_run_receiver(pp_run *run, int argc, const char *const *argv);

/* Device identity tool, same arguments as the ppkeygen program:
 * { "--out", dir, "--name", "Alice's phone" } creates dir/device.crt and
 * dir/device.key and reports identity_created with the certSha256 device
 * ID; { "--show", dir } reports an existing one. */
PP_API int pp_run_keygen(pp_run *run, int argc, const char *const *argv);

/* Thread-safe; idempotent; harmless before the run starts or after it ends. */
PP_API void pp_run_cancel(pp_run *run);

/* Only once the blocking pp_run_* call has returned. */
PP_API void pp_run_free(pp_run *run);

/* Wire protocol version this build speaks, e.g. 12. */
PP_API int pp_protocol_version(void);

#ifdef __cplusplus
}
#endif

#endif /* PEERPAYLOAD_H */
