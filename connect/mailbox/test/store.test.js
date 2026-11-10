const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const WebSocket = require("ws");

const { createMailbox } = require("../src/server");
const { memoryStore, sqliteStore } = require("../src/store");
const core = require("../../core");

// The two mailbox stores behave the same, and the SQLite one keeps waiting
// envelopes (and duplicate suppression) across a mailbox restart.

const repo = path.resolve(__dirname, "..", "..", "..");
const keygenPath = path.join(repo, "build", "engine", `ppkeygen${process.platform === "win32" ? ".exe" : ""}`);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pp-mailbox-store-"));

after(() => fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));

const env = (id) => ({ v: 1, id, to: "b".repeat(64), body: `envelope ${id}` });

for (const [name, make] of [
  ["memory", () => memoryStore()],
  ["sqlite", () => sqliteStore(path.join(tmp, `unit-${Date.now()}.db`))],
]) {
  test(`store (${name}): queue, list in order, remove, seen, expire`, () => {
    const store = make();
    const fp = "b".repeat(64);

    assert.equal(store.size(fp), 0);
    store.add(fp, "id-1", env("id-1"), 100);
    store.add(fp, "id-2", env("id-2"), 200);
    store.add("c".repeat(64), "id-3", env("id-3"), 200);
    assert.equal(store.size(fp), 2);
    assert.equal(store.total(), 3);
    assert.deepEqual(store.list(fp).map((i) => i.id), ["id-1", "id-2"]);
    assert.deepEqual(store.list(fp)[1].envelope, env("id-2"));

    assert.equal(store.remove(fp, new Set(["id-1", "nope"])), 1);
    assert.deepEqual(store.list(fp).map((i) => i.id), ["id-2"]);

    assert.equal(store.seen("k"), false);
    store.markSeen("k", 100);
    assert.equal(store.seen("k"), true);

    store.expire(150); // drops id-? at 100 and the seen key at 100
    assert.equal(store.seen("k"), false);
    assert.equal(store.size(fp), 1);
    store.close();
  });
}

test("mailbox with SQLite: envelopes and duplicate suppression survive a restart", async (t) => {
  assert.ok(fs.existsSync(keygenPath), `build the engine first (${keygenPath})`);
  const alice = core.createIdentity({ dir: path.join(tmp, "alice"), name: "Alice", keygenPath });
  const bob = core.createIdentity({ dir: path.join(tmp, "bob"), name: "Bob", keygenPath });
  const file = path.join(tmp, "mailbox.db");
  const card = core.verifyCard(core.contactCard(bob));
  const post = async (url, e) => (await fetch(`${url}/v1/messages`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(e) })).json();

  // First run: two envelopes for Bob, who is offline.
  let mailbox = createMailbox({ store: sqliteStore(file), log: { warn() {} } });
  let url = `http://127.0.0.1:${await mailbox.listen(0, "127.0.0.1")}`;
  const e1 = core.seal({ identity: alice, recipient: card, payload: { n: 1 } });
  const e2 = core.seal({ identity: alice, recipient: card, payload: { n: 2 } });
  await post(url, e1);
  await post(url, e2);
  await mailbox.close();

  // Restart: they're still there; the same envelope again is a duplicate.
  mailbox = createMailbox({ store: sqliteStore(file), log: { warn() {} } });
  url = `http://127.0.0.1:${await mailbox.listen(0, "127.0.0.1")}`;
  t.after(() => mailbox.close());
  assert.equal(mailbox.store.size(bob.fingerprint), 2);
  assert.equal((await post(url, e1)).duplicate, true);

  // Bob connects, gets both, acknowledges one.
  const ws = new WebSocket(`${url.replace("http", "ws")}/v1/inbox?token=${encodeURIComponent(core.issueInboxToken(bob))}`);
  const got = [];
  ws.on("message", (d) => {
    const m = JSON.parse(String(d));
    if (m.type === "envelope") got.push(core.open(m.envelope, bob).payload.n);
  });
  for (let i = 0; got.length < 2; i++) {
    assert.ok(i < 100, "both envelopes delivered after the restart");
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.deepEqual(got, [1, 2]);
  ws.send(JSON.stringify({ type: "ack", ids: [e1.id] }));
  for (let i = 0; mailbox.store.size(bob.fingerprint) !== 1; i++) {
    assert.ok(i < 100, "ack deletes it");
    await new Promise((r) => setTimeout(r, 50));
  }
  ws.close();
});
