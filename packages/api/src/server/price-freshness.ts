import { randomUUID } from "node:crypto";
import type {
  MarketBarsRepository,
  MarketDailySeriesRepository,
  OpenbbFreshnessRepository,
  OpenbbFreshnessStageResult,
  OpenbbFreshnessState,
} from "@darkfactory/db/server";
import type { NotificationFetch } from "@darkfactory/notifications/server";
import { implement } from "@orpc/server";

import { appContract } from "../contract.ts";
import { OPENBB_DAILY_BAR_SYMBOLS } from "../contracts/openbb.ts";
import type {
  OpenbbCheckPriceFreshnessOutput,
  OpenbbPriceFreshnessOutput,
} from "../contracts/price-freshness.ts";
import {
  diffFreshnessIncident,
  evaluatePriceFreshness,
  expectedFreshnessSession,
  OPENBB_ALL_DAILY_SERIES_IDS,
  OPENBB_PRICE_FRESHNESS_MONITOR,
  type OpenbbFreshnessDiff,
  type OpenbbFreshnessEvaluation,
  type OpenbbFreshnessPlannedAlert,
  type OpenbbStaleSeries,
} from "../price-freshness.ts";
import type { ApiContext } from "./context.ts";
import { requireOperator } from "./operator-access.ts";
import {
  type PriceAlertsNtfyDelivery,
  sendPriceAlertsNtfy,
} from "./price-alerts-ntfy.ts";
import { storageNotConfiguredMessage } from "./storage-not-configured.ts";

// Server-side handlers for openbb.priceFreshness, openbb.checkPriceFreshness, and
// openbb.recordPriceFreshnessChat (docs/vertex-rebuild/designs/price-freshness-alert/plan.md).
// Research data alerting only: no orders, arming, or risk changes.

export type FreshnessFailures = Readonly<{
  STORAGE_ERROR: (options?: { message?: string }) => Error;
}>;

export type FreshnessDeps = Readonly<{
  bars: MarketBarsRepository;
  clock: () => Date;
  context: ApiContext;
  failures: FreshnessFailures;
  freshness: OpenbbFreshnessRepository;
  notifyFetch?: NotificationFetch | undefined;
  sendNtfy?: typeof sendPriceAlertsNtfy | undefined;
  series: MarketDailySeriesRepository;
}>;

const isoDay = (timestampMs: number): string =>
  new Date(timestampMs).toISOString().slice(0, 10);

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const loadSeriesAndBars = async (
  deps: Pick<FreshnessDeps, "bars" | "series">
) => {
  const barSymbols: readonly string[] = OPENBB_DAILY_BAR_SYMBOLS;
  const [points, lastBars] = await Promise.all([
    deps.series.latestPoints(OPENBB_ALL_DAILY_SERIES_IDS),
    deps.bars.latestBars("1d"),
  ]);
  return {
    bars: lastBars
      .filter((bar) => barSymbols.includes(bar.symbol))
      .map((bar) => ({ lastDate: isoDay(bar.lastT), symbol: bar.symbol })),
    series: points.map((point) => ({ id: point.id, lastDate: point.lastDate })),
  };
};

