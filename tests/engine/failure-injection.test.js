// Failure injection: break things on purpose — wrong credentials, protocol
// mismatches, hostile/garbage peers, corruption in transit, dead peers — and
// check that every failure is (1) reported, not hung, (2) never leaves
// corrupted bytes as a "durable" result, and (3) doesn't take down a
// receiver that should keep listening for the real sender.
const { test, before } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const net = require("net");
const path = require("path");
const h = require("./harness");

before(() => h.assertBinariesExist());

function setup(t) {
  const srcDir = h.makeTempDir("src");
  const outDir = h.makeTempDir("out");
  t.after(() => {
    fs.rmSync(srcDir, { recursive: true, force: true });
    fs.rmSync(outDir, { recursive: true, force: true });
  });
  return { srcDir, outDir };
}

function failureReason(proc) {
  const ev = proc.ofType("transfer_failed")[0];
  return ev && ev.reason;
}

// Whatever the receiver kept from a failed run must be a correct prefix of
// the source — corruption must never be written as if it were durable.
function assertDurablePrefixMatches(outFile, srcFile) {
  if (!fs.existsSync(outFile)) return;
  const out = fs.readFileSync(outFile);
  const src = fs.readFileSync(srcFile);
  const stateFile = path.join(path.dirname(outFile), "transfer.state");
  let durableBytes = out.length;
  if (fs.existsSync(stateFile)) {
    const line = fs.readFileSync(stateFile, "utf8").split("\n").find((l) => l.endsWith(path.basename(outFile)));
    if (line) {
      const [, chunkSize, nextChunk] = line.split(" ").map(Number);
      durableBytes = Math.min(out.length, chunkSize * nextChunk);
    }
  }
  assert.ok(
    out.subarray(0, durableBytes).equals(src.subarray(0, durableBytes)),
    `durable prefix (${durableBytes} bytes) of ${outFile} does not match the source`
  );
}

// Proves a receiver that absorbed some bad connection is still usable.
async function assertReceiverStillServes(receiver, srcDir, opts = {}) {
  const src = h.writeRandomFile(path.join(srcDir, "after.bin"), 100 * 1024, 77);
  const sender = h.startSender({ port: receiver.port, sources: src, ...opts });
  const [senderExit, receiverExit] = await h.withTimeout(
    Promise.all([sender.exited, receiver.exited]),
    20000,
    "receiver did not serve a valid sender after a bad connection"
  );
  assert.equal(senderExit.code, 0, sender.stderr);
  assert.equal(receiverExit.code, 0, receiver.stderr);
  return src;
}

// ---- Connection / auth / configuration mismatches ----

test("failure: no receiver listening -> sender fails fast with connection_failed", async () => {
  const port = await h.freePort();
  const sender = h.startSender({ port, sources: __filename });
  const exit = await h.withTimeout(sender.exited, 30000, "sender hung with nobody listening");
  assert.notEqual(exit.code, 0);
  assert.equal(failureReason(sender), "connection_failed");
});

test("failure: wrong token is rejected, receiver keeps listening for the right one", async (t) => {
  const { srcDir, outDir } = setup(t);
  const receiver = await h.startReceiver({ outDir, token: "correct-horse" });
  t.after(() => receiver.kill());
  const src = h.writeRandomFile(path.join(srcDir, "x.bin"), 10000, 1);

  const bad = h.startSender({ port: receiver.port, sources: src, token: "wrong" });
  assert.notEqual((await bad.exited).code, 0);
  assert.equal(failureReason(bad), "session_auth_failed");
  await receiver.waitFor((e) => e.event === "connection_rejected" && e.reason === "session_auth_failed");
  assert.ok(!fs.existsSync(path.join(outDir, "x.bin")), "rejected sender must not write anything");

  const missing = h.startSender({ port: receiver.port, sources: src });
  assert.notEqual((await missing.exited).code, 0);
  assert.equal(failureReason(missing), "session_auth_failed");

  await assertReceiverStillServes(receiver, srcDir, { token: "correct-horse" });
});

