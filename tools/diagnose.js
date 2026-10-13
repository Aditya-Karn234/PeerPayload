#!/usr/bin/env node
// PeerPayload diagnostic: answers "why won't it send?" on one machine by
// checking each layer a transfer depends on, bottom up — engine binaries
// load, a real loopback TLS transfer round-trips byte-identical, the
// machine has an address a peer could reach, the backend answers, the
// stored login still works, and (optionally) a given peer's receiver port
// is reachable from here.
//
// Read-only apart from a temp dir it cleans up. Never prints the stored
// bearer token.
//
//   node tools/diagnose.js                       # everything
//   node tools/diagnose.js --peer 10.0.0.12:52011 # also test reaching a peer
//   node tools/diagnose.js --offline             # skip backend/login checks
//   node tools/diagnose.js --json                # machine-readable
//
// Exit code 0 when nothing failed (warnings allowed), 1 otherwise.
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(
    [
      "Usage: node tools/diagnose.js [options]",
      "",
      "  --server <url>      backend to check (default: $PEERPAYLOAD_SERVER or the deployed backend)",
      "  --peer <host:port>  also check a TCP connection to a peer's receiver",
      "  --sender <path>     sender binary (default: $ENGINE_SENDER_PATH or build/sender/sender)",
      "  --receiver <path>   receiver binary (default: $ENGINE_RECEIVER_PATH or build/receiver/receiver)",
      "  --size <MB>         loopback test file size (default 8)",
      "  --offline           skip backend and login checks",
      "  --json              print results as JSON",
    ].join("\n")
  );
  process.exit(0);
}

// The harness resolves binary paths from these at load time.
if (args.sender) process.env.ENGINE_SENDER_PATH = path.resolve(args.sender);
if (args.receiver) process.env.ENGINE_RECEIVER_PATH = path.resolve(args.receiver);
const h = require("../tests/engine/harness");
const { defaultCredentialsPath } = require("../client-core/tokenStore");

const serverUrl = (args.server || process.env.PEERPAYLOAD_SERVER || "https://orgxfer-backend.onrender.com").replace(/\/+$/, "");
const results = [];

function record(section, name, status, detail, hint) {
  results.push({ section, name, status, detail, ...(hint ? { hint } : {}) });
}

async function check(section, name, fn) {
  try {
    const r = await fn();
    record(section, name, r.status, r.detail, r.hint);
    return r;
  } catch (err) {
    record(section, name, "fail", err.message.split("\n")[0]);
    return { status: "fail" };
  }
}

// ---- System ----

function checkSystem() {
  record("system", "platform", "info", `${os.type()} ${os.release()} ${os.arch()}`);
  const major = Number(process.versions.node.split(".")[0]);
  record(
    "system",
    "node",
    major >= 18 ? "pass" : "warn",
    `v${process.versions.node}`,
    major >= 18 ? undefined : "client-core/CLI expect Node 18+ (global fetch)"
  );
}

// ---- Engine ----

async function checkBinary(label, exePath) {
  return check("engine", `${label} binary`, async () => {
    if (!fs.existsSync(exePath))
      return { status: "fail", detail: `not found: ${exePath}`, hint: "build with cmake --build build, or pass --" + label };

    // --help prints usage to stderr. A binary that can't load its runtime
    // DLLs (MinGW, OpenSSL) exits immediately with no output at all, which
    // is the single most common "it does nothing" failure on Windows.
    const proc = h.spawnEngine(exePath, ["--help"]);
    const exit = await h.withTimeout(proc.exited, 10000, `${label} --help hung`);
    if (!/Usage:/.test(proc.stderr))
      return {
        status: "fail",
        detail: `exited ${exit.code} without printing usage`,
        hint: process.platform === "win32" ? "likely missing runtime DLLs (libssl/libcrypto/libstdc++) next to the exe or on PATH" : "check ldd on the binary for missing libraries",
      };
    return { status: "pass", detail: exePath };
  });
}

