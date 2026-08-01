import { Notification } from "electron";
import path from "path";
import os from "os";

import * as socketBus from "./socket";
import { getApiClient } from "./apiClient";
import { runReceive } from "./transferRunner";

export const DOWNLOADS_DIR = path.join(os.homedir(), "Downloads", "PeerPayload");

let autoAccept = false;
let sendToRenderer = null;
let getMainWindow = null;

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
socketBus.events.on("incoming-transfer", (transfer) => {
  sendToRenderer?.("incoming-transfer", transfer);

  if (autoAccept) {
    acceptIncoming(transfer.id).catch((err) => console.error("auto-accept failed:", err.message));
    return;
  }

  const notification = new Notification({
    title: `${transfer.senderUsername} wants to send you a file`,
    body: transfer.fileCount
      ? `${transfer.fileCount} file(s), ${transfer.totalBytes ? Math.round(transfer.totalBytes / 1024 / 1024) : "?"} MB`
      : "Open PeerPayload to accept or decline.",
  });

  notification.on("click", () => getMainWindow?.()?.show());
  notification.show();
});
