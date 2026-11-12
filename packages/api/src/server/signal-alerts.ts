import {
  type SignalAlertEventRecord,
  SignalAlertLimitError,
  type SignalAlertRepository,
  type SignalAlertRuleRecord,
} from "@darkfactory/db/server";
import type { NotificationFetch } from "@darkfactory/notifications/server";
import { implement } from "@orpc/server";

import { appContract } from "../contract.ts";
import type { MarketBar, MarketBarSize } from "../contracts/market-data.ts";
import {
  SIGNAL_ALERT_EVENTS_MAX,
  SIGNAL_ALERT_MAX_SERIES_PER_RUN,
  SIGNAL_ALERT_TICK_MAX_RULES,
  type SignalAlertCondition,
  SignalAlertConditionSchema,
  type SignalAlertEvent,
  type SignalAlertFrequency,
  type SignalAlertRule,
  type SignalAlertTimeframe,
} from "../contracts/signal-alerts.ts";
import {
  backfillSignalAlert,
  barsFromYahooChart,
  describeSignalCondition,
  evaluateSignalAlert,
  isRegularSession,
  newYorkClock,
  parseWatchRequest,
  planSignalAlertRun,
  SIGNAL_ALERT_NOTIFICATION,
  SIGNAL_ALERT_TIMEFRAME_MS,
  type SignalAlertSeriesPlan,
  type SignalBar,
  type SignalBarsResult,
  signalAlertChartUrl,
} from "../signal-alerts.ts";
import type { ApiContext } from "./context.ts";
import type { DeployStatusConfig, DeployStatusFetch } from "./deploy-status.ts";
import type { HistoryBars } from "./ibkr-history.ts";
import {
  FallbackFailure,
  historyDate,
  historyFetchedAt,
  historyInstrument,
  LIVE_HISTORY_TIMEOUT_MS,
  loadMergedBars,
  newYorkTime,
  settle,
  windowFillBefore,
} from "./merged-bars.ts";
import { requireOperator } from "./operator-access.ts";
import {
  type PriceAlertsNtfyDelivery,
  sendPriceAlertsNtfy,
} from "./price-alerts-ntfy.ts";
import { fetchBoundedJson } from "./research-lenses.ts";
import type { PriceAlertsNtfyConfig } from "./service-config.ts";

// Signal alert and watch procedures (priceAlerts.signals.*), LuxAlgo P4. Operator-only. A run
// fetches each symbol/timeframe series once (IBKR history first within merged-bars.ts's per-isolate
// budget; public Yahoo for the rest, for older bars and for 1h series), evaluates the active
// rules arithmetically (no model call in the tick loop), inserts one event per fired bar and sends
// one fixed-text ntfy push per owner with a fire (the price alert destination). The browser shows
// events from priceAlerts.signals.events as in-app and OS notifications. No order path.

// A forming IBKR bar counts only from a service copy at most this old (as price alerts' quote limit).
const FORMING_BAR_MAX_AGE_MS = 60_000;

const api = implement(appContract).$context<ApiContext>();

const YAHOO_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) vertex-research/signal-alerts";
const YAHOO_MAX_BYTES = 6 * 1024 * 1024;
const SERIES_TIMEOUT_MS = 10_000;
const SERIES_CONCURRENCY = 4;

export type SignalAlertsOptions = Readonly<{
  fetch?: DeployStatusFetch;
  notify?: NotificationFetch;
  now?: () => Date;
}>;

let signalAlertsOptions: SignalAlertsOptions = {};
export const setSignalAlertsOptionsForTesting = (
  options: SignalAlertsOptions
): void => {
  signalAlertsOptions = options;
};

const currentTime = (): Date =>
  (signalAlertsOptions.now ?? (() => new Date()))();

type SeriesError = Readonly<{
  symbol: string;
  timeframe: SignalAlertTimeframe;
  reason: string;
}>;

