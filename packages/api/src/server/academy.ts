// Vertex Academy server: modeled lesson backtests and gated PAPER deployment requests.
// No network client, no order transport. Gates use the live portfolio feed for NLV and open premium;
// client-supplied numbers never change a gate verdict. Rule conflicts need the owner's password
// (Better Auth step-up) and an explanation naming each rule, recorded in audit_records.
import {
  academyStrategySlug,
  type BacktestResult,
  checkOverride,
  courseOf,
  evaluateDeployGates,
  type GateResult,
  isAcademyStrategySlug,
  type Lesson,
  lessonSpecPath,
  payoffSummary,
  realizedVol,
  resolveRules,
  runOptionsBacktest,
  STRUCTURE_DEFS,
  type StructureId,
  structureLegs,
} from "@darkfactory/academy";
import { lessonBySlug } from "@darkfactory/academy/lessons";
import {
  DatabasePersistenceError,
  DEPLOYMENT_REQUESTS_MAX_LISTED,
  type DeploymentRequestRow,
  DeploymentRequestStateError,
  InvalidRepositoryInputError,
  type MarketBarColumns,
  type MarketBarSeries,
  type MarketBarsRepository,
} from "@darkfactory/db/server";
import { implement } from "@orpc/server";

import { academyEngineResult } from "../academy-engine-result.ts";
import { returnStats } from "../backtest-analytics.ts";
import { appContract } from "../contract.ts";
import {
  ACADEMY_EQUITY_MAX_POINTS,
  ACADEMY_TRADES_MAX,
  type AcademyBacktestOutput,
  type AcademyDeployRequestOutput,
  type AcademyDeployRequestParsedInput,
  type AcademyGateOutput,
} from "../contracts/academy.ts";
import type { EngineComparisonTiming } from "../contracts/engine-comparison.ts";
import {
  barDate,
  comparisonGroupId,
  measureWall,
  typescriptSide,
  type WallTime,
} from "../engine-comparison.ts";
import { downsampleIndexes } from "../instant-backtest-engine.ts";
import { OWNER_RISK_CAPS } from "../risk-allocator.ts";
import { academyContentRouter } from "./academy-content.ts";
import type { ApiContext } from "./context.ts";
import { comparisonQueueFor } from "./engine-comparison.ts";
import { COMPARISON_QUEUE_ERROR } from "./instant-backtest.ts";
import { requireOperator } from "./operator-access.ts";
import {
  PASSWORD_FAILURE_LIMIT,
  PASSWORD_FAILURE_WINDOW_MS,
  passwordStepUp,
} from "./password-step-up.ts";
import {
  type FetchPortfolioMonitorOptions,
  fetchPortfolioMonitor,
} from "./portfolio-monitor.ts";

const api = implement(appContract).$context<ApiContext>();

const NLV_MAX_AGE_MS = 15 * 60_000;
const NLV_MAX_FUTURE_SKEW_MS = 60_000;
const WARMUP_BARS = 30;
const OPEN_STATUSES = ["draft", "requested", "approved"] as const;

type Code =
  | "BAD_REQUEST"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "STORAGE_ERROR";
type Factories = Readonly<
  Record<Code, (options?: { message?: string }) => Error>
>;
const factories = (errors: unknown): Factories => errors as Factories;

const refuseApiKeys = api.middleware(async ({ context, next, errors }) => {
  if (context.agentApiKeyPresented === true)
    throw factories(errors).FORBIDDEN({
      message:
        "Academy deployment requests need a signed-in operator session; API keys are refused",
    });
  return await next();
});

const lessonOr404 = (slug: string, errors: unknown): Lesson => {
  const lesson = lessonBySlug(slug);
  if (lesson === null)
    throw factories(errors).NOT_FOUND({ message: `No lesson ${slug}` });
  return lesson;
};

const presetOf = (lesson: Lesson, errors: unknown) => {
  if (lesson.backtest === undefined)
    throw factories(errors).BAD_REQUEST({
      message:
        "This is a concept lesson: it has no tradeable structure to backtest or deploy",
    });
  return lesson.backtest;
};

