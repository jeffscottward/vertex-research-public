import type { MarketDailyColumns } from "@darkfactory/db/server";
import { implement } from "@orpc/server";

import { appContract } from "../contract.ts";
import type { Breadth90GetOutput } from "../contracts/breadth-90.ts";
import type { MarketVolatilityOutput } from "../contracts/ibkr-monitor.ts";
import type { MarketContextOutput } from "../contracts/market-context.ts";
import {
  type MarketRegimeOutput,
  MarketRegimeOutputSchema,
  REGIME_ETF_VOL_INDEX_IDS,
  REGIME_INDEX_SYMBOLS,
  REGIME_RESEARCH_ONLY_NOTE,
  type RegimeIndexSymbol,
  type RegimeTrendPillar,
} from "../contracts/market-regime.ts";
import type {
  OpenbbMacroOutput,
  OpenbbVolContextOutput,
} from "../contracts/openbb.ts";
import {
  buildRegimeEtfRow,
  classifyBreadth90Pillar,
  classifyCreditPillar,
  classifyDealerGammaPillar,
  classifyTrendPillar,
  classifyVolatilityPillar,
  findCreditFallbackSeries,
  summarizeOverallRegime,
} from "../market-regime-rules.ts";
import { readBreadth90 } from "./breadth-90.ts";
import type { ApiContext } from "./context.ts";
import { fetchIbkrMonitorVolatility } from "./ibkr-monitor.ts";
import type { LoopbackStatusOptions } from "./loopback-status.ts";
import { fetchMarketContext } from "./market-context.ts";
import { type FetchMarketBarsOptions, fetchMarketBars } from "./market-data.ts";
import { historyDate } from "./merged-bars.ts";
import { readOpenbbMacro, readOpenbbVolContext } from "./openbb.ts";
import { requireOperator } from "./operator-access.ts";

// Unified market regime procedure (marketRegime.get).
// Reuses existing readers in parallel with strict fault isolation: a missing or failing upstream
// marks only its pillar unavailable instead of failing the request. Never interpolates raw
// upstream error text or reads account/order/basket paths. Research context only.

const DAY_MS = 86_400_000;
const TREND_LOOKBACK_DAYS = 400;
const CREDIT_LOOKBACK_DAYS = 400;
const CREDIT_SERIES_IDS = ["HY_OAS", "IG_OAS"] as const;
const CORE_VOL_IDS = ["VIX", "VIX3M", "VXN", "RVX", "VXD"] as const;

const MARKET_REGIME_BARS_TIMEOUT_MS = 8000;
const MARKET_REGIME_BARS_COOLDOWN_MS = 5 * 60_000;

const NY_DATE = new Intl.DateTimeFormat("en-CA", {
  day: "2-digit",
  month: "2-digit",
  timeZone: "America/New_York",
  year: "numeric",
});

const nyDateOffset = (now: Date, days: number): string => {
  const base = NY_DATE.format(now);
  return new Date(Date.parse(`${base}T00:00:00Z`) + days * DAY_MS)
    .toISOString()
    .slice(0, 10);
};

export type MarketRegimeOptions = Readonly<{
  ibkrMonitor?: Parameters<typeof fetchIbkrMonitorVolatility>[1];
  marketBars?: FetchMarketBarsOptions;
  marketContext?: LoopbackStatusOptions;
  now?: () => Date;
}>;

let regimeOptions: MarketRegimeOptions = {};
let barsFallbackCooldownUntilMs = 0;

/** Test seam: injects clock and upstream fetch options and clears the IBKR fallback cooldown. */
export const setMarketRegimeOptionsForTesting = (
  options: MarketRegimeOptions | null
): void => {
  regimeOptions = options ?? {};
  barsFallbackCooldownUntilMs = 0;
};

type SettledRead<T> = Readonly<
  { data: T; errorDetail?: undefined } | { data: null; errorDetail: string }
>;

const loadDailyTrendSeries = async (
  context: ApiContext,
  now: Date
): Promise<SettledRead<Map<string, MarketDailyColumns>>> => {
  const repo = context.repositories.marketDailySeries;
  if (repo === undefined) {
    return {
      data: null,
      errorDetail: "Missing: daily price series storage is not configured.",
    };
  }
  try {
    const data = await repo.loadSeries(REGIME_INDEX_SYMBOLS, {
      from: nyDateOffset(now, -TREND_LOOKBACK_DAYS),
    });
    return { data };
  } catch {
    return {
      data: null,
      errorDetail: "Missing: daily price series read failed.",
    };
  }
};

const loadBreadth90Safe = async (
  context: ApiContext
): Promise<SettledRead<Breadth90GetOutput>> => {
  const repo = context.repositories.breadth90;
  if (repo === undefined) {
    return {
      data: null,
      errorDetail: "Missing: Breadth-90 storage is not configured.",
    };
  }
  try {
    return { data: await readBreadth90(repo) };
  } catch {
    return {
      data: null,
      errorDetail: "Missing: Breadth-90 read failed.",
    };
  }
};

