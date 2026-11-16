import {
  PriceAlertLimitError,
  type PriceAlertRepository,
  type PriceAlertRuleRecord,
  type PriceAlertRuleState,
  type WatchlistRepository,
} from "@darkfactory/db/server";
import type { NotificationFetch } from "@darkfactory/notifications/server";
import { implement } from "@orpc/server";

import { appContract } from "../contract.ts";
import {
  PRICE_ALERT_MAX_SYMBOLS_PER_RUN,
  PRICE_ALERT_TICK_MAX_RULES,
  type PriceAlertRule,
} from "../contracts/price-alerts.ts";
import {
  evaluatePriceAlert,
  formatPriceAlertPrice,
  PRICE_ALERT_NOTIFICATION,
  type PriceAlertBar,
  type PriceAlertQuote,
  type PriceAlertQuoteResult,
  planPriceAlertRun,
  priceAlertChartUrl,
  quoteFromYahooChart,
} from "../price-alerts.ts";
import type { ApiContext } from "./context.ts";
import type { DeployStatusConfig, DeployStatusFetch } from "./deploy-status.ts";
import {
  FallbackFailure,
  historyFetchedAt,
  historyInstrument,
  LIVE_HISTORY_TIMEOUT_MS,
  loadMergedBars,
  sessionOpen,
  settle,
} from "./merged-bars.ts";
import { requireOperator } from "./operator-access.ts";
import {
  type PriceAlertsNtfyDelivery,
  sendPriceAlertsNtfy,
} from "./price-alerts-ntfy.ts";
import { fetchBoundedJson } from "./research-lenses.ts";
import type { PriceAlertsNtfyConfig } from "./service-config.ts";

export type { PriceAlertsNtfyConfig } from "./service-config.ts";
import { signalAlertsRouter } from "./signal-alerts.ts";

// Price alert procedures (priceAlerts.*). Operator-only: a session operator manages their own rules
// and runs check; an operator agent write key runs tick for every owner (scripts/price-alerts). A run
// quotes each watched symbol once (IBKR 5-minute history first within merged-bars.ts's per-isolate
// budget; public Yahoo for the rest), evaluates the active rules,
// triggers each rule at most once and sends one fixed-text ntfy notification per owner with a
// trigger (price-alerts-ntfy.ts; the topic and token are never logged). No order path.

const api = implement(appContract).$context<ApiContext>();

const YAHOO_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) vertex-research/price-alerts";
const YAHOO_MAX_BYTES = 2 * 1024 * 1024;
const QUOTE_TIMEOUT_MS = 8000;
const QUOTE_CONCURRENCY = 5;

/** Configured only when both the origin and the topic are set. */
export const resolvePriceAlertsNtfyConfig = (
  origin: string | undefined,
  topic: string | undefined,
  token: string | undefined
): PriceAlertsNtfyConfig | null =>
  origin === undefined || topic === undefined
    ? null
    : { origin, token: token ?? null, topic };

export type PriceAlertsOptions = Readonly<{
  /** Yahoo quote and IBKR history fetch. */
  fetch?: DeployStatusFetch;
  /** ntfy publish fetch. */
  notify?: NotificationFetch;
  now?: () => Date;
}>;

let priceAlertsOptions: PriceAlertsOptions = {};
export const setPriceAlertsOptionsForTesting = (
  options: PriceAlertsOptions
): void => {
  priceAlertsOptions = options;
};

const currentTime = (): Date =>
  (priceAlertsOptions.now ?? (() => new Date()))();

type QuoteError = Readonly<{ symbol: string; reason: string }>;
type ActiveRule = PriceAlertRuleRecord &
  Readonly<{ state: Extract<PriceAlertRuleState, { status: "active" }> }>;

type RunResult = Readonly<{
  checked: number;
  triggered: PriceAlertRuleRecord[];
  quoteErrors: QuoteError[];
  deliveries: ReadonlyMap<string, PriceAlertsNtfyDelivery>;
}>;

