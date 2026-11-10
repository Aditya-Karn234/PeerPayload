// Every PeerPayload wire format, defined once. See each file's header for
// the format itself:
//
//   device.js        device IDs (certificate SHA-256) and their keys
//   signedToken.js   the shape of device-signed tokens
//   inboxToken.js    Connect: a device collecting its mailbox inbox
//   relayTickets.js  relay access: Enterprise backend tickets, Connect device tickets
//   card.js          Connect contact cards
//   pairingLink.js   Connect pairing links
//   envelope.js      Connect envelopes (encrypted, signed messages)
//   messages.js      Connect message types carried inside envelopes
//
// The engine's own TCP protocol is C++ (shared/include/protocol.hpp).

module.exports = {
  ...require("./device"),
  ...require("./signedToken"),
  ...require("./inboxToken"),
  ...require("./relayTickets"),
  ...require("./card"),
  ...require("./pairingLink"),
  ...require("./envelope"),
  ...require("./messages"),
};