async function checkLoopback(noTls) {
  const name = noTls ? "loopback transfer (plaintext)" : "loopback transfer (TLS)";
  return check("engine", name, async () => {
    const work = h.makeTempDir("diag");
    try {
      const sizeBytes = Math.round((Number(args.size) || 8) * 1024 * 1024);
      const src = h.writeRandomFile(path.join(work, "src", "probe.bin"), sizeBytes, Date.now());
      const outDir = path.join(work, "out");
      const started = Date.now();
      const run = await h.transfer({ sources: src, outDir, receiverOpts: { noTls }, senderOpts: { noTls }, timeoutMs: 60000 });
      const seconds = (Date.now() - started) / 1000;

      if (run.senderExit.code !== 0 || run.receiverExit.code !== 0) {
        const reason =
          run.sender.ofType("transfer_failed")[0]?.reason || run.receiver.ofType("transfer_failed")[0]?.reason || "unknown";
        return { status: "fail", detail: `transfer failed: ${reason}`, hint: (run.sender.stderr + run.receiver.stderr).trim().split("\n")[0] };
      }
      const same = h.sha256File(src) === h.sha256File(path.join(outDir, "probe.bin"));
      if (!same) return { status: "fail", detail: "transfer reported success but the output differs from the input" };
      const mbps = sizeBytes / 1024 / 1024 / seconds;
      return { status: "pass", detail: `${(sizeBytes / 1024 / 1024).toFixed(1)} MB in ${seconds.toFixed(2)}s (${mbps.toFixed(1)} MB/s incl. startup), SHA-256 match` };
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  });
}

// ---- Network ----

function checkInterfaces() {
  const addrs = [];
  for (const [name, list] of Object.entries(os.networkInterfaces()))
    for (const i of list || []) if (i.family === "IPv4" && !i.internal) addrs.push(`${i.address} (${name})`);

  if (addrs.length === 0)
    record("network", "LAN address", "warn", "no non-loopback IPv4 address", "peers can't reach this machine; the desktop app falls back to 127.0.0.1");
  else
    // The desktop app advertises the first one (desktop/src/main/network.js);
    // with several (VPN + Wi-Fi + virtual adapters) it may pick one the peer
    // can't route to.
    record(
      "network",
      "LAN address",
      addrs.length > 1 ? "warn" : "pass",
      `advertised: ${addrs[0]}${addrs.length > 1 ? `; also: ${addrs.slice(1).join(", ")}` : ""}`,
      addrs.length > 1 ? "the desktop app advertises the first address; if peers can't connect, a VPN/virtual adapter may be listed first" : undefined
    );
}

async function checkBind() {
  return check("network", "listen on all interfaces", async () => {
    const port = await new Promise((resolve, reject) => {
      const srv = net.createServer();
      srv.on("error", reject);
      srv.listen(0, "0.0.0.0", () => {
        const p = srv.address().port;
        srv.close(() => resolve(p));
      });
    });
    return {
      status: "pass",
      detail: `bound 0.0.0.0:${port}`,
      hint: process.platform === "win32" ? "inbound connections can still be blocked by Windows Defender Firewall — allow receiver.exe on Private networks" : undefined,
    };
  });
}

async function checkPeer(spec) {
  return check("network", `reach peer ${spec}`, async () => {
    const [host, portText] = spec.split(/:(?=\d+$)/);
    const port = Number(portText);
    if (!host || !port) return { status: "fail", detail: "expected --peer host:port" };
    const started = Date.now();
    await new Promise((resolve, reject) => {
      const s = net.connect({ host, port, timeout: 5000 });
      s.on("connect", () => { s.destroy(); resolve(); });
      s.on("timeout", () => { s.destroy(); reject(new Error("timed out after 5s — filtered by a firewall, or not routable from here")); });
      s.on("error", (e) =>
        reject(new Error(e.code === "ECONNREFUSED" ? "connection refused — host reachable but nothing listening on that port" : `${e.code || e.message}`))
      );
    });
    // A bare connect shows up on the peer as one connection_rejected event
    // and is otherwise harmless — the receiver keeps listening.
    return { status: "pass", detail: `TCP connect in ${Date.now() - started} ms` };
  });
}

// ---- Backend / account ----

async function fetchJson(url, { headers, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    let body = null;
    try { body = await res.json(); } catch {}
    return { status: res.status, body };
  } catch (err) {
    throw new Error(err.name === "AbortError" ? `no response within ${timeoutMs / 1000}s` : (err.cause?.code || err.message));
  } finally {
    clearTimeout(timer);
  }
}

async function checkBackend() {
  return check("backend", `health ${serverUrl}`, async () => {
    const started = Date.now();
    // Generous timeout: Render's free tier cold-starts in 30–50 s.
    const res = await fetchJson(`${serverUrl}/health`, { timeoutMs: 75000 });
    const ms = Date.now() - started;
    if (res.status !== 200 || !res.body?.ok) return { status: "fail", detail: `HTTP ${res.status}` };
    if (ms > 10000)
      return { status: "warn", detail: `ok, but took ${(ms / 1000).toFixed(1)}s`, hint: "likely a cold start after idle; presence may lag the first heartbeat" };
    return { status: "pass", detail: `ok in ${ms} ms` };
  });
}

async function checkLogin(backendUp) {
  const credPath = defaultCredentialsPath();
  let creds = null;
  try { creds = JSON.parse(fs.readFileSync(credPath, "utf8")); } catch {}

  if (!creds?.token) {
    record("backend", "CLI login", "warn", `no stored credentials (${credPath})`, "run: peerpayload login  (the desktop app keeps its own login in the OS keychain)");
    return;
  }
  if (!backendUp) {
    record("backend", "CLI login", "skip", `credentials for ${creds.username || "?"} found; backend unreachable, not verified`);
    return;
  }
  await check("backend", "CLI login", async () => {
    const res = await fetchJson(`${serverUrl}/auth/me`, { headers: { Authorization: `Bearer ${creds.token}` }, timeoutMs: 30000 });
    if (res.status === 401)
      return { status: "fail", detail: `stored session for ${creds.username || "?"} is expired or revoked`, hint: "run: peerpayload login" };
    if (res.status !== 200) return { status: "fail", detail: `/auth/me returned HTTP ${res.status}` };
    return { status: "pass", detail: `signed in as ${res.body?.username || creds.username}` };
  });
}

// ---- Leftovers ----

function checkPendingResume() {
  const dir = path.join(os.homedir(), "Downloads", "PeerPayload");
  if (!fs.existsSync(dir)) return;
  const found = [];
  const walk = (d, depth) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isFile() && e.name === "transfer.state") found.push(d);
      else if (e.isDirectory() && depth < 2) walk(path.join(d, e.name), depth + 1);
    }
  };
  try { walk(dir, 0); } catch {}
  record(
    "receive",
    "interrupted transfers",
    found.length ? "warn" : "pass",
    found.length ? `${found.length} partial transfer(s) awaiting resume: ${found.join(", ")}` : `none under ${dir}`,
    found.length ? "re-sending the same file to this machine resumes it; delete the folder to discard" : undefined
  );
}