/** Yahoo's last price and today's 5-minute bars. */
const fetchYahooQuote = async (
  symbol: string
): Promise<PriceAlertQuoteResult> => {
  try {
    const raw = await fetchBoundedJson(
      {
        headers: { "user-agent": YAHOO_USER_AGENT },
        label: "Yahoo chart",
        maxBytes: YAHOO_MAX_BYTES,
        url: priceAlertChartUrl(symbol),
      },
      {
        ...(priceAlertsOptions.fetch === undefined
          ? {}
          : { fetch: priceAlertsOptions.fetch }),
        timeoutMs: QUOTE_TIMEOUT_MS,
      }
    );
    return quoteFromYahooChart(raw, symbol);
  } catch (error) {
    // fetchBoundedJson reports every failure as a ResearchLensError without the URL.
    return { ok: false, reason: (error as Error).message };
  }
};

/**
 * An IBKR copy fetched longer ago than this is not a quote. The owner wants IBKR first, but the
 * service caches 5-minute bars for up to 300 s, so most checks find an older copy and fall back to
 * Yahoo under this limit; IBKR serves the checks that land shortly after a fresh fetch.
 */
const QUOTE_MAX_AGE_MS = 60_000;

// IBKR bars keep their close: the newest one is the last price.
type QuoteBar = PriceAlertBar & Readonly<{ close?: number }>;

/**
 * Today's 5-minute bars and the last price: IBKR first (5 mins, 1 D; a stale copy or one fetched
 * more than QUOTE_MAX_AGE_MS ago is not used), Yahoo for the whole quote when IBKR fails or has no
 * request slot, and Yahoo for the bars before IBKR's first bar when IBKR starts after `needsFrom` (the
 * earliest window of the symbol's rules, at most back to today's 09:30 New York open: Yahoo's
 * range=1d has nothing older either). An IBKR quote carries `asOf` = min(now, fetch time): its rules
 * are marked checked only up to the time the copy covers, so a touch between the fetch and the check
 * is evaluated on the next check.
 */
const fetchQuote = (
  symbol: string,
  config: DeployStatusConfig | null,
  needsFrom: Date
): Promise<PriceAlertQuoteResult> => {
  const now = currentTime();
  const instrument = historyInstrument(symbol);
  const open = sessionOpen(now);
  let yahoo: PriceAlertQuoteResult | null = null;
  return settle(async (): Promise<PriceAlertQuoteResult> => {
    const merged = await loadMergedBars<QuoteBar>({
      site: "price-alerts",
      config,
      request:
        instrument === null
          ? null
          : {
              ...instrument,
              barSize: "5 mins",
              duration: "1 D",
            },
      options: {
        ...(priceAlertsOptions.fetch === undefined
          ? {}
          : { fetch: priceAlertsOptions.fetch }),
        now: () => now,
        timeoutMs: LIVE_HISTORY_TIMEOUT_MS,
      },
      rejectStale: true,
      maxAgeMs: QUOTE_MAX_AGE_MS,
      fillBefore: new Date(
        Math.max(needsFrom.getTime(), open.getTime())
      ).toISOString(),
      fromIbkr: (bar) =>
        Math.min(bar.h, bar.l, bar.c) > 0
          ? {
              close: bar.c,
              high: bar.h,
              low: bar.l,
              start: new Date(bar.t * 1000),
            }
          : null,
      yahoo: async () => {
        const result = await fetchYahooQuote(symbol);
        yahoo = result;
        if (!result.ok) throw new FallbackFailure(result.reason, result);
        return result.quote.bars;
      },
      keyOf: (bar) => bar.start.toISOString(),
    });
    const read = yahoo as PriceAlertQuoteResult | null;
    if (merged.history === null) return read as PriceAlertQuoteResult;
    const newest = merged.bars.filter((bar) => bar.source === "ibkr").at(-1);
    const { close, start } = newest as QuoteBar;
    return {
      ok: true,
      quote: {
        bars: merged.bars,
        last: close as number,
        asOf: new Date(
          Math.min(now.getTime(), historyFetchedAt(merged.history).getTime())
        ),
        lastAt: new Date(Math.min(now.getTime(), start.getTime() + 5 * 60_000)),
        symbol,
      },
    };
  });
};

const isActive = (rule: PriceAlertRuleRecord): rule is ActiveRule =>
  rule.state.status === "active";

/** Quotes each symbol once, a few requests at a time. */
const fetchQuotes = async (
  symbols: readonly string[],
  config: DeployStatusConfig | null,
  needsFrom: ReadonlyMap<string, Date>
): Promise<
  Readonly<{ quotes: Map<string, PriceAlertQuote>; errors: QuoteError[] }>
