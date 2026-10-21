const crypto = require("crypto");

// Issues PeerPayload Connect relay tickets: signed by this device's own key,
// with no backend involved. relay/src/ticket.js verifies them; keep the
// format in sync (see the comment there).
//
//   sessionId       shared by both devices for this transfer (e.g. its transfer ID)
//   role            "sender" | "receiver"
//   peerFingerprint the other device's ID (its certificate's SHA-256)
//   certPem/keyPem  this device's identity (ppkeygen's device.crt / device.key)
function issueDeviceTicket({ sessionId, role, peerFingerprint, certPem, keyPem, ttlSec = 600 }, now = Date.now()) {
  const der = new crypto.X509Certificate(certPem).raw;
  const payload = {
    v: 2,
    t: sessionId,
    r: role,
    f: crypto.createHash("sha256").update(der).digest("hex"),
    p: peerFingerprint.toLowerCase(),
    e: Math.floor(now / 1000) + ttlSec,
    c: der.toString("base64"),
  };
  const payloadPart = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = crypto.sign(null, Buffer.from(payloadPart), crypto.createPrivateKey(keyPem)).toString("base64url");

  return `${payloadPart}.${signature}`;
}

module.exports = { issueDeviceTicket };
