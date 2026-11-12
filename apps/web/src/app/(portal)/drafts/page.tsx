import { PageHeader } from "@darkfactory/ui";

import { GoLiveDraftQueue } from "../../../components/portal/golive-draft-queue.tsx";

export const metadata = { title: "Order drafts" };

export default function OrderDraftsPage() {
  return (
    <div className="space-y-8">
      <PageHeader title="Order drafts" />
      <GoLiveDraftQueue />
    </div>
  );
}
