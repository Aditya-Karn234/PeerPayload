import { useEffect, useMemo, useRef, useState } from "react";

import { StatTile, StatusBadge, ThemeToggle, TransferTable, Meter, formatBytes } from "@peerpayload/ui";

const POLL_MS = 3000;
const DIRECTORY_POLL_MS = 5000;
const ACTIVE_STATUSES = new Set(["pending", "accepted", "in_progress"]);

const CHUNK_SIZE_OPTIONS = [
  { label: "Default (64 KiB)", value: "" },
  { label: "256 KiB", value: 256 * 1024 },
  { label: "1 MiB", value: 1024 * 1024 },
  { label: "4 MiB", value: 4 * 1024 * 1024 },
  { label: "8 MiB (fastest, max)", value: 8 * 1024 * 1024 },
];

export default function Dashboard({ user, onLogout }) {
  const [transfers, setTransfers] = useState([]);
  const [directory, setDirectory] = useState([]);
  const [autoAccept, setAutoAccept] = useState(false);

  const [filePath, setFilePath] = useState("");
  const [toUsername, setToUsername] = useState("");
  const [chunkSize, setChunkSize] = useState("");
  const [sendError, setSendError] = useState(null);
  const [sendState, setSendState] = useState(null); // { phase, event }

  // Offers arrive by push, but a push sent while disconnected is lost, so
  // pending transfers addressed to this user in the polled list count too.
  const [pushedOffers, setPushedOffers] = useState({}); // id -> transfer
  const [activeReceive, setActiveReceive] = useState(null); // the offer being received
  // Offers already answered here (accepted, declined, finished). The polled
  // list can lag by one interval and still show them as "pending"; without
  // this they'd flash back up with live Accept/Decline buttons.
  const [answered, setAnswered] = useState(() => new Set());
  const [receiveState, setReceiveState] = useState(null);
  const [respondingTo, setRespondingTo] = useState(null);

  // History + directory both poll — presence and other people's transfers
  // can change without this window doing anything, same reasoning the web
  // dashboard's polling already used.
  useEffect(() => {
    let cancelled = false;

    async function poll() {
      try {
        const data = await window.peerpayload.listTransfers();

        if (!cancelled)
          setTransfers(data);
      } catch {
        // Transient poll failure — the next tick retries.
      }
    }

    poll();

    const id = setInterval(poll, POLL_MS);

    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      try {
        const data = await window.peerpayload.listDirectory();

        if (!cancelled)
          setDirectory(data.filter((u) => u.username !== user.username));
      } catch {
        // Transient poll failure.
      }
    }

    poll();

    const id = setInterval(poll, DIRECTORY_POLL_MS);

    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [user.username]);

  useEffect(() => {
    window.peerpayload.getAutoAccept().then(setAutoAccept);
  }, []);

  useEffect(
    () =>
      window.peerpayload.onIncomingTransfer((transfer) => {
        setPushedOffers((prev) => ({ ...prev, [transfer.id]: transfer }));
      }),
    [],
  );

  useEffect(
    () =>
      window.peerpayload.onProgress((progress) => {
        // Auto-accept starts a receive from the main process without going
        // through respondToOffer, so recognise it by the offer it belongs to.
        const offer = !activeReceive ? offersRef.current.find((o) => o.id === progress.transferId) : null;

        if (offer) {
          setAnswered((prev) => new Set(prev).add(offer.id));
          setActiveReceive(offer);
          setReceiveState(progress);
          return;
        }

        if (activeReceive && progress.transferId === activeReceive.id) {
          setReceiveState(progress);

          if (progress.phase === "done") {
            setActiveReceive(null);
            dismissOffer(progress.transferId);
          }

          return;
        }

        // Ignore progress from a different transfer than the one this send
        // is tracking. The initial "starting" state has no transferId yet, so
        // it must accept the first event — comparing against undefined used
        // to reject every event and leave the UI stuck on "Starting…".
        setSendState((prev) => (prev?.transferId && prev.transferId !== progress.transferId ? prev : progress));
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeReceive],
  );

  const offers = useMemo(() => {
    const byId = new Map();
    const polledStatus = new Map(transfers.map((t) => [t.id, t.status]));

    for (const t of transfers)
      if (t.status === "pending" && t.receiverUsername === user.username && !answered.has(t.id))
        byId.set(t.id, t);

    // A pushed offer may not be in the last poll yet; drop it once a poll
    // shows it's no longer pending (declined, cancelled, sender gave up).
    for (const t of Object.values(pushedOffers)) {
      const status = polledStatus.get(t.id);

      if ((!status || status === "pending") && !answered.has(t.id))
        byId.set(t.id, t);
    }

    if (activeReceive)
      byId.set(activeReceive.id, activeReceive);

    return [...byId.values()];
  }, [transfers, pushedOffers, activeReceive, answered, user.username]);

  const offersRef = useRef(offers);

  offersRef.current = offers;

  function dismissOffer(id) {
    setAnswered((prev) => new Set(prev).add(id));
    setPushedOffers((prev) => {
      const next = { ...prev };

      delete next[id];
      return next;
    });
  }

  const active = useMemo(() => transfers.filter((t) => ACTIVE_STATUSES.has(t.status)).length, [transfers]);
  const complete = useMemo(() => transfers.filter((t) => t.status === "complete").length, [transfers]);
  const unsuccessful = useMemo(
    () => transfers.filter((t) => ["failed", "rejected", "not_reachable", "timed_out", "cancelled"].includes(t.status)).length,
    [transfers],
  );

  async function handlePickFile(mode) {
    const path = await window.peerpayload.pickFile(mode);

    if (path)
      setFilePath(path);
  }

  async function handleSend(e) {
    e.preventDefault();
    setSendError(null);
    setSendState({ phase: "starting" });

    try {
      await window.peerpayload.send(filePath, toUsername, chunkSize || undefined);
      setFilePath("");
      setToUsername("");
    } catch (err) {
      setSendError(err.message);
      setSendState(null);
    }
  }

  async function respondToOffer(offer, accept) {
    setRespondingTo(offer.id);
    setAnswered((prev) => new Set(prev).add(offer.id));

    try {
      if (accept) {
        setActiveReceive(offer);
        setReceiveState(null);
        await window.peerpayload.acceptIncoming(offer.id);
      } else {
        await window.peerpayload.rejectIncoming(offer.id);
        dismissOffer(offer.id);
      }
    } catch (err) {
      // Didn't go through: let the offer come back so it can be retried.
      setAnswered((prev) => {
        const next = new Set(prev);

        next.delete(offer.id);
        return next;
      });

      if (accept) {
        setActiveReceive(null);
        setReceiveState({ phase: "done", ok: false, transferId: offer.id, finalEvent: { reason: err.message } });
      }
    } finally {
      setRespondingTo(null);
    }
  }

  async function handleToggleAutoAccept() {
    const next = !autoAccept;

    await window.peerpayload.setAutoAccept(next);
    setAutoAccept(next);
  }

  async function handleLogout() {
    await window.peerpayload.logout();
    onLogout();
  }

  return (
    <div className="mx-auto max-w-4xl px-4 py-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold">PeerPayload</h1>
          <p className="text-xs" style={{ color: "var(--color-ink-muted)" }}>
            Signed in as {user.username}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <ThemeToggle />
          <button
            type="button"
            onClick={handleLogout}
            className="rounded-md border px-3 py-1.5 text-xs"
            style={{ borderColor: "var(--color-border)", color: "var(--color-ink-secondary)" }}
          >
            Sign out
          </button>
        </div>
      </div>

      {offers.map((incoming) => (
        <div
          key={incoming.id}
          className="mt-4 rounded-lg border p-4"
          style={{ borderColor: "var(--color-accent)", background: "var(--color-surface)" }}
        >
          <p className="text-sm font-medium">
            {incoming.senderUsername} wants to send you {incoming.fileCount || "a"} file
            {incoming.fileCount === 1 ? "" : "s"}
            {incoming.totalBytes ? ` (${formatBytes(incoming.totalBytes)})` : ""}
          </p>
          {activeReceive?.id === incoming.id && receiveState ? (
            <p className="mt-2 text-xs" style={{ color: "var(--color-ink-muted)" }}>
              {receiveState.phase === "starting-receiver" && "Starting receiver…"}
              {receiveState.phase === "accepted" && "Accepted — waiting for sender to connect…"}
              {receiveState.phase === "receiving" &&
                (receiveState.event?.event === "session_failed"
                  ? `Connection lost (${receiveState.event.reason}) — waiting for the sender to resume…`
                  : "Receiving…")}
              {receiveState.phase === "done" && (receiveState.ok ? "Complete." : `Failed: ${receiveState.finalEvent?.reason}`)}
            </p>
          ) : (
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                onClick={() => respondToOffer(incoming, true)}
                disabled={respondingTo === incoming.id || Boolean(activeReceive)}
                className="rounded-md px-3 py-1.5 text-sm font-medium text-white disabled:opacity-60"
                style={{ background: "var(--color-accent)" }}
              >
                Accept
              </button>
              <button
                type="button"
                onClick={() => respondToOffer(incoming, false)}
                disabled={respondingTo === incoming.id || activeReceive?.id === incoming.id}
                className="rounded-md border px-3 py-1.5 text-sm disabled:opacity-60"
                style={{ borderColor: "var(--color-critical)", color: "var(--color-critical)" }}
              >
                Decline
              </button>
            </div>
          )}
        </div>
      ))}

      {receiveState?.phase === "done" && !activeReceive && (
        <p className="mt-2 text-xs" style={{ color: receiveState.ok ? "var(--color-good)" : "var(--color-critical)" }}>
          {receiveState.ok ? "Last transfer received." : `Last receive failed: ${receiveState.finalEvent?.reason}`}
        </p>
      )}

      <div className="mt-6 grid gap-3 sm:grid-cols-3">
        <StatTile label="Active transfers" value={active} accent="var(--color-accent)" />
        <StatTile label="Completed" value={complete} accent="var(--color-good)" />
        <StatTile label="Failed / declined" value={unsuccessful} accent="var(--color-critical)" />
      </div>

      <form
        onSubmit={handleSend}
        className="mt-6 rounded-lg border p-4"
        style={{ borderColor: "var(--color-border)", background: "var(--color-surface)" }}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">Send a file</h2>
          <label className="flex items-center gap-1.5 text-xs" style={{ color: "var(--color-ink-secondary)" }}>
            <input type="checkbox" checked={autoAccept} onChange={handleToggleAutoAccept} />
            Auto-accept incoming transfers
          </label>
        </div>

        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <label className="block text-sm">
            <span className="mb-1 block" style={{ color: "var(--color-ink-secondary)" }}>File or folder</span>
            <div className="flex gap-2">
              <input
                value={filePath}
                readOnly
                placeholder="Nothing selected"
                className="w-full rounded-md border bg-transparent px-3 py-2 text-sm outline-none"
                style={{ borderColor: "var(--color-border)" }}
              />
              <button
                type="button"
                onClick={() => handlePickFile("file")}
                className="shrink-0 rounded-md border px-3 py-2 text-sm"
                style={{ borderColor: "var(--color-border)" }}
              >
                File…
              </button>
              <button
                type="button"
                onClick={() => handlePickFile("folder")}
                className="shrink-0 rounded-md border px-3 py-2 text-sm"
                style={{ borderColor: "var(--color-border)" }}
              >
                Folder…
              </button>
            </div>
          </label>

          <label className="block text-sm">
            <span className="mb-1 block" style={{ color: "var(--color-ink-secondary)" }}>To</span>
            <select
              value={toUsername}
              onChange={(e) => setToUsername(e.target.value)}
              className="w-full rounded-md border bg-transparent px-3 py-2 text-sm outline-none"
              style={{ borderColor: "var(--color-border)" }}
              required
            >
              <option value="" disabled>Pick a colleague…</option>
              {directory.map((u) => (
                <option key={u.username} value={u.username} disabled={!u.online}>
                  {u.username} {u.online ? "" : "(offline)"}
                </option>
              ))}
            </select>
          </label>

          <label className="block text-sm sm:col-span-2">
            <span className="mb-1 block" style={{ color: "var(--color-ink-secondary)" }}>Chunk size</span>
            <select
              value={chunkSize}
              onChange={(e) => setChunkSize(e.target.value)}
              className="w-full rounded-md border bg-transparent px-3 py-2 text-sm outline-none sm:w-64"
              style={{ borderColor: "var(--color-border)" }}
            >
              {CHUNK_SIZE_OPTIONS.map((opt) => (
                <option key={opt.label} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </label>
        </div>

        {sendError && (
          <p className="mt-3 text-sm" style={{ color: "var(--color-critical)" }}>{sendError}</p>
        )}

        {sendState && (
          <div className="mt-3">
            <p className="text-xs" style={{ color: "var(--color-ink-muted)" }}>
              {sendState.phase === "starting" && "Starting…"}
              {sendState.phase === "waiting-for-acceptance" && "Waiting for recipient to accept…"}
              {sendState.phase === "sending" && (sendState.path === "relay" ? "Sending via relay…" : "Sending…")}
              {sendState.phase === "retrying" &&
                `Connection lost (${sendState.reason}) — resuming in ${Math.round(sendState.delayMs / 1000)}s (attempt ${sendState.attempt + 1})…`}
              {sendState.phase === "done" &&
                (sendState.ok ? (sendState.path === "relay" ? "Complete (via relay)." : "Complete.") : `Failed: ${sendState.finalEvent?.reason}`)}
            </p>
            {sendState.phase === "sending" && (
              <div className="mt-1 w-64">
                <Meter value={1} max={1} status="in_progress" />
              </div>
            )}
          </div>
        )}

        <button
          type="submit"
          disabled={!filePath || !toUsername || (sendState && sendState.phase !== "done")}
          className="mt-4 rounded-md px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
          style={{ background: "var(--color-accent)" }}
        >
          Send
        </button>
      </form>

      <div className="mt-6">
        <TransferTable transfers={transfers} myUsername={user.username} />
      </div>
    </div>
  );
}
