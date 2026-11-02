import { PageHeader } from "@darkfactory/ui";

import { BacktestSweepsWorkspace } from "../../../components/portal/backtest-sweeps-workspace.tsx";

export const metadata = { title: "Parameter sweeps" };

export default function BacktestSweepsPage() {
  return (
    <div className="space-y-8">
      <PageHeader title="Parameter sweeps" />
      <BacktestSweepsWorkspace />
    </div>
  );
}
