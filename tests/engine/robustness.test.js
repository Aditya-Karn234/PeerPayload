// Robustness: idle timeouts (a silent peer fails instead of hanging), the
// receiver's listen deadline, the receiver-side retry window that lets a
// reconnecting sender resume without restarting the receiver, and TLS
// certificate pinning.
const { test, before } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const net = require("net");
const path = require("path");
const h = require("./harness");

before(() => h.assertBinariesExist());

const CHUNK = 4096;

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
  return proc.ofType("transfer_failed")[0]?.reason;
}

function elapsedSince(start) {
  return (Date.now() - start) / 1000;
}

// ---- idle timeout ----

for (const noTls of [false, true]) {
  test(`timeout: a peer that goes silent mid-transfer fails both sides with peer_timeout (${noTls ? "plaintext" : "tls"})`, async (t) => {
    const { srcDir, outDir } = setup(t);
    const src = h.writeRandomFile(path.join(srcDir, "blob.bin"), 2 * 1024 * 1024, 4);

    const receiver = await h.startReceiver({ outDir, noTls, args: ["--idle-timeout", "2"] });
    const proxy = await h.startFaultProxy({ upstreamPort: receiver.port, freezeAfterBytes: 512 * 1024 });
    const sender = h.startSender({ port: proxy.port, sources: src, noTls, chunkSize: CHUNK, args: ["--idle-timeout", "2"] });
    const started = Date.now();
    t.after(async () => {
      sender.kill();
      receiver.kill();
      await proxy.close();
    });

    const [senderExit, receiverExit] = await h.withTimeout(
      Promise.all([sender.exited, receiver.exited]),
      20000,
      "a frozen link hung instead of timing out"
    );

    assert.ok(proxy.frozen, `proxy never froze; sender: ${failureReason(sender)}, receiver: ${failureReason(receiver)}
${sender.stderr}
${receiver.stderr}`);
    assert.notEqual(senderExit.code, 0);
    assert.notEqual(receiverExit.code, 0);
    assert.equal(failureReason(sender), "peer_timeout", sender.stderr);
    assert.equal(failureReason(receiver), "peer_timeout", receiver.stderr);
    assert.ok(elapsedSince(started) < 15, `took ${elapsedSince(started)} s`);
    assert.ok(fs.existsSync(path.join(outDir, "transfer.state")), "resume state should survive a timeout");
  });
}

test("timeout: a connection that never speaks is dropped and the receiver keeps listening", async (t) => {
  const { srcDir, outDir } = setup(t);
  const src = h.writeRandomFile(path.join(srcDir, "small.bin"), 100 * 1024, 5);
  const receiver = await h.startReceiver({ outDir, args: ["--idle-timeout", "1"] });
  t.after(() => receiver.kill());

  // Connect and say nothing: without a timeout this would block the
  // single-threaded receiver's TLS handshake forever.
  const silent = net.connect(receiver.port, "127.0.0.1");
  silent.on("error", () => {});
  await receiver.waitFor((e) => h.eventType(e) === "connection_rejected", 10000);
  silent.destroy();

  const sender = h.startSender({ port: receiver.port, sources: src });
  const [senderExit, receiverExit] = await h.withTimeout(Promise.all([sender.exited, receiver.exited]), 20000, "transfer after silent client hung");
  assert.equal(senderExit.code, 0, sender.stderr);
  assert.equal(receiverExit.code, 0, receiver.stderr);
  assert.equal(h.sha256File(path.join(outDir, "small.bin")), h.sha256File(src));
});

test("timeout: --idle-timeout 0 is accepted and a normal transfer still completes", async (t) => {
  const { srcDir, outDir } = setup(t);
  const src = h.writeRandomFile(path.join(srcDir, "f.bin"), 300 * 1024, 6);
  const run = await h.transfer({
    sources: src,
    outDir,
    receiverOpts: { args: ["--idle-timeout", "0"] },
    senderOpts: { args: ["--idle-timeout", "0"] },
  });
  assert.equal(run.senderExit.code, 0, run.sender.stderr);
  assert.equal(h.sha256File(path.join(outDir, "f.bin")), h.sha256File(src));
});

// ---- listen deadline ----

test("listen timeout: a receiver nobody connects to exits with listen_timeout", async (t) => {
  const { outDir } = setup(t);
  const started = Date.now();
  const receiver = await h.startReceiver({ outDir, args: ["--listen-timeout", "2"] });
  const exit = await h.withTimeout(receiver.exited, 15000, "receiver never gave up listening");
  assert.equal(exit.code, 1);
  assert.equal(failureReason(receiver), "listen_timeout");
  assert.ok(elapsedSince(started) >= 1.5 && elapsedSince(started) < 10, `took ${elapsedSince(started)} s`);
});

