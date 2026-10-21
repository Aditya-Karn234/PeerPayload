import { useEffect, useMemo, useRef, useState } from "react";
import { createProgressTracker } from "@peerpayload/ui";

// Everything the signed-in screens share: history and directory polling,
// incoming offers (push + poll), the send in progress, the receive in
// progress, auto-accept, and the server connection. Moved unchanged from
// the old single-page Dashboard (the offer bookkeeping in particular is
// subtle; see the comments), plus byte progress from engine events.

const POLL_MS = 3000;
const DIRECTORY_POLL_MS = 5000;

export default function useDashboard(user, onLogout) {
  const [transfers, setTransfers] = useState([]);
  const [directory, setDirectory] = useState([]);
  const [autoAccept, setAutoAccept] = useState(false);
  const [connected, setConnected] = useState(null); // null = not known yet

  const [sendError, setSendError] = useState(null);
  const [sendState, setSendState] = useState(null); // { phase, event }
  // Who the current/last send went to: kept here (not in the Transfer
  // screen) so it survives switching screens.
  const [sentTo, setSentTo] = useState("");

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

  // Bytes done per transfer running on this machine, from engine events.
  const trackers = useRef(new Map()); // transferId -> tracker
  const [progress, setProgress] = useState({}); // transferId -> { bytes, total }

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

  // The socket connection to the server: asked once (it may already be up)
  // and then followed.
  useEffect(() => {
    window.peerpayload.connectionStatus().then((s) => setConnected((prev) => prev ?? s.connected));

    return window.peerpayload.onConnection((s) => setConnected(s.connected));
  }, []);

  useEffect(
    () =>
      window.peerpayload.onIncomingTransfer((transfer) => {
        setPushedOffers((prev) => ({ ...prev, [transfer.id]: transfer }));
      }),
    [],
  );

  // Byte progress: every engine event for any transfer feeds its tracker.
  useEffect(
    () =>
      window.peerpayload.onProgress((p) => {
        if (!p.transferId || !p.event)
          return;

        let tracker = trackers.current.get(p.transferId);

        if (!tracker) {
          tracker = createProgressTracker();
          trackers.current.set(p.transferId, tracker);
        }

        const next = tracker(p.event);

        if (next)
          setProgress((prev) => ({ ...prev, [p.transferId]: next }));
      }),
    [],
  );

  useEffect(
    () =>
      window.peerpayload.onProgress((progressEvent) => {
        // Auto-accept starts a receive from the main process without going
        // through respondToOffer, so recognise it by the offer it belongs to.
        const offer = !activeReceive ? offersRef.current.find((o) => o.id === progressEvent.transferId) : null;

        if (offer) {
          setAnswered((prev) => new Set(prev).add(offer.id));
          setActiveReceive(offer);
          setReceiveState(progressEvent);
          return;
        }

        if (activeReceive && progressEvent.transferId === activeReceive.id) {
          setReceiveState(progressEvent);

          if (progressEvent.phase === "done") {
            setActiveReceive(null);
            dismissOffer(progressEvent.transferId);
          }

          return;
        }

        // Ignore progress from a different transfer than the one this send
        // is tracking. The initial "starting" state has no transferId yet, so
        // it must accept the first event — comparing against undefined used
        // to reject every event and leave the UI stuck on "Starting…".
        setSendState((prev) => (prev?.transferId && prev.transferId !== progressEvent.transferId ? prev : progressEvent));
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

  async function send(filePath, toUsername, chunkSize) {
    setSentTo(toUsername);
    setSendError(null);
    setSendState({ phase: "starting" });

    try {
      await window.peerpayload.send(filePath, toUsername, chunkSize || undefined);
      return true;
    } catch (err) {
      setSendError(err.message);
      setSendState(null);
      return false;
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

  async function toggleAutoAccept() {
    const next = !autoAccept;

    await window.peerpayload.setAutoAccept(next);
    setAutoAccept(next);
  }

  async function logout() {
    await window.peerpayload.logout();
    onLogout();
  }

  return {
    transfers,
    directory,
    connected,
    autoAccept,
    toggleAutoAccept,
    offers,
    activeReceive,
    receiveState,
    respondingTo,
    respondToOffer,
    sendState,
    sentTo,
    sendError,
    send,
    progress,
    logout,
  };
}
