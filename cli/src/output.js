const ACTIVE_STATUSES = new Set(["pending", "accepted", "in_progress"]);

function formatBytes(bytes) {
  const n = Number(bytes);

  if (!Number.isFinite(n) || n < 0)
    return "?";

  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = n;
  let unit = 0;

  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }

  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

// "→ bob" if I'm the sender, "← alice" if I'm the receiver — same
// direction-arrow convention the personal-tool's dashboard already used
// for send/receive rows.
function formatDirection(transfer, myUsername) {
  return transfer.senderUsername === myUsername
    ? `→ ${transfer.receiverUsername}`
    : `← ${transfer.senderUsername}`;
}

function formatTransferLine(transfer, myUsername) {
  const id = transfer.id.slice(0, 8);
  const status = transfer.status.padEnd(12);
  const dir = formatDirection(transfer, myUsername).padEnd(14);
  const size = transfer.totalBytes ? formatBytes(transfer.totalBytes) : "";

  return `${id}  ${status}  ${dir}  ${size}`;
}

function printJson(data) {
  console.log(JSON.stringify(data));
}

module.exports = { ACTIVE_STATUSES, formatBytes, formatDirection, formatTransferLine, printJson };
