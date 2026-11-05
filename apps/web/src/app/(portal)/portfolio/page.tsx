import { headers } from "next/headers";

import { PortfolioTabs } from "../../../components/portal/portfolio-tabs.tsx";
import { PortfolioWorkspace } from "../../../features/experience/portfolio.tsx";
import { getRequestPortalSession } from "../../../lib/request-portal-session.ts";

export const metadata = { title: "Portfolio" };

type SearchParams = Promise<
  Readonly<Record<string, string | readonly string[] | undefined>>
>;

/** `?tab=<view>` opens that Portfolio view on the first paint (StickyTabs keeps it in sync). */
export default async function PortfolioPage({
  searchParams,
}: Readonly<{ searchParams: SearchParams }>) {
  const tab = (await searchParams)["tab"];
  const requestHeaders = await headers();
  // Same cached lookup as the portal layout; the ibkr-monitor sections are operator-only.
  const session = await getRequestPortalSession(
    requestHeaders.get("cookie"),
    requestHeaders.get("cf-connecting-ip")
  );
  return (
    <PortfolioTabs
      initialTab={typeof tab === "string" ? tab : undefined}
      operator={session?.isOperator === true}
      projection={<PortfolioWorkspace />}
    />
  );
}
