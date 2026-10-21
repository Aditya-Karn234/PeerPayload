const crypto = require("crypto");

// Signature checks for the mailbox. It never decrypts anything; it only
// confirms who sent an envelope (for rate limits) and who is collecting an
// inbox. Formats must match connect/core (envelope.js, mailboxClient.js);
// kept as a copy so this service deploys on its own.

const FP = /^[0-9a-f]{64}$/;

function fingerprintOfDer(der) {
  return crypto.createHash("sha256").update(der).digest("hex");
}

// Ed25519 key of a base64 DER certificate, if it really is device `fp`.
function deviceKey(certB64, fp) {
  if (typeof certB64 !== "string" || certB64.length > 4096)
    return null;

  const der = Buffer.from(certB64, "base64");

  if (fingerprintOfDer(der) !== fp)
    return null;

  try {
    const key = new crypto.X509Certificate(der).publicKey;

    return key.asymmetricKeyType === "ed25519" ? key : null;
  } catch {
    return null;
  }
}

function envelopeSignedText(e) {
  return [e.v, e.to, e.from, e.ts, e.id, e.epk, e.iv, e.ct, e.cert].join(".");
}

// True if the envelope is well-formed and signed by its claimed sender.
function verifyEnvelope(e) {
  if (!e || e.v !== 1 || !FP.test(e.to ?? "") || !FP.test(e.from ?? "") || !Number.isInteger(e.ts))
    return false;

  for (const field of ["id", "epk", "iv", "ct", "sig", "cert"])
    if (typeof e[field] !== "string" || !e[field])
      return false;

  if (!/^[A-Za-z0-9_-]{16,64}$/.test(e.id))
    return false;

  const key = deviceKey(e.cert, e.from);

  if (!key)
    return false;

  try {
    return crypto.verify(null, Buffer.from(envelopeSignedText(e)), key, Buffer.from(e.sig, "base64url"));
  } catch {
    return false;
  }
}

// Inbox tokens: a device proving it holds its own key, to collect its
// envelopes. base64url(JSON {v: 1, purpose: "inbox", f, e, c}) "." Ed25519 sig.
const MAX_TOKEN_TTL_SEC = 15 * 60;

function verifyInboxToken(token, now = Date.now()) {
  if (typeof token !== "string" || token.length > 8192)
    return null;

  const dot = token.indexOf(".");

  if (dot <= 0)
    return null;

  const payloadPart = token.slice(0, dot);
  let payload;

  try {
    payload = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8"));
  } catch {
    return null;
  }

  if (payload?.v !== 1 || payload.purpose !== "inbox" || !FP.test(payload.f ?? "") || !Number.isInteger(payload.e))
    return null;

  const nowSec = Math.floor(now / 1000);

  if (payload.e < nowSec || payload.e > nowSec + MAX_TOKEN_TTL_SEC)
    return null;

  const key = deviceKey(payload.c, payload.f);

  if (!key)
    return null;

  try {
    if (!crypto.verify(null, Buffer.from(payloadPart), key, Buffer.from(token.slice(dot + 1), "base64url")))
      return null;
  } catch {
    return null;
  }

  return { fingerprint: payload.f };
}

module.exports = { verifyEnvelope, verifyInboxToken };
