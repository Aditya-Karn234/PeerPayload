import { app, shell, BrowserWindow, ipcMain, dialog } from "electron";
import path from "path";

import { getApiClient, getTokenStore } from "./apiClient";
import * as socketBus from "./socket";
import * as presenceLoop from "./presenceLoop";
import * as receiveListener from "./receiveListener";
import * as transferRunner from "./transferRunner";
import { createTray } from "./tray";
import { initAutoUpdater } from "./autoUpdater";

let mainWindow = null;
let isQuitting = false;

function sendToRenderer(channel, payload) {
  mainWindow?.webContents.send(channel, payload);
}

function getMainWindow() {
  return mainWindow;
}

// Called on successful login AND on app-start if a stored session is still
// valid — the two paths converge here so "resume where you left off" and
// "just logged in" behave identically.
async function enterSession(token) {
  socketBus.connectSocket(token);
  await presenceLoop.start();
}

async function exitSession() {
  await presenceLoop.goOffline();
  socketBus.disconnectSocket();
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 700,
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Minimize to tray instead of quitting — the whole point of the tray is
  // that an incoming transfer can still be received with the window closed.
  mainWindow.on("close", (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
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
  ipcMain.handle("login", async (event, { username, password }) => {
    const user = await getApiClient().login(username, password);
    const stored = getTokenStore().get();

    await enterSession(stored.token);

    return user;
  });

  ipcMain.handle("logout", async () => {
    await exitSession();
    await getApiClient().logout();
  });

  ipcMain.handle("get-me", async () => {
    const stored = getTokenStore().get();

    if (!stored)
      return null;

    try {
      const user = await getApiClient().me();

      await enterSession(stored.token);

      return user;
    } catch {
      // Stored token is stale/revoked — clear it rather than leaving the
      // renderer stuck believing it's logged in.
      getTokenStore().clear();
      return null;
    }
  });

  ipcMain.handle("list-transfers", () => getApiClient().listTransfers());
  ipcMain.handle("get-transfer", (event, id) => getApiClient().getTransfer(id));
  ipcMain.handle("list-directory", () => getApiClient().listDirectory());

  // Windows/Linux can't combine "openFile" and "openDirectory" in one native
  // dialog — Electron silently drops to directory-only mode if both are
  // requested (macOS is the only platform that supports picking either).
  // So the renderer asks for one mode at a time via two separate buttons.
  ipcMain.handle("pick-file", async (event, mode) => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: [mode === "folder" ? "openDirectory" : "openFile"],
    });

    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle("send", (event, { filePath, toUsername, chunkSize }) =>
    transferRunner.runSend({ filePath, toUsername, chunkSize }, (progress) =>
      sendToRenderer("transfer-progress", progress),
    ),
  );

  ipcMain.handle("accept-incoming", (event, transferId) => receiveListener.acceptIncoming(transferId));
  ipcMain.handle("reject-incoming", (event, transferId) => receiveListener.rejectIncoming(transferId));

  ipcMain.handle("get-auto-accept", () => receiveListener.getAutoAccept());
  ipcMain.handle("set-auto-accept", (event, value) => receiveListener.setAutoAccept(value));
}

app.whenReady().then(() => {
  receiveListener.init({ onSendToRenderer: sendToRenderer, onGetMainWindow: getMainWindow });

  socketBus.events.on("session-revoked", async () => {
    await exitSession();
    getTokenStore().clear();
    sendToRenderer("session-revoked");
  });

  registerIpcHandlers();
  createWindow();

  createTray({
    onOpen: () => mainWindow?.show(),
    onQuit: () => {
      isQuitting = true;
      app.quit();
    },
    onToggleAutoAccept: () => receiveListener.setAutoAccept(!receiveListener.getAutoAccept()),
    getAutoAccept: () => receiveListener.getAutoAccept(),
  });

  // No-op in dev (electron-updater requires a packaged app with a real
  // app-update.yml) — only meaningful once this runs from a built installer.
  if (app.isPackaged)
    initAutoUpdater();
});

app.on("before-quit", async (event) => {
  if (getTokenStore().get()) {
    event.preventDefault();
    await exitSession();
    isQuitting = true;
    app.quit();
  }
});

app.on("window-all-closed", () => {
  // Deliberately not quitting here (except macOS's own convention doesn't
  // apply to this Windows/Linux-targeted app anyway) — the tray keeps the
  // process alive so the receive listener stays active in the background.
});
