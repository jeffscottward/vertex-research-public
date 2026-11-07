import { PageHeader } from "@darkfactory/ui";
import { headers } from "next/headers";

import { BasketWatchlistSection } from "../../../components/portal/basket-watchlist-section.tsx";
import { resolveJournalSource } from "../../../components/portal/trade-journal-source.ts";
import { WatchlistWorkspace } from "../../../components/portal/watchlist-workspace.tsx";
import { getRequestPortalSession } from "../../../lib/request-portal-session.ts";

export const metadata = { title: "Watchlist" };

export default async function WatchlistPage() {
  const requestHeaders = await headers();
  // Same cached lookup as the portal layout; the operator-only tabs send nothing otherwise.
  const session = await getRequestPortalSession(
    requestHeaders.get("cookie"),
    requestHeaders.get("cf-connecting-ip")
  );
  return (
    <div className="space-y-6">
      <PageHeader
        description="Tickers you track, with buy zones and notes."
        title="Watchlist"
      />
      <BasketWatchlistSection />
      <WatchlistWorkspace
        operator={session?.isOperator === true}
        portfolioSource={resolveJournalSource()}
      />
    </div>
  );
}
