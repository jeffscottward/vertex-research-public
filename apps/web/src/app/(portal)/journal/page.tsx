import { PageHeader } from "@darkfactory/ui";

import { TradeJournal } from "../../../components/portal/trade-journal.tsx";
import { resolveJournalSource } from "../../../components/portal/trade-journal-source.ts";

export const metadata = { title: "Trade journal" };

export default function JournalPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        description="Fills, realized P&L and commissions from the IBKR execution window. Read-only."
        title="Trade journal"
      />
      <TradeJournal source={resolveJournalSource()} />
    </div>
  );
}