> => {
  const quotes = new Map<string, PriceAlertQuote>();
  const errors: QuoteError[] = [];
  for (let start = 0; start < symbols.length; start += QUOTE_CONCURRENCY) {
    const batch = symbols.slice(start, start + QUOTE_CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (symbol) => ({
        // Every planned symbol has a rule, so it has a window start.
        result: await fetchQuote(symbol, config, needsFrom.get(symbol) as Date),
        symbol,
      }))
    );
    for (const { result, symbol } of results) {
      if (result.ok) quotes.set(symbol, result.quote);
      else errors.push({ reason: result.reason, symbol });
    }
  }
  return { errors, quotes };
};

/** One notification per owner, then the outcome is stored on that owner's triggered rules. */
const notifyOwners = async (
  repository: PriceAlertRepository,
  config: PriceAlertsNtfyConfig | null,
  triggered: readonly PriceAlertRuleRecord[],
  now: Date
): Promise<Pick<RunResult, "deliveries" | "triggered">> => {
  const owners = new Map<string, string[]>();
  for (const rule of triggered)
    owners.set(rule.userId, [...(owners.get(rule.userId) ?? []), rule.id]);
  const deliveries = new Map<string, PriceAlertsNtfyDelivery>();
  const settled = new Map<string, PriceAlertRuleRecord>();
  for (const [userId, ids] of owners) {
    const delivery = await sendPriceAlertsNtfy(
      config,
      PRICE_ALERT_NOTIFICATION,
      `${now.toISOString()}:${ids.join(",")}`,
      now,
      priceAlertsOptions.notify
    );
    deliveries.set(userId, delivery);
    for (const record of await repository.recordDelivery(ids, delivery))
      settled.set(record.id, record);
  }
  return {
    deliveries,
    triggered: triggered.map((rule) => settled.get(rule.id) ?? rule),
  };
};

/**
 * Quote, evaluate, trigger and notify. Rules whose quote failed keep their window for the next run
 * but move to the back of the queue. Owners are notified before the checked marks are written, so a
 * failed mark can only cause a repeat evaluation, never a lost notification.
 */
const runPriceAlerts = async (
  repository: PriceAlertRepository,
  config: PriceAlertsNtfyConfig | null,
  history: DeployStatusConfig | null,
  candidates: readonly PriceAlertRuleRecord[]
): Promise<RunResult> => {
  const now = currentTime();
  const plan = planPriceAlertRun(
    candidates.filter(isActive),
    PRICE_ALERT_MAX_SYMBOLS_PER_RUN
  );
  // The oldest bar each symbol's rules may use: the earliest last check (or creation) of its rules.
  const needsFrom = new Map<string, Date>();
  for (const rule of plan.rules) {
    const from = rule.state.lastCheckedAt ?? rule.createdAt;
    const earliest = needsFrom.get(rule.symbol);
    if (earliest === undefined || from < earliest)
      needsFrom.set(rule.symbol, from);
  }
  const { errors, quotes } = await fetchQuotes(
    plan.symbols,
    history,
    needsFrom
  );
  let checked = 0;
  // Untouched rules by the time their quote covers (IBKR: its fetch time; Yahoo: now).
  const untouched = new Map<number, string[]>();
  const unquoted: string[] = [];
  const triggered: PriceAlertRuleRecord[] = [];
  for (const rule of plan.rules) {
    const quote = quotes.get(rule.symbol);
    if (quote === undefined) {
      unquoted.push(rule.id);
      continue;
    }
    checked += 1;
    const evaluation = evaluatePriceAlert(
      {
        createdAt: rule.createdAt,
        kind: rule.kind,
        lastCheckedAt: rule.state.lastCheckedAt,
        level: rule.level,
      },
      quote
    );
    if (!evaluation.hit) {
      const at = (quote.asOf ?? now).getTime();
      untouched.set(at, [...(untouched.get(at) ?? []), rule.id]);
      continue;
    }
    const record = await repository.trigger({
      id: rule.id,
      triggeredAt: now,
      triggerPrice: formatPriceAlertPrice(evaluation.price),
    });
    if (record !== null) triggered.push(record);
  }
  const notified = await notifyOwners(repository, config, triggered, now);
  for (const [at, ids] of untouched)
    await repository.markChecked(ids, new Date(at));
  await repository.markAttempted(unquoted);
  return { checked, quoteErrors: errors, ...notified };
};

