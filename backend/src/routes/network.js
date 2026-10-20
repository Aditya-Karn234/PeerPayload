const { createRouter } = require("../lib/router");

const router = createRouter();

// A machine can't learn its own public (NAT-translated) IP from its local
// interfaces — that's only visible to something outside the NAT. There's no
// way around asking a third party; api.ipify.org is a small, well-known,
// no-key-required service that exists for exactly this. Cached briefly
// since a public IP essentially never changes mid-session and there's no
// reason to hit a third party on every dashboard poll.
const IPIFY_URL = "https://api.ipify.org?format=json";
const CACHE_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5000;

let cached = null; // { ip, fetchedAt }

router.get("/public-ip", async (req, res) => {
  if (cached && Date.now() - cached.fetchedAt < CACHE_MS)
    return res.json({ ip: cached.ip, cached: true });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(IPIFY_URL, { signal: controller.signal });

    if (!response.ok)
      throw new Error(`ipify responded ${response.status}`);

    const body = await response.json();

    cached = { ip: body.ip, fetchedAt: Date.now() };

    res.json({ ip: body.ip, cached: false });
  } catch (err) {
    // No internet egress from this container/network, or the third party is
    // down — not fatal, the receive-mode UI just falls back to "look it up
    // yourself" copy instead of blocking on this.
    res.status(502).json({ error: "could not detect public IP", detail: err.message });
  } finally {
    clearTimeout(timeout);
  }
});

module.exports = router;
