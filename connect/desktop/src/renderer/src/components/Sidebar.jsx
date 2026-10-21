import { ArrowUpFromLine, Clock3, MonitorSmartphone, Settings } from "lucide-react";
import { SidebarNav, StatusLine } from "@peerpayload/ui";

export const PAGES = [
  { id: "transfer", label: "Transfer", icon: ArrowUpFromLine },
  { id: "devices", label: "Devices", icon: MonitorSmartphone },
  { id: "history", label: "History", icon: Clock3 },
  { id: "settings", label: "Settings", icon: Settings },
];

// Real mailbox state only: whether this device can be reached for
// invites and offers right now.
function connectionState(status) {
  if (!status.mailboxUrl)
    return { label: "No mailbox set", detail: "Set one in Settings", tone: "warning" };

  if (status.connected)
    return { label: "Connected", detail: "Can receive", tone: "good" };

  return { label: "Connecting…", detail: "Mailbox", tone: "muted" };
}

export default function Sidebar({ page, onNavigate, status, badges = {} }) {
  return (
    <SidebarNav
      edition="Connect"
      pages={PAGES.map((p) => ({ ...p, badge: badges[p.id] }))}
      current={page}
      onNavigate={onNavigate}
      footer={
        <>
          <StatusLine {...connectionState(status)} testId="connection" />
          <p className="mt-3 truncate pl-4 text-xs text-[var(--color-ink-secondary)]" title={`${status.name} · device ${status.fingerprint}`}>
            {status.name} · <span className="font-mono">{status.fingerprint.slice(0, 8)}</span>
          </p>
        </>
      }
    />
  );
}
