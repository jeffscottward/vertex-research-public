import { PageHeader } from "@darkfactory/ui";

import { AutopilotWorkspace } from "../../../components/portal/autopilot-workspace.tsx";

export const metadata = { title: "Autopilot" };

export default function AutopilotPage() {
  return (
    <div className="space-y-8">
      <PageHeader title="Autopilot" />
      <AutopilotWorkspace />
    </div>
  );
}
