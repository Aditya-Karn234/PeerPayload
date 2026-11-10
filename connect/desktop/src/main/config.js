import fs from "fs";
import path from "path";
import { app } from "electron";

// Where things are, and the user's settings.
//
// Engine binaries: in dev, relative to this file inside the repo checkout
// (out/main -> repo root); in an installed app, bundled under
// resources/engine (electron-builder.yml). ENGINE_*_PATH override either.
const exe = process.platform === "win32" ? ".exe" : "";

function enginePath(envVar, devPath, name) {
  const override = process.env[envVar]?.trim();

  if (override)
    return override;

  if (app.isPackaged)
    return path.join(process.resourcesPath, "engine", `${name}${exe}`);

  return path.resolve(__dirname, "../../../../build", devPath, `${name}${exe}`);
}

export const engine = {
  senderPath: enginePath("ENGINE_SENDER_PATH", "sender", "sender"),
  receiverPath: enginePath("ENGINE_RECEIVER_PATH", "receiver", "receiver"),
};

export const keygenPath = enginePath("ENGINE_KEYGEN_PATH", "engine", "ppkeygen");

// The device's identity and contacts live here (private keys included).
export const identityDir = () => path.join(app.getPath("userData"), "device");

// Settings: where to collect messages (mailbox), the relay for transfers
// that can't go direct, and where received files go. The defaults are the
// hosted services (connect/render.yaml); PEERPAYLOAD_MAILBOX /
// PEERPAYLOAD_RELAY override them, and set to "" mean none (tests use this
// so they never touch the hosted services). Users can change both in
// Settings.
const DEFAULT_MAILBOX = "https://peerpayload-connect-mailbox.onrender.com";
const DEFAULT_RELAY = "wss://peerpayload-connect-relay.onrender.com/v1/connect";

const settingsFile = () => path.join(app.getPath("userData"), "settings.json");

function defaults() {
  return {
    mailboxUrl: (process.env.PEERPAYLOAD_MAILBOX ?? DEFAULT_MAILBOX) || null,
    relayUrl: (process.env.PEERPAYLOAD_RELAY ?? DEFAULT_RELAY) || null,
    downloadDir: path.join(app.getPath("downloads"), "PeerPayload"),
  };
}

export function loadSettings() {
  try {
    return { ...defaults(), ...JSON.parse(fs.readFileSync(settingsFile(), "utf8")) };
  } catch {
    return defaults();
  }
}

const isUrl = (value, schemes) => {
  try {
    return schemes.includes(new URL(value).protocol);
  } catch {
    return false;
  }
};

// Validates and saves; returns the full settings. Empty string clears a URL.
export function saveSettings(changes) {
  const next = { ...loadSettings() };

  if ("mailboxUrl" in changes) {
    if (changes.mailboxUrl && !isUrl(changes.mailboxUrl, ["http:", "https:"]))
      throw new Error("The mailbox address must start with http:// or https://");

    next.mailboxUrl = changes.mailboxUrl?.replace(/\/+$/, "") || null;
  }

  if ("relayUrl" in changes) {
    if (changes.relayUrl && !isUrl(changes.relayUrl, ["ws:", "wss:"]))
      throw new Error("The relay address must start with ws:// or wss://");

    next.relayUrl = changes.relayUrl || null;
  }

  if ("downloadDir" in changes) {
    if (!changes.downloadDir || !path.isAbsolute(changes.downloadDir))
      throw new Error("Choose a folder for received files");

    next.downloadDir = changes.downloadDir;
  }

  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(next, null, 2));

  return next;
}
