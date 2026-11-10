const crypto = require("crypto");

// Device IDs. A device's identity is an Ed25519 key with a self-signed
// certificate (made by the engine's ppkeygen); its ID ("fingerprint") is
// the SHA-256 of that certificate's DER, as lowercase hex. Anything that
// carries a device ID next to a certificate (cards, envelopes, tokens,
// tickets) is checked with deviceKey().

const FINGERPRINT = /^[0-9a-f]{64}$/;
const MAX_CERT_B64 = 4096;

const isFingerprint = (s) => typeof s === "string" && FINGERPRINT.test(s);

function fingerprintOfDer(der) {
  return crypto.createHash("sha256").update(der).digest("hex");
}

// The Ed25519 public key in a certificate (base64 DER string or Buffer),
// if that certificate really is device `fingerprint`. Otherwise null.
function deviceKey(cert, fingerprint) {
  if (typeof cert === "string" && cert.length > MAX_CERT_B64)
    return null;

  const der = typeof cert === "string" ? Buffer.from(cert, "base64") : cert;

  if (!Buffer.isBuffer(der) || fingerprintOfDer(der) !== fingerprint)
    return null;

  try {
    const key = new crypto.X509Certificate(der).publicKey;

    // Device identities are Ed25519; accept nothing else.
    return key.asymmetricKeyType === "ed25519" ? key : null;
  } catch {
    return null;
  }
}

module.exports = { FINGERPRINT, isFingerprint, fingerprintOfDer, deviceKey };
