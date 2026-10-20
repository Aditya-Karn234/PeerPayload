const { createRouter } = require("../lib/router");

const db = require("../db");
const { verifyPassword } = require("../auth/hash");
const { createSession, revokeSession } = require("../auth/tokens");
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

router.get("/me", requireAuth, async (req, res) => {
  res.json(serializeUser(req.user));
});

module.exports = router;
