import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from "electron";
import path from "path";
import QRCode from "qrcode";
import { createConnectNode } from "connect-core";

import { engine, keygenPath, identityDir, loadSettings, saveSettings } from "./config";

// PeerPayload Connect's main process: owns the Connect node (connect-core)
// and exposes it to the window over IPC. All the product logic is in
// connect-core; this file is wiring.

// Lets tests (and anyone wanting two devices on one machine) run separate
// instances: each needs its own identity, contacts and settings.
if (process.env.CONNECT_USER_DATA)
  app.setPath("userData", path.resolve(process.env.CONNECT_USER_DATA));

let mainWindow = null;
let node = null;

const ACTIVE_STATES = new Set(["offered", "sending", "receiving"]);

function sendToRenderer(name, data) {
  mainWindow?.webContents.send("connect-event", { name, data });
}

function startNode() {
  const { mailboxUrl, relayUrl } = loadSettings();

  node = createConnectNode({ dir: identityDir(), keygenPath, engine, mailboxUrl, relayUrl });

  for (const name of ["status", "contacts", "paired", "transfer"])
    node.on(name, (data) => sendToRenderer(name, data));

  node.on("log", (message) => console.log(`[connect] ${message}`));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 720,
    title: "PeerPayload Connect",
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
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
  ipcMain.handle("transfers", () => node.transfers());

  ipcMain.handle("copy", (event, text) => clipboard.writeText(String(text)));
  ipcMain.handle("open-downloads", () => shell.openPath(loadSettings().downloadDir));
}

app.whenReady().then(() => {
  startNode();
  registerIpcHandlers();
  createWindow();
});

app.on("window-all-closed", () => {
  node?.stop();
  app.quit();
});
