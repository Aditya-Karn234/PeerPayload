// Small building blocks shared by the Connect screens, styled with the
// same palette tokens as the Enterprise app (index.css).

const VARIANTS = {
  primary: { background: "var(--color-accent)", color: "#fff", border: "transparent" },
  secondary: { background: "transparent", color: "var(--color-ink)", border: "var(--color-border)" },
  quiet: { background: "transparent", color: "var(--color-ink-secondary)", border: "transparent" },
  danger: { background: "transparent", color: "var(--color-critical)", border: "var(--color-border)" },
};

export function Button({ variant = "secondary", className = "", ...props }) {
  const v = VARIANTS[variant];

  return (
    <button
      type="button"
      className={`rounded-md border px-3 py-1.5 text-sm font-medium disabled:opacity-60 ${className}`}
      style={{ background: v.background, color: v.color, borderColor: v.border }}
      {...props}
    />
  );
}

export function Card({ className = "", style, children, ...props }) {
  return (
    <section className={`rounded-lg border p-4 ${className}`} style={{ borderColor: "var(--color-border)", background: "var(--color-surface)", ...style }} {...props}>
      {children}
    </section>
  );
}

export function Field({ label, hint, children }) {
  return (
    <label className="block">
      <span className="text-sm font-medium">{label}</span>
      {children}
      {hint && (
        <span className="mt-1 block text-xs" style={{ color: "var(--color-ink-muted)" }}>
          {hint}
        </span>
      )}
    </label>
  );
}

export function TextInput(props) {
  return (
    <input
      className="mt-1 w-full rounded-md border px-3 py-2 text-sm"
      style={{ borderColor: "var(--color-border)", background: "var(--color-page)", color: "var(--color-ink)" }}
      {...props}
    />
  );
}

export function ErrorText({ children }) {
  return children ? (
    <p className="mt-2 text-sm" style={{ color: "var(--color-critical)" }} role="alert">
      {children}
    </p>
  ) : null;
}

export function Muted({ children, className = "" }) {
  return (
    <p className={`text-xs ${className}`} style={{ color: "var(--color-ink-muted)" }}>
      {children}
    </p>
  );
}

// Electron's IPC wraps thrown errors as "Error invoking remote method
// 'x': Error: <message>"; show only the message.
export function errorMessage(err) {
  return String(err?.message ?? err).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
}
