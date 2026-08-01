import { app, safeStorage } from "electron";
import fs from "fs";
import path from "path";

// Same {get, set, clear} shape client-core/tokenStore.js's file-based CLI
// implementation exposes, so apiClient never needs to know which one it's
// talking to — this one backs onto the OS keychain (DPAPI on Windows, via
// Electron's safeStorage) instead of a plain JSON file, since a desktop app
// left logged in long-term is a better fit for OS-level secret storage than
// a CLI credentials file.
function credentialsPath() {
  return path.join(app.getPath("userData"), "credentials.enc");
}

function createElectronTokenStore() {
  const available = safeStorage.isEncryptionAvailable();

  if (!available)
    console.warn("safeStorage encryption is not available on this system — falling back to plain storage.");

  return {
    get() {
      try {
        const raw = fs.readFileSync(credentialsPath());
        const json = available ? safeStorage.decryptString(raw) : raw.toString("utf8");
        const data = JSON.parse(json);

        return data.token ? data : null;
      } catch {
        return null;
      }
    },

    set({ token, username }) {
      fs.mkdirSync(path.dirname(credentialsPath()), { recursive: true });

      const json = JSON.stringify({ token, username });
      const out = available ? safeStorage.encryptString(json) : Buffer.from(json, "utf8");

      fs.writeFileSync(credentialsPath(), out);
    },

    clear() {
      try {
        fs.unlinkSync(credentialsPath());
      } catch {
        // Already logged out.
      }
    },
  };
}

export { createElectronTokenStore };
