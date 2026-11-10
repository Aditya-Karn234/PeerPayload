// Device identities and mutual TLS (PeerPayload Connect): ppkeygen, lasting
// receiver certificates, and receivers that only accept allow-listed
// sender devices. Also checks the Enterprise behaviour (no identities) is
// unchanged when the new flags aren't used.
const { test, before } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const net = require("net");
const path = require("path");
const h = require("./harness");

const keygenPath = path.join(path.dirname(path.dirname(h.senderPath)), "engine", `ppkeygen${process.platform === "win32" ? ".exe" : ""}`);

before(() => {
  h.assertBinariesExist();
  assert.ok(fs.existsSync(keygenPath), `ppkeygen not found at ${keygenPath}`);
});

function setup(t) {
  const dir = h.makeTempDir("id");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, srcDir: path.join(dir, "src"), outDir: path.join(dir, "out") };
}

async function keygen(args) {
  const proc = h.spawnEngine(keygenPath, args);
  const exit = await h.withTimeout(proc.exited, 15000, "ppkeygen hung");
  return { exit, events: proc.events, stderr: proc.stderr };
}

// Creates an identity; returns { cert, key, fp }.
async function identity(dir, name) {
  const r = await keygen(["--out", path.join(dir, name), "--name", name]);
  assert.equal(r.exit.code, 0, r.stderr);
  const created = r.events.find((e) => e.event === "identity_created");
  return { cert: created.certPath, key: created.keyPath, fp: created.certSha256 };
}

const idArgs = (id) => ["--cert", id.cert, "--key", id.key];
const reason = (proc) => proc.ofType("transfer_failed")[0]?.reason;

test("ppkeygen: creates an Ed25519 identity, shows it, and won't silently replace it", async (t) => {
  const { dir } = setup(t);
  const a = await identity(dir, "alice");
  assert.match(a.fp, /^[0-9a-f]{64}$/);
  assert.match(fs.readFileSync(a.key, "utf8"), /BEGIN PRIVATE KEY/);

  const shown = await keygen(["--show", path.join(dir, "alice")]);
  assert.equal(shown.exit.code, 0);
  assert.equal(shown.events[0].certSha256, a.fp);
  assert.equal(shown.events[0].name, "alice");

  const again = await keygen(["--out", path.join(dir, "alice")]);
  assert.equal(again.exit.code, 1);
  assert.equal(again.events[0].reason, "identity_exists");
  assert.equal((await keygen(["--show", path.join(dir, "alice")])).events[0].certSha256, a.fp, "refused overwrite must not change the ID");

  const forced = await keygen(["--out", path.join(dir, "alice"), "--force"]);
  assert.equal(forced.exit.code, 0);
  assert.notEqual(forced.events[0].certSha256, a.fp, "--force creates a new device ID");

  assert.equal((await keygen(["--show", path.join(dir, "nobody")])).exit.code, 1);
  assert.equal((await keygen([])).exit.code, 1);
});

test("identity: a receiver with a device identity keeps the same fingerprint across runs", async (t) => {
  const { dir, outDir } = setup(t);
  const bob = await identity(dir, "bob");
  const fps = [];
  for (let i = 0; i < 2; i++) {
    const r = await h.startReceiver({ outDir, args: [...idArgs(bob), "--listen-timeout", "1"] });
    fps.push(r.ofType("listening")[0].certSha256);
    await h.withTimeout(r.exited, 10000, "receiver did not exit");
  }
  assert.deepEqual(fps, [bob.fp, bob.fp]);

  // Without an identity, every run gets a fresh throwaway certificate (Enterprise behaviour).
  const e1 = await h.startReceiver({ outDir, args: ["--listen-timeout", "1"] });
  const e2 = await h.startReceiver({ outDir, args: ["--listen-timeout", "1"] });
  assert.notEqual(e1.ofType("listening")[0].certSha256, e2.ofType("listening")[0].certSha256);
  await Promise.all([e1.exited, e2.exited]);
});

test("mutual TLS: paired devices transfer, and each side knows who the other is", async (t) => {
  const { dir, srcDir, outDir } = setup(t);
  const alice = await identity(dir, "alice");
  const bob = await identity(dir, "bob");
  const src = h.writeRandomFile(path.join(srcDir, "photo.bin"), 1024 * 1024 + 3, 31);

  const run = await h.transfer({
    sources: src,
    outDir,
    receiverOpts: { args: [...idArgs(bob), "--peer-sha256", alice.fp] },
    senderOpts: { args: [...idArgs(alice), "--pin-sha256", bob.fp] },
  });

  assert.equal(run.senderExit.code, 0, run.sender.stderr);
  assert.equal(run.receiverExit.code, 0, run.receiver.stderr);
  assert.equal(run.receiver.ofType("session_start")[0].peerCertSha256, alice.fp, "receiver learns which device sent");
  assert.equal(run.sender.ofType("session_start")[0].certSha256, bob.fp);
  assert.equal(run.sender.ofType("session_start")[0].pinned, true);
  assert.equal(h.sha256File(path.join(outDir, "photo.bin")), h.sha256File(src));
});

