import { app, BrowserWindow, clipboard, dialog, ipcMain, Notification, shell } from "electron";
import path from "path";
import QRCode from "qrcode";
import { createConnectNode } from "connect-core";

import { engine, keygenPath, identityDir, loadSettings, saveSettings } from "./config";
import { createTray } from "./tray";

// PeerPayload Connect's main process: owns the Connect node (connect-core)
// and exposes it to the window over IPC. All the product logic is in
// connect-core; this file is wiring.
//
// The app keeps running in the tray when its window is closed, so it can
// still receive: offers arrive as notifications. Quit is in the tray menu.

// Lets tests (and anyone wanting two devices on one machine) run separate
// instances: each needs its own identity, contacts and settings. Set before
// the single-instance lock, which is per data folder.
if (process.env.CONNECT_USER_DATA)
  app.setPath("userData", path.resolve(process.env.CONNECT_USER_DATA));

// One running copy per data folder: launching again (shortcut, Start menu)
// shows the window that's already running in the tray.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => showWindow());
  app.whenReady().then(start);
}

let mainWindow = null;
let node = null;
let tray = null;
let quitting = false;
let toldAboutTray = false;

const ACTIVE_STATES = new Set(["offered", "sending", "receiving"]);

function sendToRenderer(name, data) {
  mainWindow?.webContents.send("connect-event", { name, data });
}

function showWindow() {
  if (!mainWindow)
    return;

  if (mainWindow.isMinimized())
    mainWindow.restore();

  mainWindow.show();
  mainWindow.focus();
}

// Notifications only when the window isn't in front: otherwise the window
// itself already shows what happened.
function notify(title, body) {
  if (!Notification.isSupported() || (mainWindow?.isVisible() && mainWindow.isFocused()))
    return;

  const notification = new Notification({ title, body });

  notification.on("click", showWindow);
  notification.show();
}

const describe = (t) => (t.files?.length === 1 ? `“${t.files[0].name}”` : `${t.fileCount} files`);

// What's worth interrupting someone for, by transfer state change.
function notifyTransfer(t) {
  if (t.direction === "in" && t.state === "offered")
    notify(`${t.peerName} wants to send you ${describe(t)}`, "Open PeerPayload Connect to accept or decline.");
  else if (t.direction === "in" && t.state === "complete")
    notify(`Received ${describe(t)} from ${t.peerName}`, `Saved to ${t.downloadDir}`);
  else if (t.direction === "out" && t.state === "complete")
    notify(`Sent ${describe(t)} to ${t.peerName}`, "Delivered.");
  else if (t.state === "failed")
    notify(`Transfer with ${t.peerName} failed`, t.error ?? "");
}

function startNode() {
  const { mailboxUrl, relayUrl } = loadSettings();
  const lastState = new Map();

  node = createConnectNode({ dir: identityDir(), keygenPath, engine, mailboxUrl, relayUrl });

  for (const name of ["status", "contacts", "paired", "transfer"])
    node.on(name, (data) => sendToRenderer(name, data));

  node.on("status", () => tray?.rebuild());
  node.on("paired", (contact) => notify(`You and ${contact.name} are now paired`, "You can send each other files."));
  node.on("transfer", (t) => {
    // Progress updates repeat the state; notify on changes only.
    if (lastState.get(t.transferId) !== t.state) {
      lastState.set(t.transferId, t.state);
      notifyTransfer(t);
    }
  });
  node.on("log", (message) => console.log(`[connect] ${message}`));
}

