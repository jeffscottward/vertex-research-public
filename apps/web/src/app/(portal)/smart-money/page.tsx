import { parseSmartMoneyParams } from "../../../components/portal/smart-money-params.ts";
import { SmartMoneyWorkspace } from "../../../components/portal/smart-money-workspace.tsx";

export const metadata = { title: "Smart money" };

type SearchParams = Promise<
  Readonly<Record<string, string | readonly string[] | undefined>>
>;

/** `?sessions=&sort=&ticker=` restore the ranking filters (the server applies them); the workspace renders the header and keeps the URL in sync. */
export default async function SmartMoneyPage({
  searchParams,
}: Readonly<{ searchParams: SearchParams }>) {
  return (
    <SmartMoneyWorkspace initial={parseSmartMoneyParams(await searchParams)} />
  );
}
