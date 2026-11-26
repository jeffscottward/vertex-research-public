import { randomUUID } from "node:crypto";
import type {
  FlowRepository,
  OpenbbFreshnessRepository,
  OpenbbFreshnessStageResult,
  OpenbbFreshnessState,
  OpenbbRepository,
} from "@darkfactory/db/server";
import type { NotificationFetch } from "@darkfactory/notifications/server";
import { implement } from "@orpc/server";

import { appContract } from "../contract.ts";
import { OPENBB_JOBS } from "../contracts/openbb.ts";
import type {
  OpenbbCheckSourceOverdueOutput,
  OpenbbRecordSourceOverdueChatOutput,
} from "../contracts/openbb-overdue.ts";
import {
  diffOverdueIncident,
  evaluateOpenbbSources,
  NON_PREMIUM_FLOW_SOURCES,
  OPENBB_OVERDUE_MONITOR,
  type OpenbbOverdueDiff,
  type OpenbbOverduePlannedAlert,
  type OpenbbSourcesEvaluation,
} from "../openbb-overdue.ts";
import type { ApiContext } from "./context.ts";
import { requireOperator } from "./operator-access.ts";
import {
  type PriceAlertsNtfyDelivery,
  sendPriceAlertsNtfy,
} from "./price-alerts-ntfy.ts";
import { storageNotConfiguredMessage } from "./storage-not-configured.ts";

// Server-side handlers for openbb.checkSourceOverdue and openbb.recordSourceOverdueChat
// (docs/vertex-rebuild/designs/smart-money/plan-pr6.md). Reuses price_freshness_state with
// monitor = "openbb-overdue" (zero new migrations) and sendPriceAlertsNtfy. Research only.

const DAY_MS = 86_400_000;
const SHORT_VOLUME_TABLE = "openbb_short_volume_daily";

const NY_DATE = new Intl.DateTimeFormat("en-CA", {
  day: "2-digit",
  month: "2-digit",
  timeZone: "America/New_York",
  year: "numeric",
});

const nyDate = (now: Date, days = 0): string => {
  const base = NY_DATE.format(now);
  return new Date(Date.parse(`${base}T00:00:00Z`) + days * DAY_MS)
    .toISOString()
    .slice(0, 10);
};

export type OverdueFailures = Readonly<{
  FORBIDDEN: (options?: { message?: string }) => Error;
  STORAGE_ERROR: (options?: { message?: string }) => Error;
}>;

export type OverdueDeps = Readonly<{
  clock: () => Date;
  context: ApiContext;
  failures: OverdueFailures;
  flow?: FlowRepository | undefined;
  freshness: OpenbbFreshnessRepository;
  notifyFetch?: NotificationFetch | undefined;
  openbb: OpenbbRepository;
  sendNtfy?: typeof sendPriceAlertsNtfy | undefined;
}>;

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Loads the OpenBB + Flow source inputs needed by `openbb.status` and `openbb.checkSourceOverdue`. */
export const loadOpenbbSourceEvaluation = async (
  input: Readonly<{
    flow?: FlowRepository | undefined;
    includeFlowSamples: boolean;
    now: Date;
    openbb: OpenbbRepository;
    tables?: readonly Readonly<{ newestDate: string | null; table: string }>[];
  }>
): Promise<OpenbbSourcesEvaluation> => {
  const today = nyDate(input.now, 0);
  const from7d = nyDate(input.now, -7);
  const [runs, form4Days, tableStats, marketPremiumSessions, samples] =
    await Promise.all([
      input.openbb.lastRunsFor(OPENBB_JOBS),
      input.openbb.form4IndexDays(from7d),
      input.tables === undefined ? input.openbb.tableStats() : input.tables,
      input.flow === undefined
        ? Promise.resolve(undefined)
        : input.flow.marketPremiumLedger({ from: from7d, to: today }),
      input.flow === undefined || !input.includeFlowSamples
        ? Promise.resolve(undefined)
        : input.flow.latestSamples("SPY", NON_PREMIUM_FLOW_SOURCES),
    ]);
  const shortVolumeNewestDate =
    tableStats.find((entry) => entry.table === SHORT_VOLUME_TABLE)
      ?.newestDate ?? null;
  return evaluateOpenbbSources({
    ...(marketPremiumSessions === undefined
      ? {}
      : {
          flow: {
            marketPremiumSessions,
            ...(samples === undefined ? {} : { samples }),
          },
        }),
    form4Days,
    now: input.now,
    runs,
    shortVolumeNewestDate,
  });
};

