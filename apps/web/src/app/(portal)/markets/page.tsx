import { PageHeader } from "@darkfactory/ui";

import { MarketContextWorkspace } from "../../../components/portal/market-context-workspace.tsx";

export const metadata = { title: "Market context" };

export default function MarketsPage() {
  return (
    <div className="space-y-8">
      <PageHeader title="Market context" />
      <MarketContextWorkspace />
    </div>
  );
}
