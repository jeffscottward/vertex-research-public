import { PageHeader } from "@darkfactory/ui";

import { BasketWatchlistSection } from "../../../components/portal/basket-watchlist-section.tsx";
import { WatchlistWorkspace } from "../../../components/portal/watchlist-workspace.tsx";

export const metadata = { title: "Watchlist" };

export default function WatchlistPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        description="Tickers you track, with buy zones and notes."
        title="Watchlist"
      />
      <BasketWatchlistSection />
      <WatchlistWorkspace />
    </div>
  );
}
