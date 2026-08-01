import { Tray, Menu, nativeImage } from "electron";

let tray = null;

// A 16x16 solid-color dot as a base64 PNG — placeholder for a real icon
// asset. Good enough to prove tray/background behavior works; swap for a
// designed icon before shipping.
const ICON_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAI0lEQVR42mNkYPhfz0AEYBxVSF5BVCF5BVGF5BVEFTIwAAD+VAn+2GdWNAAAAABJRU5ErkJggg==";

export function createTray({ onOpen, onQuit, onToggleAutoAccept, getAutoAccept }) {
  tray = new Tray(nativeImage.createFromDataURL(ICON_DATA_URL));

  tray.setToolTip("orgxfer");

  function rebuildMenu() {
    const menu = Menu.buildFromTemplate([
      { label: "Open orgxfer", click: onOpen },
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
