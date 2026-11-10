const crypto = require("crypto");

const { isFingerprint, deviceKey } = require("./device");

// Connect envelopes: a small message from one device to another through
// the (untrusted) mailbox.
//
//   {v: 1, to, from, ts, id, epk, iv, ct, cert, sig}
//
//   encrypted  to the recipient's X25519 key: a fresh ephemeral X25519 key
//              (epk) per envelope, ECDH, HKDF-SHA256 -> AES-256-GCM (ct,
//              tag appended). Only the recipient can read it.
//   signed     (sig) by the sender's Ed25519 device key over every other
//              field, so the recipient and the mailbox know which device
//              sent it and that nothing was changed.
//
// Sealing and opening need the devices' private keys and live in
// connect/core/envelope.js; the format, key schedule and signature check
// are here so the mailbox checks exactly what clients produce.

const ENVELOPE_VERSION = 1;
const MAX_PAYLOAD_BYTES = 32 * 1024;
const ENVELOPE_ID = /^[A-Za-z0-9_-]{16,64}$/;

// Everything the signature covers, in a fixed order.
function signedText(e) {
  return [e.v, e.to, e.from, e.ts, e.id, e.epk, e.iv, e.ct, e.cert].join(".");
}

// Bound into the AES-GCM tag.
function aad(e) {
  return Buffer.from(`${e.v}|${e.from}|${e.to}|${e.id}|${e.ts}`);
}

function deriveKey(sharedSecret, e) {
  return Buffer.from(crypto.hkdfSync("sha256", sharedSecret, Buffer.from(e.id, "base64url"), `peerpayload-envelope-v1|${e.from}|${e.to}`, 32));
}

// Checks shape, that the certificate is the claimed sender's, and the
// signature. Returns the sender's verify key; throws with the reason.
function verifyEnvelopeSignature(e) {
  if (!e || e.v !== ENVELOPE_VERSION)
    throw new Error("unsupported envelope");

  for (const field of ["to", "from"])
    if (!isFingerprint(e[field]))
      throw new Error(`bad ${field}`);

  for (const field of ["id", "epk", "iv", "ct", "sig", "cert"])
    if (typeof e[field] !== "string" || !e[field])
      throw new Error(`missing ${field}`);

  if (!ENVELOPE_ID.test(e.id))
    throw new Error("bad id");

  if (!Number.isInteger(e.ts))
    throw new Error("bad ts");

  const key = deviceKey(e.cert, e.from);

  if (!key)
    throw new Error("sender certificate does not match sender ID");

  let valid = false;

  try {
    valid = crypto.verify(null, Buffer.from(signedText(e)), key, Buffer.from(e.sig, "base64url"));
  } catch {
    // stays false
  }

  if (!valid)
    throw new Error("bad envelope signature");

  return key;
}

module.exports = { ENVELOPE_VERSION, MAX_PAYLOAD_BYTES, signedText, aad, deriveKey, verifyEnvelopeSignature };
