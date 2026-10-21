import { useState } from "react";
import { Download } from "lucide-react";
import { Button, Mono, SectionLabel } from "@peerpayload/ui";

import { errorMessage, sizeLabel, transferTitle } from "../lib/util";

// An incoming offer: who, what, how big, and the choice. Shown above
// every page so it can't be missed.
export default function OfferBanner({ offer, onAccepted }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function answer(accept) {
    setBusy(true);
    setError(null);

    try {
      if (accept) {
        // Resolves when the transfer ends; state changes arrive as events.
        window.connect.accept(offer.transferId).catch((err) => setError(errorMessage(err)));
        onAccepted?.();
      } else {
        await window.connect.decline(offer.transferId);
      }
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <section
      aria-label={`Offer from ${offer.peerName}`}
      className="flex flex-wrap items-center gap-4 border-b border-[var(--color-border)] border-l-2 border-l-[var(--color-accent)] bg-[var(--color-surface)] px-6 py-3"
    >
      <Download size={18} strokeWidth={1.75} className="shrink-0 text-[var(--color-ink-secondary)]" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <SectionLabel>Incoming transfer</SectionLabel>
        <p className="mt-0.5 truncate text-sm">
          <span className="font-medium">{offer.peerName}</span> wants to send you{" "}
          <span className="font-medium">“{transferTitle(offer)}”</span> <Mono className="text-[var(--color-ink-secondary)]">({sizeLabel(offer.totalBytes)})</Mono>
        </p>
        {offer.files?.length > 1 && <p className="truncate text-xs text-[var(--color-ink-secondary)]">{offer.files.map((f) => f.name).join(", ")}</p>}
        {error && (
          <p className="text-xs text-[var(--color-critical)]" role="alert">
            {error}
          </p>
        )}
      </div>
      <div className="flex gap-2">
        <Button variant="secondary" size="sm" onClick={() => answer(false)} disabled={busy}>
          Decline
        </Button>
        <Button variant="primary" size="sm" onClick={() => answer(true)} disabled={busy}>
          Accept
        </Button>
      </div>
    </section>
  );
}
