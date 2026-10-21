const { spawnEngineProcess } = require("./engine");
const { startSenderBridge, startReceiverBridge, probeTcp } = require("./relayBridge");

// How a client drives the engine through failures. Shared by the desktop
// app and the CLI so both retry, resume and report identically.
//
// The receiver is spawned with --max-retries RECEIVER_MAX_RETRIES, so after
// a network failure it keeps listening with its resume state saved; the
// sender is simply re-run against the same host/port/token and resumes from
// the last durable chunk. MAX_SEND_ATTEMPTS counts the first try too, so
// the two sides agree on how many failed sessions are allowed.
const MAX_SEND_ATTEMPTS = 4;
const RECEIVER_MAX_RETRIES = MAX_SEND_ATTEMPTS - 1;
const RETRY_DELAYS_MS = [2000, 5000, 10000];

// How long a receiver waits for the sender to (re)connect before giving up
// with listen_timeout. Re-armed by the engine after each failed session, so
// it only has to cover one retry delay plus connection setup.
const RECEIVER_LISTEN_TIMEOUT_SEC = 120;

// Sender failure reasons worth another attempt: the connection or the peer
// went away, or a chunk was corrupted in flight. Anything else (wrong
// token, bad input, receiver's disk) would fail the same way again.
const RETRYABLE_REASONS = new Set([
  "peer_timeout",
  "ack_receive_failed",
  "chunk_send_failed",
  "chunk_mismatch",
  "file_header_send_failed",
  "resume_handshake_failed",
  "eof_marker_send_failed",
  "eof_confirmation_failed",
  "session_send_failed",
  "no_session_response",
]);

