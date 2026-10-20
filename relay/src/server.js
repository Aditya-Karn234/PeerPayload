const http = require("http");
const { WebSocketServer } = require("ws");

const { verifyTicket } = require("./ticket");

// Blind relay for transfers whose two machines can't reach each other
// directly (different NATs, firewalls). Each side opens a WebSocket with a
// ticket from the backend; the relay pairs the sender and receiver of the
// same transfer and forwards bytes between them. Those bytes are the
// engine's TLS stream, end to end between the two engines, so the relay
// sees only ciphertext — and the sender pins the receiver's certificate, so
// the relay can't impersonate the receiver either.
//
// Wire protocol, per WebSocket:
//   relay -> client  text   {"type":"paired"}   both sides present; start
//   both directions  binary raw engine bytes    only after "paired"
// Closing either side closes the other.

// Back-pressure: stop reading from one side while this many bytes are
// queued towards the other, resume below the low mark. Keeps a fast sender
// from buffering a whole file in relay memory.
const HIGH_WATER = 8 * 1024 * 1024;
const LOW_WATER = 2 * 1024 * 1024;

function createRelay({
  secret,
  unpairedTimeoutMs = 120_000,
  maxSockets = 200,
  pingIntervalMs = 30_000,
  log = console,
} = {}) {
  if (!secret)
    throw new Error("relay secret is required");

  // transferId -> { sender, receiver, paired }
  const slots = new Map();
  const stats = { pairs: 0, bytes: 0, rejected: 0 };

  const server = http.createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, sockets: wss.clients.size, transfers: slots.size }));
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024, perMessageDeflate: false });

  // Authenticate before upgrading, so an unauthorised client never gets a
  // WebSocket at all.
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url, "http://relay");
    const reject = (code, text) => {
      stats.rejected++;
      socket.end(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    };

    if (url.pathname !== "/v1/connect")
      return reject(404, "Not Found");

    const identity = verifyTicket(url.searchParams.get("ticket"), secret);

    if (!identity)
      return reject(401, "Unauthorized");

    if (wss.clients.size >= maxSockets)
      return reject(503, "Service Unavailable");

    wss.handleUpgrade(req, socket, head, (ws) => attach(ws, identity));
  });

  function attach(ws, { transferId, role }) {
    const otherRole = role === "sender" ? "receiver" : "sender";
    let slot = slots.get(transferId);

    if (!slot) {
      slot = { sender: null, receiver: null, paired: false };
      slots.set(transferId, slot);
    }

    // A reconnect replaces whatever this side had. If the old socket was
    // mid-session, that session is over for both sides; the engines'
    // resume protocol continues on the new pairing.
    if (slot[role]) {
      const old = slot[role];

      if (slot.paired && slot[otherRole]) {
        const partner = slot[otherRole];

        slot[otherRole] = null;
        partner.close(4000, "peer reconnected");
      }

      slot[role] = null;
      slot.paired = false;
      old.close(4000, "replaced");
    }

    slot[role] = ws;
    ws.isAlive = true;
    ws.on("pong", () => (ws.isAlive = true));

    ws.unpairedTimer = setTimeout(() => ws.close(4008, "no peer"), unpairedTimeoutMs);

    ws.on("message", (data, isBinary) => {
      // Nothing may flow before both sides are present.
      if (!isBinary || !slot.paired || slot[role] !== ws)
        return ws.close(1008, "unexpected message");

      forward(ws, slot[otherRole], data);
    });

    ws.on("close", () => {
      clearTimeout(ws.unpairedTimer);

      if (slot[role] !== ws)
        return; // already replaced

      slot[role] = null;

      if (slot.paired) {
        slot.paired = false;

        const partner = slot[otherRole];

        slot[otherRole] = null;
        partner?.close(1000, "peer closed");
      }

      if (!slot.sender && !slot.receiver && slots.get(transferId) === slot)
        slots.delete(transferId);
    });

    ws.on("error", (err) => log.warn?.(`relay socket error (${transferId}/${role}): ${err.message}`));

    if (slot.sender && slot.receiver && !slot.paired) {
      clearTimeout(slot.sender.unpairedTimer);
      clearTimeout(slot.receiver.unpairedTimer);
      slot.paired = true;
      stats.pairs++;

      const paired = JSON.stringify({ type: "paired" });

      slot.sender.send(paired);
      slot.receiver.send(paired);
    }
  }

  function forward(from, to, data) {
    if (!to || to.readyState !== to.OPEN)
      return;

    stats.bytes += data.length;
    to.pending = (to.pending || 0) + data.length;

    to.send(data, { binary: true }, () => {
      to.pending -= data.length;

      if (from.isPaused && to.pending < LOW_WATER)
        from.resume();
    });

    if (to.pending > HIGH_WATER && !from.isPaused)
      from.pause();
  }

  // Drop sockets whose peer vanished without closing (no pong).
  const pinger = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }

      ws.isAlive = false;
      ws.ping();
    }
  }, pingIntervalMs);

  pinger.unref();

  return {
    server,
    stats,
    slots,
    listen(port, host) {
      return new Promise((resolve) => server.listen(port, host, () => resolve(server.address().port)));
    },
    close() {
      clearInterval(pinger);

      for (const ws of wss.clients)
        ws.terminate();

      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

module.exports = { createRelay };

if (require.main === module) {
  const secret = process.env.RELAY_SECRET;

  if (!secret || secret.length < 32) {
    console.error("RELAY_SECRET must be set (at least 32 characters, same value as the backend's).");
    process.exit(1);
  }

  const relay = createRelay({ secret });
  const port = Number(process.env.PORT) || 4200;

  relay.listen(port).then((p) => console.log(`Relay listening on port ${p}`));
}
