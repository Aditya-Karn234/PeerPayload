const { createRouter } = require("../lib/router");

const db = require("../db");
const { verifyPassword, hashPassword } = require("../auth/hash");
const { createSession, revokeSession, revokeAllSessionsForUser } = require("../auth/tokens");
const { requireAuth } = require("../middleware/auth");
const limiter = require("../lib/loginLimiter");

const router = createRouter();

function serializeUser(user) {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    createdAt: user.createdAt,
    deactivatedAt: user.deactivatedAt,
  };
}

router.post("/login", async (req, res) => {
  const { username, password } = req.body || {};

  if (typeof username !== "string" || typeof password !== "string")
    return res.status(400).json({ error: "username and password are required" });

  // Checked before touching the database or bcrypt, so a blocked client
  // costs almost nothing.
  const waitMs = limiter.retryAfterMs(req.ip, username);

  if (waitMs > 0) {
    res.set("Retry-After", String(Math.ceil(waitMs / 1000)));
    return res.status(429).json({ error: "too many failed login attempts; try again later" });
  }

  const user = await db.user.findUnique({ where: { username } });

  // Same 401 whether the username doesn't exist or the password is wrong —
  // distinguishing them lets an attacker enumerate valid usernames.
  if (!user || user.deactivatedAt) {
    limiter.recordFailure(req.ip, username);
    return res.status(401).json({ error: "invalid username or password" });
  }

  const ok = await verifyPassword(password, user.passwordHash);

  if (!ok) {
    limiter.recordFailure(req.ip, username);
    return res.status(401).json({ error: "invalid username or password" });
  }

  limiter.recordSuccess(req.ip, username);

  const token = await createSession(user.id);

  res.json({ token, user: serializeUser(user) });
});

router.post("/logout", requireAuth, async (req, res) => {
  await revokeSession(req.sessionId);

  res.json({ ok: true });
});

// Changes the signed-in user's own password. Needs the current one, so a
// session left open on someone else's screen can't be used to take the
// account over. A wrong current password counts as a failed login (same
// limiter), or this would be a way around the login limit. All other
// sessions end; the one used here stays signed in.
router.post("/password", requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};

  if (typeof currentPassword !== "string" || typeof newPassword !== "string")
    return res.status(400).json({ error: "currentPassword and newPassword are required" });

  if (newPassword.length < 8)
    return res.status(400).json({ error: "the new password must be at least 8 characters" });

  if (newPassword === currentPassword)
    return res.status(400).json({ error: "the new password must be different from the current one" });

  const { username } = req.user;
  const waitMs = limiter.retryAfterMs(req.ip, username);

  if (waitMs > 0) {
    res.set("Retry-After", String(Math.ceil(waitMs / 1000)));
    return res.status(429).json({ error: "too many failed attempts; try again later" });
  }

  if (!(await verifyPassword(currentPassword, req.user.passwordHash))) {
    limiter.recordFailure(req.ip, username);
    return res.status(401).json({ error: "the current password is wrong" });
  }

  limiter.recordSuccess(req.ip, username);

  await db.user.update({ where: { id: req.user.id }, data: { passwordHash: await hashPassword(newPassword) } });
  await revokeAllSessionsForUser(req.user.id, { exceptSessionId: req.sessionId });

  res.json({ ok: true });
});

router.get("/me", requireAuth, async (req, res) => {
  res.json(serializeUser(req.user));
});

module.exports = router;
