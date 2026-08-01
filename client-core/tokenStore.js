const fs = require("fs");
const os = require("os");
const path = require("path");

// %APPDATA%\orgxfer\credentials.json on Windows, ~/.orgxfer/credentials.json
// everywhere else — this is the CLI's default. Electron's main process
// (Phase 4) provides a different implementation of this same {get, set,
// clear} shape backed by the OS keychain instead, so callers (apiClient)
// never need to know which one they're talking to.
function defaultCredentialsPath() {
  if (process.platform === "win32" && process.env.APPDATA)
    return path.join(process.env.APPDATA, "orgxfer", "credentials.json");

  return path.join(os.homedir(), ".orgxfer", "credentials.json");
}

function createFileTokenStore(filePath = defaultCredentialsPath()) {
  return {
    // Returns { token, username } or null — never throws, a missing/
    // corrupt file just means "not logged in."
    get() {
      try {
        const raw = fs.readFileSync(filePath, "utf8");
        const data = JSON.parse(raw);

        return data.token ? data : null;
      } catch {
        return null;
      }
    },

    set({ token, username }) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      // 0o600: this file holds a live bearer token, readable only by the
      // owning user — matches the discipline already applied to not
      // logging tokens anywhere in this codebase.
      fs.writeFileSync(filePath, JSON.stringify({ token, username }), { mode: 0o600 });
    },

    clear() {
      try {
        fs.unlinkSync(filePath);
      } catch {
        // Already gone — clearing a already-logged-out state isn't an error.
      }
    },
  };
}

module.exports = { createFileTokenStore, defaultCredentialsPath };
