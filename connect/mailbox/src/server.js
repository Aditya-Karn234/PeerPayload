const http = require("http");
const { WebSocketServer } = require("ws");

const { verifyEnvelopeSignature, verifyInboxToken } = require("peerpayload-protocol");

const verifyEnvelope = (e) => {
  try {
    verifyEnvelopeSignature(e);
    return true;
  } catch {
    return false;
  }
};

// PeerPayload Connect mailbox: store-and-forward for small envelopes
// (pairing, transfer offers/answers, later messages) between devices that
// have no other way to reach each other. Deliberately low-trust:
//
//   - it can't read anything: envelopes are end-to-end encrypted;
//   - it can't forge anything: it only accepts envelopes signed by their
//     sender's device key, and recipients verify again;
//   - a device collects only its own inbox, by proving it holds its key.
//
// API
//   POST /v1/messages   body: one envelope (JSON)  -> 202 {id}
//   WS   /v1/inbox?token=<inbox token>
//        server -> client  {"type":"envelope","envelope":{...}}
//        client -> server  {"type":"ack","ids":["..."]}   deletes them
//   GET  /health
//
// Storage is in memory: a restart drops undelivered envelopes. Fine while
// both sides are usually online; a persistent store comes later.

function createMailbox({
  ttlMs = 7 * 24 * 60 * 60 * 1000,
  maxQueuePerDevice = 1000,
  maxPerSenderPerMinute = 120,
  maxSocketsPerIp = 20,
  clockSkewSec = 10 * 60,
  maxBodyBytes = 64 * 1024,
  trustProxy = false,
  sweepIntervalMs = 60_000,
  log = console,
} = {}) {
  const queues = new Map(); // fp -> [{ id, envelope, at }]
  const recentIds = new Map(); // `${to}:${id}` -> at   (duplicate suppression)
  const senderWindows = new Map(); // fp -> { start, count }
  const inboxes = new Map(); // fp -> ws
  const socketsPerIp = new Map();
  const stats = { accepted: 0, delivered: 0, rejected: 0 };

  const clientIp = (req) => (trustProxy && String(req.headers["x-forwarded-for"] || "").split(",")[0].trim()) || req.socket.remoteAddress || "unknown";

  function json(res, status, body) {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  }

  function senderAllowed(fp, now) {
    const w = senderWindows.get(fp);

    if (!w || now - w.start >= 60_000) {
      senderWindows.set(fp, { start: now, count: 1 });
      return true;
    }

    w.count++;

    return w.count <= maxPerSenderPerMinute;
  }

  function push(ws, envelope) {
    if (ws && ws.readyState === ws.OPEN)
      ws.send(JSON.stringify({ type: "envelope", envelope }));
  }

  function accept(envelope, now) {
    const key = `${envelope.to}:${envelope.id}`;

    if (recentIds.has(key))
      return { status: 202, body: { id: envelope.id, duplicate: true } };

    const queue = queues.get(envelope.to) || [];

    if (queue.length >= maxQueuePerDevice)
      return { status: 507, body: { error: "recipient's mailbox is full" } };

    queue.push({ id: envelope.id, envelope, at: now });
    queues.set(envelope.to, queue);
    recentIds.set(key, now);
    stats.accepted++;
    push(inboxes.get(envelope.to), envelope);

    return { status: 202, body: { id: envelope.id } };
  }

  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/health")
      return json(res, 200, { ok: true, inboxes: inboxes.size, queued: [...queues.values()].reduce((n, q) => n + q.length, 0) });

    if (req.method !== "POST" || req.url !== "/v1/messages")
      return json(res, 404, { error: "not found" });

    // Answer 413, then read and discard the rest of the body (up to a bound)
    // before closing: dropping unread bytes makes the OS reset the
    // connection, and the sender would never see the response.
    const refuseTooBig = () => {
      let discarded = 0;

      req.removeAllListeners("data");
      req.on("data", (c) => {
        discarded += c.length;

        if (discarded > 1024 * 1024)
          req.destroy();
      });
      res.writeHead(413, { "Content-Type": "application/json", Connection: "close" });
      res.end(JSON.stringify({ error: "envelope too large" }));
    };

    if (Number(req.headers["content-length"]) > maxBodyBytes) {
      stats.rejected++;
      return refuseTooBig();
    }

    const chunks = [];
    let size = 0;
    let tooBig = false;

    req.on("data", (c) => {
      if (tooBig)
        return;

      size += c.length;

      if (size > maxBodyBytes) {
        tooBig = true;
        stats.rejected++;
        refuseTooBig();
        return;
      }

      chunks.push(c);
    });

    req.on("end", () => {
      if (tooBig)
        return;

      const now = Date.now();
      let envelope;

      try {
        envelope = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        stats.rejected++;
        return json(res, 400, { error: "body must be one JSON envelope" });
      }

      if (!verifyEnvelope(envelope)) {
        stats.rejected++;
        return json(res, 401, { error: "envelope is malformed or its signature is invalid" });
      }

      if (Math.abs(envelope.ts - Math.floor(now / 1000)) > clockSkewSec) {
        stats.rejected++;
        return json(res, 422, { error: "envelope timestamp too far from server time" });
      }

      if (!senderAllowed(envelope.from, now)) {
        stats.rejected++;
        return json(res, 429, { error: "too many envelopes from this device; slow down" });
      }

      const result = accept(envelope, now);

      json(res, result.status, result.body);
    });
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024, perMessageDeflate: false });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url, "http://mailbox");
    const reject = (code, text) => socket.end(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);

    if (url.pathname !== "/v1/inbox")
      return reject(404, "Not Found");

    const identity = verifyInboxToken(url.searchParams.get("token"));

    if (!identity)
      return reject(401, "Unauthorized");

    const ip = clientIp(req);

    if ((socketsPerIp.get(ip) || 0) >= maxSocketsPerIp)
      return reject(429, "Too Many Requests");

    wss.handleUpgrade(req, socket, head, (ws) => {
      socketsPerIp.set(ip, (socketsPerIp.get(ip) || 0) + 1);
      attachInbox(ws, identity.fingerprint, ip);
    });
  });

  function attachInbox(ws, fp, ip) {
    // One live inbox per device; a reconnect replaces the old one.
    inboxes.get(fp)?.close(4000, "replaced");
    inboxes.set(fp, ws);
    ws.isAlive = true;
    ws.on("pong", () => (ws.isAlive = true));

    for (const item of queues.get(fp) || [])
      push(ws, item.envelope);

    ws.on("message", (data, isBinary) => {
      if (isBinary)
        return ws.close(1003, "text only");

      let msg;

      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }

      if (msg?.type === "ack" && Array.isArray(msg.ids)) {
        const ids = new Set(msg.ids.filter((x) => typeof x === "string"));
        const queue = queues.get(fp) || [];
        const kept = queue.filter((item) => !ids.has(item.id));

        stats.delivered += queue.length - kept.length;

        if (kept.length)
          queues.set(fp, kept);
        else
          queues.delete(fp);
      }
    });

    ws.on("close", () => {
      if (inboxes.get(fp) === ws)
        inboxes.delete(fp);

      const left = (socketsPerIp.get(ip) || 1) - 1;

      if (left > 0)
        socketsPerIp.set(ip, left);
      else
        socketsPerIp.delete(ip);
    });

    ws.on("error", (err) => log.warn?.(`inbox socket error: ${err.message}`));
  }

  // Expire old envelopes and duplicate-suppression entries; drop dead sockets.
  const sweeper = setInterval(() => {
    const now = Date.now();

    for (const [fp, queue] of queues) {
      const kept = queue.filter((item) => now - item.at < ttlMs);

      if (kept.length)
        queues.set(fp, kept);
      else
        queues.delete(fp);
    }

    for (const [key, at] of recentIds)
      if (now - at >= ttlMs)
        recentIds.delete(key);

    for (const [fp, w] of senderWindows)
      if (now - w.start >= 60_000)
        senderWindows.delete(fp);

    for (const ws of wss.clients) {
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }

      ws.isAlive = false;
      ws.ping();
    }
  }, sweepIntervalMs);

  sweeper.unref();

  return {
    server,
    stats,
    queues,
    listen(port, host) {
      return new Promise((resolve) => server.listen(port, host, () => resolve(server.address().port)));
    },
    close() {
      clearInterval(sweeper);

      for (const ws of wss.clients)
        ws.terminate();

      const closed = new Promise((resolve) => server.close(() => resolve()));

      server.closeAllConnections();

      return closed;
    },
  };
}

module.exports = { createMailbox };

if (require.main === module) {
  const mailbox = createMailbox({
    trustProxy: process.env.TRUST_PROXY === "1",
    maxSocketsPerIp: Number(process.env.MAX_SOCKETS_PER_IP) || 20,
  });

  mailbox.listen(Number(process.env.PORT) || 4300).then((p) => console.log(`Mailbox listening on port ${p}`));
}
