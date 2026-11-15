import { PageHeader } from "@darkfactory/ui";

import { PlaysWorkspace } from "../../../components/portal/plays-workspace.tsx";

export const metadata = { title: "Plays" };

export default function PlaysPage() {
  return (
    <div className="space-y-8">
      <PageHeader title="Plays" />
      <PlaysWorkspace />
    </div>
  );
}
