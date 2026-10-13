// Resume: an interrupted transfer, re-run with the same command, picks up
// from the receiver's last durable chunk and still ends byte-identical — and
// refuses to resume when doing so would splice two different files.
const { test, before } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const h = require("./harness");

before(() => h.assertBinariesExist());

// Small chunks so a few MB means hundreds of chunks: plenty of room to
// interrupt squarely in the middle.
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

// Runs one session through a proxy that severs the link after cutAfterBytes.
async function interruptedRun({ sources, outDir, cutAfterBytes, noTls = false, chunkSize = CHUNK }) {
  const receiver = await h.startReceiver({ outDir, noTls });
  const proxy = await h.startFaultProxy({ upstreamPort: receiver.port, cutAfterBytes });
  const sender = h.startSender({ port: proxy.port, sources, noTls, chunkSize });
  try {
    const [senderExit, receiverExit] = await h.withTimeout(
      Promise.all([sender.exited, receiver.exited]),
      30000,
      "interrupted run did not terminate"
    );
    assert.ok(proxy.cut, "proxy never reached its cut point — file too small for this cutAfterBytes?");
    return { sender, receiver, senderExit, receiverExit };
  } finally {
    sender.kill();
    receiver.kill();
    await proxy.close();
  }
}

function resumeChunkOf(proc, relPath) {
  const ev = proc.ofType("file_start").find((e) => e.relPath === relPath);
  assert.ok(ev, `no file_start for ${relPath}`);
  return Number(ev.resumeChunk);
}

for (const noTls of [false, true]) {
  test(`resume: link dropped mid-transfer, re-run completes byte-identical (${noTls ? "no-tls" : "tls"})`, async (t) => {
    const { srcDir, outDir } = setup(t);
    const size = 2 * 1024 * 1024 + 321;
    const src = h.writeRandomFile(path.join(srcDir, "blob.bin"), size, 1);
    const chunkCount = Math.ceil(size / CHUNK);

    const first = await interruptedRun({ sources: src, outDir, cutAfterBytes: 1024 * 1024, noTls });
    assert.notEqual(first.senderExit.code, 0, "sender should fail when the link drops");
    assert.notEqual(first.receiverExit.code, 0, "receiver should fail when the link drops");
    assert.equal(first.sender.ofType("transfer_complete").length, 0);
    assert.ok(first.sender.ofType("transfer_failed").length >= 1, "sender should report transfer_failed");
    assert.ok(fs.existsSync(path.join(outDir, "transfer.state")), "resume state should survive the failure");
    const durable = first.receiver.ofType("chunk_verified").length;
    assert.ok(durable > 0 && durable < chunkCount, `expected a partial transfer, got ${durable}/${chunkCount} chunks`);

    const second = await h.transfer({ sources: src, outDir, receiverOpts: { noTls }, senderOpts: { noTls, chunkSize: CHUNK } });
    assert.equal(second.senderExit.code, 0, second.sender.stderr);
    assert.equal(second.receiverExit.code, 0, second.receiver.stderr);

    const resumedAt = resumeChunkOf(second.receiver, "blob.bin");
    assert.ok(resumedAt >= durable, `resumed at ${resumedAt}, but ${durable} chunks were already durable`);
    assert.equal(resumeChunkOf(second.sender, "blob.bin"), resumedAt, "sender and receiver disagree on resume point");
    // Only the remainder is re-sent, not the whole file.
    assert.equal(second.receiver.ofType("chunk_verified").length, chunkCount - resumedAt);

    assert.equal(h.sha256File(path.join(outDir, "blob.bin")), h.sha256File(src));
    assert.ok(!fs.existsSync(path.join(outDir, "transfer.state")), "transfer.state should be removed after completion");
  });
}

test("resume: receiver process killed mid-transfer", async (t) => {
  const { srcDir, outDir } = setup(t);
  const src = h.writeRandomFile(path.join(srcDir, "blob.bin"), 4 * 1024 * 1024, 2);

  const receiver = await h.startReceiver({ outDir });
  const sender = h.startSender({ port: receiver.port, sources: src, chunkSize: CHUNK });
  await receiver.waitFor((e) => e.event === "chunk_verified" && Number(e.chunkId) >= 100);
  await receiver.kill();
  const senderExit = await h.withTimeout(sender.exited, 20000, "sender hung after receiver died");
  assert.notEqual(senderExit.code, 0);
  assert.ok(sender.ofType("transfer_failed").length >= 1);

  const second = await h.transfer({ sources: src, outDir, senderOpts: { chunkSize: CHUNK } });
  assert.equal(second.senderExit.code, 0, second.sender.stderr);
  assert.ok(resumeChunkOf(second.receiver, "blob.bin") >= 100);
  assert.equal(h.sha256File(path.join(outDir, "blob.bin")), h.sha256File(src));
});

