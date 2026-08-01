module.exports = {
  port: Number(process.env.PORT) || 4000,
  // How long a login session stays valid before requiring a fresh login.
  // Not a security-critical secret rotation window — this is an internal
  // org tool where "log in again after a month" is a reasonable default,
  // not "log in again every day."
  sessionTtlMs: Number(process.env.SESSION_TTL_MS) || 30 * 24 * 60 * 60 * 1000,
  // Same TTL-at-read-time approach as bytesDone etc: a client's presence
  // is only "online" while its heartbeats keep landing within this window.
  presenceTtlMs: Number(process.env.PRESENCE_TTL_MS) || 45 * 1000,
};
