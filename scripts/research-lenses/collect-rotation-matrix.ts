// Daily rotation-matrix data job (read-only). Sources:
//  - Universe + sector/industry/market cap: Nasdaq stock screener (public JSON, one request; NASDAQ/NYSE/AMEX listings).
//  - Daily bars: Yahoo chart API, cached per symbol per day.
// No IBKR gateway use (live engines share its pacing). No Finviz scraping. No orders.
// Usage: bun scripts/research-lenses/collect-rotation-matrix.ts [--out data/rotation-matrix]
//        [--summary-out <file>|none] [--min-cap 3e8] [--min-volume 100000] [--concurrency 8] [--limit N]
// Relative paths resolve against the repository (or archive extract) root. Our names come from the
// market-watch-bot state files in MWB_STATE_DIR. Writes <out>/latest.json atomically.
// Ported from vertex-research scripts/collect-rotation-matrix.mjs (main 1f2b8d4).

import { join, resolve } from "node:path";
import {
  argValue,
  dig,
  field,
  type LensIo,
  logLine,
  messageOf,
  mwbStateDir,
  NASDAQ_SCREENER_URL,
  pool,
  readJsonOrNull,
  runIfMain,
  type ScreenerRow,
  screenerRows,
  symbolsOf,
  writeAtomic,
  yahooSymbol,
} from "./lens-io.ts";
import {
  buildRotationMatrix,
  monitorSummary,
  type RotationSecurity,
} from "./rotation-matrix.ts";

const HEADERS = {
  accept: "application/json",
  "user-agent":
    "Mozilla/5.0 (X11; Linux x86_64) vertex-research/rotation-matrix",
};
const SYMBOL_PATTERN = /^[A-Z]{1,5}([.-][A-Z])?$/;
const MIN_PRICE = 3;

export type RotationJobOptions = Readonly<{
  out: string;
  summaryOut: string;
  minCap: number;
  minVolume: number;
  concurrency: number;
  limit: number;
  today: string;
  cacheDir: string;
}>;

export const rotationJobOptions = (io: LensIo): RotationJobOptions => {
  const arg = (name: string, fallback: string): string =>
    argValue(io.argv, name, fallback);
  const out = resolve(io.rootDir, arg("--out", "data/rotation-matrix"));
  const today = io.now().toISOString().slice(0, 10);
  return {
    cacheDir: join(out, "cache", today),
    concurrency: Number(arg("--concurrency", "8")),
    limit: Number(arg("--limit", "0")),
    minCap: Number(arg("--min-cap", "3e8")),
    minVolume: Number(arg("--min-volume", "100000")),
    out,
    // Optional compact summary file; off by default.
    summaryOut: arg("--summary-out", "none"),
    today,
  };
};

/** GET JSON with 3 tries: waits 5 s x try on HTTP 429, 1 s x try after any other failure. */
export const getJson = async (
  io: LensIo,
  url: string,
  tries = 3
): Promise<unknown> => {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const response = await io.fetch(url, {
        headers: HEADERS,
        signal: AbortSignal.timeout(20_000),
      });
      if (response.status === 429 && attempt < tries) {
        await io.sleep(5000 * attempt);
        continue;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      if (attempt >= tries) throw error;
      await io.sleep(1000 * attempt);
    }
  }
};

export type OurTickers = Readonly<{ wish: string[]; reentry: string[] }>;

/** Wish list and re-entry candidates (watch file plus pre-exit ledger keys) from market-watch-bot state. */
export const readOurs = async (io: LensIo): Promise<OurTickers> => {
  const state = mwbStateDir(io);
  const read = (file: string): Promise<unknown> =>
    readJsonOrNull(io.fs, join(state, file));
  const wish = field(await read("wishlist_watch.json"), "symbols");
  const candidates = field(await read("reentry_watch.json"), "candidates");
  const preExit = field(await read("reentry_ledger.json"), "pre_exit");
  const ledger = Object.keys(
    typeof preExit === "object" && preExit !== null ? preExit : {}
  ).map((key) => key.split(":")[0] as string);
  return {
    reentry: [...new Set([...symbolsOf(candidates), ...ledger])],
    wish: symbolsOf(wish),
  };
};

export const rotationUniverse = async (io: LensIo): Promise<ScreenerRow[]> =>
  screenerRows(await getJson(io, NASDAQ_SCREENER_URL)).filter((row) =>
    SYMBOL_PATTERN.test(row.symbol)
  );

type Bar = [date: string, close: number];

