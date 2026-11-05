import { PageHeader } from "@darkfactory/ui";

import { SectorRotationWorkspace } from "../../../components/portal/sector-rotation-workspace.tsx";

export const metadata = { title: "Sector rotation" };

export default function SectorRotationPage() {
  return (
    <div className="space-y-8">
      <PageHeader title="Sector rotation" />
      <SectorRotationWorkspace />
    </div>
  );
}
