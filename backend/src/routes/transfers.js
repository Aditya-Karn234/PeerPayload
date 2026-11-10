const { createRouter } = require("../lib/router");
const crypto = require("crypto");

const db = require("../db");
const presenceService = require("../services/presenceService");
const signalBus = require("../signalBus");
const config = require("../config");
const { issueBackendTicket: issueRelayTicket } = require("peerpayload-protocol");

const router = createRouter();

// Mirrors shared/include/protocol.hpp's TOKEN_LEN - 1 — the engine token
// generated here is handed to sender.exe/receiver.exe as --token.
const ENGINE_TOKEN_BYTES = 16; // -> 32 hex chars, well under the limit
const MIN_PORT = 1;
const MAX_PORT = 65535;

const TERMINAL_STATUSES = new Set([
  "complete",
  "failed",
  "cancelled",
  "rejected",
  "not_reachable",
  "timed_out",
]);

// Outcomes a client may report. not_reachable (the sender could never
// connect to the receiver) and timed_out (the recipient never answered the
// offer) are kept apart from plain "failed" so the audit trail can show how
// often direct connections fail — the data a relay decision needs.
const REPORTABLE_STATUSES = new Set(["complete", "failed", "not_reachable", "timed_out"]);

// Which route the bytes took: straight between the machines, or through the
// relay. Recorded in the report so relay usage (and its cost) is visible.
const TRANSFER_PATHS = new Set(["direct", "relay"]);

const relayEnabled = () => Boolean(config.relayUrl && config.relaySecret);

const MAX_FILE_COUNT = 1_000_000; // mirrors protocol.hpp's MAX_FILE_COUNT
const MAX_FAIL_REASON_LENGTH = 500;
const MAX_BIGINT = 9223372036854775807n; // Postgres BIGINT ceiling
const CERT_FINGERPRINT = /^[0-9a-f]{64}$/i;

function generateEngineToken() {
  return crypto.randomBytes(ENGINE_TOKEN_BYTES).toString("hex");
}

// Optional non-negative integer field. Returns { value } or { error }.
function parseCount(name, raw, max) {
  if (raw === undefined || raw === null)
    return { value: undefined };

  const n = Number(raw);

  if (!Number.isSafeInteger(n) || n < 0 || n > max)
    return { error: `${name} must be an integer between 0 and ${max}` };

  return { value: n };
}

// Optional byte count. Accepts a number or a decimal string (sizes past
// 2^53 arrive as strings), stored as BigInt.
function parseByteCount(name, raw) {
  if (raw === undefined || raw === null)
    return { value: undefined };

  const text = typeof raw === "number" && Number.isSafeInteger(raw) ? String(raw) : raw;

  if (typeof text !== "string" || !/^\d{1,19}$/.test(text) || BigInt(text) > MAX_BIGINT)
    return { error: `${name} must be a non-negative integer` };

  return { value: BigInt(text) };
}

// engineToken is only ever included for the two actual parties to a
// transfer (never for an admin viewing someone else's row) — and, crucially,
// for the RECEIVER this has to be readable on a plain GET while the
// transfer is still "pending", not only from the /accept response: the
// receiving client needs the token to spawn `receiver.exe --token <token>`
// *before* it can call /accept in the first place (accept requires an
// already-listening receiver's host/port). Getting this backwards was a
// real chicken-and-egg bug caught while building the CLI's verification
// harness — the receiver has no other way to learn the token pre-accept.
function serializeTransfer(t, { forUser } = {}) {
  const base = {
    id: t.id,
    senderId: t.senderId,
    receiverId: t.receiverId,
    senderUsername: t.senderUsername,
    receiverUsername: t.receiverUsername,
    status: t.status,
    fileCount: t.fileCount,
    totalBytes: t.totalBytes === null || t.totalBytes === undefined ? null : t.totalBytes.toString(),
    failReason: t.failReason,
    receiverAddress: t.receiverAddress,
    receiverPort: t.receiverPort,
    // Not secret: the sender pins the receiver's TLS certificate to this,
    // and it only has to be authentic, which HTTPS to the backend gives it.
    receiverCertFingerprint: t.receiverCertFingerprint ?? null,
    relayAvailable: relayEnabled(),
    reportedBySender: t.reportedBySender,
    reportedByReceiver: t.reportedByReceiver,
    senderReport: t.senderReport,
    receiverReport: t.receiverReport,
    createdAt: t.createdAt,
    acceptedAt: t.acceptedAt,
    completedAt: t.completedAt,
  };

  if (forUser && isParty(t, forUser))
    base.engineToken = t.engineToken;

  return base;
}

