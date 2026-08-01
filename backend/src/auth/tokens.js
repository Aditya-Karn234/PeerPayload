const crypto = require("crypto");

const db = require("../db");
const config = require("../config");
const signalBus = require("../signalBus");

// The raw token is high-entropy random bytes (not a user-chosen secret like
// a password), so a fast deterministic hash is fine for storage — there's
// no dictionary/rainbow-table risk to defend against, unlike passwords.
function hashToken(raw) {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

// Returns the raw token — the only time it's ever available in plaintext.
// Only tokenHash is persisted, so losing this return value means the caller
// has to log in again; there's no way to recover it from the DB.
async function createSession(userId) {
  const raw = crypto.randomBytes(32).toString("hex");

  await db.session.create({
    data: {
      userId,
      tokenHash: hashToken(raw),
      expiresAt: new Date(Date.now() + config.sessionTtlMs),
    },
  });

  return raw;
}

// Returns { session, user } if the raw token maps to a live, unexpired,
// unrevoked session, else null. Also bumps lastUsedAt — cheap and gives an
// admin something to look at ("last active") without extra plumbing.
async function verifySessionToken(raw) {
  if (typeof raw !== "string" || !raw)
    return null;

  const session = await db.session.findUnique({
    where: { tokenHash: hashToken(raw) },
    include: { user: true },
  });

  if (!session || session.revokedAt || session.expiresAt < new Date())
    return null;

  if (session.user.deactivatedAt)
    return null;

  db.session.update({
    where: { id: session.id },
    data: { lastUsedAt: new Date() },
  }).catch(() => {}); // best-effort, never block the request on this

  return { session, user: session.user };
}

async function revokeSession(sessionId) {
  await db.session.update({
    where: { id: sessionId },
    data: { revokedAt: new Date() },
  });
}

// Used for both explicit logout-everywhere and admin-initiated "kill this
// employee's access now" — same operation, different caller. The
// session-revoked push lets an already-open desktop app react immediately
// (force logout) rather than only finding out on its next API call — this
// is the single choke point every revocation path (admin deactivate, admin
// explicit revoke) goes through, so it only needs wiring here once.
async function revokeAllSessionsForUser(userId) {
  await db.session.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });

  signalBus.emit("session-revoked", userId);
}

module.exports = {
  createSession,
  verifySessionToken,
  revokeSession,
  revokeAllSessionsForUser,
};