const safeSendNtfy = async (
  deps: Pick<FreshnessDeps, "context" | "notifyFetch" | "sendNtfy">,
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

/** Read-only handler for `openbb.priceFreshness`. */
export const handlePriceFreshness = async (
  deps: FreshnessDeps
): Promise<OpenbbPriceFreshnessOutput> => {
  const now = deps.clock();
  const expectedSession = expectedFreshnessSession(now);
  try {
    const [{ bars, series }, state] = await Promise.all([
      loadSeriesAndBars(deps),
      deps.freshness.getFreshnessState(OPENBB_PRICE_FRESHNESS_MONITOR),
    ]);
    const { stale } = evaluatePriceFreshness({ bars, expectedSession, series });
    return {
      activeAlertKeys: state === null ? [] : [...state.activeKeys],
      checkedAt: now,
      dailyBarsCount: OPENBB_DAILY_BAR_SYMBOLS.length,
      dailySeriesCount: OPENBB_ALL_DAILY_SERIES_IDS.length,
      expectedSession,
      ntfyConfigured:
        deps.context.priceAlertsNtfy !== null &&
        deps.context.priceAlertsNtfy !== undefined,
      pendingDelivery: state?.pendingDelivery ?? null,
      pendingKind: state?.pendingKind ?? null,
      stale,
    };
  } catch (error) {
    throw deps.failures.STORAGE_ERROR({
      message: `openbb.priceFreshness: ${errorMessage(error)}`,
    });
  }
};

/** Write-key scheduler handler for `openbb.checkPriceFreshness`. */
export const handleCheckPriceFreshness = async (
  deps: FreshnessDeps,
  dryRun: boolean
): Promise<OpenbbCheckPriceFreshnessOutput> => {
  const now = deps.clock();
  const expectedSession = expectedFreshnessSession(now);
  const ntfyConfigured =
    deps.context.priceAlertsNtfy !== null &&
    deps.context.priceAlertsNtfy !== undefined;

  let evaluated: OpenbbFreshnessEvaluation;
  try {
    const { bars, series } = await loadSeriesAndBars(deps);
    evaluated = evaluatePriceFreshness({ bars, expectedSession, series });
  } catch (error) {
    throw deps.failures.STORAGE_ERROR({
      message: `openbb.checkPriceFreshness: ${errorMessage(error)}`,
    });
  }

  const baseOutput = (
    fields: Readonly<{
      action: OpenbbCheckPriceFreshnessOutput["action"];
      activeAlertKeys: string[];
      delivery: OpenbbCheckPriceFreshnessOutput["delivery"];
      newlyStale: OpenbbStaleSeries[];
      pendingChat: OpenbbCheckPriceFreshnessOutput["pendingChat"];
      plannedAlert: OpenbbCheckPriceFreshnessOutput["plannedAlert"];
    }>
  ): OpenbbCheckPriceFreshnessOutput => ({
    action: fields.action,
    activeAlertKeys: fields.activeAlertKeys,
    checkedAt: now,
    dailyBarsCount: OPENBB_DAILY_BAR_SYMBOLS.length,
    dailySeriesCount: OPENBB_ALL_DAILY_SERIES_IDS.length,
    delivery: fields.delivery,
    dryRun,
    expectedSession,
    newlyStale: fields.newlyStale,
    ntfyConfigured,
    pendingChat: fields.pendingChat,
    plannedAlert: fields.plannedAlert,
    stale: evaluated.stale,
  });

  // Strictly read-only dry-run: no write transaction, no advisory lock, no ntfy send, pendingChat null.
  if (dryRun) {
    let state: OpenbbFreshnessState | null;
    try {
      state = await deps.freshness.getFreshnessState(
        OPENBB_PRICE_FRESHNESS_MONITOR
      );
    } catch (error) {
      throw deps.failures.STORAGE_ERROR({
        message: `openbb.checkPriceFreshness: ${errorMessage(error)}`,
      });
    }
    const diff = diffFreshnessIncident({
      activeKeys: state?.activeKeys ?? [],
      clearableKeys: evaluated.clearableKeys,
      expectedSession,
      monitoredKeys: evaluated.monitoredKeys,
      now,
      pendingDelivery: state?.pendingDelivery ?? null,
      pendingEventId: state?.pendingEventId ?? null,
      stale: evaluated.stale,
      updatedAt: state?.updatedAt ?? null,
    });
    return baseOutput({
      action: diff.action,
      activeAlertKeys: state === null ? [] : [...state.activeKeys],
      delivery: "dry-run",
      newlyStale: diff.newlyStale,
      pendingChat: null,
      plannedAlert: diff.alert,
    });
  }

  // Phase 1: short advisory-locked DB transaction to stage transition.
  type StagedEvent = Readonly<{
    action: "alert" | "recovery";
    alert: OpenbbFreshnessPlannedAlert;
    eventId: string;
    idempotencySource: string;
    pendingKeys: string[];
    pendingKind: "alert" | "recovery";
  }>;
  const phase1: {
    diff: OpenbbFreshnessDiff | null;
    event: StagedEvent | null;
  } = { diff: null, event: null };
  let staged: OpenbbFreshnessStageResult;
  try {
    staged = await deps.freshness.stageFreshnessTransition(
      OPENBB_PRICE_FRESHNESS_MONITOR,
      (current) => {
        phase1.event = null;
        const currentDiff = diffFreshnessIncident({
          activeKeys: current?.activeKeys ?? [],
          clearableKeys: evaluated.clearableKeys,
          expectedSession,
          monitoredKeys: evaluated.monitoredKeys,
          now,
          pendingDelivery: current?.pendingDelivery ?? null,
          pendingEventId: current?.pendingEventId ?? null,
          stale: evaluated.stale,
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
      message: `openbb.checkPriceFreshness: ${errorMessage(error)}`,
    });
  }

  if (phase1.diff === null)
    throw deps.failures.STORAGE_ERROR({
      message: "openbb.checkPriceFreshness: transition callback did not run",
    });
  const diff = phase1.diff;
  const currentEvent = phase1.event;
  if (currentEvent === null) {
    return baseOutput({
      action: diff.action,
      activeAlertKeys: staged.activeKeys,
      delivery: null,
      newlyStale: diff.newlyStale,
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
      OPENBB_PRICE_FRESHNESS_MONITOR,
      currentEvent.eventId,
      delivery,
      deps.clock()
    );
  } catch (error) {
    throw deps.failures.STORAGE_ERROR({
      message: `openbb.checkPriceFreshness: ${errorMessage(error)}`,
    });
  }

  if (!committed) {
    return baseOutput({
      action: currentEvent.action,
      activeAlertKeys: staged.activeKeys,
      delivery,
      newlyStale: diff.newlyStale,
      pendingChat: null,
      plannedAlert: currentEvent.alert,
    });
  }

  if (delivery === "sent") {
    return baseOutput({
      action: currentEvent.action,
      activeAlertKeys: currentEvent.pendingKeys,
      delivery: "sent",
      newlyStale: diff.newlyStale,
      pendingChat: null,
      plannedAlert: currentEvent.alert,
    });
  }

  return baseOutput({
    action: currentEvent.action,
    activeAlertKeys: staged.activeKeys,
    delivery,
    newlyStale: diff.newlyStale,
    pendingChat: {
      body: currentEvent.alert.body,
      eventId: currentEvent.eventId,
      kind: currentEvent.pendingKind,
      title: currentEvent.alert.title,
    },
    plannedAlert: currentEvent.alert,
  });
};

/** Write-key scheduler handler for `openbb.recordPriceFreshnessChat`. */
export const handleRecordPriceFreshnessChat = async (
  deps: Pick<FreshnessDeps, "clock" | "failures" | "freshness">,
  input: Readonly<{ delivery: "sent" | "failed"; eventId: string }>
): Promise<
  Readonly<{ committed: boolean; delivery: "sent" | "failed"; eventId: string }>
> => {
  try {
    const committed = await deps.freshness.completeFreshnessDelivery(
      OPENBB_PRICE_FRESHNESS_MONITOR,
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
      message: `openbb.recordPriceFreshnessChat: ${errorMessage(error)}`,
    });
  }
};

const api = implement(appContract).$context<ApiContext>();

type RouterFailures = Readonly<{
  FORBIDDEN: (options?: { message?: string }) => Error;
  STORAGE_ERROR: (options?: { message?: string }) => Error;
}>;

const systemClock = (): Date => new Date();
let clock = systemClock;
let notifyFetchOverride: NotificationFetch | undefined;
let sendNtfyOverride: typeof sendPriceAlertsNtfy | undefined;

/** Test seam: overrides clock and outbound ntfy transport for openbbPriceFreshnessRouter. */
export const setOpenbbPriceFreshnessOptionsForTesting = (
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

export const requireFreshnessWriteKey = (
  context: ApiContext,
  failures: RouterFailures,
  procedure: string
): void => {
  if (context.agentApiKeyPresented !== true || context.callerCanWrite !== true)
    throw failures.FORBIDDEN({
      message: `openbb.${procedure} needs a write agent API key`,
    });
};

const depsFor = (
  context: ApiContext,
  failures: RouterFailures
): FreshnessDeps => {
  const { marketBars, marketDailySeries, openbbFreshness } =
    context.repositories;
  if (
    openbbFreshness === undefined ||
    marketDailySeries === undefined ||
    marketBars === undefined
  )
    throw failures.STORAGE_ERROR({
      message: storageNotConfiguredMessage("OpenBB freshness"),
    });
  return {
    bars: marketBars,
    clock,
    context,
    failures,
    freshness: openbbFreshness,
    notifyFetch: notifyFetchOverride,
    sendNtfy: sendNtfyOverride,
    series: marketDailySeries,
  };
};

const priceFreshness = api.openbb.priceFreshness
  .use(requireOperator)
  .handler(async ({ context, errors }) => {
    const failures = errors as unknown as RouterFailures;
    return await handlePriceFreshness(depsFor(context, failures));
  });

const checkPriceFreshness = api.openbb.checkPriceFreshness
  .use(requireOperator)
  .handler(async ({ context, input, errors }) => {
    const failures = errors as unknown as RouterFailures;
    requireFreshnessWriteKey(context, failures, "checkPriceFreshness");
    return await handleCheckPriceFreshness(
      depsFor(context, failures),
      input.dryRun === true
    );
  });

const recordPriceFreshnessChat = api.openbb.recordPriceFreshnessChat
  .use(requireOperator)
  .handler(async ({ context, input, errors }) => {
    const failures = errors as unknown as RouterFailures;
    requireFreshnessWriteKey(context, failures, "recordPriceFreshnessChat");
    const { openbbFreshness } = context.repositories;
    if (openbbFreshness === undefined)
      throw failures.STORAGE_ERROR({
        message: storageNotConfiguredMessage("OpenBB freshness"),
      });
    return await handleRecordPriceFreshnessChat(
      { clock, failures, freshness: openbbFreshness },
      input
    );
  });

export const openbbPriceFreshnessRouter = {
  checkPriceFreshness,
  priceFreshness,
  recordPriceFreshnessChat,
};
