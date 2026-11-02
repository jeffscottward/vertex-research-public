import { PageHeader } from "@darkfactory/ui";

import { CongressTradesWorkspace } from "../../../components/portal/congress-trades-workspace.tsx";

export const metadata = { title: "Congress trades" };

export default function CongressTradesPage() {
  return (
    <div className="space-y-8">
      <PageHeader title="Congress trades" />
      <CongressTradesWorkspace />
    </div>
  );
}
