import { useEffect, useState } from "react";
import { FolderOpen, Info, Network, SlidersHorizontal } from "lucide-react";
import { Button, Field, Mono, SectionLabel, Select, TextInput, Toggle, getThemePreference, setThemePreference } from "@peerpayload/ui";

import { errorMessage } from "../lib/util";

const SECTIONS = [
  { id: "general", label: "General", icon: SlidersHorizontal },
  { id: "network", label: "Network", icon: Network },
  { id: "about", label: "About", icon: Info },
];

export default function SettingsPage({ status, section, onSection, onSaved }) {
  return (
    <div className="flex min-h-full">
      <nav aria-label="Settings sections" className="w-48 shrink-0 border-r border-[var(--color-border)] px-3 py-7">
        <SectionLabel className="px-3">Settings</SectionLabel>
        <div className="mt-3 flex flex-col gap-0.5">
          {SECTIONS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              onClick={() => onSection(id)}
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
        {section === "general" && <General status={status} onSaved={onSaved} />}
        {section === "network" && <NetworkSettings status={status} onSaved={onSaved} />}
        {section === "about" && <About status={status} />}
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

function General({ status, onSaved }) {
  const [theme, setTheme] = useState(getThemePreference);
  const [info, setInfo] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    window.connect.appInfo().then(setInfo);
  }, []);

  async function chooseFolder() {
    const dir = await window.connect.pickDownloadDir();

    if (!dir)
      return;

    try {
      await window.connect.saveSettings({ downloadDir: dir });
      await onSaved();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function setLogin(enabled) {
    try {
      const openAtLogin = await window.connect.setOpenAtLogin(enabled);

      setInfo((i) => ({ ...i, openAtLogin }));
    } catch (err) {
      setError(errorMessage(err));
    }
  }

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
        <Row title="Start when I sign in" description={info?.packaged ? "Keeps you reachable: starts in the tray." : "Available in the installed app."}>
          <Toggle label="Start when I sign in" checked={Boolean(info?.openAtLogin)} onChange={setLogin} disabled={!info?.packaged} />
        </Row>
        <div className="border-b border-[var(--color-border)] py-4">
          <p className="text-sm font-medium">Received files</p>
          <p className="mt-0.5 text-xs text-[var(--color-ink-secondary)]">Files arrive here once complete; unfinished ones wait in a hidden “.incoming” folder inside it.</p>
          <div className="mt-3 flex gap-2">
            <TextInput readOnly value={status.settings.downloadDir} aria-label="Received files folder" className="font-mono text-xs" />
            <Button variant="secondary" icon={FolderOpen} onClick={chooseFolder}>
              Choose…
            </Button>
          </div>
        </div>
      </div>
      {error && (
        <p className="mt-3 text-sm text-[var(--color-critical)]" role="alert">
          {error}
        </p>
      )}
    </>
  );
}

function NetworkSettings({ status, onSaved }) {
  const [form, setForm] = useState({ mailboxUrl: status.settings.mailboxUrl ?? "", relayUrl: status.settings.relayUrl ?? "" });
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState(null);

  const set = (key) => (e) => {
    setSaved(false);
    setForm((f) => ({ ...f, [key]: e.target.value }));
  };

  async function submit(e) {
    e.preventDefault();
    setError(null);

    try {
      await window.connect.saveSettings({ mailboxUrl: form.mailboxUrl.trim(), relayUrl: form.relayUrl.trim() });
      setSaved(true);
      await onSaved();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  const mailboxState = !status.mailboxUrl ? "Not set" : status.connected ? "Connected" : "Connecting…";

  return (
    <form onSubmit={submit}>
      <h1 className="text-xl font-bold tracking-tight">Network</h1>
      <div className="mt-4 grid gap-5 border-t border-[var(--color-border)] pt-5">
        <Field label="Mailbox" hint="Where this device picks up invites and transfer offers. They're end-to-end encrypted: the mailbox can't read them.">
          <TextInput value={form.mailboxUrl} onChange={set("mailboxUrl")} placeholder="https://mailbox.example.com" className="font-mono text-xs" />
        </Field>
        <p className="-mt-2 font-mono text-[11px] uppercase tracking-[0.12em] text-[var(--color-ink-muted)]">Status: {mailboxState}</p>
        <Field label="Relay (optional)" hint="Used only when the other device can't be reached directly. It only ever carries encrypted data.">
          <TextInput value={form.relayUrl} onChange={set("relayUrl")} placeholder="wss://relay.example.com/v1/connect" className="font-mono text-xs" />
        </Field>
        <div className="flex items-center gap-3">
          <Button type="submit" variant="primary">
            Save
          </Button>
          {saved && (
            <span className="text-sm" role="status">
              Saved
            </span>
          )}
        </div>
        {error && (
          <p className="text-sm text-[var(--color-critical)]" role="alert">
            {error}
          </p>
        )}
      </div>
    </form>
  );
}

function About({ status }) {
  const [info, setInfo] = useState(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    window.connect.appInfo().then(setInfo);
  }, []);

  return (
    <>
      <h1 className="text-xl font-bold tracking-tight">About</h1>
      <dl className="mt-4 border-t border-[var(--color-border)]">
        {[
          ["Version", info ? `PeerPayload Connect ${info.version}` : "…"],
          ["Device name", status.name],
        ].map(([k, v]) => (
          <div key={k} className="flex justify-between gap-6 border-b border-[var(--color-border)] py-3">
            <dt className="text-sm text-[var(--color-ink-secondary)]">{k}</dt>
            <dd className="text-sm">{v}</dd>
          </div>
        ))}
        <div className="border-b border-[var(--color-border)] py-3">
          <dt className="text-sm text-[var(--color-ink-secondary)]">Device ID</dt>
          <dd className="mt-1 flex items-start gap-3">
            <Mono className="break-all">{status.fingerprint}</Mono>
            <Button
              variant="ghost"
              size="sm"
              onClick={async () => {
                await window.connect.copy(status.fingerprint);
                setCopied(true);
              }}
            >
              {copied ? "Copied" : "Copy"}
            </Button>
          </dd>
          <p className="mt-1 text-xs text-[var(--color-ink-secondary)]">Your key never leaves this device. Share the ID only to double-check a pairing.</p>
        </div>
      </dl>
    </>
  );
}
