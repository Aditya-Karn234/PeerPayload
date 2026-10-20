// Shared helpers for the engine test suites: drive the real sender/receiver
// binaries as black boxes over their JSON-on-stdout contract, exactly the
// way client-core/engine.js does, so these tests exercise the same surface
// the desktop app and CLI depend on.
const { spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");

const repoRoot = path.resolve(__dirname, "..", "..");
const exeSuffix = process.platform === "win32" ? ".exe" : "";

// Same override env vars as cli/src/config.js, so one setting points both
// the CLI and these tests at a non-default build (e.g. build-linux/).
const senderPath =
  process.env.ENGINE_SENDER_PATH || path.join(repoRoot, "build", "sender", `sender${exeSuffix}`);
const receiverPath =
  process.env.ENGINE_RECEIVER_PATH || path.join(repoRoot, "build", "receiver", `receiver${exeSuffix}`);

// MinGW builds need their runtime DLLs on PATH, or the process exits 1
// with no output at all.
const mingwBin = "C:\\msys64\\mingw64\\bin";
const childEnv = { ...process.env };
if (process.platform === "win32" && fs.existsSync(mingwBin))
  childEnv.PATH = `${mingwBin};${childEnv.PATH || ""}`;

function assertBinariesExist() {
  for (const exe of [senderPath, receiverPath]) {
    if (!fs.existsSync(exe))
      throw new Error(`Engine binary not found: ${exe} — build it first (cmake --build build), or set ENGINE_SENDER_PATH / ENGINE_RECEIVER_PATH`);
  }
}

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `peerpayload-${prefix}-`));
}

