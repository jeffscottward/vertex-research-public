import { z } from "zod";

import type {
  ResearchScreenAction,
  ResearchScreenErrorCode,
} from "./contracts/research-screen.ts";
import { wilderAtr } from "./pick-list-screen.ts";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** The constants of the research screen that pure code needs. */
export const RESEARCH_SCREEN_LIMITS = Object.freeze({
  historyAgeLimitMs: 4 * DAY_MS,
  ibkrFailureStop: 3,
  leaseSeconds: 240,
  maxMessageLength: 400,
  maxMessages: 24,
  minimumBars: 50,
  quoteAgeLimitMs: 4 * HOUR_MS,
  runDeadlineMs: 25 * MINUTE_MS,
  schedulerLateMs: 30 * MINUTE_MS,
  schedulerOkMs: 10 * MINUTE_MS,
  shareBudgetMs: 50_000,
  swinglyticsStaleMs: 4 * HOUR_MS,
  yahooRateLimitStop: 3,
} as const);

export type ResearchScreenBar = Readonly<{
  date: string;
  o: number;
  h: number;
  l: number;
  c: number;
}>;

export type ResearchScreenQuote = Readonly<{
  price: number | null;
  quoteAt: Date | null;
  instrumentType: string | null;
  currency: string | null;
  timeZone: string | null;
  sessionStart: Date | null;
  sessionEnd: Date | null;
}>;

export type ResearchScreenEvidence = Readonly<{
  quote: ResearchScreenQuote | null;
  bars: readonly ResearchScreenBar[];
  barsSource: "ibkr" | "yahoo" | null;
  fetchError: ResearchScreenErrorCode | null;
}>;

export type CatalogAssetType = "equity" | "etf" | "future" | "index";

export type CatalogAlias = Readonly<{
  input: string;
  resolution: string;
  confirmed: boolean;
}>;

/** A catalog report with a verified identity and valid screen metadata. */
export type CatalogEntry = Readonly<{
  id: string;
  symbol: string;
  providerSymbol: string;
  assetType: CatalogAssetType;
  status: string;
  currency: string;
  timeZone: string;
  aliases: readonly CatalogAlias[];
  hasContractSpecs: boolean;
}>;

export type BlockingWarning = Readonly<{ code: string; text: string }>;

export type ScreenObservation = Readonly<{
  price: number;
  changePercent: number | null;
  momentumPercent: number | null;
  buyZone: Readonly<{ low: number; high: number }>;
  support: number;
  stop: number | null;
  target: number;
  rewardRisk: number | null;
  action: ResearchScreenAction;
  score: number;
  reasons: readonly string[];
  warnings: readonly string[];
  blockingWarnings: readonly BlockingWarning[];
  quoteAt: Date | null;
  historyAt: Date | null;
}>;

export type ScreenResult =
  | Readonly<{ ok: true; observation: ScreenObservation }>
  | Readonly<{
      ok: false;
      errorCode: ResearchScreenErrorCode;
      errorMessage: string;
    }>;

/** The fixed text of each blocking warning code, and of the read-time code `entry-expired`. */
export const RESEARCH_SCREEN_WARNING_TEXTS = Object.freeze({
  "alias-unconfirmed":
    "At least one symbol alias of this report has no confirmation.",
  "catalog-not-ready": "The catalog status of this report is not ready.",
  "entry-expired":
    "The quote is older than 4 hours, so the entry review has expired. Wait for the next run.",
  "future-not-executable":
    "This is a provider futures series, not one contract that can be traded.",
  "history-stale":
    "The daily history is older than 4 days or does not hold the last ended session. An entry review is blocked.",
  "outside-buy-zone":
    "The price is outside the buy zone (from support to support plus half of the ATR).",
  "quote-stale":
    "The quote is older than 4 hours or has a time in the future. An entry review is blocked.",
  "reward-below-2":
    "The observed resistance gives a reward to risk below 2 to 1, or no valid ratio.",
  "trend-not-aligned":
    "The trend does not hold: it needs the close at or above the 20-day average, the 20-day average above the 50-day average, and a 20-day momentum above 0.",
} as const);

export type ResearchScreenWarningCode =
  keyof typeof RESEARCH_SCREEN_WARNING_TEXTS;

const OPTIONS_NOTE = "Options are not checked by this screen.";
const RESEARCH_ONLY_NOTE =
  "These levels are for research only. They are no order and no advice.";
const FUTURE_NOTE =
  "The prices come from a provider futures series. A roll between contracts can move the levels.";

