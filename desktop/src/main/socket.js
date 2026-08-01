import { io } from "socket.io-client";
import { EventEmitter } from "events";

import config from "./config";

// Re-emits the backend's authenticated per-user signaling events
// (incoming-transfer/transfer-accepted/transfer-rejected/session-revoked)
// for the rest of the main process to react to — kept as a small
// EventEmitter wrapper (rather than every module importing socket.io
// directly) so the connect/reconnect lifecycle lives in exactly one place.
export const events = new EventEmitter();

events.setMaxListeners(0);

let socket = null;

export function connectSocket(token) {
  disconnectSocket();

  socket = io(config.serverUrl, { auth: { token } });

  socket.on("incoming-transfer", (transfer) => events.emit("incoming-transfer", transfer));
  socket.on("transfer-accepted", (transfer) => events.emit("transfer-accepted", transfer));
  socket.on("transfer-rejected", (transfer) => events.emit("transfer-rejected", transfer));
  socket.on("session-revoked", () => events.emit("session-revoked"));
}

export function disconnectSocket() {
  if (socket) {
    socket.close();
    socket = null;
  }
}
