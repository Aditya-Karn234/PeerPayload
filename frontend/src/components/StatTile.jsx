// Stat tile contract: label (sentence case, no trailing colon) + value
// (semibold, proportional figures — not tabular, this isn't a table column).
export default function StatTile({ label, value, accent }) {
  return (
    <div
      className="rounded-lg border p-4"
      style={{ borderColor: "var(--color-border)", background: "var(--color-surface)" }}
    >
      <div className="text-sm" style={{ color: "var(--color-ink-secondary)" }}>
        {label}
      </div>
      <div
        className="mt-1 text-2xl font-semibold"
        style={{ color: accent || "var(--color-ink)" }}
      >
        {value}
      </div>
    </div>
  );
}
