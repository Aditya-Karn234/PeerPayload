import { useState } from "react";
import { File, Folder, Pause, Play, X, FolderOpen, ArrowUpRight, ArrowDownLeft, Trash2 } from "lucide-react";
import { IconButton, Meter, Mono, StatusBadge } from "@peerpayload/ui";

import { errorMessage, formatRemaining, sizeLabel, transferTitle } from "../lib/util";

// Connect transfer states -> the shared StatusBadge statuses (icon + label,
// never color alone).
const BADGE = {
  offered: "pending",
  waiting: "pending",
  sending: "in_progress",
  receiving: "in_progress",
  complete: "complete",
  failed: "failed",
  cancelled: "cancelled",
  declined: "declined",
  timed_out: "timed_out",
  interrupted: "interrupted",
};

const speedLabel = (bytesPerSec) => `${sizeLabel(bytesPerSec)}/s`;

// The line under the progress bar: real measurements only.
function detail(t, rate) {
  switch (t.state) {
    case "offered":
      return t.direction === "out" ? `Waiting for ${t.peerName} to accept` : "Waiting for your answer";
    case "waiting":
      return `Asked ${t.peerName} to resume`;
    case "sending":
    case "receiving": {
      const via = t.path === "relay" ? "via relay" : t.path === "direct" ? "direct" : null;
      const retry = t.retry ? `reconnecting (attempt ${t.retry.attempt + 1})` : null;
      const speed = !rate || rate.measuring ? "measuring speed" : rate.stalled ? "no data for a few seconds" : speedLabel(rate.bytesPerSec);
      const left = rate?.secondsLeft != null && rate.bytesPerSec > 0 ? `${formatRemaining(rate.secondsLeft)} left` : null;

      return [retry ?? speed, left, via].filter(Boolean).join(" · ");
    }
    case "complete":
      return t.direction === "in" ? `Saved to ${t.downloadDir}` : `Delivered${t.path === "relay" ? " via relay" : t.path === "direct" ? " directly" : ""}`;
    case "declined":
      return t.direction === "out" ? `${t.peerName} declined` : "You declined";
    case "timed_out":
      return `${t.peerName} didn't answer`;
    case "interrupted":
      return t.error === "paused" ? "Paused" : t.error ?? "Interrupted";
    default:
      return t.error ? t.error : "";
  }
}

// Why a transfer went through the relay, and what would make it direct.
// The relay works anywhere but is limited by the slower side's internet
// upload; direct is as fast as the network between the two devices.
const onWindows = typeof navigator !== "undefined" && /Windows/.test(navigator.userAgent);

function relayHint(t) {
  if (t.path !== "relay" || !["sending", "receiving", "complete"].includes(t.state))
    return null;

  if (t.direction === "out")
    return `Went via the relay: ${t.peerName} couldn't be reached directly (its firewall or network blocks incoming connections).`;

  return onWindows
    ? `Came via the relay: ${t.peerName} couldn't connect to this PC directly. If you trust this network, allow “receiver” (PeerPayload Connect) in Windows Security › Firewall & network protection › Allow an app through firewall, for faster transfers.`
    : `Came via the relay: ${t.peerName} couldn't connect to this computer directly. Allowing incoming connections for PeerPayload Connect in your firewall makes transfers faster.`;
}

// Paused on purpose (by either side) vs cut off (app closed, crash).
const badgeFor = (t) => (t.state === "interrupted" && /^paused/.test(t.error ?? "") ? "paused" : BADGE[t.state] ?? "pending");

export default function TransferRow({ transfer: t, rate }) {
  const [error, setError] = useState(null);
  const outgoing = t.direction === "out";
  const running = t.state === "sending" || t.state === "receiving";
  const shownBytes = t.state === "complete" ? t.totalBytes : (t.progress?.bytes ?? 0);
  const pct = t.totalBytes > 0 ? Math.min(100, Math.floor((shownBytes / t.totalBytes) * 100)) : t.state === "complete" ? 100 : 0;
  const folder = t.files?.length === 1 && t.files[0].files > 1;
  const Icon = folder ? Folder : File;

  const act = (fn) => async () => {
    setError(null);

    try {
      await fn();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  // A resumable one loses its progress for good, on both devices: ask.
  const remove = async () => {
    if (t.resumable && !window.confirm(`Remove this transfer? It can't be resumed afterwards${outgoing ? "" : ", and the part already received is deleted"}. ${t.peerName} is told too.`))
      return;

    await window.connect.forget(t.transferId);
  };

  return (
    <li
      className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 border-b border-[var(--color-border)] px-1 py-3.5 last:border-b-0 md:grid-cols-[auto_minmax(0,1.1fr)_minmax(0,1fr)_auto]"
      data-testid={`transfer-${t.direction}`}
      data-state={t.state}
    >
      <Icon size={22} strokeWidth={1.5} className="text-[var(--color-ink-secondary)]" aria-hidden="true" />

      <div className="min-w-0">
        <p className="truncate text-sm font-medium" title={transferTitle(t)}>
          {transferTitle(t)}
        </p>
        <p className="mt-0.5 flex items-center gap-1 truncate text-xs text-[var(--color-ink-secondary)]">
          {outgoing ? <ArrowUpRight size={12} aria-hidden="true" /> : <ArrowDownLeft size={12} aria-hidden="true" />}
          <Mono>{sizeLabel(t.totalBytes)}</Mono>
          <span aria-hidden="true">·</span>
          <span className="truncate">{outgoing ? `to ${t.peerName}` : `from ${t.peerName}`}</span>
        </p>
      </div>

      <div className="col-span-3 col-start-2 row-start-2 min-w-0 md:col-span-1 md:col-start-3 md:row-start-1">
        {(running || t.started || t.state === "complete") && (
          <div className="flex items-center gap-3">
            <div className="flex-1">
              <Meter value={shownBytes} max={t.totalBytes} status={BADGE[t.state]} />
            </div>
            <Mono className="w-9 text-right">{pct}%</Mono>
          </div>
        )}
        <p className="mt-1 truncate text-xs text-[var(--color-ink-secondary)]" title={detail(t, rate)}>
          {detail(t, rate)}
        </p>
        {error && (
          <p className="mt-1 text-xs text-[var(--color-critical)]" role="alert">
            {error}
          </p>
        )}
        {relayHint(t) && (
          <p className="mt-1 text-xs text-[var(--color-ink-muted)]" data-testid="relay-hint">
            {relayHint(t)}
          </p>
        )}
      </div>

      <div className="col-start-3 row-start-1 flex items-center gap-2 md:col-start-4">
        <StatusBadge status={badgeFor(t)} />
        {running && <IconButton icon={Pause} label="Pause" onClick={act(() => window.connect.pause(t.transferId))} />}
        {t.resumable && <IconButton icon={Play} label="Resume" onClick={act(() => window.connect.resume(t.transferId))} />}
        {outgoing && t.state === "offered" && <IconButton icon={X} label="Cancel" onClick={act(() => window.connect.cancelOffer(t.transferId))} />}
        {!outgoing && t.state === "complete" && <IconButton icon={FolderOpen} label="Open received files" onClick={() => window.connect.openDownloads()} />}
        {!running && t.state !== "offered" && <IconButton icon={Trash2} label="Remove" onClick={act(remove)} />}
      </div>
    </li>
  );
}
