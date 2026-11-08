import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { COST_PROFILE_PRESETS } from "./backtest-costs.ts";
import {
  type BarColumns,
  type InstantRunParams,
  runInstantBacktest,
} from "./instant-backtest-engine.ts";
import {
  type PaperForwardPoint,
  type PaperForwardTrade,
  paperForwardStep,
  settledForwardTrades,
} from "./paper-forward.ts";

const DAY = 86_400_000;
const T0 = Date.UTC(2024, 0, 1);

/** Deterministic bars: a slow wave plus seeded noise, so the rule trades often. */
const makeBars = (count: number): BarColumns => {
  let seed = 7;
  const random = () => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    return seed / 2_147_483_648;
  };
  const t = new Float64Array(count);
  const o = new Float64Array(count);
  const h = new Float64Array(count);
  const l = new Float64Array(count);
  const c = new Float64Array(count);
  let close = 100;
  for (let index = 0; index < count; index += 1) {
    const open = close * (1 + (random() - 0.5) * 0.01);
    close = 100 + 15 * Math.sin(index / 9) + (random() - 0.5) * 6;
    t[index] = T0 + index * DAY;
    o[index] = open;
    c[index] = close;
    h[index] = Math.max(open, close) * (1 + random() * 0.01);
    l[index] = Math.min(open, close) * (1 - random() * 0.01);
  }
  return { c, h, l, o, t };
};

const prefix = (bars: BarColumns, size: number): BarColumns => ({
  c: bars.c.slice(0, size),
  h: bars.h.slice(0, size),
  l: bars.l.slice(0, size),
  o: bars.o.slice(0, size),
  t: bars.t.slice(0, size),
});

const CAPITAL = 10_000;
const params: InstantRunParams = {
  costBps: 2,
  costs: {
    capital: CAPITAL,
    profile: COST_PROFILE_PRESETS["ibkr-pro-fixed-us-stock"],
  },
  rule: { fast: 5, kind: "smaCross", slow: 20 },
  stopLossPct: 4,
  takeProfitPct: 6,
};

/** Feeds bars one at a time, as a paper runner sees them, and collects every new result. */
const replay = (bars: BarColumns, forwardStartT: number) => {
  const points: PaperForwardPoint[] = [];
  const trades: PaperForwardTrade[] = [];
  // A runner always has at least the baseline bars, so the replay starts at the forward start.
  for (let size = 120; size <= bars.t.length; size += 1) {
    const step = paperForwardStep(prefix(bars, size), params, {
      afterPointT: points.at(-1)?.t ?? Number.NEGATIVE_INFINITY,
      afterTradeT: trades.at(-1)?.t ?? Number.NEGATIVE_INFINITY,
      capital: CAPITAL,
      forwardStartT,
    });
    points.push(...step.points);
    trades.push(...step.trades);
  }
  return { points, trades };
};

