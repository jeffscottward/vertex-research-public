import { describe, expect, it } from "vitest";

import { buildScene, buildTables } from "../index.ts";
import type { ParamValues } from "../position.ts";
import type { DataTable, Panel, SceneData } from "../scene-kit.ts";
import { tradingScene, tradingTables } from "./trading.ts";
import { TRADING_FORMULAS } from "./trading-formulas.ts";
import {
  TRADING_COLORS,
  TRADING_ELEMENTS,
  TRADING_FORMULA_IDS,
  TRADING_MODELS,
  type TradingMode,
} from "./trading-ids.ts";
import {
  bookInputs,
  LANDSCAPE_ENTRIES,
  LANDSCAPE_LOOKBACKS,
  LANDSCAPE_WINDOWS,
  landscape,
  losingCells,
  orderBook,
  PAIR_HEDGE,
  pairsInputs,
  pairsPath,
  rollingZ,
  sharpe,
  slippage,
  sweep,
  zRule,
} from "./trading-models.ts";

const MODES = Object.keys(TRADING_ELEMENTS) as TradingMode[];

const scene = (mode: TradingMode, values: ParamValues = {}, t = 1): SceneData =>
  tradingScene(mode, { azimuth: 0.6, t, values });

const panel = (data: SceneData, id: string): Panel => {
  const found = data.panels.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`no panel ${id}`);
  return found;
};

const table = (tables: readonly DataTable[], id: string): DataTable => {
  const found = tables.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`no table ${id}`);
  return found;
};

const cell = (data: DataTable, measure: string): string | undefined =>
  data.rows.find((row) => row[0] === measure)?.[1];

/** Every number a scene carries, for finiteness checks. */
const numbers = (data: SceneData): number[] =>
  data.panels.flatMap((item) => [
    ...item.xDomain,
    ...item.yDomain,
    ...item.series.flatMap((series) => series.points.flat()),
    ...item.markers.flatMap((marker) =>
      [marker.x, marker.y, marker.x2].filter(
        (value): value is number => value !== undefined
      )
    ),
    ...item.bars.flatMap((bar) => [bar.x, bar.y, bar.width]),
    ...(item.surface === undefined
      ? []
      : [...item.surface.xs, ...item.surface.ys, ...item.surface.z.flat()]),
  ]);

/** Element ids a scene actually draws. */
const drawn = (data: SceneData): Set<string> =>
  new Set(
    data.panels.flatMap((item) => [
      ...item.series.map((series) => series.element),
      ...item.markers.map((marker) => marker.element),
      ...item.bars.map((bar) => bar.element),
      ...(item.surface === undefined ? [] : [item.surface.element]),
    ])
  );

describe("trading contract", () => {
  it.each(MODES)("%s draws exactly its declared elements", (mode) => {
    for (const t of [0, 0.37, 1]) {
      const data = scene(mode, {}, t);
      const declared = new Set<string>(TRADING_ELEMENTS[mode]);
      const listed = new Set(data.panels.flatMap((item) => item.elements));
      expect(listed).toEqual(declared);
      for (const element of drawn(data))
        expect(declared.has(element)).toBe(true);
      for (const item of data.panels)
        for (const element of drawn({ ...data, panels: [item] }))
          expect(item.elements).toContain(element);
      expect(numbers(data).every(Number.isFinite)).toBe(true);
      expect(data.now).toBeGreaterThanOrEqual(0);
      expect(data.now).toBeLessThanOrEqual(data.horizon);
    }
  });

  it.each(MODES)(
    "%s is deterministic for a seed and draws every element at every t",
    (mode) => {
      expect(scene(mode, { seed: 3 }, 0.5)).toEqual(
        scene(mode, { seed: 3 }, 0.5)
      );
      for (const t of [0, 0.5, 1]) {
        const data = scene(mode, {}, t);
        for (const element of TRADING_ELEMENTS[mode].filter(
          (id) => id !== "axes"
        ))
          expect(drawn(data).has(element), `${mode} ${element} t=${t}`).toBe(
            true
          );
      }
      expect(tradingTables(mode, {}, 0.5)).toEqual(
        tradingTables(mode, {}, 0.5)
      );
    }
  );

  it("names a model line and a default color for every element", () => {
    for (const mode of MODES) {
      expect(TRADING_MODELS[mode]).not.toMatch(/TODO/u);
      expect(TRADING_MODELS[mode].length).toBeGreaterThan(40);
    }
    const shared = ["axes", "a", "b", "pnl", "surface", "curve", "marker"];
    for (const element of Object.values(TRADING_ELEMENTS).flat())
      if (!shared.includes(element))
        expect(TRADING_COLORS[element]).toBeDefined();
  });

  it("defines every formula id with MathML and a plain-text form", () => {
    expect(Object.keys(TRADING_FORMULAS).sort()).toEqual(
      [...TRADING_FORMULA_IDS].sort()
    );
    for (const id of TRADING_FORMULA_IDS) {
      const formula = TRADING_FORMULAS[id];
      expect(formula.id).toBe(id);
      expect(formula.mathml).toMatch(/^<math display="block">/u);
      expect(`${formula.title} ${formula.text} ${formula.mathml}`).not.toMatch(
        /TODO/u
      );
    }
  });
});

