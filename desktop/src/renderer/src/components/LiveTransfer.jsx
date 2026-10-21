import { ArrowDownLeft, ArrowUpRight } from "lucide-react";
import { Meter, Mono, formatRemaining, useRates } from "@peerpayload/ui";

import { sizeLabel } from "../lib/util";

// What a running send or receive is doing, in words (same messages the app
// has always shown).
export function phaseText(direction, state, peer) {
  if (!state)
    return direction === "out" ? "Starting…" : "Starting receiver…";

  switch (state.phase) {
    case "starting":
      return "Starting…";
    case "waiting-for-acceptance":
      return `Waiting for ${peer} to accept…`;
    case "sending":
      return state.path === "relay" ? "Sending via relay…" : "Sending…";
    case "retrying":
      return `Connection lost (${state.reason}) — resuming in ${Math.round(state.delayMs / 1000)}s (attempt ${state.attempt + 1})…`;
    case "starting-receiver":
      return "Starting receiver…";
    case "accepted":
      return "Accepted — waiting for sender to connect…";
    case "receiving":
      return state.event?.event === "session_failed" ? `Connection lost (${state.event.reason}) — waiting for the sender to resume…` : "Receiving…";
    case "done":
      return state.ok ? (state.path === "relay" ? "Complete (via relay)." : "Complete.") : `Failed: ${state.finalEvent?.reason}`;
    default:
      return "";
  }
}

// One running transfer: who, how far (real bytes from engine events), how
// fast (measured), and the phase in words.
export default function LiveTransfer({ direction, peer, state, progress, testId }) {
  const running = state?.phase === "sending" || state?.phase === "receiving";
  const done = state?.phase === "done";
  const rates = useRates([{ id: "live", running, bytes: progress?.bytes, total: progress?.total }]);
  const rate = rates.get("live");
  const bytes = done && state.ok ? progress?.total : progress?.bytes;
  const pct = progress?.total ? Math.min(100, Math.floor(((bytes ?? 0) / progress.total) * 100)) : null;

  const speed = !running || !progress ? null : !rate || rate.measuring ? "measuring speed" : rate.stalled ? "no data for a few seconds" : `${sizeLabel(rate.bytesPerSec)}/s`;
  const left = running && rate?.bytesPerSec > 0 && rate.secondsLeft != null ? `${formatRemaining(rate.secondsLeft)} left` : null;
  const status = done ? (state.ok ? "complete" : "failed") : undefined;

  return (
    <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-4 py-3" data-testid={testId} data-phase={state?.phase ?? "starting"}>
      {direction === "out" ? (
        <ArrowUpRight size={20} strokeWidth={1.5} className="text-[var(--color-ink-secondary)]" aria-hidden="true" />
      ) : (
        <ArrowDownLeft size={20} strokeWidth={1.5} className="text-[var(--color-ink-secondary)]" aria-hidden="true" />
      )}
      <div className="min-w-0">
        <div className="flex items-baseline justify-between gap-3">
          <p className="truncate text-sm">
            {direction === "out" ? "To " : "From "}
            <span className="font-medium">{peer}</span>
          </p>
          {progress && (
            <Mono className="shrink-0 text-[var(--color-ink-secondary)]">
              {sizeLabel(bytes)} / {sizeLabel(progress.total)}
              {pct !== null && ` · ${pct}%`}
            </Mono>
          )}
        </div>
        {(progress || done) && (
          <div className="mt-2">
            <Meter value={bytes ?? 0} max={progress?.total ?? 0} status={status} />
          </div>
        )}
        <p className="mt-1.5 truncate text-xs text-[var(--color-ink-secondary)]">
          {[phaseText(direction, state, peer), speed, left].filter(Boolean).join(" · ")}
        </p>
      </div>
    </div>
  );
}
