import path from "path";
import { app } from "electron";

// In dev, __dirname is inside the repo checkout, so the relative path up to
// build/ resolves correctly. In a packaged install there is no repo
// checkout on the end user's machine — the engine binaries are bundled as
// extraResources instead (see electron-builder.yml) and live under
// process.resourcesPath, which is what app.isPackaged switches to here.
function resolveExePath(envVar, relativeDevPath, packagedRelativePath) {
  const override = process.env[envVar];

  if (override && override.trim())
    return override.trim();

  if (app.isPackaged)
    return path.join(process.resourcesPath, packagedRelativePath);

  return path.resolve(__dirname, relativeDevPath);
}

export default {
  // Build-time baked-in URL (settled decision). The real deployed backend
  // is the default now, not localhost — a plain double-click on the
  // installed Start Menu shortcut has no way to inherit a shell's
  // PEERPAYLOAD_SERVER env var, so a localhost default meant every install
  // silently failed with "fetch failed" (nothing listening on that
  // person's own machine) unless they specifically knew to launch via a
  // custom .bat file instead. PEERPAYLOAD_SERVER still overrides this, for
  // pointing a dev build at a local backend during testing. The URL itself
  // is unchanged by the app's rebrand — it's still the same deployed Render
  // service (service/database names on Render were deliberately left as
  // orgxfer-backend/orgxfer-db; only app-facing branding changed).
  serverUrl: process.env.PEERPAYLOAD_SERVER || "https://orgxfer-backend.onrender.com",
  senderPath: resolveExePath("ENGINE_SENDER_PATH", "../../../build/sender/sender.exe", "engine/sender.exe"),
  receiverPath: resolveExePath("ENGINE_RECEIVER_PATH", "../../../build/receiver/receiver.exe", "engine/receiver.exe"),
};