test("listen timeout: rejected connections don't extend the deadline", async (t) => {
  const { outDir } = setup(t);
  const receiver = await h.startReceiver({ outDir, args: ["--listen-timeout", "3", "--idle-timeout", "1"] });
  const started = Date.now();
  // A plaintext poke at a TLS receiver: rejected, and it must not reset the clock.
  const poke = net.connect(receiver.port, "127.0.0.1", () => poke.end("garbage"));
  poke.on("error", () => {});
  const exit = await h.withTimeout(receiver.exited, 15000, "receiver never gave up listening");
  assert.equal(exit.code, 1);
  assert.equal(failureReason(receiver), "listen_timeout");
  assert.ok(receiver.ofType("connection_rejected").length >= 1);
  assert.ok(elapsedSince(started) < 8, `took ${elapsedSince(started)} s`);
});

// ---- receiver retry window ----

async function cutRun({ receiver, src, cutAfterBytes, noTls = false }) {
  const proxy = await h.startFaultProxy({ upstreamPort: receiver.port, cutAfterBytes });
  const sender = h.startSender({ port: proxy.port, sources: src, noTls, chunkSize: CHUNK });
  const exit = await h.withTimeout(sender.exited, 30000, "interrupted sender did not exit");
  await proxy.close();
  assert.ok(proxy.cut, "proxy never reached its cut point");
  return { sender, exit };
}

for (const noTls of [false, true]) {
  test(`retry: with --max-retries the same receiver survives a dropped link and the re-run resumes (${noTls ? "plaintext" : "tls"})`, async (t) => {
    const { srcDir, outDir } = setup(t);
    const size = 2 * 1024 * 1024 + 99;
    const src = h.writeRandomFile(path.join(srcDir, "blob.bin"), size, 7);
    const chunkCount = Math.ceil(size / CHUNK);

    const receiver = await h.startReceiver({ outDir, noTls, args: ["--max-retries", "2"] });
    t.after(() => receiver.kill());

    const first = await cutRun({ receiver, src, cutAfterBytes: 1024 * 1024, noTls });
    assert.notEqual(first.exit.code, 0);

    const sessionFailed = await receiver.waitFor("session_failed", 10000);
    assert.equal(Number(sessionFailed.attempt), 1);
    assert.equal(Number(sessionFailed.retriesLeft), 1);
    assert.equal(receiver.ofType("transfer_failed").length, 0, "a retryable failure must not be reported as final");
    assert.equal(receiver.child.exitCode, null, "receiver should still be running");
    const durable = receiver.ofType("chunk_verified").length;

    const second = h.startSender({ port: receiver.port, sources: src, noTls, chunkSize: CHUNK });
    const [senderExit, receiverExit] = await h.withTimeout(Promise.all([second.exited, receiver.exited]), 30000, "resumed run hung");
    assert.equal(senderExit.code, 0, second.stderr);
    assert.equal(receiverExit.code, 0, receiver.stderr);

    const resumedAt = Number(receiver.ofType("file_start")[1].resumeChunk);
    assert.ok(resumedAt >= durable, `resumed at ${resumedAt}, ${durable} chunks were durable`);
    assert.equal(second.ofType("chunk_verified").length, chunkCount - resumedAt, "only the remainder should be re-sent");
    assert.equal(h.sha256File(path.join(outDir, "blob.bin")), h.sha256File(src));
    assert.equal(receiver.ofType("transfer_complete").length, 1);
  });
}

test("retry: once --max-retries is used up, the next failure is final", async (t) => {
  const { srcDir, outDir } = setup(t);
  const src = h.writeRandomFile(path.join(srcDir, "blob.bin"), 2 * 1024 * 1024, 8);
  const receiver = await h.startReceiver({ outDir, args: ["--max-retries", "1"] });
  t.after(() => receiver.kill());

  await cutRun({ receiver, src, cutAfterBytes: 600 * 1024 });
  await receiver.waitFor("session_failed", 10000);

  await cutRun({ receiver, src, cutAfterBytes: 600 * 1024 });
  const exit = await h.withTimeout(receiver.exited, 15000, "receiver kept listening past its retry budget");
  assert.equal(exit.code, 1);
  assert.equal(receiver.ofType("session_failed").length, 1);
  assert.ok(failureReason(receiver), "final failure should carry a reason");
});

test("retry: a corrupted chunk is retryable and the re-run resumes exactly at it", async (t) => {
  const { srcDir, outDir } = setup(t);
  const src = h.writeRandomFile(path.join(srcDir, "blob.bin"), 200 * CHUNK + 5, 9);
  const receiver = await h.startReceiver({ outDir, args: ["--max-retries", "1"] });
  t.after(() => receiver.kill());

  const bad = h.startSender({ port: receiver.port, sources: src, chunkSize: CHUNK, env: { DTS_CORRUPT_CHUNK: "40" } });
  await h.withTimeout(bad.exited, 20000, "corrupting sender hung");
  const sf = await receiver.waitFor("session_failed", 10000);
  assert.equal(sf.reason, "chunk_mismatch");

  const good = h.startSender({ port: receiver.port, sources: src, chunkSize: CHUNK });
  const [senderExit, receiverExit] = await h.withTimeout(Promise.all([good.exited, receiver.exited]), 20000, "resume after corruption hung");
  assert.equal(senderExit.code, 0, good.stderr);
  assert.equal(receiverExit.code, 0, receiver.stderr);
  assert.equal(Number(receiver.ofType("file_start")[1].resumeChunk), 40);
  assert.equal(h.sha256File(path.join(outDir, "blob.bin")), h.sha256File(src));
});