// Retryable only once this transfer has connected at least once: before
// that, failing to connect means the receiver isn't reachable at all
// (NAT, firewall, wrong address), and retrying just delays saying so.
const RETRYABLE_AFTER_CONNECT = new Set(["connection_failed", "tls_handshake_failed"]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Runs one engine process to completion. Resolves with its final event
// (transfer_complete or transfer_failed); rejects if it exits without one,
// which means it crashed or couldn't start at all (or was killed).
// onSpawn, if given, receives the process handle (for handle.kill()).
function runEngineOnce(exePath, args, onEvent, onSpawn) {
  return new Promise((resolve, reject) => {
    const handle = spawnEngineProcess(exePath, args);
    let finalEvent = null;

    onSpawn?.(handle);

    handle.on("event", (event) => {
      onEvent?.(event);

      if (event.event === "transfer_complete" || event.event === "transfer_failed")
        finalEvent = event;
    });

    handle.on("exit", ({ code }) => {
      if (finalEvent)
        resolve(finalEvent);
      else
        reject(new Error(`engine process exited (code ${code}) without a final event`));
    });

    handle.on("error", reject);
  });
}

// How long the sender spends checking whether the receiver's advertised
// address answers before falling back to the relay.
const DIRECT_PROBE_TIMEOUT_MS = 3000;

// Direct-path failures that mean "this address isn't the receiver from
// here" rather than "the transfer broke": nothing listening, a different
// machine that happens to own that private IP on the sender's own network
// (pin mismatch), or something that isn't our engine. With a relay
// available these switch paths instead of failing.
const SWITCH_TO_RELAY_REASONS = new Set(["connection_failed", "tls_pin_mismatch", "tls_handshake_failed"]);

// Runs the sender, re-running it after retryable failures; each re-run
// resumes from wherever the receiver's resume state says it got to.
//
// Path per attempt: direct when the receiver's address answers (always the
// case on a LAN/VPN), otherwise through the relay when `relay` is given.
// Once on the relay it stays there.
//
//   target   { host, port } the receiver advertised at accept time
//   baseArgs engine args without -h/-p (token, id, chunk size, pin, path)
//   relay    { getTicket } or null when the backend has no relay configured
//   onSpawn  (handle) => void for each engine process started (to stop it)
async function runSender({
  exePath,
  baseArgs,
  target,
  relay = null,
  onEvent,
  onRetry,
  onPath,
  onSpawn,
  wait = sleep,
  probe = probeTcp,
  startBridge = startSenderBridge,
}) {
  let connected = false;
  let failures = 0;
  let attempts = 0;
  let path = null;
  let bridge = null;
  let switched = false;

  const usePath = (next) => {
    if (next !== path) {
      path = next;
      onPath?.(path);
    }
  };

  try {
    for (;;) {
      if (path !== "relay") {
        const reachable = await probe(target.host, target.port, DIRECT_PROBE_TIMEOUT_MS);

        usePath(!reachable && relay ? "relay" : "direct");
      }

      let host = target.host;
      let port = target.port;

      if (path === "relay") {
        bridge ??= await startBridge({ getTicket: relay.getTicket });
        host = "127.0.0.1";
        port = bridge.port;
      }

      attempts++;

      let startedThisAttempt = false;

      const finalEvent = await runEngineOnce(exePath, ["-h", host, "-p", String(port), ...baseArgs], (event) => {
        if (event.event === "session_start") {
          connected = true;
          startedThisAttempt = true;
        }

        onEvent?.(event, attempts, path);
      }, onSpawn);

      if (finalEvent.event === "transfer_complete")
        return { finalEvent, attempts, connected, path };

      const reason = finalEvent.reason;

      // The direct address turned out to be wrong from here: switch once,
      // immediately, without spending one of the retry attempts.
      if (path === "direct" && relay && !switched && !startedThisAttempt && SWITCH_TO_RELAY_REASONS.has(reason)) {
        switched = true;
        usePath("relay");
        continue;
      }

      const retryable = RETRYABLE_REASONS.has(reason) || (connected && RETRYABLE_AFTER_CONNECT.has(reason));

      failures++;

      if (!retryable || failures >= MAX_SEND_ATTEMPTS)
        return { finalEvent, attempts, connected, path };

      const delayMs = RETRY_DELAYS_MS[Math.min(failures - 1, RETRY_DELAYS_MS.length - 1)];

      onRetry?.({ attempt: attempts, reason, delayMs, path });

      await wait(delayMs);
    }
  } finally {
    bridge?.close();
  }
}

// Audit status for the sender's report (see backend REPORTABLE_STATUSES).
// Never having connected through any path means the receiver couldn't be
// reached — a refused/unanswered direct connect, or a relay pairing that
// never completed the TLS handshake.
function senderReportStatus({ finalEvent, connected }) {
  if (finalEvent.event === "transfer_complete")
    return "complete";

  if (!connected && ["connection_failed", "tls_handshake_failed"].includes(finalEvent.reason))
    return "not_reachable";

  return "failed";
}

function receiverReportStatus(finalEvent) {
  if (finalEvent.event === "transfer_complete")
    return "complete";

  if (finalEvent.reason === "listen_timeout")
    return "not_reachable";

  return "failed";
}

// Posts the outcome, retrying through a cold-starting or briefly
// unreachable backend. Never throws: the audit record failing to land must
// not turn a delivered file into a reported failure. Resolves to whether it
// was recorded.
async function reportOutcome(api, transferId, report, { delaysMs = [1000, 3000, 10000], wait = sleep } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      await api.postTransferReport(transferId, report);
      return true;
    } catch (err) {
      // 4xx won't get better by retrying.
      if ((err.status >= 400 && err.status < 500) || attempt >= delaysMs.length)
        return false;

      await wait(delaysMs[attempt]);
    }
  }
}

module.exports = {
  MAX_SEND_ATTEMPTS,
  RECEIVER_MAX_RETRIES,
  RECEIVER_LISTEN_TIMEOUT_SEC,
  RETRY_DELAYS_MS,
  runEngineOnce,
  runSender,
  startReceiverBridge,
  senderReportStatus,
  receiverReportStatus,
  reportOutcome,
};
