const crypto = require("crypto");

// Relay tickets: short-lived, signed permission for one side of one
// transfer to use the relay. The backend issues them (it knows who is a
// party to which transfer); the relay only checks the signature, so it needs
// no database and can run anywhere, as many copies as needed.
//
// Format: base64url(JSON payload) + "." + base64url(HMAC-SHA256(secret, payload part))
// Payload: { t: transferId, r: "sender" | "receiver", e: expiry (unix seconds) }
//
// backend/src/relayTickets.js has the issuing half; keep the two in sync.

const ROLES = new Set(["sender", "receiver"]);

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

// Returns { transferId, role } or null. Never throws on bad input.
function verifyTicket(ticket, secret, now = Date.now()) {
  if (typeof ticket !== "string" || ticket.length > 1024)
    return null;

  const dot = ticket.indexOf(".");

  if (dot <= 0)
    return null;

  const payloadPart = ticket.slice(0, dot);
  const given = Buffer.from(ticket.slice(dot + 1), "base64url");
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

  return { transferId: payload.t, role: payload.r };
}

module.exports = { issueTicket, verifyTicket };