const loadMarketContextSafe = async (
  context: ApiContext,
  now: Date
): Promise<SettledRead<MarketContextOutput>> => {
  const base = context.engineStatus ?? null;
  if (base === null) {
    return {
      data: null,
      errorDetail: "Missing: market-context feed is not configured.",
    };
  }
  try {
    const data = await fetchMarketContext(base, {
      ...regimeOptions.marketContext,
      now: () => now,
    });
    return { data };
  } catch {
    return {
      data: null,
      errorDetail: "Missing: market-context feed read failed.",
    };
  }
};

const loadOpenbbCreditSafe = async (
  context: ApiContext,
  now: Date
): Promise<SettledRead<OpenbbMacroOutput>> => {
  const openbb = context.repositories.openbb;
  if (openbb === undefined) {
    return {
      data: null,
      errorDetail: "Missing: OpenBB macro storage is not configured.",
    };
  }
  try {
    const data = await readOpenbbMacro(
      openbb,
      CREDIT_SERIES_IDS,
      nyDateOffset(now, -CREDIT_LOOKBACK_DAYS),
      now
    );
    return { data };
  } catch {
    return {
      data: null,
      errorDetail: "Missing: OpenBB credit spread read failed.",
    };
  }
};

type VolBundle = Readonly<{
  fallbackLatest: ReadonlyMap<
    string,
    Readonly<{ close: number; date: string }>
  >;
  volContext: OpenbbVolContextOutput;
}>;

const loadOpenbbVolSafe = async (
  context: ApiContext,
  now: Date
): Promise<SettledRead<VolBundle>> => {
  const { openbb, marketDailySeries } = context.repositories;
  if (openbb === undefined || marketDailySeries === undefined) {
    return {
      data: null,
      errorDetail: "Missing: OpenBB volatility storage is not configured.",
    };
  }
  try {
    const volContext = await readOpenbbVolContext(
      openbb,
      marketDailySeries,
      null,
      now
    );
    // Surface Cboe vol indices older than the 30-day volContext lookback as stale instead of missing.
    const present = new Set<string>(volContext.indices.map((row) => row.id));
    const missing = CORE_VOL_IDS.filter((id) => !present.has(id));
    const fallbackLatest = new Map<string, { close: number; date: string }>();
    if (missing.length > 0) {
      const latest = await marketDailySeries.latestPoints(missing);
      for (const point of latest) {
        fallbackLatest.set(point.id, {
          close: point.close,
          date: point.lastDate,
        });
      }
    }
    return { data: { fallbackLatest, volContext } };
  } catch {
    return {
      data: null,
      errorDetail: "Missing: OpenBB volatility read failed.",
    };
  }
};

const loadIbkrVolatilitySafe = async (
  context: ApiContext
): Promise<MarketVolatilityOutput | null> => {
  const base = context.ibkrMonitor ?? null;
  if (base === null) return null;
  try {
    return await fetchIbkrMonitorVolatility(base, regimeOptions.ibkrMonitor);
  } catch {
    return null;
  }
};

const resolveTrendForSymbol = async (
  symbol: RegimeIndexSymbol,
  storedMap: Map<string, MarketDailyColumns> | null,
  context: ApiContext,
  now: Date
): Promise<RegimeTrendPillar> => {
  const columns = storedMap?.get(symbol);
  const storedPillar = classifyTrendPillar(
    {
      asOf: columns?.dates.at(-1) ?? null,
      closes: columns?.close ?? [],
      source: columns === undefined ? "none" : "market_daily_series",
      symbol,
    },
    now
  );

  const needsFallback = storedPillar.state === "missing" || storedPillar.stale;
  const historyConfig = context.marketHistory ?? null;
  if (
    !needsFallback ||
    historyConfig === null ||
    now.getTime() < barsFallbackCooldownUntilMs
  ) {
    return storedPillar;
  }

  try {
    const barsOutput = await fetchMarketBars(
      historyConfig,
      {
        barSize: "1 day",
        currency: "USD",
        duration: "1 Y",
        secType: "STK",
        symbol,
        useRTH: true,
        whatToShow: "TRADES",
      },
      {
        ...regimeOptions.marketBars,
        now: () => now,
        timeoutMs: MARKET_REGIME_BARS_TIMEOUT_MS,
      }
    );
    const lastBar = barsOutput.bars.at(-1);
    // Normalize IBKR daily bar timestamps (unix seconds at 00:00 UTC) via merged-bars historyDate.
    const barDate =
      lastBar === undefined
        ? barsOutput.asOf === null
          ? null
          : barsOutput.asOf.slice(0, 10)
        : historyDate(lastBar.t);
    const ibkrPillar = classifyTrendPillar(
      {
        asOf: barDate,
        closes: barsOutput.bars.map((bar) => bar.c),
        source: "ibkr_bars",
        symbol,
        upstreamStale: barsOutput.cache.stale,
      },
      now
    );
    // Retain stale Postgres SMAs if IBKR fallback returns too few bars.
    return ibkrPillar.state === "missing" ? storedPillar : ibkrPillar;
  } catch {
    barsFallbackCooldownUntilMs =
      now.getTime() + MARKET_REGIME_BARS_COOLDOWN_MS;
    return storedPillar;
  }
};

