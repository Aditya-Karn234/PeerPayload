import fs from "fs";
import path from "path";

import {
  runEngineOnce,
  runSenderWithRetries,
  senderReportStatus,
  receiverReportStatus,
  reportOutcome,
  RECEIVER_MAX_RETRIES,
  RECEIVER_LISTEN_TIMEOUT_SEC,
} from "client-core/transferPolicy";
import config from "./config";
import { getApiClient } from "./apiClient";
import { getLocalIp, findFreePort } from "./network";
import * as socketBus from "./socket";

// 90s, not 30s — a human has to notice a notification and click it, and the
// free-tier backend can take 30-50s to cold-start after being idle, during
// which the heartbeat-based "online" check can pass well before the actual
// signaling socket has finished reconnecting.
const ACCEPT_TIMEOUT_MS = 90_000;

function collectFileStats(targetPath) {
  const stat = fs.statSync(targetPath);

  if (stat.isFile())
    return { fileCount: 1, totalBytes: stat.size };

  let fileCount = 0;
  let totalBytes = 0;

  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);

      if (entry.isDirectory())
        walk(full);
      else if (entry.isFile()) {
        fileCount++;
        totalBytes += fs.statSync(full).size;
      }
    }
  })(targetPath);

  return { fileCount, totalBytes };
}

// Unlike the CLI (which has no signaling channel and has to poll), the
// desktop app has a live socket connection — waiting on the actual
// transfer-accepted/rejected push is both faster and simpler than polling,
// with the same timeout safety net for a recipient who never responds.
function waitForAcceptance(transferId) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(Object.assign(new Error("timed out waiting for the recipient to respond"), { code: "timed_out" }));
    }, ACCEPT_TIMEOUT_MS);

    function onAccepted(transfer) {
      if (transfer.id === transferId) {
        cleanup();
        resolve(transfer);
      }
    }

    function onRejected(transfer) {
      if (transfer.id === transferId) {
        cleanup();
        reject(new Error("recipient rejected the transfer"));
      }
    }

    function cleanup() {
      clearTimeout(timeout);
      socketBus.events.off("transfer-accepted", onAccepted);
      socketBus.events.off("transfer-rejected", onRejected);
    }

    socketBus.events.on("transfer-accepted", onAccepted);
    socketBus.events.on("transfer-rejected", onRejected);
  });
}

// The sender side: resolve -> create intent -> wait for accept -> spawn
// sender.exe -> report. onProgress is called with { phase, transferId,
// event? } throughout, for the caller (main/index.js) to relay to the
// renderer over IPC.
export async function runSend({ filePath, toUsername, chunkSize }, onProgress) {
  const api = getApiClient();

  const recipient = await api.resolveRecipient(toUsername);

  if (!recipient.online)
    throw new Error(`${toUsername} is not currently reachable`);

  const { fileCount, totalBytes } = collectFileStats(filePath);
  const intent = await api.createTransferIntent({ toUsername, fileCount, totalBytes });

  onProgress({ phase: "waiting-for-acceptance", transferId: intent.id });

  let accepted;

  try {
    accepted = await waitForAcceptance(intent.id);
  } catch (err) {
    // Without this, a timed-out/never-accepted intent is left "pending" in
    // the database forever — it can't ever complete (this sender has
    // already given up and never spawns sender.exe), so it just clutters
    // history and inflates the "active transfers" count. Best-effort: if
    // even this report fails, the original error is still what the user
    // sees — reporting is a cleanup step, not the point of this call.
    await reportOutcome(api, intent.id, {
      role: "sender",
      status: err.code === "timed_out" ? "timed_out" : "failed",
      fileCount,
      totalBytes,
      failReason: err.message,
    });

    throw err;
  }

  onProgress({ phase: "sending", transferId: intent.id });

  const args = [
    "-h", accepted.receiverAddress,
    "-p", String(accepted.receiverPort),
    "--token", intent.engineToken,
    "--transfer-id", intent.id,
  ];

  if (chunkSize)
    args.push("--chunk-size", String(chunkSize));

  // The fingerprint came from the backend over HTTPS, so pinning to it means
  // only the receiver that accepted this transfer can complete the TLS
  // handshake. Absent only for an older receiving client.
  if (accepted.receiverCertFingerprint)
    args.push("--pin-sha256", accepted.receiverCertFingerprint);

  args.push(filePath);

  const outcome = await runSenderWithRetries({
    exePath: config.senderPath,
    args,
    onEvent: (event, attempt) => onProgress({ phase: "sending", transferId: intent.id, attempt, event }),
    onRetry: ({ attempt, reason, delayMs }) =>
      onProgress({ phase: "retrying", transferId: intent.id, attempt, reason, delayMs }),
  });

  const { finalEvent } = outcome;
  const ok = finalEvent.event === "transfer_complete";

  // A failed audit write must not turn a delivered file into a failure.
  const reported = await reportOutcome(api, intent.id, {
    role: "sender",
    status: senderReportStatus(outcome),
    fileCount,
    totalBytes,
    failReason: ok ? undefined : finalEvent.reason,
    elapsedMs: finalEvent.elapsedMs,
  });

  onProgress({ phase: "done", transferId: intent.id, ok, finalEvent, attempts: outcome.attempts, reported });

  return { ok, transferId: intent.id };
}