const toRuleOutput = (rule: PriceAlertRuleRecord): PriceAlertRule => ({
  createdAt: rule.createdAt,
  id: rule.id,
  kind: rule.kind,
  level: rule.level,
  note: rule.note,
  role: rule.role,
  state: rule.state,
  symbol: rule.symbol,
});

type Failures = Readonly<{
  BAD_REQUEST: (options?: { message?: string }) => Error;
  FORBIDDEN: (options?: { message?: string }) => Error;
  NOT_FOUND: (options?: { message?: string }) => Error;
  VALIDATION_ERROR: (options?: { message?: string }) => Error;
  STORAGE_ERROR: () => Error;
}>;

const rulesFor = (
  context: ApiContext,
  failures: Failures
): PriceAlertRepository => {
  const repository = context.repositories.priceAlerts;
  if (repository === undefined) throw failures.STORAGE_ERROR();
  return repository;
};

const watchlistFor = (
  context: ApiContext,
  failures: Failures
): WatchlistRepository => {
  const repository = context.repositories.watchlist;
  if (repository === undefined) throw failures.STORAGE_ERROR();
  return repository;
};

const list = api.priceAlerts.list
  .use(requireOperator)
  .handler(async ({ context, errors }) => {
    const failures = errors as unknown as Failures;
    const rules = rulesFor(context, failures);
    const watchlist = watchlistFor(context, failures);
    const userId = context.principal.userId;
    const [stored, items] = await Promise.all([
      rules.listByUser(userId),
      watchlist.listByUser(userId),
    ]);
    return {
      notifications:
        (context.priceAlertsNtfy ?? null) === null
          ? ("not-configured" as const)
          : ("configured" as const),
      rules: stored.map(toRuleOutput),
      symbols: items.map((item) => item.symbol),
    };
  });

const create = api.priceAlerts.create
  .use(requireOperator)
  .handler(async ({ context, input, errors }) => {
    const failures = errors as unknown as Failures;
    const rules = rulesFor(context, failures);
    const userId = context.principal.userId;
    const items = await watchlistFor(context, failures).listByUser(userId);
    if (!items.some((item) => item.symbol === input.symbol))
      throw failures.BAD_REQUEST({
        message: "Add the symbol to your watchlist before creating an alert",
      });
    try {
      const rule = await rules.create({
        kind: input.kind,
        level: input.level,
        note: input.note ?? null,
        role: input.role,
        symbol: input.symbol,
        userId,
      });
      return { rule: toRuleOutput(rule) };
    } catch (error) {
      if (error instanceof PriceAlertLimitError)
        throw failures.VALIDATION_ERROR({ message: error.message });
      throw error;
    }
  });

const remove = api.priceAlerts.remove
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

const check = api.priceAlerts.check
  .use(requireOperator)
  .handler(async ({ context, errors }) => {
    const failures = errors as unknown as Failures;
    const rules = rulesFor(context, failures);
    const userId = context.principal.userId;
    const result = await runPriceAlerts(
      rules,
      context.priceAlertsNtfy ?? null,
      context.marketHistory ?? null,
      await rules.listActiveByUser(userId)
    );
    return {
      checked: result.checked,
      delivery: result.deliveries.get(userId) ?? ("none" as const),
      quoteErrors: result.quoteErrors,
      rules: (await rules.listByUser(userId)).map(toRuleOutput),
      triggered: result.triggered.map(toRuleOutput),
    };
  });

const tick = api.priceAlerts.tick
  .use(requireOperator)
  .handler(async ({ context, errors }) => {
    const failures = errors as unknown as Failures;
    // Scheduler only: the tick runs every owner's rules. Session operators use check.
    if (context.agentApiKeyPresented !== true)
      throw failures.FORBIDDEN({
        message: "priceAlerts.tick needs an agent API key; use check instead",
      });
    const rules = rulesFor(context, failures);
    // Only owners who are still operators: one ntfy topic serves the whole deployment.
    const result = await runPriceAlerts(
      rules,
      context.priceAlertsNtfy ?? null,
      context.marketHistory ?? null,
      await rules.listActive(PRICE_ALERT_TICK_MAX_RULES, context.operatorEmails)
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
      quoteErrors: result.quoteErrors,
      triggered: result.triggered.length,
    };
  });

export const priceAlertsRouter = {
  check,
  create,
  list,
  remove,
  signals: signalAlertsRouter,
  tick,
};
