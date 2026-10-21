import { useState } from "react";

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
    <div className="flex h-screen items-center justify-center">
      <form
        onSubmit={handleSubmit}
        className="w-80 rounded-lg border p-6"
        style={{ borderColor: "var(--color-border)", background: "var(--color-surface)" }}
      >
        <h1 className="text-base font-semibold">PeerPayload Enterprise</h1>
        <p className="mt-1 text-xs" style={{ color: "var(--color-ink-muted)" }}>
          Sign in with your org account.
        </p>

        <label className="mt-4 block text-sm">
          <span className="mb-1 block" style={{ color: "var(--color-ink-secondary)" }}>Username</span>
          <input
            autoFocus
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            className="w-full rounded-md border bg-transparent px-3 py-2 text-sm outline-none"
            style={{ borderColor: "var(--color-border)" }}
            required
          />
        </label>

        <label className="mt-3 block text-sm">
          <span className="mb-1 block" style={{ color: "var(--color-ink-secondary)" }}>Password</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full rounded-md border bg-transparent px-3 py-2 text-sm outline-none"
            style={{ borderColor: "var(--color-border)" }}
            required
          />
        </label>

        {error && (
          <p className="mt-3 text-sm" style={{ color: "var(--color-critical)" }}>{error}</p>
        )}

        <button
          type="submit"
          disabled={submitting}
          className="mt-4 w-full rounded-md px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
          style={{ background: "var(--color-accent)" }}
        >
          {submitting ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}
