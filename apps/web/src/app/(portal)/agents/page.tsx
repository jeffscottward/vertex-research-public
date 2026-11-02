import { PageHeader } from "@darkfactory/ui";

import { AgentApiKeysSection } from "../../../components/portal/agent-api-keys-section.tsx";
import { AgentModelRunsWorkspace } from "../../../components/portal/agent-model-runs-workspace.tsx";
import { AgentRunsWorkspace } from "../../../components/portal/agent-runs-workspace.tsx";

export const metadata = { title: "Agent runs" };

export default function AgentsPage() {
  return (
    <div className="space-y-8">
      <PageHeader title="Agent runs" />
      <AgentRunsWorkspace />
      <AgentModelRunsWorkspace />
      <AgentApiKeysSection />
    </div>
  );
}