const PARAMS: Readonly<Record<TradingMode, readonly string[]>> = {
  landscape: ["window", "costBps", "regimeShift", "seed"],
  orderbook: [
    "orderSize",
    "levelSize",
    "levels",
    "tickSize",
    "spreadTicks",
    "depthGrowth",
    "mid",
  ],
  pairs: ["halfLife", "entryZ", "exitZ", "lookback", "costBps", "days", "seed"],
};

describe("trading inputs", () => {
  it.each(MODES)(
    "%s stays finite for huge, negative, zero and invalid inputs",
    (mode) => {
      for (const fill of [1e300, -1e300, 0, -5, "abc", Number.NaN]) {
        const values = Object.fromEntries(
          PARAMS[mode].map((id) => [id, fill])
        ) as ParamValues;
        for (const t of [0, 0.5, 1, -3, 7]) {
          const data = scene(mode, values, t);
          expect(
            numbers(data).every(Number.isFinite),
            `${mode} ${fill} ${t}`
          ).toBe(true);
          for (const item of tradingTables(mode, values, t))
            for (const row of item.rows)
              expect(row.join(" ")).not.toMatch(/NaN|undefined|Infinity/u);
        }
      }
    }
  );

  it.each(MODES)("%s responds to each of its params", (mode) => {
    const base = scene(mode, {}, 0.6);
    const changed: Record<string, number> = {
      costBps: 40,
      days: 400,
      depthGrowth: 40,
      entryZ: 1.25,
      exitZ: 0,
      halfLife: 40,
      levelSize: 900,
      levels: 6,
      lookback: 60,
      mid: 50,
      orderSize: 9000,
      regimeShift: 0,
      seed: 99,
      spreadTicks: 8,
      tickSize: 0.05,
      window: 60,
    };
    for (const id of PARAMS[mode])
      expect(
        scene(mode, { [id]: changed[id] ?? 0 }, 0.6),
        `${mode} ${id}`
      ).not.toEqual(base);
  });

  it.each(MODES)(
    "%s builds through the shared buildScene and buildTables",
    (mode) => {
      const lesson = {
        params: [{ default: 7, id: "seed", label: "Random seed" }],
        scene: { mode, type: "quant" },
      } as never;
      const data = buildScene(lesson, { seed: 7 }, 0.5);
      expect(data).toEqual(scene(mode, { seed: 7 }, 0.5));
      const tables = buildTables(lesson, { seed: 7 }, 0.5);
      expect(tables.map((item) => item.id)).toEqual([
        "inputs",
        "constants",
        ...tradingTables(mode, { seed: 7 }, 0.5).map((item) => item.id),
      ]);
    }
  );
});

