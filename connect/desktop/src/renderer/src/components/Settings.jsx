import { useState } from "react";

import { Button, Card, ErrorText, Field, Muted, TextInput, errorMessage } from "./ui.jsx";

export default function Settings({ status, onSaved }) {
  const [form, setForm] = useState({
    mailboxUrl: status.settings.mailboxUrl ?? "",
    relayUrl: status.settings.relayUrl ?? "",
    downloadDir: status.settings.downloadDir,
  });
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState(null);

  const set = (key) => (e) => {
    setSaved(false);
    setForm((f) => ({ ...f, [key]: e.target.value }));
  };

  async function chooseFolder() {
    const dir = await window.connect.pickDownloadDir();

    if (dir) {
      setSaved(false);
      setForm((f) => ({ ...f, downloadDir: dir }));
    }
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);

    try {
      await window.connect.saveSettings({ mailboxUrl: form.mailboxUrl.trim(), relayUrl: form.relayUrl.trim(), downloadDir: form.downloadDir });
      setSaved(true);
      await onSaved();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <div className="grid gap-4">
      <Card>
        <form onSubmit={handleSubmit} className="grid gap-4">
          <Field label="Mailbox" hint="Where your device picks up invites and transfer offers. Messages are end-to-end encrypted: the mailbox can't read them.">
            <TextInput value={form.mailboxUrl} onChange={set("mailboxUrl")} placeholder="https://mailbox.example.com" />
          </Field>
          <Field label="Relay (optional)" hint="Used only when the other device can't be reached directly. It only ever sees encrypted data.">
            <TextInput value={form.relayUrl} onChange={set("relayUrl")} placeholder="wss://relay.example.com/v1/connect" />
          </Field>
          <Field label="Save received files to">
            <div className="flex gap-2">
              <TextInput value={form.downloadDir} readOnly />
              <Button className="mt-1 shrink-0" onClick={chooseFolder}>
                Choose…
              </Button>
            </div>
          </Field>
          <div className="flex items-center gap-3">
            <Button variant="primary" type="submit">
              Save
            </Button>
            {saved && <span className="text-sm" role="status">Saved</span>}
          </div>
          <ErrorText>{error}</ErrorText>
        </form>
      </Card>

      <Card>
        <h2 className="text-sm font-semibold">This device</h2>
        <Muted className="mt-1">Device ID (share this only to double-check a pairing):</Muted>
        <p className="mt-1 break-all font-mono text-xs">{status.fingerprint}</p>
      </Card>
    </div>
  );
}
