import { app, Menu, Tray, nativeImage } from "electron";

// The tray icon is what keeps Connect reachable with its window closed:
// the app (and its mailbox connection) keeps running, and offers still
// arrive as notifications.

// A filled circle in the app's accent blue with a white ring, drawn in
// code (32 px at scale factor 2, so it's sharp on 16 px trays and HiDPI).
function drawIcon() {
  const size = 32;
  const buf = Buffer.alloc(size * size * 4); // BGRA
  const c = (size - 1) / 2;

  const accent = [0xd6, 0x78, 0x2a]; // #2a78d6 as B, G, R

  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - c, y - c);
      const i = (y * size + x) * 4;
      // Coverage with a 1 px anti-aliased edge at radius r.
      const cover = (r) => Math.max(0, Math.min(1, r - d));
      const disc = cover(15.5); // whole icon (white ring + centre)
      const centre = cover(11.5); // blue centre

      for (let ch = 0; ch < 3; ch++)
        buf[i + ch] = Math.round(accent[ch] * centre + 0xff * (1 - centre));

      buf[i + 3] = Math.round(255 * disc);
    }

  return nativeImage.createFromBitmap(buf, { width: size, height: size, scaleFactor: 2 });
}

// onOpen()    show the window
// onQuit()    really quit
// getStatus() { connected, mailboxUrl } for the status line
export function createTray({ onOpen, onQuit, getStatus }) {
  const tray = new Tray(drawIcon());

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
