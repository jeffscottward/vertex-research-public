import { PageHeader } from "@darkfactory/ui";

import { RotationMatrixWorkspace } from "../../../components/portal/rotation-matrix-workspace.tsx";

export const metadata = { title: "Rotation matrix" };

export default function RotationMatrixPage() {
  return (
    <div className="space-y-8">
      <PageHeader title="Rotation matrix" />
      <RotationMatrixWorkspace />
    </div>
  );
}
