import { useEffect, useRef, useState } from "react";

// Transfer speed and time remaining, measured from reported progress
// (never estimated from anything else). A rate is shown only once there
// are at least 1.5 s of samples; if no new bytes arrive for 4 s the
// transfer counts as stalled.
//
// items: [{ id, running, bytes, total }]
// returns Map id -> { measuring } | { stalled } | { bytesPerSec, secondsLeft }
const WINDOW_MS = 5000;
const MIN_SPAN_MS = 1500;
const STALL_MS = 4000;

export default function useRates(items) {
  const samples = useRef(new Map()); // id -> [{ t, bytes }]
  const [, setTick] = useState(0);

  const running = items.filter((i) => i.running);
  const now = Date.now();

  // Record a sample whenever reported bytes change.
  for (const item of running) {
    if (item.bytes === undefined || item.bytes === null)
      continue;

    const list = samples.current.get(item.id) ?? [];

    if (!list.length || list[list.length - 1].bytes !== item.bytes)
      list.push({ t: now, bytes: item.bytes });

    while (list.length > 2 && now - list[0].t > WINDOW_MS)
      list.shift();

    samples.current.set(item.id, list);
  }

  for (const id of [...samples.current.keys()])
    if (!running.some((i) => i.id === id))
      samples.current.delete(id);

  // Re-render once a second while something runs, so a stall shows.
  useEffect(() => {
    if (!running.length)
      return undefined;

    const timer = setInterval(() => setTick((n) => n + 1), 1000);

    return () => clearInterval(timer);
  }, [running.length]);

  const rates = new Map();

  for (const item of running) {
    const list = samples.current.get(item.id) ?? [];

    if (list.length < 2) {
      rates.set(item.id, { measuring: true });
      continue;
    }

    const first = list[0];
    const last = list[list.length - 1];

    if (now - last.t > STALL_MS) {
      rates.set(item.id, { stalled: true });
      continue;
    }

    const span = last.t - first.t;

    if (span < MIN_SPAN_MS) {
      rates.set(item.id, { measuring: true });
      continue;
    }

    const bytesPerSec = ((last.bytes - first.bytes) / span) * 1000;
    const remaining = Math.max(0, (item.total ?? 0) - last.bytes);

    rates.set(item.id, { bytesPerSec, secondsLeft: bytesPerSec > 0 ? remaining / bytesPerSec : null });
  }

  return rates;
}

// Time left, readable: "42 s", "3 min 20 s", "1 h 5 min".
export function formatRemaining(seconds) {
  const s = Math.max(1, Math.round(seconds));

  if (s < 60)
    return `${s} s`;

  if (s < 3600)
    return `${Math.floor(s / 60)} min${s % 60 ? ` ${s % 60} s` : ""}`;

  return `${Math.floor(s / 3600)} h${Math.floor((s % 3600) / 60) ? ` ${Math.floor((s % 3600) / 60)} min` : ""}`;
}
