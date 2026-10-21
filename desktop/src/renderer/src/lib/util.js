import { formatBytes } from "@peerpayload/ui";

export const sizeLabel = (bytes) => formatBytes(bytes ?? 0);

export const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

// Backend transfer statuses grouped the way the History tabs show them.
const ACTIVE = new Set(["pending", "accepted", "in_progress"]);
const FAILED = new Set(["failed", "rejected", "not_reachable", "timed_out", "cancelled"]);

export function tabOf(t) {
  if (ACTIVE.has(t.status))
    return "active";

  return FAILED.has(t.status) ? "failed" : "completed";
}
