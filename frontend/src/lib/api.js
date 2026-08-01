// Every call goes through the backend's REST layer — never the engine or DB
// directly, per the project's full-stack migration plan. Dev requests are
// proxied at /api by vite.config.js to avoid a CORS round trip in dev.
const BASE = "/api";

async function request(path, options) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });

  const body = await res.json().catch(() => null);

  if (!res.ok)
    throw new Error(body?.error || `Request failed: ${res.status}`);

  return body;
}

export function listTransfers() {
  return request("/transfers");
}

export function getTransfer(id) {
  return request(`/transfers/${id}`);
}

export function createTransfer({ mode, sourcePath, destDir, chunkSize, host, port, token, requireAuth }) {
  return request("/transfers", {
    method: "POST",
    body: JSON.stringify({ mode, sourcePath, destDir, chunkSize, host, port, token, requireAuth }),
  });
}

export function cancelTransfer(id) {
  return request(`/transfers/${id}`, { method: "DELETE" });
}

export function getPublicIp() {
  return request("/network/public-ip");
}
