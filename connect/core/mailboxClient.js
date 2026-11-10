const WebSocket = require("ws");

const { issueInboxToken } = require("peerpayload-protocol");

const { open } = require("./envelope");

// Talks to a Connect mailbox (connect/mailbox): sends envelopes, and keeps
// an inbox connection that verifies + decrypts what arrives, hands it to
// the app, then acknowledges it so the mailbox can delete it.
//
// The inbox connection checks itself: a ping every heartbeatMs, and no
// pong by the next one means the connection is dead even if the socket
// doesn't know it yet (a network change, a sleeping laptop, a proxy that
// dropped it). It's then replaced, and the mailbox redelivers whatever is
// still unacknowledged.

const HEARTBEAT_MS = 25_000;

// A mailbox URL without trailing slashes. Not url.replace(/\/+$/, ""):
// that regex takes quadratic time on a long run of slashes, and mailbox
// URLs arrive in other people's pairing links.
function trimSlashes(url) {
  let end = url.length;

  while (end > 0 && url[end - 1] === "/")
    end--;

  return url.slice(0, end);
}

// Posts one envelope to a mailbox (any mailbox: contacts may use different
// ones). Resolves with the mailbox's answer; throws with .status if refused.
async function postEnvelope(url, envelope) {
  const res = await fetch(`${trimSlashes(url)}/v1/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(envelope),
  });
  const body = await res.json().catch(() => null);

  if (!res.ok)
    throw Object.assign(new Error(body?.error || `mailbox refused the envelope (${res.status})`), { status: res.status });

  return body;
}

// onEnvelope(opened, raw) receives { from, id, ts, cert, payload } for each
// envelope addressed to us that verifies and decrypts. It may be async; the
// envelope is acknowledged (deleted from the mailbox) once it resolves. If
// it throws, the envelope is left for redelivery on the next connection.
// Envelopes that fail verification are acknowledged and dropped.
// onStatus("connected" | "disconnected" | "error", detail) is optional.
function createMailboxClient({ url, identity, onEnvelope, onStatus = () => {}, log = () => {}, heartbeatMs = HEARTBEAT_MS }) {
  const base = trimSlashes(url);
  const wsBase = base.replace(/^http/, "ws");
  const seen = new Set(); // ids already handled this session (redelivery is idempotent)

  let ws = null;
  let stopped = true;
  let wake = null; // ends the current reconnect wait early
  let hurry = false; // reconnect without waiting, once

  const send = (envelope) => postEnvelope(base, envelope);

  function ack(ids) {
    if (ws && ws.readyState === WebSocket.OPEN && ids.length)
      ws.send(JSON.stringify({ type: "ack", ids }));
  }

  async function handle(raw) {
    if (seen.has(raw.id))
      return ack([raw.id]);

    let opened;

    try {
      opened = open(raw, identity);
    } catch (err) {
      log(`dropping envelope ${raw?.id}: ${err.message}`);
      return ack([raw?.id].filter(Boolean));
    }

    try {
      await onEnvelope(opened, raw);
      seen.add(raw.id);
      ack([raw.id]);
    } catch (err) {
      log(`envelope ${raw.id} not handled, will be redelivered: ${err.message}`);
    }
  }

  function connectOnce() {
    return new Promise((resolve) => {
      const socket = new WebSocket(`${wsBase}/v1/inbox?token=${encodeURIComponent(issueInboxToken(identity))}`, { perMessageDeflate: false });

      ws = socket;

      let alive = true;
      let heartbeat = null;

      socket.on("open", () => {
        onStatus("connected");
        heartbeat = setInterval(() => {
          if (!alive) {
            log("mailbox: no answer to the last ping; reconnecting");
            return socket.terminate();
          }

          alive = false;
          socket.ping();
        }, heartbeatMs);
      });
      socket.on("pong", () => (alive = true));
      socket.on("message", (data) => {
        let msg;

        try {
          msg = JSON.parse(String(data));
        } catch {
          return;
        }

        if (msg?.type === "envelope")
          handle(msg.envelope);
      });
      socket.on("unexpected-response", (req, res) => onStatus("error", `mailbox refused the inbox connection (${res.statusCode})`));
      socket.on("error", (err) => onStatus("error", err.message));
      socket.on("close", () => {
        clearInterval(heartbeat);

        if (ws === socket)
          ws = null;

        onStatus("disconnected");
        resolve();
      });
    });
  }

  async function run() {
    let backoff = 1000;

    while (!stopped) {
      const started = Date.now();

      await connectOnce();

      if (stopped)
        break;

      if (hurry) {
        hurry = false;
        backoff = 1000;
        continue;
      }

      // A connection that lasted a while resets the backoff.
      backoff = Date.now() - started > 30_000 ? 1000 : Math.min(backoff * 2, 30_000);
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, backoff);

        wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      wake = null;
    }
  }

  return {
    send,
    start() {
      if (!stopped)
        return;

      stopped = false;
      run();
    },
    stop() {
      stopped = true;
      ws?.close(1000);
      wake?.();
    },
    // Start a fresh connection now (the network just changed, the
    // computer woke up): the old one may look open but be dead, and a
    // reconnect costs little since the mailbox redelivers anything pending.
    reconnectNow() {
      if (stopped)
        return;

      if (wake)
        return wake(); // waiting between attempts: try now

      hurry = true;
      ws?.terminate();
    },
    get connected() {
      return Boolean(ws && ws.readyState === WebSocket.OPEN);
    },
  };
}

module.exports = { issueInboxToken, postEnvelope, createMailboxClient };
