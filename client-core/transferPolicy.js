const { spawnEngineProcess } = require("./engine");

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
// which means it crashed or couldn't start at all.
function runEngineOnce(exePath, args, onEvent) {
  return new Promise((resolve, reject) => {
    const handle = spawnEngineProcess(exePath, args);
    let finalEvent = null;

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

// Runs the sender, re-running it after retryable failures. Each re-run
// resumes from wherever the receiver's resume state says it got to.
async function runSenderWithRetries({ exePath, args, onEvent, onRetry, wait = sleep }) {
  let connected = false;

  for (let attempt = 1; ; attempt++) {
    const finalEvent = await runEngineOnce(exePath, args, (event) => {
      if (event.event === "session_start")
        connected = true;

      onEvent?.(event, attempt);
    });

    if (finalEvent.event === "transfer_complete")
      return { finalEvent, attempts: attempt, connected };

    const reason = finalEvent.reason;
    const retryable = RETRYABLE_REASONS.has(reason) || (connected && RETRYABLE_AFTER_CONNECT.has(reason));

    if (!retryable || attempt >= MAX_SEND_ATTEMPTS)
      return { finalEvent, attempts: attempt, connected };

    const delayMs = RETRY_DELAYS_MS[Math.min(attempt - 1, RETRY_DELAYS_MS.length - 1)];

    onRetry?.({ attempt, reason, delayMs });

    await wait(delayMs);
  }
}

// Audit status for the sender's report (see backend REPORTABLE_STATUSES).
function senderReportStatus({ finalEvent, connected }) {
  if (finalEvent.event === "transfer_complete")
    return "complete";

  if (finalEvent.reason === "connection_failed" && !connected)
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
  runSenderWithRetries,
  senderReportStatus,
  receiverReportStatus,
  reportOutcome,
};
