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
const { issueDeviceTicket, makeMessage, parseMessage, MAX_OFFER_NAMES } = require("peerpayload-protocol");

const { seal } = require("./envelope");

// Connect file transfers between paired devices. The negotiation travels
// as envelopes through the mailbox (message formats: protocol/messages.js):
//
//   sender   -> offer (resume: true to continue an interrupted one)
//   receiver -> accept (where to connect, engine token) | decline
//   sender   -> cancel (gave up: before the receiver answered, or after
//                       the transfer itself failed)
//   either   -> cancel { paused: true } (stopped a running transfer; it
//                       stays resumable)
//   either   -> cancel { removed: true } (deleted it, or never had it: the
//                       other side ends its copy for good)
//   receiver -> resume-request (asks the sender for a resume offer; one
//                       nobody answers goes back to interrupted)
//
// The bytes then go engine to engine, mutually authenticated with the two
// device certificates: the sender pins the receiver's device ID, and the
// receiver admits only the sender's. Direct when an advertised address
// answers, otherwise through the relay with device-signed tickets. The
// engine token travels only inside the encrypted accept envelope.
//
// History is kept in <identity dir>/transfers.json, so it survives a
// restart; a transfer that was running when the app stopped comes back as
// "interrupted" and can be resumed from either side. Each incoming
// transfer is received into its own staging folder (<downloads>/.incoming/
// <id>), where the engine keeps its resume state, and its files move into
// the downloads folder only once complete.

// How long a sender waits for the other device to answer an offer.
const OFFER_TIMEOUT_MS = 10 * 60 * 1000;

// The engine's 64 KiB default spends most of its time waiting on per-chunk
// acks: Connect measured 12-17 MiB/s direct with it, against 90-115 MiB/s
// at 1 MiB (about a full gigabit LAN). 1 MiB keeps the sender's memory
// small (16 chunks in flight = 16 MiB) and resume steps fine-grained;
// 8 MiB is faster still only above gigabit. Over the internet the
// connection's own bandwidth is the limit either way.
const CHUNK_SIZE = 1024 * 1024;

// History kept on disk, newest first.
const MAX_HISTORY = 200;

const ACTIVE_STATES = new Set(["offered", "sending", "receiving"]);

// Fields saved to disk. Progress is left out (it changes constantly and
// is recomputed), and so is anything secret: the engine token is never
// stored on a record.
const STORED_FIELDS = [
  "transferId", "direction", "peer", "peerName", "files", "fileCount", "totalBytes", "state", "error",
  "createdAt", "updatedAt", "started", "ended", "path", "paths", "downloadDir", "stagingDir", "savedAs",
];

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

// Bytes done so far, from the engine's events. A resumed file starts at
// the bytes already on disk (file_start's resumeChunk x the session's chunk
// size); a file's count is replaced by its size on file_complete, so
// nothing can push it past 100%. `resumedBytes` is how much was already
// there when this attempt began.
function progressTracker(total) {
  const perFile = new Map();
  let chunkSize = 0;
  let resumedBytes = 0;

  return (event) => {
    if (event.event === "session_start") {
      chunkSize = Number(event.chunkSize) || 0;
      return null;
    }

    if (event.event === "file_start") {
      const already = Math.min((Number(event.resumeChunk) || 0) * chunkSize, Number(event.fileSize) || 0);

      perFile.set(event.relPath, already);
      resumedBytes += already;
    } else if (event.event === "chunk_verified")
      perFile.set(event.relPath, (perFile.get(event.relPath) || 0) + (Number(event.bytes) || 0));
    else if (event.event === "file_complete")
      perFile.set(event.relPath, Number(event.bytes) || 0);
    else
      return null;

    let bytes = 0;

    for (const n of perFile.values())
      bytes += n;

    return { bytes: Math.min(bytes, total), total, resumedBytes };
  };
}

// A name in `dir` that doesn't exist yet: "report.pdf", "report (2).pdf", ...
function freeName(dir, name) {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);

  for (let n = 1; ; n++) {
    const candidate = n === 1 ? name : `${stem} (${n})${ext}`;

    if (!fs.existsSync(path.join(dir, candidate)))
      return candidate;
  }
}

