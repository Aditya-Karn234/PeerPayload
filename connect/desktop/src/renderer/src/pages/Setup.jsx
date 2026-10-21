import { useState } from "react";
import { ArrowRight } from "lucide-react";
import { Button, Field, SectionLabel, TextInput, Wordmark } from "@peerpayload/ui";

import { errorMessage } from "../lib/util";

// First run: create this device's identity. No account, no server: the
// key is made here and never leaves this machine.
export default function Setup({ onDone }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);

    try {
      await window.connect.setup(name.trim());
      await onDone();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <div className="grid min-h-screen grid-cols-1 md:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
      <div className="flex flex-col justify-between border-b border-[var(--color-border)] bg-[var(--color-surface)] px-10 py-10 md:border-b-0 md:border-r">
        <Wordmark size={34} edition="Connect" />
        <div className="mt-16">
          <p className="max-w-sm text-[28px] font-bold leading-tight tracking-tight">Send files straight to people you know.</p>
          <p className="mt-4 font-mono text-xs uppercase tracking-[0.16em] text-[var(--color-ink-muted)]">Direct / Private / Reliable</p>
        </div>
      </div>

      <div className="flex items-center px-10 py-10">
        <form onSubmit={submit} className="w-full max-w-sm">
          <SectionLabel>Set up this device</SectionLabel>
          <h1 className="mt-4 text-2xl font-bold tracking-tight">Welcome to PeerPayload Connect</h1>
          <p className="mt-2 text-sm text-[var(--color-ink-secondary)]">
            There's no account. This device makes its own key, here, and keeps it. People add you with a one-time invite link.
          </p>
          <Field label="Your name" hint="Shown to the devices you pair with. Up to 64 characters." error={error} className="mt-6">
            <TextInput value={name} onChange={(e) => setName(e.target.value)} maxLength={64} autoFocus required placeholder="e.g. Aditya's laptop" />
          </Field>
          <Button type="submit" variant="primary" iconAfter={ArrowRight} className="mt-5 w-full" disabled={busy || !name.trim()}>
            {busy ? "Creating keys…" : "Create my device identity"}
          </Button>
        </form>
      </div>
    </div>
  );
}
