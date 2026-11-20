"use client";

import Link from "next/link";

import {
  isRouteExposed,
  OPERATOR_PORTAL_ROUTE_PATHS,
  PORTAL_SIDEBAR_GROUPS,
} from "../../lib/navigation.ts";
import type { DashboardSummaryFailure } from "../../features/dashboard/view-model.ts";
import { AccountGlance, type AccountGlanceProps } from "./account-glance.tsx";
import { OperatorAccessRequired } from "./agent-ops-client.tsx";
import {
  MissionControl,
  type MissionControlProps,
  SummaryFailureNote,
  type SummaryState,
  summaryFailureSentence,
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

// Summary state as the member view reads it: the same shape as MissionControl's.
type MemberSummaryState = SummaryState;

const MEMBER_STILL_WORKS = "The pages below still open.";

// One sentence: state, cause and time (UTC), and what to do. Pages below open either way.
export const summaryFailureText = (
  failure: DashboardSummaryFailure | undefined
): string => summaryFailureSentence(failure, MEMBER_STILL_WORKS);

// Non-operator landing: no operator-only request is sent, so no 403s.
const MemberMissionControl = ({
  summaryState,
}: {
  readonly summaryState: MemberSummaryState | undefined;
}) => (
  <div className="space-y-4" data-dashboard-view="member">
    <SummaryFailureNote
      stillWorks={MEMBER_STILL_WORKS}
      summaryState={summaryState}
    />
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
export interface DashboardViewsProps
  extends Omit<MissionControlProps, "summaryState"> {
  readonly account?: AccountGlanceProps;
  /** From the server session. Only operators get the account card and agent work. */
  readonly operator?: boolean;
  readonly summaryState?: MemberSummaryState;
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
