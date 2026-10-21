import { ArrowUpFromLine, Clock3, MonitorSmartphone, Settings } from "lucide-react";
import { Wordmark } from "@peerpayload/ui";

export const PAGES = [
  { id: "transfer", label: "Transfer", icon: ArrowUpFromLine },
  { id: "devices", label: "Devices", icon: MonitorSmartphone },
  { id: "history", label: "History", icon: Clock3 },
  { id: "settings", label: "Settings", icon: Settings },
];

// Real mailbox state only: whether this device can be reached for
// invites and offers right now.
function connectionState(status) {
  if (!status.mailboxUrl)
    return { label: "No mailbox set", detail: "Set one in Settings", dot: "var(--color-warning)", ring: true };

  if (status.connected)
    return { label: "Connected", detail: "Can receive", dot: "var(--color-good)" };

  return { label: "Connecting…", detail: "Mailbox", dot: "var(--color-ink-muted)", ring: true };
}

export default function Sidebar({ page, onNavigate, status, badges = {} }) {
  const conn = connectionState(status);

  return (
    <aside className="flex w-56 shrink-0 flex-col border-r border-[var(--color-border)] bg-[var(--color-surface)]">
      <div className="px-5 pb-6 pt-5">
        <Wordmark size={26} edition="Connect" />
      </div>

      <nav aria-label="Sections" className="flex flex-col gap-0.5 px-3">
        {PAGES.map(({ id, label, icon: Icon }) => {
          const current = id === page;

          return (
            <button
              key={id}
              type="button"
              onClick={() => onNavigate(id)}
              aria-current={current ? "page" : undefined}
              className={`relative flex h-9 items-center gap-3 rounded-[var(--radius-md)] px-3 text-sm transition-colors duration-100 ${current ? "bg-[var(--color-accent-soft)] font-medium text-[var(--color-ink)]" : "text-[var(--color-ink-secondary)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-ink)]"}`}
            >
              {current && <span className="absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-[var(--color-accent)]" aria-hidden="true" />}
              <Icon size={17} strokeWidth={1.75} className={current ? "text-[var(--color-accent)]" : ""} aria-hidden="true" />
              {label}
              {badges[id] ? (
                <span className="ml-auto min-w-5 rounded-[var(--radius-sm)] bg-[var(--color-accent)] px-1 text-center font-mono text-[11px] font-medium text-[var(--color-accent-ink)]">
                  {badges[id]}
                  <span className="sr-only"> waiting</span>
                </span>
              ) : null}
            </button>
          );
        })}
      </nav>

      <div className="mt-auto border-t border-[var(--color-border)] px-5 py-4" data-testid="connection">
        <p className="flex items-center gap-2 text-[13px] font-medium">
          <span
            className="inline-block h-2 w-2 rounded-full"
            style={conn.ring ? { boxShadow: `inset 0 0 0 1.5px ${conn.dot}` } : { background: conn.dot }}
            aria-hidden="true"
          />
          {conn.label}
        </p>
        <p className="mt-0.5 pl-4 font-mono text-[11px] text-[var(--color-ink-muted)]">{conn.detail}</p>
        <p className="mt-3 truncate pl-4 text-xs text-[var(--color-ink-secondary)]" title={`${status.name} · device ${status.fingerprint}`}>
          {status.name} · <span className="font-mono">{status.fingerprint.slice(0, 8)}</span>
        </p>
      </div>
    </aside>
  );
}