function isParty(transfer, user) {
  return transfer.senderId === user.id || transfer.receiverId === user.id;
}

// POST /transfers — create a transfer intent. Resolves the recipient via
// presence first: architecture.md is explicit that the caller should get a
// clear "not currently reachable" response here rather than being allowed
// to connect blind.
router.post("/", async (req, res) => {
  const { toUsername, fileCount, totalBytes } = req.body || {};

  if (typeof toUsername !== "string" || !toUsername.trim())
    return res.status(400).json({ error: "toUsername is required" });

  if (toUsername === req.user.username)
    return res.status(400).json({ error: "cannot send a transfer to yourself" });

  const parsedCount = parseCount("fileCount", fileCount, MAX_FILE_COUNT);
  const parsedBytes = parseByteCount("totalBytes", totalBytes);

  if (parsedCount.error || parsedBytes.error)
    return res.status(400).json({ error: parsedCount.error || parsedBytes.error });

  const receiver = await db.user.findUnique({ where: { username: toUsername } });

  if (!receiver || receiver.deactivatedAt)
    return res.status(404).json({ error: "recipient not found" });

  if (!presenceService.isOnline(receiver))
    return res.status(409).json({ error: `${toUsername} is not currently reachable` });

  const engineToken = generateEngineToken();

  const transfer = await db.transfer.create({
    data: {
      senderId: req.user.id,
      receiverId: receiver.id,
      senderUsername: req.user.username,
      receiverUsername: receiver.username,
      engineToken,
      fileCount: parsedCount.value,
      totalBytes: parsedBytes.value,
    },
  });

  // engineToken deliberately omitted from this push — the receiver reads
  // it from a plain GET (see serializeTransfer's forUser gate above), not
  // from an unencrypted-by-default socket.io payload.
  signalBus.emit("incoming-transfer", receiver.id, serializeTransfer(transfer, {}));

  res.status(201).json(serializeTransfer(transfer, { forUser: req.user }));
});

router.get("/", async (req, res) => {
  const where =
    req.user.role === "admin"
      ? {}
      : { OR: [{ senderId: req.user.id }, { receiverId: req.user.id }] };

  const transfers = await db.transfer.findMany({ where, orderBy: { createdAt: "desc" } });

  res.json(transfers.map((t) => serializeTransfer(t, { forUser: req.user })));
});

router.get("/:id", async (req, res) => {
  const transfer = await db.transfer.findUnique({ where: { id: req.params.id } });

  if (!transfer)
    return res.status(404).json({ error: "transfer not found" });

  if (!isParty(transfer, req.user) && req.user.role !== "admin")
    return res.status(403).json({ error: "not a party to this transfer" });

  res.json(serializeTransfer(transfer, { forUser: req.user }));
});

