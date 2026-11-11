const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { createConnectNode } = require("..");
const { createTransferManager } = require("../transfers");
const { createMailbox } = require("../../mailbox/src/server");

// Transfer history that survives a restart, and pausing/resuming a
// transfer from either side so it continues where it stopped.

const repo = path.resolve(__dirname, "..", "..", "..");
const exe = process.platform === "win32" ? ".exe" : "";
const engine = {
  senderPath: path.join(repo, "build", "sender", `sender${exe}`),
  receiverPath: path.join(repo, "build", "receiver", `receiver${exe}`),
};
const keygenPath = path.join(repo, "build", "engine", `ppkeygen${exe}`);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pp-connect-resume-"));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (what, fn, ms = 30000) => {
  const end = Date.now() + ms;
  while (!(await fn())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
};
const sha = (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");

let mailbox, mailboxUrl, bigFile;

before(async () => {
  for (const p of [engine.senderPath, engine.receiverPath, keygenPath])
    assert.ok(fs.existsSync(p), `build the engine first (${p})`);

  mailbox = createMailbox({ log: { warn() {} } });
  mailboxUrl = `http://127.0.0.1:${await mailbox.listen(0, "127.0.0.1")}`;

  // Big enough that a pause lands mid-transfer even at full local speed.
  bigFile = path.join(tmp, "video.bin");
  const fd = fs.openSync(bigFile, "w");
  const block = crypto.randomBytes(1024 * 1024);
  for (let i = 0; i < 384; i++) fs.writeSync(fd, block);
  fs.closeSync(fd);
});

after(async () => {
  await mailbox.close();
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

// A device as an app runs it; `start` again with the same name = a restart.
function device(t, name) {
  const n = createConnectNode({ dir: path.join(tmp, name), keygenPath, engine, mailboxUrl });
  n.latest = new Map();
  n.on("transfer", (x) => n.latest.set(x.transferId, x));
  t.after(() => n.stop());
  return n;
}

async function pairedDevices(t, a, b) {
  const alice = device(t, a);
  const bob = device(t, b);
  alice.setup(a);
  bob.setup(b);
  await until("mailbox", () => alice.status().connected && bob.status().connected);
  await bob.addContact(alice.createInvite().link);
  await until("pairing", () => alice.contacts()[0]?.status === "paired" && bob.contacts()[0]?.status === "paired");
  return { alice, bob };
}

// Bob sends the big file; Alice accepts into her downloads and the
// transfer is paused (by `pauser`) once some of it has arrived.
async function startThenPause(alice, bob, pauser) {
  const downloads = path.join(tmp, `${alice.status().name}-downloads`);
  const sending = bob.send(alice.status().fingerprint, [bigFile]);
  await until("offer", () => [...alice.latest.values()].some((x) => x.state === "offered"));
  const id = [...alice.latest.values()].find((x) => x.state === "offered").transferId;
  const receiving = alice.accept(id, downloads);

  await until("some progress", () => (alice.latest.get(id).progress?.bytes ?? 0) >= 8 * 1024 * 1024);
  (pauser === "sender" ? bob : alice).pause(id);

  const [sent, received] = await Promise.all([sending, receiving]);
  return { id, downloads, sent, received };
}

test("resume: pause from the sender, resume from the receiver, continues where it stopped", async (t) => {
  const { alice, bob } = await pairedDevices(t, "Alice", "Bob");
  const { id, downloads, sent, received } = await startThenPause(alice, bob, "sender");

  assert.equal(sent.state, "interrupted", sent.error);
  assert.equal(sent.error, "paused");
  assert.equal(received.state, "interrupted", received.error);
  assert.equal(received.error, "paused by Bob");
  assert.ok(sent.resumable && received.resumable);
  const partial = received.progress.bytes;
  assert.ok(partial > 0 && partial < received.totalBytes, `paused mid-transfer (${partial} bytes)`);
  assert.ok(!fs.existsSync(path.join(downloads, "video.bin")), "nothing unfinished in Downloads");
  assert.ok(fs.existsSync(path.join(received.stagingDir, "transfer.state")), "engine's resume state is kept in the staging folder");

  // Alice asks Bob to resume; Bob re-offers, Alice accepts without asking.
  await alice.resume(id);
  await until("complete on both sides", () => alice.latest.get(id).state === "complete" && bob.latest.get(id).state === "complete", 60000);

  const done = alice.latest.get(id);
  assert.ok(done.progress.resumedBytes > 0, "the second attempt started from the bytes already there, not from zero");
  assert.equal(sha(path.join(downloads, "video.bin")), sha(bigFile));
  assert.deepEqual(done.savedAs, ["video.bin"]);
  assert.ok(!fs.existsSync(path.join(downloads, ".incoming", id)), "staging folder removed");
});

test("resume: pause from the receiver, resume from the sender after both restart", async (t) => {
  let { alice, bob } = await pairedDevices(t, "Carol", "Dan");
  const { id, downloads, sent, received } = await startThenPause(alice, bob, "receiver");

  assert.equal(received.state, "interrupted", received.error);
  assert.equal(sent.state, "interrupted", sent.error);
  assert.equal(sent.error, "paused by Carol");

  // Both apps restart: history comes back from disk.
  alice.stop();
  bob.stop();
  alice = device(t, "Carol");
  bob = device(t, "Dan");
  await until("mailbox again", () => alice.status().connected && bob.status().connected);
  const remembered = bob.transfers().find((x) => x.transferId === id);
  assert.equal(remembered.state, "interrupted");
  assert.equal(remembered.resumable, true);
  assert.equal(alice.transfers().find((x) => x.transferId === id).resumable, true);

  await bob.resume(id);
  await until("complete on both sides", () => alice.latest.get(id)?.state === "complete" && bob.latest.get(id)?.state === "complete", 60000);
  assert.ok(alice.latest.get(id).progress.resumedBytes > 0);
  assert.equal(sha(path.join(downloads, "video.bin")), sha(bigFile));
});

test("history: transfers running when the app stopped come back as interrupted; finished ones can be cleared", () => {
  const dir = path.join(tmp, "history-unit");
  fs.mkdirSync(dir, { recursive: true });
  const record = (id, state, extra = {}) => ({ transferId: id, direction: "out", peer: "f".repeat(64), peerName: "X", files: [], fileCount: 1, totalBytes: 10, state, createdAt: Date.now(), ...extra });
  fs.writeFileSync(path.join(dir, "transfers.json"), JSON.stringify([
    record("aaaaaaaa1", "sending", { started: true, paths: [__filename] }),
    record("aaaaaaaa2", "complete", { started: true }),
    record("aaaaaaaa3", "declined"),
  ]));

  const manager = createTransferManager({ identity: { dir }, contacts: { get: () => null }, sendEnvelope: async () => {}, engine });
  const byId = Object.fromEntries(manager.list().map((x) => [x.transferId, x]));
  assert.equal(byId.aaaaaaaa1.state, "interrupted");
  assert.equal(byId.aaaaaaaa1.resumable, true);
  assert.equal(byId.aaaaaaaa2.resumable, false);

  manager.clearFinished();
  assert.deepEqual(manager.list().map((x) => x.transferId), ["aaaaaaaa1"], "only the resumable one is kept");
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "transfers.json"), "utf8")).length, 1, "and that's what's on disk");
});

