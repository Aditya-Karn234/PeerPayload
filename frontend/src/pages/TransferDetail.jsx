import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";

import { getTransfer, cancelTransfer, getPublicIp } from "../lib/api";
import { useTransferSocket } from "../lib/socket";
import StatusBadge from "../components/StatusBadge";
import Meter from "../components/Meter";
import { formatBytes, formatRelativeTime } from "../lib/format";

const POLL_MS = 1000;
const MAX_LOG_LINES = 300;
const TERMINAL = new Set(["complete", "failed", "cancelled"]);

// Only the side the backend treats as canonical per event type — mirrors
// transferService.js's chunkSourceFor/sessionSourceFor — so the live log
// shows one line per real occurrence instead of a duplicate from each
// process. In "send"/"receive" mode only one side ever runs, so these just
// resolve to whichever source actually exists.
function isCanonical(event, mode = "local") {
  switch (event.event) {
    case "chunk_verified":
      return event.source === (mode === "send" ? "sender" : "receiver");
    case "chunk_mismatch":
      return event.source === "receiver";
    case "chunk_retry":
      return event.source === "sender";
    case "session_start":
    case "file_start":
    case "file_complete":
    case "transfer_complete":
      return event.source === (mode === "receive" ? "receiver" : "sender");
    default:
      return true;
  }
}

function describeEvent(event) {
  switch (event.event) {
    case "session_start":
      return `Session started — ${event.fileCount} file(s), ${formatBytes(event.totalBytes)}`;
    case "file_start":
      return `[${event.fileIndex}/${event.fileCount}] Starting ${event.relPath}${event.resumeChunk ? ` (resuming at chunk ${event.resumeChunk})` : ""}`;
    case "file_complete":
      return `[${event.fileIndex}/${event.fileCount}] Finished ${event.relPath} (${formatBytes(event.bytes)})`;
    case "chunk_verified":
      return `Chunk ${event.chunkId} verified — ${event.relPath} (${formatBytes(event.bytes)})`;
    case "chunk_retry":
      return `Retrying chunk ${event.chunkId} (attempt ${event.attempt}) — ${event.relPath}`;
    case "chunk_mismatch":
      return `Hash mismatch on chunk ${event.chunkId}, requesting resend — ${event.relPath}`;
    case "transfer_complete":
      return `Transfer complete — ${formatBytes(event.totalBytes)} in ${event.elapsedMs}ms`;
    case "transfer_failed":
      return `Transfer failed: ${event.reason}${event.relPath ? ` (${event.relPath})` : ""}`;
    case "listening":
      return `Receiver listening on port ${event.port}`;
    case "connection_accepted":
      return `Connection accepted from ${event.peer}`;
    case "connection_rejected":
      return `Connection rejected (${event.reason}) — still listening`;
    default:
      return event.event;
  }
}

function CopyRow({ label, value, placeholder, copied, onCopy }) {
  return (
    <div className="flex items-center justify-between gap-2 text-xs">
      <span style={{ color: "var(--color-ink-muted)" }}>{label}</span>
      <div className="flex items-center gap-2">
        <span className="font-mono tabular-nums" style={{ color: value ? "var(--color-ink)" : "var(--color-ink-muted)" }}>
          {value || placeholder}
        </span>
        {value && (
          <button
            type="button"
            onClick={onCopy}
            className="rounded border px-1.5 py-0.5"
            style={{ borderColor: "var(--color-border)", color: "var(--color-accent)" }}
          >
            {copied ? "Copied" : "Copy"}
          </button>
        )}
      </div>
    </div>
  );
}