const safeSendNtfy = async (
  deps: OverdueDeps,
  message: Readonly<{ body: string; title: string }>,
  idempotencySource: string,
  at: Date
): Promise<PriceAlertsNtfyDelivery> => {
  const sender = deps.sendNtfy ?? sendPriceAlertsNtfy;
  try {
    return await sender(
      deps.context.priceAlertsNtfy ?? null,
      message,
      idempotencySource,
      at,
      deps.notifyFetch
    );
  } catch {
    return "failed";
  }
};

/** Write-key scheduler handler for `openbb.checkSourceOverdue`. */
export const handleCheckSourceOverdue = async (
  deps: OverdueDeps,
  dryRun: boolean
): Promise<OpenbbCheckSourceOverdueOutput> => {
  const now = deps.clock();
  const ntfyConfigured =
    deps.context.priceAlertsNtfy !== null &&
    deps.context.priceAlertsNtfy !== undefined;

  let evaluated: OpenbbSourcesEvaluation;
  try {
    evaluated = await loadOpenbbSourceEvaluation({
      flow: deps.flow,
      includeFlowSamples: false,
      now,
      openbb: deps.openbb,
    });
  } catch (error) {
    throw deps.failures.STORAGE_ERROR({
      message: `openbb.checkSourceOverdue: ${errorMessage(error)}`,
    });
  }

  const baseOutput = (
    fields: Readonly<{
      action: OpenbbCheckSourceOverdueOutput["action"];
      activeAlertKeys: string[];
      delivery: OpenbbCheckSourceOverdueOutput["delivery"];
      newlyOverdue: OpenbbCheckSourceOverdueOutput["newlyOverdue"];
      pendingChat: OpenbbCheckSourceOverdueOutput["pendingChat"];
      plannedAlert: OpenbbCheckSourceOverdueOutput["plannedAlert"];
    }>
  ): OpenbbCheckSourceOverdueOutput => ({
    action: fields.action,
    activeAlertKeys: fields.activeAlertKeys,
    checkedAt: now,
    delivery: fields.delivery,
    dryRun,
    monitoredCount: evaluated.monitoredKeys.length,
    newlyOverdue: fields.newlyOverdue,
    ntfyConfigured,
    overdue: evaluated.overdueMonitored,
    pendingChat: fields.pendingChat,
    plannedAlert: fields.plannedAlert,
  });

  if (dryRun) {
    let state: OpenbbFreshnessState | null;
    try {
      state = await deps.freshness.getFreshnessState(OPENBB_OVERDUE_MONITOR);
    } catch (error) {
      throw deps.failures.STORAGE_ERROR({
        message: `openbb.checkSourceOverdue: ${errorMessage(error)}`,
      });
    }
    const diff = diffOverdueIncident({
      activeKeys: state?.activeKeys ?? [],
      clearableKeys: evaluated.clearableKeys,
      lastTransitionAt: state?.lastTransitionAt ?? null,
      monitoredKeys: evaluated.monitoredKeys,
      now,
      overdue: evaluated.overdueMonitored,
      pendingEventId: state?.pendingEventId ?? null,
      updatedAt: state?.updatedAt ?? null,
    });
    return baseOutput({
      action: diff.action,
      activeAlertKeys: state === null ? [] : [...state.activeKeys],
      delivery: "dry-run",
      newlyOverdue: diff.newlyOverdue,
      pendingChat: null,
      plannedAlert: diff.alert,
    });
  }

  // Phase 1: short advisory-locked DB transaction to stage transition.
  type StagedEvent = Readonly<{
    action: "alert" | "recovery";
    alert: OpenbbOverduePlannedAlert;
    eventId: string;
    idempotencySource: string;
    pendingKeys: string[];
    pendingKind: "alert" | "recovery";
  }>;
  const phase1: {
    diff: OpenbbOverdueDiff | null;
    event: StagedEvent | null;
  } = { diff: null, event: null };
  let staged: OpenbbFreshnessStageResult;
  try {
    staged = await deps.freshness.stageFreshnessTransition(
      OPENBB_OVERDUE_MONITOR,
      (current) => {
        phase1.event = null;
        const currentDiff = diffOverdueIncident({
          activeKeys: current?.activeKeys ?? [],
          clearableKeys: evaluated.clearableKeys,
          lastTransitionAt: current?.lastTransitionAt ?? null,
          monitoredKeys: evaluated.monitoredKeys,
          now,
          overdue: evaluated.overdueMonitored,
          pendingEventId: current?.pendingEventId ?? null,
          updatedAt: current?.updatedAt ?? null,
        });
        phase1.diff = currentDiff;
        if (
          currentDiff.action === "alert" ||
          currentDiff.action === "recovery"
        ) {
          const eventId = randomUUID();
          phase1.event = {
            action: currentDiff.action,
            alert: currentDiff.alert,
            eventId,
            idempotencySource: currentDiff.idempotencySource,
            pendingKeys: currentDiff.nextActiveKeys,
            pendingKind: currentDiff.action,
          };
          return {
            eventId,
            kind: "stage-pending",
            pendingKeys: currentDiff.nextActiveKeys,
            pendingKind: currentDiff.action,
          };
        }
        if (currentDiff.action === "prune-active")
          return {
            activeKeys: currentDiff.nextActiveKeys,
            kind: "prune-active",
          };
        if (currentDiff.action === "clear-pending")
          return { kind: "clear-pending" };
        return { kind: currentDiff.action };
      },
      now
    );
  } catch (error) {
    throw deps.failures.STORAGE_ERROR({
      message: `openbb.checkSourceOverdue: ${errorMessage(error)}`,
    });
  }

  if (phase1.diff === null)
    throw deps.failures.STORAGE_ERROR({
      message: "openbb.checkSourceOverdue: transition callback did not run",
    });
  const diff = phase1.diff;
  const currentEvent = phase1.event;
  if (currentEvent === null) {
    return baseOutput({
      action: diff.action,
      activeAlertKeys: staged.activeKeys,
      delivery: null,
      newlyOverdue: diff.newlyOverdue,
      pendingChat: null,
      plannedAlert: null,
    });
  }

  // Phase 2: outbound ntfy outside any DB transaction.
  const delivery = await safeSendNtfy(
    deps,
    { body: currentEvent.alert.body, title: currentEvent.alert.title },
    currentEvent.idempotencySource,
    now
  );

  // Phase 3: short advisory-locked DB transaction to commit ntfy result.
  let committed: boolean;
  try {
    committed = await deps.freshness.completeFreshnessDelivery(
      OPENBB_OVERDUE_MONITOR,
      currentEvent.eventId,
      delivery,
      deps.clock()
    );
  } catch (error) {
    throw deps.failures.STORAGE_ERROR({
      message: `openbb.checkSourceOverdue: ${errorMessage(error)}`,
    });
  }

  if (!committed) {
    return baseOutput({
      action: currentEvent.action,
      activeAlertKeys: staged.activeKeys,
      delivery,
      newlyOverdue: diff.newlyOverdue,
      pendingChat: null,
      plannedAlert: currentEvent.alert,
    });
  }

  if (delivery === "sent") {
    return baseOutput({
      action: currentEvent.action,
      activeAlertKeys: currentEvent.pendingKeys,
      delivery: "sent",
      newlyOverdue: diff.newlyOverdue,
      pendingChat: null,
      plannedAlert: currentEvent.alert,
    });
  }

  return baseOutput({
    action: currentEvent.action,
    activeAlertKeys: staged.activeKeys,
    delivery,
    newlyOverdue: diff.newlyOverdue,
    pendingChat: {
      body: currentEvent.alert.body,
      eventId: currentEvent.eventId,
      kind: currentEvent.pendingKind,
      title: currentEvent.alert.title,
    },
    plannedAlert: currentEvent.alert,
  });
};