/** Yahoo's bars of one series (the longest window Yahoo serves for the timeframe). */
const fetchYahooSeries = async (
  symbol: string,
  timeframe: SignalAlertTimeframe
): Promise<SignalBarsResult> => {
  try {
    const raw = await fetchBoundedJson(
      {
        headers: { "user-agent": YAHOO_USER_AGENT },
        label: "Yahoo chart",
        maxBytes: YAHOO_MAX_BYTES,
        url: signalAlertChartUrl(symbol, timeframe),
      },
      {
        ...(signalAlertsOptions.fetch === undefined
          ? {}
          : { fetch: signalAlertsOptions.fetch }),
        timeoutMs: SERIES_TIMEOUT_MS,
      }
    );
    return barsFromYahooChart(raw, timeframe);
  } catch (error) {
    return { ok: false, reason: (error as Error).message };
  }
};

/**
 * IBKR request per timeframe and the calendar days the series covers (Yahoo's range). 1h has none:
 * IBKR cannot serve the 1h window (a year of warm-up) in one request, 12 paced pages are about 4
 * minutes of the service's pacing for one series, and IBKR's hourly grid (09:30, 10:00, 11:00 ...)
 * differs from Yahoo's (09:30, 10:30 ...), so the two cannot share one series: Yahoo serves 1h.
 * Continuous futures take one page (CONTFUT has no end date), so Yahoo serves their older bars.
 */
const IBKR_SERIES: Readonly<
  Partial<
    Record<
      SignalAlertTimeframe,
      Readonly<{
        barSize: MarketBarSize;
        duration: string;
        pages: number;
        days: number;
      }>
    >
  >
> = Object.freeze({
  "1d": { barSize: "1 day", days: 730, duration: "2 Y", pages: 1 },
  "5m": { barSize: "5 mins", days: 30, duration: "30 D", pages: 1 },
  "15m": { barSize: "15 mins", days: 60, duration: "31 D", pages: 2 },
});

// Daily bars start at the regular session open (09:30 New York), or at midnight New York for
// futures, as Yahoo stamps them; IBKR stamps a daily bar 00:00 UTC of its trading date. A daily
// stock bar ends at 16:00 New York, a futures day at 17:00 New York (CME Globex).
const DAILY_MINUTES = {
  CONTFUT: { end: 17 * 60, start: 0 },
  STK: { end: 16 * 60, start: 9 * 60 + 30 },
} as const;

/** One IBKR bar as a signal bar; null without positive prices or when the cached copy holds it partial. */
const signalBarOf = (
  bar: MarketBar,
  history: HistoryBars,
  timeframe: SignalAlertTimeframe,
  now: Date
): SignalBar | null => {
  if (Math.min(bar.o, bar.h, bar.l, bar.c) <= 0) return null;
  const minutes =
    DAILY_MINUTES[history.request.secType === "CONTFUT" ? "CONTFUT" : "STK"];
  const daily = timeframe === "1d";
  const start = daily
    ? newYorkTime(historyDate(bar.t), minutes.start)
    : new Date(bar.t * 1000);
  const end = daily
    ? newYorkTime(historyDate(bar.t), minutes.end).getTime()
    : start.getTime() + SIGNAL_ALERT_TIMEFRAME_MS[timeframe];
  // The service answers from its cache: a bar that has closed by now but was still forming when the
  // copy was fetched holds a partial close, so it is dropped. A bar still forming now is kept only from a
  // copy at most FORMING_BAR_MAX_AGE_MS old (once and per-bar rules may fire on it); an older copy's
  // forming bar is dropped, so no rule fires on a partial close up to one cache lifetime old.
  const fetchedAt = historyFetchedAt(history).getTime();
  if (end > fetchedAt && end <= now.getTime()) return null;
  if (end > now.getTime() && now.getTime() - fetchedAt > FORMING_BAR_MAX_AGE_MS)
    return null;
  return { close: bar.c, high: bar.h, low: bar.l, open: bar.o, start };
};

/**
 * One series: IBKR first (a stale service copy is not used), Yahoo for the whole series when IBKR
 * fails, has no request slot or no request for the timeframe, and Yahoo for the bars older than
 * IBKR's first bar when IBKR starts later than the timeframe's window.
 */
