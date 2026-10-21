import { ArrowDownLeft, ArrowUpRight } from "lucide-react";
import { Mono, SectionLabel, StatusBadge, Tabs, formatRelativeTime } from "@peerpayload/ui";

import { plural, sizeLabel, tabOf } from "../lib/util";

const EMPTY = {
  active: "Nothing in progress.",
  completed: "Finished transfers appear here.",
  failed: "Nothing has failed.",
};

// The audit history the server keeps for this account (both directions).
export default function HistoryPage({ user, d, tab, onTab }) {
  const counts = { active: 0, completed: 0, failed: 0 };

  for (const t of d.transfers)
    counts[tabOf(t)]++;

  const shown = [...d.transfers].filter((t) => tabOf(t) === tab).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  return (
    <div className="px-8 py-7">
      <SectionLabel>Transfers</SectionLabel>
      <div className="mt-4">
        <Tabs
          label="Transfer status"
          value={tab}
          onChange={onTab}
          items={[
            { id: "active", label: "Active", count: counts.active },
            { id: "completed", label: "Completed", count: counts.completed },
            { id: "failed", label: "Failed", count: counts.failed },
          ]}
        />
      </div>

      {shown.length === 0 ? (
        <p className="mt-6 text-sm text-[var(--color-ink-secondary)]">{EMPTY[tab]}</p>
      ) : (
        <ul className="mt-1" aria-label={`${tab} transfers`}>
          {shown.map((t) => {
            const outgoing = t.senderUsername === user.username;
            const other = outgoing ? t.receiverUsername : t.senderUsername;

            return (
              <li
                key={t.id}
                className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-4 border-b border-[var(--color-border)] px-1 py-3.5 last:border-b-0"
                data-testid="history-row"
                data-status={t.status}
              >
                {outgoing ? (
                  <ArrowUpRight size={20} strokeWidth={1.5} className="text-[var(--color-ink-secondary)]" aria-label="Sent" />
                ) : (
                  <ArrowDownLeft size={20} strokeWidth={1.5} className="text-[var(--color-ink-secondary)]" aria-label="Received" />
                )}
                <div className="min-w-0">
                  <p className="truncate text-sm">
                    {outgoing ? "To " : "From "}
                    <span className="font-medium">{other}</span>
                    {t.fileCount ? <span className="text-[var(--color-ink-secondary)]"> · {plural(t.fileCount, "file")}</span> : null}
                  </p>
                  <p className="mt-0.5 truncate text-xs text-[var(--color-ink-secondary)]">
                    <Mono>{t.totalBytes ? sizeLabel(t.totalBytes) : "—"}</Mono>
                    <span aria-hidden="true"> · </span>
                    {formatRelativeTime(t.createdAt)}
                    {t.failReason ? ` · ${t.failReason}` : ""}
                  </p>
                </div>
                <StatusBadge status={t.status} />
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
