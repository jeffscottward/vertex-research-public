// TRUE SLAP deep value scorecard data job (read-only research; no orders, no wish-list or engine changes).
// Scores: (1) our names (market-watch-bot wish list + re-entry watch, rotation-matrix leaders when that file exists),
// (2) --tickers, and (3) an OPTIONAL starting universe for "deep value, low price, little coverage":
//     Nasdaq screener rows with price ≤ $10, market cap $50M–$1B, ≥ $100k/day traded (cutoffs are ours, not the reel's).
// Sources: Nasdaq screener (one request), SEC EDGAR companyfacts, Yahoo chart API. No IBKR gateway. No scraping.
// Usage: bun scripts/research-lenses/collect-deep-value.ts [--out data/deep-value] [--tickers A,B] [--no-universe]
//        [--limit N] [--concurrency 4] [--rotation data/rotation-matrix/latest.json]
// Relative paths resolve against the repository (or archive extract) root. SEC contact: see deep-value-sources.ts.
// Ported from vertex-research scripts/collect-deep-value.mjs (PR #10 plus local fix ffa345d).

import { join, resolve } from "node:path";
import {
  CRITERIA,
  CUTOFFS,
  FLAG_CUTOFFS,
  industryMedians,
  inUniverse,
  rank,
  scoreTicker,
  UNIVERSE_CUTOFFS,
  withPeers,
} from "./deep-value.ts";
import {
  createDeepValueSources,
  type GatheredFacts,
} from "./deep-value-sources.ts";
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
} from "./lens-io.ts";

const SYMBOL_PATTERN = /^[A-Z]{1,5}$/;

export type DeepValueJobOptions = Readonly<{
  out: string;
  limit: number;
  concurrency: number;
  tickers: string[];
  universe: boolean;
  rotationFile: string;
}>;

export const deepValueJobOptions = (io: LensIo): DeepValueJobOptions => {
  const arg = (name: string, fallback: string): string =>
    argValue(io.argv, name, fallback);
  return {
    concurrency: Number(arg("--concurrency", "4")),
    limit: Number(arg("--limit", "0")),
    out: resolve(io.rootDir, arg("--out", "data/deep-value")),
    // Upstream read <repo>/data/rotation-matrix/latest.json; --rotation can point at another checkout.
    rotationFile: resolve(
      io.rootDir,
      arg("--rotation", "data/rotation-matrix/latest.json")
    ),
    tickers: arg("--tickers", "").split(",").filter(Boolean),
    universe: !io.argv.includes("--no-universe"),
  };
};

/** Role labels per ticker: wish list, re-entry, rotation leader (1M top industries), requested. */
export const ourNames = async (
  io: LensIo,
  options: DeepValueJobOptions
): Promise<Map<string, Set<string>>> => {
  const roles = new Map<string, Set<string>>();
  const add = (symbol: string, role: string): void => {
    const key = String(symbol).toUpperCase();
    roles.set(key, (roles.get(key) ?? new Set()).add(role));
  };
  const state = mwbStateDir(io);
  const wish = await readJsonOrNull(io.fs, join(state, "wishlist_watch.json"));
  for (const symbol of symbolsOf(field(wish, "symbols")))
    add(symbol, "wish list");
  const reentry = await readJsonOrNull(
    io.fs,
    join(state, "reentry_watch.json")
  );
  for (const symbol of symbolsOf(field(reentry, "candidates")))
    add(symbol, "re-entry");
  const rotation = await readJsonOrNull(io.fs, options.rotationFile);
  const month = dig(rotation, "periods", "1M");
  const top = field(month, "top");
  const industries = field(month, "industries");
  for (const industry of Array.isArray(top) ? top : []) {
    const full: unknown = Array.isArray(industries)
      ? industries.find(
          (candidate: unknown) =>
            field(candidate, "industry") === field(industry, "industry") &&
            field(candidate, "sector") === field(industry, "sector")
        )
      : undefined;
    const leaders = field(full, "leaders");
    for (const leader of Array.isArray(leaders) ? leaders : [])
      add(String(field(leader, "symbol")), "rotation leader");
  }
  for (const symbol of options.tickers) add(symbol, "requested");
  return roles;
};

