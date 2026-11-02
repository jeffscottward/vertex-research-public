import { PageHeader } from "@darkfactory/ui";

import { AgentFrameworksSection } from "../../../../components/portal/agent-frameworks-section.tsx";
import { AgentModelBenchmarkWorkspace } from "../../../../components/portal/agent-model-benchmark-workspace.tsx";

export const metadata = { title: "Model benchmark" };

// The benchmark and the framework reference sheets are loaded client side through
// agentModelRuns.benchmark and agentModelRuns.frameworks, which enforce operator access.
export default function AgentModelBenchmarkPage() {
  return (
    <div className="space-y-8">
      <PageHeader title="Model benchmark" />
      <AgentModelBenchmarkWorkspace>
        <AgentFrameworksSection />
      </AgentModelBenchmarkWorkspace>
    </div>
  );
}