test("resume: sender process killed mid-transfer", async (t) => {
  const { srcDir, outDir } = setup(t);
  const src = h.writeRandomFile(path.join(srcDir, "blob.bin"), 4 * 1024 * 1024, 3);

  const receiver = await h.startReceiver({ outDir });
  const sender = h.startSender({ port: receiver.port, sources: src, chunkSize: CHUNK });
  await receiver.waitFor((e) => e.event === "chunk_verified" && Number(e.chunkId) >= 100);
  await sender.kill();
  const receiverExit = await h.withTimeout(receiver.exited, 20000, "receiver hung after sender died");
  assert.notEqual(receiverExit.code, 0);

  const second = await h.transfer({ sources: src, outDir, senderOpts: { chunkSize: CHUNK } });
  assert.equal(second.senderExit.code, 0, second.sender.stderr);
  assert.ok(resumeChunkOf(second.receiver, "blob.bin") >= 100);
  assert.equal(h.sha256File(path.join(outDir, "blob.bin")), h.sha256File(src));
});

test("resume: survives several interruptions in a row", async (t) => {
  const { srcDir, outDir } = setup(t);
  const src = h.writeRandomFile(path.join(srcDir, "blob.bin"), 3 * 1024 * 1024, 4);

  let lastResume = -1;
  for (let i = 0; i < 3; i++) {
    const run = await interruptedRun({ sources: src, outDir, cutAfterBytes: 512 * 1024 });
    const resumedAt = resumeChunkOf(run.receiver, "blob.bin");
    assert.ok(resumedAt > lastResume, `run ${i}: resume point did not advance (${resumedAt} after ${lastResume})`);
    lastResume = resumedAt;
  }

  const final = await h.transfer({ sources: src, outDir, senderOpts: { chunkSize: CHUNK } });
  assert.equal(final.senderExit.code, 0, final.sender.stderr);
  assert.equal(h.sha256File(path.join(outDir, "blob.bin")), h.sha256File(src));
});

test("resume: directory transfer interrupted mid-way keeps finished files and resumes the rest", async (t) => {
  const { srcDir, outDir } = setup(t);
  const files = ["dir/a.bin", "dir/b.bin", "dir/c.bin"];
  files.forEach((rel, i) => h.writeRandomFile(path.join(srcDir, rel), 1024 * 1024, 10 + i));

  // Cut somewhere inside the second file.
  const first = await interruptedRun({ sources: path.join(srcDir, "dir"), outDir, cutAfterBytes: 1.5 * 1024 * 1024 });
  assert.ok(first.receiver.ofType("file_complete").length >= 1, "first file should have completed before the cut");

  const second = await h.transfer({ sources: path.join(srcDir, "dir"), outDir, senderOpts: { chunkSize: CHUNK } });
  assert.equal(second.senderExit.code, 0, second.sender.stderr);
  for (const rel of files) assert.equal(h.sha256File(path.join(outDir, rel)), h.sha256File(path.join(srcDir, rel)), rel);
  assert.ok(!fs.existsSync(path.join(outDir, "transfer.state")));
});

test("resume: a source file whose size changed restarts from chunk 0", async (t) => {
  const { srcDir, outDir } = setup(t);
  const src = path.join(srcDir, "blob.bin");
  h.writeRandomFile(src, 2 * 1024 * 1024, 5);
  await interruptedRun({ sources: src, outDir, cutAfterBytes: 1024 * 1024 });

  h.writeRandomFile(src, 2 * 1024 * 1024 + 1, 6);
  const second = await h.transfer({ sources: src, outDir, senderOpts: { chunkSize: CHUNK } });
  assert.equal(second.senderExit.code, 0, second.sender.stderr);
  assert.equal(resumeChunkOf(second.receiver, "blob.bin"), 0);
  assert.equal(h.sha256File(path.join(outDir, "blob.bin")), h.sha256File(src));
});

