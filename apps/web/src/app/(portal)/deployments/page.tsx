import { PageHeader } from "@darkfactory/ui";

import { DeploymentsView } from "../../../components/portal/deployments-view.tsx";

export const metadata = { title: "Deployments" };

export default function DeploymentsPage() {
  return (
    <div className="space-y-8">
      <PageHeader title="Deployments" />
      <DeploymentsView />
    </div>
  );
}
