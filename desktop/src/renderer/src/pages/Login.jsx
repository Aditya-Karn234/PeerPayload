import { useState } from "react";
import { ArrowRight } from "lucide-react";
import { Button, Field, SectionLabel, TextInput, Wordmark } from "@peerpayload/ui";

export default function Login({ onLogin }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);

    try {
      const user = await window.peerpayload.login(username, password);

      onLogin(user);
    } catch (err) {
      setError(err.message || "Login failed");
      setSubmitting(false);
    }
  }

  return (
    <div className="grid min-h-screen grid-cols-1 md:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
      <div className="flex flex-col justify-between border-b border-[var(--color-border)] bg-[var(--color-surface)] px-10 py-10 md:border-b-0 md:border-r">
        <Wordmark size={34} edition="Enterprise" />
        <div className="mt-16">
          <p className="max-w-sm text-[28px] font-bold leading-tight tracking-tight">Send files to colleagues, directly.</p>
          <p className="mt-4 font-mono text-xs uppercase tracking-[0.16em] text-[var(--color-ink-muted)]">Direct / Private / Reliable</p>
        </div>
      </div>

      <div className="flex items-center px-10 py-10">
        <form onSubmit={handleSubmit} className="w-full max-w-sm">
          <SectionLabel>Sign in</SectionLabel>
          <h1 className="mt-4 text-2xl font-bold tracking-tight">PeerPayload Enterprise</h1>
          <p className="mt-2 text-sm text-[var(--color-ink-secondary)]">Sign in with your organisation account.</p>

          <Field label="Username" className="mt-6">
            <TextInput autoFocus value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" required />
          </Field>
          <Field label="Password" error={error} className="mt-4">
            <TextInput type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
          </Field>

          <Button type="submit" variant="primary" iconAfter={ArrowRight} className="mt-6 w-full" disabled={submitting}>
            {submitting ? "Signing in…" : "Sign in"}
          </Button>
        </form>
      </div>
    </div>
  );
}
