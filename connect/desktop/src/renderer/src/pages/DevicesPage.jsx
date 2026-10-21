import { useState } from "react";
import { Check, Clock3, Copy, Laptop, Link2, RefreshCw, ShieldCheck, Trash2 } from "lucide-react";
import { Button, Field, IconButton, Mono, SectionLabel, TextInput } from "@peerpayload/ui";

import { errorMessage, lastTransferLabel, shortId } from "../lib/util";

export default function DevicesPage({ contacts, transfers, status, onNavigate }) {
  return (
    <div className="divide-y divide-[var(--color-border)]">
      <InviteSection status={status} onNavigate={onNavigate} />
      <AddSection />
      <PairedSection contacts={contacts} transfers={transfers} />
    </div>
  );
}

// A one-time invite: the link (and its QR code) another device opens to
// pair with this one.
function InviteSection({ status, onNavigate }) {
  const [invite, setInvite] = useState(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState(null);

  async function create() {
    setError(null);
    setCopied(false);

    try {
      setInvite(await window.connect.createInvite());
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function copy() {
    await window.connect.copy(invite.link);
    setCopied(true);
  }

  return (
    <section className="px-8 py-7" aria-labelledby="pair-heading">
      <SectionLabel>Pair a device</SectionLabel>
      <h1 id="pair-heading" className="mt-4 text-[26px] font-bold tracking-tight">
        Connect a device
      </h1>
      <p className="mt-1 text-sm text-[var(--color-ink-secondary)]">
        Share this one-time link with the other device, or let it scan the code. It works once, for 24 hours.
      </p>

      {!status.mailboxUrl ? (
        <div className="mt-5 border-l-2 border-[var(--color-warning)] bg-[var(--color-surface)] px-4 py-3 text-sm">
          The other device needs a mailbox to reach this one.{" "}
          <button type="button" className="font-medium underline underline-offset-2" onClick={() => onNavigate("settings", "network")}>
            Set one in Settings
          </button>
        </div>
      ) : invite ? (
        <div className="mt-5 flex flex-wrap items-start gap-6">
          <img src={invite.qr} alt="QR code of the invite link" width={176} height={176} className="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-white p-2" />
          <div className="min-w-64 flex-1">
            <SectionLabel>Invite link</SectionLabel>
            <textarea
              readOnly
              value={invite.link}
              aria-label="Invite link"
              data-testid="invite-link"
              rows={4}
              onFocus={(e) => e.target.select()}
              className="mt-2 w-full resize-none break-all rounded-[var(--radius-md)] border border-[var(--color-border-strong)] bg-[var(--color-surface-2)] px-3 py-2 font-mono text-[11px] leading-relaxed text-[var(--color-ink-secondary)]"
            />
            <p className="mt-2 flex items-center gap-1.5 text-xs text-[var(--color-ink-secondary)]">
              <Clock3 size={13} aria-hidden="true" />
              Valid until <Mono>{new Date(invite.expiresAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}</Mono> · single use
            </p>
            <div className="mt-4 flex gap-2">
              <Button variant="primary" size="sm" icon={copied ? Check : Copy} onClick={copy}>
                {copied ? "Copied" : "Copy link"}
              </Button>
              <Button variant="secondary" size="sm" icon={RefreshCw} onClick={create}>
                New link
              </Button>
            </div>
          </div>
        </div>
      ) : (
        <Button variant="primary" icon={Link2} className="mt-5" onClick={create}>
          Create invite link
        </Button>
      )}
      {error && (
        <p className="mt-3 text-sm text-[var(--color-critical)]" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

// The other half: paste a link someone sent.
function AddSection() {
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setResult(null);

    try {
      const contact = await window.connect.addContact(link.trim());

      setResult(`Pairing request sent to ${contact.name}. It's paired once their device answers, usually within seconds.`);
      setLink("");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="px-8 py-7" aria-labelledby="add-heading">
      <SectionLabel as="h2">
        <span id="add-heading">Add a device</span>
      </SectionLabel>
      <form onSubmit={submit} className="mt-4 flex max-w-2xl items-end gap-3">
        <Field label="Invite link" error={error} className="flex-1">
          <TextInput value={link} onChange={(e) => setLink(e.target.value)} placeholder="peerpayload://pair#…" className="font-mono text-xs" required />
        </Field>
        <Button type="submit" variant="secondary" disabled={busy || !link.trim()} className={error ? "mb-6" : ""}>
          {busy ? "Adding…" : "Add device"}
        </Button>
      </form>
      {result && (
        <p className="mt-3 text-sm" role="status">
          {result}
        </p>
      )}
    </section>
  );
}

function PairedSection({ contacts, transfers }) {
  return (
    <section className="px-8 py-7" aria-labelledby="paired-heading">
      <SectionLabel as="h2">
        <span id="paired-heading">Paired devices · {contacts.length}</span>
      </SectionLabel>
      {contacts.length === 0 ? (
        <p className="mt-3 text-sm text-[var(--color-ink-secondary)]">None yet.</p>
      ) : (
        <ul className="mt-2" aria-label="Paired devices">
          {contacts.map((c) => (
            <DeviceRow key={c.fp} contact={c} lastLabel={lastTransferLabel(transfers, c.fp)} />
          ))}
        </ul>
      )}
    </section>
  );
}

function DeviceRow({ contact: c, lastLabel }) {
  const [showCode, setShowCode] = useState(false);
  const paired = c.status === "paired";

  async function remove() {
    if (window.confirm(`Remove ${c.name}? You'd need a new invite to pair again.`))
      await window.connect.removeContact(c.fp);
  }

  return (
    <li className="border-b border-[var(--color-border)] py-3 last:border-b-0" data-testid={`contact-${c.name}`}>
      <div className="flex items-center gap-4">
        <Laptop size={20} strokeWidth={1.5} className="shrink-0 text-[var(--color-ink-secondary)]" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{c.name}</p>
          <p className="truncate font-mono text-[11px] text-[var(--color-ink-muted)]">
            {shortId(c.fp)} · {lastLabel}
          </p>
        </div>
        <span className={`text-xs ${paired ? "text-[var(--color-ink-secondary)]" : "text-[var(--color-warning)]"}`}>{paired ? "Paired" : "Waiting for them to accept"}</span>
        <Button variant="ghost" size="sm" icon={ShieldCheck} onClick={() => setShowCode((s) => !s)} aria-expanded={showCode}>
          Safety code
        </Button>
        <IconButton icon={Trash2} label={`Remove ${c.name}`} onClick={remove} />
      </div>
      {showCode && (
        <div className="ml-9 mt-3 border-l-2 border-[var(--color-border-strong)] pl-4">
          <p className="font-mono text-base tracking-[0.12em]" data-testid="safety-code">{c.safetyCode}</p>
          <p className="mt-1 text-xs text-[var(--color-ink-secondary)]">If {c.name} sees the same code on their device, you're connected to the right device.</p>
        </div>
      )}
    </li>
  );
}