test("resume: both sides tap Resume at once, and it still completes", async (t) => {
  const { alice, bob } = await pairedDevices(t, "Iris", "Jude");
  const { id, downloads } = await startThenPause(alice, bob, "sender");

  // The sender's re-offer and the receiver's resume-request cross in the
  // mailbox: each side gets the other's message mid-resume.
  await Promise.all([bob.resume(id), alice.resume(id)]);
  await until("complete on both sides, or ended", () => {
    const a = alice.latest.get(id);
    const b = bob.latest.get(id);
    return (a.state === "complete" && b.state === "complete") || a.ended || b.ended;
  }, 60000);

  const received = alice.latest.get(id);
  assert.ok(!received.ended, `the receiver's copy was ended: ${received.error}`);
  assert.equal(received.state, "complete", received.error);
  assert.equal(bob.latest.get(id).state, "complete");
  assert.ok(received.progress.resumedBytes > 0, "continued from the bytes already there");
  assert.equal(sha(path.join(downloads, "video.bin")), sha(bigFile));
});

test("resume: a pause that arrives after this side already failed still counts as a pause", () => {
  // Pausing stops that side's engine at once, but the message saying so goes
  // through the mailbox: the dropped connection can win, our side retries,
  // gives up and marks the transfer failed. The late pause then corrects it.
  const dir = path.join(tmp, "late-pause");
  fs.mkdirSync(dir, { recursive: true });
  const peer = "e".repeat(64);
  const base = { direction: "out", peer, peerName: "Phone", files: [], fileCount: 1, totalBytes: 10, createdAt: Date.now(), paths: [__filename] };
  fs.writeFileSync(path.join(dir, "transfers.json"), JSON.stringify([
    { ...base, transferId: "latepause1", state: "failed", started: true, error: "tls_handshake_failed" },
    { ...base, transferId: "latepause2", state: "failed", started: false, error: "connection_failed" },
  ]));

  const manager = createTransferManager({
    identity: { dir },
    contacts: { get: (fp) => (fp === peer ? { fp, name: "Phone", status: "paired" } : null) },
    sendEnvelope: async () => {},
    engine,
  });

  for (const transferId of ["latepause1", "latepause2"])
    assert.equal(manager.handleEnvelope({ from: peer, payload: { type: "cancel", transferId, paused: true } }), true);

  const byId = Object.fromEntries(manager.list().map((x) => [x.transferId, x]));
  assert.equal(byId.latepause1.state, "interrupted");
  assert.equal(byId.latepause1.error, "paused by Phone");
  assert.equal(byId.latepause1.resumable, true);
  // Never got going: nothing was paused, so it stays a failure.
  assert.equal(byId.latepause2.state, "failed");
});

