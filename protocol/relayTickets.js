const crypto = require("crypto");

const { isFingerprint } = require("./device");
const { signDeviceToken, parseToken, verifyDeviceToken } = require("./signedToken");

// Relay tickets: short-lived, signed permission for one side of one
// transfer to use the relay. The relay only checks signatures, so it needs
// no database. Two kinds:
//
// 1. Backend tickets (Enterprise). The backend knows who is a party to
//    which transfer and signs with a secret it shares with the relay.
//      base64url(JSON {t: transferId, r: role, e: expiry}) "." base64url(HMAC-SHA256(secret))
//
// 2. Device tickets (Connect). No backend: each device signs its own
//    ticket (see signedToken.js) and names the device it wants to meet.
//      payload {v: 2, t: sessionId, r: role, f: own ID, p: peer ID, e: expiry, c: certificate}
//    The relay pairs two sides only when each names the other, so a third
//    device can't join.

const ROLES = new Set(["sender", "receiver"]);
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;

// Device tickets are signed by the device itself, so cap how far ahead they
// may be valid: a leaked one can't be replayed for long.
const MAX_DEVICE_TICKET_TTL_SEC = 15 * 60;

const hmac = (payloadPart, secret) => crypto.createHmac("sha256", secret).update(payloadPart).digest("base64url");

// Returns { ticket, expiresAt }.
function issueBackendTicket({ transferId, role, ttlSec }, secret, now = Date.now()) {
  const payload = { t: transferId, r: role, e: Math.floor(now / 1000) + ttlSec };
  const payloadPart = Buffer.from(JSON.stringify(payload)).toString("base64url");

  return { ticket: `${payloadPart}.${hmac(payloadPart, secret)}`, expiresAt: new Date(payload.e * 1000) };
}

//   sessionId       shared by both devices for this transfer (e.g. its transfer ID)
//   role            "sender" | "receiver"
//   peerFingerprint the other device's ID
//   certPem/keyPem  this device's identity (ppkeygen's device.crt / device.key)
function issueDeviceTicket({ sessionId, role, peerFingerprint, certPem, keyPem, ttlSec = 600 }, now = Date.now()) {
  const der = new crypto.X509Certificate(certPem).raw;

  return signDeviceToken(
    {
      v: 2,
      t: sessionId,
      r: role,
      f: crypto.createHash("sha256").update(der).digest("hex"),
      p: peerFingerprint.toLowerCase(),
      e: Math.floor(now / 1000) + ttlSec,
      c: der.toString("base64"),
    },
    crypto.createPrivateKey(keyPem)
  );
}

function verifyBackendTicket({ payloadPart, signaturePart, payload }, secret, now) {
  const given = Buffer.from(signaturePart, "base64url");
  const expected = Buffer.from(hmac(payloadPart, secret), "base64url");

  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected))
    return null;

  if (typeof payload?.t !== "string" || !payload.t || !ROLES.has(payload.r) || !Number.isInteger(payload.e))
    return null;

  if (payload.e * 1000 < now)
    return null;

  return { kind: "backend", transferId: payload.t, role: payload.r };
}

function verifyDeviceTicket(ticket, now) {
  const payload = verifyDeviceToken(ticket, { now, maxTtlSec: MAX_DEVICE_TICKET_TTL_SEC });

  if (!payload || !SESSION_ID.test(payload.t ?? "") || !ROLES.has(payload.r) || !isFingerprint(payload.p) || payload.f === payload.p)
    return null;

  // Both sides of a session share this key (IDs sorted), and nothing else
  // can: a third device's ID changes it, and backend transfer IDs never
  // start with "dev:".
  const pair = [payload.f, payload.p].sort().join(":");

  return { kind: "device", transferId: `dev:${payload.t}:${pair}`, role: payload.r, from: payload.f, to: payload.p };
}

// Returns { kind, transferId, role, (from, to) } or null. Never throws.
// Without a secret only device tickets are accepted.
function verifyTicket(ticket, secret, now = Date.now()) {
  const parsed = parseToken(ticket);

  if (!parsed)
    return null;

  if (parsed.payload?.v === 2)
    return verifyDeviceTicket(ticket, now);

  return secret ? verifyBackendTicket(parsed, secret, now) : null;
}

module.exports = { issueBackendTicket, issueDeviceTicket, verifyTicket, MAX_DEVICE_TICKET_TTL_SEC };
