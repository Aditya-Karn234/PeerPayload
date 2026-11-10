const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const core = require("..");

const repo = path.resolve(__dirname, "..", "..", "..");
const keygenPath = path.join(repo, "build", "engine", `ppkeygen${process.platform === "win32" ? ".exe" : ""}`);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pp-connect-core-"));
const MAILBOX = "https://mailbox.example";

let alice, bob, mallory;

before(() => {
  assert.ok(fs.existsSync(keygenPath), `build the engine first (${keygenPath})`);
  alice = core.createIdentity({ dir: path.join(tmp, "alice"), name: "Alice", keygenPath });
  bob = core.createIdentity({ dir: path.join(tmp, "bob"), name: "Bob", keygenPath });
  mallory = core.createIdentity({ dir: path.join(tmp, "mallory"), name: "Mallory", keygenPath });
});

after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const card = (id) => core.verifyCard(core.contactCard(id));

// ---- identity -------------------------------------------------------------

test("identity: created on the device, reloadable, and not silently replaced", () => {
  assert.match(alice.fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(alice.name, "Alice");
  assert.equal(Buffer.from(alice.boxPublic, "base64url").length, 32);
  const again = core.loadIdentity(alice.dir);
  assert.equal(again.fingerprint, alice.fingerprint);
  assert.equal(again.boxPublic, alice.boxPublic);
  assert.ok(core.hasIdentity(alice.dir));
  assert.throws(() => core.createIdentity({ dir: alice.dir, name: "Alice 2", keygenPath }), /already exists/);
  assert.throws(() => core.createIdentity({ dir: path.join(tmp, "x"), name: "", keygenPath }), /name/);
});

test("contact cards: verified by construction; any mismatch is rejected", () => {
  const c = core.contactCard(alice);
  assert.equal(core.verifyCard(c).fp, alice.fingerprint);
  assert.throws(() => core.verifyCard({ ...c, fp: bob.fingerprint }), /does not match/);
  assert.throws(() => core.verifyCard({ ...c, cert: core.contactCard(bob).cert }), /does not match/);
  assert.throws(() => core.verifyCard({ ...c, box: "short" }), /encryption key/);
  assert.throws(() => core.verifyCard({ ...c, v: 9 }), /unsupported/);
  assert.throws(() => core.verifyCard({ ...c, name: "" }), /name/);
});

test("safety code: identical on both sides, different for a different pair", () => {
  const ab = core.safetyCode(alice.fingerprint, bob.fingerprint);
  assert.equal(ab, core.safetyCode(bob.fingerprint, alice.fingerprint));
  assert.match(ab, /^\d{5}( \d{5}){5}$/);
  assert.notEqual(ab, core.safetyCode(alice.fingerprint, mallory.fingerprint));
});

// ---- envelopes ------------------------------------------------------------

test("envelope: only the recipient can read it, and it proves who sent it", () => {
  const env = core.seal({ identity: alice, recipient: card(bob), payload: { type: "hello", text: "hi Bob 👋" } });
  assert.ok(!JSON.stringify(env).includes("hi Bob"), "plaintext must not appear in the envelope");
  const opened = core.open(env, bob);
  assert.equal(opened.from, alice.fingerprint);
  assert.deepEqual(opened.payload, { type: "hello", text: "hi Bob 👋" });
  assert.throws(() => core.open(env, mallory), /not addressed/);
  // Readdressing to Mallory breaks the signature.
  assert.throws(() => core.open({ ...env, to: mallory.fingerprint }, mallory), /signature/);
});

test("envelope: every field is protected", () => {
  const env = core.seal({ identity: alice, recipient: card(bob), payload: { n: 1 } });
  const flipped = (s) => (s[0] === "A" ? "B" : "A") + s.slice(1);
  for (const field of ["ct", "iv", "epk", "id"]) assert.throws(() => core.open({ ...env, [field]: flipped(env[field]) }, bob), undefined, field);
  assert.throws(() => core.open({ ...env, ts: env.ts + 1 }, bob), /signature/);
  // Claiming to be Mallory with Alice's signature/cert, or swapping in Mallory's cert.
  assert.throws(() => core.open({ ...env, from: mallory.fingerprint }, bob), /does not match/);
  assert.throws(() => core.open({ ...env, cert: mallory.certDer.toString("base64") }, bob), /does not match/);
  // A valid envelope from Mallory with Alice's ID forged in.
  const forged = core.seal({ identity: mallory, recipient: card(bob), payload: { n: 2 } });
  assert.throws(() => core.open({ ...forged, from: alice.fingerprint }, bob));
  // The mailbox-side check needs no private keys.
  assert.ok(core.verifySignature(env));
  assert.throws(() => core.verifySignature({ ...env, sig: env.sig.slice(0, -4) + "AAAA" }), /signature/);
});

test("envelope: payload size is capped", () => {
  assert.throws(() => core.seal({ identity: alice, recipient: card(bob), payload: { big: "x".repeat(40 * 1024) } }), /too large/);
});

// ---- pairing --------------------------------------------------------------

test("pairing links: round trip, expiry, tampering, garbage", () => {
  const invite = core.createInvite(alice, { mailbox: MAILBOX });
  assert.ok(invite.link.startsWith(core.LINK_PREFIX));
  const parsed = core.parseInvite(invite.link);
  assert.equal(parsed.card.fp, alice.fingerprint);
  assert.equal(parsed.secret, invite.secret);
  assert.equal(parsed.mailbox, MAILBOX);
  // Pasting just the encoded part works too.
  assert.equal(core.parseInvite(invite.link.slice(core.LINK_PREFIX.length)).card.fp, alice.fingerprint);

  const expired = core.createInvite(alice, { mailbox: MAILBOX, ttlMs: 1000, now: Date.now() - 10_000 });
  assert.throws(() => core.parseInvite(expired.link), /expired/);

  const body = JSON.parse(Buffer.from(invite.link.slice(core.LINK_PREFIX.length), "base64url").toString());
  const swapped = { ...body, card: { ...body.card, box: core.contactCard(mallory).box, fp: mallory.fingerprint } };
  assert.throws(() => core.parseInvite(core.LINK_PREFIX + Buffer.from(JSON.stringify(swapped)).toString("base64url")), /does not match/);

  assert.throws(() => core.parseInvite("https://example.com"), /not a PeerPayload/);
  assert.throws(() => core.createInvite(alice, { mailbox: "ftp://x" }), /mailbox/);
});

test("pairing: full handshake leaves both sides with each other's verified card", () => {
  const aliceContacts = core.openContacts(alice.dir);
  const bobContacts = core.openContacts(bob.dir);

  // Alice makes a link and keeps only the secret's hash.
  const invite = core.createInvite(alice, { mailbox: MAILBOX });
  aliceContacts.addInvite(invite);
  assert.ok(!fs.readFileSync(path.join(alice.dir, "contacts.json"), "utf8").includes(invite.secret), "secret itself is never stored");

  // Bob opens it: he now has Alice's verified card, and asks to pair.
  const parsed = core.parseInvite(invite.link);
  bobContacts.upsert(parsed.card, "pending");
  const request = core.seal({ identity: bob, recipient: parsed.card, payload: { type: "pair-request", secret: parsed.secret, card: core.contactCard(bob) } });

  // Alice: valid secret -> Bob becomes a contact; she confirms.
  const got = core.open(request, alice);
  const bobCard = core.verifyCard(got.payload.card);
  assert.equal(bobCard.fp, got.from, "the card inside must be the sender's");
  assert.ok(aliceContacts.consumeInvite(got.payload.secret, got.from));
  aliceContacts.upsert(bobCard, "paired");
  const accept = core.seal({ identity: alice, recipient: bobCard, payload: { type: "pair-accept" } });

  // Bob: the accept is from the device he expects -> paired.
  const ack = core.open(accept, bob);
  assert.equal(ack.from, alice.fingerprint);
  bobContacts.upsert(bobContacts.card(ack.from), "paired");

  assert.equal(core.openContacts(alice.dir).get(bob.fingerprint).status, "paired", "persisted");
  assert.equal(core.openContacts(bob.dir).get(alice.fingerprint).status, "paired");

  // The secret is single-use: replaying the request (or Mallory using a
  // stolen copy of the link) can't pair again.
  assert.equal(aliceContacts.consumeInvite(parsed.secret, mallory.fingerprint), false);
});

test("contacts: expired invites are refused; paired is never downgraded; remove works", () => {
  const contacts = core.openContacts(mallory.dir);
  const invite = core.createInvite(mallory, { mailbox: MAILBOX, ttlMs: 1000, now: Date.now() - 10_000 });
  contacts.addInvite(invite);
  assert.equal(contacts.consumeInvite(invite.secret, alice.fingerprint), false);
  assert.equal(contacts.consumeInvite("nonsense", alice.fingerprint), false);

  contacts.upsert(core.contactCard(alice), "paired");
  contacts.upsert(core.contactCard(alice), "pending");
  assert.equal(contacts.get(alice.fingerprint).status, "paired");
  assert.equal(contacts.list().length, 1);
  assert.ok(contacts.remove(alice.fingerprint));
  assert.equal(contacts.get(alice.fingerprint), null);
  assert.throws(() => contacts.upsert({ ...core.contactCard(bob), fp: alice.fingerprint }, "paired"));
});