/** The 4 limitation texts that the page shows with every screen. */
export const RESEARCH_SCREEN_LIMITATIONS: readonly string[] = Object.freeze([
  "This screen is for research only. It places no order and sends no alert.",
  "Quotes can be delayed. A quote older than 4 hours cannot be or stay an entry review.",
  "Runs happen only at the scheduled slots. The slots follow the regular NYSE calendar, so a special closure can give a run with old prices.",
  `Prices come from third-party providers, which can limit or refuse requests; a report then keeps its last row. ${OPTIONS_NOTE}`,
]);

export const CALENDAR_UNVERIFIED_LIMITATION =
  "The trading calendar is not verified for this year. Slots that depend on the market close can be at the wrong time.";

/** At most 24 messages of at most 400 characters, without duplicates. */
export const boundedMessages = (messages: readonly string[]): string[] =>
  [
    ...new Set(
      messages.map((text) =>
        text.slice(0, RESEARCH_SCREEN_LIMITS.maxMessageLength)
      )
    ),
  ].slice(0, RESEARCH_SCREEN_LIMITS.maxMessages);

const isTimeZone = (timeZone: string): boolean => {
  try {
    const format = new Intl.DateTimeFormat("en-CA", { timeZone });
    return format.resolvedOptions().timeZone.length > 0;
  } catch {
    return false;
  }
};

const metadataSchema = z.record(z.string(), z.unknown());
const assetTypeSchema = z.enum(["equity", "etf", "future", "index"]);
const currencySchema = z.string().regex(/^[A-Z]{3}$/);
const timeZoneSchema = z.string().min(1).refine(isTimeZone);
const aliasesSchema = z
  .array(
    z.object({
      confirmed: z.boolean(),
      input: z.string(),
      resolution: z.string(),
    })
  )
  .default([]);
const contractSpecsSchema = z.record(z.string(), z.unknown()).optional();

export type CatalogReportInput = Readonly<{
  id: string;
  symbol: string;
  providerSymbol: string;
  assetType: string | null;
  status: string;
  identityStatus: string;
  metadata: unknown;
}>;

export type CatalogEntryResult =
  | Readonly<{ ok: true; entry: CatalogEntry }>
  | Readonly<{
      ok: false;
      errorCode: "metadata-invalid" | "identity-unverified";
      errorMessage: string;
    }>;

const metadataInvalid = (key: string): CatalogEntryResult => ({
  errorCode: "metadata-invalid",
  errorMessage: `The catalog field ${key} is missing or not valid.`,
  ok: false,
});

/** Step 1 of the screen: the catalog columns and metadata keys that the screen needs. */
export const parseCatalogEntry = (
  report: CatalogReportInput
): CatalogEntryResult => {
  const metadata = metadataSchema.safeParse(report.metadata);
  if (!metadata.success) return metadataInvalid("metadata");
  const assetType = assetTypeSchema.safeParse(report.assetType ?? "equity");
  if (!assetType.success) return metadataInvalid("assetType");
  const currency = currencySchema.safeParse(metadata.data["currency"]);
  if (!currency.success) return metadataInvalid("currency");
  const timeZone = timeZoneSchema.safeParse(metadata.data["timeZone"]);
  if (!timeZone.success) return metadataInvalid("timeZone");
  const aliases = aliasesSchema.safeParse(metadata.data["aliases"]);
  if (!aliases.success) return metadataInvalid("aliases");
  const contractSpecs = contractSpecsSchema.safeParse(
    metadata.data["contractSpecs"]
  );
  if (!contractSpecs.success) return metadataInvalid("contractSpecs");
  if (report.identityStatus !== "verified")
    return {
      errorCode: "identity-unverified",
      errorMessage: "The catalog identity of this report is not verified.",
      ok: false,
    };
  return {
    entry: {
      aliases: aliases.data,
      assetType: assetType.data,
      currency: currency.data,
      hasContractSpecs: contractSpecs.data !== undefined,
      id: report.id,
      providerSymbol: report.providerSymbol,
      status: report.status,
      symbol: report.symbol,
      timeZone: timeZone.data,
    },
    ok: true,
  };
};

const EXPECTED_INSTRUMENT_TYPE: Readonly<Record<CatalogAssetType, string>> = {
  equity: "EQUITY",
  etf: "ETF",
  future: "FUTURE",
  index: "INDEX",
};

const positive = (value: number | null): value is number =>
  value !== null && Number.isFinite(value) && value > 0;