const rulesFor = (
  structure: StructureId,
  preset: Readonly<Record<string, number>>,
  input: Readonly<Record<string, number>>,
  errors: unknown
): Record<string, number> => {
  try {
    return resolveRules(structure, preset, input);
  } catch (error) {
    throw factories(errors).BAD_REQUEST({
      message: error instanceof Error ? error.message : "Invalid rules",
    });
  }
};

const barsRepository = (
  context: ApiContext,
  errors: unknown
): MarketBarsRepository => {
  const repository = context.repositories.marketBars;
  if (repository === undefined)
    throw factories(errors).STORAGE_ERROR({
      message: "Bar storage unavailable",
    });
  return repository;
};

const iso = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

const loadDaily = async (
  repository: MarketBarsRepository,
  ticker: string
): Promise<{
  columns: MarketBarColumns;
  series: MarketBarSeries;
  source: string;
} | null> => {
  const series = await repository.getSeries(ticker, "1d");
  if (series === null) return null;
  return {
    columns: await repository.loadColumns(series.id),
    series,
    source: series.source,
  };
};

/** What one Academy backtest ran on: the bars it read (warm-up included) and its inputs. */
export type AcademyRun = Readonly<{
  capital: number;
  closes: readonly number[];
  iv: readonly number[] | undefined;
  rules: Readonly<Record<string, number>>;
  series: MarketBarSeries;
  /** The VIX series when it supplied `iv`. */
  ivSeries: MarketBarSeries | undefined;
  structure: StructureId;
  times: readonly number[];
}>;

/**
 * Queues the Academy backtest on Nautilus when engine comparison is on (dual run, switch plan step
 * 6): the same structure, rules, capital and implied volatility on the same daily closes, as a
 * backtest run with an `academy` rule for the research worker. The TypeScript result is mapped to
 * the engine result shape (academy-engine-result.ts) for the stored comparison. Returns the timing
 * for the answer, or undefined when off or when the result cannot be mapped. A queue failure never
 * changes the backtest.
 */
export const queueAcademyComparison = async (
  context: ApiContext & Readonly<{ principal: { userId: string } }>,
  run: AcademyRun,
  result: BacktestResult,
  wall: WallTime
): Promise<EngineComparisonTiming | undefined> => {
  const queue = comparisonQueueFor(context, context.principal.userId);
  if (queue === null) return undefined;
  const closes = Float64Array.from(run.closes);
  const mapped = academyEngineResult(
    result,
    {
      c: closes,
      h: closes,
      l: closes,
      o: closes,
      t: Float64Array.from(run.times),
    },
    run.capital
  );
  if (mapped === null) return undefined;
  const timing = { host: queue.host, ...wall };
  const spec = {
    costBps: 0,
    from: barDate(run.times[0] as number),
    initialCapital: run.capital,
    rule: {
      // JSON has no NaN: a missing implied volatility is null (the engine then models it).
      ...(run.iv === undefined
        ? {}
        : {
            iv: run.iv.map((value) => (Number.isFinite(value) ? value : null)),
          }),
      kind: "academy" as const,
      rules: { ...run.rules },
      structure: run.structure,
    },
    stopLossPct: 0,
    symbol: run.series.symbol,
    takeProfitPct: 0,
    timeframe: run.series.timeframe,
    to: barDate(run.times.at(-1) as number),
  };
  try {
    // As the instant backtest: an identical request reuses its group; a new one replaces the older
    // queued Academy runs of this user.
    const enqueued = await queue.enqueue({
      feature: "academy",
      groupId: await comparisonGroupId("academy", {
        ivSha256: run.ivSeries?.sourceSha256 ?? null,
        seriesSha256: run.series.sourceSha256,
        spec,
      }),
      latest: true,
      runs: [
        {
          label: `${run.series.symbol} 1d academy ${run.structure}`,
          spec,
          typescript: typescriptSide(mapped, wall, queue.host),
        },
      ],
    });
    return { ...timing, ...enqueued };
  } catch {
    return { ...timing, error: COMPARISON_QUEUE_ERROR, groupId: null };
  }
};

