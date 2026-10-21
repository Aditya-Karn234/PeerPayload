const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const p = require("..");

// Device identities come from the engine's ppkeygen (Node can't create
// X.509 certificates), so build the engine first.

const repo = path.resolve(__dirname, "..", "..");
const keygen = path.join(repo, "build", "engine", `ppkeygen${process.platform === "win32" ? ".exe" : ""}`);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pp-protocol-"));

function device(name) {
  const dir = path.join(tmp, name);

  execFileSync(keygen, ["--out", dir, "--name", name], { stdio: "ignore" });

  const certPem = fs.readFileSync(path.join(dir, "device.crt"), "utf8");
  const keyPem = fs.readFileSync(path.join(dir, "device.key"), "utf8");
  const certDer = new crypto.X509Certificate(certPem).raw;
  const box = crypto.generateKeyPairSync("x25519");

  return {
    name,
    certPem,
    keyPem,
    certDer,
    fingerprint: p.fingerprintOfDer(certDer),
    signingKey: crypto.createPrivateKey(keyPem),
    boxPublic: box.publicKey.export({ format: "jwk" }).x,
  };
}

let alice, bob;

before(() => {
  assert.ok(fs.existsSync(keygen), `build the engine first (${keygen})`);
  alice = device("alice");
  bob = device("bob");
});

after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const MIN = 60 * 1000;

test("device: a certificate only yields a key for its own ID", () => {
  assert.ok(p.deviceKey(alice.certDer, alice.fingerprint));
  assert.ok(p.deviceKey(alice.certDer.toString("base64"), alice.fingerprint));
  assert.equal(p.deviceKey(alice.certDer, bob.fingerprint), null);
  assert.equal(p.deviceKey("x".repeat(5000), alice.fingerprint), null);
  assert.equal(p.deviceKey("not a cert", p.fingerprintOfDer(Buffer.from("not a cert", "base64"))), null);
});

test("inbox tokens: valid, expired, too long-lived, someone else's ID, tampered", () => {
  const now = Date.now();

  assert.deepEqual(p.verifyInboxToken(p.issueInboxToken(alice, { now }), now), { fingerprint: alice.fingerprint });
  assert.equal(p.verifyInboxToken(p.issueInboxToken(alice, { now, ttlSec: 60 }), now + 2 * MIN), null, "expired");
  assert.equal(p.verifyInboxToken(p.issueInboxToken(alice, { now, ttlSec: 3600 }), now), null, "ttl over 15 min");
  assert.equal(p.verifyInboxToken(p.issueInboxToken({ ...alice, fingerprint: bob.fingerprint }, { now }), now), null, "claims Bob's ID");

  const [payload, sig] = p.issueInboxToken(alice, { now }).split(".");
  const other = p.issueInboxToken(bob, { now }).split(".")[1];
  assert.equal(p.verifyInboxToken(`${payload}.${other}`, now), null, "signature from another device");
  for (const junk of [undefined, "", ".", "a.", ".b", "x".repeat(9000), `${payload}`, `${payload}.${sig}x`])
    assert.equal(p.verifyInboxToken(junk, now), null, String(junk).slice(0, 20));
});

test("relay tickets: backend (HMAC) and device-signed, never interchangeable", () => {
  const now = Date.now();
  const secret = "s3cret";
  const { ticket } = p.issueBackendTicket({ transferId: "t1", role: "sender", ttlSec: 60 }, secret, now);

  assert.deepEqual(p.verifyTicket(ticket, secret, now), { kind: "backend", transferId: "t1", role: "sender" });
  assert.equal(p.verifyTicket(ticket, "other", now), null, "wrong secret");
  assert.equal(p.verifyTicket(ticket, null, now), null, "relay without a secret takes device tickets only");
  assert.equal(p.verifyTicket(ticket, secret, now + 2 * MIN), null, "expired");

  const issue = (me, peer, role, opts = {}) =>
    p.issueDeviceTicket({ sessionId: "abc", role, peerFingerprint: peer.fingerprint, certPem: me.certPem, keyPem: me.keyPem, ...opts }, now);
  const a = p.verifyTicket(issue(alice, bob, "sender"), null, now);
  const b = p.verifyTicket(issue(bob, alice, "receiver"), null, now);

  assert.equal(a.kind, "device");
  assert.equal(a.transferId, b.transferId, "both sides land in the same slot");
  assert.deepEqual([a.from, a.to], [alice.fingerprint, bob.fingerprint]);
  assert.equal(p.verifyTicket(issue(alice, alice, "sender"), null, now), null, "meeting yourself");
  assert.equal(p.verifyTicket(issue(alice, bob, "admin"), null, now), null, "unknown role");
  assert.equal(p.verifyTicket(issue(alice, bob, "sender", { ttlSec: 3600 }), null, now), null, "ttl over 15 min");

  // Other device-signed tokens aren't tickets, and tickets aren't inbox tokens.
  assert.equal(p.verifyTicket(p.issueInboxToken(alice, { now }), secret, now), null);
  assert.equal(p.verifyInboxToken(issue(alice, bob, "sender"), now), null);
});

