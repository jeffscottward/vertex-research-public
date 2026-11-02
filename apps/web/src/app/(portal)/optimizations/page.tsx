import { PageHeader } from "@darkfactory/ui";

import { OptimizationsWorkspace } from "../../../components/portal/optimizations-workspace.tsx";

export const metadata = { title: "Optimizations" };

export default function OptimizationsPage() {
  return (
    <div className="space-y-8">
      <PageHeader title="Optimizations" />
      <OptimizationsWorkspace />
    </div>
  );
}
