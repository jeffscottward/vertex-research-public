import { PageHeader } from "@darkfactory/ui";

import { DeepValueWorkspace } from "../../../components/portal/deep-value-workspace.tsx";

export const metadata = { title: "Deep value screen" };

export default function DeepValuePage() {
  return (
    <div className="space-y-8">
      <PageHeader title="Deep value screen" />
      <DeepValueWorkspace />
    </div>
  );
}