test("failure: plaintext sender against a TLS receiver", async (t) => {
  const { srcDir, outDir } = setup(t);
  const receiver = await h.startReceiver({ outDir });
  t.after(() => receiver.kill());

  const bad = h.startSender({ port: receiver.port, sources: __filename, noTls: true });
  const exit = await h.withTimeout(bad.exited, 20000, "plaintext sender hung against TLS receiver");
  assert.notEqual(exit.code, 0);
  await receiver.waitFor((e) => e.event === "connection_rejected" && e.reason === "tls_handshake_failed");

  await assertReceiverStillServes(receiver, srcDir);
});

test("failure: TLS sender against a plaintext receiver", async (t) => {
  const { srcDir, outDir } = setup(t);
  const receiver = await h.startReceiver({ outDir, noTls: true });
  t.after(() => receiver.kill());

  const bad = h.startSender({ port: receiver.port, sources: __filename });
  const exit = await h.withTimeout(bad.exited, 20000, "TLS sender hung against plaintext receiver");
  assert.notEqual(exit.code, 0);
  await receiver.waitFor("connection_rejected");

  await assertReceiverStillServes(receiver, srcDir, { noTls: true });
});

test("failure: port scans and garbage bytes don't kill the receiver", async (t) => {
  const { srcDir, outDir } = setup(t);
  for (const noTls of [false, true]) {
    const receiver = await h.startReceiver({ outDir, noTls });
    t.after(() => receiver.kill());

    // Bare connect-then-drop, the way a port scanner or health check looks.
    await new Promise((resolve) => net.connect(receiver.port, "127.0.0.1", function () { this.destroy(); resolve(); }));
    // Random junk, then hang up.
    await new Promise((resolve) => {
      const s = net.connect(receiver.port, "127.0.0.1", () => s.end(crypto.randomBytes(4096)));
      s.on("close", resolve);
      s.on("error", resolve);
    });
    // An HTTP request to the wrong port.
    await new Promise((resolve) => {
      const s = net.connect(receiver.port, "127.0.0.1", () => s.end("GET / HTTP/1.1\r\nHost: x\r\n\r\n"));
      s.on("close", resolve);
      s.on("error", resolve);
    });

    await h.withTimeout(
      (async () => { while (receiver.ofType("connection_rejected").length < 3) await new Promise((r) => setTimeout(r, 50)); })(),
      10000,
      () => `receiver did not reject all 3 bad connections: ${receiver.events.map(h.eventType)}`
    );
    assert.equal(receiver.child.exitCode, null, "receiver exited after garbage connections");
    await assertReceiverStillServes(receiver, srcDir, { noTls });
  }
});

test("failure: invalid sender input is rejected before connecting", async () => {
  const port = await h.freePort();
  const missing = h.startSender({ port, sources: path.join(__dirname, "does-not-exist.bin") });
  assert.notEqual((await missing.exited).code, 0);
  assert.equal(failureReason(missing), "invalid_input");

  for (const chunkSize of [1024, 16 * 1024 * 1024]) {
    const bad = h.startSender({ port, sources: __filename, chunkSize });
    assert.notEqual((await bad.exited).code, 0, `chunk size ${chunkSize} should be refused`);
  }
});