/** Write-key scheduler handler for `openbb.recordSourceOverdueChat`. */
export const handleRecordSourceOverdueChat = async (
  deps: Pick<OverdueDeps, "clock" | "failures" | "freshness">,
  input: Readonly<{ delivery: "sent" | "failed"; eventId: string }>
): Promise<OpenbbRecordSourceOverdueChatOutput> => {
  try {
    const committed = await deps.freshness.completeFreshnessDelivery(
      OPENBB_OVERDUE_MONITOR,
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
      message: `openbb.recordSourceOverdueChat: ${errorMessage(error)}`,
    });
  }
};

const api = implement(appContract).$context<ApiContext>();

const systemClock = (): Date => new Date();
let clock = systemClock;
let notifyFetchOverride: NotificationFetch | undefined;
let sendNtfyOverride: typeof sendPriceAlertsNtfy | undefined;

/** Test seam: overrides clock and outbound ntfy transport for openbbOverdueRouter. */
export const setOpenbbOverdueOptionsForTesting = (
  options: Readonly<{
    clock?: (() => Date) | null;
    notifyFetch?: NotificationFetch | null;
    sendNtfy?: typeof sendPriceAlertsNtfy | null;
  }> | null
): void => {
  clock = options?.clock ?? systemClock;
  notifyFetchOverride = options?.notifyFetch ?? undefined;
  sendNtfyOverride = options?.sendNtfy ?? undefined;
};