const tickers = api.academy.tickers
  .use(requireOperator)
  .handler(async ({ context, errors }) => {
    const series = await barsRepository(context, errors).listSeries();
    return {
      tickers: series
        .filter(
          (entry) =>
            entry.timeframe === "1d" &&
            /^[A-Z][A-Z0-9.^-]{0,9}$/u.test(entry.symbol)
        )
        .slice(0, 200)
        .map((entry) => ({
          bars: entry.barCount,
          first: iso(entry.firstT),
          last: iso(entry.lastT),
          ticker: entry.symbol,
        })),
    };
  });

const pick = <T>(values: readonly T[]): T[] =>
  downsampleIndexes(values.length, ACADEMY_EQUITY_MAX_POINTS).map(
    (index) => values[index] as T
  );

const backtest = api.academy.backtest
  .use(requireOperator)
  .handler(
    async ({ context, input, errors }): Promise<AcademyBacktestOutput> => {
      const lesson = lessonOr404(input.slug, errors);
      const preset = presetOf(lesson, errors);
      const rules = rulesFor(
        preset.structure,
        preset.rules,
        input.rules,
        errors
      );
      if (input.start >= input.end)
        throw factories(errors).BAD_REQUEST({
          message: "start must be before end",
        });
      const repository = barsRepository(context, errors);
      const daily = await loadDaily(repository, input.ticker);
      if (daily === null)
        throw factories(errors).NOT_FOUND({
          message: `No stored daily bars for ${input.ticker}. Import them with bun run vertex:bars:import.`,
        });
      const startMs = Date.parse(`${input.start}T00:00:00Z`);
      const endMs = Date.parse(`${input.end}T23:59:59Z`);
      const { t, c } = daily.columns;
      let first = t.findIndex((value) => value >= startMs);
      if (first < 0)
        throw factories(errors).NOT_FOUND({
          message: `No ${input.ticker} bars after ${input.start}`,
        });
      first = Math.max(first - WARMUP_BARS, 0);
      let last = t.length - 1;
      while (last > first && (t[last] as number) > endMs) last -= 1;
      const times = Array.from(t.subarray(first, last + 1));
      const closes = Array.from(c.subarray(first, last + 1));
      // SPY uses the VIX index as its implied volatility when stored; other tickers use the RV model.
      let iv: number[] | undefined;
      let ivSeries: MarketBarSeries | undefined;
      if (input.ticker === "SPY") {
        const vix = await loadDaily(repository, "^VIX");
        if (vix !== null) {
          const byDay = new Map<string, number>();
          for (const [index, value] of vix.columns.t.entries())
            byDay.set(iso(value), (vix.columns.c[index] as number) / 100);
          const aligned = times.map(
            (value) => byDay.get(iso(value)) ?? Number.NaN
          );
          if (
            aligned.filter((value) => Number.isFinite(value)).length >
            aligned.length * 0.9
          ) {
            iv = aligned;
            ivSeries = vix.series;
          }
        }
      }
      let result: BacktestResult;
      let wall: WallTime;
      try {
        const { value, ...measured } = measureWall(
          () => performance.now(),
          () =>
            runOptionsBacktest({
              bars: {
                c: closes,
                t: times,
                ...(iv === undefined ? {} : { iv }),
              },
              capital: input.capital,
              rules,
              structure: preset.structure,
            })
        );
        result = value;
        wall = measured;
      } catch (error) {
        throw factories(errors).BAD_REQUEST({
          message: error instanceof Error ? error.message : "Backtest failed",
        });
      }
      const comparison = await queueAcademyComparison(
        context,
        {
          capital: input.capital,
          closes,
          iv,
          ivSeries,
          rules,
          series: daily.series,
          structure: preset.structure,
          times,
        },
        result,
        wall
      );
      const stats = returnStats(result.equity);
      let peak = 0;
      let benchmarkDrawdown = 0;
      for (const point of result.benchmark) {
        peak = Math.max(peak, point.equity);
        if (peak > 0)
          benchmarkDrawdown = Math.min(
            benchmarkDrawdown,
            point.equity / peak - 1
          );
      }
      return {
        assumptions: [...result.assumptions],
        benchmark: pick(result.benchmark),
        ...(comparison === undefined ? {} : { comparison }),
        data: {
          bars: times.length,
          // first <= last, so the window holds at least one bar.
          first: iso(times[0] as number),
          last: iso(times.at(-1) as number),
          source: daily.source.slice(0, 300),
        },
        drawdown: pick(result.drawdown),
        end: result.equity.at(-1)?.t ?? input.end,
        equity: pick(result.equity),
        ivSource: result.ivSource,
        modeled: true,
        rules: result.rules,
        slug: lesson.slug,
        start: result.equity[0]?.t ?? input.start,
        stats: {
          ...result.stats,
          benchmarkMaxDrawdown: benchmarkDrawdown,
          sortino: stats?.sortino ?? null,
          volatility: stats?.annualVolatility ?? null,
        },
        structure: preset.structure,
        ticker: input.ticker,
        trades: result.trades.slice(-ACADEMY_TRADES_MAX).map((trade) => ({
          ...trade,
          legs: trade.legs.slice(0, 8).map((leg) => leg.slice(0, 80)),
        })),
        tradesTotal: result.trades.length,
      };
    }
  );

