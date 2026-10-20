const { createRouter } = require("../lib/router");

const { requireAuth } = require("../middleware/auth");
const presenceService = require("../services/presenceService");

const router = createRouter();

router.use(requireAuth);

const MIN_PORT = 1;
const MAX_PORT = 65535;

router.post("/heartbeat", async (req, res) => {
  const { address, port } = req.body || {};

  if (typeof address !== "string" || !address.trim())
    return res.status(400).json({ error: "address is required" });

  const parsedPort = Number(port);

  if (!Number.isInteger(parsedPort) || parsedPort < MIN_PORT || parsedPort > MAX_PORT)
    return res.status(400).json({ error: `port must be an integer between ${MIN_PORT} and ${MAX_PORT}` });

  await presenceService.recordHeartbeat(req.user.id, address.trim(), parsedPort);

  res.json({ ok: true });
});

router.post("/offline", async (req, res) => {
  await presenceService.clearPresence(req.user.id);

  res.json({ ok: true });
});

module.exports = router;
