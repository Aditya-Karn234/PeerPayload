import { useState } from "react";
import { useNavigate } from "react-router-dom";

import { createTransfer } from "../lib/api";

const inputClass =
  "w-full rounded-md border bg-transparent px-3 py-2 text-sm outline-none focus:ring-2";

// Bigger chunks mean fewer round trips, which is what actually dominates
// throughput over any real network link — see the Performance section of
// the README (64 KiB default measured ~10x slower than 8 MiB at realistic
// latency). "" means don't send --chunk-size at all; the engine defaults to
// 64 KiB on its own.
const CHUNK_SIZE_OPTIONS = [
  { label: "Default (64 KiB)", value: "" },
  { label: "256 KiB", value: 256 * 1024 },
  { label: "1 MiB", value: 1024 * 1024 },
  { label: "4 MiB", value: 4 * 1024 * 1024 },
  { label: "8 MiB (fastest, max)", value: 8 * 1024 * 1024 },
];

const MODES = [
  { value: "local", label: "This machine" },
  { value: "send", label: "Send to remote" },
  { value: "receive", label: "Receive from remote" },
];

const SUBMIT_LABEL = {
  local: "Start transfer",
  send: "Send",
  receive: "Start listening",
};

export default function NewTransferForm() {
  const navigate = useNavigate();

  const [mode, setMode] = useState("local");
  const [sourcePath, setSourcePath] = useState("");
  const [destDir, setDestDir] = useState("");
  const [chunkSize, setChunkSize] = useState("");
  const [host, setHost] = useState("");
  const [port, setPort] = useState("");
  const [token, setToken] = useState("");
  const [requireAuth, setRequireAuth] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  async function handleSubmit(e) {
    e.preventDefault();

    setSubmitting(true);
    setError(null);

    try {
      const transfer = await createTransfer({
        mode,
        sourcePath: mode === "receive" ? undefined : sourcePath,
        destDir: mode === "send" ? undefined : destDir,
        chunkSize: chunkSize || undefined,
        host: mode === "send" ? host : undefined,
        port: mode === "local" ? undefined : port || undefined,
        token: mode === "send" ? token || undefined : undefined,
        requireAuth: mode === "receive" ? requireAuth : undefined,
      });

      navigate(`/transfers/${transfer.id}`);
    } catch (err) {
      setError(err.message);
      setSubmitting(false);
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="rounded-lg border p-4"
      style={{ borderColor: "var(--color-border)", background: "var(--color-surface)" }}
    >
      <h2 className="text-sm font-semibold" style={{ color: "var(--color-ink)" }}>
        New transfer
      </h2>

      <div className="mt-3 inline-flex rounded-md border p-0.5" style={{ borderColor: "var(--color-border)" }}>
        {MODES.map((m) => (
          <button
            key={m.value}
            type="button"
            onClick={() => setMode(m.value)}
            className="rounded px-3 py-1.5 text-xs font-medium"
            style={
              mode === m.value
                ? { background: "var(--color-accent)", color: "white" }
                : { color: "var(--color-ink-secondary)" }
            }
          >
            {m.label}
          </button>
        ))}
      </div>

      <p className="mt-3 text-xs" style={{ color: "var(--color-ink-muted)" }}>
        {mode === "local" &&
          "Paths are resolved on the machine running the backend. Both ends run here."}
        {mode === "send" &&
          "Sends a local file/folder to a receiver already running elsewhere. If that receiver requires an access token, enter it below — it was shown on their \"Receive from remote\" screen."}
        {mode === "receive" &&
          "Starts a receiver here and waits for a sender elsewhere to connect. Share this machine's reachable address, the port, and the access token (shown once listening starts) with the sender out of band."}
      </p>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        {mode !== "receive" && (
          <label className="block text-sm">
            <span className="mb-1 block" style={{ color: "var(--color-ink-secondary)" }}>
              Source file or directory
            </span>
            <input
              className={inputClass}
              style={{ borderColor: "var(--color-border)" }}
              value={sourcePath}
              onChange={(e) => setSourcePath(e.target.value)}
              placeholder="C:\path\to\file-or-folder"
              required
            />
          </label>
        )}

        {mode !== "send" && (
          <label className="block text-sm">
            <span className="mb-1 block" style={{ color: "var(--color-ink-secondary)" }}>
              Destination directory
            </span>
            <input
              className={inputClass}
              style={{ borderColor: "var(--color-border)" }}
              value={destDir}
              onChange={(e) => setDestDir(e.target.value)}
              placeholder="C:\path\to\output"
              required
            />
          </label>
        )}

        {mode === "send" && (
          <>
            <label className="block text-sm">
              <span className="mb-1 block" style={{ color: "var(--color-ink-secondary)" }}>
                Remote host
              </span>
              <input
                className={inputClass}
                style={{ borderColor: "var(--color-border)" }}
                value={host}
                onChange={(e) => setHost(e.target.value)}
                placeholder="203.0.113.5"
                required
              />
            </label>

            <label className="block text-sm">
              <span className="mb-1 block" style={{ color: "var(--color-ink-secondary)" }}>
                Remote port
              </span>
              <input
                className={inputClass}
                style={{ borderColor: "var(--color-border)" }}
                value={port}
                onChange={(e) => setPort(e.target.value)}
                placeholder="8080"
                inputMode="numeric"
                required
              />
            </label>

            <label className="block text-sm sm:col-span-2">
              <span className="mb-1 block" style={{ color: "var(--color-ink-secondary)" }}>
                Access token <span style={{ color: "var(--color-ink-muted)" }}>(if the receiver requires one)</span>
              </span>
              <input
                className={inputClass}
                style={{ borderColor: "var(--color-border)" }}
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="Paste the token shown on the receiving side"
              />
            </label>
          </>
        )}

        {mode === "receive" && (
          <>
            <label className="block text-sm">
              <span className="mb-1 block" style={{ color: "var(--color-ink-secondary)" }}>
                Listen port <span style={{ color: "var(--color-ink-muted)" }}>(optional)</span>
              </span>
              <input
                className={inputClass}
                style={{ borderColor: "var(--color-border)" }}
                value={port}
                onChange={(e) => setPort(e.target.value)}
                placeholder="Auto-pick if left blank"
                inputMode="numeric"
              />
            </label>

            <label className="flex items-center gap-2 text-sm sm:col-span-2">
              <input
                type="checkbox"
                checked={requireAuth}
                onChange={(e) => setRequireAuth(e.target.checked)}
              />
              <span style={{ color: "var(--color-ink-secondary)" }}>
                Require an access token (recommended — a random one is generated and shown once
                listening starts; senders without it are rejected before any data moves)
              </span>
            </label>
          </>
        )}

        <label className="block text-sm">
          <span className="mb-1 block" style={{ color: "var(--color-ink-secondary)" }}>
            Chunk size
          </span>
          <select
            className={inputClass}
            style={{ borderColor: "var(--color-border)" }}
            value={chunkSize}
            onChange={(e) => setChunkSize(e.target.value)}
          >
            {CHUNK_SIZE_OPTIONS.map((opt) => (
              <option key={opt.label} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {error && (
        <p className="mt-3 text-sm" style={{ color: "var(--color-critical)" }}>
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={submitting}
        className="mt-4 rounded-md px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
        style={{ background: "var(--color-accent)" }}
      >
        {submitting ? "Starting…" : SUBMIT_LABEL[mode]}
      </button>
    </form>
  );
}
