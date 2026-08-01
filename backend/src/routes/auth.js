const express = require("express");

const db = require("../db");
const { verifyPassword } = require("../auth/hash");
const { createSession, revokeSession } = require("../auth/tokens");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

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

  const user = await db.user.findUnique({ where: { username } });

  // Same 401 whether the username doesn't exist or the password is wrong —
  // distinguishing them lets an attacker enumerate valid usernames.
  if (!user || user.deactivatedAt)
    return res.status(401).json({ error: "invalid username or password" });

  const ok = await verifyPassword(password, user.passwordHash);

  if (!ok)
    return res.status(401).json({ error: "invalid username or password" });

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
