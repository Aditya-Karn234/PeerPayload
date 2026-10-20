const { createRouter } = require("../lib/router");

const db = require("../db");
const { requireAuth } = require("../middleware/auth");
const presenceService = require("../services/presenceService");

const router = createRouter();

router.use(requireAuth);

// List view: identity + online status only, no address/port — the picker
// needs to show every colleague (so you can see "bob is offline" rather
// than bob just not appearing), not just who's currently reachable.
router.get("/", async (req, res) => {
  const users = await db.user.findMany({
    where: { deactivatedAt: null },
    orderBy: { username: "asc" },
  });

  res.json(
    users.map((user) => ({
      username: user.username,
      online: presenceService.isOnline(user),
    })),
  );
});

// Resolve one username to a connectable address — this is the actual
// lookup a send flow depends on. Distinguishes "no such user" (404, a real
// error) from "exists but not currently reachable" (200, online: false —
// not an error, exactly the case architecture.md says should short-circuit
// before ever attempting a blind connection).
router.get("/:username", async (req, res) => {
  const user = await db.user.findUnique({ where: { username: req.params.username } });

  if (!user || user.deactivatedAt)
    return res.status(404).json({ error: "user not found" });

  if (!presenceService.isOnline(user))
    return res.json({ username: user.username, online: false });

  res.json({
    username: user.username,
    online: true,
    address: user.presenceAddress,
    port: user.presencePort,
  });
});

module.exports = router;
