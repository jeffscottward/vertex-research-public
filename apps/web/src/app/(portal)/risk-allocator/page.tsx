import {
  parseRiskAllocatorParams,
  RiskAllocatorWorkspace,
} from "../../../components/portal/risk-allocator-workspace.tsx";

export const metadata = { title: "Risk allocator" };

type SearchParams = Promise<
  Readonly<Record<string, string | readonly string[] | undefined>>
>;

/**
 * `?symbol=` picks the symbol to size; without it the workspace sizes the first watchlist symbol.
 * The workspace renders the header.
 */
export default async function RiskAllocatorPage({
  searchParams,
}: Readonly<{ searchParams: SearchParams }>) {
  const initial = parseRiskAllocatorParams(await searchParams);
  // Keyed by symbol so a same-page link with another (or no) symbol resets the form.
  return (
    <RiskAllocatorWorkspace initial={initial} key={initial.symbol ?? ""} />
  );
}