describe("trading model helpers", () => {
  it("applies the z-score rule from every state", () => {
    expect(zRule(0, 2.1, 2, 0.5)).toBe(-1);
    expect(zRule(0, -2.1, 2, 0.5)).toBe(1);
    expect(zRule(0, 1, 2, 0.5)).toBe(0);
    expect(zRule(-1, 0.4, 2, 0.5)).toBe(0);
    expect(zRule(-1, 1, 2, 0.5)).toBe(-1);
    expect(zRule(1, -0.4, 2, 0.5)).toBe(0);
    expect(zRule(1, -1, 2, 0.5)).toBe(1);
  });

  it("computes a rolling z-score against the previous L values with a sample sd", () => {
    // Previous 2 values only: [1, 2] → mean 1.5, sample sd √0.5, so 3 scores (3 - 1.5)/√0.5.
    const z = rollingZ([1, 2, 3, 4], 2);
    expect(Number.isNaN(z[0])).toBe(true);
    expect(Number.isNaN(z[1])).toBe(true);
    expect(z[2]).toBeCloseTo(1.5 / Math.sqrt(0.5), 12);
    expect(z[3]).toBeCloseTo(1.5 / Math.sqrt(0.5), 12);
    expect(rollingZ([5, 5, 5], 2).slice(2)).toEqual([0]);
    expect(rollingZ([1, 2, 3, 4], 3)[3]).toBeCloseTo(2 / 1, 12);
  });

  it("counts only Sharpe below 0 as a losing cell", () => {
    expect(losingCells([0, 0, -0.01, 0.4, -2])).toBe(2);
    expect(losingCells([0, 0, 0])).toBe(0);
    const model = landscape({});
    for (const t of [0, 0.5, 1]) {
      const index = Math.min(
        Math.floor(t * LANDSCAPE_WINDOWS),
        LANDSCAPE_WINDOWS - 1
      );
      const surface = model.windows[index]?.surface.flat() ?? [];
      const sea = cell(
        table(tradingTables("landscape", {}, t), "landscape"),
        "Cells losing after costs (the sea)"
      );
      expect(sea).toBe(`${losingCells(surface)} of ${surface.length}`);
    }
  });

  it("states the exit rule for both sides of the trade", () => {
    const { mathml, text } = TRADING_FORMULAS.zScore;
    expect(text).toContain("exit a short once z falls to z_out or below");
    expect(text).toContain("exit a long once z rises to -z_out or above");
    expect(text).toContain("previous L days, not counting today");
    expect(mathml).toContain("<mtext>exit short at</mtext>");
    expect(mathml).toContain("<mtext>exit long at</mtext>");
    for (const formula of Object.values(TRADING_FORMULAS))
      expect(formula.mathml).not.toMatch(/<mo>[\s\u2003]*<\/mo>/u);
  });

  it("keeps today out of its own window, so a big jump scores beyond √(L - 1)", () => {
    const lookback = 10;
    const quiet = Array.from({ length: 30 }, (_, day) =>
      day % 2 === 0 ? 1 : -1
    );
    const z = rollingZ([...quiet, 50], lookback);
    expect(Number.isNaN(z[lookback - 1])).toBe(true);
    expect(Number.isFinite(z[lookback])).toBe(true);
    const jump = Math.abs(z.at(-1) as number);
    expect(jump).toBeGreaterThan(Math.sqrt(lookback - 1));
    // Previous 10 values: mean 0, sample sd √(10/9).
    expect(jump).toBeCloseTo(50 / Math.sqrt(10 / 9), 9);
  });

  it("annualizes Sharpe", () => {
    expect(sharpe([1])).toBe(0);
    expect(sharpe([2, 2, 2])).toBe(0);
    expect(sharpe([1, 3])).toBeCloseTo((2 / Math.SQRT2) * Math.sqrt(252));
  });

  it("clamps inputs to safe ranges", () => {
    expect(
      pairsInputs({ days: 5, entryZ: 9, exitZ: 9, lookback: 1 })
    ).toMatchObject({
      days: 60,
      entryZ: 5,
      exitZ: 4.5,
      lookback: 5,
    });
    expect(
      bookInputs({ levels: 0, mid: 0.01, orderSize: -5, tickSize: 0 })
    ).toMatchObject({
      levels: 1,
      orderSize: 0,
      tickSize: 0.0001,
    });
    expect(bookInputs({ mid: 0.01 }).mid).toBeGreaterThan(0.01);
  });
});

