const fs = require("fs");
const path = require("path");

const { spawnEngineProcess } = require("client-core/engine");
const { api, tokenStore } = require("../client");
const config = require("../config");
const { printJson } = require("../output");

const POLL_INTERVAL_MS = 1000;
const ACCEPT_TIMEOUT_MS = 30_000;

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

  throw new Error("timed out waiting for the recipient to respond");
}

function runSender({ host, port, token, transferId, chunkSize, filePath }, onEvent) {
  return new Promise((resolve, reject) => {
    const args = ["-h", host, "-p", String(port), "--token", token, "--transfer-id", transferId];

    if (chunkSize)
      args.push("--chunk-size", String(chunkSize));

    args.push(filePath);

    const handle = spawnEngineProcess(config.senderPath, args);
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
        reject(new Error(`sender exited (code ${code}) without a final event`));
    });

    handle.on("error", reject);
  });
}

async function sendCommand(filePath, options) {
  if (!tokenStore.get()) {
    console.error("Not logged in. Run `orgxfer login` first.");
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

    const accepted = await waitForAcceptance(intent.id);

    if (!options.json)
      console.log(`Accepted. Sending to ${accepted.receiverAddress}:${accepted.receiverPort}...`);

    let printedDots = false;

    const finalEvent = await runSender(
      {
        host: accepted.receiverAddress,
        port: accepted.receiverPort,
        token: intent.engineToken,
        transferId: intent.id,
        chunkSize: options.chunkSize,
        filePath: resolvedPath,
      },
      (event) => {
        if (!options.json && event.event === "chunk_verified") {
          process.stdout.write(".");
          printedDots = true;
        }
      },
    );

    if (printedDots)
      process.stdout.write("\n");

    const ok = finalEvent.event === "transfer_complete";

    await api.postTransferReport(intent.id, {
      role: "sender",
      status: ok ? "complete" : "failed",
      fileCount,
      totalBytes,
      failReason: ok ? undefined : finalEvent.reason,
      elapsedMs: finalEvent.elapsedMs,
    });

    if (options.json) {
      printJson({ ok, transferId: intent.id, ...finalEvent });
    } else if (ok) {
      console.log(`Transfer complete (${finalEvent.elapsedMs}ms).`);
    } else {
      console.error(`Transfer failed: ${finalEvent.reason}`);
    }

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