/** The calendar date (YYYY-MM-DD) of an instant in a time zone. */
const dateInZone = (instant: Date, timeZone: string): string =>
  new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone,
    year: "numeric",
  }).format(instant);

const isCalendarDate = (date: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const day = Date.parse(`${date}T00:00:00Z`);
  return (
    Number.isFinite(day) && new Date(day).toISOString().slice(0, 10) === date
  );
};

/** The date of the session that still runs at `now`, or null. */
const runningSessionDate = (
  quote: ResearchScreenQuote,
  timeZone: string,
  now: Date
): string | null =>
  quote.sessionStart !== null &&
  quote.sessionEnd !== null &&
  now.getTime() < quote.sessionEnd.getTime()
    ? dateInZone(quote.sessionStart, timeZone)
    : null;

/** Step 5: completed bars, one per date (the first wins), oldest first. */
export const completedBars = (
  bars: readonly ResearchScreenBar[],
  quote: ResearchScreenQuote,
  timeZone: string,
  now: Date
): ResearchScreenBar[] => {
  const today = dateInZone(now, timeZone);
  const running = runningSessionDate(quote, timeZone, now);
  const seen = new Set<string>();
  return bars
    .filter((bar) => {
      if (!(positive(bar.c) && isCalendarDate(bar.date))) return false;
      if (bar.date > today || bar.date === running || seen.has(bar.date))
        return false;
      seen.add(bar.date);
      return true;
    })
    .sort((a, b) => a.date.localeCompare(b.date));
};

const mean = (values: readonly number[]): number =>
  values.reduce((sum, value) => sum + value, 0) / values.length;

/** (last close / close 20 bars before it, minus 1) x 100; null with fewer than 21 closes. */
export const momentumPercentOf = (closes: readonly number[]): number | null => {
  const last = closes.at(-1);
  const base = closes.at(-21);
  if (last === undefined || base === undefined) return null;
  return (last / base - 1) * 100;
};

const validOhlc = (bar: ResearchScreenBar): boolean =>
  positive(bar.h) && positive(bar.l) && bar.h >= bar.c && bar.l <= bar.c;

const failure = (
  errorCode: ResearchScreenErrorCode,
  errorMessage: string
): ScreenFailure => ({ errorCode, errorMessage, ok: false });

const catalogWarnings = (entry: CatalogEntry): string[] => [
  RESEARCH_ONLY_NOTE,
  ...(entry.currency === "USD"
    ? []
    : [`Prices and levels are in ${entry.currency}, not in USD.`]),
  ...(entry.assetType === "future" ? [FUTURE_NOTE] : []),
  ...entry.aliases.map(
    (alias) =>
      `Alias ${alias.input}: ${alias.resolution} (${alias.confirmed ? "confirmed" : "not confirmed"}).`
  ),
  OPTIONS_NOTE,
];

type ScreenFailure = Extract<ScreenResult, { ok: false }>;

type CheckedQuote = Readonly<{
  ok: true;
  quote: ResearchScreenQuote;
  price: number;
  quoteAt: Date;
}>;

/** Steps 2 to 4: an answer, the identity match, a price and a provider time. */
const checkQuote = (
  entry: CatalogEntry,
  evidence: ResearchScreenEvidence
): CheckedQuote | ScreenFailure => {
  const { quote } = evidence;
  if (quote === null)
    return failure(
      evidence.fetchError ?? "provider-http",
      "The price read returned no answer."
    );
  if (
    quote.instrumentType !== EXPECTED_INSTRUMENT_TYPE[entry.assetType] ||
    quote.currency !== entry.currency ||
    quote.timeZone !== entry.timeZone
  )
    return failure(
      "identity-mismatch",
      "The instrument type, currency or time zone of the quote does not match the catalog."
    );
  const { price, quoteAt } = quote;
  if (!positive(price) || quoteAt === null)
    return failure(
      "quote-missing",
      "The quote has no price above 0 or no provider time."
    );
  return { ok: true, price, quote, quoteAt };
};

type CheckedBars = Readonly<{
  ok: true;
  bars: readonly ResearchScreenBar[];
  last: ResearchScreenBar;
  atr: number;
}>;