// Only the recipient can accept, and only while still pending. The
// receiver is expected to have already spawned its local `receiver.exe`
// and seen its own "listening" event before calling this — host/port here
// describe where that receiver is actually listening.
router.post("/:id/accept", async (req, res) => {
  const { host, port, certFingerprint } = req.body || {};

  const transfer = await db.transfer.findUnique({ where: { id: req.params.id } });

  if (!transfer)
    return res.status(404).json({ error: "transfer not found" });

  if (transfer.receiverId !== req.user.id)
    return res.status(403).json({ error: "only the recipient can accept this transfer" });

  if (transfer.status !== "pending")
    return res.status(409).json({ error: `cannot accept a transfer in status "${transfer.status}"` });

  if (typeof host !== "string" || !host.trim())
    return res.status(400).json({ error: "host is required" });

  const parsedPort = Number(port);

  if (!Number.isInteger(parsedPort) || parsedPort < MIN_PORT || parsedPort > MAX_PORT)
    return res.status(400).json({ error: `port must be an integer between ${MIN_PORT} and ${MAX_PORT}` });

  // Optional so older clients (and --no-tls debugging) still work; when
  // present it's the SHA-256 of the receiver's certificate from its
  // "listening" event, and the sender refuses any other certificate.
  if (certFingerprint !== undefined && certFingerprint !== null && (typeof certFingerprint !== "string" || !CERT_FINGERPRINT.test(certFingerprint)))
    return res.status(400).json({ error: "certFingerprint must be 64 hex characters" });

  const updated = await db.transfer.update({
    where: { id: transfer.id },
    data: {
      status: "accepted",
      acceptedAt: new Date(),
      receiverAddress: host.trim(),
      receiverPort: parsedPort,
      receiverCertFingerprint: certFingerprint ? certFingerprint.toLowerCase() : null,
    },
  });

  signalBus.emit("transfer-accepted", updated.senderId, serializeTransfer(updated, {}));

  res.json(serializeTransfer(updated, { forUser: req.user }));
});

router.post("/:id/reject", async (req, res) => {
  const transfer = await db.transfer.findUnique({ where: { id: req.params.id } });

  if (!transfer)
    return res.status(404).json({ error: "transfer not found" });

  if (transfer.receiverId !== req.user.id)
    return res.status(403).json({ error: "only the recipient can reject this transfer" });

  if (transfer.status !== "pending")
    return res.status(409).json({ error: `cannot reject a transfer in status "${transfer.status}"` });

  const updated = await db.transfer.update({
    where: { id: transfer.id },
    data: { status: "rejected" },
  });

  signalBus.emit("transfer-rejected", updated.senderId, serializeTransfer(updated, {}));

  res.json(serializeTransfer(updated, { forUser: req.user }));
});

