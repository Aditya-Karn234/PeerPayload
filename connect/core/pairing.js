const crypto = require("crypto");

const { encodeInviteLink, parseInviteLink, LINK_PREFIX } = require("peerpayload-protocol");

// Pairing links: how two people become contacts with no server vouching
// for anyone.
//
//   Alice shares a link (or its QR code) over any channel she trusts
//   (format: protocol/pairingLink.js).
//
// Opening it gives Bob Alice's exact card (device ID, certificate,
// encryption key): he can verify her by construction. Bob then sends a
// pair-request envelope containing the one-time secret and his own card;
// Alice accepts it only if the secret matches an unused, unexpired invite
// of hers, which proves the request came from someone she gave the link
// to. Both sides end up holding each other's verified cards.

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

function hashSecret(secret) {
  return crypto.createHash("sha256").update(secret).digest("hex");
}

// Returns { link, secret, secretHash, expiresAt }. The caller stores
// secretHash + expiresAt as a pending invite (never the secret itself).
function createInvite(identity, { mailbox, ttlMs = DEFAULT_TTL_MS, now = Date.now() } = {}) {
  const secret = crypto.randomBytes(16).toString("base64url");
  const expiresAt = now + ttlMs;

  return { link: encodeInviteLink({ identity, secret, mailbox, expiresAt }), secret, secretHash: hashSecret(secret), expiresAt };
}

// Parses and verifies a link someone shared. Returns { card, secret,
// mailbox, expiresAt } with a verified card. Throws if malformed, tampered
// with or expired. Also accepts the bare base64 part (for pasting).
const parseInvite = parseInviteLink;

module.exports = { createInvite, parseInvite, hashSecret, LINK_PREFIX };
