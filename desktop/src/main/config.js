import path from "path";

function resolveExePath(envVar, relativeDefault) {
  const override = process.env[envVar];

  if (override && override.trim())
    return override.trim();

  return path.resolve(__dirname, relativeDefault);
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
  senderPath: resolveExePath("ENGINE_SENDER_PATH", "../../../build/sender/sender.exe"),
  receiverPath: resolveExePath("ENGINE_RECEIVER_PATH", "../../../build/receiver/receiver.exe"),
};
