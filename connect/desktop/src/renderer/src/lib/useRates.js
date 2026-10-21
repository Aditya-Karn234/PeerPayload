import { useEffect, useRef, useState } from "react";

// Transfer speed and time remaining, measured from the progress the engine
// reports (never estimated from anything else). A rate is shown only once
// there are at least 1.5 s of samples; if no new bytes arrive for 4 s the
// transfer counts as stalled.
const WINDOW_MS = 5000;
const MIN_SPAN_MS = 1500;
const STALL_MS = 4000;

export default function useRates(transfers) {
  const samples = useRef(new Map()); // transferId -> [{ t, bytes }]
  const [, setTick] = useState(0);

  const running = transfers.filter((t) => t.state === "sending" || t.state === "receiving");

  // Record a sample whenever reported bytes change.
  const now = Date.now();

  for (const t of running) {
    const bytes = t.progress?.bytes;

    if (bytes === undefined)
      continue;

    const list = samples.current.get(t.transferId) ?? [];

    if (!list.length || list[list.length - 1].bytes !== bytes)
      list.push({ t: now, bytes });

    while (list.length > 2 && now - list[0].t > WINDOW_MS)
      list.shift();

    samples.current.set(t.transferId, list);
  }

  for (const id of [...samples.current.keys()])
    if (!running.some((t) => t.transferId === id))
      samples.current.delete(id);

  // Re-render once a second while something runs, so a stall shows.
  useEffect(() => {
    if (!running.length)
      return undefined;

    const timer = setInterval(() => setTick((n) => n + 1), 1000);

    return () => clearInterval(timer);
  }, [running.length]);

  const rates = new Map();

  for (const t of running) {
    const list = samples.current.get(t.transferId) ?? [];

    if (list.length < 2) {
      rates.set(t.transferId, { measuring: true });
      continue;
    }

    const first = list[0];
    const last = list[list.length - 1];

    if (now - last.t > STALL_MS) {
      rates.set(t.transferId, { stalled: true });
      continue;
    }

    const span = last.t - first.t;

    if (span < MIN_SPAN_MS) {
      rates.set(t.transferId, { measuring: true });
      continue;
    }

    const bytesPerSec = ((last.bytes - first.bytes) / span) * 1000;
    const remaining = Math.max(0, (t.totalBytes ?? 0) - last.bytes);

    rates.set(t.transferId, { bytesPerSec, secondsLeft: bytesPerSec > 0 ? remaining / bytesPerSec : null });
  }

  return rates;
}
