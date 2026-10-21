import { Wordmark } from "./Brand";

// The app's left column: wordmark + edition, navigation, and a footer the
// app fills with its own (real) status. pages: [{ id, label, icon, badge }]
export default function SidebarNav({ edition, pages, current, onNavigate, footer }) {
  return (
    <aside className="flex w-56 shrink-0 flex-col border-r border-[var(--color-border)] bg-[var(--color-surface)]">
      <div className="px-5 pb-6 pt-5">
        <Wordmark size={26} edition={edition} />
      </div>

      <nav aria-label="Sections" className="flex flex-col gap-0.5 px-3">
        {pages.map(({ id, label, icon: Icon, badge }) => {
          const selected = id === current;

          return (
            <button
              key={id}
              type="button"
              onClick={() => onNavigate(id)}
              aria-current={selected ? "page" : undefined}
              className={`relative flex h-9 items-center gap-3 rounded-[var(--radius-md)] px-3 text-sm transition-colors duration-100 ${selected ? "bg-[var(--color-accent-soft)] font-medium text-[var(--color-ink)]" : "text-[var(--color-ink-secondary)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-ink)]"}`}
            >
              {selected && <span className="absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-[var(--color-accent)]" aria-hidden="true" />}
              <Icon size={17} strokeWidth={1.75} className={selected ? "text-[var(--color-accent)]" : ""} aria-hidden="true" />
              {label}
              {badge ? (
                <span className="ml-auto min-w-5 rounded-[var(--radius-sm)] bg-[var(--color-accent)] px-1 text-center font-mono text-[11px] font-medium text-[var(--color-accent-ink)]">
                  {badge}
                  <span className="sr-only"> waiting</span>
                </span>
              ) : null}
            </button>
          );
        })}
      </nav>

      <div className="mt-auto border-t border-[var(--color-border)] px-5 py-4">{footer}</div>
    </aside>
  );
}

// A status line for the sidebar footer: a dot (filled when good, a ring
// otherwise) plus the label, so it never relies on color alone.
export function StatusLine({ label, detail, tone = "muted", testId }) {
  const color = { good: "var(--color-good)", warning: "var(--color-warning)", bad: "var(--color-critical)", muted: "var(--color-ink-muted)" }[tone];

  return (
    <div data-testid={testId}>
      <p className="flex items-center gap-2 text-[13px] font-medium">
        <span
          className="inline-block h-2 w-2 rounded-full"
          style={tone === "good" ? { background: color } : { boxShadow: `inset 0 0 0 1.5px ${color}` }}
          aria-hidden="true"
        />
        {label}
      </p>
      {detail && <p className="mt-0.5 pl-4 font-mono text-[11px] text-[var(--color-ink-muted)]">{detail}</p>}
    </div>
  );
}
