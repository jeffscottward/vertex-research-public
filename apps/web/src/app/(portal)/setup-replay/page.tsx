import { PageHeader } from "@darkfactory/ui";

import { SetupReplayWorkspace } from "../../../components/portal/setup-replay-workspace.tsx";

export const metadata = { title: "Setup replay" };

export default function SetupReplayPage() {
  return (
    <div className="space-y-8">
      <PageHeader title="Setup replay" />
      <SetupReplayWorkspace />
    </div>
  );
}
