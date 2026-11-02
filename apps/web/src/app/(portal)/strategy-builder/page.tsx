import { PageHeader } from "@darkfactory/ui";

import { StrategyBuilderWorkspace } from "../../../components/portal/strategy-builder-workspace.tsx";

export const metadata = { title: "Strategy builder" };

export default function StrategyBuilderPage() {
  return (
    <div className="space-y-8">
      <PageHeader title="Strategy builder" />
      <StrategyBuilderWorkspace />
    </div>
  );
}
