import type {
  FlowRepository,
  FlowSampleRecord,
  OpenbbFreshnessRepository,
  OpenbbFreshnessState,
  OpenbbRepository,
  OpenbbRun,
} from "@darkfactory/db/server";
import type { NotificationFetch } from "@darkfactory/notifications/server";
import { implement } from "@orpc/server";

import {
  alertableConnectivityIssues,
  CONNECTIVITY_ALERT_MONITOR,
  type ConnectivityRuntimeConfigSummary,
  diffConnectivityAlerts,
  evaluateConnectivityHealth,
} from "../connectivity-health.ts";
import { appContract } from "../contract.ts";
import type {
  ConnectivityCheckAlertsOutput,
  ConnectivityHealthOutput,
  ConnectivityPlannedAlert,
} from "../contracts/connectivity.ts";
import type { ApiContext } from "./context.ts";
import { requireOperator } from "./operator-access.ts";
import {
  type PriceAlertsNtfyDelivery,
  sendPriceAlertsNtfy,
} from "./price-alerts-ntfy.ts";
import type { PriceAlertsNtfyConfig } from "./service-config.ts";

// Server-side handlers for connectivity.health, connectivity.checkAlerts, and
// connectivity.recordAlertChat (card vertex-connectivity-audit-autofix; research diagnostics
// and alerting only, no orders, arming, or secret rotation).

const RECENT_FLOW_SAMPLES_PER_SOURCE = 5;

export type ConnectivityFailures = Readonly<{
  FORBIDDEN: (options?: { message?: string }) => Error;
  STORAGE_ERROR: (options?: { message?: string }) => Error;
}>;

export type ConnectivityDeps = Readonly<{
  clock: () => Date;
  config: ConnectivityRuntimeConfigSummary;
  failures: ConnectivityFailures;
  flow: FlowRepository | undefined;
  freshness: OpenbbFreshnessRepository | undefined;
  notify?: NotificationFetch;
  ntfy: PriceAlertsNtfyConfig | null;
  openbb: OpenbbRepository | undefined;
}>;

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const newEventId = (): string => `conn-${crypto.randomUUID()}`;

const runtimeConfigOf = (
  context: ApiContext
): ConnectivityRuntimeConfigSummary => ({
  deployStatus: Boolean(context.deployStatus || context.deployStatusV2),
  engineStatus: Boolean(context.engineStatus),
  ibkrMonitor: Boolean(context.ibkrMonitor),
  ibkrRecovery: Boolean(context.ibkrRecovery),
  marketHistory: Boolean(context.marketHistory),
  portfolioMonitor: Boolean(context.portfolioMonitor),
  priceAlertsNtfy: Boolean(context.priceAlertsNtfy),
  quantData: Boolean(context.quantData),
  researchLenses: Boolean(context.researchLenses),
});

const sendConnectivityNtfy = async (
  deps: ConnectivityDeps,
  alert: ConnectivityPlannedAlert,
  eventId: string,
  at: Date
): Promise<PriceAlertsNtfyDelivery> =>
  await sendPriceAlertsNtfy(
    deps.ntfy,
    { body: alert.body, title: alert.title },
    `${CONNECTIVITY_ALERT_MONITOR}:${eventId}`,
    at,
    deps.notify
  );

/** Read-only operator handler for `connectivity.health`. */
export const handleConnectivityHealth = async (
  deps: ConnectivityDeps
): Promise<ConnectivityHealthOutput> => {
  const checkedAt = deps.clock();
  try {
    const [flowSamples, openbbRuns, state] = await Promise.all([
      deps.flow === undefined
        ? Promise.resolve([])
        : deps.flow.recentSamples(RECENT_FLOW_SAMPLES_PER_SOURCE),
      deps.openbb === undefined
        ? Promise.resolve([])
        : deps.openbb.latestRuns(),
      deps.freshness === undefined
        ? Promise.resolve(null)
        : deps.freshness.getFreshnessState(CONNECTIVITY_ALERT_MONITOR),
    ]);
    const evaluated = evaluateConnectivityHealth({
      config: deps.config,
      flowSamples,
      openbbRuns,
    });
    return {
      activeAlertKeys: state?.activeKeys ?? [],
      checkedAt,
      issues: evaluated.issues,
      ntfyConfigured: deps.ntfy !== null,
      overallStatus: evaluated.overallStatus,
      pendingDelivery: state?.pendingDelivery ?? null,
      pendingKind: state?.pendingKind ?? null,
      providers: evaluated.providers,
    };
  } catch (error) {
    throw deps.failures.STORAGE_ERROR({
      message: `connectivity.health: ${errorMessage(error)}`,
    });
  }
};