test("resume: the sender removed it, so the receiver's resume ends instead of waiting forever", async (t) => {
  const { alice, bob } = await pairedDevices(t, "Erin", "Frank");
  const { id, received } = await startThenPause(alice, bob, "sender");
  assert.equal(received.resumable, true);

  // Frank deletes his copy; Erin hears about it and can't resume any more.
  assert.equal(bob.forget(id), true);
  assert.equal(bob.transfers().some((x) => x.transferId === id), false);
  await until("Erin's copy ended", () => alice.latest.get(id).ended === true);
  const ended = alice.latest.get(id);
  assert.equal(ended.state, "cancelled");
  assert.equal(ended.resumable, false);
  assert.match(ended.error, /Frank removed this transfer/);

  // And she can delete it, partial files included.
  assert.equal(alice.forget(id), true);
  assert.ok(!fs.existsSync(received.stagingDir), "partly received files deleted");
});

test("resume: asking a sender that no longer has the transfer ends it on this side too", async (t) => {
  const { alice, bob } = await pairedDevices(t, "Gina", "Hal");
  const { id } = await startThenPause(alice, bob, "receiver");

  // Hal's record is gone without telling Gina (an older app, a reinstall):
  // simulate by restarting him with no history.
  bob.stop();
  fs.rmSync(path.join(tmp, "Hal", "transfers.json"));
  const hal = device(t, "Hal");
  await until("Hal back online", () => hal.status().connected);

  await alice.resume(id);
  await until("Gina's copy ended", () => alice.latest.get(id).ended === true);
  assert.equal(alice.latest.get(id).resumable, false);
});

test("history: clearing finished transfers removes their partial files; the sweep removes orphans only", () => {
  const dir = path.join(tmp, "incoming-tidy");
  const downloads = path.join(dir, "downloads");
  const staging = (id) => path.join(downloads, ".incoming", id);
  for (const id of ["endedxxxx1", "pausedxxx2", "orphanxxx3"]) {
    fs.mkdirSync(staging(id), { recursive: true });
    fs.writeFileSync(path.join(staging(id), "part.bin"), "x");
  }
  fs.mkdirSync(path.join(downloads, ".incoming", "not an id"), { recursive: true });
  const record = (id, state, extra) => ({ transferId: id, direction: "in", peer: "f".repeat(64), peerName: "X", files: [], fileCount: 1, totalBytes: 10, createdAt: 1, started: true, stagingDir: staging(id), state, ...extra });
  fs.writeFileSync(path.join(dir, "transfers.json"), JSON.stringify([
    record("endedxxxx1", "cancelled", { ended: true }),
    record("pausedxxx2", "interrupted"),
  ]));

  const manager = createTransferManager({ identity: { dir }, contacts: { get: () => null }, sendEnvelope: async () => {}, engine });

  manager.clearFinished();
  assert.equal(fs.existsSync(staging("endedxxxx1")), false, "a cleared transfer's partial files go too");
  assert.equal(fs.existsSync(staging("pausedxxx2")), true, "a resumable one keeps them");

  assert.deepEqual(manager.sweepIncoming(downloads), ["orphanxxx3"]);
  assert.equal(fs.existsSync(staging("pausedxxx2")), true, "in use: kept");
  assert.equal(fs.existsSync(path.join(downloads, ".incoming", "not an id")), true, "not named like a transfer: left alone");
  assert.deepEqual(manager.sweepIncoming(path.join(dir, "nowhere")), []);
});

test("resume: a resume request nobody answers goes back to interrupted", async (t) => {
  const dir = path.join(tmp, "unanswered");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "transfers.json"), JSON.stringify([
    { transferId: "abcdefgh12", direction: "in", peer: "f".repeat(64), peerName: "Ivy", files: [], fileCount: 1, totalBytes: 10, state: "interrupted", started: true, createdAt: 1 },
  ]));
  const updates = [];
  const manager = createTransferManager({
    identity: { dir, fingerprint: "e".repeat(64) },
    contacts: { get: () => ({ status: "paired", name: "Ivy" }), card: () => null },
    sendEnvelope: async () => {},
    engine,
    offerTimeoutMs: 150,
    onUpdate: (x) => updates.push(x),
  });
  // seal() needs a real card; only the waiting timeout matters here.
  await manager.resume("abcdefgh12").catch(() => {});
  await until("back to interrupted", () => manager.get("abcdefgh12").state === "interrupted", 3000);
  assert.match(manager.get("abcdefgh12").error, /no answer from Ivy/);
  assert.equal(manager.get("abcdefgh12").resumable, true);
});
