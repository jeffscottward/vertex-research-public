import { PageHeader } from "@darkfactory/ui";

import { FlowWorkspace } from "../../../components/portal/flow-workspace.tsx";
import { OpenbbShortsPanel } from "../../../features/openbb/openbb-panels.tsx";

export const metadata = { title: "Flow" };

export default function FlowPage() {
  return (
    <div className="space-y-8">
      <PageHeader title="Flow" />
      <FlowWorkspace />
      {/* FINRA/SEC short data exists for the ETF only; the ES view shows SPY too. */}
      <OpenbbShortsPanel symbol="SPY" />
    </div>
  );
}
