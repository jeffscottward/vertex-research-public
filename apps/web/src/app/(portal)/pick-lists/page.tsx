import { PageHeader } from "@darkfactory/ui";

import { PickListsWorkspace } from "../../../components/portal/pick-lists-workspace.tsx";

export const metadata = { title: "Pick lists" };

export default function PickListsPage() {
  return (
    <div className="space-y-8">
      <PageHeader title="Pick lists" />
      <PickListsWorkspace />
    </div>
  );
}