const requireOverdueWriteKey = (
  context: ApiContext,
  failures: OverdueFailures,
  procedure: string
): void => {
  if (context.agentApiKeyPresented !== true)
    throw failures.FORBIDDEN({
      message: `openbb.${procedure} needs an agent API key`,
    });
};

const overdueDeps = (
  context: ApiContext,
  failures: OverdueFailures
): OverdueDeps => {
  const { flow, openbb, openbbFreshness } = context.repositories;
  if (openbb === undefined || openbbFreshness === undefined)
    throw failures.STORAGE_ERROR({
      message: storageNotConfiguredMessage("OpenBB"),
    });
  return {
    clock,
    context,
    failures,
    flow,
    freshness: openbbFreshness,
    notifyFetch: notifyFetchOverride,
    openbb,
    sendNtfy: sendNtfyOverride,
  };
};

const checkSourceOverdue = api.openbb.checkSourceOverdue
  .use(requireOperator)
  .handler(async ({ context, input, errors }) => {
    const failures = errors as unknown as OverdueFailures;
    requireOverdueWriteKey(context, failures, "checkSourceOverdue");
    return await handleCheckSourceOverdue(
      overdueDeps(context, failures),
      input.dryRun === true
    );
  });

const recordSourceOverdueChat = api.openbb.recordSourceOverdueChat
  .use(requireOperator)
  .handler(async ({ context, input, errors }) => {
    const failures = errors as unknown as OverdueFailures;
    requireOverdueWriteKey(context, failures, "recordSourceOverdueChat");
    const { openbbFreshness } = context.repositories;
    if (openbbFreshness === undefined)
      throw failures.STORAGE_ERROR({
        message: storageNotConfiguredMessage("OpenBB"),
      });
    return await handleRecordSourceOverdueChat(
      { clock, failures, freshness: openbbFreshness },
      input
    );
  });

export const openbbOverdueRouter = {
  checkSourceOverdue,
  recordSourceOverdueChat,
};
