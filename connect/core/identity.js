const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

// A Connect device identity, all of it generated and kept on the device:
//
//   device.crt / device.key  Ed25519 signing key + self-signed certificate,
//                            made by the engine's ppkeygen. Used for TLS
//                            (mutual TLS between contacts) and to sign
//                            relay tickets and envelopes. The certificate's
//                            SHA-256 is the device ID ("fingerprint").
//   box.key                  X25519 key for receiving encrypted envelopes.
//                            Ed25519 keys can only sign, so encryption needs
//                            its own key; the public half travels in the
//                            contact card.
//   profile.json             the display name.
//
// Private keys are written owner-only where the OS supports file modes.

const CARD_VERSION = 1;

function fingerprintOfDer(der) {
  return crypto.createHash("sha256").update(der).digest("hex");
}

function writePrivate(file, contents) {
  fs.writeFileSync(file, contents, { mode: 0o600 });
}

// Creates a new identity in `dir` (refuses if one exists). keygenPath is
// the engine's ppkeygen binary.
function createIdentity({ dir, name, keygenPath }) {
  if (fs.existsSync(path.join(dir, "device.crt")))
    throw new Error(`an identity already exists in ${dir}`);

  if (typeof name !== "string" || !name.trim() || Buffer.byteLength(name) > 64)
    throw new Error("name must be 1-64 bytes");

  fs.mkdirSync(dir, { recursive: true });

  execFileSync(keygenPath, ["--out", dir, "--name", name.trim()], { stdio: ["ignore", "pipe", "pipe"] });

  const box = crypto.generateKeyPairSync("x25519");

  writePrivate(path.join(dir, "box.key"), box.privateKey.export({ type: "pkcs8", format: "pem" }));
  fs.writeFileSync(path.join(dir, "profile.json"), JSON.stringify({ name: name.trim(), createdAt: new Date().toISOString() }, null, 2));

  return loadIdentity(dir);
}

function loadIdentity(dir) {
  const certPath = path.join(dir, "device.crt");
  const keyPath = path.join(dir, "device.key");
  const certPem = fs.readFileSync(certPath, "utf8");
  const keyPem = fs.readFileSync(keyPath, "utf8");
  const cert = new crypto.X509Certificate(certPem);
  const signingKey = crypto.createPrivateKey(keyPem);
  const boxPrivateKey = crypto.createPrivateKey(fs.readFileSync(path.join(dir, "box.key"), "utf8"));
  const profile = JSON.parse(fs.readFileSync(path.join(dir, "profile.json"), "utf8"));

  return {
    dir,
    name: profile.name,
    fingerprint: fingerprintOfDer(cert.raw),
    certPath,
    keyPath,
    certPem,
    keyPem,
    certDer: cert.raw,
    signingKey,
    boxPrivateKey,
    boxPublic: crypto.createPublicKey(boxPrivateKey).export({ format: "jwk" }).x,
  };
}

function hasIdentity(dir) {
  return ["device.crt", "device.key", "box.key", "profile.json"].every((f) => fs.existsSync(path.join(dir, f)));
}

// What a contact needs to know about this device: name, device ID, the
// certificate (so the ID can be checked), and the encryption key.
function contactCard(identity) {
  return {
    v: CARD_VERSION,
    name: identity.name,
    fp: identity.fingerprint,
    cert: identity.certDer.toString("base64"),
    box: identity.boxPublic,
  };
}

// Validates a card from someone else. Throws on anything wrong; returns the
// card with derived key objects attached.
function verifyCard(card) {
  if (!card || card.v !== CARD_VERSION)
    throw new Error("unsupported contact card");

  if (typeof card.name !== "string" || !card.name.trim() || card.name.length > 64)
    throw new Error("bad name in contact card");

  if (!/^[0-9a-f]{64}$/.test(card.fp ?? ""))
    throw new Error("bad device ID in contact card");

  const der = Buffer.from(card.cert ?? "", "base64");

  if (fingerprintOfDer(der) !== card.fp)
    throw new Error("contact card certificate does not match its device ID");

  const cert = new crypto.X509Certificate(der);

  if (cert.publicKey.asymmetricKeyType !== "ed25519")
    throw new Error("contact card certificate is not Ed25519");

  if (typeof card.box !== "string" || Buffer.from(card.box, "base64url").length !== 32)
    throw new Error("bad encryption key in contact card");

  return {
    ...card,
    verifyKey: cert.publicKey,
    boxPublicKey: crypto.createPublicKey({ key: { kty: "OKP", crv: "X25519", x: card.box }, format: "jwk" }),
  };
}

// Short code two people can compare to be sure they paired the right
// devices (like Signal's safety numbers). Same on both sides.
function safetyCode(fpA, fpB) {
  const digest = crypto.createHash("sha256").update([fpA, fpB].sort().join(":")).digest();
  const digits = [];

  for (let i = 0; i < 6; i++)
    digits.push(String(digest.readUInt32BE(i * 4) % 100000).padStart(5, "0"));

  return digits.join(" ");
}

module.exports = { createIdentity, loadIdentity, hasIdentity, contactCard, verifyCard, safetyCode, fingerprintOfDer };
