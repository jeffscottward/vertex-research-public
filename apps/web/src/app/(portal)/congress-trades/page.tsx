import { parseCongressTradesParams } from "../../../components/portal/congress-trades-params.ts";
import { CongressTradesWorkspace } from "../../../components/portal/congress-trades-workspace.tsx";

export const metadata = { title: "Congress trades" };

type SearchParams = Promise<
  Readonly<Record<string, string | readonly string[] | undefined>>
>;

/** `?days=&chamber=&ticker=&member=` restore the feed filters (the server applies them); the workspace renders the header and keeps the URL in sync. */
export default async function CongressTradesPage({
  searchParams,
}: Readonly<{ searchParams: SearchParams }>) {
  return (
    <CongressTradesWorkspace
      initial={parseCongressTradesParams(await searchParams)}
    />
  );
}
