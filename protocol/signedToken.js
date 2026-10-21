const crypto = require("crypto");

const { isFingerprint, deviceKey } = require("./device");

// The shape shared by every token a device signs for itself (inbox tokens,
// device relay tickets):
//
//   base64url(JSON payload) "." base64url(Ed25519 signature over the first part)
//
// where the payload carries the device's ID as `f`, its certificate as `c`
// (base64 DER) and an expiry `e` (unix seconds). Verifying checks the
// certificate is device `f` and signed the token, so nobody can claim
// another device's ID.

const MAX_TOKEN_LENGTH = 8192;

function signDeviceToken(payload, signingKey) {
  const payloadPart = Buffer.from(JSON.stringify(payload)).toString("base64url");

  return `${payloadPart}.${crypto.sign(null, Buffer.from(payloadPart), signingKey).toString("base64url")}`;
}

// Splits a token and decodes its payload. Null if it isn't token-shaped;
// payload is null if the first part isn't JSON.
function parseToken(token) {
  if (typeof token !== "string" || token.length > MAX_TOKEN_LENGTH)
    return null;

  const dot = token.indexOf(".");

  if (dot <= 0 || dot === token.length - 1)
    return null;

  const payloadPart = token.slice(0, dot);
  let payload = null;

  try {
    payload = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8"));
  } catch {
    // left null
  }

  return { payloadPart, signaturePart: token.slice(dot + 1), payload };
}

// Payload of a device-signed token if its signature, certificate and
// expiry check out (expiry no later than maxTtlSec from now). Else null.
function verifyDeviceToken(token, { now = Date.now(), maxTtlSec }) {
  const parsed = parseToken(token);
  const payload = parsed?.payload;

  if (!payload || !isFingerprint(payload.f) || !Number.isInteger(payload.e))
    return null;

  const nowSec = Math.floor(now / 1000);

  if (payload.e < nowSec || payload.e > nowSec + maxTtlSec)
    return null;

  const key = deviceKey(payload.c, payload.f);

  if (!key)
    return null;

  try {
    return crypto.verify(null, Buffer.from(parsed.payloadPart), key, Buffer.from(parsed.signaturePart, "base64url")) ? payload : null;
  } catch {
    return null;
  }
}

module.exports = { signDeviceToken, parseToken, verifyDeviceToken };
