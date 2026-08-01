import { useEffect, useState } from "react";

import { listTransfers } from "../lib/api";
import StatTile from "../components/StatTile";
import NewTransferForm from "../components/NewTransferForm";
import TransferTable from "../components/TransferTable";

const POLL_MS = 3000;

export default function Dashboard() {
  const [transfers, setTransfers] = useState([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      try {
        const data = await listTransfers();

        if (!cancelled) {
          setTransfers(data);
          setLoaded(true);
        }
      } catch {
        // A transient poll failure isn't worth surfacing; the next tick retries.
      }
    }

    poll();

    const id = setInterval(poll, POLL_MS);

    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const active = transfers.filter(
    (t) => t.status === "pending" || t.status === "listening" || t.status === "in_progress",
  ).length;
  const complete = transfers.filter((t) => t.status === "complete").length;
  const unsuccessful = transfers.filter((t) => t.status === "failed" || t.status === "cancelled").length;

  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      <div className="grid gap-3 sm:grid-cols-3">
        <StatTile label="Active transfers" value={active} accent="var(--color-accent)" />
        <StatTile label="Completed" value={complete} accent="var(--color-good)" />
        <StatTile label="Failed / cancelled" value={unsuccessful} accent="var(--color-critical)" />
      </div>

      <div className="mt-6">
        <NewTransferForm />
      </div>

      <div className="mt-6">
        {loaded ? (
          <TransferTable transfers={transfers} />
        ) : (
          <p className="text-sm" style={{ color: "var(--color-ink-muted)" }}>
            Loading…
          </p>
        )}
      </div>
    </div>
  );
}
