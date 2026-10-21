const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const WebSocket = require("ws");

const { createMailbox } = require("../src/server");
const core = require("../../core");

const repo = path.resolve(__dirname, "..", "..", "..");
const keygenPath = path.join(repo, "build", "engine", `ppkeygen${process.platform === "win32" ? ".exe" : ""}`);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pp-mailbox-"));

let alice, bob, mallory;

before(() => {
  assert.ok(fs.existsSync(keygenPath), `build the engine first (${keygenPath})`);
  alice = core.createIdentity({ dir: path.join(tmp, "alice"), name: "Alice", keygenPath });
  bob = core.createIdentity({ dir: path.join(tmp, "bob"), name: "Bob", keygenPath });
  mallory = core.createIdentity({ dir: path.join(tmp, "mallory"), name: "Mallory", keygenPath });
});

after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const card = (id) => core.verifyCard(core.contactCard(id));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 5000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error("timed out");
    await sleep(20);
  }
};

async function startMailbox(t, options = {}) {
  const mailbox = createMailbox({ log: { warn() {} }, ...options });
  const port = await mailbox.listen(0, "127.0.0.1");
  t.after(() => mailbox.close());
  return { mailbox, url: `http://127.0.0.1:${port}` };
}

async function post(url, body, raw = false) {
  const res = await fetch(`${url}/v1/messages`, { method: "POST", headers: { "Content-Type": "application/json" }, body: raw ? body : JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null) };
}

