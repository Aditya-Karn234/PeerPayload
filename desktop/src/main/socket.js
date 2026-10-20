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

// After the server's auth middleware refuses a connection, socket.io-client
// stops reconnecting on its own (socket.active becomes false). Retry those
// ourselves unless the refusal means the token itself is bad.
const RETRY_AFTER_REFUSAL_MS = 5000;

export function connectSocket(token) {
  disconnectSocket();

  const current = io(config.serverUrl, { auth: { token } });

  socket = current;

  // Fires on the first connection and on every reconnection. Pushes sent
  // while disconnected are gone for good, so listeners use this to catch up.
  current.on("connect", () => events.emit("connected"));

  current.on("disconnect", (reason) => {
    console.warn("signaling socket disconnected:", reason);
    events.emit("disconnected", reason);
  });

  current.on("connect_error", (err) => {
    console.warn("signaling socket connect failed:", err.message);

    if (err.message === "unauthorized") {
      events.emit("unauthorized");
      return;
    }

    if (!current.active)
      setTimeout(() => {
        if (socket === current && !current.connected)
          current.connect();
      }, RETRY_AFTER_REFUSAL_MS);
  });

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
