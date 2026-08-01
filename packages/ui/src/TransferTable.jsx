import { useMemo, useState } from "react";

import StatusBadge from "./StatusBadge";
import { formatBytes, formatRelativeTime } from "./format";

const STATUS_OPTIONS = [
  "all",
  "pending",
  "accepted",
  "in_progress",
  "complete",
  "failed",
  "rejected",
  "not_reachable",
  "timed_out",
  "cancelled",
];

// "→ bob" if I'm the sender, "← alice" if I'm the receiver — this table has
// no notion of local file paths anymore (the backend never sees them); the
// other party's name is the identifying detail for a row.
function formatDirection(transfer, myUsername) {
  return transfer.senderUsername === myUsername
    ? `→ ${transfer.receiverUsername}`
    : `← ${transfer.senderUsername}`;
}

// No live progress column — this is a historical/audit list of intents the
// backend knows about, not a view into an in-flight transfer's byte
// progress (that only exists locally, via IPC, while it's actually running
// on this machine; see the desktop app's TransferDetail equivalent).
export default function TransferTable({ transfers, myUsername, onSelect }) {
  const [statusFilter, setStatusFilter] = useState("all");
  const [sortDir, setSortDir] = useState("desc");

  const rows = useMemo(() => {
    let result = transfers;

    if (statusFilter !== "all")
      result = result.filter((t) => t.status === statusFilter);

    result = [...result].sort((a, b) => {
      const dir = sortDir === "asc" ? 1 : -1;

      return (new Date(a.createdAt) - new Date(b.createdAt)) * dir;
    });

    return result;
  }, [transfers, statusFilter, sortDir]);

  return (
    <div
      className="rounded-lg border"
      style={{ borderColor: "var(--color-border)", background: "var(--color-surface)" }}
    >
      <div
        className="flex items-center justify-between border-b px-4 py-3"
        style={{ borderColor: "var(--color-border)" }}
      >
        <h2 className="text-sm font-semibold">History</h2>

        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="rounded-md border bg-transparent px-2 py-1 text-xs"
          style={{ borderColor: "var(--color-border)", color: "var(--color-ink-secondary)" }}
        >
          {STATUS_OPTIONS.map((s) => (
            <option key={s} value={s}>
              {s === "all" ? "All statuses" : s.replace(/_/g, " ")}
            </option>
          ))}
        </select>
      </div>

      {rows.length === 0 ? (
        <p className="px-4 py-8 text-center text-sm" style={{ color: "var(--color-ink-muted)" }}>
          No transfers yet.
        </p>
      ) : (
        <table className="w-full text-left text-sm">
          <thead>
            <tr style={{ color: "var(--color-ink-muted)" }}>
              <th className="px-4 py-2 font-medium">Status</th>
              <th className="px-4 py-2 font-medium">With</th>
              <th className="px-4 py-2 font-medium">Size</th>
              <th className="px-4 py-2 font-medium">
                <button type="button" onClick={() => setSortDir((d) => (d === "asc" ? "desc" : "asc"))} className="hover:underline">
                  Created
                </button>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((t) => (
              <tr
                key={t.id}
                onClick={() => onSelect?.(t)}
                className="cursor-pointer border-t"
                style={{ borderColor: "var(--color-gridline)" }}
              >
                <td className="px-4 py-3">
                  <StatusBadge status={t.status} />
                </td>
                <td className="px-4 py-3" style={{ color: "var(--color-ink)" }}>
                  {formatDirection(t, myUsername)}
                  {t.fileCount ? (
                    <span className="ml-1.5" style={{ color: "var(--color-ink-muted)" }}>
                      ({t.fileCount} {t.fileCount === 1 ? "file" : "files"})
                    </span>
                  ) : null}
                </td>
                <td className="px-4 py-3 tabular-nums" style={{ color: "var(--color-ink-muted)" }}>
                  {t.totalBytes ? formatBytes(t.totalBytes) : "—"}
                </td>
                <td className="px-4 py-3 tabular-nums" style={{ color: "var(--color-ink-muted)" }}>
                  {formatRelativeTime(t.createdAt)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