// A raw inbox socket (no client library) collecting envelopes.
function inbox(url, identity, token = core.issueInboxToken(identity)) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${url.replace("http", "ws")}/v1/inbox?token=${encodeURIComponent(token)}`);
    ws.envelopes = [];
    ws.on("message", (d) => {
      const m = JSON.parse(String(d));
      if (m.type === "envelope") ws.envelopes.push(m.envelope);
    });
    ws.closed = new Promise((r) => ws.on("close", (code) => r(code)));
    ws.on("open", () => resolve(ws));
    ws.on("unexpected-response", (req, res) => reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { status: res.statusCode })));
    ws.on("error", () => {});
  });
}

const env = (from, to, payload = { type: "ping" }, now) => core.seal({ identity: from, recipient: card(to), payload, now });

test("mailbox: online recipients get envelopes pushed immediately", async (t) => {
  const { url } = await startMailbox(t);
  const box = await inbox(url, bob);
  const e = env(alice, bob, { type: "hello" });
  assert.equal((await post(url, e)).status, 202);
  await until(() => box.envelopes.length === 1);
  assert.deepEqual(core.open(box.envelopes[0], bob).payload, { type: "hello" });
  box.close();
});

test("mailbox: offline envelopes wait, are redelivered until acknowledged, then deleted", async (t) => {
  const { url, mailbox } = await startMailbox(t);
  const e1 = env(alice, bob, { n: 1 });
  const e2 = env(alice, bob, { n: 2 });
  await post(url, e1);
  await post(url, e2);

  let box = await inbox(url, bob);
  await until(() => box.envelopes.length === 2);
  box.send(JSON.stringify({ type: "ack", ids: [e1.id] }));
  await sleep(100);
  box.close();
  await box.closed;

  box = await inbox(url, bob);
  await until(() => box.envelopes.length === 1);
  assert.equal(box.envelopes[0].id, e2.id, "only the unacknowledged one comes back");
  box.send(JSON.stringify({ type: "ack", ids: [e2.id] }));
  await until(() => !mailbox.queues.has(bob.fingerprint));
  box.close();
});

test("mailbox: forged, malformed, oversized, stale and duplicate envelopes", async (t) => {
  const { url } = await startMailbox(t);
  const good = env(alice, bob);

  assert.equal((await post(url, { ...good, from: mallory.fingerprint })).status, 401, "claimed sender ≠ certificate");
  assert.equal((await post(url, { ...good, ct: good.ct.slice(0, -4) + "AAAA" })).status, 401, "tampered");
  assert.equal((await post(url, { ...good, sig: undefined })).status, 401);
  assert.equal((await post(url, "{not json", true)).status, 400);
  assert.equal((await post(url, { pad: "x".repeat(100 * 1024) })).status, 413);
  assert.equal((await post(url, env(alice, bob, {}, Date.now() - 60 * 60 * 1000))).status, 422, "an hour old");

  assert.equal((await post(url, good)).status, 202);
  const dup = await post(url, good);
  assert.equal(dup.status, 202);
  assert.equal(dup.body.duplicate, true);
  const box = await inbox(url, bob);
  await sleep(200);
  assert.equal(box.envelopes.length, 1, "a duplicate is stored once");
  box.close();
});

test("mailbox: per-sender rate limit and per-device queue cap", async (t) => {
  const { url } = await startMailbox(t, { maxPerSenderPerMinute: 3, maxQueuePerDevice: 5 });
  const codes = [];
  for (let i = 0; i < 4; i++) codes.push((await post(url, env(alice, bob, { i }))).status);
  assert.deepEqual(codes, [202, 202, 202, 429]);

  for (let i = 0; i < 2; i++) assert.equal((await post(url, env(mallory, bob, { i }))).status, 202);
  assert.equal((await post(url, env(mallory, bob, { i: 9 }))).status, 507, "Bob's queue is full at 5");
});

test("mailbox: a device can only collect its own inbox", async (t) => {
  const { url } = await startMailbox(t);
  await post(url, env(alice, bob, { secret: "for bob" }));

  await assert.rejects(inbox(url, mallory, "garbage"), (e) => e.status === 401);
  // Mallory signs a token claiming Bob's device ID with her own key.
  const forged = core.issueInboxToken({ ...mallory, fingerprint: bob.fingerprint });
  await assert.rejects(inbox(url, mallory, forged), (e) => e.status === 401);
  // Her own (valid) inbox doesn't contain Bob's mail.
  const malloryBox = await inbox(url, mallory);
  await sleep(200);
  assert.equal(malloryBox.envelopes.length, 0);
  malloryBox.close();
});

test("mailbox: a second connection for the same device replaces the first", async (t) => {
  const { url } = await startMailbox(t);
  const first = await inbox(url, bob);
  const second = await inbox(url, bob);
  assert.equal(await first.closed, 4000);
  await post(url, env(alice, bob));
  await until(() => second.envelopes.length === 1);
  second.close();
});

test("client: pairing end to end through the mailbox", async (t) => {
  const { url } = await startMailbox(t);
  const aliceContacts = core.openContacts(alice.dir);
  const bobContacts = core.openContacts(bob.dir);

  // Alice's app: answers valid pair requests.
  const aliceClient = core.createMailboxClient({
    url,
    identity: alice,
    onEnvelope: async ({ from, payload }) => {
      if (payload.type !== "pair-request") return;
      const requester = core.verifyCard(payload.card);
      if (requester.fp !== from || !aliceContacts.consumeInvite(payload.secret, from)) return;
      aliceContacts.upsert(requester, "paired");
      await aliceClient.send(core.seal({ identity: alice, recipient: requester, payload: { type: "pair-accept" } }));
    },
  });

  // Bob's app: marks the inviter paired when she accepts.
  const bobClient = core.createMailboxClient({
    url,
    identity: bob,
    onEnvelope: async ({ from, payload }) => {
      if (payload.type === "pair-accept" && bobContacts.get(from)) bobContacts.upsert(bobContacts.card(from), "paired");
    },
  });

  aliceClient.start();
  bobClient.start();
  t.after(() => {
    aliceClient.stop();
    bobClient.stop();
  });
  await until(() => aliceClient.connected && bobClient.connected);

  const invite = core.createInvite(alice, { mailbox: url });
  aliceContacts.addInvite(invite);
  const parsed = core.parseInvite(invite.link);
  bobContacts.upsert(parsed.card, "pending");
  await bobClient.send(core.seal({ identity: bob, recipient: parsed.card, payload: { type: "pair-request", secret: parsed.secret, card: core.contactCard(bob) } }));

  await until(() => bobContacts.get(alice.fingerprint)?.status === "paired" && aliceContacts.get(bob.fingerprint)?.status === "paired");
});

test("client: an envelope whose handler fails is redelivered after reconnecting", async (t) => {
  const { url } = await startMailbox(t);
  let attempts = 0;
  const got = [];
  const client = core.createMailboxClient({
    url,
    identity: bob,
    onEnvelope: async ({ payload }) => {
      attempts++;
      if (attempts === 1) throw new Error("disk full");
      got.push(payload);
    },
  });
  await post(url, env(alice, bob, { n: 42 }));
  client.start();
  await until(() => attempts === 1);
  client.stop();
  await sleep(100);
  client.start();
  t.after(() => client.stop());
  await until(() => got.length === 1);
  assert.deepEqual(got[0], { n: 42 });
});
