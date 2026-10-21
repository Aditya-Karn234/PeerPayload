const crypto = require("crypto");

const { ENVELOPE_VERSION, MAX_PAYLOAD_BYTES, signedText, aad, deriveKey, verifyEnvelopeSignature } = require("peerpayload-protocol");

// Sealing and opening Connect envelopes. The format, key schedule and
// signature check are in protocol/envelope.js (shared with the mailbox);
// this is the half that needs the devices' private keys.

const b64u = (buf) => Buffer.from(buf).toString("base64url");

// identity: our own (loadIdentity). recipient: a verified contact card
// (verifyCard). payload: any JSON-serialisable object.
function seal({ identity, recipient, payload, now = Date.now() }) {
  const plaintext = Buffer.from(JSON.stringify(payload));

  if (plaintext.length > MAX_PAYLOAD_BYTES)
    throw new Error(`envelope payload too large (${plaintext.length} bytes)`);

  const ephemeral = crypto.generateKeyPairSync("x25519");
  const envelope = {
    v: ENVELOPE_VERSION,
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

// Verifies and decrypts an envelope addressed to `identity`. Returns
// { from, id, ts, cert, payload }. Throws if it's not for us, forged,
// tampered with, or undecryptable.
function open(envelope, identity) {
  verifyEnvelopeSignature(envelope);

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

module.exports = { seal, open, verifySignature: verifyEnvelopeSignature, MAX_PAYLOAD_BYTES };
