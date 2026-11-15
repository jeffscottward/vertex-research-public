import { PageHeader } from "@darkfactory/ui";

import { BacktestsWorkspace } from "../../../components/portal/backtests-workspace.tsx";
import { FilterStudiesSection } from "../../../components/portal/filter-studies-section.tsx";
import { QuantLabPanel } from "../../../components/portal/quant-lab-panel.tsx";

export const metadata = { title: "Backtests" };

export default function BacktestsPage() {
  return (
    <div className="space-y-8">
      <PageHeader title="Backtests" />
      <BacktestsWorkspace />
      <QuantLabPanel />
      <FilterStudiesSection />
    </div>
  );
}