type Evaluation = Readonly<{
  lesson: Lesson;
  structure: StructureId;
  rules: Record<string, number>;
  gate: GateResult;
  pricing: UnitPricing | null;
  /** An open Academy request for the same lesson and ticker already exists. */
  duplicateOpen: boolean;
  output: AcademyGateOutput;
}>;

let portfolioFetchOptions: FetchPortfolioMonitorOptions = {};
/** Test seam: the fetch used to read the portfolio feed. */
export const setAcademyPortfolioFetchForTesting = (
  options: FetchPortfolioMonitorOptions
): void => {
  portfolioFetchOptions = options;
};

/** NLV and open premium in the ticker from the live portfolio feed; null NLV when unavailable or stale. */
const liveAccount = async (
  context: ApiContext,
  ticker: string
): Promise<{ nlv: number | null; openPremium: number; detail: string }> => {
  try {
    const snapshot = await fetchPortfolioMonitor(
      context.portfolioMonitor ?? null,
      portfolioFetchOptions
    );
    const asOf =
      snapshot.status.dataAsOf === null
        ? Number.NaN
        : Date.parse(snapshot.status.dataAsOf);
    // A future timestamp (clock skew or a bad feed) must not keep an old NLV fresh forever.
    const age = Date.now() - asOf;
    const fresh =
      Number.isFinite(asOf) &&
      age >= -NLV_MAX_FUTURE_SKEW_MS &&
      age <= NLV_MAX_AGE_MS;
    const nlv = snapshot.summary.netLiquidation;
    if (!(snapshot.status.connected && fresh) || nlv === null || !(nlv > 0))
      return {
        detail: `Portfolio feed not usable (connected ${snapshot.status.connected}, data as of ${snapshot.status.dataAsOf ?? "unknown"}).`,
        nlv: null,
        openPremium: 0,
      };
    const openPremium = snapshot.positions
      .filter(
        (position) =>
          position.symbol === ticker &&
          position.secType === "OPT" &&
          position.position > 0
      )
      .reduce((sum, position) => sum + Math.abs(position.marketValue ?? 0), 0);
    return {
      detail: `Live IBKR portfolio feed, data as of ${snapshot.status.dataAsOf}.`,
      nlv,
      openPremium,
    };
  } catch (error) {
    return {
      detail: `Portfolio feed unavailable: ${error instanceof Error ? error.message.slice(0, 200) : "error"}.`,
      nlv: null,
      openPremium: 0,
    };
  }
};

type OpenAllocations = Readonly<{ totalPct: number; duplicateOpen: boolean }>;

/**
 * Allocations of every open Academy request (all lessons and tickers), read per open status at the
 * repository maximum. A full page could hide older rows, so the total then fails closed.
 */
