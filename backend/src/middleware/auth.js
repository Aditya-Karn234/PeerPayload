const { verifySessionToken } = require("../auth/tokens");

function extractBearerToken(req) {
  const header = req.headers.authorization;

  if (typeof header !== "string" || !header.startsWith("Bearer "))
    return null;

  return header.slice("Bearer ".length).trim() || null;
}

// Attaches req.user (the User row) and req.sessionId on success. Every
// route this guards is unreachable without a live, unrevoked session —
// there is no fallback/anonymous path once this is applied.
async function requireAuth(req, res, next) {
  const token = extractBearerToken(req);

  if (!token)
    return res.status(401).json({ error: "missing bearer token" });

  const result = await verifySessionToken(token);

  if (!result)
    return res.status(401).json({ error: "invalid, expired, or revoked session" });

  req.user = result.user;
  req.sessionId = result.session.id;

  next();
}

// Must run after requireAuth (relies on req.user already being set).
function requireAdmin(req, res, next) {
  if (!req.user)
    return res.status(401).json({ error: "missing bearer token" });

  if (req.user.role !== "admin")
    return res.status(403).json({ error: "admin role required" });

  next();
}

module.exports = { requireAuth, requireAdmin };
