const { test } = require("node:test");
const assert = require("node:assert/strict");
const net = require("net");

const { newKey, startReverseBridge, startReverseDialer } = require("../reverse");

// The reverse bridges on their own: the key gate, and bytes both ways
// between a "sender engine" and a "receiver engine".

const until = async (fn, ms = 5000) => {
  const end = Date.now() + ms;
  while (!(await fn())) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
};

test("reverse: a dialer with the key is spliced to the sender engine", async (t) => {
  const key = newKey();
  const bridge = await startReverseBridge({ key });
  t.after(() => bridge.close());

  // The receiver engine: echoes uppercase.
  const engine = net.createServer((s) => s.on("data", (d) => s.write(String(d).toUpperCase())));
  await new Promise((r) => engine.listen(0, "127.0.0.1", r));
  t.after(() => engine.close());

  const dialer = startReverseDialer({ addresses: ["127.0.0.1"], port: bridge.port, key, enginePort: engine.address().port });
  t.after(() => dialer.stop());
  assert.equal(await bridge.arrived(3000), true);

  // The sender engine connects locally and talks first, like a TLS client.
  const sender = net.connect(bridge.localPort, "127.0.0.1");
  let got = "";
  sender.on("data", (d) => (got += d));
  sender.write("hello");
  await until(() => got === "HELLO");
  sender.destroy();
});

test("reverse: a connection without the right key never reaches the engine", async (t) => {
  const bridge = await startReverseBridge({ key: newKey() });
  t.after(() => bridge.close());

  const stranger = net.connect(bridge.port, "127.0.0.1");
  stranger.on("error", () => {});
  stranger.write(Buffer.alloc(32, 7));
  const closed = new Promise((r) => stranger.on("close", r));

  assert.equal(await bridge.arrived(500), false);
  await closed;
});