test("mutual TLS: a sender without a certificate, or an unknown device, is refused; the receiver keeps listening", async (t) => {
  const { dir, srcDir, outDir } = setup(t);
  const alice = await identity(dir, "alice");
  const bob = await identity(dir, "bob");
  const mallory = await identity(dir, "mallory");
  const src = h.writeRandomFile(path.join(srcDir, "f.bin"), 64 * 1024, 32);

  const receiver = await h.startReceiver({ outDir, args: [...idArgs(bob), "--peer-sha256", alice.fp] });
  t.after(() => receiver.kill());

  // No client certificate at all: refused during the handshake.
  const anon = h.startSender({ port: receiver.port, sources: src, args: ["--pin-sha256", bob.fp] });
  assert.equal((await h.withTimeout(anon.exited, 15000, "anonymous sender hung")).code, 1);
  assert.equal(anon.ofType("session_start").length, 0);
  await receiver.waitFor((e) => e.event === "connection_rejected", 10000);

  // A real device identity, but not one Bob paired with.
  const stranger = h.startSender({ port: receiver.port, sources: src, args: [...idArgs(mallory), "--pin-sha256", bob.fp] });
  assert.equal((await h.withTimeout(stranger.exited, 15000, "unknown sender hung")).code, 1);
  assert.equal(stranger.ofType("session_start").length, 0, "no session may start with an unknown device");
  await receiver.waitFor((e) => e.event === "connection_rejected" && e.reason === "tls_peer_not_allowed", 10000);
  assert.ok(!fs.existsSync(path.join(outDir, "f.bin")), "nothing was written");

  // The receiver is still there for its real contact.
  const good = h.startSender({ port: receiver.port, sources: src, args: [...idArgs(alice), "--pin-sha256", bob.fp] });
  const [goodExit, receiverExit] = await h.withTimeout(Promise.all([good.exited, receiver.exited]), 20000, "paired transfer hung");
  assert.equal(goodExit.code, 0, good.stderr);
  assert.equal(receiverExit.code, 0);
  assert.equal(h.sha256File(path.join(outDir, "f.bin")), h.sha256File(src));
});

test("mutual TLS: several allowed devices", async (t) => {
  const { dir, srcDir } = setup(t);
  const alice = await identity(dir, "alice");
  const carol = await identity(dir, "carol");
  const bob = await identity(dir, "bob");
  const src = h.writeRandomFile(path.join(srcDir, "f.bin"), 32 * 1024, 33);

  for (const who of [alice, carol]) {
    const out = path.join(dir, `out-${who.fp.slice(0, 6)}`);
    const run = await h.transfer({
      sources: src,
      outDir: out,
      receiverOpts: { args: [...idArgs(bob), "--peer-sha256", alice.fp, "--peer-sha256", carol.fp.toUpperCase()] },
      senderOpts: { args: [...idArgs(who), "--pin-sha256", bob.fp] },
    });
    assert.equal(run.senderExit.code, 0, run.sender.stderr);
    assert.equal(run.receiver.ofType("session_start")[0].peerCertSha256, who.fp);
  }
});

test("identity flags: invalid combinations and unreadable files fail cleanly", async (t) => {
  const { dir, srcDir, outDir } = setup(t);
  const alice = await identity(dir, "alice");
  const src = h.writeRandomFile(path.join(srcDir, "f.bin"), 1024, 34);

  const bad = [
    ["--cert", alice.cert],
    ["--key", alice.key],
    ["--no-tls", ...idArgs(alice)],
    ["--peer-sha256", "abc"],
    ["--no-tls", "--peer-sha256", alice.fp],
  ];
  for (const args of bad) {
    const r = h.spawnEngine(h.receiverPath, ["-p", "1", "-o", outDir, ...args]);
    assert.equal((await h.withTimeout(r.exited, 10000, "receiver hung")).code, 1, `receiver accepted ${args.join(" ")}`);
  }
  for (const args of [["--cert", alice.cert], ["--no-tls", ...idArgs(alice)]]) {
    const s = h.startSender({ port: 1, sources: src, args });
    assert.equal((await h.withTimeout(s.exited, 10000, "sender hung")).code, 1, `sender accepted ${args.join(" ")}`);
  }

  const missing = h.spawnEngine(h.receiverPath, ["-p", String(await h.freePort()), "-o", outDir, "--cert", path.join(dir, "nope.crt"), "--key", alice.key]);
  assert.equal((await h.withTimeout(missing.exited, 10000, "receiver hung")).code, 1);
  assert.equal(reason(missing), "tls_context_failed");

  // A key that doesn't belong to the certificate.
  const other = await identity(dir, "other");
  const mismatch = h.spawnEngine(h.receiverPath, ["-p", String(await h.freePort()), "-o", outDir, "--cert", alice.cert, "--key", other.key]);
  assert.equal((await h.withTimeout(mismatch.exited, 10000, "receiver hung")).code, 1);
  assert.match(mismatch.stderr, /key values mismatch|does not match/);
});

test("compatibility: a sender with an identity still works with an Enterprise-style receiver", async (t) => {
  const { dir, srcDir, outDir } = setup(t);
  const alice = await identity(dir, "alice");
  const src = h.writeRandomFile(path.join(srcDir, "f.bin"), 100 * 1024, 35);
  const run = await h.transfer({ sources: src, outDir, senderOpts: { args: idArgs(alice) } });
  assert.equal(run.senderExit.code, 0, run.sender.stderr);
  assert.equal(run.receiver.ofType("session_start")[0].peerCertSha256, undefined, "no client certificate is requested without --peer-sha256");
  assert.equal(h.sha256File(path.join(outDir, "f.bin")), h.sha256File(src));
});
