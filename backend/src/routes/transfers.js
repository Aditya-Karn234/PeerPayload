const express = require("express");
const crypto = require("crypto");

const db = require("../db");
const presenceService = require("../services/presenceService");
const signalBus = require("../signalBus");

const router = express.Router();

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

function generateEngineToken() {
  return crypto.randomBytes(ENGINE_TOKEN_BYTES).toString("hex");
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
      fileCount: fileCount !== undefined && fileCount !== null ? Number(fileCount) : undefined,
      totalBytes: totalBytes !== undefined && totalBytes !== null ? BigInt(totalBytes) : undefined,
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
  const { host, port } = req.body || {};

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

  const updated = await db.transfer.update({
    where: { id: transfer.id },
    data: {
      status: "accepted",
      acceptedAt: new Date(),
      receiverAddress: host.trim(),
      receiverPort: parsedPort,
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
  const { role, status, fileCount, totalBytes, failReason, elapsedMs } = req.body || {};

  if (role !== "sender" && role !== "receiver")
    return res.status(400).json({ error: 'role must be "sender" or "receiver"' });

  const transfer = await db.transfer.findUnique({ where: { id: req.params.id } });

  if (!transfer)
    return res.status(404).json({ error: "transfer not found" });

  const expectedUserId = role === "sender" ? transfer.senderId : transfer.receiverId;

  if (expectedUserId !== req.user.id)
    return res.status(403).json({ error: `you are not the ${role} for this transfer` });

  const report = { status, fileCount, totalBytes, failReason, elapsedMs, reportedAt: new Date() };

  const data =
    role === "sender"
      ? { senderReport: report, reportedBySender: true }
      : { receiverReport: report, reportedByReceiver: true };

  // Only the sender's report finalizes the canonical status/completedAt —
  // matches the old sessionSourceFor sender-priority convention. A
  // receiver-only report still gets recorded (for cross-check) but doesn't
  // move the transfer out of its current state on its own.
  if (role === "sender" && !TERMINAL_STATUSES.has(transfer.status)) {
    data.status = status === "failed" ? "failed" : "complete";
    data.completedAt = new Date();

    if (status === "failed" && failReason)
      data.failReason = failReason;
  }

  const updated = await db.transfer.update({ where: { id: transfer.id }, data });

  res.json(serializeTransfer(updated, { forUser: req.user }));
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