/** Steps 5 and 6: at least 50 completed bars with valid OHLC and an ATR above 0. */
const checkBars = (
  entry: CatalogEntry,
  evidence: ResearchScreenEvidence,
  quote: ResearchScreenQuote,
  now: Date
): CheckedBars | ScreenFailure => {
  const bars = completedBars(evidence.bars, quote, entry.timeZone, now);
  const last = bars.at(-1);
  if (bars.length < RESEARCH_SCREEN_LIMITS.minimumBars || last === undefined)
    return failure(
      "too-few-bars",
      `The screen needs at least ${RESEARCH_SCREEN_LIMITS.minimumBars} completed daily bars; it received ${bars.length}.`
    );
  const atr = wilderAtr(
    bars.map((bar) => ({ ...bar, v: 0 })),
    14
  );
  if (!(bars.every(validOhlc) && positive(atr)))
    return failure(
      "invalid-ohlc",
      "The completed bars have a high, low or close that is not valid, or no price range."
    );
  return { atr, bars, last, ok: true };
};

/** The levels of the last 20 completed bars for a price. */
const levelsOf = (checked: CheckedBars, price: number) => {
  const recent = checked.bars.slice(-20);
  const support = Math.min(...recent.map((bar) => bar.l));
  const target = Math.max(...recent.map((bar) => bar.h));
  const stop = support - checked.atr > 0 ? support - checked.atr : null;
  const rewardRisk =
    stop !== null && stop < price && target > price
      ? (target - price) / (price - stop)
      : null;
  return {
    buyZone: {
      high: Math.min(target, support + checked.atr / 2),
      low: support,
    },
    rewardRisk,
    stop,
    support,
    target,
  };
};

/** `quoteFresh`, `historyCurrent` and the provider time of the last bar. */
const freshnessOf = (
  checkedQuote: CheckedQuote,
  last: ResearchScreenBar,
  timeZone: string,
  now: Date
) => {
  const { quote, quoteAt } = checkedQuote;
  const quoteAge = now.getTime() - quoteAt.getTime();
  // `historyAt` is the end of the day of the last completed bar: the UTC
  // instant of that date at 00:00 plus 1 day. It can be a few hours after
  // `now` for a session that ended today west of UTC, so the age test has
  // only the upper limit of 4 days and no lower limit; step 5 already
  // refuses a bar dated after `now`.
  const historyAt = new Date(Date.parse(`${last.date}T00:00:00Z`) + DAY_MS);
  const endedSessionDate =
    quote.sessionStart !== null &&
    quote.sessionEnd !== null &&
    now.getTime() >= quote.sessionEnd.getTime()
      ? dateInZone(quote.sessionStart, timeZone)
      : null;
  return {
    historyAt,
    historyCurrent:
      now.getTime() - historyAt.getTime() <=
        RESEARCH_SCREEN_LIMITS.historyAgeLimitMs &&
      (endedSessionDate === null || last.date >= endedSessionDate),
    quoteFresh:
      quoteAge >= 0 && quoteAge <= RESEARCH_SCREEN_LIMITS.quoteAgeLimitMs,
  };
};

type ScreenFlags = Readonly<{
  trend: boolean;
  inZone: boolean;
  rewardAdequate: boolean;
  quoteFresh: boolean;
  historyCurrent: boolean;
}>;

const blockingCodesOf = (
  entry: CatalogEntry,
  flags: ScreenFlags
): ResearchScreenWarningCode[] => {
  const checks: readonly (readonly [ResearchScreenWarningCode, boolean])[] = [
    ["quote-stale", !flags.quoteFresh],
    ["history-stale", !flags.historyCurrent],
    ["trend-not-aligned", !flags.trend],
    ["outside-buy-zone", !flags.inZone],
    ["reward-below-2", !flags.rewardAdequate],
    ["catalog-not-ready", entry.status !== "ready"],
    ["future-not-executable", entry.assetType === "future"],
    ["alias-unconfirmed", entry.aliases.some((alias) => !alias.confirmed)],
  ];
  return checks.filter(([, blocks]) => blocks).map(([code]) => code);
};

const reasonsOf = (flags: ScreenFlags): string[] => [
  flags.trend
    ? "The trend holds: the close is at or above the 20-day average, the 20-day average is above the 50-day average, and the 20-day momentum is above 0."
    : RESEARCH_SCREEN_WARNING_TEXTS["trend-not-aligned"],
  flags.inZone
    ? "The price is inside the buy zone (from support to support plus half of the ATR)."
    : RESEARCH_SCREEN_WARNING_TEXTS["outside-buy-zone"],
  flags.rewardAdequate
    ? "The observed resistance gives a reward to risk of at least 2 to 1 against the stop (support minus the ATR)."
    : RESEARCH_SCREEN_WARNING_TEXTS["reward-below-2"],
  "Support and resistance use the provider's own OHLC of the last 20 completed sessions, with no adjustment for a split or a roll.",
];