const openAllocations = async (
  context: ApiContext,
  strategySlug: string,
  ticker: string,
  errors: unknown
): Promise<OpenAllocations> => {
  const repository = context.repositories.deploymentRequests;
  if (repository === undefined) return { duplicateOpen: false, totalPct: 0 };
  let totalPct = 0;
  let duplicateOpen = false;
  for (const status of OPEN_STATUSES) {
    const rows = await repository.list({
      limit: DEPLOYMENT_REQUESTS_MAX_LISTED,
      status,
    });
    if (rows.length >= DEPLOYMENT_REQUESTS_MAX_LISTED)
      throw factories(errors).CONFLICT({
        message: `${DEPLOYMENT_REQUESTS_MAX_LISTED}+ ${status} deployment requests: the Academy allocation total cannot be verified; close old requests first`,
      });
    for (const row of rows) {
      // The Academy allocation cap counts the requests of every course.
      if (!isAcademyStrategySlug(row.strategySlug)) continue;
      if (row.strategySlug === strategySlug && row.symbol === ticker)
        duplicateOpen = true;
      const value = Number(row.params?.["allocationPct"]);
      totalPct += Number.isFinite(value) ? value : 0;
    }
  }
  return { duplicateOpen, totalPct };
};

type DeployInput = Readonly<{
  slug: string;
  ticker: string;
  allocationPct: number;
  riskPerTradePct: number;
  tranches: number;
  rules: Readonly<Record<string, number>>;
  statedNlv?: number | undefined;
}>;

const evaluate = async (
  context: ApiContext,
  input: DeployInput,
  errors: unknown
): Promise<Evaluation> => {
  const lesson = lessonOr404(input.slug, errors);
  const preset = presetOf(lesson, errors);
  const rules = rulesFor(preset.structure, preset.rules, input.rules, errors);
  const account = await liveAccount(context, input.ticker);
  const pricing = await priceUnit(
    context,
    input.ticker,
    preset.structure,
    rules
  );
  const open = await openAllocations(
    context,
    academyStrategySlug(lesson),
    input.ticker,
    errors
  );
  const others = open.totalPct;
  const gate = evaluateDeployGates({
    allocationPct: input.allocationPct,
    caps: {
      leapsMinDte: OWNER_RISK_CAPS.leapsMinDte,
      leapsPremiumPct: OWNER_RISK_CAPS.leapsPremiumPct,
      optionsOnly: OWNER_RISK_CAPS.optionsOnly,
      optionsOnlyScope: OWNER_RISK_CAPS.optionsOnlyScope,
      shortPremiumPct: OWNER_RISK_CAPS.shortPremiumPct,
    },
    nlv: account.nlv ?? 0,
    openPremiumInNameUsd: account.openPremium,
    otherAllocationsPct: others,
    riskPerTradePct: input.riskPerTradePct,
    rules,
    structure: preset.structure,
    tranches: input.tranches,
    unitLossUsd: pricing?.unitLoss ?? null,
  });
  return {
    duplicateOpen: open.duplicateOpen,
    gate,
    lesson,
    output: {
      checks: gate.checks.map((check) => ({ ...check })),
      conflicts: [...gate.conflicts],
      nlv: account.nlv,
      nlvDetail: account.detail.slice(0, 300),
      nlvSource: account.nlv === null ? "unavailable" : "portfolio-monitor",
      openPremiumInNameUsd: account.openPremium,
      otherAllocationsPct: others,
      premiumPerPositionPctNlv: Number.isFinite(gate.premiumPerPositionPctNlv)
        ? gate.premiumPerPositionPctNlv
        : -1,
      premiumPerPositionUsd: gate.premiumPerPositionUsd,
      rewardRisk: gate.rewardRisk,
      statedNlv: input.statedNlv ?? null,
      structure: preset.structure,
      unitLossUsd: pricing?.unitLoss ?? null,
      verdict: gate.verdict,
    },
    pricing,
    rules,
    structure: preset.structure,
  };
};

const deployPreview = api.academy.deployPreview
  .use(refuseApiKeys)
  .use(requireOperator)
  .handler(
    async ({ context, input, errors }) =>
      (await evaluate(context, input, errors)).output
  );

const strategyParams = (
  structure: StructureId,
  rules: Readonly<Record<string, number>>
) => [
  {
    default: 5,
    max: 100,
    min: 0.1,
    name: "allocationPct",
    title: "Allocation (% of NLV)",
    type: "decimal" as const,
  },
  {
    default: 10,
    max: 100,
    min: 0.1,
    name: "riskPerTradePct",
    title: "Max loss per position (% of allocation)",
    type: "decimal" as const,
  },
  {
    default: 2,
    max: 10,
    min: 1,
    name: "tranches",
    title: "Entry tranches",
    type: "integer" as const,
  },
  ...Object.keys(STRUCTURE_DEFS[structure].defaults).map((key) => ({
    // rules come from resolveRules(structure, ...), which always includes every default key.
    default: rules[key] as number,
    max: 100_000,
    min: -100_000,
    name: key,
    title: key,
    type: "decimal" as const,
  })),
];

