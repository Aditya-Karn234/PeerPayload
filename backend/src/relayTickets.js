const crypto = require("crypto");

// Issues relay tickets: short-lived, signed permission for one side of one
// transfer to use the relay. The relay (relay/src/ticket.js) verifies the
// signature with the same RELAY_SECRET and needs nothing else — no database,
// no call back here. Keep this format in sync with relay/src/ticket.js:
//
//   base64url(JSON {t: transferId, r: role, e: expiry unix s}) "." base64url(HMAC-SHA256)
function issueRelayTicket({ transferId, role, ttlSec }, secret, now = Date.now()) {
  const payload = { t: transferId, r: role, e: Math.floor(now / 1000) + ttlSec };
  const payloadPart = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = crypto.createHmac("sha256", secret).update(payloadPart).digest("base64url");

  return { ticket: `${payloadPart}.${signature}`, expiresAt: new Date(payload.e * 1000) };
}

module.exports = { issueRelayTicket };
