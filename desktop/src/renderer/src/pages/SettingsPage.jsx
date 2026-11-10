import { useEffect, useState } from "react";
import { FolderOpen, Info, KeyRound, LogOut, SlidersHorizontal, UserRound } from "lucide-react";
import { Button, Field, Mono, SectionLabel, Select, TextInput, Toggle, getThemePreference, setThemePreference } from "@peerpayload/ui";

const SECTIONS = [
  { id: "general", label: "General", icon: SlidersHorizontal },
  { id: "account", label: "Account", icon: UserRound },
  { id: "about", label: "About", icon: Info },
];

export default function SettingsPage({ user, d }) {
  const [section, setSection] = useState("general");
  const [info, setInfo] = useState(null);

  useEffect(() => {
    window.peerpayload.appInfo().then(setInfo);
  }, []);

  return (
    <div className="flex min-h-full">
      <nav aria-label="Settings sections" className="w-48 shrink-0 border-r border-[var(--color-border)] px-3 py-7">
        <SectionLabel className="px-3">Settings</SectionLabel>
        <div className="mt-3 flex flex-col gap-0.5">
          {SECTIONS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              onClick={() => setSection(id)}
              aria-current={section === id ? "page" : undefined}
              className={`flex h-9 items-center gap-2.5 rounded-[var(--radius-md)] px-3 text-sm ${section === id ? "bg-[var(--color-accent-soft)] font-medium" : "text-[var(--color-ink-secondary)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-ink)]"}`}
            >
              <Icon size={16} strokeWidth={1.75} className={section === id ? "text-[var(--color-accent)]" : ""} aria-hidden="true" />
              {label}
            </button>
          ))}
        </div>
      </nav>
      <div className="max-w-2xl flex-1 px-8 py-7">
        {section === "general" && <General d={d} info={info} />}
        {section === "account" && <Account user={user} d={d} />}
        {section === "about" && <About info={info} />}
      </div>
    </div>
  );
}

function Row({ title, description, children }) {
  return (
    <div className="flex items-center justify-between gap-6 border-b border-[var(--color-border)] py-4">
      <div className="min-w-0">
        <p className="text-sm font-medium">{title}</p>
        {description && <p className="mt-0.5 text-xs text-[var(--color-ink-secondary)]">{description}</p>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function General({ d, info }) {
  const [theme, setTheme] = useState(getThemePreference);

  return (
    <>
      <h1 className="text-xl font-bold tracking-tight">General</h1>
      <div className="mt-4 border-t border-[var(--color-border)]">
        <Row title="Theme" description="System follows your Windows setting.">
          <Select
            aria-label="Theme"
            value={theme}
            onChange={(e) => {
              setTheme(e.target.value);
              setThemePreference(e.target.value);
            }}
            className="w-40"
          >
            <option value="system">System</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </Select>
        </Row>
        <Row title="Auto-accept incoming transfers" description="Accept files from colleagues without asking. Also in the tray menu.">
          <Toggle label="Auto-accept incoming transfers" checked={d.autoAccept} onChange={d.toggleAutoAccept} />
        </Row>
        <div className="border-b border-[var(--color-border)] py-4">
          <p className="text-sm font-medium">Received files</p>
          <p className="mt-0.5 text-xs text-[var(--color-ink-secondary)]">Where files you accept are saved.</p>
          <div className="mt-3 flex gap-2">
            <TextInput readOnly value={info?.downloadsDir ?? ""} aria-label="Received files folder" className="font-mono text-xs" />
            <Button variant="secondary" icon={FolderOpen} onClick={() => window.peerpayload.openDownloads()}>
              Open
            </Button>
          </div>
        </div>
      </div>
    </>
  );
}

function Account({ user, d }) {
  return (
    <>
      <h1 className="text-xl font-bold tracking-tight">Account</h1>
      <div className="mt-4 border-t border-[var(--color-border)]">
        <Row title="Signed in as" description="Your organisation account. An administrator manages accounts.">
          <Mono className="text-sm">{user.username}</Mono>
        </Row>
        <ChangePassword />
        <Row title="Sign out" description="Incoming transfers stop reaching this computer until you sign in again.">
          <Button variant="secondary" icon={LogOut} onClick={d.logout}>
            Sign out
          </Button>
        </Row>
      </div>
    </>
  );
}

// Electron prefixes errors from the main process; show only the server's message.
const cleanError = (err) => String(err?.message ?? err).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");

function ChangePassword() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError(null);
    setDone(false);

    if (next.length < 8)
      return setError("The new password must be at least 8 characters.");

    if (next !== confirm)
      return setError("The new passwords don't match.");

    setBusy(true);

    try {
      await window.peerpayload.changePassword(current, next);
      setCurrent("");
      setNext("");
      setConfirm("");
      setDone(true);
    } catch (err) {
      setError(cleanError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="border-b border-[var(--color-border)] py-4">
      <p className="text-sm font-medium">Change password</p>
      <p className="mt-0.5 text-xs text-[var(--color-ink-secondary)]">
        At least 8 characters. Your other signed-in computers are signed out; this one stays signed in.
      </p>
      <div className="mt-3 grid max-w-sm gap-3">
        <Field label="Current password">
          <TextInput type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" required />
        </Field>
        <Field label="New password">
          <TextInput type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" required />
        </Field>
        <Field label="Confirm new password" error={error}>
          <TextInput type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" required />
        </Field>
        <div className="flex items-center gap-3">
          <Button type="submit" variant="secondary" icon={KeyRound} disabled={busy}>
            {busy ? "Changing…" : "Change password"}
          </Button>
          {done && <span role="status" className="text-xs text-[var(--color-good)]">Password changed.</span>}
        </div>
      </div>
    </form>
  );
}

function About({ info }) {
  return (
    <>
      <h1 className="text-xl font-bold tracking-tight">About</h1>
      <dl className="mt-4 border-t border-[var(--color-border)]">
        <div className="flex justify-between gap-6 border-b border-[var(--color-border)] py-3">
          <dt className="text-sm text-[var(--color-ink-secondary)]">Version</dt>
          <dd className="text-sm">PeerPayload Enterprise {info?.version ?? "…"}</dd>
        </div>
      </dl>
    </>
  );
}