const ensureStrategy = async (
  context: ApiContext,
  lesson: Lesson,
  structure: StructureId,
  rules: Record<string, number>,
  errors: unknown
) => {
  const library = context.repositories.strategyLibrary;
  if (library === undefined)
    throw factories(errors).STORAGE_ERROR({
      message: "Strategy library unavailable",
    });
  const course = courseOf(lesson);
  const slug = academyStrategySlug(lesson);
  const existing = (await library.list({ limit: 20, search: slug })).find(
    (row) => row.slug === slug
  );
  if (existing !== undefined) return existing;
  return await library.create({
    description: lesson.summary.slice(0, 2000),
    kind: "external",
    name: `${course.shortTitle}: ${lesson.title}`.slice(0, 200),
    params: strategyParams(structure, rules),
    section: course.librarySection,
    slug,
    // The library requires a repository-relative source; the Instagram URL stays on the lesson page.
    sourceRef: lessonSpecPath(lesson),
    status: "idea",
    tags: [
      course.strategyTag,
      structure.replace(/_/gu, "-"),
      ...lesson.tags.instruments,
    ].slice(0, 12),
  });
};

type UnitPricing = Readonly<{ spot: number; unitLoss: number; asOf: string }>;

/** Max loss of one unit of the structure priced at the ticker's last stored close; null without bars. */
const priceUnit = async (
  context: ApiContext,
  ticker: string,
  structure: StructureId,
  rules: Record<string, number>
): Promise<UnitPricing | null> => {
  const repository = context.repositories.marketBars;
  if (repository === undefined) return null;
  const daily = await loadDaily(repository, ticker);
  if (daily === null || daily.columns.c.length < 25) return null;
  const closes = daily.columns.c;
  const end = closes.length - 1;
  const spot = closes[end] as number;
  const vol = Math.min(
    Math.max(
      (realizedVol(closes, end, 20) ?? 0.25) * (rules["ivMult"] ?? 1.1),
      0.08
    ),
    2
  );
  const legs = structureLegs(structure, rules, spot, vol, 0.04);
  const summary = payoffSummary(legs, spot, 0.04);
  const unitLoss = STRUCTURE_DEFS[structure].usesShares
    ? spot * 100
    : summary.maxLoss === null
      ? spot * 100 * 0.2
      : Math.max(-summary.maxLoss, 1);
  return { asOf: iso(daily.columns.t[end] as number), spot, unitLoss };
};

/**
 * Paper limits from the per-position budget and one priced unit. No unit is allowed when one unit's max
 * loss exceeds the budget, unless the operator overrode the unit-fits-budget gate (then exactly one).
 */
const paperLimits = (
  pricing: UnitPricing | null,
  ticker: string,
  budgetUsd: number,
  tranches: number,
  unitOverridden: boolean,
  errors: unknown
) => {
  if (pricing === null)
    throw factories(errors).NOT_FOUND({
      message: `No stored daily bars for ${ticker}; the paper limits need a last close`,
    });
  const units = Math.floor(budgetUsd / pricing.unitLoss);
  if (units < 1 && !unitOverridden)
    throw factories(errors).CONFLICT({
      message: `Blocked by unit-fits-budget: one unit risks $${Math.round(pricing.unitLoss)}, more than the $${Math.round(budgetUsd)} budget per position.`,
    });
  const maxPosition = Math.max(units, 1);
  return {
    asOf: pricing.asOf,
    limits: {
      dailyLossLimit: Math.max(Math.round(budgetUsd), 1),
      maxOrderSize: Math.max(Math.floor(maxPosition / tranches), 1),
      maxOrdersPerMinute: 4,
      maxPosition,
    },
  };
};

