import { useCallback, useEffect, useState } from "react";
import { X } from "lucide-react";

import Sidebar from "./components/Sidebar.jsx";
import OfferBanner from "./components/OfferBanner.jsx";
import Setup from "./pages/Setup.jsx";
import TransferPage from "./pages/TransferPage.jsx";
import DevicesPage from "./pages/DevicesPage.jsx";
import HistoryPage from "./pages/HistoryPage.jsx";
import SettingsPage from "./pages/SettingsPage.jsx";
import { useRates } from "@peerpayload/ui";

// The window: sidebar + one page. Everything shown comes from the main
// process, fetched on load and then kept current by its events.
export default function App() {
  const [status, setStatus] = useState(null);
  const [contacts, setContacts] = useState([]);
  const [transfers, setTransfers] = useState(new Map());
  const [page, setPage] = useState("transfer");
  const [settingsSection, setSettingsSection] = useState("general");
  const [historyTab, setHistoryTab] = useState("active");
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

  // Clearing removes records without per-record events: reload the list.
  const clearFinished = useCallback(async () => {
    await window.connect.clearFinished();
    setTransfers(new Map((await window.connect.transfers()).map((t) => [t.transferId, t])));
  }, []);

  // A notice clears itself after a while; it can also be dismissed.
  useEffect(() => {
    if (!notice)
      return undefined;

    const timer = setTimeout(() => setNotice(null), 10000);

    return () => clearTimeout(timer);
  }, [notice]);

  const transferList = [...transfers.values()].sort((a, b) => b.createdAt - a.createdAt);
  const rates = useRates(
    transferList.map((t) => ({ id: t.transferId, running: t.state === "sending" || t.state === "receiving", bytes: t.progress?.bytes, total: t.totalBytes })),
  );

  if (!status)
    return <div className="flex h-screen items-center justify-center text-sm text-[var(--color-ink-muted)]">Loading…</div>;

  if (!status.hasIdentity)
    return <Setup onDone={refresh} />;

  const offers = transferList.filter((t) => t.direction === "in" && t.state === "offered");
  const go = (to, section) => {
    if (section)
      setSettingsSection(section);

    setPage(to);
  };

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar page={page} onNavigate={go} status={status} badges={{ history: offers.length || 0 }} />

      <div className="flex min-w-0 flex-1 flex-col">
        {notice && (
          <div className="flex items-center gap-3 border-b border-[var(--color-border)] bg-[var(--color-surface)] px-6 py-2.5 text-sm" role="status">
            <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-[var(--color-good)]">Paired</span>
            <span className="flex-1">{notice}</span>
            <button type="button" onClick={() => setNotice(null)} aria-label="Dismiss" className="text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]">
              <X size={16} aria-hidden="true" />
            </button>
          </div>
        )}
        {offers.map((offer) => (
          <OfferBanner
            key={offer.transferId}
            offer={offer}
            onAccepted={() => {
              setHistoryTab("active");
              setPage("history");
            }}
          />
        ))}

        <main className="min-h-0 flex-1 overflow-y-auto">
          {page === "transfer" && <TransferPage contacts={contacts} transfers={transferList} rates={rates} onNavigate={go} />}
          {page === "devices" && <DevicesPage contacts={contacts} transfers={transferList} status={status} onNavigate={go} />}
          {page === "history" && <HistoryPage transfers={transferList} rates={rates} tab={historyTab} onTab={setHistoryTab} onClearFinished={clearFinished} />}
          {page === "settings" && <SettingsPage status={status} section={settingsSection} onSection={setSettingsSection} onSaved={refresh} />}
        </main>
      </div>
    </div>
  );
}
