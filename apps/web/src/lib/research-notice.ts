// The research notice of the portal shell: one sentence, printed once under the page content.
// It is a trading-safety notice, so it must be true on the page that shows it. A route that holds
// an order, arming, broker-recovery or approval control does not get it. research-notice.test.ts
// walks the imports of every portal route file and fails when a route with such a control is
// missing from EXECUTION_CONTROL_ROUTES. It also reads every source file and fails when a file
// that calls an order, arming, recovery or approval procedure is missing from the lists below.

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
 * A shared client file that holds an approval call beside read calls, with the exports that reach
 * the call. Pages get the control only through these exports, so a file that names one of them
 * belongs in EXECUTION_CONTROL_MODULES.
 */
export const EXECUTION_GATEWAY_EXPORTS: Readonly<
  Record<string, readonly string[]>
> = {
  "components/portal/agent-ops-client.tsx": [
    "createBrowserDeploymentRequestsGateway",
  ],
};

/**
 * True when the shell prints the research notice on this portal path. An unknown path (null)
 * gets no notice: the sentence is printed only where the route is known to hold no such control.
 */
export const researchNoticeApplies = (pathname: string | null): boolean =>
  pathname !== null &&
  !EXECUTION_CONTROL_ROUTES.some(
    (route) => pathname === route || pathname.startsWith(`${route}/`)
  );
