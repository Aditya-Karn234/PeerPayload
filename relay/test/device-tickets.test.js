// Device tickets (PeerPayload Connect): signed by each device's own Ed25519
// key, no backend. Covers verification, pairing rules and the per-IP cap.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const WebSocket = require("ws");

const { createRelay } = require("../src/server");
const { verifyTicket, issueTicket } = require("../src/ticket");
const { issueDeviceTicket } = require("../../client-core/deviceTicket");

// Device identities come from the engine's ppkeygen (Node can't create
// X.509 certificates itself), so build the engine before running these.
const path = require("path");
const fs = require("fs");
const os = require("os");
const { execFileSync } = require("child_process");

const repo = path.resolve(__dirname, "..", "..");
const keygen = path.join(repo, "build", "engine", `ppkeygen${process.platform === "win32" ? ".exe" : ""}`);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pp-devtickets-"));

function device(name) {
  const dir = path.join(tmp, name);
  const out = execFileSync(keygen, ["--out", dir, "--name", name], { encoding: "utf8" });
  const fp = JSON.parse(out.trim()).certSha256;
  return { fp, certPem: fs.readFileSync(path.join(dir, "device.crt"), "utf8"), keyPem: fs.readFileSync(path.join(dir, "device.key"), "utf8") };
}

let relay;
let base;
let alice, bob, carol;

before(async () => {
  assert.ok(fs.existsSync(keygen), `build ppkeygen first (${keygen})`);
  alice = device("alice");
  bob = device("bob");
  carol = device("carol");
  // No secret: a Connect-only relay.
  relay = createRelay({ unpairedTimeoutMs: 1500, maxSocketsPerIp: 6, log: { warn() {} } });
  const port = await relay.listen(0, "127.0.0.1");
  base = `ws://127.0.0.1:${port}/v1/connect`;
});

after(async () => {
  await relay.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const ticket = (me, peer, role, sessionId = "s1", ttlSec = 300) =>
  issueDeviceTicket({ sessionId, role, peerFingerprint: peer.fp, certPem: me.certPem, keyPem: me.keyPem, ttlSec });

function connect(t) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${base}?ticket=${encodeURIComponent(t)}`);
    ws.received = [];
    ws.texts = [];
    ws.on("message", (d, bin) => (bin ? ws.received.push(Buffer.from(d)) : ws.texts.push(String(d))));
    ws.closed = new Promise((r) => ws.on("close", (code) => r(code)));
    ws.on("open", () => resolve(ws));
    ws.on("unexpected-response", (req, res) => reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { status: res.statusCode })));
    ws.on("error", () => {});
  });
}

const until = async (fn, ms = 5000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
};

test("verify: a device ticket proves the device ID and names its peer", () => {
  const v = verifyTicket(ticket(alice, bob, "sender"), null);
  assert.equal(v.kind, "device");
  assert.equal(v.from, alice.fp);
  assert.equal(v.to, bob.fp);
  assert.equal(v.role, "sender");
  // Both sides of the session get the same slot key.
  assert.equal(verifyTicket(ticket(bob, alice, "receiver"), null).transferId, v.transferId);
});

test("verify: forged, tampered, expired, long-lived and foreign tickets are rejected", () => {
  const good = ticket(alice, bob, "sender");
  const [payloadPart, sig] = good.split(".");
  const payload = JSON.parse(Buffer.from(payloadPart, "base64url").toString());

  // Claim to be Bob while presenting Alice's certificate.
  const claimBob = Buffer.from(JSON.stringify({ ...payload, f: bob.fp })).toString("base64url");
  assert.equal(verifyTicket(`${claimBob}.${sig}`, null), null);

  // Any change to the signed part.
  const otherPeer = Buffer.from(JSON.stringify({ ...payload, p: carol.fp })).toString("base64url");
  assert.equal(verifyTicket(`${otherPeer}.${sig}`, null), null);

  // Signature by a different device's key over Alice's claims.
  const forgedSig = crypto.sign(null, Buffer.from(payloadPart), crypto.createPrivateKey(carol.keyPem)).toString("base64url");
  assert.equal(verifyTicket(`${payloadPart}.${forgedSig}`, null), null);

  assert.equal(verifyTicket(ticket(alice, bob, "sender", "s1", -5), null), null, "expired");
  assert.equal(verifyTicket(ticket(alice, bob, "sender", "s1", 3600), null), null, "valid for too long");
  assert.equal(verifyTicket(ticket(alice, alice, "sender"), null), null, "self-pairing");
  assert.equal(verifyTicket(ticket(alice, bob, "sender", "bad id!"), null), null, "bad session id");

  // A non-Ed25519 identity.
  const rsa = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  assert.throws(() => issueDeviceTicket({ sessionId: "s", role: "sender", peerFingerprint: bob.fp, certPem: "not a cert", keyPem: rsa.privateKey.export({ type: "pkcs8", format: "pem" }) }));
});

test("verify: backend tickets need the secret, device tickets don't", () => {
  const secret = "x".repeat(40);
  const backend = issueTicket({ transferId: "t", role: "sender", ttlSec: 60 }, secret);
  assert.equal(verifyTicket(backend, null), null, "no secret configured: backend tickets refused");
  assert.equal(verifyTicket(backend, secret).kind, "backend");
  assert.equal(verifyTicket(ticket(alice, bob, "sender"), secret).kind, "device", "device tickets work with or without a secret");
});

test("relay: two devices that name each other pair and exchange bytes", async () => {
  const s = await connect(ticket(alice, bob, "sender", "p1"));
  const r = await connect(ticket(bob, alice, "receiver", "p1"));
  await until(() => s.texts.length && r.texts.length);
  s.send(Buffer.from("hi bob"));
  await until(() => r.received.length);
  assert.equal(Buffer.concat(r.received).toString(), "hi bob");
  s.close();
  await r.closed;
});

test("relay: a third device can't join someone else's session", async () => {
  const r = await connect(ticket(bob, alice, "receiver", "p2"));
  // Carol, with her own valid key, names Bob and uses the same session ID.
  const c = await connect(ticket(carol, bob, "sender", "p2"));
  await new Promise((res) => setTimeout(res, 300));
  assert.equal(r.texts.length, 0, "Bob's receiver must not pair with Carol");
  assert.equal(c.texts.length, 0);
  c.close();
  // Alice still can.
  const s = await connect(ticket(alice, bob, "sender", "p2"));
  await until(() => s.texts.length && r.texts.length);
  s.close();
  await r.closed;
});

test("relay: per-IP connection cap", async () => {
  const sockets = [];
  for (let i = 0; i < 6; i++) sockets.push(await connect(ticket(alice, bob, "sender", `cap${i}`)));
  await assert.rejects(connect(ticket(alice, bob, "sender", "cap-extra")), (e) => e.status === 429);
  sockets[0].close();
  await sockets[0].closed;
  const again = await connect(ticket(alice, bob, "sender", "cap-after"));
  again.close();
  for (const ws of sockets.slice(1)) ws.close();
});