const api = implement(appContract).$context<ApiContext>();

const get = api.marketRegime.get
  .use(requireOperator)
  .handler(async ({ context }): Promise<MarketRegimeOutput> => {
    const now = (regimeOptions.now ?? (() => new Date()))();

    const [
      trendSeries,
      breadthRead,
      marketContextRead,
      creditRead,
      openbbVolRead,
      ibkrVol,
    ] = await Promise.all([
      loadDailyTrendSeries(context, now),
      loadBreadth90Safe(context),
      loadMarketContextSafe(context, now),
      loadOpenbbCreditSafe(context, now),
      loadOpenbbVolSafe(context, now),
      loadIbkrVolatilitySafe(context),
    ]);

    // Sequential loop for fallback keeps IBKR pacing bounded and short-circuits on cooldown.
    const trends = new Map<RegimeIndexSymbol, RegimeTrendPillar>();
    for (const symbol of REGIME_INDEX_SYMBOLS) {
      trends.set(
        symbol,
        await resolveTrendForSymbol(symbol, trendSeries.data, context, now)
      );
    }

    const breadth90 = classifyBreadth90Pillar(
      breadthRead.data,
      now,
      breadthRead.errorDetail
    );

    const hySeries = creditRead.data?.series.find((row) => row.id === "HY_OAS");
    const igSeries = creditRead.data?.series.find((row) => row.id === "IG_OAS");
    const credit = classifyCreditPillar(
      {
        fallbackContextStale: marketContextRead.data?.stale === true,
        fallbackSeries: findCreditFallbackSeries(
          marketContextRead.data?.macro?.series
        ),
        hyPoints: hySeries?.points ?? [],
        igPoints: igSeries?.points ?? [],
      },
      now,
      creditRead.errorDetail
    );

    const volBundle = openbbVolRead.data;
    const findVolIndex = (id: string) => {
      const fromContext = volBundle?.volContext.indices.find(
        (entry) => entry.id === id
      );
      if (fromContext !== undefined) return fromContext;
      return volBundle?.fallbackLatest.get(id) ?? null;
    };
    const vixIndex = findVolIndex("VIX");
    const vix3mIndex = findVolIndex("VIX3M");
    const ratios = volBundle?.volContext.ratios;

    const etfs = REGIME_INDEX_SYMBOLS.map((symbol) => {
      const etfVolId = REGIME_ETF_VOL_INDEX_IDS[symbol];
      const etfVol = findVolIndex(etfVolId);
      const ivRow =
        volBundle?.volContext.ivDaily.find(
          (entry) => entry.underlying === symbol
        ) ?? null;

      const dealerGamma = classifyDealerGammaPillar(
        symbol,
        marketContextRead.data,
        now,
        marketContextRead.errorDetail
      );

      const volatility = classifyVolatilityPillar(
        {
          atmIv30d: ivRow?.atmIv30d ?? null,
          etfVolClose: etfVol?.close ?? null,
          etfVolDate: etfVol?.date ?? null,
          ivPercentile: ivRow?.ivPercentile ?? null,
          liveVixAsOf: ibkrVol?.vix?.asOf ?? null,
          liveVixStale: ibkrVol?.vix?.stale === true,
          liveVixValue: ibkrVol?.vix?.value ?? null,
          openbbVix3mDate: vix3mIndex?.date ?? null,
          openbbVixClose: vixIndex?.close ?? null,
          openbbVixDate: vixIndex?.date ?? null,
          symbol,
          vix3mVix6m: ratios?.vix3mVix6m ?? null,
          vix9dVix: ratios?.vix9dVix ?? null,
          vixVix3m: ratios?.vixVix3m ?? null,
        },
        now,
        openbbVolRead.errorDetail
      );

      return buildRegimeEtfRow(symbol, {
        breadth90,
        credit,
        dealerGamma,
        trend: trends.get(symbol) as RegimeTrendPillar,
        volatility,
      });
    });

    return MarketRegimeOutputSchema.parse({
      etfs,
      generatedAt: now.toISOString(),
      overall: summarizeOverallRegime(etfs),
      researchOnlyNote: REGIME_RESEARCH_ONLY_NOTE,
    });
  });

export const marketRegimeRouter = { get };