// Posted by whichever side's local engine process just exited — the ONLY
// way this audit log gets populated, since the backend never sees the
// transfer itself (architecture.md step 6). role disambiguates which
// report this is; overall status/completedAt are finalized from the
// sender's report when present (mirrors the old single-machine backend's
// sender-owns-completion-timing convention), the receiver's is kept for
// cross-check only.
router.post("/:id/report", async (req, res) => {
  const { role, status, fileCount, totalBytes, failReason, elapsedMs, path: transferPath, attempts } = req.body || {};

  if (role !== "sender" && role !== "receiver")
    return res.status(400).json({ error: 'role must be "sender" or "receiver"' });

  if (!REPORTABLE_STATUSES.has(status))
    return res.status(400).json({ error: `status must be one of: ${[...REPORTABLE_STATUSES].join(", ")}` });

  if (failReason !== undefined && failReason !== null && typeof failReason !== "string")
    return res.status(400).json({ error: "failReason must be a string" });

  if (elapsedMs !== undefined && elapsedMs !== null && (!Number.isFinite(Number(elapsedMs)) || Number(elapsedMs) < 0))
    return res.status(400).json({ error: "elapsedMs must be a non-negative number" });

  if (transferPath !== undefined && transferPath !== null && !TRANSFER_PATHS.has(transferPath))
    return res.status(400).json({ error: `path must be one of: ${[...TRANSFER_PATHS].join(", ")}` });

  if (attempts !== undefined && attempts !== null && (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 100))
    return res.status(400).json({ error: "attempts must be a positive integer" });

  const reportCount = parseCount("fileCount", fileCount, MAX_FILE_COUNT);
  const reportBytes = parseByteCount("totalBytes", totalBytes);

  if (reportCount.error || reportBytes.error)
    return res.status(400).json({ error: reportCount.error || reportBytes.error });

  const reason = failReason ? failReason.slice(0, MAX_FAIL_REASON_LENGTH) : undefined;

  const transfer = await db.transfer.findUnique({ where: { id: req.params.id } });

  if (!transfer)
    return res.status(404).json({ error: "transfer not found" });

  const expectedUserId = role === "sender" ? transfer.senderId : transfer.receiverId;

  if (expectedUserId !== req.user.id)
    return res.status(403).json({ error: `you are not the ${role} for this transfer` });

  const report = {
    status,
    fileCount: reportCount.value,
    // Json columns can't hold a BigInt; keep the exact value as a string.
    totalBytes: reportBytes.value === undefined ? undefined : reportBytes.value.toString(),
    failReason: reason,
    elapsedMs: elapsedMs === undefined || elapsedMs === null ? undefined : Number(elapsedMs),
    path: transferPath ?? undefined,
    attempts: attempts ?? undefined,
    reportedAt: new Date(),
  };

  const data =
    role === "sender"
      ? { senderReport: report, reportedBySender: true }
      : { receiverReport: report, reportedByReceiver: true };

  // Only the sender's report finalizes the canonical status/completedAt —
  // matches the old sessionSourceFor sender-priority convention. A
  // receiver-only report still gets recorded (for cross-check) but doesn't
  // move the transfer out of its current state on its own.
  if (role === "sender" && !TERMINAL_STATUSES.has(transfer.status)) {
    data.status = status;
    data.completedAt = new Date();

    if (status !== "complete" && reason)
      data.failReason = reason;
  }

  const updated = await db.transfer.update({ where: { id: transfer.id }, data });

  res.json(serializeTransfer(updated, { forUser: req.user }));
});

// GET /transfers/:id/relay-ticket — permission for the caller's side of
// this transfer to use the relay. Only the two parties, only while the
// transfer is live, and the role comes from who is asking, so a sender's
// ticket can never be used to pose as the receiver. Each (re)connect fetches
// a fresh one.
router.get("/:id/relay-ticket", async (req, res) => {
  if (!relayEnabled())
    return res.status(404).json({ error: "relay not configured" });

  const transfer = await db.transfer.findUnique({ where: { id: req.params.id } });

  if (!transfer)
    return res.status(404).json({ error: "transfer not found" });

  if (!isParty(transfer, req.user))
    return res.status(403).json({ error: "not a party to this transfer" });

  if (transfer.status !== "pending" && transfer.status !== "accepted")
    return res.status(409).json({ error: `transfer is "${transfer.status}"` });

  const role = transfer.senderId === req.user.id ? "sender" : "receiver";
  const { ticket, expiresAt } = issueRelayTicket({ transferId: transfer.id, role, ttlSec: config.relayTicketTtlSec }, config.relaySecret);

  res.json({ url: config.relayUrl, ticket, role, expiresAt });
});

// The backend never touches the live connection, so this can only mark a
// not-yet-in_progress intent as cancelled for bookkeeping — it cannot stop
// bytes already flowing directly between the two clients. That's a
// client-local kill of its own engine process now, not something this
// endpoint can reach.
router.delete("/:id", async (req, res) => {
  const transfer = await db.transfer.findUnique({ where: { id: req.params.id } });

  if (!transfer)
    return res.status(404).json({ error: "transfer not found" });

  if (!isParty(transfer, req.user) && req.user.role !== "admin")
    return res.status(403).json({ error: "not a party to this transfer" });

  if (TERMINAL_STATUSES.has(transfer.status))
    return res.status(409).json({ error: `transfer is already "${transfer.status}"` });

  const updated = await db.transfer.update({
    where: { id: transfer.id },
    data: { status: "cancelled" },
  });

  res.json(serializeTransfer(updated, { forUser: req.user }));
});

module.exports = router;
