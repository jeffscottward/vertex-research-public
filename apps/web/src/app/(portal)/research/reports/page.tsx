import { ResearchReportsCatalog } from "../../../../components/portal/research-reports.tsx";

export const metadata = { title: "Research dossiers" };

// The catalog is loaded client side through researchReports.list, which enforces operator access.
export default function ResearchReportsPage() {
  return <ResearchReportsCatalog />;
}