// Known bug: rejectSession(..., retryable=false) emits transfer_failed but
// never sets sessionAccepted, so the receiver's accept loop keeps running —
// it reports failure yet never exits, contrary to the comment on
// rejectSession. Marked todo until the receiver exits on non-retryable
// rejections.
test("failure: unusable output directory is a reported, non-retryable failure", { todo: "receiver keeps listening after a non-retryable session_local_error" }, async (t) => {
  const { srcDir } = setup(t);
  // A regular file where the output directory should be.
  const blocker = path.join(srcDir, "not-a-dir");
  fs.writeFileSync(blocker, "x");
  const receiver = await h.startReceiver({ outDir: blocker });
  t.after(() => receiver.kill());

  const sender = h.startSender({ port: receiver.port, sources: __filename });
  const senderExit = await h.withTimeout(sender.exited, 20000, "sender hung on unusable output dir");
  assert.notEqual(senderExit.code, 0);
  assert.equal(failureReason(sender), "session_local_error");
  const receiverExit = await h.withTimeout(receiver.exited, 5000, "receiver did not exit after a non-retryable failure");
  assert.notEqual(receiverExit.code, 0);
  assert.equal(failureReason(receiver), "session_local_error");
});

// ---- Corruption in transit ----

test("failure: corrupted chunk (DTS_CORRUPT_CHUNK) aborts, nothing bad is kept, resume heals it", async (t) => {
  const { srcDir, outDir } = setup(t);
  const chunkSize = 4096;
  const corruptChunk = 50;
  const src = h.writeRandomFile(path.join(srcDir, "blob.bin"), 200 * chunkSize + 17, 2);

  const first = await h.transfer({
    sources: src,
    outDir,
    senderOpts: { chunkSize, env: { DTS_CORRUPT_CHUNK: String(corruptChunk) } },
  });
  assert.notEqual(first.senderExit.code, 0);
  assert.notEqual(first.receiverExit.code, 0);
  const mismatch = first.receiver.ofType("chunk_mismatch");
  assert.equal(mismatch.length, 1);
  assert.equal(Number(mismatch[0].chunkId), corruptChunk);
  assert.equal(failureReason(first.receiver), "chunk_mismatch");
  assert.ok(
    first.receiver.ofType("chunk_verified").every((e) => Number(e.chunkId) < corruptChunk),
    "receiver verified chunks past the corrupted one"
  );
  assertDurablePrefixMatches(path.join(outDir, "blob.bin"), src);

  const second = await h.transfer({ sources: src, outDir, senderOpts: { chunkSize } });
  assert.equal(second.senderExit.code, 0, second.sender.stderr);
  const resumeAt = Number(second.receiver.ofType("file_start")[0].resumeChunk);
  assert.equal(resumeAt, corruptChunk, "should resume exactly at the corrupted chunk");
  assert.equal(h.sha256File(path.join(outDir, "blob.bin")), h.sha256File(src));
});

for (const noTls of [true, false]) {
  test(`failure: bit flips on the wire are never accepted as data (${noTls ? "plaintext" : "tls"})`, async (t) => {
    const { srcDir, outDir } = setup(t);
    const src = h.writeRandomFile(path.join(srcDir, "blob.bin"), 1024 * 1024, 3);

    // Several offsets so the flip lands in chunk payloads, hashes, and
    // headers across runs; each must fail closed.
    for (const corruptAtByte of [20_000, 300_123, 700_001]) {
      fs.rmSync(outDir, { recursive: true, force: true });
      fs.mkdirSync(outDir);
      const receiver = await h.startReceiver({ outDir, noTls });
      const proxy = await h.startFaultProxy({ upstreamPort: receiver.port, corruptAtByte });
      const sender = h.startSender({ port: proxy.port, sources: src, noTls, chunkSize: 4096 });
      const [senderExit] = await h.withTimeout(
        Promise.all([sender.exited, receiver.exited]),
        30000,
        `hung after flipping byte ${corruptAtByte}`
      ).finally(async () => {
        sender.kill();
        receiver.kill();
        await proxy.close();
      });

      assert.ok(proxy.corrupted, "proxy never reached the corruption offset");
      assert.notEqual(senderExit.code, 0, `a flipped byte at ${corruptAtByte} went unnoticed`);
      assertDurablePrefixMatches(path.join(outDir, "blob.bin"), src);

      const healed = await h.transfer({ sources: src, outDir, receiverOpts: { noTls }, senderOpts: { noTls, chunkSize: 4096 } });
      assert.equal(healed.senderExit.code, 0, healed.sender.stderr);
      assert.equal(h.sha256File(path.join(outDir, "blob.bin")), h.sha256File(src));
    }
  });
}

