const express = require("express");

const db = require("../db");
const { hashPassword } = require("../auth/hash");
const { revokeAllSessionsForUser } = require("../auth/tokens");
const { requireAuth, requireAdmin } = require("../middleware/auth");

const router = express.Router();

// Every route here is admin-only — this whole router assumes both
// middlewares are applied before any handler runs.
router.use(requireAuth, requireAdmin);

function serializeUser(user) {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    createdAt: user.createdAt,
    deactivatedAt: user.deactivatedAt,
  };
}

const VALID_ROLES = new Set(["admin", "user"]);

router.post("/", async (req, res) => {
  const { username, password, role = "user" } = req.body || {};

  if (typeof username !== "string" || !username.trim())
    return res.status(400).json({ error: "username is required" });

  if (typeof password !== "string" || password.length < 8)
    return res.status(400).json({ error: "password must be at least 8 characters" });

  if (!VALID_ROLES.has(role))
    return res.status(400).json({ error: `role must be one of: ${[...VALID_ROLES].join(", ")}` });

  const existing = await db.user.findUnique({ where: { username } });

  if (existing)
    return res.status(409).json({ error: "username already exists" });

  const user = await db.user.create({
    data: { username, passwordHash: await hashPassword(password), role },
  });

  res.status(201).json(serializeUser(user));
});

router.get("/", async (req, res) => {
  const users = await db.user.findMany({ orderBy: { createdAt: "desc" } });

  res.json(users.map(serializeUser));
});

router.patch("/:id", async (req, res) => {
  const { role, deactivated } = req.body || {};
  const data = {};

  if (role !== undefined) {
    if (!VALID_ROLES.has(role))
      return res.status(400).json({ error: `role must be one of: ${[...VALID_ROLES].join(", ")}` });

    data.role = role;
  }

  if (deactivated !== undefined)
    data.deactivatedAt = deactivated ? new Date() : null;

  if (Object.keys(data).length === 0)
    return res.status(400).json({ error: "nothing to update" });

  const existing = await db.user.findUnique({ where: { id: req.params.id } });

  if (!existing)
    return res.status(404).json({ error: "user not found" });

  const user = await db.user.update({ where: { id: req.params.id }, data });

  // Deactivating an account doesn't just block future logins — kill
  // whatever sessions they already hold too, same as an explicit revoke.
  if (deactivated)
    await revokeAllSessionsForUser(user.id);

  res.json(serializeUser(user));
});

router.post("/:id/revoke-sessions", async (req, res) => {
  const user = await db.user.findUnique({ where: { id: req.params.id } });

  if (!user)
    return res.status(404).json({ error: "user not found" });

  await revokeAllSessionsForUser(user.id);

  res.json({ ok: true });
});

module.exports = router;