/** Nasdaq screener rows with plain tickers (no class suffix); one request, no retry, as upstream. */
export const deepValueUniverse = async (io: LensIo): Promise<ScreenerRow[]> => {
  const response = await io.fetch(NASDAQ_SCREENER_URL, {
    headers: {
      accept: "application/json",
      "user-agent": "Mozilla/5.0 vertex-research/deep-value",
    },
    signal: AbortSignal.timeout(30_000),
  });
  return screenerRows(await response.json()).filter((row) =>
    SYMBOL_PATTERN.test(row.symbol)
  );
};

interface Target {
  industry?: string | null | undefined;
  name?: string | undefined;
  roles: string[];
  symbol: string;
}

/** One scoring run; returns the process exit code (0 on success). */
export const runDeepValue = async (io: LensIo): Promise<number> => {
  try {
    await collect(io);
    return 0;
  } catch (error) {
    logLine(io, "deep-value failed:", messageOf(error));
    return 1;
  }
};

const collect = async (io: LensIo): Promise<void> => {
  const options = deepValueJobOptions(io);
  const roles = await ourNames(io, options);
  const targets = new Map<string, Target>(
    [...roles].map(([symbol, set]) => [symbol, { roles: [...set], symbol }])
  );
  let universeCount = 0;
  let industryBySymbol: Record<string, string> = {};
  if (options.universe) {
    const all = await deepValueUniverse(io);
    const meta = new Map(all.map((row) => [row.symbol, row]));
    industryBySymbol = Object.fromEntries(
      all.flatMap((row) => (row.industry ? [[row.symbol, row.industry]] : []))
    );
    for (const target of targets.values()) {
      const row = meta.get(target.symbol);
      Object.assign(target, { industry: row?.industry, name: row?.name });
    }
    let picks = all
      .filter((row) => inUniverse(row))
      .sort((a, b) => Number(a.marketCap) - Number(b.marketCap));
    if (options.limit) picks = picks.slice(0, options.limit);
    universeCount = picks.length;
    for (const pick of picks) {
      const target = targets.get(pick.symbol);
      if (target) target.roles.push("low-price universe");
      else
        targets.set(pick.symbol, {
          industry: pick.industry,
          name: pick.name,
          roles: ["low-price universe"],
          symbol: pick.symbol,
        });
    }
  }
  logLine(
    io,
    `scoring ${targets.size} names (ours ${roles.size}, universe ${universeCount})`
  );
  const sources = createDeepValueSources(io);
  const list = [...targets.values()];
  const gathered: GatheredFacts[] = [];
  let errors = 0;
  await pool(
    list,
    options.concurrency,
    async (target) => {
      const facts = await sources.gatherFacts(target.symbol, {
        industry: target.industry,
        name: target.name,
        roles: target.roles,
      });
      if (facts.errors.length) errors += 1;
      gathered.push(facts);
    },
    (done) => {
      if (done % 100 === 0) logLine(io, `gathered ${done}/${list.length}`);
    }
  );
  // Pass 2: peer medians need every name's facts first.
  const medians = industryMedians(gathered);
  const ranked = rank(
    gathered.map((facts) => ({
      ...scoreTicker(withPeers(facts, medians)),
      errors: facts.errors,
      symbol: facts.symbol,
    }))
  );
  const document = {
    counts: {
      ours: roles.size,
      scored: ranked.length,
      universe: universeCount,
      withErrors: errors,
    },
    criteria: CRITERIA,
    cutoffs: {
      flags: FLAG_CUTOFFS,
      note: "All numeric cutoffs and proxies are ours. The reel gives no numbers; creator claims are unverified.",
      scoring: CUTOFFS,
      universe: UNIVERSE_CUTOFFS,
    },
    generatedAt: io.now().toISOString(),
    industryBySymbol,
    industryMedians: medians,
    method: "TRUE SLAP (IG reel Dew5OAejyOH, @willbchou)",
    rows: ranked,
    sources: {
      fundamentals: "SEC EDGAR XBRL companyfacts",
      prices: "Yahoo Finance chart API (1y daily)",
      universe: "Nasdaq stock screener (api.nasdaq.com)",
    },
  };
  const latest = join(options.out, "latest.json");
  await writeAtomic(io.fs, latest, JSON.stringify(document));
  const top = ranked
    .slice(0, 5)
    .map((row) => `${row.symbol}:${row.total}`)
    .join(",");
  logLine(io, `wrote ${latest} scored=${ranked.length} top=${top}`);
};

await runIfMain(import.meta, runDeepValue);
