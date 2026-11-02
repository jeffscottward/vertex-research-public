import { PageHeader } from "@darkfactory/ui";

import { PortfolioCombosWorkspace } from "../../../components/portal/portfolio-combos-workspace.tsx";

export const metadata = { title: "Portfolio combos" };

export default function PortfolioCombosPage() {
  return (
    <div className="space-y-8">
      <PageHeader title="Portfolio combos" />
      <PortfolioCombosWorkspace />
    </div>
  );
}