describe("pairs", () => {
  const path = pairsPath({});

  it("builds b from the hedge ratio and the spread and trades on the bands", () => {
    for (const [day, price] of path.a.entries())
      expect(path.b[day]).toBeCloseTo(
        PAIR_HEDGE * price + (path.spread[day] ?? 0)
      );
    expect(path.trips.length).toBeGreaterThan(2);
    expect(new Set(path.trips.map((trip) => trip.side))).toEqual(
      new Set([1, -1])
    );
    for (const trip of path.trips) {
      expect(Math.abs(trip.entryZ)).toBeGreaterThanOrEqual(path.inputs.entryZ);
      expect(Math.sign(trip.entryZ)).toBe(-trip.side);
    }
    const final = path.pnl.at(-1) ?? 0;
    // P&L only moves while a position is held or traded, so the trips add up to the total.
    expect(path.trips.reduce((sum, trip) => sum + trip.pnl, 0)).toBeCloseTo(
      final,
      6
    );
    expect(path.costs.at(-1)).toBeGreaterThan(0);
    expect(pairsPath({ costBps: 0 }).costs.at(-1)).toBe(0);
    expect(pairsPath({ costBps: 50 }).pnl.at(-1) ?? 0).toBeLessThan(final);
  });

  it("reveals days with t and marks trades only up to now", () => {
    const early = scene("pairs", {}, 0);
    expect(early.now).toBe(1);
    expect(
      panel(early, "zscore").markers.filter((m) => m.kind === "dot")
    ).toEqual([]);
    // The position cursor keeps the trades element on the chart before the first trade.
    expect(
      panel(early, "zscore").markers.find((m) => m.kind === "vline")
    ).toMatchObject({ element: "trades", label: "Day 1: flat", x: 1 });
    const cursor = (side: number) => {
      const day = path.position.indexOf(side);
      return panel(
        scene("pairs", {}, day / path.inputs.days),
        "zscore"
      ).markers.find((m) => m.kind === "vline")?.label;
    };
    expect(cursor(1)).toMatch(/: long spread$/u);
    expect(cursor(-1)).toMatch(/: short spread$/u);
    const late = scene("pairs", {}, 1);
    expect(late.now).toBe(path.inputs.days);
    const dots = panel(late, "zscore").markers.filter((m) => m.kind === "dot");
    expect(dots.length).toBeGreaterThanOrEqual(path.trips.length);
    expect(new Set(dots.map((dot) => dot.label))).toEqual(
      new Set(["Buy", "Sell", ""])
    );
    expect(
      panel(late, "prices").markers.filter((m) => m.kind === "band")
    ).toHaveLength(path.trips.length);
  });

  it("draws one exit line at a zero exit level and two otherwise", () => {
    const exits = (values: ParamValues) =>
      panel(scene("pairs", values), "zscore").markers.filter(
        (m) => m.element === "exit"
      );
    expect(exits({ exitZ: 0 })).toHaveLength(1);
    expect(exits({ exitZ: 0.5 })).toHaveLength(2);
  });

  it("keeps a trip open past the last day and marks it to market", () => {
    // A long spread exits only once z climbs back to -exitZ = +1.8: trips stay open for long.
    const values = { entryZ: 2, exitZ: -1.8 };
    const open = pairsPath(values);
    const last = open.trips.at(-1);
    expect(last?.exit).toBeNull();
    const data = scene("pairs", values, 1);
    const bands = panel(data, "prices").markers.filter(
      (m) => m.kind === "band"
    );
    expect(bands.at(-1)?.x2).toBe(open.inputs.days);
    const rows = table(tradingTables("pairs", values, 1), "trades").rows;
    expect(rows.at(-1)?.[3]).toBe("Open");
    expect(rows.at(-1)?.[4]).toBe("");
  });

  it("reports the position, trades and P&L on the current day", () => {
    const early = tradingTables("pairs", {}, 0);
    expect(cell(table(early, "pairs"), "Spread z-score")).toBe(
      "Lookback filling"
    );
    expect(cell(table(early, "pairs"), "Win rate")).toBe("None closed yet");
    expect(cell(table(early, "pairs"), "Position")).toBe("Flat");
    const at = (side: number): string | undefined => {
      const day = path.position.indexOf(side);
      return cell(
        table(tradingTables("pairs", {}, day / path.inputs.days), "pairs"),
        "Position"
      );
    };
    expect(at(1)).toMatch(/^Long spread/u);
    expect(at(-1)).toMatch(/^Short spread/u);
    const late = tradingTables("pairs", {}, 1);
    expect(cell(table(late, "pairs"), "Win rate")).toMatch(/%$/u);
    const trades = table(late, "trades").rows;
    expect(trades).toHaveLength(path.trips.length);
    expect(trades.some((row) => row[0] === "Long spread")).toBe(true);
    expect(trades.some((row) => row[0] === "Short spread")).toBe(true);
    expect(trades.every((row) => /^-?\$\d+$/u.test(row[5] ?? ""))).toBe(true);
  });
});