// The receiver side: spawn receiver.exe first (so the token is already
// bound to a listening process before we ever tell the backend "accept"),
// then accept, then wait for the transfer to actually run.
export async function runReceive({ transferId, outputDir }, onProgress) {
  const api = getApiClient();

  const transfer = await api.getTransfer(transferId);

  if (!transfer.engineToken)
    throw new Error("missing engine token for this transfer — was it fetched as the receiver?");

  const port = await findFreePort();

  onProgress({ phase: "starting-receiver", transferId });

  fs.mkdirSync(outputDir, { recursive: true });

  const args = [
    "-p", String(port),
    "-o", outputDir,
    "--token", transfer.engineToken,
    "--transfer-id", transferId,
    // Stay up through a dropped link so the sender can reconnect and
    // resume, and give up if the sender never shows up at all.
    "--max-retries", String(RECEIVER_MAX_RETRIES),
    "--listen-timeout", String(RECEIVER_LISTEN_TIMEOUT_SEC),
  ];

  let listeningResolve;
  let listeningReject;
  const listening = new Promise((resolve, reject) => { listeningResolve = resolve; listeningReject = reject; });

  const finishedPromise = runEngineOnce(config.receiverPath, args, (event) => {
    if (event.event === "listening")
      listeningResolve(event);

    onProgress({ phase: "receiving", transferId, event });
  });

  // If the engine never gets to "listening" (fails to spawn, exits early,
  // etc.), finishedPromise rejects/resolves without listeningResolve ever
  // firing — without this, "await listening" below just hangs forever
  // instead of surfacing the failure (a real bug: the UI was stuck on
  // "Starting receiver..." indefinitely when the engine binary was
  // missing). No-op if listening already settled.
  finishedPromise.catch((err) => listeningReject(err));

  const listeningEvent = await listening;

  await api.acceptTransfer(transferId, {
    host: getLocalIp(),
    port,
    certFingerprint: listeningEvent.certSha256,
  });
  onProgress({ phase: "accepted", transferId });

  const finalEvent = await finishedPromise;
  const ok = finalEvent.event === "transfer_complete";

  await reportOutcome(api, transferId, {
    role: "receiver",
    status: receiverReportStatus(finalEvent),
    failReason: ok ? undefined : finalEvent.reason,
    elapsedMs: finalEvent.elapsedMs,
  });

  onProgress({ phase: "done", transferId, ok, finalEvent });

  return { ok, transferId };
}