/** Write-key scheduler handler for `connectivity.checkAlerts`. */
export const handleCheckConnectivityAlerts = async (
  deps: ConnectivityDeps,
  input: Readonly<{ dryRun?: boolean | undefined }>
): Promise<ConnectivityCheckAlertsOutput> => {
  const dryRun = input.dryRun === true;
  const checkedAt = deps.clock();
  const ntfyConfigured = deps.ntfy !== null;
  if (deps.freshness === undefined) {
    throw deps.failures.STORAGE_ERROR({
      message:
        "Connectivity alert storage is not configured on this server; ask the operator",
    });
  }
  const freshness = deps.freshness;

  let flowSamples: FlowSampleRecord[];
  let openbbRuns: OpenbbRun[];
  try {
    [flowSamples, openbbRuns] = await Promise.all([
      deps.flow === undefined
        ? Promise.resolve([])
        : deps.flow.recentSamples(RECENT_FLOW_SAMPLES_PER_SOURCE),
      deps.openbb === undefined
        ? Promise.resolve([])
        : deps.openbb.latestRuns(),
    ]);
  } catch (error) {
    throw deps.failures.STORAGE_ERROR({
      message: `connectivity.checkAlerts: ${errorMessage(error)}`,
    });
  }

  const evaluated = evaluateConnectivityHealth({
    config: deps.config,
    flowSamples,
    openbbRuns,
  });
  const alertable = alertableConnectivityIssues(evaluated.issues);
  const needsOwnerAsk = alertable.some(
    (issue) => issue.category === "auth_failed"
  );

  const buildOutput = (fields: {
    action: ConnectivityCheckAlertsOutput["action"];
    activeAlertKeys: string[];
    delivery: ConnectivityCheckAlertsOutput["delivery"];
    newlyAlerted: ConnectivityCheckAlertsOutput["newlyAlerted"];
    pendingChat: ConnectivityCheckAlertsOutput["pendingChat"];
    plannedAlert: ConnectivityCheckAlertsOutput["plannedAlert"];
  }): ConnectivityCheckAlertsOutput => ({
    action: fields.action,
    activeAlertKeys: fields.activeAlertKeys,
    alertableIssues: alertable,
    checkedAt,
    delivery: fields.delivery,
    dryRun,
    issues: evaluated.issues,
    needsOwnerAsk,
    newlyAlerted: fields.newlyAlerted,
    ntfyConfigured,
    overallStatus: evaluated.overallStatus,
    pendingChat: fields.pendingChat,
    plannedAlert: fields.plannedAlert,
  });

  if (dryRun) {
    let state: OpenbbFreshnessState | null;
    try {
      state = await freshness.getFreshnessState(CONNECTIVITY_ALERT_MONITOR);
    } catch (error) {
      throw deps.failures.STORAGE_ERROR({
        message: `connectivity.checkAlerts: ${errorMessage(error)}`,
      });
    }
    const diff = diffConnectivityAlerts({
      alertable,
      now: checkedAt,
      state,
    });
    return buildOutput({
      action: diff.action,
      activeAlertKeys: state?.activeKeys ?? [],
      delivery: diff.alert === null ? null : "dry-run",
      newlyAlerted: [...diff.newlyAlerted],
      pendingChat: null,
      plannedAlert: diff.alert,
    });
  }

  let stagedEvent: {
    action: "alert" | "recovery";
    alert: ConnectivityPlannedAlert;
    eventId: string;
    newlyAlerted: ConnectivityCheckAlertsOutput["newlyAlerted"];
  } | null = null;
  let nonAlertOutcome: {
    action: "noop" | "in-flight" | "prune-active" | "clear-pending";
    newlyAlerted: ConnectivityCheckAlertsOutput["newlyAlerted"];
  } | null = null;

  try {
    const stage = await freshness.stageFreshnessTransition(
      CONNECTIVITY_ALERT_MONITOR,
      (current) => {
        const diff = diffConnectivityAlerts({
          alertable,
          now: checkedAt,
          state: current,
        });
        if (diff.action === "alert" || diff.action === "recovery") {
          const eventId = newEventId();
          stagedEvent = {
            action: diff.action,
            alert: diff.alert,
            eventId,
            newlyAlerted: [...diff.newlyAlerted],
          };
          return {
            eventId,
            kind: "stage-pending",
            pendingKeys: diff.targetKeys,
            pendingKind: diff.action,
          };
        }
        nonAlertOutcome = {
          action: diff.action,
          newlyAlerted: [...diff.newlyAlerted],
        };
        if (diff.action === "prune-active") {
          return { activeKeys: diff.targetKeys, kind: "prune-active" };
        }
        return { kind: diff.action };
      },
      checkedAt
    );

    if (stagedEvent === null) {
      const outcome = nonAlertOutcome ?? {
        action: "noop" as const,
        newlyAlerted: [],
      };
      return buildOutput({
        action: outcome.action,
        activeAlertKeys: stage.activeKeys,
        delivery: null,
        newlyAlerted: outcome.newlyAlerted,
        pendingChat: null,
        plannedAlert: null,
      });
    }
  } catch (error) {
    throw deps.failures.STORAGE_ERROR({
      message: `connectivity.checkAlerts: ${errorMessage(error)}`,
    });
  }

  const event = stagedEvent as {
    action: "alert" | "recovery";
    alert: ConnectivityPlannedAlert;
    eventId: string;
    newlyAlerted: ConnectivityCheckAlertsOutput["newlyAlerted"];
  };

  // Phase 2: outbound ntfy outside any DB transaction.
  const delivery = await sendConnectivityNtfy(
    deps,
    event.alert,
    event.eventId,
    checkedAt
  );

  // Phase 3: commit ntfy delivery result under advisory lock.
  let committed: boolean;
  let stateAfter: OpenbbFreshnessState | null;
  try {
    committed = await freshness.completeFreshnessDelivery(
      CONNECTIVITY_ALERT_MONITOR,
      event.eventId,
      delivery,
      deps.clock()
    );
    stateAfter = await freshness.getFreshnessState(CONNECTIVITY_ALERT_MONITOR);
  } catch (error) {
    throw deps.failures.STORAGE_ERROR({
      message: `connectivity.checkAlerts: ${errorMessage(error)}`,
    });
  }

  const activeAlertKeys = stateAfter?.activeKeys ?? [];
  if (delivery === "sent" || !committed) {
    return buildOutput({
      action: event.action,
      activeAlertKeys,
      delivery,
      newlyAlerted: event.newlyAlerted,
      pendingChat: null,
      plannedAlert: event.alert,
    });
  }

  return buildOutput({
    action: event.action,
    activeAlertKeys,
    delivery,
    newlyAlerted: event.newlyAlerted,
    pendingChat: {
      body: event.alert.body,
      eventId: event.eventId,
      kind: event.alert.kind,
      needsOwnerAsk: event.alert.needsOwnerAsk,
      title: event.alert.title,
    },
    plannedAlert: event.alert,
  });
};

