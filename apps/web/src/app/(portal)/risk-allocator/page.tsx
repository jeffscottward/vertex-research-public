import { PageHeader } from "@darkfactory/ui";

import { RiskAllocatorWorkspace } from "../../../components/portal/risk-allocator-workspace.tsx";

export const metadata = { title: "Risk allocator" };

export default function RiskAllocatorPage() {
  return (
    <div className="space-y-8">
      <PageHeader title="Risk allocator" />
      <RiskAllocatorWorkspace />
    </div>
  );
}
