const crypto = require("crypto");

const { isFingerprint, deviceKey } = require("./device");

// Contact cards: what one Connect device gives another (inside a pairing
// link or a pair-request message) so it can verify and encrypt to it.
//
//   {v: 1, name, fp: device ID, cert: base64 DER certificate, box: base64url raw X25519 public key}

const CARD_VERSION = 1;
const MAX_NAME_LENGTH = 64;

// identity: { name, fingerprint, certDer, boxPublic } (connect/core loadIdentity)
function contactCard(identity) {
  return {
    v: CARD_VERSION,
    name: identity.name,
    fp: identity.fingerprint,
    cert: identity.certDer.toString("base64"),
    box: identity.boxPublic,
  };
}

// Validates someone else's card. Throws on anything wrong; returns the
// card with key objects attached (verifyKey, boxPublicKey).
function verifyCard(card) {
  if (!card || card.v !== CARD_VERSION)
    throw new Error("unsupported contact card");

  if (typeof card.name !== "string" || !card.name.trim() || card.name.length > MAX_NAME_LENGTH)
    throw new Error("bad name in contact card");

  if (!isFingerprint(card.fp))
    throw new Error("bad device ID in contact card");

  const verifyKey = deviceKey(card.cert ?? "", card.fp);

  if (!verifyKey)
    throw new Error("contact card certificate does not match its device ID");

  if (typeof card.box !== "string" || Buffer.from(card.box, "base64url").length !== 32)
    throw new Error("bad encryption key in contact card");

  return {
    ...card,
    verifyKey,
    boxPublicKey: crypto.createPublicKey({ key: { kty: "OKP", crv: "X25519", x: card.box }, format: "jwk" }),
  };
}

module.exports = { CARD_VERSION, MAX_NAME_LENGTH, contactCard, verifyCard };
