import { AgentModelRunDetail } from "../../../../../components/portal/agent-model-run-detail.tsx";

type Params = Promise<{ id: string }>;

export const metadata = { title: "Model run" };

// The run is loaded client side through agentModelRuns.get, which enforces operator access.
export default async function AgentModelRunPage({
  params,
}: {
  readonly params: Params;
}) {
  const { id } = await params;
  return <AgentModelRunDetail runId={decodeURIComponent(id)} />;
}
