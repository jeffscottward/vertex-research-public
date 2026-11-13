import { Breadth90Card } from "../../../components/portal/breadth-90-card.tsx";
import { MarketContextPage } from "../../../components/portal/market-context-page.tsx";
import { OwnerMarketNotesCard } from "../../../components/portal/owner-market-notes-card.tsx";
import { OpenbbMarketsSection } from "../../../features/openbb/openbb-panels.tsx";

export const metadata = { title: "Market context" };

export default function MarketsPage() {
  return (
    <div className="space-y-8">
      <MarketContextPage
        belowHeader={
          <>
            <OwnerMarketNotesCard />
            <Breadth90Card />
          </>
        }
      />
      <OpenbbMarketsSection />
    </div>
  );
}
