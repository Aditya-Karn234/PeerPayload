const fs = require("fs");
const path = require("path");

const { runSender, senderReportStatus, reportOutcome } = require("client-core/transferPolicy");
const { api, tokenStore } = require("../client");
const config = require("../config");
const { printJson } = require("../output");

const POLL_INTERVAL_MS = 1000;
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

// Never connects blind (architecture.md) — polls the intent's status until
// the recipient's client calls /accept or /reject, or gives up after
// ACCEPT_TIMEOUT_MS so a sender isn't stuck forever if the recipient's
// client never responds (e.g. they saw the notification and walked away).
async function waitForAcceptance(transferId) {
  const deadline = Date.now() + ACCEPT_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const transfer = await api.getTransfer(transferId);

    if (transfer.status === "accepted")
      return transfer;

    if (transfer.status === "rejected")
      throw new Error("recipient rejected the transfer");

    if (transfer.status !== "pending")
      throw new Error(`transfer ended in unexpected status "${transfer.status}"`);

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  throw Object.assign(new Error("timed out waiting for the recipient to respond"), { code: "timed_out" });
}

function senderArgs({ token, transferId, chunkSize, certFingerprint, filePath }) {
  const args = ["--token", token, "--transfer-id", transferId];

  if (chunkSize)
    args.push("--chunk-size", String(chunkSize));

  // From the backend over HTTPS: only the receiver that accepted this
  // transfer can complete the TLS handshake.
  if (certFingerprint)
    args.push("--pin-sha256", certFingerprint);

  args.push(filePath);

  return args;
}

async function sendCommand(filePath, options) {
  if (!tokenStore.get()) {
    console.error("Not logged in. Run `peerpayload login` first.");
    process.exitCode = 1;
    return;
  }

  const resolvedPath = path.resolve(filePath);

  if (!fs.existsSync(resolvedPath)) {
    console.error(`No such file or directory: ${resolvedPath}`);
    process.exitCode = 1;
    return;
  }

  try {
    const recipient = await api.resolveRecipient(options.to);

    if (!recipient.online)
      throw new Error(`${options.to} is not currently reachable`);

    const { fileCount, totalBytes } = collectFileStats(resolvedPath);
    const intent = await api.createTransferIntent({ toUsername: options.to, fileCount, totalBytes });

    if (!options.json)
      console.log(`Waiting for ${options.to} to accept...`);

    let accepted;

    try {
      accepted = await waitForAcceptance(intent.id);
    } catch (err) {
      // Without this, a timed-out/never-accepted intent is left "pending" in
      // the database forever — it can't ever complete (this sender has
      // already given up and never spawns sender.exe), so it just clutters
      // history. Best-effort: if even this report fails, the original
      // error is still what the user sees.
      await reportOutcome(api, intent.id, {
        role: "sender",
        status: err.code === "timed_out" ? "timed_out" : "failed",
        fileCount,
        totalBytes,
        failReason: err.message,
      });

      throw err;
    }

    if (!options.json)
      console.log(`Accepted. Sending to ${accepted.receiverAddress}:${accepted.receiverPort}...`);

    let printedDots = false;

    const outcome = await runSender({
      exePath: config.senderPath,
      target: { host: accepted.receiverAddress, port: accepted.receiverPort },
      // Direct when the receiver's address answers, relay otherwise.
      relay: accepted.relayAvailable ? { getTicket: () => api.getRelayTicket(intent.id) } : null,
      onPath: (path) => {
        if (!options.json && path === "relay")
          console.log("Receiver isn't directly reachable; sending through the relay...");
      },
      baseArgs: senderArgs({
        token: intent.engineToken,
        transferId: intent.id,
        chunkSize: options.chunkSize,
        certFingerprint: accepted.receiverCertFingerprint,
        filePath: resolvedPath,
      }),
      onEvent: (event) => {
        if (!options.json && event.event === "chunk_verified") {
          process.stdout.write(".");
          printedDots = true;
        }
      },
      onRetry: ({ attempt, reason, delayMs }) => {
        if (printedDots) {
          process.stdout.write("\n");
          printedDots = false;
        }

        if (!options.json)
          console.log(`Attempt ${attempt} failed (${reason}); resuming in ${Math.round(delayMs / 1000)}s...`);
      },
    });

    if (printedDots)
      process.stdout.write("\n");

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
      path: outcome.path,
      attempts: outcome.attempts,
    });

    if (options.json) {
      printJson({ ok, transferId: intent.id, attempts: outcome.attempts, path: outcome.path, reported, ...finalEvent });
    } else if (ok) {
      console.log(`Transfer complete (${finalEvent.elapsedMs}ms${outcome.path === "relay" ? ", via relay" : ""}${outcome.attempts > 1 ? `, ${outcome.attempts} attempts` : ""}).`);
    } else {
      console.error(`Transfer failed: ${finalEvent.reason}`);
    }

    if (!reported && !options.json)
      console.error("Warning: couldn't record the outcome with the server; history may show this transfer as still in progress.");

    if (!ok)
      process.exitCode = 1;
  } catch (err) {
    if (options.json)
      printJson({ ok: false, error: err.message });
    else
      console.error(`Send failed: ${err.message}`);

    process.exitCode = 1;
  }
}

module.exports = { sendCommand };
