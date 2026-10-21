import { useEffect, useState } from "react";
import { ArrowUpFromLine, Clock3, LogOut, Settings } from "lucide-react";
import { SidebarNav, StatusLine } from "@peerpayload/ui";

import Login from "./pages/Login.jsx";
import TransferPage from "./pages/TransferPage.jsx";
import HistoryPage from "./pages/HistoryPage.jsx";
import SettingsPage from "./pages/SettingsPage.jsx";
import OfferBanner from "./components/OfferBanner.jsx";
import useDashboard from "./lib/useDashboard";

const PAGES = [
  { id: "transfer", label: "Transfer", icon: ArrowUpFromLine },
  { id: "history", label: "History", icon: Clock3 },
  { id: "settings", label: "Settings", icon: Settings },
];

// No react-router: "signed out" vs "signed in" plus one page at a time is
// all the navigation this tray app has.
export default function App() {
  const [user, setUser] = useState(undefined); // undefined = still checking, null = logged out

  useEffect(() => {
    window.peerpayload.getMe().then(setUser);
  }, []);

  useEffect(() => window.peerpayload.onSessionRevoked(() => setUser(null)), []);

  if (user === undefined)
    return <div className="flex h-screen items-center justify-center text-sm text-[var(--color-ink-muted)]">Loading…</div>;

  if (!user)
    return <Login onLogin={setUser} />;

  return <SignedIn user={user} onLogout={() => setUser(null)} />;
}

function SignedIn({ user, onLogout }) {
  const [page, setPage] = useState("transfer");
  const [historyTab, setHistoryTab] = useState("active");
  const d = useDashboard(user, onLogout);

  const waiting = d.offers.filter((o) => o.id !== d.activeReceive?.id).length;
  const server =
    d.connected === null
      ? { label: "Connecting…", detail: "Server", tone: "muted" }
      : d.connected
        ? { label: "Connected", detail: "Server", tone: "good" }
        : { label: "Reconnecting…", detail: "Server unreachable", tone: "warning" };

  return (
    <div className="flex h-screen overflow-hidden">
      <SidebarNav
        edition="Enterprise"
        pages={PAGES.map((p) => ({ ...p, badge: p.id === "transfer" ? waiting : 0 }))}
        current={page}
        onNavigate={setPage}
        footer={
          <>
            <StatusLine {...server} testId="connection" />
            <div className="mt-3 flex items-center justify-between gap-2 pl-4">
              <p className="truncate text-xs text-[var(--color-ink-secondary)]">
                Signed in as <span className="font-medium text-[var(--color-ink)]">{user.username}</span>
              </p>
              <button type="button" onClick={d.logout} aria-label="Sign out" title="Sign out" className="text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]">
                <LogOut size={15} aria-hidden="true" />
              </button>
            </div>
          </>
        }
      />

      <div className="flex min-w-0 flex-1 flex-col">
        {d.offers.map((offer) => (
          <OfferBanner key={offer.id} offer={offer} d={d} />
        ))}

        <main className="min-h-0 flex-1 overflow-y-auto">
          {page === "transfer" && <TransferPage user={user} d={d} onShowHistory={() => setPage("history")} />}
          {page === "history" && <HistoryPage user={user} d={d} tab={historyTab} onTab={setHistoryTab} />}
          {page === "settings" && <SettingsPage user={user} d={d} />}
        </main>
      </div>
    </div>
  );
}