/** Maps repository failures to typed errors so a bad record never surfaces as a 500. */
const repositoryErrors = (error: unknown, errors: unknown): never => {
  const fail = factories(errors);
  if (error instanceof InvalidRepositoryInputError)
    throw fail.BAD_REQUEST({
      message: error.message.replace(/^Invalid repository input: /u, ""),
    });
  if (error instanceof DeploymentRequestStateError)
    throw fail.CONFLICT({ message: error.message });
  if (error instanceof DatabasePersistenceError)
    throw fail.STORAGE_ERROR({
      message: "Strategy, deployment request or audit storage unavailable",
    });
  throw error;
};

/**
 * Academy password step-up (shared helper, see password-step-up.ts). Rows go to the Academy audit with the
 * lesson, ticker and broken rules; outcomes map to FORBIDDEN (failed or locked) and STORAGE_ERROR (outage).
 */
const academyStepUp = async (
  context: ApiContext,
  audit: NonNullable<ApiContext["repositories"]["academyAudit"]>,
  verifyPassword: (password: string) => Promise<boolean>,
  userId: string,
  input: AcademyDeployRequestParsedInput,
  password: string,
  conflicts: readonly string[],
  errors: unknown
): Promise<void> => {
  const fail = factories(errors);
  const metadata = {
    brokenRules: [...conflicts],
    lesson: input.slug,
    ticker: input.ticker,
  };
  const outcome = await passwordStepUp(
    {
      countSince: async (stage, since) =>
        await audit.countSince({
          action: `academy.deploy.password-${stage}`,
          actorUserId: userId,
          since,
        }),
      record: async (stage) =>
        await audit.record({
          action: `academy.deploy.password-${stage}`,
          actorUserId: userId,
          deploymentRequestId: "none",
          metadata,
          requestId: context.requestId,
        }),
    },
    verifyPassword,
    password
  );
  if (outcome.kind === "verified") return;
  if (outcome.kind === "locked")
    throw fail.FORBIDDEN({
      message: `Too many failed password attempts; try again in ${PASSWORD_FAILURE_WINDOW_MS / 60_000} minutes`,
    });
  if (outcome.kind === "error")
    throw fail.STORAGE_ERROR({
      message: "The password could not be checked; try again later",
    });
  throw fail.FORBIDDEN({
    message: `Password check failed; nothing was created (${outcome.attempt} of ${PASSWORD_FAILURE_LIMIT} attempts)`,
  });
};

