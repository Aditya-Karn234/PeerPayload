// The one client-side implementation of "talk to the backend" — the CLI
// and (from Phase 4) the desktop app both construct one of these and never
// touch fetch/auth headers directly. Mirrors frontend/src/lib/api.js's
// request() pattern, but takes an explicit baseUrl (no Vite dev-proxy to
// lean on outside a browser) and a pluggable tokenStore instead of a
// browser-managed cookie/session.
function createApiClient({ baseUrl, tokenStore }) {
  async function request(path, options = {}) {
    const stored = tokenStore.get();
    const headers = { "Content-Type": "application/json", ...(options.headers || {}) };

    if (stored?.token)
      headers.Authorization = `Bearer ${stored.token}`;

    const res = await fetch(`${baseUrl}${path}`, { ...options, headers });
    const body = await res.json().catch(() => null);

    if (!res.ok) {
      const error = new Error(body?.error || `Request failed: ${res.status}`);

      error.status = res.status;
      error.body = body;

      throw error;
    }

    return body;
  }

  return {
    async login(username, password) {
      const result = await request("/auth/login", {
        method: "POST",
        body: JSON.stringify({ username, password }),
      });

      tokenStore.set({ token: result.token, username: result.user.username });

      return result.user;
    },

    async logout() {
      try {
        await request("/auth/logout", { method: "POST" });
      } finally {
        // Clear locally even if the network call fails — a stuck "logged
        // in" local state with a token the server no longer honors is
        // worse than a slightly premature local logout.
        tokenStore.clear();
      }
    },

    me() {
      return request("/auth/me");
    },

    heartbeat(address, port) {
      return request("/presence/heartbeat", {
        method: "POST",
        body: JSON.stringify({ address, port }),
      });
    },

    goOffline() {
      return request("/presence/offline", { method: "POST" });
    },

    // Never throws for "exists but offline" — that's a normal 200 with
    // online: false, per architecture.md's "clear not-currently-reachable
    // response instead of connecting blind." Only throws (404) for a
    // genuinely nonexistent username.
    resolveRecipient(username) {
      return request(`/directory/${encodeURIComponent(username)}`);
    },

    listDirectory() {
      return request("/directory");
    },

    createTransferIntent(data) {
      return request("/transfers", { method: "POST", body: JSON.stringify(data) });
    },

    getTransfer(id) {
      return request(`/transfers/${id}`);
    },

    listTransfers() {
      return request("/transfers");
    },

    acceptTransfer(id, data) {
      return request(`/transfers/${id}/accept`, { method: "POST", body: JSON.stringify(data) });
    },

    rejectTransfer(id) {
      return request(`/transfers/${id}/reject`, { method: "POST" });
    },

    // { url, ticket, role, expiresAt }; throws (404) when the backend has
    // no relay configured.
    getRelayTicket(id) {
      return request(`/transfers/${id}/relay-ticket`);
    },

    postTransferReport(id, report) {
      return request(`/transfers/${id}/report`, { method: "POST", body: JSON.stringify(report) });
    },
  };
}

module.exports = { createApiClient };
