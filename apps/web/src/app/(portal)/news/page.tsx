import { PageHeader } from "@darkfactory/ui";

import { MarketNewsWorkspace } from "../../../components/portal/market-news-workspace.tsx";

export const metadata = { title: "News monitor" };

export default function NewsPage() {
  return (
    <div className="space-y-8">
      <PageHeader title="News monitor" />
      <MarketNewsWorkspace />
    </div>
  );
}
