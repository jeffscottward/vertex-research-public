import { PageHeader } from "@darkfactory/ui";

import { ForwardDriftWorkspace } from "../../../components/portal/forward-drift-workspace.tsx";

export const metadata = { title: "Forward drift" };

export default function ForwardDriftPage() {
  return (
    <div className="space-y-8">
      <PageHeader title="Forward drift" />
      <ForwardDriftWorkspace />
    </div>
  );
}
