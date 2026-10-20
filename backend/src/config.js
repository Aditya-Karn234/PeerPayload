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
  // Relay for transfers whose machines can't reach each other directly
  // (relay/). Both must be set to enable it: the relay's public WebSocket
  // URL (wss://.../v1/connect) and the secret shared with the relay for
  // signing tickets. Unset = LAN/direct transfers only.
  relayUrl: process.env.RELAY_URL || null,
  relaySecret: process.env.RELAY_SECRET || null,
  // A ticket only has to stay valid long enough to open the relay socket;
  // clients fetch a fresh one for every (re)connect.
  relayTicketTtlSec: Number(process.env.RELAY_TICKET_TTL_SEC) || 600,
};
