const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const core = require("..");
const { createMailbox } = require("../../mailbox/src/server");
const { createRelay } = require("../../../relay/src/server");

// Two Connect devices on one machine, each with its own identity, contacts
// and mailbox client, sending real files through the real engines.

const repo = path.resolve(__dirname, "..", "..", "..");
const exe = process.platform === "win32" ? ".exe" : "";
const engine = {
  senderPath: path.join(repo, "build", "sender", `sender${exe}`),
  receiverPath: path.join(repo, "build", "receiver", `receiver${exe}`),
};
const keygenPath = path.join(repo, "build", "engine", `ppkeygen${exe}`);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pp-connect-xfer-"));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 20000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error("timed out");
    await sleep(25);
  }
};
const sha = (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");

let mailbox, mailboxUrl, relay, relayUrl;
let alice, bob, carol;

before(async () => {
  for (const p of [engine.senderPath, engine.receiverPath, keygenPath])
    assert.ok(fs.existsSync(p), `build the engine first (${p})`);

  mailbox = createMailbox({ log: { warn() {} } });
  mailboxUrl = `http://127.0.0.1:${await mailbox.listen(0, "127.0.0.1")}`;
  relay = createRelay({ log: { warn() {} } });
  relayUrl = `ws://127.0.0.1:${await relay.listen(0, "127.0.0.1")}/v1/connect`;

  alice = core.createIdentity({ dir: path.join(tmp, "alice"), name: "Alice", keygenPath });
  bob = core.createIdentity({ dir: path.join(tmp, "bob"), name: "Bob", keygenPath });
  carol = core.createIdentity({ dir: path.join(tmp, "carol"), name: "Carol", keygenPath });
});

after(async () => {
  await mailbox.close();
  await relay.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

// A device: contacts + mailbox client + transfer manager, wired the way
// the app wires them. `probe` lets a test pretend direct paths don't work.
function device(t, identity, { probe, relay: useRelay = true, engine: engineOverride } = {}) {
  const contacts = core.openContacts(identity.dir);
  const updates = [];
  let manager;
  const client = core.createMailboxClient({
    url: mailboxUrl,
    identity,
    onEnvelope: async (opened) => manager.handleEnvelope(opened),
  });

  manager = core.createTransferManager({
    identity,
    contacts,
    sendEnvelope: client.send,
    engine: { ...engine, ...engineOverride },
    relayUrl: useRelay ? relayUrl : null,
    onUpdate: (s) => updates.push(s),
    ...(probe && { probe }),
  });
  client.start();
  t.after(() => client.stop());

  return { identity, contacts, client, manager, updates, latest: (id) => manager.get(id) };
}

function pair(a, b) {
  a.contacts.upsert(core.verifyCard(core.contactCard(b.identity)), "paired");
  b.contacts.upsert(core.verifyCard(core.contactCard(a.identity)), "paired");
}

function makeFolder(name, files) {
  const dir = path.join(tmp, "src", name);

  for (const [rel, bytes] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), crypto.randomBytes(bytes));
  }

  return dir;
}

async function offerAndAccept(sender, receiver, paths, outDir) {
  const sending = sender.manager.send(receiver.identity.fingerprint, paths);
  await until(() => receiver.manager.list().some((x) => x.state === "offered"));
  const offer = receiver.manager.list().find((x) => x.state === "offered");
  const receiving = receiver.manager.accept(offer.transferId, outDir);
  return { offer, sent: await sending, received: await receiving };
}

test("connect: send a folder directly between paired devices", async (t) => {
  const a = device(t, alice);
  const b = device(t, bob);
  pair(a, b);
  await until(() => a.client.connected && b.client.connected);

  const folder = makeFolder("photos", { "a.jpg": 300_000, "trip/b.jpg": 1_200_000, "trip/notes.txt": 10 });
  const out = path.join(tmp, "bob-downloads-1");
  const { offer, sent, received } = await offerAndAccept(a, b, [folder], out);

  assert.equal(offer.fileCount, 3);
  assert.equal(offer.totalBytes, 1_500_010);
  assert.equal(offer.peerName, "Alice");
  assert.deepEqual(offer.files.map((f) => f.name), ["photos"]);

  assert.equal(sent.state, "complete", sent.error);
  assert.equal(sent.path, "direct");
  assert.equal(received.state, "complete", received.error);
  for (const rel of ["a.jpg", "trip/b.jpg", "trip/notes.txt"])
    assert.equal(sha(path.join(out, "photos", rel)), sha(path.join(folder, rel)), rel);
  assert.deepEqual(b.latest(offer.transferId).progress, { bytes: 1_500_010, total: 1_500_010 });
});

test("connect: falls back to the relay when the receiver isn't directly reachable", async (t) => {
  const a = device(t, alice, { probe: async () => false });
  const b = device(t, bob);
  pair(a, b);
  await until(() => a.client.connected && b.client.connected);

  const file = path.join(makeFolder("relayed", { "big.bin": 3_000_000 }), "big.bin");
  const out = path.join(tmp, "bob-downloads-2");
  const { sent, received } = await offerAndAccept(a, b, [file], out);

  assert.equal(sent.state, "complete", sent.error);
  assert.equal(sent.path, "relay");
  assert.equal(received.state, "complete", received.error);
  assert.equal(sha(path.join(out, "big.bin")), sha(file));
  assert.ok(relay.stats.pairs >= 1);
});

test("connect: the receiver can decline", async (t) => {
  const a = device(t, alice);
  const b = device(t, bob);
  pair(a, b);
  await until(() => a.client.connected && b.client.connected);

  const file = path.join(makeFolder("declined", { "x.bin": 10 }), "x.bin");
  const sending = a.manager.send(bob.fingerprint, [file]);
  await until(() => b.manager.list().some((x) => x.state === "offered"));
  await b.manager.decline(b.manager.list().find((x) => x.state === "offered").transferId);

  assert.equal((await sending).state, "declined");
});

test("connect: offers and answers from anyone but the paired device are ignored", async (t) => {
  const a = device(t, alice);
  const b = device(t, bob);
  const c = device(t, carol);
  pair(a, b);
  // Carol knows Bob's card (it's not secret) but Bob never paired with her.
  c.contacts.upsert(core.verifyCard(core.contactCard(bob)), "paired");
  await until(() => a.client.connected && b.client.connected && c.client.connected);

  await assert.rejects(a.manager.send(carol.fingerprint, [__filename]), /paired contact/);

  const file = path.join(makeFolder("spam", { "s.bin": 10 }), "s.bin");
  const spam = c.manager.send(bob.fingerprint, [file]);
  await sleep(500);
  assert.equal(b.manager.list().length, 0, "Bob never sees Carol's offer");
  c.manager.cancelOffer(c.manager.list()[0].transferId);
  assert.equal((await spam).state, "cancelled");

  // Carol, seeing (somehow) Alice's transfer ID, tries to answer for Bob.
  const sending = a.manager.send(bob.fingerprint, [file]);
  await until(() => b.manager.list().some((x) => x.state === "offered"));
  const { transferId } = b.manager.list().find((x) => x.state === "offered");
  a.contacts.upsert(core.verifyCard(core.contactCard(carol)), "paired"); // even if Alice knows Carol
  await c.client.send(core.seal({ identity: carol, recipient: core.verifyCard(core.contactCard(alice)), payload: { type: "accept", transferId, token: "t", port: 1, addresses: ["127.0.0.1"], relay: false } }));
  await sleep(500);
  assert.equal(a.manager.get(transferId).state, "offered", "a third party can't accept");

  a.manager.cancelOffer(transferId);
  assert.equal((await sending).state, "cancelled");
  await until(() => b.manager.get(transferId).state === "cancelled");
});

test("connect: when the sender gives up, the receiver stops waiting for it", async (t) => {
  const a = device(t, alice, { engine: { senderPath: path.join(tmp, "missing-sender") } });
  const b = device(t, bob);
  pair(a, b);
  await until(() => a.client.connected && b.client.connected);

  const file = path.join(makeFolder("abandoned", { "x.bin": 10 }), "x.bin");
  const started = Date.now();
  const { sent, received } = await offerAndAccept(a, b, [file], path.join(tmp, "bob-downloads-3"));

  assert.equal(sent.state, "failed");
  assert.equal(received.state, "cancelled");
  assert.match(received.error, /sender stopped/);
  assert.ok(Date.now() - started < 15000, "well before the receiver's 120 s listen timeout");
});
