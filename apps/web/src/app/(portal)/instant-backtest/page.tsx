import { PageHeader } from "@darkfactory/ui";

import { InstantBacktestWorkspace } from "../../../components/portal/instant-backtest-workspace.tsx";

export const metadata = { title: "Instant backtest" };

export default function InstantBacktestPage() {
  return (
    <div className="space-y-8">
      <PageHeader title="Instant backtest" />
      <InstantBacktestWorkspace />
    </div>
  );
}
