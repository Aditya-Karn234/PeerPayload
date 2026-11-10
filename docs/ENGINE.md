# The transfer engine

The C++ engine both products use to move files (`sender/`, `receiver/`,
`shared/`, `engine/`). It knows nothing about accounts, devices or either
app: callers pass command-line arguments and read JSON events.

## How it works

- **Resumable.** Interrupt a transfer (kill the process, lose the network)
  and re-run the same sender command — it picks up from the last
  chunk the receiver durably wrote, verified against both file size and
  chunk size so a changed source file or a different `--chunk-size`
  correctly restarts from scratch instead of producing a corrupted splice.
- **Verified.** Every chunk is SHA-256 hashed by the sender and checked by
  the receiver before being written and acknowledged.
- **Pipelined.** A sliding window of chunks can be in flight at once,
  handled by four cooperating threads (disk reader → hasher → network
  sender, with a separate thread reading acks) instead of the naive
  send-one-wait-for-its-ack-send-next approach. See
  [Performance](#performance) for what this actually bought.
- **Encrypted and pinned.** TLS 1.3 by default. The receiver generates one
  self-signed certificate per run and publishes its SHA-256 fingerprint in
  its `listening` event. The apps send that fingerprint to the backend when
  accepting, and the sender passes it to `--pin-sha256`, so it refuses any
  other certificate: a machine-in-the-middle can't stand in for the
  receiver. Run standalone without `--pin-sha256`, the sender accepts any
  certificate (encryption only, no receiver authentication).
- **Fails instead of hanging.** Every send/recv has an idle timeout
  (`--idle-timeout`, default 120 s), so a peer that vanishes without
  closing the connection (sleep, Wi-Fi or VPN drop) ends the session with
  `peer_timeout` instead of blocking forever. TCP keepalive is on, so NAT
  state isn't expired mid-transfer.
- **Resumes automatically under the apps.** The apps start the receiver
  with `--max-retries 3 --listen-timeout 120`: after a network failure it
  keeps listening (emitting `session_failed`, not `transfer_failed`) with
  its resume state saved, and the desktop app or CLI re-runs the sender,
  which picks up from the last durable chunk. The retry policy lives in
  `client-core/transferPolicy.js` (Enterprise); Connect has its own in
  `connect/core/transfers.js`.
- **Cross-platform.** The same source builds and runs natively on Windows
  and Linux; sender and receiver interoperate in either direction
  regardless of which platform each side is running on.
- **IPv6 and IPv4.** The receiver listens dual-stack (one port, both
  families; the `listening` event reports `ipv6`), and the sender accepts
  IPv6 addresses (`::1` or `[::1]`) and hostnames of either family. Needed
  for IPv6-only mobile networks. Addresses are tried one after another,
  not raced, so a hostname whose first address silently drops packets
  delays the next one by up to the 20 s connect limit.
- **A hash mismatch aborts the session** rather than retrying the bad
  chunk in place. Once chunks are pipelined, chunks after a bad one may
  already be in flight or received by the time its failure is known, so a
  clean single-chunk retry isn't possible without the receiver buffering
  out-of-order chunks. Disconnecting and relying on resume is far less
  code, and a real mismatch should be rare — TCP already checksums the
  byte stream, so this mostly catches logic bugs, not routine transit
  noise.

## Device identities (PeerPayload Connect)

`ppkeygen --out <dir> --name "Alice's laptop"` creates a device identity: an
Ed25519 key (`device.key`, keep it private) and a self-signed certificate
(`device.crt`) that never expires. Its SHA-256 fingerprint (`certSha256`) is
the device's ID. Paired devices pin each other: the sender with
`--pin-sha256 <receiver's ID>`, the receiver with `--peer-sha256 <sender's
ID>`, both using `--cert`/`--key` for their own identity. That's mutual
TLS with no certificate authority and no server vouching for anyone.
`ppkeygen --show <dir>` prints an existing ID; it refuses to replace one
without `--force`, because that changes the device ID. The Enterprise apps
don't use any of this.

## Using the engine as a library

The same engine also builds as a library, `peerpayload` (`.dll`/`.so`), for
apps that can't launch the `sender`/`receiver` programs; the Connect
Android app uses it through JNI. The two programs are now just `main()`
wrappers around that library, so there is one implementation either way.

The C API (`engine/include/peerpayload.h`) takes the programs' exact
command-line arguments and delivers their exact JSON events through a
callback instead of stdout:

```c
pp_run *run = pp_run_new(on_event, user_data);
const char *args[] = { "-p", "8080", "-o", "/data/received" };
int rc = pp_run_receiver(run, 4, args);   /* blocks; 0 = success */
pp_run_free(run);
```

Runs block, so call them from a worker thread. `pp_run_cancel` works from
any thread at any stage (listening, connecting, mid-transfer) and ends the
run promptly with `transfer_failed` / `cancelled`, keeping resume state.
Several runs can be active in one process; each callback only sees its own
events. `engine/test/lib_test.cpp` (built as `engine_lib_test`) covers this.

## Running the engine standalone (no accounts, no backend)

```sh
# terminal 1
receiver -p 8080 -o ./received

# terminal 2
sender -p 8080 ./some-file-or-directory
```

Both take `--help` for the full flag list. The ones worth knowing:

| Flag | Applies to | What it does |
|---|---|---|
| `--chunk-size <bytes>` | sender | Bytes per chunk (default 64 KiB, range 4 KiB–8 MiB). Bigger chunks mean fewer round trips — see the performance section. |
| `--window <n>` | sender | Chunks allowed in flight at once before waiting for an ack (default 16). |
| `--bench <path>` | sender | Writes per-chunk stage timings (disk read / hash / send / ack) to a CSV. |
| `--no-tls` | both | Skips the TLS handshake. Debug/benchmark only — both sides must set it, or the connection fails. |
| `--token <token>` | both | Shared-secret handshake auth. This is what a transfer intent's `engineToken` fills in automatically when the engine is spawned by the desktop app or CLI. |
| `--transfer-id <id>` | both | Tags every emitted JSON event; callers use this to correlate a sender/receiver pair to one transfer record. |
| `--idle-timeout <sec>` | both | Give up when the peer is silent this long on any single send/recv (default 120, `0` = never). The failure reason is `peer_timeout`. |
| `--pin-sha256 <hex>` | sender | Refuse the receiver unless its certificate's SHA-256 matches (the `certSha256` from the receiver's `listening` event). Fails with `tls_pin_mismatch`. |
| `--max-retries <n>` | receiver | After a network-type session failure, keep listening for the sender to reconnect and resume, up to `n` times (default 0: exit on the first failure). |
| `--listen-timeout <sec>` | receiver | Exit with `listen_timeout` if no sender connects within this long; re-armed after each retryable failure (default 0 = wait forever). |
| `--cert <file>` `--key <file>` | both | Use a lasting device identity from `ppkeygen` instead of a throwaway certificate. The receiver's fingerprint then stays the same across runs; the sender presents it to receivers that require one. |
| `--peer-sha256 <hex>` | receiver | Mutual TLS: only accept senders presenting a certificate with this fingerprint (repeat for each allowed device). Others are refused (`tls_peer_not_allowed`) and the receiver keeps listening. `session_start` reports the sender's `peerCertSha256`. |