const fetchSeries = (
  symbol: string,
  timeframe: SignalAlertTimeframe,
  config: DeployStatusConfig | null
): Promise<SignalBarsResult> => {
  const now = currentTime();
  const instrument = historyInstrument(symbol);
  const spec = IBKR_SERIES[timeframe];
  const daily = timeframe === "1d";
  const keyOf = (bar: SignalBar): string =>
    daily ? newYorkClock(bar.start).day : bar.start.toISOString();
  const fillBefore = windowFillBefore(now, spec?.days ?? 0);
  return settle(async (): Promise<SignalBarsResult> => {
    const merged = await loadMergedBars<SignalBar>({
      site: "signal-alerts",
      config,
      request:
        instrument === null || spec === undefined
          ? null
          : {
              ...instrument,
              barSize: spec.barSize,
              duration: spec.duration,
              useRTH: instrument.secType === "STK",
            },
      pages: instrument?.secType === "STK" ? (spec?.pages ?? 1) : 1,
      options: {
        ...(signalAlertsOptions.fetch === undefined
          ? {}
          : { fetch: signalAlertsOptions.fetch }),
        now: () => now,
        timeoutMs: LIVE_HISTORY_TIMEOUT_MS,
      },
      rejectStale: true,
      fillBefore: daily
        ? newYorkClock(fillBefore).day
        : fillBefore.toISOString(),
      fromIbkr: (bar, history) => signalBarOf(bar, history, timeframe, now),
      noRequestReason:
        spec === undefined
          ? "1h served by Yahoo"
          : "No IBKR contract for this symbol",
      yahoo: async () => {
        const result = await fetchYahooSeries(symbol, timeframe);
        if (!result.ok) throw new FallbackFailure(result.reason, result);
        return result.bars;
      },
      keyOf,
    });
    return { bars: merged.bars, ok: true };
  });
};

/** A stored condition that no longer parses is skipped (never evaluated with a guessed meaning). */
const conditionOf = (
  rule: SignalAlertRuleRecord
): SignalAlertCondition | null => {
  const parsed = SignalAlertConditionSchema.safeParse(rule.condition);
  return parsed.success ? parsed.data : null;
};

const toRuleOutput = (rule: SignalAlertRuleRecord): SignalAlertRule => {
  const condition = conditionOf(rule);
  return {
    condition: condition ?? {
      left: { field: "close", type: "price" },
      operator: "above",
      right: { type: "value", value: "0" },
    },
    createdAt: rule.createdAt,
    description:
      condition === null
        ? "Unreadable condition (skipped)"
        : describeSignalCondition(condition),
    fireCount: rule.fireCount,
    frequency: rule.frequency,
    id: rule.id,
    kind: rule.kind,
    lastBarAt: rule.lastBarAt,
    lastCheckedAt: rule.lastCheckedAt,
    lastFiredAt: rule.lastFiredAt,
    name: rule.name,
    origin: rule.origin,
    status: rule.status,
    symbol: rule.symbol,
    timeframe: rule.timeframe,
  };
};

const toEventOutput = (event: SignalAlertEventRecord): SignalAlertEvent => ({
  barAt: event.barAt,
  delivery: event.delivery,
  firedAt: event.firedAt,
  id: event.id,
  kind: event.kind,
  name: event.name,
  price: event.price,
  ruleId: event.ruleId,
  symbol: event.symbol,
});

const formatPrice = (price: number): string =>
  String(Number(price.toFixed(price >= 100 ? 2 : 4)));

type RunResult = Readonly<{
  checked: number;
  events: SignalAlertEventRecord[];
  seriesErrors: SeriesError[];
  deliveries: ReadonlyMap<string, PriceAlertsNtfyDelivery>;
}>;

/**
 * Fetch, evaluate, record fires, notify. Rules whose series failed keep their cursor and move to the
 * back of the queue. Owners are notified after the events are stored, so a failed push never loses
 * the in-app record, and the (rule, bar) key keeps a repeat run from firing the same bar twice.
 */
