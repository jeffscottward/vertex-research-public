"use client";

import type { PortfolioMonitorOutput } from "@darkfactory/api";
import { buttonVariants, cn, Skeleton, StatusBadge } from "@darkfactory/ui";
import Link from "next/link";
import { useState } from "react";

import {
  IbkrRecoveryButton,
  IbkrRecoveryPanel,
  type IbkrRecoveryProps,
  useIbkrRecovery,
} from "./ibkr-recovery-control.tsx";
import {
  NautilusArmControls,
  NautilusArmPanel,
  type NautilusArmProps,
  useNautilusArm,
} from "./nautilus-arm-control.tsx";
import {
  AccountBadge,
  AccountModeAlert,
  Banner,
  FailureState,
  ForbiddenState,
  useNow,
  useSnapshotFeed,
} from "./portfolio-monitor.tsx";
import {
  createBrowserIbkrMonitorGateway,
  type PortfolioMonitorFailure,
  type PortfolioMonitorGateway,
} from "./portfolio-monitor-client.ts";
import {
  ageSeconds,
  clock,
  monitorHealth,
  PNL_TONE_CLASS,
  summaryStats,
} from "./portfolio-monitor-model.ts";

// Mission control account card. It reads the same upstream as /portfolio (ibkr-monitor through
// ibkrMonitor.snapshot), so both pages show one NLV. Read-only for the account: the controls are
// the human IBKR 2FA request, sent only after the operator confirms it, and the Nautilus node
// badge with Arm (dialog) / Disarm (one click).

export const GLANCE_REFRESH_SECONDS = 30;
// The account summary stats the card shows, in this order (labels from summaryStats).
export const GLANCE_STAT_KEYS = [
  "netLiquidation",
  "daily",
  "maintMargin",
] as const;

const NOT_CONFIGURED: PortfolioMonitorFailure = Object.freeze({
  kind: "not-configured",
  code: "NOT_CONFIGURED",
  message: "IBKR_MONITOR_URL is not set on this server",
});

export interface AccountGlanceProps {
  readonly gateway?: PortfolioMonitorGateway;
  // false: the server has no ibkr-monitor address (IBKR_MONITOR_URL); no request is sent.
  readonly configured?: boolean;
  // The human "Send IBKR 2FA request" control. Absent or not configured => not shown.
  readonly recovery?: IbkrRecoveryProps;
  // The Nautilus node badge with Arm / Disarm. Absent or not configured => not shown.
  readonly nautilus?: NautilusArmProps;
}

const GlanceStats = ({
  snapshot,
}: {
  readonly snapshot: PortfolioMonitorOutput;
}) => {
  const keys: readonly string[] = GLANCE_STAT_KEYS;
  return (
    <dl aria-label="Account glance" className="grid gap-2 sm:grid-cols-3">
      {summaryStats(snapshot)
        .filter((stat) => keys.includes(stat.key))
        .map((stat) => (
          <div
            className="min-w-0 rounded-md border border-border bg-surface p-3"
            data-stat={stat.key}
            key={stat.key}
          >
            <dt className="text-muted-foreground text-xs">{stat.label}</dt>
            <dd
              className={cn(
                "mt-0.5 truncate font-semibold text-lg tabular-nums",
                PNL_TONE_CLASS[stat.tone]
              )}
            >
              {stat.value}
            </dd>
            {stat.sub === null ? null : (
              <dd className="text-muted-foreground text-xs tabular-nums">
                {stat.sub}
              </dd>
            )}
          </div>
        ))}
    </dl>
  );
};

const GlanceLoading = () => (
  <div
    aria-busy="true"
    className="grid gap-2 sm:grid-cols-3"
    data-monitor-state="loading"
    role="status"
  >
    <span className="sr-only">Loading IBKR snapshot</span>
    {GLANCE_STAT_KEYS.map((key) => (
      <Skeleton className="h-[4.5rem]" key={key} />
    ))}
  </div>
);

export const AccountGlance = ({
  gateway: suppliedGateway,
  configured = true,
  recovery: recoveryProps,
  nautilus: nautilusProps,
}: AccountGlanceProps) => {
  const recovery = useIbkrRecovery(recoveryProps ?? {});
  const nautilus = useNautilusArm(nautilusProps ?? {});
  const [gateway] = useState(
    () => suppliedGateway ?? createBrowserIbkrMonitorGateway()
  );
  const [reloadKey, setReloadKey] = useState(0);
  const { failure, fetchedAt, snapshot } = useSnapshotFeed(
    gateway,
    GLANCE_REFRESH_SECONDS,
    reloadKey,
    configured,
    NOT_CONFIGURED
  );
  const nowMs = useNow();
  const health = monitorHealth({
    snapshot,
    failureKind: failure?.kind ?? null,
    nowMs,
    intervalS: GLANCE_REFRESH_SECONDS,
  });
  const age =
    snapshot === null ? null : ageSeconds(snapshot.status.dataAsOf, nowMs);
  const freshness = `Data as of ${clock(snapshot?.status.dataAsOf)}${age === null ? "" : ` (${Math.round(age)} s ago)`}`;
  const retry = () => setReloadKey((key) => key + 1);

  const body =
    failure?.kind === "forbidden" ? (
      <ForbiddenState />
    ) : snapshot === null ? (
      failure === null ? (
        <GlanceLoading />
      ) : (
        <FailureState failure={failure} onRetry={retry} />
      )
    ) : (
      <>
        <AccountModeAlert account={snapshot.account} />
        <Banner
          age={age}
          failure={failure}
          fetchedAt={fetchedAt}
          health={health}
          nowMs={nowMs}
          snapshot={snapshot}
        />
        {/* On a mode mismatch the values are withheld: the alert says so; no empty stat grid. */}
        {snapshot.account.modeError === "mismatch" ? null : (
          <GlanceStats snapshot={snapshot} />
        )}
      </>
    );

  return (
    <section
      aria-labelledby="account-glance-title"
      className="space-y-3 rounded-lg border border-border bg-card p-4 text-card-foreground"
      data-account-glance="true"
    >
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h2
            className="font-heading font-semibold text-lg"
            id="account-glance-title"
          >
            IBKR account
          </h2>
          <p
            className="text-muted-foreground text-xs tabular-nums"
            data-freshness="true"
          >
            {freshness}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge data-health={health.key} status={health.tone}>
            {health.label}
          </StatusBadge>
          {snapshot === null ? null : (
            <AccountBadge account={snapshot.account} />
          )}
          <IbkrRecoveryButton model={recovery} nowMs={nowMs} />
          <NautilusArmControls model={nautilus} />
          <Link
            className={buttonVariants({ variant: "outline" })}
            href="/portfolio"
            prefetch={false}
          >
            Open Portfolio
          </Link>
        </div>
      </header>
      <IbkrRecoveryPanel model={recovery} nowMs={nowMs} />
      <NautilusArmPanel model={nautilus} />
      {body}
    </section>
  );
};
