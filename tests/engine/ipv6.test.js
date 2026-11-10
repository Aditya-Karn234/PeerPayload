// IPv6: the receiver listens dual-stack (IPv6 and IPv4 on one port) and the
// sender connects over IPv6 — needed on IPv6-only mobile networks. Skipped
// automatically where the machine has no IPv6 loopback.
const { test, before } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const net = require("net");
const path = require("path");
const h = require("./harness");

let ipv6Available = false;

before(async () => {
  h.assertBinariesExist();
  ipv6Available = await new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.listen(0, "::1", () => srv.close(() => resolve(true)));
  });
});

function setup(t) {
  const srcDir = h.makeTempDir("src");
  const outDir = h.makeTempDir("out");
  t.after(() => {
    fs.rmSync(srcDir, { recursive: true, force: true });
    fs.rmSync(outDir, { recursive: true, force: true });
  });
  return { srcDir, outDir };
}

async function sendVia(t, host, { receiverArgs = [], senderArgs = [] } = {}) {
  const { srcDir, outDir } = setup(t);
  const src = h.writeRandomFile(path.join(srcDir, "f.bin"), 700 * 1024 + 9, 41);
  const receiver = await h.startReceiver({ outDir, args: receiverArgs });
  const sender = h.startSender({ host, port: receiver.port, sources: src, args: senderArgs });
  const [senderExit, receiverExit] = await h.withTimeout(Promise.all([sender.exited, receiver.exited]), 30000, `transfer via ${host} hung`).finally(() => {
    sender.kill();
    receiver.kill();
  });
  return { sender, receiver, senderExit, receiverExit, same: () => h.sha256File(path.join(outDir, "f.bin")) === h.sha256File(src) };
}

test("ipv6: the receiver listens dual-stack", async (t) => {
  if (!ipv6Available) return t.skip("no IPv6 loopback on this machine");
  const { outDir } = setup(t);
  const receiver = await h.startReceiver({ outDir, args: ["--listen-timeout", "1"] });
  assert.equal(receiver.ofType("listening")[0].ipv6, true);
  await receiver.exited;
});

for (const host of ["::1", "[::1]"]) {
  test(`ipv6: transfer to ${host}`, async (t) => {
    if (!ipv6Available) return t.skip("no IPv6 loopback on this machine");
    const run = await sendVia(t, host);
    assert.equal(run.senderExit.code, 0, run.sender.stderr);
    assert.equal(run.receiverExit.code, 0, run.receiver.stderr);
    assert.equal(run.receiver.ofType("connection_accepted")[0].peer, "::1");
    assert.ok(run.same(), "file identical");
  });
}

test("ipv6: IPv4 senders still connect to the dual-stack receiver, shown as plain IPv4", async (t) => {
  if (!ipv6Available) return t.skip("no IPv6 loopback on this machine");
  const run = await sendVia(t, "127.0.0.1");
  assert.equal(run.senderExit.code, 0, run.sender.stderr);
  assert.equal(run.receiver.ofType("connection_accepted")[0].peer, "127.0.0.1", "not ::ffff:127.0.0.1");
  assert.ok(run.same());
});

test("ipv6: a hostname resolving to both families works", async (t) => {
  if (!ipv6Available) return t.skip("no IPv6 loopback on this machine");
  const run = await sendVia(t, "localhost");
  assert.equal(run.senderExit.code, 0, run.sender.stderr);
  assert.ok(["::1", "127.0.0.1"].includes(run.receiver.ofType("connection_accepted")[0].peer));
  assert.ok(run.same());
});

test("ipv6: TLS pinning works over IPv6 too", async (t) => {
  if (!ipv6Available) return t.skip("no IPv6 loopback on this machine");
  const { srcDir, outDir } = setup(t);
  const src = h.writeRandomFile(path.join(srcDir, "p.bin"), 200 * 1024, 42);
  const receiver = await h.startReceiver({ outDir });
  const pin = receiver.ofType("listening")[0].certSha256;
  const sender = h.startSender({ host: "::1", port: receiver.port, sources: src, args: ["--pin-sha256", pin] });
  const [senderExit] = await h.withTimeout(Promise.all([sender.exited, receiver.exited]), 30000, "pinned IPv6 transfer hung");
  assert.equal(senderExit.code, 0, sender.stderr);
  assert.equal(sender.ofType("session_start")[0].pinned, true);
  assert.equal(h.sha256File(path.join(outDir, "p.bin")), h.sha256File(src));
});