test("retry: a listen deadline is re-armed after a retryable failure", async (t) => {
  const { srcDir, outDir } = setup(t);
  const src = h.writeRandomFile(path.join(srcDir, "blob.bin"), 2 * 1024 * 1024, 10);
  const receiver = await h.startReceiver({ outDir, args: ["--max-retries", "3", "--listen-timeout", "2"] });
  t.after(() => receiver.kill());

  await cutRun({ receiver, src, cutAfterBytes: 600 * 1024 });
  await receiver.waitFor("session_failed", 10000);
  // Nobody reconnects: the re-armed deadline should end it, not hang forever.
  const exit = await h.withTimeout(receiver.exited, 15000, "receiver waited forever for a reconnect");
  assert.equal(exit.code, 1);
  assert.equal(failureReason(receiver), "listen_timeout");
});

// ---- certificate pinning ----

test("pinning: listening publishes a fingerprint, and the cert is stable across connections", async (t) => {
  const { srcDir, outDir } = setup(t);
  const src = h.writeRandomFile(path.join(srcDir, "f.bin"), 200 * 1024, 11);
  const receiver = await h.startReceiver({ outDir, args: ["--max-retries", "1"] });
  t.after(() => receiver.kill());

  const fp = receiver.ofType("listening")[0].certSha256;
  assert.match(fp, /^[0-9a-f]{64}$/);

  // First connection fails (cut); second must present the same certificate.
  const first = await cutRun({ receiver, src: h.writeRandomFile(path.join(srcDir, "big.bin"), 2 * 1024 * 1024, 12), cutAfterBytes: 300 * 1024 });
  assert.equal(first.sender.ofType("session_start")[0].certSha256, fp);
  await receiver.waitFor("session_failed", 10000);

  const second = h.startSender({ port: receiver.port, sources: path.join(srcDir, "big.bin"), chunkSize: CHUNK, args: ["--pin-sha256", fp.toUpperCase()] });
  const [senderExit] = await h.withTimeout(Promise.all([second.exited, receiver.exited]), 30000, "pinned resume hung");
  assert.equal(senderExit.code, 0, second.stderr);
  const start = second.ofType("session_start")[0];
  assert.equal(start.certSha256, fp);
  assert.equal(start.pinned, true);
  assert.ok(src);
});

test("pinning: a wrong pin is refused, and the receiver keeps listening for the right sender", async (t) => {
  const { srcDir, outDir } = setup(t);
  const src = h.writeRandomFile(path.join(srcDir, "f.bin"), 200 * 1024, 13);
  const receiver = await h.startReceiver({ outDir });
  t.after(() => receiver.kill());
  const fp = receiver.ofType("listening")[0].certSha256;
  const wrong = (fp[0] === "0" ? "1" : "0") + fp.slice(1);

  const bad = h.startSender({ port: receiver.port, sources: src, args: ["--pin-sha256", wrong] });
  const badExit = await h.withTimeout(bad.exited, 15000, "mismatched pin hung");
  assert.equal(badExit.code, 1);
  assert.equal(failureReason(bad), "tls_pin_mismatch");
  assert.equal(bad.ofType("session_start").length, 0, "no data may flow to an unpinned receiver");
  await receiver.waitFor("connection_rejected", 10000);

  const good = h.startSender({ port: receiver.port, sources: src, args: ["--pin-sha256", fp] });
  const [goodExit, receiverExit] = await h.withTimeout(Promise.all([good.exited, receiver.exited]), 20000, "pinned transfer hung");
  assert.equal(goodExit.code, 0, good.stderr);
  assert.equal(receiverExit.code, 0, receiver.stderr);
  assert.equal(h.sha256File(path.join(outDir, "f.bin")), h.sha256File(src));
});

test("pinning: invalid or TLS-less pins are rejected before connecting", async (t) => {
  const { srcDir } = setup(t);
  const src = h.writeRandomFile(path.join(srcDir, "f.bin"), 1024, 14);
  for (const args of [["--pin-sha256", "abc"], ["--pin-sha256", "z".repeat(64)], ["--no-tls", "--pin-sha256", "a".repeat(64)]]) {
    const sender = h.startSender({ port: 1, sources: src, args });
    const exit = await h.withTimeout(sender.exited, 10000, `sender hung on ${args.join(" ")}`);
    assert.equal(exit.code, 1, `accepted ${args.join(" ")}`);
    assert.equal(sender.ofType("session_start").length, 0);
  }
});
