const { contactCard, verifyCard } = require("./card");

// Pairing links: how one Connect device invites another.
//
//   peerpayload://pair#<base64url JSON {v: 1, card, secret, mailbox, exp}>
//
// card is the inviter's contact card; secret is 16 random bytes (base64url)
// the invitee returns in its pair-request; mailbox is where the inviter
// collects messages; exp is unix seconds. The fragment (#...) is never sent
// to a web server if someone opens the link in a browser.

const LINK_PREFIX = "peerpayload://pair#";
const INVITE_VERSION = 1;
const SECRET_BYTES = 16;

const isMailboxUrl = (v) => typeof v === "string" && /^https?:\/\//.test(v);

// identity: as for contactCard(). expiresAt in ms.
function encodeInviteLink({ identity, secret, mailbox, expiresAt }) {
  if (!isMailboxUrl(mailbox))
    throw new Error("an http(s) mailbox URL is required");

  const body = { v: INVITE_VERSION, card: contactCard(identity), secret, mailbox, exp: Math.floor(expiresAt / 1000) };

  return LINK_PREFIX + Buffer.from(JSON.stringify(body)).toString("base64url");
}

// Returns { card (verified), secret, mailbox, expiresAt (ms) }. Throws if
// malformed, tampered with or expired. Also accepts the bare base64 part
// (for pasting).
function parseInviteLink(link, { now = Date.now() } = {}) {
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

  if (typeof body.secret !== "string" || Buffer.from(body.secret, "base64url").length !== SECRET_BYTES)
    throw new Error("pairing link has no valid secret");

  if (!isMailboxUrl(body.mailbox))
    throw new Error("pairing link has no valid mailbox");

  if (!Number.isInteger(body.exp) || body.exp * 1000 < now)
    throw new Error("this pairing link has expired; ask for a new one");

  return { card: verifyCard(body.card), secret: body.secret, mailbox: body.mailbox, expiresAt: body.exp * 1000 };
}

module.exports = { LINK_PREFIX, SECRET_BYTES, encodeInviteLink, parseInviteLink };
