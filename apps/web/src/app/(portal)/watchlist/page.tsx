import { PageHeader } from "@darkfactory/ui";

import { WatchlistWorkspace } from "../../../components/portal/watchlist-workspace.tsx";

export const metadata = { title: "Watchlist" };

export default function WatchlistPage() {
  return (
    <div className="space-y-8">
      <PageHeader title="Watchlist" />
      <WatchlistWorkspace />
    </div>
  );
}