/** Adjusted daily closes (about 7 months), read from today's cache or fetched and cached. */
export const dailyBars = async (
  io: LensIo,
  cacheDir: string,
  symbol: string
): Promise<Bar[]> => {
  const file = join(cacheDir, `${symbol}.json`);
  if (io.fs.exists(file))
    return JSON.parse(await io.fs.readFile(file)) as Bar[];
  const document = await getJson(
    io,
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol(symbol))}?range=7mo&interval=1d`
  );
  const result = dig(document, "chart", "result", 0);
  const timestamps = dig(result, "timestamp");
  const closes =
    dig(result, "indicators", "adjclose", 0, "adjclose") ??
    dig(result, "indicators", "quote", 0, "close");
  const adjusted: readonly unknown[] = Array.isArray(closes) ? closes : [];
  const rows: Bar[] = [];
  for (const [i, time] of (Array.isArray(timestamps)
    ? timestamps
    : []
  ).entries()) {
    const close = adjusted[i];
    if (typeof close === "number" && Number.isFinite(close))
      rows.push([
        new Date(Number(time) * 1000).toISOString().slice(0, 10),
        close,
      ]);
  }
  await writeAtomic(io.fs, file, JSON.stringify(rows));
  return rows;
};

/** Most common last bar date; ties keep the first date seen. */
const mostCommon = (counts: ReadonlyMap<string, number>): string | null =>
  [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

type DatedSecurity = RotationSecurity &
  ScreenerRow &
  Readonly<{ lastDate: string }>;

/** One collection run; returns the process exit code (0 on success). */
export const runRotationMatrix = async (io: LensIo): Promise<number> => {
  try {
    await collect(io);
    return 0;
  } catch (error) {
    logLine(io, "rotation-matrix failed:", messageOf(error));
    return 1;
  }
};

const collect = async (io: LensIo): Promise<void> => {
  const options = rotationJobOptions(io);
  const ours = await readOurs(io);
  const ourSet = new Set([...ours.wish, ...ours.reentry]);
  let list = (await rotationUniverse(io)).filter(
    (row) =>
      ourSet.has(row.symbol) ||
      (Number(row.marketCap) >= options.minCap &&
        row.volume >= options.minVolume &&
        row.price >= MIN_PRICE)
  );
  if (options.limit) list = list.slice(0, options.limit);
  logLine(
    io,
    `universe ${list.length} (min cap ${options.minCap}, min volume ${options.minVolume}); ours wish=${ours.wish.length} reentry=${ours.reentry.length}`
  );
  const securities: DatedSecurity[] = [];
  const failed: string[] = [];
  const dateCount = new Map<string, number>();
  await pool(
    list,
    options.concurrency,
    async (row) => {
      try {
        const bars = await dailyBars(io, options.cacheDir, row.symbol);
        const last = bars.at(-1);
        if (bars.length < 2 || last === undefined) {
          failed.push(row.symbol);
          return;
        }
        dateCount.set(last[0], (dateCount.get(last[0]) ?? 0) + 1);
        securities.push({
          ...row,
          closes: bars.map((bar) => bar[1]),
          lastDate: last[0],
        });
      } catch {
        failed.push(row.symbol);
      }
    },
    (done) => {
      if (done % 250 === 0) logLine(io, `bars ${done}/${list.length}`);
    }
  );
  // asOf = most common last bar date; drop names whose last bar is older (stale/halted) so periods align.
  const asOf = mostCommon(dateCount);
  const aligned = securities.filter((security) => security.lastDate === asOf);
  const matrix = buildRotationMatrix(aligned, { asOf, now: io.now, ours });
  matrix.source = {
    bars: "Yahoo Finance chart API, adjusted daily closes",
    failed: failed.length,
    filters: {
      minCap: options.minCap,
      minPrice: MIN_PRICE,
      minVolume: options.minVolume,
    },
    finvizMap: "https://finviz.com/map.ashx?t=sec_all",
    metadata:
      "Nasdaq stock screener (api.nasdaq.com), sector/industry per Nasdaq classification",
    staleDropped: securities.length - aligned.length,
  };
  const latest = join(options.out, "latest.json");
  await writeAtomic(io.fs, latest, JSON.stringify(matrix));
  if (options.summaryOut !== "none")
    await writeAtomic(
      io.fs,
      options.summaryOut,
      JSON.stringify(monitorSummary(matrix), null, 1)
    );
  // Keep only today's bar cache.
  const cacheRoot = join(options.out, "cache");
  const days = await io.fs.readdir(cacheRoot).catch((): string[] => []);
  for (const day of days)
    if (day !== options.today) await io.fs.rm(join(cacheRoot, day));
  const opportunities = matrix.ours
    .filter((name) => name.opportunity === true)
    .map((name) => name.symbol);
  logLine(
    io,
    `wrote ${latest} asOf=${asOf} names=${aligned.length} failed=${failed.length} opportunities=${opportunities.join(",") || "none"}`
  );
};

await runIfMain(import.meta, runRotationMatrix);