// ---- Hostile sender speaking the raw (plaintext) protocol ----

const PROTOCOL_MAGIC = 0x44545331;
const PROTOCOL_VERSION = 12; // keep in sync with shared/include/protocol.hpp
const TOKEN_LEN = 64;
const MAX_PATH_LEN = 256;

function sessionHeader({ magic = PROTOCOL_MAGIC, version = PROTOCOL_VERSION, fileCount = 1, totalBytes = 0, chunkSize = 4096 } = {}) {
  const b = Buffer.alloc(4 + 4 + 8 + 8 + 4 + TOKEN_LEN);
  b.writeUInt32LE(magic, 0);
  b.writeUInt32LE(version, 4);
  b.writeBigUInt64LE(BigInt(fileCount), 8);
  b.writeBigUInt64LE(BigInt(totalBytes), 16);
  b.writeUInt32LE(chunkSize, 24);
  return b;
}

function fileHeader(fileSize, relPath) {
  const b = Buffer.alloc(8 + MAX_PATH_LEN);
  b.writeBigUInt64LE(BigInt(fileSize), 0);
  b.write(relPath, 8, "utf8");
  return b;
}

function chunkHeader(chunkId, size, hash = Buffer.alloc(32)) {
  const b = Buffer.alloc(8 + 4 + 32);
  b.writeBigUInt64LE(BigInt(chunkId), 0);
  b.writeUInt32LE(size, 8);
  hash.copy(b, 12);
  return b;
}

// Minimal blocking-style reader over a socket for request/response steps.
function rawClient(port) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, "127.0.0.1");
    let buf = Buffer.alloc(0);
    let want = null;
    let closed = false;
    const pump = () => {
      if (want && buf.length >= want.n) {
        const out = buf.subarray(0, want.n);
        buf = buf.subarray(want.n);
        const w = want;
        want = null;
        w.resolve(out);
      } else if (want && closed) {
        const w = want;
        want = null;
        w.resolve(null);
      }
    };
    sock.on("data", (d) => { buf = Buffer.concat([buf, d]); pump(); });
    sock.on("close", () => { closed = true; pump(); });
    sock.on("error", () => {});
    sock.on("connect", () =>
      resolve({
        write: (b) => sock.write(b),
        read: (n) => new Promise((res) => { want = { n, resolve: res }; pump(); }),
        close: () => sock.destroy(),
      })
    );
    sock.on("error", reject);
  });
}

async function openSession(port, opts) {
  const c = await rawClient(port);
  c.write(sessionHeader(opts));
  const ack = await c.read(2);
  return { c, ack };
}

test("failure: hostile sender — bad magic / version / file count / chunk size are rejected and receiver keeps listening", async (t) => {
  const { srcDir, outDir } = setup(t);
  const receiver = await h.startReceiver({ outDir, noTls: true });
  t.after(() => receiver.kill());

  const cases = [
    [{ magic: 0xdeadbeef }, 1, "session_bad_magic"],
    [{ version: PROTOCOL_VERSION + 1 }, 2, "session_bad_version"],
    [{ fileCount: 0 }, 3, "session_bad_count"],
    [{ chunkSize: 16 }, 5, "session_bad_chunk_size"],
  ];
  for (const [opts, reasonByte, reasonCode] of cases) {
    const { c, ack } = await openSession(receiver.port, opts);
    c.close();
    assert.ok(ack, `${reasonCode}: no SessionAck`);
    assert.equal(ack[0], 0, `${reasonCode}: session should be refused`);
    assert.equal(ack[1], reasonByte, `${reasonCode}: wrong reason byte`);
    await receiver.waitFor((e) => e.event === "connection_rejected" && e.reason === reasonCode);
  }
  await assertReceiverStillServes(receiver, srcDir, { noTls: true });
});

