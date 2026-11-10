// Relay path end to end: real sender/receiver engines, the real relay
// (relay/src/server.js) and the client-core bridges and path policy. No
// backend — tickets are issued here with the relay's own helper.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const net = require("net");
const path = require("path");
const h = require("./harness");
const { createRelay } = require("../../relay/src/server");
const { issueBackendTicket, issueDeviceTicket } = require("../../protocol");

const issueTicket = (...args) => issueBackendTicket(...args).ticket;
const { runSender, senderReportStatus, startReceiverBridge } = require("../../client-core/transferPolicy");

const SECRET = "relay-test-secret".padEnd(40, "z");
const CHUNK = 4096;
let relay;
let relayUrl;

before(async () => {
  h.assertBinariesExist();
  relay = createRelay({ secret: SECRET, log: { warn() {} } });
  const port = await relay.listen(0, "127.0.0.1");
  relayUrl = `ws://127.0.0.1:${port}/v1/connect`;
});

after(() => relay.close());

const ticketsFor = (transferId, role) => async () => ({ url: relayUrl, ticket: issueTicket({ transferId, role, ttlSec: 300 }, SECRET) });

function setup(t) {
  const srcDir = h.makeTempDir("src");
  const outDir = h.makeTempDir("out");
  t.after(() => {
    fs.rmSync(srcDir, { recursive: true, force: true });
    fs.rmSync(outDir, { recursive: true, force: true });
  });
  return { srcDir, outDir };
}

// Receiver engine (retry window on, like the apps) plus its relay bridge.
async function startReceiverSide(t, outDir, transferId) {
  const receiver = await h.startReceiver({ outDir, transferId, token: "tok", args: ["--max-retries", "3", "--listen-timeout", "60"] });
  const bridge = startReceiverBridge({ getTicket: ticketsFor(transferId, "receiver"), enginePort: receiver.port });
  t.after(() => {
    bridge.stop();
    receiver.kill();
  });
  const pin = receiver.ofType("listening")[0].certSha256;
  return { receiver, bridge, pin };
}

const baseArgs = (transferId, pin, src) => ["--token", "tok", "--transfer-id", transferId, "--chunk-size", String(CHUNK), "--pin-sha256", pin, src];
const noWait = () => Promise.resolve();

test("relay: unreachable receiver address -> transfer goes through the relay, pinned and byte-identical", async (t) => {
  const { srcDir, outDir } = setup(t);
  const src = h.writeRandomFile(path.join(srcDir, "blob.bin"), 3 * 1024 * 1024 + 7, 21);
  const { receiver, pin } = await startReceiverSide(t, outDir, "r1");
  const deadPort = await h.freePort();
  const paths = [];

  const outcome = await runSender({
    exePath: h.senderPath,
    baseArgs: baseArgs("r1", pin, src),
    target: { host: "127.0.0.1", port: deadPort },
    relay: { getTicket: ticketsFor("r1", "sender") },
    onPath: (p) => paths.push(p),
    wait: noWait,
  });

  assert.equal(outcome.finalEvent.event, "transfer_complete", JSON.stringify(outcome.finalEvent));
  assert.equal(outcome.path, "relay");
  assert.deepEqual(paths, ["relay"]);
  assert.equal(outcome.attempts, 1);
  await h.withTimeout(receiver.exited, 10000, "receiver did not finish");
  assert.equal(h.sha256File(path.join(outDir, "blob.bin")), h.sha256File(src));
  assert.ok(relay.stats.bytes > 3 * 1024 * 1024, "bytes should have crossed the relay");
});

test("relay: a reachable receiver is used directly, never touching the relay", async (t) => {
  const { srcDir, outDir } = setup(t);
  const src = h.writeRandomFile(path.join(srcDir, "f.bin"), 500 * 1024, 22);
  const { receiver, pin } = await startReceiverSide(t, outDir, "r2");
  const before = relay.stats.bytes;

  const outcome = await runSender({
    exePath: h.senderPath,
    baseArgs: baseArgs("r2", pin, src),
    target: { host: "127.0.0.1", port: receiver.port },
    relay: { getTicket: ticketsFor("r2", "sender") },
    wait: noWait,
  });

  assert.equal(outcome.finalEvent.event, "transfer_complete");
  assert.equal(outcome.path, "direct");
  assert.equal(relay.stats.bytes, before, "no bytes may go through the relay on the direct path");
  assert.equal(h.sha256File(path.join(outDir, "f.bin")), h.sha256File(src));
});

