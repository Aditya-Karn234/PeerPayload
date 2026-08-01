// Status colors are never the only signal — each pairs a fixed icon with a
// label, per the project's dataviz palette rules (status colors are
// reserved and must ship with icon + label, never color alone). Covers the
// org-tool Transfer status enum: pending -> accepted -> in_progress ->
// complete|failed, or pending -> rejected|not_reachable|timed_out|cancelled.
const STATUS = {
  pending: {
    label: "Pending",
    color: "var(--color-ink-muted)",
    icon: <circle cx="8" cy="8" r="5.5" fill="none" strokeWidth="2" />,
  },
  accepted: {
    label: "Accepted",
    color: "var(--color-accent)",
    icon: (
      <>
        <circle cx="8" cy="8" r="2" />
        <path d="M4.5 8a3.5 3.5 0 0 1 7 0M2.5 8a5.5 5.5 0 0 1 11 0" fill="none" strokeWidth="1.6" strokeLinecap="round" opacity="0.6" />
      </>
    ),
  },
  in_progress: {
    label: "In progress",
    color: "var(--color-accent)",
    icon: (
      <>
        <circle cx="8" cy="8" r="5.5" fill="none" strokeWidth="2" opacity="0.35" />
        <path d="M8 2.5a5.5 5.5 0 0 1 5.5 5.5" fill="none" strokeWidth="2" strokeLinecap="round" />
      </>
    ),
  },
  complete: {
    label: "Complete",
    color: "var(--color-good)",
    icon: <path d="M3.5 8.5l3 3 6-6.5" fill="none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />,
  },
  failed: {
    label: "Failed",
    color: "var(--color-critical)",
    icon: <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" fill="none" strokeWidth="2" strokeLinecap="round" />,
  },
  cancelled: {
    label: "Cancelled",
    color: "var(--color-serious)",
    icon: (
      <>
        <circle cx="8" cy="8" r="5.5" fill="none" strokeWidth="2" />
        <path d="M4.5 4.5l7 7" strokeWidth="2" strokeLinecap="round" />
      </>
    ),
  },
  rejected: {
    label: "Rejected",
    color: "var(--color-serious)",
    icon: (
      <>
        <circle cx="8" cy="8" r="5.5" fill="none" strokeWidth="2" />
        <path d="M5.5 5.5l5 5M10.5 5.5l-5 5" strokeWidth="2" strokeLinecap="round" />
      </>
    ),
  },
  not_reachable: {
    label: "Not reachable",
    color: "var(--color-warning)",
    icon: (
      <>
        <path d="M3 3l10 10" strokeWidth="2" strokeLinecap="round" />
        <path d="M4.5 8a3.5 3.5 0 0 1 4.5-3.36M11.5 8a3.5 3.5 0 0 1-1.3 2.73" fill="none" strokeWidth="1.6" strokeLinecap="round" opacity="0.6" />
      </>
    ),
  },
  timed_out: {
    label: "Timed out",
    color: "var(--color-warning)",
    icon: (
      <>
        <circle cx="8" cy="8" r="5.5" fill="none" strokeWidth="2" />
        <path d="M8 4.5v4l2.5 1.5" fill="none" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </>
    ),
  },
};

export default function StatusBadge({ status }) {
  const spec = STATUS[status] || STATUS.pending;

  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium"
      style={{ color: spec.color, borderColor: "var(--color-border)" }}
    >
      <svg width="16" height="16" viewBox="0 0 16 16" stroke="currentColor" fill="currentColor">
        {spec.icon}
      </svg>
      {spec.label}
    </span>
  );
}
