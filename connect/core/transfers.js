const crypto = require("crypto");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");

const {
  runEngineOnce,
  runSender,
  startReceiverBridge,
  RECEIVER_MAX_RETRIES,
  RECEIVER_LISTEN_TIMEOUT_SEC,
} = require("client-core/transferPolicy");
const { probeTcp } = require("client-core/relayBridge");
const { issueDeviceTicket } = require("client-core/deviceTicket");

const { seal } = require("./envelope");

// Connect file transfers between paired devices. The negotiation travels
// as envelopes through the mailbox:
//
//   sender   -> offer   { transferId, files: [{ name, size }], fileCount, totalBytes }
//   receiver -> accept  { transferId, token, port, addresses: [host, ...], relay }
//            |  decline { transferId }
//   sender   -> cancel  { transferId }    (gave up: before the receiver answered,
//                                         or after the transfer itself failed)
//
// The bytes then go engine to engine, mutually authenticated with the two
// device certificates: the sender pins the receiver's device ID, and the
// receiver admits only the sender's. Direct when an advertised address
// answers, otherwise through the relay with device-signed tickets. The
// engine token travels only inside the encrypted accept envelope.

// How long a sender waits for the other device to answer an offer.
const OFFER_TIMEOUT_MS = 10 * 60 * 1000;

const MAX_OFFER_NAMES = 50;

function summarize(paths) {
  const files = [];
  let fileCount = 0;
  let totalBytes = 0;

  const walk = (p) => {
    const stat = fs.statSync(p);

    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(p))
        walk(path.join(p, entry));
    } else {
      fileCount++;
      totalBytes += stat.size;
    }
  };

  for (const p of paths) {
    const before = { fileCount, totalBytes };

    walk(p);

    if (files.length < MAX_OFFER_NAMES)
      files.push({ name: path.basename(p), size: totalBytes - before.totalBytes, files: fileCount - before.fileCount });
  }

  return { files, fileCount, totalBytes };
}

