const { contextBridge, ipcRenderer, webUtils } = require("electron");

// Narrow, explicit surface — the renderer gets exactly these functions and
// nothing else (no raw ipcRenderer, no Node APIs). contextIsolation +
// nodeIntegration:false in main/index.js's BrowserWindow config is what
// makes this the *only* bridge between the two.
function subscribe(channel, callback) {
  const handler = (event, payload) => callback(payload);

  ipcRenderer.on(channel, handler);

  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld("peerpayload", {
  login: (username, password) => ipcRenderer.invoke("login", { username, password }),
  logout: () => ipcRenderer.invoke("logout"),
  getMe: () => ipcRenderer.invoke("get-me"),

  listTransfers: () => ipcRenderer.invoke("list-transfers"),
  getTransfer: (id) => ipcRenderer.invoke("get-transfer", id),
  listDirectory: () => ipcRenderer.invoke("list-directory"),

  pickFile: (mode) => ipcRenderer.invoke("pick-file", mode),
  send: (filePath, toUsername, chunkSize) => ipcRenderer.invoke("send", { filePath, toUsername, chunkSize }),

  acceptIncoming: (transferId) => ipcRenderer.invoke("accept-incoming", transferId),
  rejectIncoming: (transferId) => ipcRenderer.invoke("reject-incoming", transferId),

  getAutoAccept: () => ipcRenderer.invoke("get-auto-accept"),
  setAutoAccept: (value) => ipcRenderer.invoke("set-auto-accept", value),

  connectionStatus: () => ipcRenderer.invoke("connection-status"),
  appInfo: () => ipcRenderer.invoke("app-info"),
  openDownloads: () => ipcRenderer.invoke("open-downloads"),
  // A dropped File's real path on disk (Electron removed File.path).
  pathForFile: (file) => webUtils.getPathForFile(file),

  onProgress: (callback) => subscribe("transfer-progress", callback),
  onConnection: (callback) => subscribe("connection", callback),
  onIncomingTransfer: (callback) => subscribe("incoming-transfer", callback),
  onSessionRevoked: (callback) => subscribe("session-revoked", callback),
});
