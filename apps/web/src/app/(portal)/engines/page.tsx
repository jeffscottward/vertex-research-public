import { PageHeader } from "@darkfactory/ui";

import { EnginesWorkspace } from "../../../components/portal/engines-workspace.tsx";

export const metadata = { title: "Engines" };

export default function EnginesPage() {
  return (
    <div className="space-y-8">
      <PageHeader title="Engines" />
      <EnginesWorkspace />
    </div>
  );
}
