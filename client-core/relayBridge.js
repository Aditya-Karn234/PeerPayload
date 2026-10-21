const net = require("net");
const WebSocket = require("ws");

// Local bridges between an engine and the relay (relay/src/server.js), for
// transfers whose machines can't reach each other directly. The engines are
// unchanged: the sender engine connects to a local port, the receiver engine
// gets a local connection, and the bridges carry the bytes over a WebSocket.
// Those bytes are the engines' own TLS stream (pinned by the sender), so the
// relay in the middle only ever sees ciphertext.

const HIGH_WATER = 4 * 1024 * 1024; // pause the TCP side above this many queued bytes
const PAIR_TIMEOUT_MS = 30_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function openRelaySocket({ url, ticket }) {
  return new WebSocket(`${url}?ticket=${encodeURIComponent(ticket)}`, { perMessageDeflate: false });
}

function isPairedMessage(data, isBinary) {
  if (isBinary)
    return false;

  try {
    return JSON.parse(String(data)).type === "paired";
  } catch {
    return false;
  }
}

// Forwards bytes both ways between a TCP socket and a paired relay
// WebSocket, with back-pressure in both directions, until either side ends.
function splice(tcp, ws) {
  let pending = 0;

  tcp.on("data", (chunk) => {
    pending += chunk.length;

    ws.send(chunk, { binary: true }, () => {
      pending -= chunk.length;

      if (tcp.isPaused() && pending < HIGH_WATER / 4)
        tcp.resume();
    });

    if (pending > HIGH_WATER)
      tcp.pause();
  });

  ws.on("message", (data, isBinary) => {
    // Nothing to deliver to once the engine's side is gone.
    if (!isBinary || tcp.destroyed)
      return;

    if (!tcp.write(data)) {
      ws.pause();
      tcp.once("drain", () => ws.resume());
    }
  });

  // end() rather than destroy() so bytes still queued (the receiver's last
  // FileDone, say) reach the engine before the connection closes.
  ws.on("close", () => tcp.end());
  // Resume first: a socket paused for back-pressure (whose "drain" will now
  // never come) wouldn't read the relay's close frame, and would linger
  // until ws's 30 s close timeout.
  tcp.on("close", () => {
    ws.resume();
    ws.close(1000);
  });
  tcp.on("error", () => ws.terminate());
}

// Sender side: a local TCP port for the sender engine to connect to. Each
// engine connection gets its own relay socket (a retry reconnects, and so
// re-pairs). Returns { port, close() }.
async function startSenderBridge({ getTicket, log = () => {} }) {
  const live = new Set();

  const server = net.createServer((tcp) => {
    // Hold the engine's first bytes (TLS ClientHello) until the relay has
    // paired us with the receiver.
    tcp.pause();
    live.add(tcp);
    tcp.on("close", () => live.delete(tcp));
    tcp.on("error", () => {});

    let ws = null;

    const pairTimer = setTimeout(() => {
      log("relay: receiver did not join in time");
      tcp.destroy();
      ws?.terminate();
    }, PAIR_TIMEOUT_MS);

    tcp.on("close", () => {
      clearTimeout(pairTimer);

      if (ws && ws.readyState !== WebSocket.CLOSED)
        ws.close(1000);
    });

    getTicket()
      .then((access) => {
        if (tcp.destroyed)
          return;

        ws = openRelaySocket(access);

        const onFirst = (data, isBinary) => {
          if (!isPairedMessage(data, isBinary))
            return;

          clearTimeout(pairTimer);
          ws.off("message", onFirst);
          ws.off("close", onEarlyClose);
          splice(tcp, ws);
          tcp.resume();
        };

        const onEarlyClose = (code, reason) => {
          log(`relay: closed before pairing (${code} ${reason})`);
          tcp.destroy();
        };

        ws.on("message", onFirst);
        ws.on("close", onEarlyClose);
        ws.on("error", (err) => {
          log(`relay: ${err.message}`);
          tcp.destroy();
        });
      })
      .catch((err) => {
        log(`relay: no ticket (${err.message})`);
        tcp.destroy();
      });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  return {
    port: server.address().port,
    close() {
      for (const tcp of live)
        tcp.destroy();

      server.close();
    },
  };
}

// Receiver side: keeps one relay socket waiting for the sender. When it
// pairs, connects to the local receiver engine and splices; when that
// session ends (done, or a dropped link the sender will retry), waits again.
// Runs until stop(), which the caller does when the receiver engine exits.
function startReceiverBridge({ getTicket, enginePort, log = () => {} }) {
  let stopped = false;
  let current = null;

  function oneSession() {
    return new Promise((resolve, reject) => {
      getTicket().then((access) => {
        if (stopped)
          return resolve();

        const ws = openRelaySocket(access);
        let opened = false;

        current = { ws, tcp: null };

        ws.on("open", () => (opened = true));

        ws.on("error", (err) => {
          if (!opened)
            reject(err);
        });

        const onFirst = (data, isBinary) => {
          if (!isPairedMessage(data, isBinary))
            return;

          ws.off("message", onFirst);
          // Hold the sender's bytes until the local engine connection is up.
          ws.pause();

          const tcp = net.connect(enginePort, "127.0.0.1", () => {
            splice(tcp, ws);
            ws.resume();
          });

          current.tcp = tcp;
          tcp.on("error", (err) => {
            log(`relay: local engine connection failed (${err.message})`);
            ws.terminate();
          });
        };

        ws.on("message", onFirst);

        // Resolves for every close (session over, no-peer timeout, replaced);
        // the loop then opens a fresh waiting socket.
        ws.on("close", () => {
          current = null;
          resolve();
        });
      }, reject);
    });
  }

  (async () => {
    let backoff = 1000;

    while (!stopped) {
      try {
        await oneSession();
        backoff = 1000;
        await sleep(200);
      } catch (err) {
        if (stopped)
          break;

        log(`relay: ${err.message}; retrying in ${backoff / 1000}s`);
        await sleep(backoff);
        backoff = Math.min(backoff * 2, 10_000);
      }
    }
  })();

  return {
    stop() {
      stopped = true;
      current?.tcp?.destroy();
      current?.ws?.terminate();
    },
  };
}

// True if a TCP connection to host:port succeeds within timeoutMs. Used to
// decide between the direct path and the relay before starting the sender.
function probeTcp(host, port, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(ok);
    };
    const timer = setTimeout(() => done(false), timeoutMs);

    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

module.exports = { startSenderBridge, startReceiverBridge, probeTcp };
