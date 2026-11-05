// One-time helper: fetches Yahoo daily adjusted closes and writes the frozen backtest data.
// Read-only public GET requests. Run with: bun scripts/sector-rotation-backtest-freeze.ts
import { z } from "zod";

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
    rows.push([date, Math.round(close * 10_000) / 10_000]);
  });
  return rows;
};

export type FetchJson = (url: string) => Promise<unknown>;

/** Fetches every symbol and returns the frozen file content. */
export const freeze = async (
  fetchJson: FetchJson,
  now: Date
): Promise<string> => {
  const symbols: Record<string, FrozenRow[]> = {};
  for (const symbol of FREEZE_SYMBOLS)
    symbols[symbol] = parseChart(
      await fetchJson(
        `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=10y&interval=1d`
      )
    );
  return `${JSON.stringify({
    fetchedAt: now.toISOString(),
    source: FREEZE_SOURCE,
    symbols,
  })}\n`;
};

export const FREEZE_USER_AGENT =
  "vertex-research-platform sector-rotation backtest freeze (research only)";

export type FreezeIo = Readonly<{
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  now: Date;
  out: string;
  write: (path: string, content: string) => void;
}>;

/** Fetches with the descriptive User-Agent, writes the frozen file to `out` and returns exit code 0. */
export const runFreeze = async (io: FreezeIo): Promise<number> => {
  const content = await freeze(async (url) => {
    const response = await io.fetch(url, {
      headers: { "User-Agent": FREEZE_USER_AGENT },
    });
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
    return response.json();
  }, io.now);
  io.write(io.out, content);
  return 0;
};