describe("landscape", () => {
  const model = landscape({});

  it("computes an 8×8 Sharpe surface per rolling window", () => {
    expect(model.windows).toHaveLength(LANDSCAPE_WINDOWS);
    expect(model.step).toBe(30);
    expect(model.horizon).toBe(120 + (LANDSCAPE_WINDOWS - 1) * 30);
    for (const window of model.windows) {
      expect(window.end - window.start).toBe(120);
      expect(window.surface).toHaveLength(LANDSCAPE_ENTRIES.length);
      for (const row of window.surface)
        expect(row).toHaveLength(LANDSCAPE_LOOKBACKS.length);
      const peak = Math.max(...window.surface.flat());
      expect(window.best.sharpe).toBe(peak);
      expect(
        window.surface[window.best.entryIndex]?.[window.best.lookbackIndex]
      ).toBe(peak);
    }
  });

  it("trades the previous window's optimum, one refit behind", () => {
    expect(model.windows[0]?.model).toBeNull();
    expect(model.windows[0]?.outOfSample).toEqual([]);
    model.windows.slice(1).forEach((window, index) => {
      const previous = model.windows[index];
      expect(window.model?.lookback).toBe(previous?.best.lookback);
      expect(window.model?.entry).toBe(previous?.best.entry);
      expect(window.model?.sharpe).toBeLessThanOrEqual(window.best.sharpe);
      expect(window.outOfSample).toHaveLength(model.step * (index + 1));
    });
    const moved = new Set(model.windows.map((window) => window.best.lookback));
    expect(moved.size).toBeGreaterThan(2);
  });

  it("drifts the mean-reversion speed with regimeShift and sinks peaks under costs", () => {
    const spread = (values: ParamValues) => {
      const halfLives = landscape(values).windows.map(
        (window) => window.halfLife
      );
      return Math.max(...halfLives) / Math.min(...halfLives);
    };
    expect(spread({ regimeShift: 0 })).toBeCloseTo(1);
    expect(spread({ regimeShift: 2 })).toBeGreaterThan(
      spread({ regimeShift: 1 })
    );
    const sea = (values: ParamValues) =>
      landscape(values)
        .windows.flatMap((window) => window.surface.flat())
        .filter((v) => v < 0).length;
    expect(sea({ costBps: 40 })).toBeGreaterThan(sea({ costBps: 0 }));
  });

  it("moves the landscape with t", () => {
    const first = scene("landscape", {}, 0);
    const last = scene("landscape", {}, 1);
    expect(first.now).toBe(120);
    expect(last.now).toBe(model.horizon);
    expect(panel(first, "landscape").surface?.z).not.toEqual(
      panel(last, "landscape").surface?.z
    );
    expect(panel(first, "landscape").surface?.legend).toMatch(
      /Sharpe after 5 bps/u
    );
    expect(panel(first, "walkforward").markers.map((m) => m.element)).toEqual([
      "optimum",
    ]);
    expect(panel(last, "walkforward").markers.map((m) => m.element)).toEqual([
      "optimum",
      "model",
    ]);
    expect(
      panel(last, "walkforward").series.find((s) => s.element === "model")
        ?.points
    ).toHaveLength(LANDSCAPE_WINDOWS - 1);
  });

  it("labels the model dot unless it sits on the optimum", () => {
    const labels = model.windows.slice(1).map((window) => {
      const data = scene(
        "landscape",
        {},
        (window.index + 0.5) / LANDSCAPE_WINDOWS
      );
      const markers = panel(data, "walkforward").markers;
      const same = window.model?.lookback === window.best.lookback;
      expect(markers[0]?.label.endsWith("(model on it)")).toBe(same);
      expect(markers[1]?.label).toBe(same ? "" : "Model");
      return same;
    });
    expect(new Set(labels)).toEqual(new Set([true, false]));
  });

  it("tables the walk-forward path up to the current window", () => {
    const first = tradingTables("landscape", {}, 0);
    expect(cell(table(first, "landscape"), "Model Sharpe on this window")).toBe(
      "None yet"
    );
    expect(
      cell(table(first, "landscape"), "Walk-forward Sharpe out of sample")
    ).toBe("None yet");
    expect(table(first, "walkforward").rows).toHaveLength(1);
    expect(table(first, "walkforward").rows[0]?.[5]).toBe("");
    const last = tradingTables("landscape", {}, 1);
    expect(cell(table(last, "landscape"), "Window")).toMatch(/^16 of 16/u);
    expect(
      cell(table(last, "landscape"), "Model cell (previous window's best)")
    ).toMatch(/-day lookback/u);
    expect(
      cell(table(last, "landscape"), "Walk-forward Sharpe out of sample")
    ).toMatch(/^-?\d+\.\d\d$/u);
    expect(table(last, "walkforward").rows).toHaveLength(LANDSCAPE_WINDOWS);
  });
});

