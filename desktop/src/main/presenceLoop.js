import { getApiClient } from "./apiClient";
import { getLocalIp, findFreePort } from "./network";

const HEARTBEAT_INTERVAL_MS = 15_000;

let intervalHandle = null;

// The port reported here is informational only (useful for an admin
// troubleshooting "why can't alice reach bob" — "last seen at x.x.x.x") —
// it is deliberately NOT where a sender actually connects. Per the
// idle-footprint requirement, this client has no fixed listening port at
// all until a specific transfer is accepted (transferRunner.runReceive
// binds a fresh ephemeral port then, and *that* address/port — not this
// one — is what the accept() call and the sender actually use).
export async function start() {
  stop();

  const nominalPort = await findFreePort();

  const beat = () => {
    getApiClient()
      .heartbeat(getLocalIp(), nominalPort)
      .catch((err) => console.error("heartbeat failed:", err.message));
  };

  beat();
  intervalHandle = setInterval(beat, HEARTBEAT_INTERVAL_MS);
}

export function stop() {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}

// Best-effort — called from before-quit, where there's no guarantee a slow
// network call gets to finish; the presence TTL is the real safety net for
// a client that vanishes without managing to tell the server first.
export async function goOffline() {
  stop();

  try {
    await getApiClient().goOffline();
  } catch {
    // Fine — TTL expiry covers this if the request doesn't land in time.
  }
}
