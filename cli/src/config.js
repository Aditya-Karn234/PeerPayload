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
  // stands in for that until Phase 5's packaging work exists. Defaults to
  // the real deployed backend, not localhost — same reasoning as the
  // desktop app's config.js: nobody runs the CLI with a local backend
  // listening unless they specifically override it for dev/testing.
  serverUrl: process.env.PEERPAYLOAD_SERVER || "https://orgxfer-backend.onrender.com",
  senderPath: resolveExePath("ENGINE_SENDER_PATH", "../../build/sender/sender.exe"),
  receiverPath: resolveExePath("ENGINE_RECEIVER_PATH", "../../build/receiver/receiver.exe"),
};
