// One-time helper: fetches daily adjusted closes and writes the frozen backtest data. With
// VERTEX_HISTORY_URL and VERTEX_DEPLOY_STATUS_TOKEN set (.env.example) it asks IBKR first
// (vertex-history ADJUSTED_LAST, 10 Y, waiting out the service pacing) and fills the dates IBKR did
// not serve from Yahoo; without them it reads Yahoo only, as before. Read-only GET requests.
// Run with: bun scripts/sector-rotation-backtest-freeze.ts
import { z } from "zod";

import type { DeployStatusConfig } from "../../packages/api/src/server/deploy-status.ts";
import type { PagedHistoryOptions } from "../../packages/api/src/server/ibkr-history.ts";
import { resolveMarketHistoryConfig } from "../../packages/api/src/server/market-data.ts";
import {
  DAILY_HISTORY_DURATION,
  historyDate,
  loadMergedBars,
} from "../../packages/api/src/server/merged-bars.ts";

const FREEZE_SYMBOLS = [
  "SPY",
  "XLB",
  "XLC",
  "XLE",
  "XLF",
  "XLI",
  "XLK",
  "XLP",
  "XLRE",
  "XLU",
  "XLV",
  "XLY",
] as const;
export const FREEZE_FROM = "2018-06-19";
export const FREEZE_TO = "2026-10-30";
const FREEZE_SOURCE =
  "Yahoo Finance v8 chart API, range=10y, interval=1d, adjusted close";
const FREEZE_SOURCE_IBKR =
  "IBKR daily ADJUSTED_LAST via vertex-history, duration 10 Y; Yahoo Finance v8 chart API adjusted close (range=10y, interval=1d) for dates IBKR did not serve";

const adjSchema = z.object({ adjclose: z.array(z.number().nullable()) });
const resultSchema = z.object({
  indicators: z.object({ adjclose: z.tuple([adjSchema]).rest(adjSchema) }),
  timestamp: z.array(z.number()),
});
const chartSchema = z.object({
  chart: z.object({ result: z.tuple([resultSchema]).rest(resultSchema) }),
});

export type FrozenRow = [string, number];

/** Parses one chart response into sorted, rounded rows inside the freeze window. */
export const parseChart = (body: unknown): FrozenRow[] => {
  const [result] = chartSchema.parse(body).chart.result;
  const [adj] = result.indicators.adjclose;
  const rows: FrozenRow[] = [];
  result.timestamp.forEach((seconds, index) => {
    const close = adj.adjclose[index];
    if (close === null || close === undefined) return;
    const date = new Date(seconds * 1000).toISOString().slice(0, 10);
    if (date < FREEZE_FROM || date > FREEZE_TO) return;
    rows.push([date, round(close)]);
  });
  return rows;
};

export type FetchJson = (url: string) => Promise<unknown>;

/** The IBKR history service of a freeze run (null: Yahoo only). */
export type FreezeHistory = Readonly<{
  config: DeployStatusConfig;
  options?: PagedHistoryOptions;
}>;

type Close = Readonly<{ date: string; close: number }>;

const round = (close: number): number => Math.round(close * 10_000) / 10_000;

/** Fetches every symbol (IBKR first when `history` is set) and returns the frozen file content. */
export const freeze = async (
  fetchJson: FetchJson,
  now: Date,
  history: FreezeHistory | null = null
): Promise<string> => {
  const symbols: Record<string, FrozenRow[]> = {};
  let ibkrUsed = false;
  for (const symbol of FREEZE_SYMBOLS) {
    const merged = await loadMergedBars<Close>({
      config: history?.config ?? null,
      request: {
        barSize: "1 day",
        duration: DAILY_HISTORY_DURATION["10y"],
        symbol,
        whatToShow: "ADJUSTED_LAST",
      },
      offline: true,
      ...(history?.options === undefined ? {} : { options: history.options }),
      fillBefore: FREEZE_FROM,
      fromIbkr: (bar) => {
        const date = historyDate(bar.t);
        return date < FREEZE_FROM || date > FREEZE_TO
          ? null
          : { close: round(bar.c), date };
      },
      yahoo: async () =>
        parseChart(
          await fetchJson(
            `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=10y&interval=1d`
          )
        ).map(([date, close]) => ({ close, date })),
      keyOf: (row) => row.date,
    });
    ibkrUsed ||= merged.history !== null;
    symbols[symbol] = merged.bars.map((row) => [row.date, row.close]);
  }
  return `${JSON.stringify({
    fetchedAt: now.toISOString(),
    source: ibkrUsed ? FREEZE_SOURCE_IBKR : FREEZE_SOURCE,
    symbols,
  })}\n`;
};

export const FREEZE_USER_AGENT =
  "vertex-research-platform sector-rotation backtest freeze (research only)";

export type FreezeIo = Readonly<{
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  /** VERTEX_HISTORY_URL and VERTEX_DEPLOY_STATUS_TOKEN select IBKR first; absent = Yahoo only. */
  env?: Readonly<Record<string, string | undefined>>;
  now: Date;
  out: string;
  write: (path: string, content: string) => void;
}>;

/** Fetches with the descriptive User-Agent, writes the frozen file to `out` and returns exit code 0. */
export const runFreeze = async (io: FreezeIo): Promise<number> => {
  const config = resolveMarketHistoryConfig(
    io.env?.["VERTEX_HISTORY_URL"],
    io.env?.["VERTEX_DEPLOY_STATUS_TOKEN"]
  );
  const content = await freeze(
    async (url) => {
      const response = await io.fetch(url, {
        headers: { "User-Agent": FREEZE_USER_AGENT },
      });
      if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
      return response.json();
    },
    io.now,
    config === null ? null : { config, options: { fetch: io.fetch } }
  );
  io.write(io.out, content);
  return 0;
};
