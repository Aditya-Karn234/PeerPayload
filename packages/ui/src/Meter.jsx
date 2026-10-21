// Meter / progress track: fill carries state (accent while active, good on
// success, critical/serious if it stopped early); unfilled track is a
// lighter step of the same accent ramp so state reads across the whole bar.
const FILL_BY_STATUS = {
  complete: "var(--color-good)",
  failed: "var(--color-critical)",
  cancelled: "var(--color-serious)",
  rejected: "var(--color-serious)",
  not_reachable: "var(--color-warning)",
  timed_out: "var(--color-warning)",
};

export default function Meter({ value, max, status }) {
  const pct =
    max > 0
      ? Math.min(100, (value / max) * 100)
      : status === "complete"
        ? 100
        : 0;

  // Active: the neutral progress color where the theme defines one (it
  // keeps orange for actions), else the accent.
  const fill = FILL_BY_STATUS[status] || "var(--color-progress, var(--color-accent))";

  return (
    <div
      className="h-1.5 w-full overflow-hidden rounded-[2px]"
      style={{ background: "var(--color-accent-track)" }}
      role="progressbar"
      aria-valuenow={Math.round(pct)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div
        className="h-full rounded-[2px] transition-[width] duration-300 ease-out"
        style={{ width: `${pct}%`, background: fill }}
      />
    </div>
  );
}
