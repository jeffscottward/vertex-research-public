import { PageHeader } from "@darkfactory/ui";

import { ChartsWorkspace } from "../../../components/portal/charts-workspace.tsx";

export const metadata = { title: "Charts" };

export default function ChartsPage() {
  return (
    <div className="space-y-8">
      <PageHeader title="Charts" />
      <ChartsWorkspace />
    </div>
  );
}
