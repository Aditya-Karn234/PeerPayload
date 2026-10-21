import { Download } from "lucide-react";
import { Button, Mono, SectionLabel } from "@peerpayload/ui";

import LiveTransfer from "./LiveTransfer.jsx";
import { plural, sizeLabel } from "../lib/util";

// An incoming offer: who, what, how big, and the choice. Once accepted it
// turns into the live receive, so the answer and its progress stay in one
// place. Shown above every page.
export default function OfferBanner({ offer, d }) {
  const receiving = d.activeReceive?.id === offer.id;

  return (
    <section
      aria-label={`Offer from ${offer.senderUsername}`}
      className="border-b border-[var(--color-border)] border-l-2 border-l-[var(--color-accent)] bg-[var(--color-surface)] px-6 py-3"
    >
      {receiving ? (
        <LiveTransfer direction="in" peer={offer.senderUsername} state={d.receiveState} progress={d.progress[offer.id]} testId="receive" />
      ) : (
        <div className="flex flex-wrap items-center gap-4">
          <Download size={18} strokeWidth={1.75} className="shrink-0 text-[var(--color-ink-secondary)]" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <SectionLabel>Incoming transfer</SectionLabel>
            <p className="mt-0.5 truncate text-sm">
              <span className="font-medium">{offer.senderUsername}</span> wants to send you {offer.fileCount ? plural(offer.fileCount, "file") : "files"}
              {offer.totalBytes ? <Mono className="text-[var(--color-ink-secondary)]"> ({sizeLabel(offer.totalBytes)})</Mono> : null}
            </p>
          </div>
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" onClick={() => d.respondToOffer(offer, false)} disabled={d.respondingTo === offer.id}>
              Decline
            </Button>
            <Button variant="primary" size="sm" onClick={() => d.respondToOffer(offer, true)} disabled={d.respondingTo === offer.id || Boolean(d.activeReceive)}>
              Accept
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
