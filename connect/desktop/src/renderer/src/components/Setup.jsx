import { useState } from "react";

import { Button, Card, ErrorText, Field, Muted, TextInput, errorMessage } from "./ui.jsx";

// First run: create this device's identity. No account, no server: the
// keys are made here and never leave this machine.
export default function Setup({ onDone }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function handleSubmit(e) {
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
    <div className="mx-auto max-w-md px-4 py-16">
      <h1 className="text-xl font-semibold">Welcome to PeerPayload Connect</h1>
      <Muted className="mt-2">
        Send files and folders straight to people you know. There's no account: this device gets its own key, made here and
        kept here. People add you with a one-time invite link.
      </Muted>

      <Card className="mt-6">
        <form onSubmit={handleSubmit}>
          <Field label="Your name" hint="Shown to people you pair with. Up to 64 characters.">
            <TextInput value={name} onChange={(e) => setName(e.target.value)} maxLength={64} autoFocus required placeholder="e.g. Aditya's laptop" />
          </Field>
          <ErrorText>{error}</ErrorText>
          <Button variant="primary" type="submit" className="mt-4" disabled={busy || !name.trim()}>
            {busy ? "Creating keys…" : "Create my device identity"}
          </Button>
        </form>
      </Card>
    </div>
  );
}