test("cards and pairing links: round trip, tampering, expiry", () => {
  const card = p.contactCard(alice);

  assert.equal(p.verifyCard(card).fp, alice.fingerprint);
  assert.throws(() => p.verifyCard({ ...card, fp: bob.fingerprint }), /does not match/);
  assert.throws(() => p.verifyCard({ ...card, name: "x".repeat(65) }), /name/);

  const now = Date.now();
  const link = p.encodeInviteLink({ identity: alice, secret: crypto.randomBytes(16).toString("base64url"), mailbox: "https://mb.example", expiresAt: now + MIN });

  assert.ok(link.startsWith(p.LINK_PREFIX));
  assert.equal(p.parseInviteLink(link, { now }).card.fp, alice.fingerprint);
  assert.equal(p.parseInviteLink(link.slice(p.LINK_PREFIX.length), { now }).mailbox, "https://mb.example", "bare part pasted");
  assert.throws(() => p.parseInviteLink(link, { now: now + 2 * MIN }), /expired/);
  assert.throws(() => p.parseInviteLink("peerpayload://pair#garbage"), /not a PeerPayload pairing link|unsupported/);
  assert.throws(() => p.encodeInviteLink({ identity: alice, secret: "s", mailbox: "ftp://x", expiresAt: now }), /mailbox/);
});

test("envelopes: the signature covers every field", () => {
  const e = { v: 1, to: bob.fingerprint, from: alice.fingerprint, ts: 1, id: crypto.randomBytes(16).toString("base64url"), epk: "k", iv: "i", ct: "c", cert: alice.certDer.toString("base64") };
  e.sig = crypto.sign(null, Buffer.from(p.signedText(e)), alice.signingKey).toString("base64url");

  assert.ok(p.verifyEnvelopeSignature(e));
  for (const field of ["to", "ts", "id", "epk", "iv", "ct"])
    assert.throws(() => p.verifyEnvelopeSignature({ ...e, [field]: field === "ts" ? 2 : field === "to" ? alice.fingerprint : `${e[field]}x` }), Error, field);
  assert.throws(() => p.verifyEnvelopeSignature({ ...e, from: bob.fingerprint }), /does not match/);
  assert.throws(() => p.verifyEnvelopeSignature({ ...e, id: "short" }), /bad id/);
});

test("messages: every type round-trips through makeMessage -> JSON -> parseMessage", () => {
  const roundTrip = (type, fields) => p.parseMessage(JSON.parse(JSON.stringify(p.makeMessage(type, fields))));
  const transferId = "abcdefgh12";

  assert.deepEqual(roundTrip("offer", { transferId, files: [{ name: "a", size: 1, files: 1 }], fileCount: 1, totalBytes: 1 }),
    { type: "offer", transferId, files: [{ name: "a", size: 1, files: 1 }], fileCount: 1, totalBytes: 1 });
  assert.deepEqual(roundTrip("accept", { transferId, token: "t", port: 9, addresses: ["::1", "10.0.0.2"], relay: false }),
    { type: "accept", transferId, token: "t", port: 9, addresses: ["::1", "10.0.0.2"], relay: false });
  assert.deepEqual(roundTrip("decline", { transferId }), { type: "decline", transferId });
  assert.deepEqual(roundTrip("cancel", { transferId }), { type: "cancel", transferId });
  assert.deepEqual(roundTrip("pair-accept"), { type: "pair-accept" });

  const request = p.makeMessage("pair-request", { secret: "abc", card: p.contactCard(alice) });
  assert.deepEqual(Object.keys(request.card).sort(), ["box", "cert", "fp", "name", "v"], "plain JSON card, no key objects");
  assert.equal(p.parseMessage(JSON.parse(JSON.stringify(request))).card.fp, alice.fingerprint);
});

test("messages: malformed ones are refused on both sides", () => {
  const transferId = "abcdefgh12";
  const accept = { type: "accept", transferId, token: "t", port: 9, addresses: ["10.0.0.2"], relay: false };

  for (const [what, bad] of [
    ["unknown type", { type: "nope", transferId }],
    ["no type", { transferId }],
    ["not an object", "offer"],
    ["short id", { type: "decline", transferId: "abc" }],
    ["port 0", { ...accept, port: 0 }],
    ["port as string", { ...accept, port: "9" }],
    ["token too long", { ...accept, token: "x".repeat(64) }],
    ["hostname instead of IP", { ...accept, addresses: ["example.com"] }],
    ["nowhere to connect", { ...accept, addresses: [], relay: false }],
    ["relay as string", { ...accept, relay: "yes" }],
    ["too many offered names", { type: "offer", transferId, files: Array(51).fill({ name: "a", size: 1, files: 1 }), fileCount: 51, totalBytes: 51 }],
    ["negative size", { type: "offer", transferId, files: [], fileCount: 1, totalBytes: -1 }],
    ["forged card", { type: "pair-request", secret: "abc", card: { ...p.contactCard(alice), fp: bob.fingerprint } }],
  ]) {
    assert.equal(p.parseMessage(bad), null, what);

    if (bad && typeof bad === "object" && p.MESSAGES[bad.type])
      assert.throws(() => p.makeMessage(bad.type, bad), /invalid/, what);
  }

  // Relay-only accepts are fine; unknown extra fields are dropped.
  assert.ok(p.parseMessage({ ...accept, addresses: [], relay: true }));
  assert.equal(p.parseMessage({ ...accept, future: 1 }).future, undefined);
});
