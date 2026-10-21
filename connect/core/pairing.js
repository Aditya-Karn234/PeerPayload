const crypto = require("crypto");

const { contactCard, verifyCard } = require("./identity");

// Pairing links: how two people become contacts with no server vouching
// for anyone.
//
//   Alice shares a link (or its QR code) over any channel she trusts:
//     peerpayload://pair#<base64url JSON {v, card, secret, mailbox, exp}>
//   The fragment (#...) is never sent to a web server if someone opens the
//   link in a browser.
//
// Opening it gives Bob Alice's exact card (device ID, certificate,
// encryption key): he can verify her by construction. Bob then sends a
// pair-request envelope containing the one-time secret and his own card;
// Alice accepts it only if the secret matches an unused, unexpired invite
// of hers, which proves the request came from someone she gave the link
// to. Both sides end up holding each other's verified cards.

const LINK_PREFIX = "peerpayload://pair#";
const INVITE_VERSION = 1;
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

function hashSecret(secret) {
  return crypto.createHash("sha256").update(secret).digest("hex");
}

// Returns { link, secret, secretHash, expiresAt }. The caller stores
// secretHash + expiresAt as a pending invite (never the secret itself).
function createInvite(identity, { mailbox, ttlMs = DEFAULT_TTL_MS, now = Date.now() } = {}) {
  if (typeof mailbox !== "string" || !/^https?:\/\//.test(mailbox))
    throw new Error("an http(s) mailbox URL is required");

  const secret = crypto.randomBytes(16).toString("base64url");
  const expiresAt = now + ttlMs;
  const body = { v: INVITE_VERSION, card: contactCard(identity), secret, mailbox, exp: Math.floor(expiresAt / 1000) };

  return {
    link: LINK_PREFIX + Buffer.from(JSON.stringify(body)).toString("base64url"),
    secret,
    secretHash: hashSecret(secret),
    expiresAt,
  };
}

// Parses and verifies a link someone shared. Returns { card, secret,
// mailbox, expiresAt } with a verified card. Throws if malformed, tampered
// with or expired. Also accepts the bare base64 part (for pasting).
function parseInvite(link, { now = Date.now() } = {}) {
  const text = String(link ?? "").trim();
  const encoded = text.startsWith(LINK_PREFIX) ? text.slice(LINK_PREFIX.length) : text;

  let body;

  try {
    body = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    throw new Error("not a PeerPayload pairing link");
  }

  if (body?.v !== INVITE_VERSION)
    throw new Error("unsupported pairing link");

  if (typeof body.secret !== "string" || Buffer.from(body.secret, "base64url").length !== 16)
    throw new Error("pairing link has no valid secret");

  if (typeof body.mailbox !== "string" || !/^https?:\/\//.test(body.mailbox))
    throw new Error("pairing link has no valid mailbox");

  if (!Number.isInteger(body.exp) || body.exp * 1000 < now)
    throw new Error("this pairing link has expired; ask for a new one");

  return { card: verifyCard(body.card), secret: body.secret, mailbox: body.mailbox, expiresAt: body.exp * 1000 };
}

module.exports = { createInvite, parseInvite, hashSecret, LINK_PREFIX };