describe("orderbook", () => {
  const book = orderBook({});

  it("lays out bids and asks around mid on the tick grid", () => {
    expect(book.bestBid).toBeCloseTo(97.6);
    expect(book.bestAsk).toBeCloseTo(97.63);
    expect(book.mid).toBeCloseTo(97.615);
    expect(book.asks[1]?.size).toBe(1864);
    expect(book.askDepth).toBe(
      book.asks.reduce((sum, level) => sum + level.size, 0)
    );
  });

  it("sweeps asks in price priority and averages the fills", () => {
    const fill = sweep(book, 3000);
    expect(fill.taken.slice(0, 3)).toEqual([1690, 1310, 0]);
    expect(fill.average).toBeCloseTo((1690 * 97.63 + 1310 * 97.64) / 3000);
    expect(fill.levelsTouched).toBe(2);
    expect(fill.newBestAsk).toBeCloseTo(97.64);
    expect(sweep(book, 0)).toMatchObject({
      average: book.bestAsk,
      filled: 0,
      levelsTouched: 0,
    });
    expect(slippage(book, 0)).toBe(0);
    const all = sweep(book, book.askDepth + 100);
    expect(all.unfilled).toBe(100);
    expect(all.newBestAsk).toBeNull();
    const sizes = [1000, 5000, 20_000, 40_000];
    const slips = sizes.map((size) => slippage(book, size));
    expect([...slips].sort((x, y) => x - y)).toEqual(slips);
  });

  it("fills the order progressively with t", () => {
    const start = scene("orderbook", {}, 0);
    const [first, average] = panel(start, "book").markers;
    // Before the first fill the band marks the best ask, where the order starts.
    expect(first).toMatchObject({ element: "sweep", kind: "band" });
    expect(first?.x).toBeCloseTo(97.625);
    expect(first?.x2).toBeCloseTo(97.635);
    expect(average?.element).toBe("avg");
    expect(average?.x).toBeCloseTo(book.bestAsk);
    expect(
      panel(start, "book").bars.some((bar) => bar.element === "sweep")
    ).toBe(false);
    const end = scene("orderbook", {}, 1);
    const band = panel(end, "book").markers.find((m) => m.element === "sweep");
    expect(panel(end, "book").title).toMatch(/20,000 filled, 9 levels swept/u);
    expect(band?.x).toBeCloseTo(97.625);
    expect(band?.x2).toBeCloseTo(97.715);
    const asks = panel(end, "book").bars.filter(
      (bar) => bar.element === "asks"
    );
    expect(asks).toHaveLength(book.asks.length - 8);
    // Consumed levels keep a ghost of their original size in the sweep color.
    const ghosts = panel(end, "book").bars.filter(
      (bar) => bar.element === "sweep"
    );
    expect(ghosts.map((bar) => -bar.y)).toEqual(
      book.asks.slice(0, 9).map((level) => level.size)
    );
    expect(ghosts.every((bar) => bar.tone === true)).toBe(true);
    expect(asks.every((bar) => bar.y < 0)).toBe(true);
    expect(
      panel(end, "book")
        .bars.filter((bar) => bar.element === "bids")
        .every((bar) => bar.y > 0)
    ).toBe(true);
    const one = scene("orderbook", { orderSize: 1000 }, 1);
    expect(panel(one, "book").title).toMatch(/1 level swept/u);
    const marker = panel(end, "slippage").markers[0];
    expect(marker?.x).toBe(20_000);
    expect(marker?.y).toBeCloseTo(slippage(book, 20_000) * 100);
    expect(marker?.label).not.toMatch(/exhausted/u);
  });

  it("caps an order larger than the book and says so", () => {
    const values = { levels: 2, orderSize: 50_000 };
    const data = scene("orderbook", values, 1);
    expect(panel(data, "slippage").markers[0]?.label).toMatch(
      /book exhausted/u
    );
    const summary = table(tradingTables("orderbook", values, 1), "orderbook");
    expect(summary.note).toMatch(/stay unfilled/u);
    expect(cell(summary, "Best ask after the order")).toBe("Ask side empty");
    expect(cell(summary, "Price impact")).toBe("Book exhausted");
  });

  it("tables the fill, the impact and the ladder", () => {
    const tables = tradingTables("orderbook", {}, 1);
    const summary = table(tables, "orderbook");
    expect(summary.note).toMatch(/static book/u);
    // The reel's example: 20,000 shares move the best ask from $97.63 to $97.71 and fill on
    // average 4.10 cents above the old best ask.
    expect(cell(summary, "Best ask")).toBe("97.63");
    expect(cell(summary, "Best ask after the order")).toBe("97.71");
    expect(cell(summary, "Slippage vs best ask")).toBe("4.10¢");
    expect(cell(summary, "Spread")).toBe("3.00¢ (3 ticks)");
    expect(cell(summary, "Shares filled")).toBe("20,000 of 20,000");
    expect(cell(summary, "Price impact")).toBe("+8.00¢");
    expect(cell(summary, "Levels swept")).toBe("9");
    expect(table(tables, "ladder").rows).toHaveLength(12);
    expect(table(tables, "ladder").rows[0]).toEqual([
      "1",
      "1,690",
      "97.60",
      "97.63",
      "1,690",
      "1,690",
    ]);
    const fine = tradingTables("orderbook", { tickSize: 0.001 }, 0);
    expect(cell(table(fine, "orderbook"), "Best ask")).toMatch(/^\d+\.\d{3}$/u);
  });
});
