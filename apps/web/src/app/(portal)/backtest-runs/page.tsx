import { PageHeader } from "@darkfactory/ui";

import { BacktestRunsWorkspace } from "../../../components/portal/backtest-runs-workspace.tsx";

export const metadata = { title: "Backtest runs" };

type SearchParams = Promise<
  Readonly<Record<string, string | readonly string[] | undefined>>
>;

const RUN_ID = /^[\w-]{1,128}$/u;

/** `?run=<id>` opens that run (the parameter sweep page links here after "Run full backtest"). */
export default async function BacktestRunsPage({
  searchParams,
}: Readonly<{ searchParams: SearchParams }>) {
  const run = (await searchParams)["run"];
  return (
    <div className="space-y-8">
      <PageHeader title="Backtest runs" />
      <BacktestRunsWorkspace
        initialRunId={typeof run === "string" && RUN_ID.test(run) ? run : null}
      />
    </div>
  );
}