// ---- Main ----

(async () => {
  checkSystem();
  const senderOk = (await checkBinary("sender", h.senderPath)).status === "pass";
  const receiverOk = (await checkBinary("receiver", h.receiverPath)).status === "pass";
  if (senderOk && receiverOk) {
    const tls = await checkLoopback(false);
    // Only worth isolating if TLS failed: tells "TLS setup broken" apart
    // from "engine broken".
    if (tls.status === "fail") await checkLoopback(true);
  } else {
    record("engine", "loopback transfer", "skip", "needs both binaries");
  }

  checkInterfaces();
  await checkBind();
  if (args.peer) await checkPeer(args.peer);

  if (args.offline) {
    record("backend", "backend + login", "skip", "--offline");
  } else {
    const backend = await checkBackend();
    await checkLogin(backend.status !== "fail");
  }
  checkPendingResume();

  const failed = results.filter((r) => r.status === "fail").length;
  const warned = results.filter((r) => r.status === "warn").length;

  if (args.json) {
    console.log(JSON.stringify({ ok: failed === 0, failed, warned, results }, null, 2));
  } else {
    const mark = { pass: "PASS", fail: "FAIL", warn: "WARN", skip: "SKIP", info: "INFO" };
    let section = "";
    for (const r of results) {
      if (r.section !== section) {
        section = r.section;
        console.log(`\n${section.toUpperCase()}`);
      }
      console.log(`  [${mark[r.status]}] ${r.name}: ${r.detail}`);
      if (r.hint && r.status !== "pass") console.log(`         -> ${r.hint}`);
    }
    console.log(`\n${failed ? `${failed} failed` : "no failures"}${warned ? `, ${warned} warning(s)` : ""}`);
  }
  // exitCode rather than process.exit(): exiting while fetch's sockets are
  // still closing trips a libuv assertion on Windows (exit 127).
  process.exitCode = failed ? 1 : 0;
})();

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json" || a === "--offline" || a === "--help" || a === "-h") out[a.replace(/^-+/, "").replace(/^h$/, "help")] = true;
    else if (a.startsWith("--")) out[a.slice(2)] = argv[++i];
  }
  return out;
}
