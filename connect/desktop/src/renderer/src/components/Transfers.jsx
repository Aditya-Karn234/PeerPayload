import { useState } from "react";
import { Meter, StatusBadge, formatBytes } from "@peerpayload/ui";

import { Button, Card, ErrorText, Muted, errorMessage } from "./ui.jsx";

// Connect transfer states (connect-core transfers.js) -> the shared
// StatusBadge / Meter statuses.
const BADGE = {
  offered: "pending",
  sending: "in_progress",
  receiving: "in_progress",
  complete: "complete",
  failed: "failed",
  cancelled: "cancelled",
  declined: "rejected",
  timed_out: "timed_out",
};

const describeItems = (t) => {
  const what = t.files?.length === 1 ? `“${t.files[0].name}”` : `${t.fileCount} file${t.fileCount === 1 ? "" : "s"}`;

  return `${what} (${formatBytes(t.totalBytes)})`;
};

export function IncomingOffers({ offers, onAnswered }) {
  return offers.map((offer) => <OfferCard key={offer.transferId} offer={offer} onAnswered={onAnswered} />);
}

function OfferCard({ offer, onAnswered }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function answer(accept) {
    setBusy(true);
    setError(null);

    try {
      if (accept) {
        // Resolves when the transfer ends; the state changes arrive as events.
        window.connect.accept(offer.transferId).catch((err) => setError(errorMessage(err)));
        onAnswered();
      } else {
        await window.connect.decline(offer.transferId);
      }
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <Card className="mt-4" style={{ borderColor: "var(--color-accent)" }} aria-label={`Offer from ${offer.peerName}`}>
      <p className="text-sm font-medium">
        {offer.peerName} wants to send you {describeItems(offer)}
      </p>
      {offer.files?.length > 1 && <Muted className="mt-1">{offer.files.map((f) => f.name).join(", ")}</Muted>}
      <div className="mt-3 flex gap-2">
        <Button variant="primary" onClick={() => answer(true)} disabled={busy}>
          Accept
        </Button>
        <Button onClick={() => answer(false)} disabled={busy}>
          Decline
        </Button>
      </div>
      <ErrorText>{error}</ErrorText>
    </Card>
  );
}

export default function Transfers({ transfers }) {
  if (!transfers.length)
    return <Muted>No transfers yet. Send something from a contact, or accept an offer when one arrives.</Muted>;

  return (
    <div>
      <div className="flex justify-end">
        <Button variant="quiet" onClick={() => window.connect.openDownloads()}>
          Open received files
        </Button>
      </div>
      <ul className="mt-2 grid gap-2" aria-label="Transfers">
        {transfers.map((t) => (
          <TransferRow key={t.transferId} transfer={t} />
        ))}
      </ul>
    </div>
  );
}

function TransferRow({ transfer: t }) {
  const outgoing = t.direction === "out";
  const done = t.state === "complete" ? t.totalBytes : (t.progress?.bytes ?? 0);

  return (
    <li className="rounded-lg border p-3" style={{ borderColor: "var(--color-border)", background: "var(--color-surface)" }} data-testid={`transfer-${t.direction}`} data-state={t.state}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm">
          {outgoing ? `To ${t.peerName}` : `From ${t.peerName}`}: {describeItems(t)}
        </p>
        <StatusBadge status={BADGE[t.state] ?? "pending"} />
      </div>
      {["sending", "receiving", "complete", "failed"].includes(t.state) && (
        <div className="mt-2">
          <Meter value={done} max={t.totalBytes} status={BADGE[t.state]} />
        </div>
      )}
      <Muted className="mt-1">{detail(t)}</Muted>
      {outgoing && t.state === "offered" && (
        <Button variant="quiet" className="mt-1" onClick={() => window.connect.cancelOffer(t.transferId)}>
          Cancel
        </Button>
      )}
    </li>
  );
}

function detail(t) {
  switch (t.state) {
    case "offered":
      return t.direction === "out" ? `Waiting for ${t.peerName} to accept…` : "Waiting for your answer";
    case "sending":
    case "receiving": {
      const via = t.path === "relay" ? " via relay" : t.path === "direct" ? " directly" : "";
      const retry = t.retry ? ` · reconnecting (attempt ${t.retry.attempt + 1})` : "";

      return `${formatBytes(t.progress?.bytes ?? 0)} of ${formatBytes(t.totalBytes)}${via}${retry}`;
    }
    case "complete":
      return t.direction === "in" ? `Saved to ${t.downloadDir}` : `Delivered${t.path === "relay" ? " via relay" : ""}`;
    case "declined":
      return t.direction === "out" ? `${t.peerName} declined` : "You declined";
    case "cancelled":
      return t.error ?? "Cancelled";
    case "timed_out":
      return `${t.peerName} didn't answer`;
    default:
      return t.error ? `Failed: ${t.error}` : "";
  }
}
