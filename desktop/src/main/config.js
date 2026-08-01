import path from "path";

function resolveExePath(envVar, relativeDefault) {
  const override = process.env[envVar];

  if (override && override.trim())
    return override.trim();

  return path.resolve(__dirname, relativeDefault);
}

export default {
  // Build-time baked-in URL (settled decision) — for this repo's dev/
  // verification runs, ORGXFER_SERVER overrides it the same way the CLI's
  // config does; a real release would bake a fixed org URL in via
  // electron-builder's env injection instead of shipping this override.
  serverUrl: process.env.ORGXFER_SERVER || "http://localhost:4000",
  senderPath: resolveExePath("ENGINE_SENDER_PATH", "../../../build/sender/sender.exe"),
  receiverPath: resolveExePath("ENGINE_RECEIVER_PATH", "../../../build/receiver/receiver.exe"),
};
