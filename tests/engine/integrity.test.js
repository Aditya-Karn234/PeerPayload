// Integrity: whatever goes in one side comes out the other byte-for-byte,
// across the shapes of input that stress chunk-boundary and path handling.
const { test, before } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const h = require("./harness");

before(() => h.assertBinariesExist());

async function sendAndCompare(t, { files, sourceArg, chunkSize, noTls, window }) {
  const srcDir = h.makeTempDir("src");
  const outDir = h.makeTempDir("out");
  t.after(() => {
    fs.rmSync(srcDir, { recursive: true, force: true });
    fs.rmSync(outDir, { recursive: true, force: true });
  });

  for (const [rel, size, seed] of files) h.writeRandomFile(path.join(srcDir, rel), size, seed);

  const sources = sourceArg(srcDir);
  const { sender, receiver, senderExit, receiverExit } = await h.transfer({
    sources,
    outDir,
    receiverOpts: { noTls },
    senderOpts: { noTls, chunkSize, window },
  });

  assert.equal(senderExit.code, 0, `sender failed: ${sender.stderr}`);
  assert.equal(receiverExit.code, 0, `receiver failed: ${receiver.stderr}`);
  assert.equal(sender.ofType("transfer_complete").length, 1);
  assert.equal(receiver.ofType("transfer_complete").length, 1);
  assert.equal(receiver.ofType("chunk_mismatch").length, 0);

  // Resume state is removed once a session finishes cleanly.
  assert.ok(!fs.existsSync(path.join(outDir, "transfer.state")), "transfer.state left behind after success");

  return { srcDir, outDir, sender, receiver };
}

const singleFile = (rel) => (srcDir) => path.join(srcDir, rel);

for (const [name, size] of [
  ["empty file", 0],
  ["1 byte", 1],
  ["exactly one 64 KiB chunk", 64 * 1024],
  ["one byte past a chunk boundary", 64 * 1024 + 1],
  ["one byte short of a chunk boundary", 3 * 64 * 1024 - 1],
  ["multi-MB, many chunks", 5 * 1024 * 1024 + 123],
]) {
  test(`integrity: ${name} (${size} bytes)`, async (t) => {
    const { srcDir, outDir } = await sendAndCompare(t, {
      files: [["blob.bin", size, size]],
      sourceArg: singleFile("blob.bin"),
    });
    const out = path.join(outDir, "blob.bin");
    assert.equal(fs.statSync(out).size, size);
    assert.equal(h.sha256File(out), h.sha256File(path.join(srcDir, "blob.bin")));
  });
}

for (const chunkSize of [4096, 65536, 1024 * 1024, 8 * 1024 * 1024]) {
  test(`integrity: chunk size ${chunkSize}`, async (t) => {
    const size = 3 * 1024 * 1024 + 7;
    const { srcDir, outDir } = await sendAndCompare(t, {
      files: [["blob.bin", size, chunkSize]],
      sourceArg: singleFile("blob.bin"),
      chunkSize,
    });
    assert.equal(h.sha256File(path.join(outDir, "blob.bin")), h.sha256File(path.join(srcDir, "blob.bin")));
  });
}

for (const window of [1, 64]) {
  test(`integrity: window ${window}`, async (t) => {
    const { srcDir, outDir } = await sendAndCompare(t, {
      files: [["blob.bin", 2 * 1024 * 1024 + 99, window]],
      sourceArg: singleFile("blob.bin"),
      window,
    });
    assert.equal(h.sha256File(path.join(outDir, "blob.bin")), h.sha256File(path.join(srcDir, "blob.bin")));
  });
}

test("integrity: --no-tls on both sides", async (t) => {
  const { srcDir, outDir } = await sendAndCompare(t, {
    files: [["blob.bin", 1024 * 1024 + 5, 9]],
    sourceArg: singleFile("blob.bin"),
    noTls: true,
  });
  assert.equal(h.sha256File(path.join(outDir, "blob.bin")), h.sha256File(path.join(srcDir, "blob.bin")));
});

test("integrity: nested directory keeps structure and every file's bytes", async (t) => {
  const files = [
    ["tree/a.txt", 10, 1],
    ["tree/empty.bin", 0, 2],
    ["tree/sub/b.bin", 200 * 1024 + 3, 3],
    ["tree/sub/deeper/c.bin", 64 * 1024, 4],
    ["tree/with space/d e.bin", 777, 5],
    ["tree/ünïcødé/文件.bin", 4321, 6],
  ];
  const { srcDir, outDir } = await sendAndCompare(t, {
    files,
    sourceArg: (src) => path.join(src, "tree"),
  });

  const expected = files.map(([rel]) => rel).sort();
  assert.deepEqual(
    h.listFilesRecursive(outDir).filter((f) => f !== "transfer.state"),
    expected
  );
  for (const [rel] of files)
    assert.equal(h.sha256File(path.join(outDir, rel)), h.sha256File(path.join(srcDir, rel)), rel);
});

test("integrity: multiple source arguments in one session", async (t) => {
  const files = [
    ["one.bin", 1000, 11],
    ["two.bin", 70000, 12],
  ];
  const { srcDir, outDir, receiver } = await sendAndCompare(t, {
    files,
    sourceArg: (src) => files.map(([rel]) => path.join(src, rel)),
  });
  assert.equal(receiver.ofType("file_complete").length, 2);
  for (const [rel] of files)
    assert.equal(h.sha256File(path.join(outDir, rel)), h.sha256File(path.join(srcDir, rel)));
});

test("integrity: a stale longer file at the destination is truncated, not spliced", async (t) => {
  const srcDir = h.makeTempDir("src");
  const outDir = h.makeTempDir("out");
  t.after(() => {
    fs.rmSync(srcDir, { recursive: true, force: true });
    fs.rmSync(outDir, { recursive: true, force: true });
  });
  h.writeRandomFile(path.join(outDir, "blob.bin"), 500 * 1024, 99);
  const src = h.writeRandomFile(path.join(srcDir, "blob.bin"), 100 * 1024 + 1, 100);

  const { senderExit } = await h.transfer({ sources: src, outDir });
  assert.equal(senderExit.code, 0);
  assert.equal(fs.statSync(path.join(outDir, "blob.bin")).size, 100 * 1024 + 1);
  assert.equal(h.sha256File(path.join(outDir, "blob.bin")), h.sha256File(src));
});

test("integrity: chunk_verified events cover every chunk exactly once, in order", async (t) => {
  const chunkSize = 4096;
  const size = 37 * chunkSize + 100;
  const { receiver } = await sendAndCompare(t, {
    files: [["blob.bin", size, 7]],
    sourceArg: singleFile("blob.bin"),
    chunkSize,
  });
  const ids = receiver.ofType("chunk_verified").map((e) => Number(e.chunkId));
  assert.deepEqual(ids, Array.from({ length: Math.ceil(size / chunkSize) }, (_, i) => i));
  const bytes = receiver.ofType("chunk_verified").reduce((n, e) => n + Number(e.bytes), 0);
  assert.equal(bytes, size);
});