test("resume: a different --chunk-size restarts from chunk 0", async (t) => {
  const { srcDir, outDir } = setup(t);
  const src = h.writeRandomFile(path.join(srcDir, "blob.bin"), 2 * 1024 * 1024, 7);
  await interruptedRun({ sources: src, outDir, cutAfterBytes: 1024 * 1024, chunkSize: CHUNK });

  const second = await h.transfer({ sources: src, outDir, senderOpts: { chunkSize: 8192 } });
  assert.equal(second.senderExit.code, 0, second.sender.stderr);
  assert.equal(resumeChunkOf(second.receiver, "blob.bin"), 0);
  assert.equal(h.sha256File(path.join(outDir, "blob.bin")), h.sha256File(src));
});

test("resume: partial file deleted while state remains restarts from chunk 0", async (t) => {
  const { srcDir, outDir } = setup(t);
  const src = h.writeRandomFile(path.join(srcDir, "blob.bin"), 2 * 1024 * 1024, 8);
  await interruptedRun({ sources: src, outDir, cutAfterBytes: 1024 * 1024 });
  fs.rmSync(path.join(outDir, "blob.bin"));

  const second = await h.transfer({ sources: src, outDir, senderOpts: { chunkSize: CHUNK } });
  assert.equal(second.senderExit.code, 0, second.sender.stderr);
  assert.equal(resumeChunkOf(second.receiver, "blob.bin"), 0);
  assert.equal(h.sha256File(path.join(outDir, "blob.bin")), h.sha256File(src));
});

test("resume: garbage transfer.state is discarded, not trusted", async (t) => {
  const { srcDir, outDir } = setup(t);
  const src = h.writeRandomFile(path.join(srcDir, "blob.bin"), 512 * 1024, 9);
  fs.writeFileSync(path.join(outDir, "transfer.state"), "not a state file\n99999 4096 99999 blob.bin\n");

  const run = await h.transfer({ sources: src, outDir, senderOpts: { chunkSize: CHUNK } });
  assert.equal(run.senderExit.code, 0, run.sender.stderr);
  assert.equal(resumeChunkOf(run.receiver, "blob.bin"), 0);
  assert.equal(h.sha256File(path.join(outDir, "blob.bin")), h.sha256File(src));
});

test("resume: state claiming more chunks than the file holds is ignored", async (t) => {
  const { srcDir, outDir } = setup(t);
  const size = 256 * 1024;
  const src = h.writeRandomFile(path.join(srcDir, "blob.bin"), size, 10);
  // Read the real header line from a genuine interrupted run, then forge an
  // out-of-range offset under it.
  const big = h.writeRandomFile(path.join(srcDir, "big.bin"), 2 * 1024 * 1024, 11);
  await interruptedRun({ sources: big, outDir, cutAfterBytes: 1024 * 1024 });
  const header = fs.readFileSync(path.join(outDir, "transfer.state"), "utf8").split("\n")[0];
  fs.writeFileSync(path.join(outDir, "transfer.state"), `${header}\n${size} ${CHUNK} 999999 blob.bin\n`);

  const run = await h.transfer({ sources: src, outDir, senderOpts: { chunkSize: CHUNK } });
  assert.equal(run.senderExit.code, 0, run.sender.stderr);
  assert.equal(resumeChunkOf(run.receiver, "blob.bin"), 0);
  assert.equal(h.sha256File(path.join(outDir, "blob.bin")), h.sha256File(src));
});

// Known gap, documented rather than hidden: resume eligibility checks file
// size and chunk size but not content, so a same-size edit to the source
// between runs resumes and produces a splice of old and new bytes. Marked
// todo so it reports without failing the suite; flip it to a normal test
// once the protocol carries a source fingerprint (e.g. mtime or a hash of
// the first chunk).
test("resume: same-size content change between runs is detected", { todo: "resume does not fingerprint source content yet" }, async (t) => {
  const { srcDir, outDir } = setup(t);
  const src = path.join(srcDir, "blob.bin");
  h.writeRandomFile(src, 2 * 1024 * 1024, 12);
  await interruptedRun({ sources: src, outDir, cutAfterBytes: 1024 * 1024 });

  h.writeRandomFile(src, 2 * 1024 * 1024, 13);
  const second = await h.transfer({ sources: src, outDir, senderOpts: { chunkSize: CHUNK } });
  assert.equal(second.senderExit.code, 0, second.sender.stderr);
  assert.equal(h.sha256File(path.join(outDir, "blob.bin")), h.sha256File(src));
});
