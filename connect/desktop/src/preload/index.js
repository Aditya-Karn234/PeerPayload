const { contextBridge, ipcRenderer } = require("electron");

// The window's only way to reach the main process: exactly these calls,
// no raw ipcRenderer and no Node APIs (contextIsolation, nodeIntegration off).
const invoke = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld("connect", {
  status: invoke("status"),
  setup: invoke("setup"),
  saveSettings: invoke("save-settings"),

  createInvite: invoke("create-invite"),
  addContact: invoke("add-contact"),
  contacts: invoke("contacts"),
  removeContact: invoke("remove-contact"),

  pickPaths: invoke("pick-paths"),
  pickDownloadDir: invoke("pick-download-dir"),
  send: (fp, paths) => ipcRenderer.invoke("send", { fp, paths }),
  accept: invoke("accept"),
  decline: invoke("decline"),
  cancelOffer: invoke("cancel-offer"),
  pause: invoke("pause"),
  resume: invoke("resume"),
  clearFinished: invoke("clear-finished"),
  transfers: invoke("transfers"),

  copy: invoke("copy"),
  openDownloads: invoke("open-downloads"),

  // callback({ name, data }) for "status", "contacts", "paired", "transfer".
  // Returns an unsubscribe function.
  onEvent(callback) {
    const handler = (event, payload) => callback(payload);

    ipcRenderer.on("connect-event", handler);

    return () => ipcRenderer.removeListener("connect-event", handler);
  },
});
