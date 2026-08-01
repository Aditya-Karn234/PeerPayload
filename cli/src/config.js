const path = require("path");

function resolveExePath(envVar, relativeDefault) {
  const override = process.env[envVar];

  if (override && override.trim())
    return override.trim();

  return path.resolve(__dirname, relativeDefault);
}

module.exports = {
  // Same "baked-in default, PEERPAYLOAD_SERVER env var overrides" approach the
  // desktop app uses (electron-builder config) — the CLI isn't packaged
  // via a build tool with its own config injection yet, so an env var
  // stands in for that until Phase 5's packaging work exists.
  serverUrl: process.env.PEERPAYLOAD_SERVER || "http://localhost:4000",
  senderPath: resolveExePath("ENGINE_SENDER_PATH", "../../build/sender/sender.exe"),
  receiverPath: resolveExePath("ENGINE_RECEIVER_PATH", "../../build/receiver/receiver.exe"),
};
