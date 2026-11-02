import { headers } from "next/headers";

import { PortfolioTabs } from "../../../components/portal/portfolio-tabs.tsx";
import { PortfolioWorkspace } from "../../../features/experience/portfolio.tsx";
import { getRequestPortalSession } from "../../../lib/request-portal-session.ts";

export const metadata = { title: "Portfolio" };
export default async function PortfolioPage() {
  const requestHeaders = await headers();
  // Same cached lookup as the portal layout; the ibkr-monitor sections are operator-only.
  const session = await getRequestPortalSession(
    requestHeaders.get("cookie"),
    requestHeaders.get("cf-connecting-ip")
  );
  return (
    <PortfolioTabs
      operator={session?.isOperator === true}
      projection={<PortfolioWorkspace />}
    />
  );
}
