const crypto = require("crypto");

const { fingerprintOfDer } = require("./identity");

// Envelopes: how one Connect device sends a small message to another
// through the (untrusted) mailbox. Each envelope is
//
//   encrypted  to the recipient's X25519 key: a fresh ephemeral X25519 key
//              per envelope, ECDH, HKDF-SHA256 -> AES-256-GCM. Only the
//              recipient can read it; the mailbox can't.
//   signed     by the sender's Ed25519 device key over every other field,
//              so the recipient (and the mailbox, for rate limiting) knows
//              which device sent it and that nothing was changed.
//
// connect/mailbox/src/envelope.js verifies the same format (signature and
// shape only, never decrypts); keep the two in sync.

const VERSION = 1;
const MAX_PAYLOAD_BYTES = 32 * 1024;

const b64u = (buf) => Buffer.from(buf).toString("base64url");

// Everything the signature covers, in a fixed order.
function signedText(e) {
  return [e.v, e.to, e.from, e.ts, e.id, e.epk, e.iv, e.ct, e.cert].join(".");
}

function deriveKey(sharedSecret, e) {
  return Buffer.from(crypto.hkdfSync("sha256", sharedSecret, Buffer.from(e.id, "base64url"), `peerpayload-envelope-v1|${e.from}|${e.to}`, 32));
}

function aad(e) {
  return Buffer.from(`${e.v}|${e.from}|${e.to}|${e.id}|${e.ts}`);
}

// identity: our own (loadIdentity). recipient: a verified contact card
// (verifyCard). payload: any JSON-serialisable object.
function seal({ identity, recipient, payload, now = Date.now() }) {
  const plaintext = Buffer.from(JSON.stringify(payload));

  if (plaintext.length > MAX_PAYLOAD_BYTES)
    throw new Error(`envelope payload too large (${plaintext.length} bytes)`);

  const ephemeral = crypto.generateKeyPairSync("x25519");
  const envelope = {
    v: VERSION,
    to: recipient.fp,
    from: identity.fingerprint,
    ts: Math.floor(now / 1000),
    id: b64u(crypto.randomBytes(16)),
    epk: ephemeral.publicKey.export({ format: "jwk" }).x,
    iv: b64u(crypto.randomBytes(12)),
    ct: "",
    cert: identity.certDer.toString("base64"),
  };

  const key = deriveKey(crypto.diffieHellman({ privateKey: ephemeral.privateKey, publicKey: recipient.boxPublicKey }), envelope);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64url"));

  cipher.setAAD(aad(envelope));
  envelope.ct = b64u(Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]));
  envelope.sig = b64u(crypto.sign(null, Buffer.from(signedText(envelope)), identity.signingKey));

  return envelope;
}

// Checks shape, that the certificate is the sender's claimed device, and
// the signature. Returns the sender's verify key, or throws. Used by
// open() and mirrored by the mailbox.
function verifySignature(e) {
  if (!e || e.v !== VERSION)
    throw new Error("unsupported envelope");

  for (const field of ["to", "from"])
    if (!/^[0-9a-f]{64}$/.test(e[field] ?? ""))
      throw new Error(`bad ${field}`);

  for (const field of ["id", "epk", "iv", "ct", "sig", "cert"])
    if (typeof e[field] !== "string" || !e[field])
      throw new Error(`missing ${field}`);

  if (!Number.isInteger(e.ts))
    throw new Error("bad ts");

  const der = Buffer.from(e.cert, "base64");

  if (fingerprintOfDer(der) !== e.from)
    throw new Error("sender certificate does not match sender ID");

  const verifyKey = new crypto.X509Certificate(der).publicKey;

  if (verifyKey.asymmetricKeyType !== "ed25519" || !crypto.verify(null, Buffer.from(signedText(e)), verifyKey, Buffer.from(e.sig, "base64url")))
    throw new Error("bad envelope signature");

  return verifyKey;
}

// Verifies and decrypts an envelope addressed to `identity`. Returns
// { from, id, ts, cert, payload }. Throws if it's not for us, forged,
// tampered with, or undecryptable.
function open(envelope, identity) {
  verifySignature(envelope);

  if (envelope.to !== identity.fingerprint)
    throw new Error("envelope is not addressed to this device");

  const epk = crypto.createPublicKey({ key: { kty: "OKP", crv: "X25519", x: envelope.epk }, format: "jwk" });
  const key = deriveKey(crypto.diffieHellman({ privateKey: identity.boxPrivateKey, publicKey: epk }), envelope);
  const data = Buffer.from(envelope.ct, "base64url");

  if (data.length < 16)
    throw new Error("ciphertext too short");

  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64url"));

  decipher.setAAD(aad(envelope));
  decipher.setAuthTag(data.subarray(data.length - 16));

  const plaintext = Buffer.concat([decipher.update(data.subarray(0, data.length - 16)), decipher.final()]);

  return { from: envelope.from, id: envelope.id, ts: envelope.ts, cert: envelope.cert, payload: JSON.parse(plaintext.toString("utf8")) };
}

module.exports = { seal, open, verifySignature, MAX_PAYLOAD_BYTES };
