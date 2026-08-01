import { autoUpdater } from "electron-updater";
import { Notification } from "electron";

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours

// Downloads happen automatically once an update is found, but installation
// waits for the app's next natural quit — never force-restarts a client
// mid-transfer just because an update landed. Points at whatever generic
// HTTP feed electron-builder.yml's publish.url configures (baked in at
// build time), not GitHub/S3, matching "internal network only."
export function initAutoUpdater() {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("update-downloaded", (info) => {
    new Notification({
      title: "orgxfer update ready",
      body: `Version ${info.version} will install the next time you quit.`,
    }).show();
  });

  autoUpdater.on("error", (err) => {
    console.error("auto-update check failed:", err.message);
  });

  checkForUpdates();
  setInterval(checkForUpdates, CHECK_INTERVAL_MS);
}

function checkForUpdates() {
  autoUpdater.checkForUpdates().catch((err) => console.error("checkForUpdates failed:", err.message));
}
