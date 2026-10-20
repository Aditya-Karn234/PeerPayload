const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const WebSocket = require("ws");

const { createRelay } = require("../src/server");
const { issueTicket, verifyTicket } = require("../src/ticket");

const SECRET = "test-secret-".padEnd(40, "x");
let relay;
let base;

before(async () => {
  relay = createRelay({ secret: SECRET, unpairedTimeoutMs: 1500, log: { warn() {} } });
  const port = await relay.listen(0, "127.0.0.1");
  base = `ws://127.0.0.1:${port}/v1/connect`;
});

after(() => relay.close());

const ticket = (transferId, role, ttlSec = 60) => issueTicket({ transferId, role, ttlSec }, SECRET);

// Opens a socket and resolves once it's open; collects messages.
function connect(t) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${base}?ticket=${encodeURIComponent(t)}`);
    ws.received = [];
    ws.texts = [];
    ws.on("message", (data, isBinary) => (isBinary ? ws.received.push(Buffer.from(data)) : ws.texts.push(String(data))));
    ws.closed = new Promise((r) => ws.on("close", (code, reason) => r({ code, reason: String(reason) })));
    ws.on("open", () => resolve(ws));
    ws.on("unexpected-response", (req, res) => reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { status: res.statusCode })));
    ws.on("error", (err) => !ws.readyState && reject(err));
  });
}

const until = async (fn, ms = 5000) => {
  const deadline = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 20));
  }
};

const paired = (ws) => until(() => ws.texts.some((t) => JSON.parse(t).type === "paired"));

test("tickets: round trip, and tampered / expired / wrong-secret tickets are rejected", () => {
  const t = ticket("abc", "sender");
  assert.deepEqual(verifyTicket(t, SECRET), { transferId: "abc", role: "sender" });
  assert.equal(verifyTicket(t, "other-secret"), null);
  const [payload, sig] = t.split(".");
  const forged = Buffer.from(JSON.stringify({ t: "abc", r: "receiver", e: 9999999999 })).toString("base64url");
  assert.equal(verifyTicket(`${forged}.${sig}`, SECRET), null, "payload swap must fail");
  assert.equal(verifyTicket(`${payload}.${sig.slice(0, -2)}xx`, SECRET), null);
  assert.equal(verifyTicket(ticket("abc", "sender", -5), SECRET), null, "expired");
  assert.equal(verifyTicket(issueTicket({ transferId: "abc", role: "admin", ttlSec: 60 }, SECRET), SECRET), null, "unknown role");
  for (const junk of [undefined, "", ".", "a.b", "x".repeat(5000)]) assert.equal(verifyTicket(junk, SECRET), null);
});

test("upgrade without a valid ticket is refused with 401 before any WebSocket exists", async () => {
  await assert.rejects(connect("nope"), (e) => e.status === 401);
  await assert.rejects(connect(ticket("t1", "sender", -1)), (e) => e.status === 401);
});

test("pairs sender and receiver of the same transfer and forwards bytes both ways", async () => {
  const s = await connect(ticket("t2", "sender"));
  const r = await connect(ticket("t2", "receiver"));
  await Promise.all([paired(s), paired(r)]);

  s.send(Buffer.from("hello receiver"));
  r.send(Buffer.from("hello sender"));
  await until(() => r.received.length && s.received.length);
  assert.equal(Buffer.concat(r.received).toString(), "hello receiver");
  assert.equal(Buffer.concat(s.received).toString(), "hello sender");

  s.close();
  assert.equal((await r.closed).code, 1000, "partner is closed when one side leaves");
});

test("different transfers never cross", async () => {
  const s1 = await connect(ticket("ta", "sender"));
  const r2 = await connect(ticket("tb", "receiver"));
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(s1.texts.length, 0);
  assert.equal(r2.texts.length, 0);
  s1.close();
  r2.close();
});

test("data sent before pairing is a protocol violation", async () => {
  const s = await connect(ticket("t3", "sender"));
  s.send(Buffer.from("too early"));
  assert.equal((await s.closed).code, 1008);
});

test("an unpaired socket times out", async () => {
  const r = await connect(ticket("t4", "receiver"));
  const { code } = await r.closed;
  assert.equal(code, 4008);
});

test("a reconnecting side replaces the old pairing, and the new pair works", async () => {
  const s1 = await connect(ticket("t5", "sender"));
  const r1 = await connect(ticket("t5", "receiver"));
  await paired(s1);

  // Sender reconnects (e.g. after a dropped link): old pair is torn down.
  const s2 = await connect(ticket("t5", "sender"));
  assert.equal((await s1.closed).code, 4000);
  assert.equal((await r1.closed).code, 4000);

  const r2 = await connect(ticket("t5", "receiver"));
  await Promise.all([paired(s2), paired(r2)]);
  s2.send(Buffer.from("round two"));
  await until(() => r2.received.length);
  assert.equal(Buffer.concat(r2.received).toString(), "round two");
  s2.close();
  await r2.closed;
  assert.equal(relay.slots.has("t5"), false, "slot is cleaned up");
});

test("a large stream arrives intact and in order (flow control)", async () => {
  const s = await connect(ticket("t6", "sender"));
  const r = await connect(ticket("t6", "receiver"));
  await Promise.all([paired(s), paired(r)]);

  const total = 24 * 1024 * 1024;
  const source = crypto.randomBytes(total);
  for (let off = 0; off < total; off += 64 * 1024) s.send(source.subarray(off, off + 64 * 1024));

  await until(() => r.received.reduce((n, b) => n + b.length, 0) >= total, 30000);
  assert.ok(Buffer.concat(r.received).equals(source));
  s.close();
  await r.closed;
});

test("health endpoint answers", async () => {
  const port = relay.server.address().port;
  const res = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).ok, true);
});