const createDeployRequest = async (
  context: ApiContext,
  principal: Readonly<{ userId: string }>,
  input: AcademyDeployRequestParsedInput,
  errors: unknown
): Promise<AcademyDeployRequestOutput> => {
  {
    const fail = factories(errors);
    const requests = context.repositories.deploymentRequests;
    const audit = context.repositories.academyAudit;
    if (requests === undefined || audit === undefined)
      throw fail.STORAGE_ERROR({
        message: "Deployment request or audit storage unavailable",
      });
    const evaluation = await evaluate(context, input, errors);
    if (evaluation.duplicateOpen)
      throw fail.CONFLICT({
        message: `A request for ${input.slug} on ${input.ticker} is already open; withdraw it in Deployments before sending another`,
      });
    // With a live NLV the gate budget sizes the limits; without one (override only) the stated NLV does.
    const sizingNlv = evaluation.output.nlv ?? input.statedNlv ?? null;
    if (sizingNlv === null)
      throw fail.BAD_REQUEST({
        message:
          "The live NLV is unavailable; state your NLV so the paper limits can be sized (recorded in the audit)",
      });
    const conflicts = evaluation.gate.conflicts;
    const overriding = conflicts.length > 0;
    if (overriding) {
      if (input.override === undefined)
        throw fail.CONFLICT({
          message: `Blocked by ${conflicts.join(", ")}. To override, enter your password and an explanation that names each rule.`,
        });
      const problems = checkOverride(
        conflicts,
        input.override.acknowledged,
        input.override.explanation
      );
      if (problems.length > 0)
        throw fail.BAD_REQUEST({ message: problems.join("; ") });
      if (context.verifyPassword === undefined)
        throw fail.FORBIDDEN({
          message:
            "Password step-up is not available on this server; overrides are refused",
        });
      await academyStepUp(
        context,
        audit,
        context.verifyPassword,
        principal.userId,
        input,
        input.override.password,
        conflicts,
        errors
      );
    }
    const budgetUsd =
      (sizingNlv * (input.allocationPct / 100) * input.riskPerTradePct) / 100;
    const sizing = paperLimits(
      evaluation.pricing,
      input.ticker,
      budgetUsd,
      input.tranches,
      conflicts.includes("unit-fits-budget"),
      errors
    );
    const strategy = await ensureStrategy(
      context,
      evaluation.lesson,
      evaluation.structure,
      evaluation.rules,
      errors
    );
    const params = {
      allocationPct: input.allocationPct,
      riskPerTradePct: input.riskPerTradePct,
      tranches: input.tranches,
      ...evaluation.rules,
    };
    const draft = await requests.create({
      limits: sizing.limits,
      params,
      requestedBy: principal.userId,
      strategyId: strategy.id,
      symbol: input.ticker,
      timeframe: "1d",
    });
    if (draft === null)
      throw fail.NOT_FOUND({ message: "Strategy record missing" });
    const metadata = {
      allocationPct: input.allocationPct,
      checks: evaluation.gate.checks.map((check) => ({
        detail: check.detail,
        id: check.id,
        status: check.status,
      })),
      lesson: evaluation.lesson.slug,
      limits: sizing.limits,
      mode: "paper",
      nlv: evaluation.output.nlv,
      nlvSource: evaluation.output.nlvSource,
      priceAsOf: sizing.asOf,
      riskPerTradePct: input.riskPerTradePct,
      sizingNlv,
      statedNlv: input.statedNlv ?? null,
      structure: evaluation.structure,
      ticker: input.ticker,
      tranches: input.tranches,
      verdict: evaluation.gate.verdict,
    };
    let overrideAuditId: string | null = null;
    try {
      await audit.record({
        action: "academy.deploy.request",
        actorUserId: principal.userId,
        deploymentRequestId: draft.id,
        metadata,
        requestId: context.requestId,
      });
      if (overriding && input.override !== undefined) {
        const row = await audit.record({
          action: "academy.deploy.override",
          actorUserId: principal.userId,
          deploymentRequestId: draft.id,
          metadata: {
            acknowledged: [...input.override.acknowledged],
            brokenRules: [...conflicts],
            explanation: input.override.explanation.trim(),
            lesson: evaluation.lesson.slug,
            stepUp: "password-verified",
            ticker: input.ticker,
          },
          requestId: context.requestId,
        });
        overrideAuditId = row.id;
      }
    } catch {
      await requests
        .transition({
          action: "withdraw",
          actorId: principal.userId,
          id: draft.id,
        })
        .catch(() => null);
      throw fail.STORAGE_ERROR({
        message: "Audit write failed; the request was withdrawn",
      });
    }
    // The override details live in the audit row; submit takes no note.
    let submitted: DeploymentRequestRow | null;
    try {
      submitted = await requests.transition({
        action: "submit",
        actorId: principal.userId,
        id: draft.id,
      });
    } catch (error) {
      await requests
        .transition({
          action: "withdraw",
          actorId: principal.userId,
          id: draft.id,
        })
        .catch(() => null);
      throw error;
    }
    const row = submitted ?? draft;
    return {
      gate: evaluation.output,
      override: {
        auditId: overrideAuditId,
        rules: [...conflicts],
        used: overriding,
      },
      request: {
        brokerSubmissionAllowed: false as const,
        executionAuthorized: false as const,
        id: row.id,
        mode: "paper" as const,
        status: row.status,
        strategyId: row.strategyId,
        strategySlug: row.strategySlug,
      },
    };
  }
};

const deployRequest = api.academy.deployRequest
  .use(refuseApiKeys)
  .use(requireOperator)
  .handler(
    async ({ context, input, errors }) =>
      await createDeployRequest(
        context,
        context.principal,
        input,
        errors
      ).catch((error: unknown) => repositoryErrors(error, errors))
  );

export const academyRouter = {
  ...academyContentRouter,
  backtest,
  deployPreview,
  deployRequest,
  tickers,
};