test("relay: the advertised address answers but is the wrong machine -> pin mismatch switches to the relay", async (t) => {
  const { srcDir, outDir } = setup(t);
  const src = h.writeRandomFile(path.join(srcDir, "f.bin"), 400 * 1024, 23);
  const { receiver, pin } = await startReceiverSide(t, outDir, "r3");
  // A different receiver (different certificate) squatting on the advertised address.
  const decoyDir = h.makeTempDir("decoy");
  const decoy = await h.startReceiver({ outDir: decoyDir, transferId: "decoy" });
  t.after(() => {
    decoy.kill();
    fs.rmSync(decoyDir, { recursive: true, force: true });
  });
  const paths = [];

  const outcome = await runSender({
    exePath: h.senderPath,
    baseArgs: baseArgs("r3", pin, src),
    target: { host: "127.0.0.1", port: decoy.port },
    relay: { getTicket: ticketsFor("r3", "sender") },
    onPath: (p) => paths.push(p),
    wait: noWait,
  });

  assert.equal(outcome.finalEvent.event, "transfer_complete", JSON.stringify(outcome.finalEvent));
  assert.deepEqual(paths, ["direct", "relay"]);
  assert.equal(decoy.ofType("session_start").length, 0, "nothing may be sent to the wrong machine");
  assert.equal(fs.readdirSync(decoyDir).length, 0);
  await h.withTimeout(receiver.exited, 10000, "receiver did not finish");
  assert.equal(h.sha256File(path.join(outDir, "f.bin")), h.sha256File(src));
});

test("relay: the relay link drops mid-transfer -> the sender reconnects and resumes", async (t) => {
  const { srcDir, outDir } = setup(t);
  const size = 4 * 1024 * 1024;
  const src = h.writeRandomFile(path.join(srcDir, "big.bin"), size, 24);
  const { receiver, pin } = await startReceiverSide(t, outDir, "r4");
  const deadPort = await h.freePort();

  // Cut both relay sockets once ~1 MiB has been verified.
  let cut = false;
  const watcher = setInterval(() => {
    if (!cut && receiver.ofType("chunk_verified").length > 256) {
      cut = true;
      const slot = relay.slots.get("r4");
      slot?.sender?.terminate();
      slot?.receiver?.terminate();
    }
  }, 20);
  t.after(() => clearInterval(watcher));

  const retries = [];
  const outcome = await runSender({
    exePath: h.senderPath,
    baseArgs: baseArgs("r4", pin, src),
    target: { host: "127.0.0.1", port: deadPort },
    relay: { getTicket: ticketsFor("r4", "sender") },
    onRetry: (r) => retries.push(r),
    wait: noWait,
  });

  assert.ok(cut, "the relay link was never cut");
  assert.equal(outcome.finalEvent.event, "transfer_complete", JSON.stringify(outcome.finalEvent));
  assert.ok(outcome.attempts >= 2, `attempts ${outcome.attempts}`);
  assert.equal(retries[0].path, "relay");
  await receiver.waitFor("session_failed", 1000);
  const resumes = receiver.ofType("file_start").map((e) => Number(e.resumeChunk));
  assert.ok(resumes.length >= 2 && resumes[resumes.length - 1] > 0, `resume points ${resumes}`);
  await h.withTimeout(receiver.exited, 10000, "receiver did not finish");
  assert.equal(h.sha256File(path.join(outDir, "big.bin")), h.sha256File(src));
});

test("relay: the direct link dies mid-transfer -> the sender switches to the relay and resumes", async (t) => {
  const { srcDir, outDir } = setup(t);
  const size = 4 * 1024 * 1024;
  const src = h.writeRandomFile(path.join(srcDir, "big.bin"), size, 26);
  const { receiver, pin } = await startReceiverSide(t, outDir, "r7");

  // The "network" between the two: a pass-through to the receiver that the
  // test can take away, the way a phone leaving Wi-Fi takes its address.
  const links = new Set();
  const proxy = net.createServer((client) => {
    const upstream = net.connect(receiver.port, "127.0.0.1");
    links.add(client).add(upstream);
    client.pipe(upstream).pipe(client);
    for (const s of [client, upstream])
      s.on("error", () => {}).on("close", () => links.delete(s));
  });
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const proxyPort = proxy.address().port;
  t.after(() => proxy.close());

  // Once ~1 MiB has been verified, the address stops answering and the
  // live connection dies.
  let cut = false;
  const watcher = setInterval(() => {
    if (!cut && receiver.ofType("chunk_verified").length > 256) {
      cut = true;
      proxy.close();
      for (const s of links) s.destroy();
    }
  }, 20);
  t.after(() => clearInterval(watcher));

  const relayBytesBefore = relay.stats.bytes;
  const paths = [];
  const retries = [];
  const outcome = await runSender({
    exePath: h.senderPath,
    baseArgs: baseArgs("r7", pin, src),
    target: { host: "127.0.0.1", port: proxyPort },
    relay: { getTicket: ticketsFor("r7", "sender") },
    onPath: (p) => paths.push(p),
    onRetry: (r) => retries.push(r),
    wait: noWait,
  });

  assert.ok(cut, "the direct link was never cut");
  assert.equal(outcome.finalEvent.event, "transfer_complete", JSON.stringify(outcome.finalEvent));
  assert.deepEqual(paths, ["direct", "relay"]);
  assert.equal(retries[0].path, "direct", "the failure that caused the switch happened on the direct path");
  await h.withTimeout(receiver.exited, 10000, "receiver did not finish");

  // Resumed, not restarted: the relay session started past chunk 0 and
  // carried less than the whole file.
  const resumes = receiver.ofType("file_start").map((e) => Number(e.resumeChunk));
  assert.ok(resumes.length >= 2 && resumes[resumes.length - 1] > 0, `resume points ${resumes}`);
  const viaRelay = relay.stats.bytes - relayBytesBefore;
  assert.ok(viaRelay > 0 && viaRelay < size, `bytes through the relay: ${viaRelay} of ${size}`);
  assert.equal(h.sha256File(path.join(outDir, "big.bin")), h.sha256File(src));
});

