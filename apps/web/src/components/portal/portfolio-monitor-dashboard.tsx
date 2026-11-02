"use client";

import Link from "next/link";

import {
  isRouteExposed,
  OPERATOR_PORTAL_ROUTE_PATHS,
  PORTAL_SIDEBAR_GROUPS,
} from "../../lib/navigation.ts";
import { AccountGlance, type AccountGlanceProps } from "./account-glance.tsx";
import { OperatorAccessRequired } from "./agent-ops-client.tsx";
import {
  MissionControl,
  type MissionControlProps,
} from "./mission-control.tsx";

/** Sidebar pages a non-operator can open, except Mission control itself. */
export const memberDestinations = () => {
  const operatorOnly: readonly string[] = OPERATOR_PORTAL_ROUTE_PATHS;
  return PORTAL_SIDEBAR_GROUPS.flatMap((group) => group.items).filter(
    (item) =>
      item.href !== "/dashboard" &&
      !operatorOnly.includes(item.href) &&
      isRouteExposed(item.href)
  );
};

// Non-operator landing: no operator-only request is sent, so no 403s.
const MemberMissionControl = ({
  summaryState,
}: {
  readonly summaryState: MissionControlProps["summaryState"] | undefined;
}) => (
  <div className="space-y-4" data-dashboard-view="member">
    {summaryState?.type === "error" ? (
      <p className="text-muted-foreground text-xs" role="note">
        Workspace session summary unavailable.
      </p>
    ) : null}
    <OperatorAccessRequired feature="mission-control" />
    <section aria-labelledby="member-destinations" className="space-y-2">
      <h2 className="font-medium text-base" id="member-destinations">
        Pages you can open
      </h2>
      <ul className="grid gap-1 sm:grid-cols-2 lg:grid-cols-3">
        {memberDestinations().map((item) => {
          const Icon = item.icon;
          return (
            <li key={item.href}>
              <Link
                className="flex min-h-11 items-center gap-2 rounded-md px-2 text-sm hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                href={item.href}
                prefetch={false}
              >
                <Icon aria-hidden="true" className="size-4 shrink-0" />
                <span>{item.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  </div>
);

// Agent work keeps the MissionControl props (gateway, summaryState); `account` goes to the
// account glance card.
export interface DashboardViewsProps extends MissionControlProps {
  readonly account?: AccountGlanceProps;
  /** From the server session. Only operators get the account card and agent work. */
  readonly operator?: boolean;
}

// Mission control: operators get the read-only IBKR account card (same reader as /portfolio)
// above agent work. Non-operators get their own view.
export const DashboardViews = ({
  account,
  operator = false,
  ...agentProps
}: DashboardViewsProps) => {
  if (!operator)
    return <MemberMissionControl summaryState={agentProps.summaryState} />;
  return (
    <div className="space-y-8" data-dashboard-view="operator">
      <AccountGlance {...account} />
      <MissionControl {...agentProps} />
    </div>
  );
};
