import { PageHeader } from "@darkfactory/ui";

import { BacktestsWorkspace } from "../../../components/portal/backtests-workspace.tsx";
import {
  FILTER_STUDY_MODEL,
  FilterStudiesPanel,
} from "../../../components/portal/filter-studies-panel.tsx";
import { QuantLabPanel } from "../../../components/portal/quant-lab-panel.tsx";

export const metadata = { title: "Backtests" };

export default function BacktestsPage() {
  return (
    <div className="space-y-8">
      <PageHeader title="Backtests" />
      <BacktestsWorkspace />
      <QuantLabPanel />
      <FilterStudiesPanel model={FILTER_STUDY_MODEL} />
    </div>
  );
}
