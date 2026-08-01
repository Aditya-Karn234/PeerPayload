const db = require("../db");
const config = require("../config");

async function recordHeartbeat(userId, address, port) {
  await db.user.update({
    where: { id: userId },
    data: {
      lastHeartbeatAt: new Date(),
      presenceAddress: address,
      presencePort: port,
    },
  });
}

// Explicit "I'm quitting" path (best-effort, called on graceful shutdown).
// Clearing lastHeartbeatAt is enough — isOnline() checks that field first,
// so a null there is immediately offline regardless of the address/port
// values left behind.
async function clearPresence(userId) {
  await db.user.update({
    where: { id: userId },
    data: { lastHeartbeatAt: null },
  });
}

// Pure function so directory listings can compute this per-row without a
// second query — "online" is never a stored value, only ever derived from
// how recently a heartbeat landed.
function isOnline(user) {
  if (!user.lastHeartbeatAt)
    return false;

  return Date.now() - new Date(user.lastHeartbeatAt).getTime() < config.presenceTtlMs;
}

module.exports = { recordHeartbeat, clearPresence, isOnline };