test("relay: no direct path and no working relay -> not_reachable", async (t) => {
  const { srcDir } = setup(t);
  const src = h.writeRandomFile(path.join(srcDir, "f.bin"), 10 * 1024, 25);
  const deadPort = await h.freePort();

  // Relay configured but the receiver never joins (and tickets are valid):
  // the sender's bridge gives up pairing and the engine never connects.
  const withRelay = await runSender({
    exePath: h.senderPath,
    baseArgs: ["--token", "tok", "--transfer-id", "r5", "--idle-timeout", "5", src],
    target: { host: "127.0.0.1", port: deadPort },
    relay: { getTicket: async () => { throw new Error("relay not configured"); } },
    wait: noWait,
  });
  assert.equal(withRelay.connected, false);
  assert.equal(senderReportStatus(withRelay), "not_reachable", JSON.stringify(withRelay.finalEvent));

  // No relay at all: plain direct failure, also not_reachable.
  const noRelay = await runSender({
    exePath: h.senderPath,
    baseArgs: ["--token", "tok", "--transfer-id", "r6", src],
    target: { host: "127.0.0.1", port: deadPort },
    wait: noWait,
  });
  assert.equal(noRelay.path, "direct");
  assert.equal(noRelay.finalEvent.reason, "connection_failed");
  assert.equal(senderReportStatus(noRelay), "not_reachable");
});

test("relay: Connect-style — device identities, mutual TLS, device-signed tickets, no backend", async (t) => {
  const { execFileSync } = require("child_process");
  const keygen = path.join(path.dirname(path.dirname(h.senderPath)), "engine", `ppkeygen${process.platform === "win32" ? ".exe" : ""}`);
  const { srcDir, outDir } = setup(t);
  const idDir = h.makeTempDir("ids");
  t.after(() => fs.rmSync(idDir, { recursive: true, force: true }));

  const device = (name) => {
    const dir = path.join(idDir, name);
    const fp = JSON.parse(execFileSync(keygen, ["--out", dir], { encoding: "utf8" }).trim()).certSha256;
    const cert = path.join(dir, "device.crt");
    const key = path.join(dir, "device.key");
    return { fp, cert, key, certPem: fs.readFileSync(cert, "utf8"), keyPem: fs.readFileSync(key, "utf8") };
  };
  const alice = device("alice");
  const bob = device("bob");
  const deviceTicket = (me, peer, role) => async () => ({
    url: relayUrl,
    ticket: issueDeviceTicket({ sessionId: "c1", role, peerFingerprint: peer.fp, certPem: me.certPem, keyPem: me.keyPem }),
  });

  const src = h.writeRandomFile(path.join(srcDir, "holiday.bin"), 2 * 1024 * 1024 + 1, 26);
  const receiver = await h.startReceiver({ outDir, transferId: "c1", args: ["--cert", bob.cert, "--key", bob.key, "--peer-sha256", alice.fp, "--listen-timeout", "60"] });
  assert.equal(receiver.ofType("listening")[0].certSha256, bob.fp);
  const bridge = startReceiverBridge({ getTicket: deviceTicket(bob, alice, "receiver"), enginePort: receiver.port });
  t.after(() => {
    bridge.stop();
    receiver.kill();
  });

  const outcome = await runSender({
    exePath: h.senderPath,
    baseArgs: ["--transfer-id", "c1", "--cert", alice.cert, "--key", alice.key, "--pin-sha256", bob.fp, src],
    target: { host: "127.0.0.1", port: await h.freePort() },
    relay: { getTicket: deviceTicket(alice, bob, "sender") },
    wait: noWait,
  });

  assert.equal(outcome.finalEvent.event, "transfer_complete", JSON.stringify(outcome.finalEvent));
  assert.equal(outcome.path, "relay");
  await h.withTimeout(receiver.exited, 10000, "receiver did not finish");
  assert.equal(receiver.ofType("session_start")[0].peerCertSha256, alice.fp, "Bob's engine knows Alice sent it");
  assert.equal(h.sha256File(path.join(outDir, "holiday.bin")), h.sha256File(src));
});
