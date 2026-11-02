import { PageHeader } from "@darkfactory/ui";

import { AssistantWorkspace } from "../../../components/portal/assistant-workspace.tsx";

export const metadata = { title: "Assistant" };

export default function AssistantPage() {
  return (
    <div className="space-y-8">
      <PageHeader title="Assistant" />
      <AssistantWorkspace />
    </div>
  );
}
