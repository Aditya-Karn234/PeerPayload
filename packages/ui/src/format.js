const UNITS = ["B", "KB", "MB", "GB", "TB"];

export function formatBytes(value) {
  if (value === null || value === undefined)
    return "—";

  let n = typeof value === "bigint" ? Number(value) : Number(value);

  if (!Number.isFinite(n))
    return "—";

  let unitIndex = 0;

  while (n >= 1024 && unitIndex < UNITS.length - 1) {
    n /= 1024;
    unitIndex += 1;
  }

  const precision = unitIndex === 0 ? 0 : 1;

  return `${n.toFixed(precision)} ${UNITS[unitIndex]}`;
}

export function formatRelativeTime(isoString) {
  if (!isoString)
    return "—";

  const then = new Date(isoString).getTime();
  const diffSeconds = Math.round((Date.now() - then) / 1000);

  if (diffSeconds < 5)
    return "just now";

  if (diffSeconds < 60)
    return `${diffSeconds}s ago`;

  const diffMinutes = Math.round(diffSeconds / 60);

  if (diffMinutes < 60)
    return `${diffMinutes}m ago`;

  const diffHours = Math.round(diffMinutes / 60);

  if (diffHours < 24)
    return `${diffHours}h ago`;

  const diffDays = Math.round(diffHours / 24);

  return `${diffDays}d ago`;
}

export function formatDuration(ms) {
  if (ms === null || ms === undefined)
    return "—";

  if (ms < 1000)
    return `${ms}ms`;

  return `${(ms / 1000).toFixed(1)}s`;
}
