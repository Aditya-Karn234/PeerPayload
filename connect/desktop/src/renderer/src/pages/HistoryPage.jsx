import { Eraser } from "lucide-react";
import { Button, SectionLabel, Tabs } from "@peerpayload/ui";

import TransferRow from "../components/TransferRow.jsx";
import { tabOf } from "../lib/util";

const EMPTY = {
  active: "Nothing in progress. Paused or interrupted transfers wait here until you resume them.",
  completed: "Finished transfers appear here.",
  failed: "Nothing has failed.",
};

// `tab` is kept by the App, so accepting an offer can open Active.
export default function HistoryPage({ transfers, rates, tab, onTab: setTab, onClearFinished }) {
  const counts = { active: 0, completed: 0, failed: 0 };

  for (const t of transfers)
    counts[tabOf(t)]++;

  const shown = transfers.filter((t) => tabOf(t) === tab);

  return (
    <div className="px-8 py-7">
      <SectionLabel>Transfers</SectionLabel>
      <div className="mt-4 flex items-end justify-between gap-4">
        <div className="flex-1">
          <Tabs
            label="Transfer status"
            value={tab}
            onChange={setTab}
            items={[
              { id: "active", label: "Active", count: counts.active },
              { id: "completed", label: "Completed", count: counts.completed },
              { id: "failed", label: "Failed", count: counts.failed },
            ]}
          />
        </div>
        {tab !== "active" && shown.length > 0 && (
          <Button variant="ghost" size="sm" icon={Eraser} onClick={onClearFinished} className="mb-1.5">
            Clear finished
          </Button>
        )}
      </div>

      {shown.length === 0 ? (
        <p className="mt-6 text-sm text-[var(--color-ink-secondary)]">{EMPTY[tab]}</p>
      ) : (
        <ul className="mt-1" aria-label={`${tab} transfers`}>
          {shown.map((t) => (
            <TransferRow key={t.transferId} transfer={t} rate={rates.get(t.transferId)} />
          ))}
        </ul>
      )}
    </div>
  );
}
