import { PageHeader } from "@darkfactory/ui";

import { PriceAlertsWorkspace } from "../../../components/portal/price-alerts-workspace.tsx";
import { SignalAlertsSection } from "../../../components/portal/signal-alerts-section.tsx";

export const metadata = { title: "Price alerts" };

export default function PriceAlertsPage() {
  return (
    <div className="space-y-8">
      <PageHeader title="Price alerts" />
      <PriceAlertsWorkspace />
      <SignalAlertsSection />
    </div>
  );
}
