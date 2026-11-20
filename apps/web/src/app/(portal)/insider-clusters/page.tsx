import { parseInsiderClustersParams } from "../../../components/portal/insider-clusters-params.ts";
import { InsiderClustersWorkspace } from "../../../components/portal/insider-clusters-workspace.tsx";

export const metadata = { title: "Insider clusters" };

type SearchParams = Promise<
  Readonly<Record<string, string | readonly string[] | undefined>>
>;

/** `?days=` restores the window; the workspace keeps the URL in sync. */
export default async function InsiderClustersPage({
  searchParams,
}: Readonly<{ searchParams: SearchParams }>) {
  return (
    <InsiderClustersWorkspace
      initial={parseInsiderClustersParams(await searchParams)}
    />
  );
}