const runSignalAlerts = async (
  repository: SignalAlertRepository,
  config: PriceAlertsNtfyConfig | null,
  history: DeployStatusConfig | null,
  candidates: readonly SignalAlertRuleRecord[]
): Promise<RunResult> => {
  const now = currentTime();
  const plan = planSignalAlertRun(
    candidates.filter((rule) => rule.status === "active"),
    SIGNAL_ALERT_MAX_SERIES_PER_RUN
  );
  const groups = [...plan.series.values()];
  const seriesErrors: SeriesError[] = [];
  const bars = new Map<
    SignalAlertSeriesPlan<SignalAlertRuleRecord>,
    readonly SignalBar[]
  >();
  for (let start = 0; start < groups.length; start += SERIES_CONCURRENCY) {
    await Promise.all(
      groups.slice(start, start + SERIES_CONCURRENCY).map(async (group) => {
        const result = await fetchSeries(
          group.symbol,
          group.timeframe,
          history
        );
        if (result.ok) bars.set(group, result.bars);
        else
          seriesErrors.push({
            reason: result.reason,
            symbol: group.symbol,
            timeframe: group.timeframe,
          });
      })
    );
  }
  let checked = 0;
  const unfetched: string[] = plan.deferred.map((rule) => rule.id);
  const events: SignalAlertEventRecord[] = [];
  for (const group of groups) {
    const series = bars.get(group);
    for (const rule of group.rules) {
      const condition = conditionOf(rule);
      if (series === undefined || condition === null) {
        unfetched.push(rule.id);
        continue;
      }
      checked += 1;
      const evaluation = evaluateSignalAlert(
        {
          condition,
          frequency: rule.frequency,
          regularSession: isRegularSession(rule.symbol),
          timeframe: rule.timeframe,
        },
        {
          activeSince: rule.activatedAt ?? rule.createdAt,
          lastBarAt: rule.lastBarAt,
          lastFiredBarAt: rule.lastFiredBarAt,
        },
        series,
        now
      );
      for (const fire of evaluation.fires) {
        const event = await repository.recordFire({
          barAt: fire.barAt,
          done: evaluation.done,
          price: formatPrice(fire.price),
          ruleId: rule.id,
          userId: rule.userId,
        });
        if (event !== null) events.push(event);
      }
      await repository.markChecked(rule.id, evaluation.lastBarAt, now);
    }
  }
  await repository.markAttempted(unfetched);
  const owners = new Map<string, SignalAlertEventRecord[]>();
  for (const event of events)
    owners.set(event.userId, [...(owners.get(event.userId) ?? []), event]);
  const deliveries = new Map<string, PriceAlertsNtfyDelivery>();
  const settled: SignalAlertEventRecord[] = [];
  for (const [userId, owned] of owners) {
    const ids = owned.map((event) => event.id);
    const delivery = await sendPriceAlertsNtfy(
      config,
      SIGNAL_ALERT_NOTIFICATION,
      `signal:${now.toISOString()}:${ids.join(",")}`,
      now,
      signalAlertsOptions.notify
    );
    deliveries.set(userId, delivery);
    await repository.recordDelivery(ids, delivery);
    settled.push(...owned.map((event) => ({ ...event, delivery })));
  }
  return { checked, deliveries, events: settled, seriesErrors };
};

type Failures = Readonly<{
  BAD_REQUEST: (options?: { message?: string }) => Error;
  FORBIDDEN: (options?: { message?: string }) => Error;
  NOT_FOUND: (options?: { message?: string }) => Error;
  UPSTREAM_ERROR: (options?: { message?: string }) => Error;
  VALIDATION_ERROR: (options?: { message?: string }) => Error;
  STORAGE_ERROR: () => Error;
}>;

const rulesFor = (
  context: ApiContext,
  failures: Failures
): SignalAlertRepository => {
  const repository = context.repositories.signalAlerts;
  if (repository === undefined) throw failures.STORAGE_ERROR();
  return repository;
};

const backfillFor = async (
  input: Readonly<{
    symbol: string;
    timeframe: SignalAlertTimeframe;
    condition: SignalAlertCondition;
  }>,
  history: DeployStatusConfig | null
) => {
  const result = await fetchSeries(input.symbol, input.timeframe, history);
  if (!result.ok) return { ok: false as const, reason: result.reason };
  return {
    backfill: backfillSignalAlert(
      input.condition,
      result.bars,
      input.timeframe,
      currentTime(),
      isRegularSession(input.symbol)
    ),
    ok: true as const,
  };
};