function createWindow({ hidden }) {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 720,
    title: "PeerPayload Connect",
    show: !hidden,
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Close hides to the tray: the app keeps receiving.
  mainWindow.on("close", (event) => {
    if (quitting)
      return;

    event.preventDefault();
    mainWindow.hide();

    if (!toldAboutTray) {
      toldAboutTray = true;
      notify("PeerPayload Connect is still running", "It keeps receiving in the background. Quit from the tray icon.");
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  if (process.env.ELECTRON_RENDERER_URL)
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  else
    mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
}

function registerIpcHandlers() {
  ipcMain.handle("status", () => ({ ...node.status(), settings: loadSettings() }));
  ipcMain.handle("setup", (event, name) => node.setup(name));

  ipcMain.handle("save-settings", (event, changes) => {
    const urlsChanged = ["mailboxUrl", "relayUrl"].some((k) => k in changes && changes[k] !== loadSettings()[k]);

    // The node is rebuilt with the new addresses, which would drop
    // transfers in flight.
    if (urlsChanged && node.transfers().some((t) => ACTIVE_STATES.has(t.state)))
      throw new Error("Wait for the current transfers to finish before changing the mailbox or relay");

    const settings = saveSettings(changes);

    if (urlsChanged) {
      node.stop();
      startNode();
      sendToRenderer("status", node.status());
      tray?.rebuild();
    }

    return settings;
  });

  ipcMain.handle("create-invite", async () => {
    const invite = node.createInvite();

    return { ...invite, qr: await QRCode.toDataURL(invite.link, { errorCorrectionLevel: "L", margin: 1, width: 260 }) };
  });

  ipcMain.handle("add-contact", (event, link) => node.addContact(link));
  ipcMain.handle("contacts", () => node.contacts());
  ipcMain.handle("remove-contact", (event, fp) => node.removeContact(fp));

  // One mode per dialog: Windows/Linux can't offer files and folders in
  // the same native picker.
  ipcMain.handle("pick-paths", async (event, mode) => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: mode === "folder" ? ["openDirectory"] : ["openFile", "multiSelections"],
    });

    return result.canceled ? [] : result.filePaths;
  });

  ipcMain.handle("pick-download-dir", async () => {
    const result = await dialog.showOpenDialog(mainWindow, { properties: ["openDirectory", "createDirectory"] });

    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle("send", (event, { fp, paths }) => node.send(fp, paths));
  ipcMain.handle("accept", (event, transferId) => node.accept(transferId, loadSettings().downloadDir));
  ipcMain.handle("decline", (event, transferId) => node.decline(transferId));
  ipcMain.handle("cancel-offer", (event, transferId) => node.cancelOffer(transferId));
  ipcMain.handle("pause", (event, transferId) => node.pause(transferId));
  ipcMain.handle("resume", (event, transferId) => node.resume(transferId));
  ipcMain.handle("clear-finished", () => node.clearFinished());
  ipcMain.handle("transfers", () => node.transfers());

  ipcMain.handle("copy", (event, text) => clipboard.writeText(String(text)));
  ipcMain.handle("open-downloads", () => shell.openPath(loadSettings().downloadDir));
}

function quit() {
  const running = node.transfers().filter((t) => t.state === "sending" || t.state === "receiving");

  if (running.length) {
    const choice = dialog.showMessageBoxSync({
      type: "warning",
      buttons: ["Keep running", "Quit anyway"],
      defaultId: 0,
      cancelId: 0,
      title: "PeerPayload Connect",
      message: running.length === 1 ? `A transfer with ${running[0].peerName} is in progress.` : `${running.length} transfers are in progress.`,
      detail: "Quitting stops them, and they'd need to be sent again.",
    });

    if (choice === 0)
      return;
  }

  quitting = true;
  app.quit();
}

function start() {
  // Windows shows this name on notifications.
  app.setAppUserModelId("com.peerpayload.connect");

  startNode();
  registerIpcHandlers();
  // Started at sign-in (see tray.js): straight to the tray.
  createWindow({ hidden: process.argv.includes("--hidden") });
  tray = createTray({ onOpen: showWindow, onQuit: quit, getStatus: () => node.status() });
}

app.on("before-quit", () => {
  quitting = true;
  node?.stop();
  tray?.destroy();
});

// The tray keeps the app alive with no windows open.
app.on("window-all-closed", () => {});
