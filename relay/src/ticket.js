const crypto = require("crypto");

// Relay tickets: short-lived, signed permission for one side of one
// transfer to use the relay. The relay only checks signatures, so it needs
// no database and can run anywhere, as many copies as needed. Two kinds:
//
// 1. Backend tickets (PeerPayload Enterprise). The backend knows who is a
//    party to which transfer and signs with a secret shared with the relay.
//      base64url(JSON {t: transferId, r: role, e: expiry}) "." base64url(HMAC-SHA256(secret))
//    backend/src/relayTickets.js has the issuing half; keep the two in sync.
//
// 2. Device tickets (PeerPayload Connect). There is no backend: each device
//    signs its own ticket with its device key (the same Ed25519 key its
//    engine uses for TLS), and names the device it wants to meet.
//      base64url(JSON {v: 2, t: sessionId, r: role, f: own device ID,
//                      p: peer device ID, e: expiry, c: base64 DER certificate})
//      "." base64url(Ed25519 signature over the first part)
//    A device ID is the SHA-256 of its certificate (what ppkeygen prints).
//    The relay checks the certificate hashes to `f` and the signature is
//    valid, so nobody can claim another device's ID. The relay pairs two
//    sides only when each names the other, so a third device can't join.
//    client-core/deviceTicket.js has the issuing half; keep them in sync.

const ROLES = new Set(["sender", "receiver"]);
const FINGERPRINT = /^[0-9a-f]{64}$/;
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;

// Device tickets are signed by the device itself, so cap how far ahead they
// may be valid: a leaked one can't be replayed for long.
const MAX_DEVICE_TICKET_TTL_SEC = 15 * 60;

function b64url(buf) {
  return Buffer.from(buf).toString("base64url");
}

function sign(payloadPart, secret) {
  return b64url(crypto.createHmac("sha256", secret).update(payloadPart).digest());
}

function issueTicket({ transferId, role, ttlSec }, secret, now = Date.now()) {
  const payload = { t: transferId, r: role, e: Math.floor(now / 1000) + ttlSec };
  const payloadPart = b64url(JSON.stringify(payload));

  return `${payloadPart}.${sign(payloadPart, secret)}`;
}

function verifyBackendTicket(payloadPart, signaturePart, secret, now) {
  const given = Buffer.from(signaturePart, "base64url");
  const expected = Buffer.from(sign(payloadPart, secret), "base64url");

  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected))
    return null;

  let payload;

  try {
    payload = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8"));
  } catch {
    return null;
  }

  if (typeof payload?.t !== "string" || !payload.t || !ROLES.has(payload.r) || !Number.isInteger(payload.e))
    return null;

  if (payload.e * 1000 < now)
    return null;

  return { kind: "backend", transferId: payload.t, role: payload.r };
}

function verifyDeviceTicket(payloadPart, signaturePart, payload, now) {
  const { t, r, f, p, e, c } = payload;

  if (!SESSION_ID.test(t ?? "") || !ROLES.has(r) || !FINGERPRINT.test(f ?? "") || !FINGERPRINT.test(p ?? ""))
    return null;

  if (f === p || !Number.isInteger(e) || typeof c !== "string" || c.length > 4096)
    return null;

  const nowSec = Math.floor(now / 1000);

  if (e < nowSec || e > nowSec + MAX_DEVICE_TICKET_TTL_SEC)
    return null;

  const der = Buffer.from(c, "base64");

  // The ticket's claimed device ID must be this certificate's.
  if (crypto.createHash("sha256").update(der).digest("hex") !== f)
    return null;

  let publicKey;

  try {
    publicKey = new crypto.X509Certificate(der).publicKey;
  } catch {
    return null;
  }

  // Device identities are Ed25519 (ppkeygen); accept nothing else.
  if (publicKey.asymmetricKeyType !== "ed25519")
    return null;

  let valid = false;

  try {
    valid = crypto.verify(null, Buffer.from(payloadPart), publicKey, Buffer.from(signaturePart, "base64url"));
  } catch {
    return null;
  }

  if (!valid)
    return null;

  // Both sides of a session share this key (IDs sorted), and nothing else
  // can: a third device's ID changes it, and backend transfer IDs never
  // start with "dev:".
  const pair = [f, p].sort().join(":");

  return { kind: "device", transferId: `dev:${t}:${pair}`, role: r, from: f, to: p };
}

// Returns { kind, transferId, role, (from, to) } or null. Never throws.
function verifyTicket(ticket, secret, now = Date.now()) {
  if (typeof ticket !== "string" || ticket.length > 8192)
    return null;

  const dot = ticket.indexOf(".");

  if (dot <= 0 || dot === ticket.length - 1)
    return null;

  const payloadPart = ticket.slice(0, dot);
  const signaturePart = ticket.slice(dot + 1);

  let payload = null;

  try {
    payload = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8"));
  } catch {
    // Not JSON: can only be a (bad) backend ticket; fall through.
  }

  if (payload?.v === 2)
    return verifyDeviceTicket(payloadPart, signaturePart, payload, now);

  if (!secret)
    return null;

  return verifyBackendTicket(payloadPart, signaturePart, secret, now);
}

module.exports = { issueTicket, verifyTicket, MAX_DEVICE_TICKET_TTL_SEC };