for (const evil of ["../escape.bin", "..\\escape.bin", "sub/../../escape.bin", "/abs-escape.bin", "C:/abs-escape.bin", ""]) {
  test(`failure: hostile sender — path ${JSON.stringify(evil)} cannot escape the output directory`, async (t) => {
    const { outDir } = setup(t);
    const inner = path.join(outDir, "inner");
    const receiver = await h.startReceiver({ outDir: inner, noTls: true });
    t.after(() => receiver.kill());

    const { c, ack } = await openSession(receiver.port, { totalBytes: 5 });
    assert.equal(ack[0], 1, "session should be accepted");
    c.write(fileHeader(5, evil));
    const resume = await c.read(8);
    if (resume) {
      const payload = Buffer.from("pwned");
      c.write(chunkHeader(0, 5, crypto.createHash("sha256").update(payload).digest()));
      c.write(payload);
      c.write(chunkHeader(0, 0));
    }
    await h.withTimeout(receiver.exited, 10000, "receiver hung on hostile path");
    c.close();

    assert.ok(!fs.existsSync(path.join(outDir, "escape.bin")), "file escaped the output directory");
    assert.ok(!fs.existsSync(path.join(path.parse(outDir).root, "abs-escape.bin")), "absolute path was honoured");
    assert.equal(failureReason(receiver), "invalid_path");
  });
}

test("failure: hostile sender — out-of-order, oversized, and missing chunks are rejected", async (t) => {
  const { outDir } = setup(t);
  const payload = crypto.randomBytes(4096);
  const hash = crypto.createHash("sha256").update(payload).digest();

  const cases = [
    ["chunk_order_error", (c) => { c.write(chunkHeader(5, 4096, hash)); c.write(payload); }],
    ["chunk_size_over_limit", (c) => { c.write(chunkHeader(0, 4096 * 2, hash)); }],
    ["chunk_count_mismatch", (c) => { c.write(chunkHeader(0, 4096, hash)); c.write(payload); c.write(chunkHeader(0, 0)); }],
  ];
  for (const [reason, misbehave] of cases) {
    const receiver = await h.startReceiver({ outDir, noTls: true });
    const { c, ack } = await openSession(receiver.port, { totalBytes: 3 * 4096 });
    assert.equal(ack[0], 1);
    c.write(fileHeader(3 * 4096, `${reason}.bin`));
    await c.read(8);
    misbehave(c);
    const exit = await h.withTimeout(receiver.exited, 10000, `receiver hung on ${reason}`);
    c.close();
    assert.notEqual(exit.code, 0);
    assert.equal(failureReason(receiver), reason);
  }
});

test("failure: hostile sender — wrong hash is nacked, not written", async (t) => {
  const { outDir } = setup(t);
  const receiver = await h.startReceiver({ outDir, noTls: true });
  const { c, ack } = await openSession(receiver.port, { totalBytes: 4096 });
  assert.equal(ack[0], 1);
  c.write(fileHeader(4096, "bad-hash.bin"));
  await c.read(8);
  c.write(chunkHeader(0, 4096, crypto.randomBytes(32)));
  c.write(crypto.randomBytes(4096));
  const chunkAck = await c.read(9);
  await h.withTimeout(receiver.exited, 10000, "receiver hung on bad hash");
  c.close();

  assert.ok(chunkAck, "no ChunkAck for a bad chunk");
  assert.equal(chunkAck[8], 0, "bad chunk must be nacked");
  assert.equal(failureReason(receiver), "chunk_mismatch");
  const out = path.join(outDir, "bad-hash.bin");
  assert.ok(!fs.existsSync(out) || fs.statSync(out).size === 0, "bad chunk bytes were written to disk");
});
