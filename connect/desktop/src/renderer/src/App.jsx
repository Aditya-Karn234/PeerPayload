import { useCallback, useEffect, useState } from "react";
import { ThemeToggle } from "@peerpayload/ui";

import Setup from "./components/Setup.jsx";
import Contacts from "./components/Contacts.jsx";
import Transfers, { IncomingOffers } from "./components/Transfers.jsx";
import Settings from "./components/Settings.jsx";
import { Button } from "./components/ui.jsx";

const TABS = ["Contacts", "Transfers", "Settings"];

// One window, three tabs. Everything shown comes from the main process:
// fetched once on load, then kept current by its events.
export default function App() {
  const [status, setStatus] = useState(null);
  const [contacts, setContacts] = useState([]);
  const [transfers, setTransfers] = useState(new Map());
  const [tab, setTab] = useState("Contacts");
  const [notice, setNotice] = useState(null);

  const refresh = useCallback(async () => {
    const next = await window.connect.status();

    setStatus(next);

    if (next.hasIdentity) {
      setContacts(await window.connect.contacts());
      setTransfers(new Map((await window.connect.transfers()).map((t) => [t.transferId, t])));
    }
  }, []);

  useEffect(() => {
    refresh();

    return window.connect.onEvent(({ name, data }) => {
      if (name === "status")
        setStatus((prev) => ({ ...prev, ...data }));
      else if (name === "contacts")
        setContacts(data);
      else if (name === "paired")
        setNotice(`You and ${data.name} are now paired.`);
      else if (name === "transfer")
        setTransfers((prev) => new Map(prev).set(data.transferId, data));
    });
  }, [refresh]);

  if (!status)
    return <Centered>Loading…</Centered>;

  if (!status.hasIdentity)
    return <Setup onDone={refresh} />;

  const transferList = [...transfers.values()].sort((a, b) => b.createdAt - a.createdAt);
  const offers = transferList.filter((t) => t.direction === "in" && t.state === "offered");

  return (
    <div className="mx-auto max-w-4xl px-4 py-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">PeerPayload Connect</h1>
          <p className="text-xs" style={{ color: "var(--color-ink-muted)" }}>
            {status.name} · device {status.fingerprint.slice(0, 8)}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <ConnectionDot status={status} />
          <ThemeToggle />
        </div>
      </header>

      {notice && (
        <div className="mt-4 flex items-center justify-between rounded-lg border p-3 text-sm" style={{ borderColor: "var(--color-good)" }} role="status">
          <span>{notice}</span>
          <Button variant="quiet" onClick={() => setNotice(null)}>Dismiss</Button>
        </div>
      )}

      <IncomingOffers offers={offers} onAnswered={() => setTab("Transfers")} />

      <nav className="mt-6 flex gap-1 border-b" style={{ borderColor: "var(--color-border)" }} aria-label="Sections">
        {TABS.map((name) => (
          <button
            key={name}
            type="button"
            onClick={() => setTab(name)}
            aria-current={tab === name ? "page" : undefined}
            className="-mb-px border-b-2 px-3 py-2 text-sm"
            style={{
              borderColor: tab === name ? "var(--color-accent)" : "transparent",
              color: tab === name ? "var(--color-ink)" : "var(--color-ink-secondary)",
            }}
          >
            {name}
            {name === "Transfers" && offers.length > 0 && ` (${offers.length})`}
          </button>
        ))}
      </nav>

      <main className="mt-6">
        {tab === "Contacts" && <Contacts contacts={contacts} status={status} onSent={() => setTab("Transfers")} />}
        {tab === "Transfers" && <Transfers transfers={transferList} />}
        {tab === "Settings" && <Settings status={status} onSaved={refresh} />}
      </main>
    </div>
  );
}

function ConnectionDot({ status }) {
  const { label, color } = !status.mailboxUrl
    ? { label: "No mailbox set", color: "var(--color-warning)" }
    : status.connected
      ? { label: "Connected", color: "var(--color-good)" }
      : { label: "Connecting…", color: "var(--color-ink-muted)" };

  return (
    <span className="inline-flex items-center gap-1.5 text-xs" style={{ color: "var(--color-ink-secondary)" }} data-testid="connection">
      <span className="inline-block h-2 w-2 rounded-full" style={{ background: color }} aria-hidden="true" />
      {label}
    </span>
  );
}

function Centered({ children }) {
  return (
    <div className="flex h-screen items-center justify-center text-sm" style={{ color: "var(--color-ink-muted)" }}>
      {children}
    </div>
  );
}
