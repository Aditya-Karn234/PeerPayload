const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const net = require("net");
const { WebSocketServer } = require("ws");

const { createConnectNode, createMailboxClient, createIdentity } = require("..");
const { createMailbox } = require("../../mailbox/src/server");

// Whole Connect devices, as an app runs them: setup, invite link, pairing,
// a transfer. Alice and Bob use different mailboxes, so every message has
// to be routed to the right one.

const repo = path.resolve(__dirname, "..", "..", "..");
const exe = process.platform === "win32" ? ".exe" : "";
const engine = {
  senderPath: path.join(repo, "build", "sender", `sender${exe}`),
  receiverPath: path.join(repo, "build", "receiver", `receiver${exe}`),
};
const keygenPath = path.join(repo, "build", "engine", `ppkeygen${exe}`);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pp-connect-node-"));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 20000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error("timed out");
    await sleep(25);
  }
};

const mailboxes = [];
let mailboxA, mailboxB;

before(async () => {
  for (const p of [engine.senderPath, engine.receiverPath, keygenPath])
    assert.ok(fs.existsSync(p), `build the engine first (${p})`);

  for (let i = 0; i < 2; i++) {
    const m = createMailbox({ log: { warn() {} } });
    mailboxes.push(m);
  }
  mailboxA = `http://127.0.0.1:${await mailboxes[0].listen(0, "127.0.0.1")}`;
  mailboxB = `http://127.0.0.1:${await mailboxes[1].listen(0, "127.0.0.1")}`;
});

after(async () => {
  for (const m of mailboxes) await m.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function node(t, name, mailboxUrl, options = {}) {
  const n = createConnectNode({ dir: path.join(tmp, name), keygenPath, engine, mailboxUrl, ...options });
  const seen = { paired: [], transfers: new Map() };

  n.on("paired", (c) => seen.paired.push(c));
  n.on("transfer", (x) => seen.transfers.set(x.transferId, x));
  t.after(() => n.stop());

  return Object.assign(n, { seen });
}

test("node: set up, pair through an invite link, send a file", async (t) => {
  const alice = node(t, "alice", mailboxA);
  const bob = node(t, "bob", mailboxB);

  assert.equal(alice.status().hasIdentity, false);
  assert.throws(() => alice.createInvite(), /no identity/);
  alice.setup("Alice");
  bob.setup("Bob");
  assert.throws(() => alice.setup("Again"), /already has an identity/);
  await until(() => alice.status().connected && bob.status().connected);

  const { link } = alice.createInvite();
  await assert.rejects(alice.addContact(link), /own invite/);

  const pending = await bob.addContact(link);
  assert.equal(pending.status, "pending");
  assert.equal(pending.name, "Alice");

  await until(() => alice.seen.paired.length === 1 && bob.seen.paired.length === 1);
  const [bobsView] = bob.contacts();
  const [alicesView] = alice.contacts();
  assert.equal(bobsView.status, "paired");
  assert.equal(alicesView.status, "paired");
  assert.equal(alicesView.mailbox, mailboxB, "Alice learned where Bob collects messages");
  assert.equal(alicesView.safetyCode, bobsView.safetyCode, "both sides show the same safety code");

  // Bob sends Alice a file; Alice accepts when the offer arrives.
  const file = path.join(tmp, "report.pdf");
  fs.writeFileSync(file, crypto.randomBytes(700_000));
  const sending = bob.send(alice.status().fingerprint, [file]);
  await until(() => [...alice.seen.transfers.values()].some((x) => x.state === "offered"));
  const offer = [...alice.seen.transfers.values()].find((x) => x.state === "offered");
  assert.equal(offer.peerName, "Bob");

  const out = path.join(tmp, "alice-downloads");
  const [sent, received] = await Promise.all([sending, alice.accept(offer.transferId, out)]);
  assert.equal(sent.state, "complete", sent.error);
  assert.equal(received.state, "complete", received.error);
  assert.ok(fs.readFileSync(path.join(out, "report.pdf")).equals(fs.readFileSync(file)));
});

test("node: an invite link works once; a second device using it isn't paired", async (t) => {
  const alice = node(t, "alice2", mailboxA);
  const bob = node(t, "bob2", mailboxB);
  const carol = node(t, "carol2", mailboxB);
  for (const [n, name] of [[alice, "Alice"], [bob, "Bob"], [carol, "Carol"]]) n.setup(name);
  await until(() => alice.status().connected && bob.status().connected && carol.status().connected);

  const { link } = alice.createInvite();
  await bob.addContact(link);
  await until(() => bob.seen.paired.length === 1);

  await carol.addContact(link);
  await sleep(700);
  assert.equal(carol.contacts()[0].status, "pending", "Carol is never accepted");
  assert.deepEqual(alice.contacts().map((c) => c.name), ["Bob"]);
});

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

test("node: a pair request that couldn't be sent goes again until it's answered", async (t) => {
  // Alice's mailbox is down when Bob opens her link.
  const port = await freePort();
  const alice = node(t, "alice3", `http://127.0.0.1:${port}`);
  const bob = node(t, "bob3", mailboxB, { pairRetryMs: 200 });
  alice.setup("Alice");
  bob.setup("Bob");
  await until(() => bob.status().connected);

  const pending = await bob.addContact(alice.createInvite().link);
  assert.equal(pending.status, "pending", "adding still works; the request goes later");
  await sleep(500);
  assert.equal(alice.seen.paired.length, 0);

  // Her mailbox comes up; Bob's retries get through and Alice answers.
  const late = createMailbox({ log: { warn() {} } });
  t.after(() => late.close());
  await late.listen(port, "127.0.0.1");
  alice.reconnectNow();

  await until(() => alice.seen.paired.length === 1 && bob.seen.paired.length === 1);
  assert.equal(bob.contacts()[0].status, "paired");
  assert.equal(alice.contacts()[0].status, "paired");
});

test("mailbox client: replaces a connection that stops answering pings", async (t) => {
  // A "mailbox" whose connections go silent: never answers pings.
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1", autoPong: false });
  let connections = 0;
  wss.on("connection", () => connections++);
  t.after(() => new Promise((r) => wss.close(r)));
  await new Promise((r) => wss.once("listening", r));

  const identity = createIdentity({ dir: path.join(tmp, "heartbeat"), name: "Heartbeat", keygenPath });
  const client = createMailboxClient({ url: `http://127.0.0.1:${wss.address().port}`, identity, onEnvelope() {}, heartbeatMs: 100 });
  t.after(() => client.stop());
  client.start();

  // Dead after two silent pings, then a fresh connection (backoff 1 s at most).
  await until(() => connections >= 2, 5000);
});
