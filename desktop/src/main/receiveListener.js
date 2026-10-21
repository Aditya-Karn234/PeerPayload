import { Notification } from "electron";
import path from "path";
import os from "os";

import * as socketBus from "./socket";
import { getApiClient, getTokenStore } from "./apiClient";
import { runReceive } from "./transferRunner";

export const DOWNLOADS_DIR = path.join(os.homedir(), "Downloads", "PeerPayload");

let autoAccept = false;
let sendToRenderer = null;
let getMainWindow = null;

// Transfer ids already offered to the user (by push or catch-up), so a
// reconnect doesn't re-notify or auto-accept the same transfer twice.
const offered = new Set();

export function init({ onSendToRenderer, onGetMainWindow }) {
  sendToRenderer = onSendToRenderer;
  getMainWindow = onGetMainWindow;
}

export function setAutoAccept(value) {
  autoAccept = Boolean(value);
}

export function getAutoAccept() {
  return autoAccept;
}

export async function acceptIncoming(transferId) {
  return runReceive({ transferId, outputDir: DOWNLOADS_DIR }, (progress) => {
    sendToRenderer?.("transfer-progress", progress);
  });
}

export async function rejectIncoming(transferId) {
  await getApiClient().rejectTransfer(transferId);
}

// Fires for every transfer offered to this user, whether or not the window
// is focused — this is the whole point of running in the background/tray:
// an incoming transfer shouldn't require the app to already be in the
// foreground to be noticed.
function handleIncoming(transfer) {
  if (offered.has(transfer.id))
    return;

  offered.add(transfer.id);

  sendToRenderer?.("incoming-transfer", transfer);

  if (autoAccept) {
    acceptIncoming(transfer.id).catch((err) => console.error("auto-accept failed:", err.message));
    return;
  }

  const notification = new Notification({
    title: `${transfer.senderUsername} wants to send you a file`,
    body: transfer.fileCount
      ? `${transfer.fileCount} file(s), ${transfer.totalBytes ? Math.round(transfer.totalBytes / 1024 / 1024) : "?"} MB`
      : "Open PeerPayload Enterprise to accept or decline.",
  });

  notification.on("click", () => getMainWindow?.()?.show());
  notification.show();
}

socketBus.events.on("incoming-transfer", handleIncoming);

// A push sent while this app was disconnected (asleep, offline, backend
// restarting) is lost. On every (re)connect, look up offers still pending
// for this user and handle any that weren't seen.
socketBus.events.on("connected", async () => {
  const me = getTokenStore().get()?.username;

  if (!me)
    return;

  try {
    const transfers = await getApiClient().listTransfers();

    for (const transfer of transfers)
      if (transfer.status === "pending" && transfer.receiverUsername === me)
        handleIncoming(transfer);
  } catch (err) {
    console.warn("pending-offer catch-up failed:", err.message);
  }
});
