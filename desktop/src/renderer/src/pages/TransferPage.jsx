import { useState } from "react";
import { ArrowRight, File, Folder, FolderOpen, UserRound, X } from "lucide-react";
import { Button, IconButton, Mono, SectionLabel, Select } from "@peerpayload/ui";

import LiveTransfer from "../components/LiveTransfer.jsx";

// 1 MiB by default: with the engine's own 64 KiB default most of the time
// goes to waiting on per-chunk acks (12-17 MiB/s vs ~100+ MiB/s at 1 MiB
// on a fast network). Receivers of any version accept any of these.
const DEFAULT_CHUNK_SIZE = 1024 * 1024;

const CHUNK_SIZE_OPTIONS = [
  { label: "64 KiB", value: 64 * 1024 },
  { label: "256 KiB", value: 256 * 1024 },
  { label: "Default (1 MiB)", value: DEFAULT_CHUNK_SIZE },
  { label: "4 MiB", value: 4 * 1024 * 1024 },
  { label: "8 MiB (fastest, max)", value: 8 * 1024 * 1024 },
];

const baseName = (p) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

// Send one file or folder to one colleague who's online. (One send at a
// time, as the app has always done.)
export default function TransferPage({ d, onShowHistory }) {
  const [filePath, setFilePath] = useState("");
  const [folder, setFolder] = useState(false);
  const [toUsername, setToUsername] = useState("");
  const [chunkSize, setChunkSize] = useState(DEFAULT_CHUNK_SIZE);
  const [dragging, setDragging] = useState(false);
  const [dropNote, setDropNote] = useState(null);

  const sending = Boolean(d.sendState && d.sendState.phase !== "done");
  const colleagues = [...d.directory].sort((a, b) => Number(b.online) - Number(a.online) || a.username.localeCompare(b.username));
  const online = colleagues.filter((u) => u.online).length;
  const chosen = colleagues.find((u) => u.username === toUsername && u.online);

  async function pick(mode) {
    const path = await window.peerpayload.pickFile(mode);

    if (path) {
      setFilePath(path);
      setFolder(mode === "folder");
      setDropNote(null);
    }
  }

  function onDrop(event) {
    event.preventDefault();
    setDragging(false);

    const files = [...event.dataTransfer.files];
    const path = files.length ? window.peerpayload.pathForFile(files[0]) : null;

    if (!path)
      return;

    setFilePath(path);
    // A dropped folder has no type and no extension-based guess; the send
    // works the same either way, this only picks the icon.
    setFolder(files[0].type === "" && !/\.[^\\/]+$/.test(path));
    setDropNote(files.length > 1 ? "One file or folder per transfer: the first one dropped was kept." : null);
  }

  async function start() {
    if (await d.send(filePath, toUsername, chunkSize)) {
      setFilePath("");
      setToUsername("");
    }
  }

  return (
    <div className="flex min-h-full flex-col">
      <div className="grid flex-1 grid-cols-1 border-b border-[var(--color-border)] lg:grid-cols-[minmax(0,1fr)_320px]">
        <section className="flex flex-col px-8 py-7" aria-labelledby="send-heading">
          <SectionLabel>File transfer</SectionLabel>
          <h1 id="send-heading" className="mt-4 text-[26px] font-bold tracking-tight">
            Send files. Keep control.
          </h1>
          <p className="mt-1 font-mono text-[13px] text-[var(--color-ink-secondary)]">Peer-to-peer file transfer. No unnecessary detours.</p>

          <div
            role="button"
            tabIndex={0}
            aria-label="Drop a file or folder here, or press Enter to choose a file"
            onClick={() => pick("file")}
            onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), pick("file"))}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            className={`mt-6 flex min-h-44 flex-1 cursor-pointer flex-col items-center justify-center rounded-[var(--radius-md)] border border-dashed px-6 py-8 text-center transition-colors duration-100 ${dragging ? "border-[var(--color-accent)] bg-[var(--color-accent-soft)]" : "border-[var(--color-border-strong)] hover:bg-[var(--color-surface)]"}`}
          >
            <FolderOpen size={34} strokeWidth={1.25} className="text-[var(--color-ink-secondary)]" aria-hidden="true" />
            <p className="mt-3 text-sm font-medium">{dragging ? "Drop to choose" : "Drop a file or folder here"}</p>
            <p className="mt-1 font-mono text-xs text-[var(--color-ink-muted)]">or click to browse</p>
          </div>

          <div className="mt-4 grid grid-cols-2 gap-3">
            <Button variant="secondary" icon={File} onClick={() => pick("file")}>
              Select file
            </Button>
            <Button variant="secondary" icon={Folder} onClick={() => pick("folder")}>
              Select folder
            </Button>
          </div>

          {filePath && (
            <div className="mt-5">
              <SectionLabel>Selected</SectionLabel>
              <div className="mt-2 flex items-center gap-3 border-y border-[var(--color-border)] py-2" data-testid="selected">
                {folder ? <Folder size={16} strokeWidth={1.5} aria-hidden="true" /> : <File size={16} strokeWidth={1.5} aria-hidden="true" />}
                <span className="max-w-[60%] shrink-0 truncate text-sm" title={filePath}>
                  {baseName(filePath)}
                </span>
                <Mono className="hidden min-w-0 flex-1 truncate text-[var(--color-ink-muted)] md:block" title={filePath}>
                  {filePath}
                </Mono>
                <IconButton icon={X} label="Clear selection" onClick={() => setFilePath("")} disabled={sending} />
              </div>
            </div>
          )}
          {dropNote && <p className="mt-2 text-xs text-[var(--color-ink-secondary)]">{dropNote}</p>}

          <details className="mt-5 text-sm">
            <summary className="cursor-pointer select-none text-[var(--color-ink-secondary)] hover:text-[var(--color-ink)]">Advanced</summary>
            <label className="mt-3 flex items-center gap-3">
              <span className="text-[13px]">Chunk size</span>
              <Select value={chunkSize} onChange={(e) => setChunkSize(Number(e.target.value))} className="w-56" aria-label="Chunk size">
                {CHUNK_SIZE_OPTIONS.map((opt) => (
                  <option key={opt.label} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </Select>
            </label>
          </details>
        </section>

        <section className="flex flex-col border-t border-[var(--color-border)] bg-[var(--color-surface)] lg:border-l lg:border-t-0" aria-labelledby="recipient-label">
          <div className="flex items-center justify-between px-5 pb-3 pt-7">
            <SectionLabel as="h2">
              <span id="recipient-label">Recipient</span>
            </SectionLabel>
            <Mono className="text-[var(--color-ink-muted)]">{online} online</Mono>
          </div>

          {colleagues.length === 0 ? (
            <p className="px-5 py-4 text-sm text-[var(--color-ink-secondary)]">No colleagues in the directory yet.</p>
          ) : (
            <ul role="radiogroup" aria-labelledby="recipient-label" className="min-h-0 flex-1 overflow-y-auto border-t border-[var(--color-border)]">
              {colleagues.map((u) => {
                const selected = u.username === toUsername;

                return (
                  <li key={u.username}>
                    <button
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      disabled={!u.online}
                      onClick={() => setToUsername(u.username)}
                      data-testid={`recipient-${u.username}`}
                      title={u.online ? undefined : `${u.username} is offline: they need the app open to receive`}
                      className={`relative flex w-full items-center gap-3 border-b border-[var(--color-border)] px-5 py-3 text-left transition-colors duration-100 disabled:cursor-not-allowed ${selected ? "bg-[var(--color-accent-soft)]" : "enabled:hover:bg-[var(--color-surface-2)]"}`}
                    >
                      {selected && <span className="absolute inset-y-0 left-0 w-0.5 bg-[var(--color-accent)]" aria-hidden="true" />}
                      <UserRound size={20} strokeWidth={1.5} className={`shrink-0 ${u.online ? "text-[var(--color-ink-secondary)]" : "text-[var(--color-ink-muted)]"}`} aria-hidden="true" />
                      <span className="min-w-0 flex-1">
                        <span className={`block truncate text-sm font-medium ${u.online ? "" : "text-[var(--color-ink-muted)]"}`}>{u.username}</span>
                        <span className="flex items-center gap-1.5 font-mono text-[11px] text-[var(--color-ink-muted)]">
                          <span
                            className="inline-block h-1.5 w-1.5 rounded-full"
                            style={u.online ? { background: "var(--color-good)" } : { boxShadow: "inset 0 0 0 1px var(--color-ink-muted)" }}
                            aria-hidden="true"
                          />
                          {u.online ? "Online" : "Offline"}
                        </span>
                      </span>
                      {u.online && (
                        <span
                          className={`h-3.5 w-3.5 shrink-0 rounded-full border ${selected ? "border-[4px] border-[var(--color-accent)]" : "border-[var(--color-border-strong)]"}`}
                          aria-hidden="true"
                        />
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          <div className="mt-auto border-t border-[var(--color-border)] p-5">
            <Button variant="primary" iconAfter={ArrowRight} className="w-full" disabled={!filePath || !chosen || sending} onClick={start}>
              Start transfer
            </Button>
            <p className="mt-2 text-center text-xs text-[var(--color-ink-secondary)]">
              {sending ? "One transfer at a time: this one's still running" : !filePath ? "Choose a file or folder to send" : !chosen ? "Choose a colleague who's online" : `To ${chosen.username}, encrypted in transit`}
            </p>
          </div>
        </section>
      </div>

      {(d.sendState || d.sendError) && (
        <section className="px-8 py-6" aria-labelledby="sending-heading">
          <div className="flex items-baseline justify-between">
            <SectionLabel as="h2">
              <span id="sending-heading">{d.sendState?.phase === "done" ? "Last transfer" : "In progress"}</span>
            </SectionLabel>
            <button type="button" onClick={onShowHistory} className="text-xs text-[var(--color-ink-secondary)] underline-offset-2 hover:underline">
              All transfers
            </button>
          </div>
          {d.sendError ? (
            <p className="mt-3 text-sm text-[var(--color-critical)]" role="alert">
              {d.sendError}
            </p>
          ) : (
            <div className="mt-1 border-b border-[var(--color-border)]">
              <LiveTransfer direction="out" peer={d.sentTo} state={d.sendState} progress={d.progress[d.sendState.transferId]} testId="send" />
            </div>
          )}
        </section>
      )}
    </div>
  );
}