// Deterministic pseudo-random content: same seed, same bytes, so a "changed
// file" test can produce a genuinely different file of the same size.
function writeRandomFile(filePath, size, seed = 1) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const buf = Buffer.alloc(size);
  let block = crypto.createHash("sha256").update(`seed:${seed}`).digest();
  for (let off = 0; off < size; off += block.length) {
    block.copy(buf, off, 0, Math.min(block.length, size - off));
    block = crypto.createHash("sha256").update(block).digest();
  }
  fs.writeFileSync(filePath, buf);
  return filePath;
}

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// Spawns one engine process and collects its NDJSON event stream.
function spawnEngine(exePath, args, extraEnv = {}) {
  const child = spawn(exePath, args, { windowsHide: true, env: { ...childEnv, ...extraEnv } });
  const events = [];
  const waiters = [];
  let stderr = "";
  let pending = "";

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (data) => {
    pending += data;
    let nl;
    while ((nl = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, nl).trim();
      pending = pending.slice(nl + 1);
      if (!line) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        event = { event: "unparseable_stdout", line };
      }
      events.push(event);
      for (const w of [...waiters]) {
        if (w.predicate(event)) {
          waiters.splice(waiters.indexOf(w), 1);
          w.resolve(event);
        }
      }
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (data) => (stderr += data));

  const exited = new Promise((resolve) => {
    child.on("close", (code, signal) => resolve({ code, signal }));
  });

  const proc = {
    child,
    events,
    exited,
    get stderr() {
      return stderr;
    },
    ofType(type) {
      return events.filter((e) => eventType(e) === type);
    },
    // Resolves with the first matching event (already seen or future);
    // rejects if the process exits or the timeout passes first.
    waitFor(predicateOrType, timeoutMs = 15000) {
      const predicate =
        typeof predicateOrType === "string" ? (e) => eventType(e) === predicateOrType : predicateOrType;
      const seen = events.find(predicate);
      if (seen) return Promise.resolve(seen);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out waiting for event; got: ${summarize(events)}\nstderr: ${stderr}`)), timeoutMs);
        const waiter = {
          predicate,
          resolve: (e) => {
            clearTimeout(timer);
            resolve(e);
          },
        };
        waiters.push(waiter);
        exited.then(() => {
          // Let any final stdout lines flush through the parser first.
          setImmediate(() => {
            if (waiters.includes(waiter)) {
              clearTimeout(timer);
              reject(new Error(`process exited before event; got: ${summarize(events)}\nstderr: ${stderr}`));
            }
          });
        });
      });
    },
    kill() {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      return exited;
    },
  };
  return proc;
}

function eventType(e) {
  return e.event ?? e.type;
}

function summarize(events) {
  return events.map(eventType).join(", ") || "(none)";
}

async function startReceiver({ port, outDir, noTls = false, token, transferId = "test", env, args: extraArgs = [] } = {}) {
  port = port ?? (await freePort());
  const args = ["-p", String(port), "-o", outDir, "--transfer-id", transferId];
  if (noTls) args.push("--no-tls");
  if (token) args.push("--token", token);
  args.push(...extraArgs);
  const proc = spawnEngine(receiverPath, args, env);
  proc.port = port;
  await proc.waitFor("listening");
  return proc;
}

function startSender({ port, host = "127.0.0.1", sources, noTls = false, token, chunkSize, window, transferId = "test", env, args: extraArgs = [] } = {}) {
  const args = ["-h", host, "-p", String(port), "--transfer-id", transferId];
  if (noTls) args.push("--no-tls");
  if (token) args.push("--token", token);
  args.push(...extraArgs);
  if (chunkSize) args.push("--chunk-size", String(chunkSize));
  if (window) args.push("--window", String(window));
  args.push(...(Array.isArray(sources) ? sources : [sources]));
  return spawnEngine(senderPath, args, env);
}

// One full receiver+sender run. Returns both procs and their exit results.
async function transfer({ sources, outDir, receiverOpts = {}, senderOpts = {}, timeoutMs = 60000 }) {
  const receiver = await startReceiver({ outDir, ...receiverOpts });
  const sender = startSender({ port: receiver.port, sources, ...senderOpts });
  const [senderExit, receiverExit] = await withTimeout(
    Promise.all([sender.exited, receiver.exited]),
    timeoutMs,
    () => `transfer did not finish\nsender: ${summarize(sender.events)}\nreceiver: ${summarize(receiver.events)}`
  ).finally(() => {
    sender.kill();
    receiver.kill();
  });
  return { sender, receiver, senderExit, receiverExit };
}

function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(typeof message === "function" ? message() : message)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

// A TCP proxy between sender and receiver that misbehaves on purpose.
//   cutAfterBytes: forward this many sender->receiver bytes, then hard-close
//                  both sides — a deterministic stand-in for a dropped link
//                  mid-transfer (works under TLS too, since it never parses).
//   corruptAtByte: flip one sender->receiver byte at this stream offset.
//   freezeAfterBytes: forward this many sender->receiver bytes, then stop
//                  forwarding in both directions WITHOUT closing anything —
//                  a peer that went silent (sleep, Wi-Fi drop) with no
//                  FIN/RST, which only an idle timeout can detect.
function startFaultProxy({ upstreamPort, cutAfterBytes, corruptAtByte, freezeAfterBytes }) {
  return new Promise((resolve, reject) => {
    const sockets = new Set();
    const server = net.createServer((client) => {
      const upstream = net.connect(upstreamPort, "127.0.0.1");
      sockets.add(client);
      sockets.add(upstream);
      let forwarded = 0;
      const destroyBoth = () => {
        client.destroy();
        upstream.destroy();
      };

      client.on("data", (chunk) => {
        if (proxy.frozen) return;
        if (freezeAfterBytes !== undefined && forwarded + chunk.length >= freezeAfterBytes) {
          const keep = Math.max(0, freezeAfterBytes - forwarded);
          if (keep > 0) upstream.write(chunk.subarray(0, keep));
          forwarded += keep;
          proxy.frozen = true;
          return;
        }
        if (cutAfterBytes !== undefined && forwarded + chunk.length >= cutAfterBytes) {
          const keep = Math.max(0, cutAfterBytes - forwarded);
          if (keep > 0) upstream.write(chunk.subarray(0, keep));
          forwarded += keep;
          proxy.cut = true;
          // Give the partial write a moment to land, then sever.
          setTimeout(destroyBoth, 50);
          client.pause();
          return;
        }
        if (corruptAtByte !== undefined && corruptAtByte >= forwarded && corruptAtByte < forwarded + chunk.length) {
          chunk = Buffer.from(chunk);
          chunk[corruptAtByte - forwarded] ^= 0xff;
          proxy.corrupted = true;
        }
        forwarded += chunk.length;
        upstream.write(chunk);
      });
      upstream.on("data", (chunk) => {
        if (!proxy.frozen && !client.destroyed) client.write(chunk);
      });
      // Once frozen, nothing crosses the proxy — not even a close — so each
      // side has to notice the silence on its own.
      client.on("end", () => !proxy.frozen && upstream.end());
      upstream.on("end", () => !proxy.frozen && client.end());
      client.on("error", () => (proxy.frozen ? client.destroy() : destroyBoth()));
      upstream.on("error", () => (proxy.frozen ? upstream.destroy() : destroyBoth()));
      client.on("close", () => sockets.delete(client));
      upstream.on("close", () => sockets.delete(upstream));
    });

    const proxy = {
      cut: false,
      corrupted: false,
      frozen: false,
      port: 0,
      close() {
        for (const s of sockets) s.destroy();
        return new Promise((r) => server.close(() => r()));
      },
    };

    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      proxy.port = server.address().port;
      resolve(proxy);
    });
  });
}

function listFilesRecursive(dir, base = dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFilesRecursive(full, base));
    else out.push(path.relative(base, full).split(path.sep).join("/"));
  }
  return out.sort();
}

module.exports = {
  senderPath,
  receiverPath,
  childEnv,
  assertBinariesExist,
  makeTempDir,
  writeRandomFile,
  sha256File,
  freePort,
  spawnEngine,
  eventType,
  startReceiver,
  startSender,
  transfer,
  withTimeout,
  startFaultProxy,
  listFilesRecursive,
};
