// Basic controls in the PeerPayload style: square-ish (4 px), thin
// borders, no shadows, one orange primary action per view. All colors
// come from theme.css variables, so both themes need nothing extra here.

const BUTTON = {
  primary: "bg-[var(--color-accent)] text-[var(--color-accent-ink)] border-transparent hover:bg-[var(--color-accent-hover)]",
  secondary: "bg-[var(--color-surface)] text-[var(--color-ink)] border-[var(--color-border-strong)] hover:bg-[var(--color-surface-2)]",
  ghost: "bg-transparent text-[var(--color-ink-secondary)] border-transparent hover:bg-[var(--color-surface-2)] hover:text-[var(--color-ink)]",
  danger: "bg-transparent text-[var(--color-critical)] border-[var(--color-border)] hover:bg-[var(--color-surface-2)]",
};

const SIZE = {
  sm: "h-8 px-3 text-[13px] gap-1.5",
  md: "h-10 px-4 text-sm gap-2",
};

export function Button({ variant = "secondary", size = "md", icon: Icon, iconAfter: IconAfter, className = "", children, ...props }) {
  return (
    <button
      type="button"
      className={`inline-flex shrink-0 items-center justify-center rounded-[var(--radius-md)] border font-medium transition-colors duration-100 disabled:cursor-not-allowed disabled:opacity-45 ${BUTTON[variant]} ${SIZE[size]} ${className}`}
      {...props}
    >
      {Icon && <Icon size={size === "sm" ? 15 : 16} strokeWidth={1.75} aria-hidden="true" />}
      {children}
      {IconAfter && <IconAfter size={size === "sm" ? 15 : 16} strokeWidth={1.75} aria-hidden="true" />}
    </button>
  );
}

// Square icon-only button; `label` is required (it's the accessible name
// and the tooltip).
export function IconButton({ icon: Icon, label, className = "", ...props }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--radius-md)] border border-[var(--color-border)] text-[var(--color-ink-secondary)] transition-colors duration-100 hover:bg-[var(--color-surface-2)] hover:text-[var(--color-ink)] disabled:opacity-45 ${className}`}
      {...props}
    >
      <Icon size={15} strokeWidth={1.75} aria-hidden="true" />
    </button>
  );
}

// Small uppercase mono label: section identifiers and technical keys.
export function SectionLabel({ children, className = "", as: Tag = "p" }) {
  return (
    <Tag className={`font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--color-ink-muted)] ${className}`}>
      {children}
    </Tag>
  );
}

// Monospaced technical value (sizes, speeds, IDs).
export function Mono({ children, className = "" }) {
  return <span className={`font-mono text-[12px] tabular-nums ${className}`}>{children}</span>;
}

export function Field({ label, hint, error, children, className = "" }) {
  return (
    <label className={`block ${className}`}>
      <span className="text-[13px] font-medium text-[var(--color-ink)]">{label}</span>
      <span className="mt-1.5 block">{children}</span>
      {hint && !error && <span className="mt-1.5 block text-xs text-[var(--color-ink-secondary)]">{hint}</span>}
      {error && (
        <span className="mt-1.5 block text-xs text-[var(--color-critical)]" role="alert">
          {error}
        </span>
      )}
    </label>
  );
}

const INPUT = "w-full rounded-[var(--radius-md)] border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-3 text-sm text-[var(--color-ink)] placeholder:text-[var(--color-ink-muted)] focus:border-[var(--color-ink-secondary)] read-only:bg-[var(--color-surface-2)]";

export function TextInput({ className = "", ...props }) {
  return <input className={`h-10 ${INPUT} ${className}`} {...props} />;
}

export function Select({ className = "", children, ...props }) {
  return (
    <select className={`h-10 ${INPUT} pr-8 ${className}`} {...props}>
      {children}
    </select>
  );
}

// On/off switch. `label` is its accessible name.
export function Toggle({ checked, onChange, label, disabled }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors duration-100 disabled:opacity-45 ${checked ? "border-transparent bg-[var(--color-accent)]" : "border-[var(--color-border-strong)] bg-[var(--color-surface-2)]"}`}
    >
      <span
        className={`inline-block h-3.5 w-3.5 rounded-full transition-transform duration-100 ${checked ? "translate-x-[18px] bg-[var(--color-accent-ink)]" : "translate-x-[2px] bg-[var(--color-ink-muted)]"}`}
      />
    </button>
  );
}

// Underlined tabs with optional counts. items: [{ id, label, count }]
export function Tabs({ items, value, onChange, label }) {
  return (
    <div role="tablist" aria-label={label} className="flex gap-6 border-b border-[var(--color-border)]">
      {items.map((item) => {
        const selected = item.id === value;

        return (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => onChange(item.id)}
            className={`-mb-px flex items-center gap-2 border-b-2 pb-2.5 text-sm transition-colors duration-100 ${selected ? "border-[var(--color-accent)] font-medium text-[var(--color-ink)]" : "border-transparent text-[var(--color-ink-secondary)] hover:text-[var(--color-ink)]"}`}
          >
            {item.label}
            {item.count !== undefined && (
              <span className={`min-w-5 rounded-[var(--radius-sm)] border px-1 font-mono text-[11px] tabular-nums ${selected ? "border-[var(--color-ink)]" : "border-[var(--color-border-strong)]"}`}>
                {item.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
