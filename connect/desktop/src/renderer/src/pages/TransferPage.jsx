import { useState } from "react";
import { ArrowRight, File, Folder, FolderOpen, Laptop, Plus, X } from "lucide-react";
import { Button, IconButton, Mono, SectionLabel } from "@peerpayload/ui";

import TransferRow from "../components/TransferRow.jsx";
import { ACTIVE, errorMessage, lastTransferLabel, plural, shortId, sizeLabel } from "../lib/util";

// The main workflow: choose what to send (drop, browse, or the two
// buttons), choose who to send it to, start. Running transfers below.
export default function TransferPage({ contacts, transfers, rates, onNavigate }) {
  const [items, setItems] = useState([]); // [{ path, name, size, files, folder, missing }]
  const [recipient, setRecipient] = useState(null);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState(null);
  const [starting, setStarting] = useState(false);

  const paired = contacts.filter((c) => c.status === "paired");
  const pending = contacts.filter((c) => c.status !== "paired");
  const active = transfers.filter((t) => ACTIVE.has(t.state) && !(t.direction === "in" && t.state === "offered"));
  const chosen = paired.find((c) => c.fp === recipient) ?? null;

  async function addPaths(paths) {
    const fresh = paths.filter((p) => !items.some((i) => i.path === p));

    if (!fresh.length)
      return;

    const described = await window.connect.describePaths(fresh);
    const missing = described.filter((d) => d.missing);

    setError(missing.length ? `Can't read ${missing.map((d) => d.name).join(", ")}` : null);
    setItems((prev) => [...prev, ...described.filter((d) => !d.missing)]);
  }

  async function pick(mode) {
    addPaths(await window.connect.pickPaths(mode));
  }

  function onDrop(event) {
    event.preventDefault();
    setDragging(false);
    addPaths([...event.dataTransfer.files].map((f) => window.connect.pathForFile(f)).filter(Boolean));
  }

  async function start() {
    setStarting(true);
    setError(null);

    try {
      // Resolves when the transfer ends; progress arrives as events.
      window.connect.send(chosen.fp, items.map((i) => i.path)).catch((err) => setError(errorMessage(err)));
      setItems([]);
    } finally {
      setStarting(false);
    }
  }

  const totalBytes = items.reduce((n, i) => n + i.size, 0);

  return (
    <div className="flex min-h-full flex-col">
      <div className="grid flex-1 grid-cols-1 border-b border-[var(--color-border)] lg:grid-cols-[minmax(0,1fr)_320px]">
        {/* What to send */}
        <section className="flex flex-col px-8 py-7" aria-labelledby="send-heading">
          <SectionLabel>File transfer</SectionLabel>
          <h1 id="send-heading" className="mt-4 text-[26px] font-bold tracking-tight">
            Send files. Keep control.
          </h1>
          <p className="mt-1 font-mono text-[13px] text-[var(--color-ink-secondary)]">Peer-to-peer file transfer. No unnecessary detours.</p>

          <div
            role="button"
            tabIndex={0}
            aria-label="Drop files or folders here, or press Enter to choose files"
            onClick={() => pick("files")}
            onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), pick("files"))}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            className={`mt-6 flex min-h-44 flex-1 cursor-pointer flex-col items-center justify-center rounded-[var(--radius-md)] border border-dashed px-6 py-8 text-center transition-colors duration-100 ${dragging ? "border-[var(--color-accent)] bg-[var(--color-accent-soft)]" : "border-[var(--color-border-strong)] hover:bg-[var(--color-surface)]"}`}
          >
            <FolderOpen size={34} strokeWidth={1.25} className="text-[var(--color-ink-secondary)]" aria-hidden="true" />
            <p className="mt-3 text-sm font-medium">{dragging ? "Drop to add" : "Drop files or folders here"}</p>
            <p className="mt-1 font-mono text-xs text-[var(--color-ink-muted)]">or click to browse</p>
          </div>

          <div className="mt-4 grid grid-cols-2 gap-3">
            <Button variant="secondary" icon={File} onClick={() => pick("files")}>
              Select files
            </Button>
            <Button variant="secondary" icon={Folder} onClick={() => pick("folder")}>
              Select folder
            </Button>
          </div>

          {items.length > 0 && (
            <div className="mt-5">
              <div className="flex items-baseline justify-between">
                <SectionLabel>Selected</SectionLabel>
                <Mono className="text-[var(--color-ink-secondary)]">
                  {plural(items.reduce((n, i) => n + i.files, 0), "file")} · {sizeLabel(totalBytes)}
                </Mono>
              </div>
              <ul className="mt-2 border-y border-[var(--color-border)]" aria-label="Selected files">
                {items.map((item) => (
                  <li key={item.path} className="flex items-center gap-3 border-b border-[var(--color-border)] py-2 last:border-b-0">
                    {item.folder ? <Folder size={16} strokeWidth={1.5} aria-hidden="true" /> : <File size={16} strokeWidth={1.5} aria-hidden="true" />}
                    <span className="min-w-0 flex-1 truncate text-sm" title={item.path}>
                      {item.name}
                    </span>
                    <Mono className="text-[var(--color-ink-secondary)]">
                      {item.folder ? `${plural(item.files, "file")} · ` : ""}
                      {sizeLabel(item.size)}
                    </Mono>
                    <IconButton icon={X} label={`Remove ${item.name}`} onClick={() => setItems((prev) => prev.filter((i) => i.path !== item.path))} />
                  </li>
                ))}
              </ul>
            </div>
          )}
          {error && (
            <p className="mt-3 text-sm text-[var(--color-critical)]" role="alert">
              {error}
            </p>
          )}
        </section>

        {/* Who to send it to */}
        <section className="flex flex-col border-t border-[var(--color-border)] bg-[var(--color-surface)] lg:border-l lg:border-t-0" aria-labelledby="recipient-label">
          <div className="flex items-center justify-between px-5 pb-3 pt-7">
            <SectionLabel as="h2">
              <span id="recipient-label">Recipient</span>
            </SectionLabel>
            <Mono className="text-[var(--color-ink-muted)]">{paired.length}</Mono>
          </div>

          {paired.length === 0 ? (
            <div className="px-5 py-4">
              <p className="text-sm text-[var(--color-ink-secondary)]">No paired devices yet. Pair one to send it files.</p>
              <Button variant="secondary" size="sm" icon={Plus} className="mt-3" onClick={() => onNavigate("devices")}>
                Pair a device
              </Button>
            </div>
          ) : (
            <ul role="radiogroup" aria-labelledby="recipient-label" className="border-t border-[var(--color-border)]">
              {paired.map((c) => {
                const selected = c.fp === recipient;

                return (
                  <li key={c.fp}>
                    <button
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      onClick={() => setRecipient(c.fp)}
                      data-testid={`recipient-${c.name}`}
                      className={`relative flex w-full items-center gap-3 border-b border-[var(--color-border)] px-5 py-3 text-left transition-colors duration-100 ${selected ? "bg-[var(--color-accent-soft)]" : "hover:bg-[var(--color-surface-2)]"}`}
                    >
                      {selected && <span className="absolute inset-y-0 left-0 w-0.5 bg-[var(--color-accent)]" aria-hidden="true" />}
                      <Laptop size={20} strokeWidth={1.5} className="shrink-0 text-[var(--color-ink-secondary)]" aria-hidden="true" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">{c.name}</span>
                        <span className="block truncate font-mono text-[11px] text-[var(--color-ink-muted)]">
                          {shortId(c.fp)} · {lastTransferLabel(transfers, c.fp)}
                        </span>
                      </span>
                      <span
                        className={`h-3.5 w-3.5 shrink-0 rounded-full border ${selected ? "border-[4px] border-[var(--color-accent)]" : "border-[var(--color-border-strong)]"}`}
                        aria-hidden="true"
                      />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {pending.length > 0 && (
            <p className="px-5 py-3 text-xs text-[var(--color-ink-secondary)]">
              Waiting for {pending.map((c) => c.name).join(", ")} to accept your pairing request.
            </p>
          )}

          <div className="mt-auto border-t border-[var(--color-border)] p-5">
            <Button variant="primary" iconAfter={ArrowRight} className="w-full" disabled={!items.length || !chosen || starting} onClick={start}>
              Start transfer
            </Button>
            <p className="mt-2 text-center text-xs text-[var(--color-ink-secondary)]">
              {!items.length ? "Choose files or a folder to send" : !chosen ? "Choose who to send to" : `${sizeLabel(totalBytes)} to ${chosen.name}, encrypted end to end`}
            </p>
          </div>
        </section>
      </div>

      {active.length > 0 && (
        <section className="px-8 py-6" aria-labelledby="active-heading">
          <SectionLabel as="h2">
            <span id="active-heading">In progress · {active.length}</span>
          </SectionLabel>
          <ul className="mt-2">
            {active.map((t) => (
              <TransferRow key={t.transferId} transfer={t} rate={rates.get(t.transferId)} />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
