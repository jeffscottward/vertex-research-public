import { MarketContextPage } from "../../../components/portal/market-context-page.tsx";
import { OpenbbMarketsSection } from "../../../features/openbb/openbb-panels.tsx";

export const metadata = { title: "Market context" };

export default function MarketsPage() {
  return (
    <div className="space-y-8">
      <MarketContextPage />
      <OpenbbMarketsSection />
    </div>
  );
}
