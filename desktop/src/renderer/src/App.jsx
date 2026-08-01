import { useEffect, useState } from "react";

import Login from "./pages/Login.jsx";
import Dashboard from "./pages/Dashboard.jsx";

// No react-router here — this is a single-window tray app, not a
// multi-page dashboard; "logged out" vs "logged in" is the only real
// navigation state that matters.
export default function App() {
  const [user, setUser] = useState(undefined); // undefined = still checking, null = logged out

  useEffect(() => {
    window.peerpayload.getMe().then(setUser);
  }, []);

  useEffect(() => window.peerpayload.onSessionRevoked(() => setUser(null)), []);

  if (user === undefined) {
    return (
      <div className="flex h-screen items-center justify-center text-sm" style={{ color: "var(--color-ink-muted)" }}>
        Loading…
      </div>
    );
  }

  if (!user)
    return <Login onLogin={setUser} />;

  return <Dashboard user={user} onLogout={() => setUser(null)} />;
}
