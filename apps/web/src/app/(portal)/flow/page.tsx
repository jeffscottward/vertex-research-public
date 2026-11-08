import { PageHeader } from "@darkfactory/ui";

import { FlowWorkspace } from "../../../components/portal/flow-workspace.tsx";

export const metadata = { title: "Flow" };

export default function FlowPage() {
  return (
    <div className="space-y-8">
      <PageHeader title="Flow" />
      <FlowWorkspace />
    </div>
  );
}
