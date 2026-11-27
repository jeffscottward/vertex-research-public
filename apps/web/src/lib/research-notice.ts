// The research notice of the portal shell: one sentence, printed once under the page content.
// It is a trading-safety notice, so it must be true on the page that shows it. A route that holds
// an order, arming, broker-recovery or approval control does not get it. research-notice.test.ts
// reads the imports of every portal route and fails when a route with such a control is missing
// from EXECUTION_CONTROL_ROUTES.

export const PORTAL_RESEARCH_NOTICE =
  "Research only: nothing here authorizes a trade.";

/** Portal routes with an order, arming, broker-recovery or approval control. */
export const EXECUTION_CONTROL_ROUTES: readonly string[] = [
  "/dashboard",
  "/deployments",
  "/drafts",
  "/portfolio",
];

/**
 * Modules whose import gives a page such a control (paths from apps/web/src). A new client of an
 * order, arming, recovery or approval procedure belongs in this list.
 */
export const EXECUTION_CONTROL_MODULES: readonly string[] = [
  "components/portal/deployment-requests-workspace.tsx",
  "components/portal/golive-draft-queue.tsx",
  "components/portal/ibkr-recovery-client.ts",
  "components/portal/nautilus-arm-client.ts",
  "components/portal/vertex-orders-client.ts",
];

/**
 * True when the shell prints the research notice on this portal path. An unknown path (null)
 * gets no notice: the sentence is printed only where the route is known to hold no such control.
 */
export const researchNoticeApplies = (pathname: string | null): boolean =>
  pathname !== null &&
  !EXECUTION_CONTROL_ROUTES.some(
    (route) => pathname === route || pathname.startsWith(`${route}/`)
  );