const createRule = async (
  repository: SignalAlertRepository,
  failures: Failures,
  input: Parameters<SignalAlertRepository["create"]>[0]
): Promise<SignalAlertRuleRecord> => {
  try {
    return await repository.create(input);
  } catch (error) {
    if (error instanceof SignalAlertLimitError)
      throw failures.VALIDATION_ERROR({ message: error.message });
    throw error;
  }
};

const defaultName = (
  symbol: string,
  timeframe: SignalAlertTimeframe,
  condition: SignalAlertCondition
): string =>
  `${symbol} ${timeframe}: ${describeSignalCondition(condition)}`.slice(0, 120);

/**
 * Activating a rule is the owner's own click: agent keys may propose, list, dismiss and remove, but
 * never create an active alert or start a proposed watch.
 */
const refuseAgentKey = (
  context: ApiContext,
  failures: Failures,
  procedure: "create" | "start"
): void => {
  if (context.agentApiKeyPresented === true)
    throw failures.FORBIDDEN({
      message: `priceAlerts.signals.${procedure} is session-only; agents use propose`,
    });
};

const notificationsOf = (context: ApiContext) =>
  (context.priceAlertsNtfy ?? null) === null
    ? ("not-configured" as const)
    : ("configured" as const);

const list = api.priceAlerts.signals.list
  .use(requireOperator)
  .handler(async ({ context, errors }) => {
    const failures = errors as unknown as Failures;
    const rules = await rulesFor(context, failures).listByUser(
      context.principal.userId
    );
    return {
      notifications: notificationsOf(context),
      rules: rules.map(toRuleOutput),
    };
  });

const create = api.priceAlerts.signals.create
  .use(requireOperator)
  .handler(async ({ context, input, errors }) => {
    const failures = errors as unknown as Failures;
    refuseAgentKey(context, failures, "create");
    const rule = await createRule(rulesFor(context, failures), failures, {
      condition: input.condition,
      frequency: input.frequency,
      kind: "alert",
      name:
        input.name ??
        defaultName(input.symbol, input.timeframe, input.condition),
      origin: input.origin,
      status: "active",
      symbol: input.symbol,
      timeframe: input.timeframe,
      userId: context.principal.userId,
    });
    return { rule: toRuleOutput(rule) };
  });

const backfill = api.priceAlerts.signals.backfill
  .use(requireOperator)
  .handler(async ({ context, input, errors }) => {
    const failures = errors as unknown as Failures;
    const result = await backfillFor(input, context.marketHistory ?? null);
    if (!result.ok) throw failures.UPSTREAM_ERROR({ message: result.reason });
    return {
      backfill: result.backfill,
      description: describeSignalCondition(input.condition),
    };
  });

const propose = api.priceAlerts.signals.propose
  .use(requireOperator)
  .handler(async ({ context, input, errors }) => {
    const failures = errors as unknown as Failures;
    let fields: Readonly<{
      symbol: string;
      timeframe: SignalAlertTimeframe;
      frequency: SignalAlertFrequency;
      condition: SignalAlertCondition;
      name: string | undefined;
      summary: string;
    }>;
    if ("text" in input) {
      const parsed = parseWatchRequest(input.text);
      if (!parsed.ok) return { ok: false as const, reason: parsed.reason };
      fields = { ...parsed.proposal, name: undefined };
    } else {
      fields = {
        condition: input.condition,
        frequency: input.frequency,
        name: input.name,
        summary: `Watch ${input.symbol} on ${input.timeframe} bars: alert when ${describeSignalCondition(input.condition)}.`,
        symbol: input.symbol,
        timeframe: input.timeframe,
      };
    }
    const rule = await createRule(rulesFor(context, failures), failures, {
      condition: fields.condition,
      frequency: fields.frequency,
      kind: "watch",
      name:
        fields.name ??
        defaultName(fields.symbol, fields.timeframe, fields.condition),
      origin: "quant",
      status: "proposed",
      symbol: fields.symbol,
      timeframe: fields.timeframe,
      userId: context.principal.userId,
    });
    // The backfill is context for the card; a market-data failure never blocks the proposal.
    const history = await backfillFor(fields, context.marketHistory ?? null);
    return {
      backfill: history.ok ? history.backfill : null,
      ok: true as const,
      rule: toRuleOutput(rule),
      summary: fields.summary,
    };
  });