const scoreOf = (flags: ScreenFlags): number =>
  (flags.trend ? 30 : 0) +
  (flags.inZone ? 25 : 0) +
  (flags.rewardAdequate ? 25 : 0) +
  (flags.quoteFresh && flags.historyCurrent ? 20 : 0);

/**
 * Steps 2 to 6 of the screen rules, then the values, the blocking warnings,
 * the score and the action. Step 1 is `parseCatalogEntry`.
 */
export const screenReport = (
  entry: CatalogEntry,
  evidence: ResearchScreenEvidence,
  now: Date
): ScreenResult => {
  const checkedQuote = checkQuote(entry, evidence);
  if (!checkedQuote.ok) return checkedQuote;
  const checkedBars = checkBars(entry, evidence, checkedQuote.quote, now);
  if (!checkedBars.ok) return checkedBars;
  const { price, quoteAt } = checkedQuote;
  const { bars, last } = checkedBars;

  const closes = bars.map((bar) => bar.c);
  const quoteDate = dateInZone(quoteAt, entry.timeZone);
  const previous = bars.findLast((bar) => bar.date < quoteDate);
  const momentumPercent = momentumPercentOf(closes);
  const sma20 = mean(closes.slice(-20));
  const levels = levelsOf(checkedBars, price);
  const { historyAt, ...freshness } = freshnessOf(
    checkedQuote,
    last,
    entry.timeZone,
    now
  );
  const flags: ScreenFlags = {
    ...freshness,
    inZone: price >= levels.buyZone.low && price <= levels.buyZone.high,
    rewardAdequate: levels.rewardRisk !== null && levels.rewardRisk >= 2,
    trend:
      last.c >= sma20 &&
      sma20 > mean(closes.slice(-50)) &&
      momentumPercent !== null &&
      momentumPercent > 0,
  };
  const codes = blockingCodesOf(entry, flags);
  const blockedAction = flags.trend ? "watch" : "wait";

  return {
    observation: {
      changePercent:
        previous === undefined ? null : (price / previous.c - 1) * 100,
      momentumPercent,
      price,
      ...levels,
      action: codes.length === 0 ? "review-entry" : blockedAction,
      blockingWarnings: codes.map((code) => ({
        code,
        text: RESEARCH_SCREEN_WARNING_TEXTS[code],
      })),
      historyAt,
      quoteAt,
      reasons: reasonsOf(flags),
      score: scoreOf(flags),
      warnings: boundedMessages(catalogWarnings(entry)),
    },
    ok: true,
  };
};

/**
 * Read-time rule: a stored `review-entry` whose quote is older than 4 hours,
 * has a time after `now`, or has no time, is shown as `watch` with 20 points less.
 */
export const effectiveRow = <
  T extends {
    action: ResearchScreenAction;
    score: number;
    quoteAt: Date | null;
    warnings: readonly string[];
  },
>(
  stored: T,
  now: Date
): T & { storedAction: ResearchScreenAction; storedScore: number } => {
  const kept = {
    ...stored,
    storedAction: stored.action,
    storedScore: stored.score,
  };
  if (stored.action !== "review-entry") return kept;
  const age =
    stored.quoteAt === null ? null : now.getTime() - stored.quoteAt.getTime();
  if (age !== null && age >= 0 && age <= RESEARCH_SCREEN_LIMITS.quoteAgeLimitMs)
    return kept;
  return {
    ...kept,
    action: "watch",
    score: Math.max(0, stored.score - 20),
    warnings: boundedMessages([
      ...stored.warnings,
      RESEARCH_SCREEN_WARNING_TEXTS["entry-expired"],
    ]),
  };
};

/** The end status of a run from its counts (see "Run statuses"). */
export const runStatusOf = (counts: {
  total: number;
  succeeded: number;
  failed: number;
  notReached: number;
}): "completed" | "partial" | "failed" => {
  if (counts.total > 0 && counts.succeeded === counts.total) return "completed";
  return counts.succeeded === 0 ? "failed" : "partial";
};

/** The scheduler state from the age of the last tick. */
export const schedulerStateOf = (
  lastTickAt: Date | null,
  now: Date
): "ok" | "late" | "silent" | "never" => {
  if (lastTickAt === null) return "never";
  const age = now.getTime() - lastTickAt.getTime();
  if (age <= RESEARCH_SCREEN_LIMITS.schedulerOkMs) return "ok";
  return age <= RESEARCH_SCREEN_LIMITS.schedulerLateMs ? "late" : "silent";
};