// Addresses another device might reach this one at: every non-internal
// interface, IPv4 first. Loopback last, for two devices on one machine.
function localAddresses() {
  const v4 = [];
  const v6 = [];

  for (const list of Object.values(os.networkInterfaces()))
    for (const iface of list || []) {
      if (iface.internal)
        continue;

      if (iface.family === "IPv4")
        v4.push(iface.address);
      else if (!iface.address.startsWith("fe80"))
        v6.push(iface.address);
    }

  return [...v4, ...v6, "127.0.0.1"];
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();

    server.listen(0, () => {
      const { port } = server.address();

      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

// First advertised address that answers, or the first one (the sender then
// falls back to the relay when it doesn't).
async function pickAddress(addresses, port, probe) {
  const results = await Promise.all(addresses.map((host) => probe(host, port, 3000).then((ok) => ok && host)));

  return results.find(Boolean) || addresses[0];
}

// Bytes done so far, from the engine's per-chunk and per-file events. A
// file's count is replaced by its size on file_complete, so chunks
// re-sent after a resume can't push it past 100%.
function progressTracker(total) {
  const perFile = new Map();

  return (event) => {
    if (event.event === "chunk_verified")
      perFile.set(event.relPath, (perFile.get(event.relPath) || 0) + (Number(event.bytes) || 0));
    else if (event.event === "file_complete")
      perFile.set(event.relPath, Number(event.bytes) || 0);
    else
      return null;

    let bytes = 0;

    for (const n of perFile.values())
      bytes += n;

    return { bytes: Math.min(bytes, total), total };
  };
}

const isTransferId = (id) => typeof id === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(id);

// identity     loadIdentity() result
// contacts     openContacts() store; only paired contacts can offer/accept
// sendEnvelope (envelope) => Promise — usually mailboxClient.send
// engine       { senderPath, receiverPath }
// relayUrl     ws(s)://.../v1/connect, or null for direct only
// onUpdate     (transfer) => void, called with a snapshot on every change
function createTransferManager({ identity, contacts, sendEnvelope, engine, relayUrl = null, onUpdate = () => {}, probe = probeTcp }) {
  const transfers = new Map(); // transferId -> state
  const waiters = new Map(); // transferId -> { resolve, reject, timer }
  const receivers = new Map(); // transferId -> engine handle, while receiving

  const snapshot = (t) => ({ ...t, files: t.files && [...t.files] });

  function update(t, changes) {
    Object.assign(t, changes);
    onUpdate(snapshot(t));
  }

  function sendTo(fp, payload) {
    return sendEnvelope(seal({ identity, recipient: contacts.card(fp), payload }));
  }

  const relayFor = (transferId, role, peerFingerprint) =>
    relayUrl
      ? {
          getTicket: async () => ({
            url: relayUrl,
            ticket: issueDeviceTicket({ sessionId: transferId, role, peerFingerprint, certPem: identity.certPem, keyPem: identity.keyPem }),
          }),
        }
      : null;

  const identityArgs = () => ["--cert", identity.certPath, "--key", identity.keyPath];

  // Sender: offer, wait for an answer, then run the engine.
  async function send(peerFingerprint, paths) {
    const contact = contacts.get(peerFingerprint);

    if (!contact || contact.status !== "paired")
      throw new Error("can only send to a paired contact");

    if (!paths.length)
      throw new Error("nothing to send");

    const transferId = crypto.randomBytes(12).toString("base64url");
    const summary = summarize(paths);
    const t = { transferId, direction: "out", peer: peerFingerprint, peerName: contact.name, ...summary, state: "offered", createdAt: Date.now() };

    transfers.set(transferId, t);
    onUpdate(snapshot(t));

    let answer;

    try {
      const answered = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiters.delete(transferId);
          reject(Object.assign(new Error("no answer from the other device"), { code: "timed_out" }));
        }, OFFER_TIMEOUT_MS);

        waiters.set(transferId, { resolve, reject, timer });
      });

      await sendTo(peerFingerprint, { type: "offer", transferId, ...summary });
      answer = await answered;
    } catch (err) {
      waiters.get(transferId) && clearTimeout(waiters.get(transferId).timer);
      waiters.delete(transferId);

      if (err.code === "timed_out")
        sendTo(peerFingerprint, { type: "cancel", transferId }).catch(() => {});

      update(t, { state: err.code === "timed_out" ? "timed_out" : err.code === "cancelled" ? "cancelled" : "failed", error: err.message });
      return snapshot(t);
    }

    if (answer.type === "decline") {
      update(t, { state: "declined" });
      return snapshot(t);
    }

    update(t, { state: "sending" });

    const track = progressTracker(t.totalBytes);

    let outcome;

    try {
      const host = await pickAddress(answer.addresses, answer.port, probe);

      outcome = await runSender({
        exePath: engine.senderPath,
        baseArgs: ["--token", answer.token, "--transfer-id", transferId, ...identityArgs(), "--pin-sha256", peerFingerprint, ...paths],
        target: { host, port: answer.port },
        relay: answer.relay ? relayFor(transferId, "sender", peerFingerprint) : null,
        probe,
        onPath: (p) => update(t, { path: p }),
        onEvent: (event) => {
          const progress = track(event);

          if (progress)
            update(t, { progress });
        },
        onRetry: ({ attempt, reason }) => update(t, { retry: { attempt, reason } }),
      });
    } catch (err) {
      outcome = { error: err.message };
    }

    const ok = outcome.finalEvent?.event === "transfer_complete";

    // The receiver would otherwise keep listening until its own timeout.
    if (!ok)
      sendTo(peerFingerprint, { type: "cancel", transferId }).catch(() => {});

    update(t, { state: ok ? "complete" : "failed", error: ok ? undefined : outcome.error ?? outcome.finalEvent.reason, path: outcome.path });

    return snapshot(t);
  }

  // Receiver: start the engine, tell the sender where it is, wait for it.
  async function accept(transferId, outputDir) {
    const t = transfers.get(transferId);

    if (!t || t.direction !== "in" || t.state !== "offered")
      throw new Error("no such pending offer");

    const token = crypto.randomBytes(24).toString("hex");
    const port = await findFreePort();

    fs.mkdirSync(outputDir, { recursive: true });
    update(t, { state: "receiving", outputDir });

    const args = [
      "-p", String(port),
      "-o", outputDir,
      "--token", token,
      "--transfer-id", transferId,
      ...identityArgs(),
      "--peer-sha256", t.peer,
      "--max-retries", String(RECEIVER_MAX_RETRIES),
      "--listen-timeout", String(RECEIVER_LISTEN_TIMEOUT_SEC),
    ];

    const track = progressTracker(t.totalBytes);
    let onListening;
    const listening = new Promise((resolve, reject) => (onListening = { resolve, reject }));
    const finished = runEngineOnce(engine.receiverPath, args, (event) => {
      if (event.event === "listening")
        onListening.resolve(event);

      const progress = track(event);

      if (progress)
        update(t, { progress });
    }, (handle) => receivers.set(transferId, handle));

    finished.catch((err) => onListening.reject(err));

    let bridge = null;
    let finalEvent;

    try {
      await listening;

      const relay = relayFor(transferId, "receiver", t.peer);

      if (relay)
        bridge = startReceiverBridge({ getTicket: relay.getTicket, enginePort: port });

      await sendTo(t.peer, { type: "accept", transferId, token, port, addresses: localAddresses(), relay: Boolean(relay) });
      finalEvent = await finished;
    } catch (err) {
      receivers.get(transferId)?.kill();
      update(t, t.state === "cancelled" ? {} : { state: "failed", error: err.message });
      return snapshot(t);
    } finally {
      receivers.delete(transferId);
      bridge?.stop();
    }

    const ok = finalEvent.event === "transfer_complete";

    update(t, { state: ok ? "complete" : "failed", error: ok ? undefined : finalEvent.reason });

    return snapshot(t);
  }

  async function decline(transferId) {
    const t = transfers.get(transferId);

    if (!t || t.direction !== "in" || t.state !== "offered")
      throw new Error("no such pending offer");

    update(t, { state: "declined" });
    await sendTo(t.peer, { type: "decline", transferId });
  }

  // Feed every opened envelope here. Returns true if it was a transfer
  // message (handled or deliberately ignored), false otherwise.
  function handleEnvelope({ from, payload }) {
    if (!["offer", "accept", "decline", "cancel"].includes(payload?.type))
      return false;

    const contact = contacts.get(from);

    if (!contact || contact.status !== "paired" || !isTransferId(payload.transferId))
      return true;

    const t = transfers.get(payload.transferId);

    switch (payload.type) {
      case "offer": {
        if (t)
          return true; // redelivery

        const offer = {
          transferId: payload.transferId,
          direction: "in",
          peer: from,
          peerName: contact.name,
          files: Array.isArray(payload.files) ? payload.files.slice(0, MAX_OFFER_NAMES).map((f) => ({ name: String(f?.name ?? "").slice(0, 255), size: Number(f?.size) || 0, files: Number(f?.files) || 0 })) : [],
          fileCount: Number(payload.fileCount) || 0,
          totalBytes: Number(payload.totalBytes) || 0,
          state: "offered",
          createdAt: Date.now(),
        };

        transfers.set(offer.transferId, offer);
        onUpdate(snapshot(offer));
        return true;
      }

      case "accept":
      case "decline": {
        const waiter = waiters.get(payload.transferId);

        // Only the device we offered to can answer.
        if (!t || t.direction !== "out" || t.peer !== from || !waiter)
          return true;

        if (payload.type === "accept") {
          const port = Number(payload.port);
          const addresses = Array.isArray(payload.addresses) ? payload.addresses.filter((a) => typeof a === "string" && net.isIP(a)).slice(0, 16) : [];

          if (!Number.isInteger(port) || port < 1 || port > 65535 || typeof payload.token !== "string" || payload.token.length > 63 || (!addresses.length && !payload.relay))
            return true;

          if (!addresses.length)
            addresses.push("127.0.0.1");

          clearTimeout(waiter.timer);
          waiters.delete(payload.transferId);
          waiter.resolve({ type: "accept", token: payload.token, port, addresses, relay: Boolean(payload.relay) });
        } else {
          clearTimeout(waiter.timer);
          waiters.delete(payload.transferId);
          waiter.resolve({ type: "decline" });
        }

        return true;
      }

      case "cancel":
        if (!t || t.direction !== "in" || t.peer !== from)
          return true;

        if (t.state === "offered")
          update(t, { state: "cancelled" });
        else if (t.state === "receiving") {
          // The sender gave up; stop listening for it. accept() then
          // sees the engine exit and keeps this state.
          update(t, { state: "cancelled", error: "the sender stopped the transfer" });
          receivers.get(t.transferId)?.kill();
        }

        return true;
    }

    return true;
  }

  // Sender gives up waiting for an answer.
  function cancelOffer(transferId) {
    const waiter = waiters.get(transferId);
    const t = transfers.get(transferId);

    if (!waiter || !t)
      return false;

    clearTimeout(waiter.timer);
    waiters.delete(transferId);
    sendTo(t.peer, { type: "cancel", transferId }).catch(() => {});
    waiter.reject(Object.assign(new Error("cancelled"), { code: "cancelled" }));

    return true;
  }

  return {
    send,
    accept,
    decline,
    cancelOffer,
    handleEnvelope,
    list: () => [...transfers.values()].map(snapshot),
    get: (id) => (transfers.has(id) ? snapshot(transfers.get(id)) : null),
  };
}

module.exports = { createTransferManager, OFFER_TIMEOUT_MS };
