import { PageHeader } from "@darkfactory/ui";

import { PapersWorkspace } from "../../../components/portal/papers-workspace.tsx";

export const metadata = { title: "Papers" };

export default function PapersPage() {
  return (
    <div className="space-y-8">
      <PageHeader title="Papers" />
      <PapersWorkspace />
    </div>
  );
}
