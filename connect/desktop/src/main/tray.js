import path from "path";
import { app, Menu, Tray, nativeImage } from "electron";

// The tray icon is what keeps Connect reachable with its window closed:
// the app (and its mailbox connection) keeps running, and offers still
// arrive as notifications.

// The raven app tile (resources/tray.png; Electron picks tray@2x.png on
// high-DPI screens). From out/main in development and inside the
// packaged app alike.
const trayIcon = () => nativeImage.createFromPath(path.join(__dirname, "../../resources/tray.png"));

// onOpen()    show the window
// onQuit()    really quit
// getStatus() { connected, mailboxUrl } for the status line
export function createTray({ onOpen, onQuit, getStatus }) {
  const tray = new Tray(trayIcon());

  function rebuild() {
    const status = getStatus();
    const statusLabel = !status.mailboxUrl ? "No mailbox set" : status.connected ? "Connected: can receive" : "Connecting…";
    const items = [
      { label: "Open PeerPayload Connect", click: onOpen },
      { label: statusLabel, enabled: false },
      { type: "separator" },
    ];

    // Registering a login item only makes sense for the installed app (in
    // development it would register the bare Electron binary).
    if (app.isPackaged)
      items.push(
        {
          label: "Start when I sign in",
          type: "checkbox",
          checked: app.getLoginItemSettings().openAtLogin,
          click: (item) => {
            app.setLoginItemSettings({ openAtLogin: item.checked, args: ["--hidden"] });
            rebuild();
          },
        },
        { type: "separator" },
      );

    items.push({ label: "Quit", click: onQuit });

    tray.setToolTip(`PeerPayload Connect: ${statusLabel}`);
    tray.setContextMenu(Menu.buildFromTemplate(items));
  }

  rebuild();
  tray.on("click", onOpen);

  return { rebuild, destroy: () => tray.destroy() };
}
