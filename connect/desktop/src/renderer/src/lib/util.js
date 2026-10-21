import { formatBytes, formatRelativeTime } from "@peerpayload/ui";

// Electron's IPC wraps thrown errors as "Error invoking remote method
// 'x': Error: <message>"; show only the message.
export function errorMessage(err) {
  return String(err?.message ?? err).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
}

// What a transfer carries, in a few words: "holiday.jpg", "Photos (12 files)", "3 items".
export function transferTitle(t) {
  if (t.files?.length === 1)
    return t.files[0].files > 1 ? `${t.files[0].name} (${t.files[0].files} files)` : t.files[0].name;

  return `${t.files?.length || t.fileCount} items`;
}

export const sizeLabel = (bytes) => formatBytes(bytes ?? 0);

export const shortId = (fp) => fp.slice(0, 8);

export const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

// The most recent transfer with a contact, in a few words (from history):
// "sent 3m ago · direct", "received 2h ago", "no transfers yet".
export function lastTransferLabel(transfers, fp) {
  const last = transfers.find((t) => t.peer === fp);

  if (!last)
    return "no transfers yet";

  const when = formatRelativeTime(new Date(last.updatedAt ?? last.createdAt).toISOString());
  const verb = last.direction === "out" ? "sent" : "received";

  return [last.state === "complete" ? `${verb} ${when}` : `${last.state.replace("_", " ")} ${when}`, last.path].filter(Boolean).join(" · ");
}

// States grouped the way the History tabs show them.
export const ACTIVE = new Set(["offered", "waiting", "sending", "receiving", "interrupted"]);
export const DONE = new Set(["complete"]);
export const ENDED_BADLY = new Set(["failed", "cancelled", "declined", "timed_out"]);

export function tabOf(t) {
  if (DONE.has(t.state))
    return "completed";

  if (ENDED_BADLY.has(t.state))
    return "failed";

  return "active";
}

// Time left, readable: "42 s", "3 min 20 s", "1 h 5 min".
export function formatRemaining(seconds) {
  const s = Math.max(1, Math.round(seconds));

  if (s < 60)
    return `${s} s`;

  if (s < 3600)
    return `${Math.floor(s / 60)} min${s % 60 ? ` ${s % 60} s` : ""}`;

  return `${Math.floor(s / 3600)} h${Math.floor((s % 3600) / 60) ? ` ${Math.floor((s % 3600) / 60)} min` : ""}`;
}
