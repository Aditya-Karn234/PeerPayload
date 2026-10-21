const net = require("net");

const { verifyCard } = require("./card");

// Connect messages: the payloads carried inside envelopes. Every type is
// declared once below as { field: check }. Senders build messages with
// makeMessage() (which refuses a malformed one) and receivers read them
// with parseMessage() (which returns null for anything malformed), so the
// two can't drift apart.
//
// Adding a message type: add an entry to MESSAGES. Adding a field to an
// existing type: wrap its check in optional(), so devices running the
// previous version, which don't send it, are still understood. Unknown
// extra fields are dropped, so newer senders don't break older receivers.

const INVALID = Symbol("invalid");

// ---- field checks: value -> normalised value, or INVALID ----

const str = (max, pattern) => (v) => (typeof v === "string" && v.length >= 1 && v.length <= max && (!pattern || pattern.test(v)) ? v : INVALID);

const int = (min, max = Number.MAX_SAFE_INTEGER) => (v) => (Number.isSafeInteger(v) && v >= min && v <= max ? v : INVALID);

const bool = (v) => (typeof v === "boolean" ? v : INVALID);

const url = str(512, /^https?:\/\/[^\s]+$/);

const ip = (v) => (typeof v === "string" && net.isIP(v) ? v : INVALID);

const optional = (check) => (v) => (v === undefined ? undefined : check(v));

function list(check, max) {
  return (v) => {
    if (!Array.isArray(v) || v.length > max)
      return INVALID;

    const out = v.map(check);

    return out.includes(INVALID) ? INVALID : out;
  };
}

function object(fields) {
  return (v) => {
    if (!v || typeof v !== "object" || Array.isArray(v))
      return INVALID;

    const out = {};

    for (const [name, check] of Object.entries(fields)) {
      const value = check(v[name]);

      if (value === INVALID)
        return INVALID;

      if (value !== undefined)
        out[name] = value;
    }

    return out;
  };
}

// A contact card, verified (signature, device ID); comes back with key objects.
const card = (v) => {
  try {
    return verifyCard(v);
  } catch {
    return INVALID;
  }
};

const transferId = str(64, /^[A-Za-z0-9_-]{8,64}$/);

const MAX_OFFER_NAMES = 50;

// ---- the messages ----

const MESSAGES = {
  // Pairing: the device that opened an invite link introduces itself to
  // the inviter, proving it saw the link by returning the link's secret,
  // and says which mailbox to answer it at.
  "pair-request": {
    fields: { secret: str(64, /^[A-Za-z0-9_-]+$/), card, mailbox: optional(url) },
  },
  // The inviter accepted; both sides are now paired.
  "pair-accept": { fields: {} },

  // Transfers (connect/core/transfers.js).
  offer: {
    fields: {
      transferId,
      // Top-level items being sent: a file, or a folder with its file count.
      files: list(object({ name: str(255), size: int(0), files: int(0) }), MAX_OFFER_NAMES),
      fileCount: int(0),
      totalBytes: int(0),
    },
  },
  accept: {
    fields: {
      transferId,
      token: str(63), // the engine's limit (TOKEN_LEN - 1)
      port: int(1, 65535),
      addresses: list(ip, 16),
      relay: bool,
    },
    // The sender needs some way to reach the receiver.
    check: (m) => m.addresses.length > 0 || m.relay,
  },
  decline: { fields: { transferId } },
  // The sender gave up: before an answer, or after the transfer failed.
  cancel: { fields: { transferId } },
};

function validate(type, payload) {
  const spec = MESSAGES[type];

  if (!spec)
    return null;

  const fields = object(spec.fields)(payload);

  if (fields === INVALID || (spec.check && !spec.check(fields)))
    return null;

  return { type, ...fields };
}

// Payload received in an envelope -> { type, ...fields }, or null when the
// type is unknown or anything is malformed.
function parseMessage(payload) {
  return payload && typeof payload === "object" ? validate(payload.type, payload) : null;
}

// Builds a payload to send. Throws if it wouldn't pass parseMessage() on
// the other side: a bug here should fail loudly, not be silently dropped.
function makeMessage(type, fields = {}) {
  const message = validate(type, fields);

  if (!message)
    throw new Error(`invalid ${type} message`);

  // Cards travel as plain JSON, not with their key objects.
  if (message.card)
    message.card = { v: message.card.v, name: message.card.name, fp: message.card.fp, cert: message.card.cert, box: message.card.box };

  return message;
}

module.exports = { MESSAGES, MAX_OFFER_NAMES, parseMessage, makeMessage };
