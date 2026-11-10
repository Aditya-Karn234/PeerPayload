const crypto = require("crypto");
const net = require("net");

// Reversed connections: when the sender can't reach the receiver (its
// firewall or network drops incoming connections) but the receiver can
// reach the sender, the receiver dials out instead. The engines don't
// change: as with the relay, each side's engine talks to a local bridge,
// and the bridges carry the bytes - here over one plain TCP connection
// that the receiver opened.
//
//   sender engine -> 127.0.0.1:local --[sender bridge]-- public port
//                                               ^ receiver dials out
//   receiver engine <- 127.0.0.1 --[receiver dialer]-----'
//
// The engines' TLS (pinned to the paired device certificates) runs end to
// end through this, as before. On top, the dialer must open with a
// one-time key (sent only inside the encrypted `reverse` message) within
// a few seconds, or the sender drops the connection before its engine
// sees it.

const KEY_BYTES = 32;
const KEY_TIMEOUT_MS = 5000;
const MAX_WAITING = 4; // verified connections held for the engine
const ENGINE_WAIT_MS = 30_000; // an engine connection waits this long for one

const newKey = () => crypto.randomBytes(KEY_BYTES).toString("hex");

// Bytes both ways until either side ends; the other is then closed too.
function splice(a, b) {
  a.pipe(b);
  b.pipe(a);

  const end = () => {
    a.destroy();
    b.destroy();
  };

  a.on("close", end);
  b.on("close", end);
  a.on("error", () => {});
  b.on("error", () => {});
}

// Reads exactly n bytes, or null on timeout/close. Any bytes after them
// are put back for the next reader.
function readExactly(socket, n, timeoutMs) {
  return new Promise((resolve) => {
    let buf = Buffer.alloc(0);

    const done = (value) => {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("close", onClose);
      resolve(value);
    };
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);

      if (buf.length >= n) {
        socket.pause();

        if (buf.length > n)
          socket.unshift(buf.subarray(n));

        done(buf.subarray(0, n));
      }
    };
    const onClose = () => done(null);
    const timer = setTimeout(() => done(null), timeoutMs);

    socket.on("data", onData);
    socket.on("close", onClose);
  });
}

// Sender side. Listens publicly (port) for the receiver's dial, and locally
// (localPort) for the sender engine; pairs each engine connection with the
// next verified incoming one. arrived(ms) tells whether the receiver
// managed to dial at all, which decides whether to use this path.
async function startReverseBridge({ key, log = () => {} }) {
  const expected = Buffer.from(key, "hex");
  const ready = []; // verified incoming sockets, oldest first
  const wanting = []; // engine sockets waiting for one
  let arrivals = [];
  let closed = false;
  const live = new Set();

  const track = (s) => {
    live.add(s);
    s.on("close", () => live.delete(s));
    s.on("error", () => {});
  };

  function match() {
    while (ready.length && wanting.length) {
      const remote = ready.shift();
      const engine = wanting.shift();

      clearTimeout(engine.waitTimer);
      splice(engine, remote);
      remote.resume();
      engine.resume();
    }
  }

  const publicServer = net.createServer(async (socket) => {
    track(socket);

    if (ready.length >= MAX_WAITING)
      return socket.destroy();

    const got = await readExactly(socket, KEY_BYTES, KEY_TIMEOUT_MS);

    if (!got || !crypto.timingSafeEqual(got, expected)) {
      log("reverse: dropped a connection without the right key");
      return socket.destroy();
    }

    socket.once("close", () => {
      const i = ready.indexOf(socket);

      if (i >= 0)
        ready.splice(i, 1);
    });
    ready.push(socket);
    arrivals.forEach((resolve) => resolve(true));
    arrivals = [];
    match();
  });

  const localServer = net.createServer((engine) => {
    track(engine);
    // The engine's first bytes (TLS ClientHello) wait for the receiver.
    engine.pause();
    engine.waitTimer = setTimeout(() => {
      const i = wanting.indexOf(engine);

      if (i >= 0)
        wanting.splice(i, 1);

      engine.destroy();
    }, ENGINE_WAIT_MS);
    wanting.push(engine);
    match();
  });

  await Promise.all([
    new Promise((resolve, reject) => publicServer.once("error", reject).listen(0, resolve)),
    new Promise((resolve, reject) => localServer.once("error", reject).listen(0, "127.0.0.1", resolve)),
  ]);

  return {
    port: publicServer.address().port,
    localPort: localServer.address().port,
    // Resolves true once a verified connection has arrived, false after ms.
    arrived(ms) {
      if (ready.length)
        return Promise.resolve(true);

      return new Promise((resolve) => {
        const timer = setTimeout(() => resolve(false), ms);

        arrivals.push((v) => {
          clearTimeout(timer);
          resolve(v);
        });
      });
    },
    close() {
      if (closed)
        return;

      closed = true;
      arrivals.forEach((resolve) => resolve(false));
      publicServer.close();
      localServer.close();

      for (const s of live)
        s.destroy();
    },
  };
}