## Performance

Replacing stop-and-wait chunk transfer with the sliding-window pipeline
described above gave a **13–16× throughput improvement** at realistic
network latency (20–50 ms round trip) — stop-and-wait is bound by
`chunk_size / RTT`, a cost that's invisible on localhost and dominates
completely over any real link, independent of file size.

Chunk size turned out to matter even more: per-stage timing isolation
(reading `--bench` output) found that neither disk (~500–650 MB/s) nor
SHA-256 (~600–700 MB/s) were ever the bottleneck — it was the ack-listener
thread's `recv()` calls, at roughly 2.9 ms each, which dominates total time
once there are thousands of small chunks. Fewer, bigger chunks means
proportionally fewer acks: pushing chunk size to the protocol maximum
(8 MiB) reached **~200–290 MB/s**, roughly 10× the default 64 KiB result.

TLS costs nothing measurable at the sizes tested, consistent with
hardware-accelerated AES-GCM on modern CPUs.

Known limitations of this benchmark: a single machine, one pass per
condition, and no `iperf3`/`fio` baseline for a true I/O ceiling.

Reproduce it with `tools/benchmark.ps1` — see the script's own header
comment for why latency is simulated with a small TCP proxy
(`tools/latency-proxy.js`) rather than a `Sleep()` inside the receiver.
(That harness predates the accounts/presence rework and drives the engine
directly, standalone — it isn't affected by anything above it.)

## Tests and diagnostics

Engine tests drive the real `sender`/`receiver` binaries over their JSON
event stream, the same surface the desktop app and CLI use. Build the
engine first; there are no npm dependencies:

```sh
node --test "tests/engine/*.test.js"
```

To build the engine and run every suite in the repo (engine library,
engine, relay, Connect mailbox, Connect core) in one go, as CI does:

```sh
npm test               # builds first; on Windows MinGW64 must be at C:\msys64 (or set MINGW_BIN)
npm run test:quick     # skip the build
node tools/test-all.js --only relay,connect-core
```

| Suite | Covers |
|---|---|
| `integrity.test.js` | Byte-identical output across empty/1-byte/chunk-boundary files, every chunk size 4 KiB–8 MiB, window sizes, TLS and plaintext, nested/unicode directories, multiple sources, and truncation of a stale longer destination file. |
| `resume.test.js` | Link dropped mid-transfer (TLS and plaintext), receiver or sender process killed, repeated interruptions, partially finished directories, plus the cases that must restart from chunk 0 instead of resuming: changed file size, changed `--chunk-size`, deleted partial file, garbage or out-of-range `transfer.state`. |
| `ipv6.test.js` | Dual-stack receiver: transfers to `::1` and `[::1]`, IPv4 senders shown as plain IPv4, hostnames resolving to both families, pinning over IPv6. Skipped on machines without IPv6 loopback. |
| `identity.test.js` | `ppkeygen` (create, show, refuse to overwrite), stable receiver fingerprints with an identity, mutual TLS between paired devices (receiver learns the sender's ID), refusing senders with no certificate or an unknown one while staying up, several allowed devices, invalid flag combinations, and senders with an identity working against an Enterprise-style receiver. |
| `relay.test.js` | Engines through the real relay and client bridges, including a Connect-style transfer (device identities, mutual TLS, device-signed tickets, no backend): an unreachable address goes via the relay (pinned, byte-identical), a reachable one never touches it, a wrong machine at the advertised address switches to the relay, a relay link dropped mid-transfer resumes, and no path at all reports `not_reachable`. The relay's own tests (`relay/test/`) cover tickets, pairing, reconnects and flow control. |
| `robustness.test.js` | Idle timeouts (a frozen link fails both sides with `peer_timeout`; a silent connection is dropped while the receiver keeps listening), the listen deadline, the receiver retry window (survives a dropped link or a corrupted chunk and the re-run resumes; retry budget runs out), and certificate pinning (stable fingerprint, wrong pin refused, invalid pins rejected). |
| `failure-injection.test.js` | No receiver, wrong or missing token, TLS/plaintext mismatch, port scans and garbage bytes (receiver must keep listening), invalid input, injected chunk corruption (`DTS_CORRUPT_CHUNK`), bit flips on the wire via a fault proxy, and a hostile raw-protocol sender: bad handshake fields, path traversal, out-of-order/oversized/missing chunks, wrong hashes. |

Tests marked `todo` document known engine bugs (see
[Known limitations](#known-limitations)). They run and
report, but don't fail the suite. Point the tests at a different build
with `ENGINE_SENDER_PATH` / `ENGINE_RECEIVER_PATH`.

When a transfer won't work on a particular machine, run the diagnostic:

```sh
node tools/diagnose.js                         # engine, loopback TLS transfer, network, backend, login
node tools/diagnose.js --peer 10.0.0.12:52011  # also test reaching a peer's receiver port
node tools/diagnose.js --offline --json        # skip backend checks; machine-readable output
```

It checks that the engine binaries load (a missing DLL makes them exit
silently), runs a real loopback TLS transfer and verifies its SHA-256,
lists the LAN address the desktop app will advertise, checks the backend's
`/health` and whether the stored CLI login is still valid, and lists
interrupted transfers waiting to resume. It never prints the stored token.
It exits 1 if any check fails.

## Known limitations

- **No `htonl`/`ntohl` byte-order handling on the wire protocol.** Every
  platform this currently runs on (Windows and Linux, both x86-64) is
  little-endian, so this is a real gap only for a future big-endian
  target, not for anything deployed today.
- **No zero-copy send.** Benchmark data showed disk read and hashing
  aren't the bottleneck (see [Performance](#performance)), so the
  optimization `TransmitFile`/`sendfile` would provide isn't where the
  time actually goes.
- **Resume doesn't fingerprint file content.** A resume is allowed when
  the file size and chunk size match. If the source file is edited between
  runs but stays the same size, resume splices old and new bytes into a
  corrupted file and still reports success. Covered by a `todo` test in
  `resume.test.js`.
