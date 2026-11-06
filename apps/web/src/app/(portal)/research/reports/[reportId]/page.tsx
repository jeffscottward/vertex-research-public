import { ResearchReportDetail } from "../../../../../components/portal/research-reports.tsx";

type Params = Promise<{ reportId: string }>;
type SearchParams = Promise<
  Readonly<Record<string, string | readonly string[] | undefined>>
>;

export const metadata = { title: "Research dossier" };

// Datasets are loaded client side through researchReports.dataset, which enforces operator access.
// `?tab=<dataset>` opens that dataset on the first paint (StickyTabs keeps it in sync).
export default async function ResearchReportPage({
  params,
  searchParams,
}: {
  readonly params: Params;
  readonly searchParams: SearchParams;
}) {
  const { reportId } = await params;
  const tab = (await searchParams)["tab"];
  let id = reportId;
  try {
    id = decodeURIComponent(reportId);
  } catch {
    // A malformed escape stays as written; the API answers NOT_FOUND for it.
  }
  return (
    <ResearchReportDetail
      initialTab={typeof tab === "string" ? tab : undefined}
      reportId={id}
    />
  );
}
