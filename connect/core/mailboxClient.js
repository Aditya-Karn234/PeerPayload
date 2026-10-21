const crypto = require("crypto");
const WebSocket = require("ws");

const { open } = require("./envelope");

// Talks to a Connect mailbox (connect/mailbox): sends envelopes, and keeps
// an inbox connection that verifies + decrypts what arrives, hands it to
// the app, then acknowledges it so the mailbox can delete it.

// Proves to the mailbox that we hold this device's key, so it lets us
// collect this device's inbox. Must match connect/mailbox/src/verify.js.
function issueInboxToken(identity, { ttlSec = 600, now = Date.now() } = {}) {
  const payload = { v: 1, purpose: "inbox", f: identity.fingerprint, e: Math.floor(now / 1000) + ttlSec, c: identity.certDer.toString("base64") };
  const payloadPart = Buffer.from(JSON.stringify(payload)).toString("base64url");

  return `${payloadPart}.${crypto.sign(null, Buffer.from(payloadPart), identity.signingKey).toString("base64url")}`;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// onEnvelope(opened, raw) receives { from, id, ts, cert, payload } for each
// envelope addressed to us that verifies and decrypts. It may be async; the
// envelope is acknowledged (deleted from the mailbox) once it resolves. If
// it throws, the envelope is left for redelivery on the next connection.
// Envelopes that fail verification are acknowledged and dropped.
// onStatus("connected" | "disconnected" | "error", detail) is optional.
function createMailboxClient({ url, identity, onEnvelope, onStatus = () => {}, log = () => {} }) {
  const base = url.replace(/\/+$/, "");
  const wsBase = base.replace(/^http/, "ws");
  const seen = new Set(); // ids already handled this session (redelivery is idempotent)

  let ws = null;
  let stopped = true;

  async function send(envelope) {
    const res = await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(envelope),
    });
    const body = await res.json().catch(() => null);

    if (!res.ok)
      throw Object.assign(new Error(body?.error || `mailbox refused the envelope (${res.status})`), { status: res.status });

    return body;
  }

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

      socket.on("open", () => onStatus("connected"));
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

      // A connection that lasted a while resets the backoff.
      backoff = Date.now() - started > 30_000 ? 1000 : Math.min(backoff * 2, 30_000);
      await sleep(backoff);
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
    },
    get connected() {
      return Boolean(ws && ws.readyState === WebSocket.OPEN);
    },
  };
}

module.exports = { issueInboxToken, createMailboxClient };