export default function TransferDetail() {
  const { id } = useParams();
  const navigate = useNavigate();

  const [transfer, setTransfer] = useState(null);
  const [notFound, setNotFound] = useState(false);
  const [log, setLog] = useState([]);
  const [cancelling, setCancelling] = useState(false);
  const [publicIp, setPublicIp] = useState(null);
  const [publicIpError, setPublicIpError] = useState(false);
  const [copied, setCopied] = useState(null);
  const logEndRef = useRef(null);
  const nextLogKey = useRef(0);

  useEffect(() => {
    let cancelled = false;
    let intervalId;

    async function poll() {
      try {
        const data = await getTransfer(id);

        if (cancelled)
          return;

        setTransfer(data);

        if (TERMINAL.has(data.status))
          clearInterval(intervalId);
      } catch {
        if (!cancelled)
          setNotFound(true);
      }
    }

    poll();
    intervalId = setInterval(poll, POLL_MS);

    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }, [id]);

  // Only ever needed for "receive" mode's share panel, and only once — a
  // public IP doesn't change mid-session, no reason to refetch on every
  // 1s poll tick.
  useEffect(() => {
    if (transfer?.mode !== "receive" || publicIp || publicIpError)
      return;

    getPublicIp()
      .then((res) => setPublicIp(res.ip))
      .catch(() => setPublicIpError(true));
  }, [transfer?.mode, publicIp, publicIpError]);

  function copyToClipboard(label, value) {
    navigator.clipboard?.writeText(value).then(() => {
      setCopied(label);
      setTimeout(() => setCopied((c) => (c === label ? null : c)), 1500);
    });
  }

  useTransferSocket(id, {
    onEvent: (event) => {
      if (!isCanonical(event, transfer?.mode))
        return;

      setLog((prev) => {
        const next = [...prev, { ...event, key: nextLogKey.current++ }];

        return next.length > MAX_LOG_LINES ? next.slice(next.length - MAX_LOG_LINES) : next;
      });
    },
  });

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ block: "nearest" });
  }, [log]);

  async function handleCancel() {
    setCancelling(true);

    try {
      await cancelTransfer(id);
    } finally {
      setCancelling(false);
    }
  }

  if (notFound) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-8">
        <Link to="/" className="text-sm" style={{ color: "var(--color-accent)" }}>
          ← Back
        </Link>
        <p className="mt-4 text-sm" style={{ color: "var(--color-critical)" }}>
          Transfer not found.
        </p>
      </div>
    );
  }

  if (!transfer)
    return (
      <div className="mx-auto max-w-3xl px-4 py-8 text-sm" style={{ color: "var(--color-ink-muted)" }}>
        Loading…
      </div>
    );

  const cancellable =
    transfer.status === "pending" ||
    transfer.status === "listening" ||
    transfer.status === "in_progress";

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <button
        type="button"
        onClick={() => navigate("/")}
        className="text-sm"
        style={{ color: "var(--color-accent)" }}
      >
        ← Back
      </button>

      <div
        className="mt-4 rounded-lg border p-5"
        style={{ borderColor: "var(--color-border)", background: "var(--color-surface)" }}
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            {transfer.mode === "receive" ? (
              <>
                <h1 className="text-base font-semibold break-all">{transfer.destDir}</h1>
                <p className="mt-1 text-xs" style={{ color: "var(--color-ink-muted)" }}>
                  {transfer.status === "listening"
                    ? `← listening on port ${transfer.port}, waiting for a sender`
                    : `← received on port ${transfer.port}`}
                </p>
              </>
            ) : (
              <>
                <h1 className="text-base font-semibold break-all">{transfer.sourcePath}</h1>
                <p className="mt-1 text-xs" style={{ color: "var(--color-ink-muted)" }}>
                  {transfer.mode === "send" ? `→ ${transfer.host}:${transfer.port}` : `→ ${transfer.destDir}`}
                </p>
              </>
            )}
          </div>
          <StatusBadge status={transfer.status} />
        </div>

        {transfer.mode === "receive" && (
          <div
            className="mt-4 rounded-md border p-3"
            style={{ borderColor: "var(--color-border)", background: "var(--color-page)" }}
          >
            <p className="text-xs font-medium" style={{ color: "var(--color-ink-secondary)" }}>
              Share with the sender
            </p>
            <div className="mt-2 flex flex-col gap-1.5">
              <CopyRow
                label="IP"
                value={publicIpError ? null : publicIp}
                placeholder={
                  publicIpError ? "Couldn't auto-detect — check whatismyip.com" : "Detecting…"
                }
                copied={copied === "ip"}
                onCopy={() => publicIp && copyToClipboard("ip", publicIp)}
              />
              <CopyRow
                label="Port"
                value={transfer.port ? String(transfer.port) : null}
                placeholder="Assigning…"
                copied={copied === "port"}
                onCopy={() => transfer.port && copyToClipboard("port", String(transfer.port))}
              />
              <CopyRow
                label="Token"
                value={transfer.token}
                placeholder="None — this receiver accepts any sender"
                copied={copied === "token"}
                onCopy={() => transfer.token && copyToClipboard("token", transfer.token)}
              />
            </div>
            {!transfer.token && (
              <p className="mt-2 text-xs" style={{ color: "var(--color-warning)" }}>
                No access token — anyone who reaches this port can send data here.
              </p>
            )}
          </div>
        )}

        <div className="mt-4">
          <Meter value={Number(transfer.bytesDone)} max={Number(transfer.totalBytes || 0)} status={transfer.status} />
          <div className="mt-1.5 flex justify-between text-xs tabular-nums" style={{ color: "var(--color-ink-muted)" }}>
            <span>
              {formatBytes(transfer.bytesDone)}
              {transfer.totalBytes ? ` / ${formatBytes(transfer.totalBytes)}` : ""}
              {transfer.fileCount ? ` · ${transfer.fileCount} file(s)` : ""}
              {transfer.chunkSize ? ` · ${formatBytes(transfer.chunkSize)} chunks` : ""}
            </span>
            <span>{formatRelativeTime(transfer.createdAt)}</span>
          </div>
        </div>

        {transfer.failReason && (
          <p className="mt-3 text-sm" style={{ color: "var(--color-critical)" }}>
            {transfer.failReason}
            {transfer.failedPath ? ` — ${transfer.failedPath}` : ""}
          </p>
        )}

        {cancellable && (
          <button
            type="button"
            onClick={handleCancel}
            disabled={cancelling}
            className="mt-4 rounded-md border px-3 py-1.5 text-sm disabled:opacity-60"
            style={{ borderColor: "var(--color-critical)", color: "var(--color-critical)" }}
          >
            {cancelling ? "Cancelling…" : "Cancel transfer"}
          </button>
        )}
      </div>

      <div
        className="mt-6 rounded-lg border"
        style={{ borderColor: "var(--color-border)", background: "var(--color-surface)" }}
      >
        <div className="border-b px-4 py-3" style={{ borderColor: "var(--color-border)" }}>
          <h2 className="text-sm font-semibold">Live log</h2>
        </div>
        <div className="max-h-96 overflow-y-auto px-4 py-3 font-mono text-xs">
          {log.length === 0 ? (
            <p style={{ color: "var(--color-ink-muted)" }}>Waiting for events…</p>
          ) : (
            log.map((event) => (
              <div
                key={event.key}
                className="py-0.5"
                style={{
                  color:
                    event.event === "transfer_failed" || event.event === "chunk_mismatch"
                      ? "var(--color-critical)"
                      : event.event === "chunk_retry" || event.event === "connection_rejected"
                        ? "var(--color-warning)"
                        : "var(--color-ink-secondary)",
                }}
              >
                {describeEvent(event)}
              </div>
            ))
          )}
          <div ref={logEndRef} />
        </div>
      </div>
    </div>
  );
}
