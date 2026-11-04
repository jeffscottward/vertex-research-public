import {
  PriceAlertLimitError,
  type PriceAlertRepository,
  type PriceAlertRuleRecord,
  type PriceAlertRuleState,
  type WatchlistRepository,
} from "@darkfactory/db/server";
import {
  createNtfyNotificationAdapter,
  type NotificationFetch,
} from "@darkfactory/notifications/server";
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
  type PriceAlertQuote,
  type PriceAlertQuoteResult,
  planPriceAlertRun,
  priceAlertChartUrl,
  quoteFromYahooChart,
} from "../price-alerts.ts";
import type { ApiContext } from "./context.ts";
import type { DeployStatusFetch } from "./deploy-status.ts";
import { requireOperator } from "./operator-access.ts";
import { fetchBoundedJson } from "./research-lenses.ts";

// Price alert procedures (priceAlerts.*). Operator-only: a session operator manages their own rules
// and runs check; an operator agent write key runs tick for every owner (scripts/price-alerts). A run
// quotes each watched symbol once from Yahoo (public GET, bounded), evaluates the active rules,
// triggers each rule at most once and sends one fixed-text ntfy notification per owner with a
// trigger. The topic and token never leave this module and are never logged. No order path.

const api = implement(appContract).$context<ApiContext>();

const YAHOO_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) vertex-research/price-alerts";
const YAHOO_MAX_BYTES = 2 * 1024 * 1024;
const QUOTE_TIMEOUT_MS = 8000;
const QUOTE_CONCURRENCY = 5;
const NTFY_TIMEOUT_MS = 10_000;
const NOTIFICATION_TENANT = "vertex";
const NOTIFICATION_RECIPIENT = "price-alerts";
const NOTIFICATION_CONFIGURATION = "price-alerts-ntfy";

/** Server-only ntfy destination (VERTEX_PRICE_ALERTS_NTFY_*). Never returned to clients or logged. */
export type PriceAlertsNtfyConfig = Readonly<{
  origin: string;
  topic: string;
  token: string | null;
}>;

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
  /** Yahoo quote fetch. */
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

type Delivery = "sent" | "not-configured" | "failed";
type QuoteError = Readonly<{ symbol: string; reason: string }>;
type ActiveRule = PriceAlertRuleRecord &
  Readonly<{ state: Extract<PriceAlertRuleState, { status: "active" }> }>;

type RunResult = Readonly<{
  checked: number;
  triggered: PriceAlertRuleRecord[];
  quoteErrors: QuoteError[];
  deliveries: ReadonlyMap<string, Delivery>;
}>;

const fetchQuote = async (symbol: string): Promise<PriceAlertQuoteResult> => {
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

const sha256Hex = async (text: string): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text)
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
};

/**
 * One ntfy message through the notifications package, sent to the price alert ntfy destination
 * (also used by sectorRotation.collect). The idempotency key is the SHA-256 of `idempotencySource`.
 */
export const sendPriceAlertsNtfy = async (
  config: PriceAlertsNtfyConfig | null,
  message: Readonly<{ title: string; body: string }>,
  idempotencySource: string,
  at: Date,
  notify?: NotificationFetch
): Promise<Delivery> => {
  if (config === null) return "not-configured";
  const fetcher =
    notify ?? ((url: string, init: RequestInit) => globalThis.fetch(url, init));
  const adapter = createNtfyNotificationAdapter({
    enabled: true,
    fetcher,
    resolveConfiguration: async () => ({
      bearerToken: config.token,
      enabled: true,
      origin: config.origin,
      recipientKey: NOTIFICATION_RECIPIENT,
      tenantKey: NOTIFICATION_TENANT,
      topic: config.topic,
    }),
    timeoutMs: NTFY_TIMEOUT_MS,
  });
  const signal = new AbortController().signal;
  const preparation = await adapter.prepare(
    {
      authenticated: true,
      channel: "phone",
      configurationRef: NOTIFICATION_CONFIGURATION,
      cooldownMs: 1000,
      enabled: true,
      expiresAt: at.getTime() + 10 * 60_000,
      purpose: "market-alert",
      recipientKey: NOTIFICATION_RECIPIENT,
      recipientRef: NOTIFICATION_RECIPIENT,
      tenantKey: NOTIFICATION_TENANT,
    },
    signal
  );
  if (preparation.status !== "ready") return "failed";
  const outcome = await preparation.send(
    {
      body: message.body,
      providerIdempotencyKey: await sha256Hex(idempotencySource),
      title: message.title,
    },
    signal
  );
  return outcome.acceptance === "accepted" ? "sent" : "failed";
};

const isActive = (rule: PriceAlertRuleRecord): rule is ActiveRule =>
  rule.state.status === "active";

/** Quotes each symbol once, a few requests at a time. */
const fetchQuotes = async (
  symbols: readonly string[]
): Promise<
  Readonly<{ quotes: Map<string, PriceAlertQuote>; errors: QuoteError[] }>
> => {
  const quotes = new Map<string, PriceAlertQuote>();
  const errors: QuoteError[] = [];
  for (let start = 0; start < symbols.length; start += QUOTE_CONCURRENCY) {
    const batch = symbols.slice(start, start + QUOTE_CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (symbol) => ({
        result: await fetchQuote(symbol),
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
  const deliveries = new Map<string, Delivery>();
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
  candidates: readonly PriceAlertRuleRecord[]
): Promise<RunResult> => {
  const now = (priceAlertsOptions.now ?? (() => new Date()))();
  const plan = planPriceAlertRun(
    candidates.filter(isActive),
    PRICE_ALERT_MAX_SYMBOLS_PER_RUN
  );
  const { errors, quotes } = await fetchQuotes(plan.symbols);
  let checked = 0;
  const untouched: string[] = [];
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
      untouched.push(rule.id);
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
  await repository.markChecked(untouched, now);
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

export const priceAlertsRouter = { check, create, list, remove, tick };
