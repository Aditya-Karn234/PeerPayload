const { signDeviceToken, verifyDeviceToken } = require("./signedToken");

// Inbox tokens: a Connect device proving to the mailbox that it holds its
// own key, so it may collect envelopes addressed to it.
//   payload {v: 1, purpose: "inbox", f: device ID, e: expiry, c: certificate}

const MAX_INBOX_TOKEN_TTL_SEC = 15 * 60;

// identity: { fingerprint, certDer, signingKey } (connect/core loadIdentity)
function issueInboxToken(identity, { ttlSec = 600, now = Date.now() } = {}) {
  return signDeviceToken(
    { v: 1, purpose: "inbox", f: identity.fingerprint, e: Math.floor(now / 1000) + ttlSec, c: identity.certDer.toString("base64") },
    identity.signingKey
  );
}

// { fingerprint } of the device collecting its inbox, or null.
function verifyInboxToken(token, now = Date.now()) {
  const payload = verifyDeviceToken(token, { now, maxTtlSec: MAX_INBOX_TOKEN_TTL_SEC });

  return payload?.v === 1 && payload.purpose === "inbox" ? { fingerprint: payload.f } : null;
}

module.exports = { issueInboxToken, verifyInboxToken, MAX_INBOX_TOKEN_TTL_SEC };