const start = api.priceAlerts.signals.start
  .use(requireOperator)
  .handler(async ({ context, input, errors }) => {
    const failures = errors as unknown as Failures;
    refuseAgentKey(context, failures, "start");
    const rule = await rulesFor(context, failures).transition(
      input.id,
      context.principal.userId,
      ["proposed"],
      "active"
    );
    if (rule === null)
      throw failures.NOT_FOUND({ message: "No proposed watch with that id" });
    return { rule: toRuleOutput(rule) };
  });

const dismiss = api.priceAlerts.signals.dismiss
  .use(requireOperator)
  .handler(async ({ context, input, errors }) => {
    const failures = errors as unknown as Failures;
    const rule = await rulesFor(context, failures).transition(
      input.id,
      context.principal.userId,
      ["proposed", "active"],
      "dismissed"
    );
    if (rule === null) throw failures.NOT_FOUND();
    return { rule: toRuleOutput(rule) };
  });

const remove = api.priceAlerts.signals.remove
  .use(requireOperator)
  .handler(async ({ context, input, errors }) => {
    const failures = errors as unknown as Failures;
    const removed = await rulesFor(context, failures).remove(
      input.id,
      context.principal.userId
    );
    if (!removed) throw failures.NOT_FOUND();
    return { id: input.id, removed: true as const };
  });

const events = api.priceAlerts.signals.events
  .use(requireOperator)
  .handler(async ({ context, input, errors }) => {
    const failures = errors as unknown as Failures;
    const stored = await rulesFor(context, failures).listEvents(
      context.principal.userId,
      input.since ?? null,
      SIGNAL_ALERT_EVENTS_MAX
    );
    return { events: stored.map(toEventOutput) };
  });

const check = api.priceAlerts.signals.check
  .use(requireOperator)
  .handler(async ({ context, errors }) => {
    const failures = errors as unknown as Failures;
    const repository = rulesFor(context, failures);
    const userId = context.principal.userId;
    const result = await runSignalAlerts(
      repository,
      context.priceAlertsNtfy ?? null,
      context.marketHistory ?? null,
      await repository.listActiveByUser(userId)
    );
    return {
      checked: result.checked,
      delivery: result.deliveries.get(userId) ?? ("none" as const),
      events: result.events.map(toEventOutput),
      seriesErrors: result.seriesErrors,
    };
  });

const tick = api.priceAlerts.signals.tick
  .use(requireOperator)
  .handler(async ({ context, errors }) => {
    const failures = errors as unknown as Failures;
    if (context.agentApiKeyPresented !== true)
      throw failures.FORBIDDEN({
        message:
          "priceAlerts.signals.tick needs an agent API key; use check instead",
      });
    const repository = rulesFor(context, failures);
    const result = await runSignalAlerts(
      repository,
      context.priceAlertsNtfy ?? null,
      context.marketHistory ?? null,
      await repository.listActive(
        SIGNAL_ALERT_TICK_MAX_RULES,
        context.operatorEmails
      )
    );
    const outcomes = [...result.deliveries.values()];
    return {
      checked: result.checked,
      deliveries: {
        failed: outcomes.filter((outcome) => outcome === "failed").length,
        notConfigured: outcomes.filter(
          (outcome) => outcome === "not-configured"
        ).length,
        sent: outcomes.filter((outcome) => outcome === "sent").length,
      },
      fired: result.events.length,
      seriesErrors: result.seriesErrors,
    };
  });

export const signalAlertsRouter = {
  backfill,
  check,
  create,
  dismiss,
  events,
  list,
  propose,
  remove,
  start,
  tick,
};