describe("paperForwardStep", () => {
  const bars = makeBars(300);
  const forwardStartT = T0 + 120 * DAY;

  it("replays a bar stream into the same trades as a backtest over the same bars", () => {
    const paper = replay(bars, forwardStartT);
    const backtest = runInstantBacktest(bars, params);
    const expected = settledForwardTrades(
      bars,
      backtest.trades,
      forwardStartT
    ).map((trade) => ({
      pnl: CAPITAL * trade.pnl,
      t: bars.t[trade.exitIndex] as number,
    }));
    expect(expected.length).toBeGreaterThanOrEqual(3);
    expect(paper.trades).toEqual(expected);
    const expectedPoints: PaperForwardPoint[] = [];
    for (let index = 0; index < bars.t.length - 1; index += 1) {
      const t = bars.t[index] as number;
      if (t >= forwardStartT)
        expectedPoints.push({
          equity: CAPITAL * (backtest.equity[index] as number),
          t,
        });
    }
    expect(paper.points).toEqual(expectedPoints);
  });

  it("gives identical results on a second replay", () => {
    expect(replay(bars, forwardStartT)).toEqual(replay(bars, forwardStartT));
  });

  it("returns nothing before two bars or before the forward start", () => {
    const cursor = {
      afterPointT: Number.NEGATIVE_INFINITY,
      afterTradeT: Number.NEGATIVE_INFINITY,
      capital: CAPITAL,
      forwardStartT,
    };
    expect(paperForwardStep(prefix(bars, 1), params, cursor)).toEqual({
      points: [],
      run: null,
      settledIndex: -1,
      trades: [],
    });
    const early = paperForwardStep(prefix(bars, 100), params, cursor);
    expect(early.points).toEqual([]);
    expect(early.trades).toEqual([]);
    expect(early.settledIndex).toBe(98);
    // The whole engine run is returned for the engine comparison (dual run).
    expect(early.run).toEqual(runInstantBacktest(prefix(bars, 100), params));
  });

  it("skips results at or before the cursor", () => {
    const all = paperForwardStep(bars, params, {
      afterPointT: Number.NEGATIVE_INFINITY,
      afterTradeT: Number.NEGATIVE_INFINITY,
      capital: CAPITAL,
      forwardStartT,
    });
    const cut = all.trades[1]?.t as number;
    const later = paperForwardStep(bars, params, {
      afterPointT: cut,
      afterTradeT: cut,
      capital: CAPITAL,
      forwardStartT,
    });
    expect(later.trades).toEqual(all.trades.filter((trade) => trade.t > cut));
    expect(later.points[0]?.t).toBe(cut + DAY);
  });
});

describe("paper forward broker isolation", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const roots = [
    resolve(here, "paper-forward.ts"),
    resolve(here, "server/paper-forward-runner.ts"),
    resolve(here, "../../../scripts/vertex-paper-forward-tick.ts"),
  ];
  const FORBIDDEN = /broker|ibkr|order|execution|quant-?vps|native|gateway/iu;
  // `@darkfactory/shared/universes` is constants only: its own test proves it imports nothing.
  const ALLOWED_PACKAGES = new Set([
    "@darkfactory/db/server",
    "@darkfactory/shared/universes",
    "@orpc/contract",
    "zod",
  ]);

  /** Every import specifier reachable from the roots through relative imports. */
  const reachable = (): Map<string, string[]> => {
    const seen = new Map<string, string[]>();
    const queue = [...roots];
    while (queue.length > 0) {
      const file = queue.pop() as string;
      if (seen.has(file)) continue;
      const source = readFileSync(file, "utf8");
      const specifiers = [
        ...source.matchAll(
          /(?:^|\n)\s*(?:import|export)[^;]*?from\s+["']([^"']+)["']/gu
        ),
        ...source.matchAll(/import\(\s*["']([^"']+)["']\s*\)/gu),
      ].map((match) => match[1] as string);
      seen.set(file, specifiers);
      for (const specifier of specifiers)
        if (specifier.startsWith("."))
          queue.push(resolve(dirname(file), specifier));
    }
    return seen;
  };

  it("imports no broker, order or execution module, directly or indirectly", () => {
    const graph = reachable();
    expect(graph.size).toBeGreaterThanOrEqual(roots.length);
    for (const [file, specifiers] of graph) {
      for (const specifier of specifiers) {
        expect(FORBIDDEN.test(specifier), `${file} imports ${specifier}`).toBe(
          false
        );
        if (!specifier.startsWith("."))
          expect(
            ALLOWED_PACKAGES.has(specifier),
            `${file} imports package ${specifier}`
          ).toBe(true);
      }
    }
  });

  it("detects a forbidden specifier", () => {
    expect(FORBIDDEN.test("../ibkr/order-client.ts")).toBe(true);
    expect(FORBIDDEN.test("./instant-backtest-engine.ts")).toBe(false);
  });
});
