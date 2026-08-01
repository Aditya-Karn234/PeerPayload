import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";

import StatusBadge from "./StatusBadge";
import Meter from "./Meter";
import { formatBytes, formatRelativeTime } from "../lib/format";

const STATUS_OPTIONS = ["all", "pending", "listening", "in_progress", "complete", "failed", "cancelled"];

function basename(path) {
  if (!path)
    return "";

  return path.split(/[\\/]/).filter(Boolean).pop() || path;
}

// "send"/"receive" transfers only ever have one of sourcePath/destDir set
// locally — the other end lives on a different machine entirely.
function describeTransfer(t) {
  if (t.mode === "receive")
    return `← ${basename(t.destDir)}${t.port ? ` (port ${t.port})` : ""}`;

  if (t.mode === "send")
    return `${basename(t.sourcePath)} → ${t.host}:${t.port}`;

  return basename(t.sourcePath);
}

export default function TransferTable({ transfers }) {
  const navigate = useNavigate();
  const [statusFilter, setStatusFilter] = useState("all");
  const [sortKey, setSortKey] = useState("createdAt");
  const [sortDir, setSortDir] = useState("desc");

  const rows = useMemo(() => {
    let result = transfers;

    if (statusFilter !== "all")
      result = result.filter((t) => t.status === statusFilter);

    result = [...result].sort((a, b) => {
      const dir = sortDir === "asc" ? 1 : -1;

      if (sortKey === "status")
        return a.status.localeCompare(b.status) * dir;

      return (new Date(a.createdAt) - new Date(b.createdAt)) * dir;
    });

    return result;
  }, [transfers, statusFilter, sortKey, sortDir]);

  function toggleSort(key) {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  }

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
              {s === "all" ? "All statuses" : s.replace("_", " ")}
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
              <th className="px-4 py-2 font-medium">
                <button type="button" onClick={() => toggleSort("status")} className="hover:underline">
                  Status
                </button>
              </th>
              <th className="px-4 py-2 font-medium">Source</th>
              <th className="px-4 py-2 font-medium">Progress</th>
              <th className="px-4 py-2 font-medium">
                <button type="button" onClick={() => toggleSort("createdAt")} className="hover:underline">
                  Created
                </button>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((t) => (
              <tr
                key={t.id}
                onClick={() => navigate(`/transfers/${t.id}`)}
                className="cursor-pointer border-t"
                style={{ borderColor: "var(--color-gridline)" }}
              >
                <td className="px-4 py-3">
                  <StatusBadge status={t.status} />
                </td>
                <td className="px-4 py-3" style={{ color: "var(--color-ink)" }}>
                  {describeTransfer(t)}
                  {t.fileCount ? (
                    <span className="ml-1.5" style={{ color: "var(--color-ink-muted)" }}>
                      ({t.fileCount} {t.fileCount === 1 ? "file" : "files"})
                    </span>
                  ) : null}
                </td>
                <td className="px-4 py-3" style={{ width: "180px" }}>
                  <div className="flex items-center gap-2">
                    <div className="w-24">
                      <Meter value={Number(t.bytesDone)} max={Number(t.totalBytes || 0)} status={t.status} />
                    </div>
                    <span
                      className="text-xs tabular-nums"
                      style={{ color: "var(--color-ink-muted)" }}
                    >
                      {formatBytes(t.bytesDone)}
                      {t.totalBytes ? ` / ${formatBytes(t.totalBytes)}` : ""}
                    </span>
                  </div>
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
