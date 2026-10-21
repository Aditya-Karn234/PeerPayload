import path from "path";
import { Tray, Menu, nativeImage } from "electron";

let tray = null;

// The raven app tile (resources/tray.png; Electron picks tray@2x.png on
// high-DPI screens). From out/main in development and inside the packaged
// app alike.
const trayIcon = () => nativeImage.createFromPath(path.join(__dirname, "../../resources/tray.png"));

export function createTray({ onOpen, onQuit, onToggleAutoAccept, getAutoAccept }) {
  tray = new Tray(trayIcon());

  tray.setToolTip("PeerPayload Enterprise");

  function rebuildMenu() {
    const menu = Menu.buildFromTemplate([
      { label: "Open PeerPayload Enterprise", click: onOpen },
      { type: "separator" },
      {
        label: "Auto-accept incoming transfers",
        type: "checkbox",
        checked: getAutoAccept(),
        click: () => {
          onToggleAutoAccept();
          rebuildMenu();
        },
      },
      { type: "separator" },
      { label: "Quit", click: onQuit },
    ]);

    tray.setContextMenu(menu);
  }

  rebuildMenu();
  tray.on("click", onOpen);

  return { rebuildMenu };
}
