import fs from "fs";
import path from "path";

import { spawnEngineProcess } from "client-core/engine";
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
      reject(new Error("timed out waiting for the recipient to respond"));
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

function runEngineProcess(exePath, args, onEvent) {
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
    await api
      .postTransferReport(intent.id, { role: "sender", status: "failed", fileCount, totalBytes, failReason: err.message })
      .catch(() => {});

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

  args.push(filePath);

  const finalEvent = await runEngineProcess(config.senderPath, args, (event) =>
    onProgress({ phase: "sending", transferId: intent.id, event }),
  );

  const ok = finalEvent.event === "transfer_complete";

  await api.postTransferReport(intent.id, {
    role: "sender",
    status: ok ? "complete" : "failed",
    fileCount,
    totalBytes,
    failReason: ok ? undefined : finalEvent.reason,
    elapsedMs: finalEvent.elapsedMs,
  });

  onProgress({ phase: "done", transferId: intent.id, ok, finalEvent });

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
  ];

  let listeningResolve;
  const listening = new Promise((resolve) => { listeningResolve = resolve; });

  const finishedPromise = runEngineProcess(config.receiverPath, args, (event) => {
    if (event.event === "listening")
      listeningResolve();

    onProgress({ phase: "receiving", transferId, event });
  });

  await listening;

  await api.acceptTransfer(transferId, { host: getLocalIp(), port });
  onProgress({ phase: "accepted", transferId });

  const finalEvent = await finishedPromise;
  const ok = finalEvent.event === "transfer_complete";

  await api.postTransferReport(transferId, {
    role: "receiver",
    status: ok ? "complete" : "failed",
    failReason: ok ? undefined : finalEvent.reason,
    elapsedMs: finalEvent.elapsedMs,
  });

  onProgress({ phase: "done", transferId, ok, finalEvent });

  return { ok, transferId };
}