/** Write-key scheduler handler for `connectivity.recordAlertChat`. */
export const handleRecordConnectivityAlertChat = async (
  deps: Pick<ConnectivityDeps, "clock" | "failures" | "freshness">,
  input: Readonly<{ delivery: "sent" | "failed"; eventId: string }>
): Promise<
  Readonly<{ committed: boolean; delivery: "sent" | "failed"; eventId: string }>
> => {
  if (deps.freshness === undefined) {
    throw deps.failures.STORAGE_ERROR({
      message:
        "Connectivity alert storage is not configured on this server; ask the operator",
    });
  }
  try {
    const committed = await deps.freshness.completeFreshnessDelivery(
      CONNECTIVITY_ALERT_MONITOR,
      input.eventId,
      input.delivery,
      deps.clock()
    );
    return {
      committed,
      delivery: input.delivery,
      eventId: input.eventId,
    };
  } catch (error) {
    throw deps.failures.STORAGE_ERROR({
      message: `connectivity.recordAlertChat: ${errorMessage(error)}`,
    });
  }
};

// --- oRPC router wiring ---

const api = implement(appContract).$context<ApiContext>();
const systemClock = (): Date => new Date();
let clock: () => Date = systemClock;
let notifyOverride: NotificationFetch | undefined;

/** Test seam: overrides clock and outbound ntfy transport for connectivityRouter. */
export const setConnectivityOptionsForTesting = (
  options?: Readonly<{
    clock?: () => Date;
    notify?: NotificationFetch;
  }>
): void => {
  clock = options?.clock ?? systemClock;
  notifyOverride = options?.notify;
};

const requireConnectivityWriteKey = (
  context: ApiContext,
  failures: ConnectivityFailures,
  procedure: string
): void => {
  if (context.agentApiKeyPresented !== true) {
    throw failures.FORBIDDEN({
      message: `connectivity.${procedure} needs an agent API key`,
    });
  }
};

const depsFor = (
  context: ApiContext,
  failures: ConnectivityFailures
): ConnectivityDeps => ({
  clock,
  config: runtimeConfigOf(context),
  failures,
  flow: context.repositories.flow,
  freshness: context.repositories.openbbFreshness,
  ...(notifyOverride === undefined ? {} : { notify: notifyOverride }),
  ntfy: context.priceAlertsNtfy ?? null,
  openbb: context.repositories.openbb,
});

const health = api.connectivity.health
  .use(requireOperator)
  .handler(async ({ context, errors }) => {
    const failures = errors as unknown as ConnectivityFailures;
    return await handleConnectivityHealth(depsFor(context, failures));
  });

const checkAlerts = api.connectivity.checkAlerts
  .use(requireOperator)
  .handler(async ({ context, input, errors }) => {
    const failures = errors as unknown as ConnectivityFailures;
    requireConnectivityWriteKey(context, failures, "checkAlerts");
    return await handleCheckConnectivityAlerts(
      depsFor(context, failures),
      input
    );
  });

const recordAlertChat = api.connectivity.recordAlertChat
  .use(requireOperator)
  .handler(async ({ context, input, errors }) => {
    const failures = errors as unknown as ConnectivityFailures;
    requireConnectivityWriteKey(context, failures, "recordAlertChat");
    return await handleRecordConnectivityAlertChat(
      depsFor(context, failures),
      input
    );
  });

export const connectivityRouter = {
  checkAlerts,
  health,
  recordAlertChat,
};