// Moves a finished transfer's files out of its staging folder into the
// downloads folder, renaming on clashes. Returns the names they got.
function deliver(stagingDir, downloadDir) {
  const saved = [];

  for (const entry of fs.readdirSync(stagingDir)) {
    if (entry === "transfer.state" || entry === "transfer.state.tmp")
      continue;

    const name = freeName(downloadDir, entry);

    fs.renameSync(path.join(stagingDir, entry), path.join(downloadDir, name));
    saved.push(name);
  }

  fs.rmSync(stagingDir, { recursive: true, force: true });

  return saved;
}

// identity     loadIdentity() result (identity.dir also holds the history)
// contacts     openContacts() store; only paired contacts can offer/accept
// sendEnvelope (envelope) => Promise — usually mailboxClient.send
// engine       { senderPath, receiverPath }
// relayUrl     ws(s)://.../v1/connect, or null for direct only
// onUpdate     (transfer) => void, called with a snapshot on every change
// log          (message) => void
function createTransferManager({
  identity,
  contacts,
  sendEnvelope,
  engine,
  relayUrl = null,
  onUpdate = () => {},
  onRemove = () => {},
  log = () => {},
  probe = probeTcp,
  historyFile = path.join(identity.dir, "transfers.json"),
  offerTimeoutMs = OFFER_TIMEOUT_MS,
}) {
  const transfers = new Map(); // transferId -> record
  const waiters = new Map(); // transferId -> { resolve, reject, timer }
  const receivers = new Map(); // transferId -> engine handle, while receiving
  const senders = new Map(); // transferId -> engine handle, while sending
  const pausing = new Set(); // transferIds being paused (their engine exit isn't a failure)
  const resumeTimers = new Map(); // transferId -> timer, while a resume-request waits

  // Can be picked up again: it got going (accepted) but didn't finish, and
  // nobody said no or removed it.
  const resumable = (t) => Boolean(t.started) && !t.ended && ["failed", "cancelled", "interrupted", "waiting"].includes(t.state);

  const snapshot = (t) => ({ ...t, files: t.files && [...t.files], resumable: resumable(t) });

  // ---- history on disk ----

  function load() {
    let records = [];

    try {
      records = JSON.parse(fs.readFileSync(historyFile, "utf8"));
    } catch {
      return; // none yet, or unreadable: start empty
    }

    for (const r of Array.isArray(records) ? records : []) {
      if (!r?.transferId)
        continue;

      // The app stopped while this was going.
      if (ACTIVE_STATES.has(r.state) || r.state === "waiting")
        Object.assign(r, { state: "interrupted", error: "PeerPayload Connect was closed during the transfer" });

      transfers.set(r.transferId, r);
    }
  }

  function save() {
    const records = [...transfers.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, MAX_HISTORY)
      .map((t) => Object.fromEntries(STORED_FIELDS.filter((k) => t[k] !== undefined).map((k) => [k, t[k]])));
    const tmp = `${historyFile}.tmp`;

    try {
      fs.writeFileSync(tmp, JSON.stringify(records, null, 1));
      fs.renameSync(tmp, historyFile);
    } catch (err) {
      log(`couldn't save transfer history: ${err.message}`);
    }
  }

  function update(t, changes) {
    Object.assign(t, changes, { updatedAt: Date.now() });

    // Progress ticks aren't worth a disk write each.
    if (!(Object.keys(changes).length === 1 && "progress" in changes))
      save();

    onUpdate(snapshot(t));
  }

  function add(t) {
    t.updatedAt = Date.now();
    transfers.set(t.transferId, t);
    save();
    onUpdate(snapshot(t));
  }

  load();

  // ---- helpers ----

  function sendTo(fp, type, fields) {
    return sendEnvelope(seal({ identity, recipient: contacts.card(fp), payload: makeMessage(type, fields) }));
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

  function requirePaired(fp) {
    const contact = contacts.get(fp);

    if (!contact || contact.status !== "paired")
      throw new Error("can only send to a paired contact");

    return contact;
  }

  // ---- sender ----

  // Offer, wait for an answer, then run the engine. `resume` marks the
  // offer as continuing an earlier attempt of the same transfer.
  async function runOutgoing(t, { resume }) {
    let answer;

    try {
      const answered = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiters.delete(t.transferId);
          reject(Object.assign(new Error("no answer from the other device"), { code: "timed_out" }));
        }, offerTimeoutMs);

        waiters.set(t.transferId, { resolve, reject, timer });
      });

      await sendTo(t.peer, "offer", {
        transferId: t.transferId,
        files: t.files,
        fileCount: t.fileCount,
        totalBytes: t.totalBytes,
        ...(resume && { resume: true }),
      });
      answer = await answered;
    } catch (err) {
      waiters.get(t.transferId) && clearTimeout(waiters.get(t.transferId).timer);
      waiters.delete(t.transferId);

      // Ended for good meanwhile (the other side removed it): keep that.
      if (t.ended)
        return snapshot(t);

      if (err.code === "timed_out")
        sendTo(t.peer, "cancel", { transferId: t.transferId }).catch(() => {});

      // A resume that wasn't answered leaves the transfer resumable.
      const state = resume ? "interrupted" : err.code === "timed_out" ? "timed_out" : err.code === "cancelled" ? "cancelled" : "failed";

      update(t, { state, error: err.message });
      return snapshot(t);
    }

    if (answer.type === "decline") {
      update(t, { state: "declined", error: undefined });
      return snapshot(t);
    }

    update(t, { state: "sending", started: true, error: undefined, retry: undefined });

    const track = progressTracker(t.totalBytes);
    let outcome;

    try {
      const host = await pickAddress(answer.addresses, answer.port, probe);

      outcome = await runSender({
        exePath: engine.senderPath,
        baseArgs: ["--token", answer.token, "--transfer-id", t.transferId, "--chunk-size", String(CHUNK_SIZE), ...identityArgs(), "--pin-sha256", t.peer, ...t.paths],
        target: { host, port: answer.port },
        relay: answer.relay ? relayFor(t.transferId, "sender", t.peer) : null,
        probe,
        onPath: (p) => update(t, { path: p }),
        onEvent: (event) => {
          const progress = track(event);

          if (progress)
            update(t, { progress });
        },
        onRetry: ({ attempt, reason }) => update(t, { retry: { attempt, reason } }),
        onSpawn: (handle) => senders.set(t.transferId, handle),
      });
    } catch (err) {
      outcome = { error: err.message };
    } finally {
      senders.delete(t.transferId);
    }

    if (pausing.delete(t.transferId)) {
      update(t, { state: "interrupted", error: t.error ?? "paused", retry: undefined });
      return snapshot(t);
    }

    const ok = outcome.finalEvent?.event === "transfer_complete";

    if (t.ended && !ok)
      return snapshot(t);

    // The receiver would otherwise keep listening until its own timeout.
    if (!ok)
      sendTo(t.peer, "cancel", { transferId: t.transferId }).catch(() => {});

    update(t, {
      state: ok ? "complete" : "failed",
      error: ok ? undefined : outcome.error ?? outcome.finalEvent.reason,
      path: outcome.path ?? t.path,
      retry: undefined,
      ...(ok && { progress: { ...t.progress, bytes: t.totalBytes, total: t.totalBytes } }),
    });

    return snapshot(t);
  }

  async function send(peerFingerprint, paths) {
    const contact = requirePaired(peerFingerprint);

    if (!paths.length)
      throw new Error("nothing to send");

    const absolute = paths.map((p) => path.resolve(p));
    const t = {
      transferId: crypto.randomBytes(12).toString("base64url"),
      direction: "out",
      peer: peerFingerprint,
      peerName: contact.name,
      ...summarize(absolute),
      paths: absolute,
      state: "offered",
      createdAt: Date.now(),
    };

    add(t);

    return runOutgoing(t, { resume: false });
  }

  // ---- receiver ----

  // Start the engine, tell the sender where it is, wait for it. The first
  // accept fixes the staging folder; a resume reuses it, so the engine
  // continues from its saved state there.
  async function accept(transferId, downloadDir) {
    const t = transfers.get(transferId);

    if (!t || t.direction !== "in" || t.state !== "offered")
      throw new Error("no such pending offer");

    const target = t.downloadDir ?? downloadDir;

    if (!target)
      throw new Error("no folder to receive into");

    const stagingDir = t.stagingDir ?? path.join(target, ".incoming", transferId);
    const token = crypto.randomBytes(24).toString("hex");
    const port = await findFreePort();

    fs.mkdirSync(stagingDir, { recursive: true });
    update(t, { state: "receiving", started: true, downloadDir: target, stagingDir, error: undefined });

    const args = [
      "-p", String(port),
      "-o", stagingDir,
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
        bridge = startReceiverBridge({
          getTicket: relay.getTicket,
          enginePort: port,
          // The sender couldn't reach this device directly (see TransferRow's hint).
          onPaired: () => t.path !== "relay" && update(t, { path: "relay" }),
        });

      await sendTo(t.peer, "accept", { transferId, token, port, addresses: localAddresses(), relay: Boolean(relay) });
      finalEvent = await finished;
    } catch (err) {
      receivers.get(transferId)?.kill();

      if (pausing.delete(transferId))
        update(t, { state: "interrupted", error: t.error ?? "paused" });
      else if (t.state !== "cancelled" && !t.ended)
        update(t, { state: "failed", error: err.message });

      return snapshot(t);
    } finally {
      receivers.delete(transferId);
      bridge?.stop();
    }

    if (finalEvent.event !== "transfer_complete") {
      if (!t.ended)
        update(t, { state: "failed", error: finalEvent.reason });
      return snapshot(t);
    }

    try {
      const savedAs = deliver(stagingDir, target);

      update(t, { state: "complete", savedAs, stagingDir: undefined, progress: { ...t.progress, bytes: t.totalBytes, total: t.totalBytes } });
    } catch (err) {
      // Received fine, but couldn't be moved: say where the files are.
      update(t, { state: "failed", error: `received, but couldn't move the files out of ${stagingDir}: ${err.message}` });
    }

    return snapshot(t);
  }

  async function decline(transferId) {
    const t = transfers.get(transferId);

    if (!t || t.direction !== "in" || t.state !== "offered")
      throw new Error("no such pending offer");

    update(t, { state: "declined" });
    await sendTo(t.peer, "decline", { transferId });
  }

  // ---- pause / resume ----

  // Stops a running transfer on both sides, leaving it resumable. `by` is
  // who asked, for the message shown.
  function stopRunning(t, by) {
    const handle = t.direction === "out" ? senders.get(t.transferId) : receivers.get(t.transferId);

    if (!handle)
      return false;

    pausing.add(t.transferId);
    t.error = by;
    handle.kill();

    return true;
  }

  function pause(transferId) {
    const t = transfers.get(transferId);

    if (!t || !(t.state === "sending" || t.state === "receiving"))
      throw new Error("only a running transfer can be paused");

    sendTo(t.peer, "cancel", { transferId, paused: true }).catch(() => {});

    if (!stopRunning(t, "paused"))
      throw new Error("this transfer isn't running here");

    return snapshot(t);
  }

  // Picks an interrupted transfer up again. The sender re-offers it; the
  // receiver asks the sender to.
  async function resume(transferId) {
    const t = transfers.get(transferId);

    if (!t || !resumable(t))
      throw new Error("this transfer can't be resumed");

    requirePaired(t.peer);

    if (t.direction === "out") {
      const missing = t.paths.find((p) => !fs.existsSync(p));

      if (missing)
        throw new Error(`${missing} is no longer there, so this can't be resumed; send it again`);

      update(t, { state: "offered", error: undefined });

      return runOutgoing(t, { resume: true });
    }

    update(t, { state: "waiting", error: undefined });
    clearTimeout(resumeTimers.get(transferId));
    resumeTimers.set(transferId, setTimeout(() => {
      resumeTimers.delete(transferId);

      if (t.state === "waiting")
        update(t, { state: "interrupted", error: `no answer from ${t.peerName}; try again when it's online` });
    }, offerTimeoutMs));
    await sendTo(t.peer, "resume-request", { transferId });

    return snapshot(t);
  }

  // ---- incoming messages ----

  // Feed every opened envelope here. Returns true if it was a transfer
  // message (handled or deliberately ignored), false otherwise.
  function handleEnvelope({ from, payload }) {
    if (!["offer", "accept", "decline", "cancel", "resume-request"].includes(payload?.type))
      return false;

    const message = parseMessage(payload);
    const contact = contacts.get(from);

    if (!message || !contact || contact.status !== "paired")
      return true;

    const t = transfers.get(message.transferId);

    switch (message.type) {
      case "offer": {
        if (t) {
          // The sender resuming something we already accepted: accept
          // again into the same staging folder, without asking.
          if (message.resume && t.direction === "in" && t.peer === from && resumable(t)) {
            clearTimeout(resumeTimers.get(t.transferId));
            resumeTimers.delete(t.transferId);
            update(t, { state: "offered" });
            accept(t.transferId).catch((err) => log(`resuming ${t.transferId} failed: ${err.message}`));
          }

          return true; // otherwise a redelivery
        }

        add({
          transferId: message.transferId,
          direction: "in",
          peer: from,
          peerName: contact.name,
          files: message.files,
          fileCount: message.fileCount,
          totalBytes: message.totalBytes,
          state: "offered",
          createdAt: Date.now(),
        });
        return true;
      }

      case "accept":
      case "decline": {
        const waiter = waiters.get(message.transferId);

        // Only the device we offered to can answer.
        if (!t || t.direction !== "out" || t.peer !== from || !waiter)
          return true;

        // A relay-only answer has no address to try directly; give the
        // sender's probe one that fails fast.
        if (message.type === "accept" && !message.addresses.length)
          message.addresses.push("127.0.0.1");

        clearTimeout(waiter.timer);
        waiters.delete(message.transferId);
        waiter.resolve(message);

        return true;
      }

      case "cancel":
        if (!t || t.peer !== from)
          return true;

        // The other side paused: stop our engine too, resumable.
        if (message.paused && (t.state === "sending" || t.state === "receiving")) {
          stopRunning(t, `paused by ${t.peerName}`);
          return true;
        }

        // The other side deleted it: nothing left to resume from.
        if (message.removed) {
          if (t.state !== "complete")
            endForGood(t, `${t.peerName} removed this transfer`);

          return true;
        }

        if (t.direction !== "in")
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

      case "resume-request":
        if (t && t.direction === "out" && t.peer === from && resumable(t))
          resume(t.transferId).catch((err) => log(`resume of ${t.transferId} requested, but: ${err.message}`));
        // Deleted here (or finished, or never ours): say so, or the other
        // side waits for an offer that will never come.
        else if (!t || (t.peer === from && t.direction === "out"))
          sendTo(from, "cancel", { transferId: message.transferId, removed: true }).catch(() => {});

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
    sendTo(t.peer, "cancel", { transferId }).catch(() => {});
    waiter.reject(Object.assign(new Error("cancelled"), { code: "cancelled" }));

    return true;
  }

  // Ends a transfer for good: stops whatever is running for it and marks
  // it not resumable.
  function endForGood(t, reason) {
    const waiter = waiters.get(t.transferId);

    clearTimeout(resumeTimers.get(t.transferId));
    resumeTimers.delete(t.transferId);

    if (waiter) {
      clearTimeout(waiter.timer);
      waiters.delete(t.transferId);
      waiter.reject(Object.assign(new Error(reason), { code: "cancelled" }));
    }

    update(t, { state: "cancelled", ended: true, error: reason });
    (senders.get(t.transferId) ?? receivers.get(t.transferId))?.kill();
  }

  // Deletes one transfer that isn't running: its record, and for an
  // incoming one the partly received files. Tells the other device, unless
  // it finished, so it doesn't keep it waiting to be resumed.
  function forget(transferId) {
    const t = transfers.get(transferId);

    if (!t)
      return false;

    if (ACTIVE_STATES.has(t.state))
      throw new Error("stop the transfer first");

    if (!["complete", "declined"].includes(t.state) && contacts.get(t.peer))
      sendTo(t.peer, "cancel", { transferId, removed: true }).catch(() => {});

    clearTimeout(resumeTimers.get(transferId));
    resumeTimers.delete(transferId);

    if (t.direction === "in" && t.stagingDir)
      fs.rmSync(t.stagingDir, { recursive: true, force: true });

    transfers.delete(transferId);
    save();
    onRemove(transferId);

    return true;
  }

  // Forgets finished transfers (not ones that are running or resumable).
  function clearFinished() {
    for (const [id, t] of transfers)
      if (!ACTIVE_STATES.has(t.state) && !resumable(t))
        transfers.delete(id);

    save();
  }

  return {
    send,
    accept,
    decline,
    pause,
    resume,
    cancelOffer,
    clearFinished,
    forget,
    handleEnvelope,
    list: () => [...transfers.values()].sort((a, b) => b.createdAt - a.createdAt).map(snapshot),
    get: (id) => (transfers.has(id) ? snapshot(transfers.get(id)) : null),
  };
}

module.exports = { createTransferManager, OFFER_TIMEOUT_MS };
