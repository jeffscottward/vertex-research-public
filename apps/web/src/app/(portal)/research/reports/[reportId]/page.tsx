import { ResearchReportDetail } from "../../../../../components/portal/research-reports.tsx";

type Params = Promise<{ reportId: string }>;

export const metadata = { title: "Research dossier" };

// Datasets are loaded client side through researchReports.dataset, which enforces operator access.
export default async function ResearchReportPage({
  params,
}: {
  readonly params: Params;
}) {
  const { reportId } = await params;
  let id = reportId;
  try {
    id = decodeURIComponent(reportId);
  } catch {
    // A malformed escape stays as written; the API answers NOT_FOUND for it.
  }
  return <ResearchReportDetail reportId={id} />;
}
