const { EventEmitter } = require("events");

// The bridge between route handlers and server.js's socket.io wiring — kept
// as a separate plain EventEmitter (rather than routes reaching into `io`
// directly) so persistence/business logic and live push stay independent
// concerns, same reasoning the old transferService.bus used for the
// personal-tool's progress relay.
//
// Events: "incoming-transfer" (userId, transfer), "transfer-accepted"
// (userId, transfer), "transfer-rejected" (userId, transfer),
// "session-revoked" (userId).
const signalBus = new EventEmitter();

signalBus.setMaxListeners(0);

module.exports = signalBus;
