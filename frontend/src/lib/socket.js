import { io } from "socket.io-client";
import { useEffect, useRef } from "react";

// One shared connection for the whole app; dev requests hit the same origin
// (5173) and vite.config.js proxies /socket.io through to the backend (4000)
// with ws:true, so no CORS/URL wiring is needed in dev. A deployed build can
// point elsewhere via VITE_BACKEND_URL.
let sharedSocket = null;

function getSocket() {
  if (!sharedSocket)
    sharedSocket = io(import.meta.env.VITE_BACKEND_URL || undefined);

  return sharedSocket;
}

// Subscribes to a transfer's room for as long as the calling component is
// mounted with a given transferId; re-subscribes if the id changes.
export function useTransferSocket(transferId, { onEvent, onLog } = {}) {
  const onEventRef = useRef(onEvent);
  const onLogRef = useRef(onLog);

  onEventRef.current = onEvent;
  onLogRef.current = onLog;

  useEffect(() => {
    if (!transferId)
      return undefined;

    const socket = getSocket();

    socket.emit("join", transferId);

    function handleEvent(event) {
      onEventRef.current?.(event);
    }

    function handleLog(log) {
      onLogRef.current?.(log);
    }

    socket.on("transfer-event", handleEvent);
    socket.on("transfer-log", handleLog);

    return () => {
      socket.off("transfer-event", handleEvent);
      socket.off("transfer-log", handleLog);
      socket.emit("leave", transferId);
    };
  }, [transferId]);
}