// The first of `addresses` that accepts a TCP connection on `port` within
// timeoutMs (all tried at once), or null.
function dialFirst(addresses, port, timeoutMs) {
  return new Promise((resolve) => {
    let pending = addresses.length;
    let winner = null;

    if (!pending)
      return resolve(null);

    const timer = setTimeout(() => {
      if (!winner)
        resolve(null);
    }, timeoutMs);

    for (const host of addresses) {
      const s = net.connect({ host, port });

      s.once("connect", () => {
        if (winner)
          return s.destroy();

        winner = s;
        clearTimeout(timer);
        resolve(s);
      });
      s.once("error", () => {
        s.destroy();

        if (--pending === 0 && !winner) {
          clearTimeout(timer);
          resolve(null);
        }
      });
    }
  });
}

// Receiver side. Dials the sender, proves the key, and once the sender's
// bytes start arriving connects them to the local receiver engine. When a
// session ends (done, or a dropped link the sender will retry) it dials
// again, until stop() (when the receiver engine exits).
function startReverseDialer({ addresses, port, key, enginePort, onConnected = () => {}, log = () => {} }) {
  let stopped = false;
  let current = new Set();

  async function oneSession() {
    const remote = await dialFirst(addresses, port, 3000);

    if (!remote)
      return false;

    current.add(remote);
    remote.on("close", () => current.delete(remote));
    remote.on("error", () => {});
    remote.write(Buffer.from(key, "hex"));

    // Connect to the engine only when the sender's engine starts talking,
    // so the receiver engine doesn't sit on an idle connection. The first
    // bytes are put back for the splice.
    await new Promise((resolve) => {
      remote.once("data", (chunk) => {
        remote.pause();
        remote.unshift(chunk);
        resolve();
      });
      remote.once("close", resolve);
    });

    if (stopped || remote.destroyed)
      return true;

    const engine = net.connect(enginePort, "127.0.0.1");

    current.add(engine);
    engine.on("close", () => current.delete(engine));
    engine.once("connect", () => {
      onConnected();
      splice(engine, remote);
      remote.resume();
    });
    engine.on("error", (err) => {
      log(`reverse: local engine connection failed (${err.message})`);
      remote.destroy();
    });

    await new Promise((resolve) => remote.once("close", resolve));

    return true;
  }

  (async () => {
    let backoff = 500;

    while (!stopped) {
      const ok = await oneSession().catch(() => false);

      if (stopped)
        break;

      backoff = ok ? 500 : Math.min(backoff * 2, 5000);
      await new Promise((r) => setTimeout(r, backoff));
    }
  })();

  return {
    stop() {
      stopped = true;

      for (const s of current)
        s.destroy();

      current = new Set();
    },
  };
}

module.exports = { newKey, startReverseBridge, startReverseDialer };
