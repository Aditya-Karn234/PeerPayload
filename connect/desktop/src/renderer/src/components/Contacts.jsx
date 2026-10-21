import { useState } from "react";

import { Button, Card, ErrorText, Field, Muted, TextInput, errorMessage } from "./ui.jsx";

export default function Contacts({ contacts, status, onSent }) {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <InviteCard status={status} />
      <AddContactCard />
      <div className="md:col-span-2">
        <h2 className="text-sm font-semibold">Contacts</h2>
        {contacts.length === 0 ? (
          <Muted className="mt-2">No contacts yet. Share an invite link, or paste one someone sent you.</Muted>
        ) : (
          <ul className="mt-2 grid gap-2" aria-label="Contacts">
            {contacts.map((c) => (
              <ContactRow key={c.fp} contact={c} onSent={onSent} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// A one-time link (and its QR code) for someone else to add this device.
function InviteCard({ status }) {
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
    <Card aria-label="Invite someone">
      <h2 className="text-sm font-semibold">Invite someone</h2>
      <Muted className="mt-1">
        Anyone with the link can pair with you once, within 24 hours. Send it over something you trust, or let them scan the code.
      </Muted>
      {!status.mailboxUrl && <Muted className="mt-2">Set a mailbox in Settings first, so their device can reach yours.</Muted>}

      {invite ? (
        <div className="mt-3">
          <img src={invite.qr} alt="QR code of the invite link" width={180} height={180} className="rounded bg-white p-1" />
          <textarea
            readOnly
            value={invite.link}
            aria-label="Invite link"
            data-testid="invite-link"
            rows={3}
            className="mt-2 w-full resize-none rounded-md border px-2 py-1 font-mono text-xs"
            style={{ borderColor: "var(--color-border)", background: "var(--color-page)", color: "var(--color-ink-secondary)" }}
            onFocus={(e) => e.target.select()}
          />
          <div className="mt-2 flex items-center gap-2">
            <Button onClick={copy}>{copied ? "Copied" : "Copy link"}</Button>
            <Button variant="quiet" onClick={create}>New link</Button>
            <Muted>Valid until {new Date(invite.expiresAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}</Muted>
          </div>
        </div>
      ) : (
        <Button variant="primary" className="mt-3" onClick={create} disabled={!status.mailboxUrl}>
          Create invite link
        </Button>
      )}
      <ErrorText>{error}</ErrorText>
    </Card>
  );
}

function AddContactCard() {
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  async function handleSubmit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setResult(null);

    try {
      const contact = await window.connect.addContact(link.trim());

      setResult(`Asked ${contact.name} to pair. They'll appear as paired once their device answers.`);
      setLink("");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card aria-label="Add a contact">
      <h2 className="text-sm font-semibold">Add a contact</h2>
      <form onSubmit={handleSubmit} className="mt-2">
        <Field label="Invite link" hint="Starts with peerpayload://pair#">
          <TextInput value={link} onChange={(e) => setLink(e.target.value)} placeholder="peerpayload://pair#…" required />
        </Field>
        <Button variant="primary" type="submit" className="mt-3" disabled={busy || !link.trim()}>
          {busy ? "Adding…" : "Add contact"}
        </Button>
      </form>
      {result && (
        <p className="mt-2 text-sm" role="status">
          {result}
        </p>
      )}
      <ErrorText>{error}</ErrorText>
    </Card>
  );
}

function ContactRow({ contact, onSent }) {
  const [showCode, setShowCode] = useState(false);
  const [error, setError] = useState(null);
  const paired = contact.status === "paired";

  async function send(mode) {
    setError(null);

    const paths = await window.connect.pickPaths(mode);

    if (!paths.length)
      return;

    // Resolves when the transfer ends; progress arrives as events.
    window.connect.send(contact.fp, paths).catch((err) => setError(errorMessage(err)));
    onSent();
  }

  async function remove() {
    if (window.confirm(`Remove ${contact.name}? You'd need a new invite to pair again.`))
      await window.connect.removeContact(contact.fp);
  }

  return (
    <li className="rounded-lg border p-3" style={{ borderColor: "var(--color-border)", background: "var(--color-surface)" }} data-testid={`contact-${contact.name}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-sm font-medium">{contact.name}</p>
          <Muted>
            {paired ? "Paired" : "Waiting for them to accept"} · device {contact.fp.slice(0, 8)}
          </Muted>
        </div>
        <div className="flex gap-2">
          <Button variant="primary" onClick={() => send("files")} disabled={!paired}>
            Send files
          </Button>
          <Button onClick={() => send("folder")} disabled={!paired}>
            Send folder
          </Button>
          <Button variant="quiet" onClick={() => setShowCode((s) => !s)} aria-expanded={showCode}>
            Safety code
          </Button>
          <Button variant="danger" onClick={remove}>
            Remove
          </Button>
        </div>
      </div>
      {showCode && (
        <div className="mt-2">
          <p className="font-mono text-sm tracking-wider">{contact.safetyCode}</p>
          <Muted>If {contact.name} sees the same code on their device, you're connected to the right person.</Muted>
        </div>
      )}
      <ErrorText>{error}</ErrorText>
    </li>
  );
}
