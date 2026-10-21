// The PeerPayload raven: a flat, angular silhouette with one orange
// feather. The body takes the current text color (graphite on bone, bone
// on graphite), so the same mark works in both themes; only the feather
// is the accent. Stays recognizable down to 16 px.

export function RavenMark({ size = 24, title = "PeerPayload", accent = "var(--color-accent)", ...props }) {
  return (
    <svg viewBox="0 0 64 64" width={size} height={size} role="img" aria-label={title} {...props}>
      <path fill={accent} d="M31 34 L3 46 L26 30 Z" />
      <path
        fill="currentColor"
        fillRule="evenodd"
        d="M63.5 19.5 L51 22.6 L46 27.5 L41 36.5 L26 51 L29 37.5 L4 31 L24 27 L1 5 L33 15 L39 9.5 L48 9 L53 12.8 Z M44.4 13.4 L47.9 13.8 L45.6 16.4 Z"
      />
    </svg>
  );
}

// Mark + "PeerPayload" ("Payload" in the accent), optionally with the
// edition ("Connect", "Enterprise") as a small mono label underneath.
// markSrc: the edition's own app icon image instead of the raven mark, so
// the window matches the launcher icon.
export function Wordmark({ size = 24, edition, markSrc, className = "" }) {
  return (
    <span className={`inline-flex items-center gap-2.5 ${className}`}>
      {markSrc ? (
        <img src={markSrc} alt="" width={size + 6} height={size + 6} className="shrink-0" aria-hidden="true" />
      ) : (
        <RavenMark size={size} title="" aria-hidden="true" />
      )}
      <span className="flex flex-col leading-none">
        <span className="font-bold tracking-tight" style={{ fontSize: size * 0.62 }}>
          Peer<span style={{ color: "var(--color-accent)" }}>Payload</span>
        </span>
        {edition && (
          <span className="mt-1 font-mono text-[10px] uppercase tracking-[0.14em]" style={{ color: "var(--color-ink-muted)" }}>
            {edition}
          </span>
        )}
      </span>
    </span>
  );
}
