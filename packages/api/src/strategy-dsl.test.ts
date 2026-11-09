import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { canonicalJson, sha256Hex } from "./canonical-json.ts";
import {
  parseStrategyDefinitionText,
  resolveStrategySeries,
  STRATEGY_CALENDAR_INTRADAY_REFUSAL,
  STRATEGY_CALENDAR_INTRADAY_UNSUPPORTED,
  STRATEGY_DAILY_TIMEFRAMES,
  STRATEGY_DSL_MAX_EXPR_DEPTH,
  STRATEGY_DSL_MAX_EXPR_NODES,
  STRATEGY_FUTURE_TWIN,
  STRATEGY_INTRADAY_DAILY_REFUSAL,
  STRATEGY_INTRADAY_DAILY_UNSUPPORTED,
  STRATEGY_IV_INDEX,
  STRATEGY_MONTHLY_INDICATOR_MESSAGE,
  STRATEGY_OPTION_IS_DEBIT,
  STRATEGY_OPTIONS_REFUSAL,
  STRATEGY_OPTIONS_TIMEFRAME_REFUSAL,
  STRATEGY_OPTIONS_UNSUPPORTED,
  STRATEGY_SERIES_FILTERS_UNSUPPORTED,
  STRATEGY_SERIES_IDS,
  STRATEGY_TEMPLATES,
  STRATEGY_TOTAL_RETURN,
  StrategyDefinitionSchema,
  type StrategyExprInput,
  StrategyExprSchema,
  serverStrategyRefusal,
  strategyExprSeries,
  strategyExprSize,
  strategySeriesRefs,
  validateStrategyDefinition,
} from "./strategy-dsl.ts";

const minimal = {
  entry: {
    all: [
      {
        left: { field: "close", type: "price" },
        op: ">",
        right: { type: "const", value: 1 },
      },
    ],
  },
  name: "Test",
  version: 1,
};

describe("validateStrategyDefinition", () => {
  it("accepts a minimal definition and fills defaults", () => {
    const result = validateStrategyDefinition(minimal);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.definition.exit.any).toEqual([]);
    expect(result.definition.sizing).toEqual({ mode: "allIn" });
    expect(result.definition.stopLoss).toEqual({ kind: "none" });
    expect(result.definition.takeProfit).toEqual({ kind: "none" });
  });

  it("defaults the indicator source to close", () => {
    const result = StrategyDefinitionSchema.parse({
      ...minimal,
      entry: {
        all: [
          {
            left: { length: 3, name: "sma", type: "indicator" },
            op: "crossesAbove",
            right: { length: 5, name: "ema", type: "indicator" },
          },
        ],
      },
    });
    expect(result.entry.all[0]?.left).toEqual({
      length: 3,
      name: "sma",
      source: "close",
      type: "indicator",
    });
  });

  it.each([
    ["no entry conditions", { ...minimal, entry: { all: [] } }, "entry"],
    ["unknown version", { ...minimal, version: 2 }, "version"],
    ["blank name", { ...minimal, name: " " }, "name"],
    ["unknown key", { ...minimal, extra: true }, ""],
    [
      "indicator length 0",
      {
        ...minimal,
        entry: {
          all: [
            {
              left: { length: 0, name: "rsi", type: "indicator" },
              op: "<",
              right: { type: "const", value: 30 },
            },
          ],
        },
      },
      "entry.all.0.left.length",
    ],
    [
      "unknown operator",
      {
        ...minimal,
        entry: {
          all: [{ ...minimal.entry.all[0], op: "==" }],
        },
      },
      "entry.all.0.op",
    ],
    [
      "risk sizing without a stop",
      { ...minimal, sizing: { mode: "riskPct", riskPct: 1 } },
      "sizing",
    ],
    [
      "bad session time",
      { ...minimal, session: { endUtc: "25:00", startUtc: "09:30" } },
      "session.endUtc",
    ],
    [
      "empty session",
      { ...minimal, session: { endUtc: "09:30", startUtc: "09:30" } },
      "session",
    ],
  ])("rejects %s", (_, value, path) => {
    const result = validateStrategyDefinition(value);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((issue) => issue.path)).toContain(path);
  });
});

describe("parseStrategyDefinitionText", () => {
  it("parses valid JSON text", () => {
    expect(parseStrategyDefinitionText(JSON.stringify(minimal)).ok).toBe(true);
  });

  it("reports a JSON syntax error at the root path", () => {
    const result = parseStrategyDefinitionText("{ not json");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.path).toBe("");
    expect(result.issues[0]?.message).toMatch(/^Not valid JSON\. /u);
  });

  it("reports schema issues for valid JSON", () => {
    const result = parseStrategyDefinitionText("{}");
    expect(result.ok).toBe(false);
  });
});

describe("STRATEGY_TEMPLATES", () => {
  it("ships four templates that validate", () => {
    const names = Object.values(STRATEGY_TEMPLATES).map((template) => {
      const result = validateStrategyDefinition(template);
      expect(result.ok).toBe(true);
      return template.name;
    });
    expect(names.sort()).toEqual([
      "ATR expansion",
      "Donchian breakout",
      "RSI reversion",
      "SMA cross",
    ]);
  });
});

describe("offset and new indicators", () => {
  const withLeft = (left: unknown) => ({
    ...minimal,
    entry: {
      all: [{ left, op: ">", right: { type: "const", value: 20 } }],
    },
  });

  it("accepts adx, rvol and offsets from 0 to the max length", () => {
    for (const left of [
      { length: 14, name: "adx", offset: 5, type: "indicator" },
      { length: 20, name: "rvol", type: "indicator" },
      { field: "close", offset: 0, type: "price" },
      { field: "high", offset: 1000, type: "price" },
    ]) {
      expect(validateStrategyDefinition(withLeft(left)).ok).toBe(true);
    }
  });

  it.each([
    [{ field: "close", offset: -1, type: "price" }],
    [{ field: "close", offset: 1001, type: "price" }],
    [{ field: "close", offset: 1.5, type: "price" }],
    [{ length: 14, name: "adx", offset: "5", type: "indicator" }],
    [{ offset: 1, type: "const", value: 1 }],
    [{ length: 14, name: "adx", shift: 1, type: "indicator" }],
  ])("rejects %j", (left) => {
    expect(validateStrategyDefinition(withLeft(left)).ok).toBe(false);
  });

  it("caps rvol at 100 sessions and keeps other indicators at 1000", () => {
    expect(
      validateStrategyDefinition(
        withLeft({ length: 100, name: "rvol", type: "indicator" })
      ).ok
    ).toBe(true);
    expect(
      validateStrategyDefinition(
        withLeft({ length: 1000, name: "adx", type: "indicator" })
      ).ok
    ).toBe(true);
    expect(
      validateStrategyDefinition(
        withLeft({ length: 101, name: "rvol", type: "indicator" })
      )
    ).toEqual({
      issues: [
        {
          message: "rvol length must be at most 100 sessions",
          path: "entry.all.0.left.length",
        },
      ],
      ok: false,
    });
  });

  it("needs at least 2 bars for zscore and realizedVol", () => {
    for (const name of ["zscore", "realizedVol"] as const) {
      expect(
        validateStrategyDefinition(
          withLeft({ length: 2, name, source: "high", type: "indicator" })
        ).ok
      ).toBe(true);
      expect(
        validateStrategyDefinition(
          withLeft({ length: 1, name, type: "indicator" })
        )
      ).toEqual({
        issues: [
          {
            message: "zscore and realizedVol length must be at least 2",
            path: "entry.all.0.left.length",
          },
        ],
        ok: false,
      });
    }
  });

  it("adds no offset key to existing templates, so revisions stay the same", () => {
    for (const template of Object.values(STRATEGY_TEMPLATES)) {
      const parsed = StrategyDefinitionSchema.parse(template);
      expect(JSON.stringify(parsed)).not.toContain('"offset"');
      expect(StrategyDefinitionSchema.parse(parsed)).toEqual(parsed);
    }
  });
});

describe("sector quadrant filters", () => {
  const filter = {
    quadrants: ["leading", "improving"],
    sector: "XLK",
    type: "sectorQuadrant",
  };

  it("accepts a filter and defaults the timeframe to weekly", () => {
    const parsed = StrategyDefinitionSchema.parse({
      ...minimal,
      filters: [filter],
    });
    expect(parsed.filters).toEqual([{ ...filter, timeframe: "weekly" }]);
  });

  it("rejects an unknown sector, empty or repeated quadrants and too many filters", () => {
    const issues = (filters: unknown) => {
      const result = validateStrategyDefinition({ ...minimal, filters });
      return result.ok ? [] : result.issues.map((issue) => issue.message);
    };
    expect(issues([{ ...filter, sector: "AAPL" }])).toEqual([
      "Unknown sector. Use a Select Sector SPDR symbol, for example XLK",
    ]);
    expect(issues([{ ...filter, quadrants: [] }]).length).toBe(1);
    expect(issues([{ ...filter, quadrants: ["leading", "leading"] }])).toEqual([
      "Quadrants must not repeat",
    ]);
    expect(issues([{ ...filter, quadrants: ["up"] }]).length).toBe(1);
    expect(issues([]).length).toBe(1);
    expect(issues(Array.from({ length: 5 }, () => filter)).length).toBe(1);
  });

  it("adds no filters key to definitions without filters, so revisions stay the same", () => {
    for (const template of Object.values(STRATEGY_TEMPLATES)) {
      const parsed = StrategyDefinitionSchema.parse(template);
      expect("filters" in parsed).toBe(false);
      expect(JSON.stringify(parsed)).not.toContain('"filters"');
    }
  });
});

const issuesOf = (value: unknown) => {
  const result = validateStrategyDefinition(value);
  return result.ok
    ? []
    : result.issues.map((issue) => `${issue.path}: ${issue.message}`);
};
const withFilters = (...filters: unknown[]) => ({ ...minimal, filters });

describe("series and calendar filters", () => {
  it("accepts each filter type and fills only the documented defaults", () => {
    const parsed = StrategyDefinitionSchema.parse(
      withFilters(
        { max: 30, type: "ivRank" },
        { maxRatio: 0.95, type: "vixTermStructure" },
        { maxTermRatio: 1, maxVix: 20, type: "volRegime" },
        { fromDay: -2, toDay: 3, type: "calendarWindow", window: "turnOfMonth" }
      )
    );
    expect(parsed.filters).toEqual([
      { length: 252, max: 30, type: "ivRank" },
      { maxRatio: 0.95, type: "vixTermStructure" },
      { maxTermRatio: 1, maxVix: 20, trendLength: 200, type: "volRegime" },
      { fromDay: -2, toDay: 3, type: "calendarWindow", window: "turnOfMonth" },
    ]);
    const more = StrategyDefinitionSchema.parse(
      withFilters(
        { length: 20, max: 80, min: 20, type: "ivRank" },
        { maxRatio: 1.1, minRatio: 0.9, type: "vixTermStructure" },
        { type: "calendarWindow", window: "opexWeek" },
        { months: [12, 1], type: "calendarWindow", window: "months" }
      )
    );
    expect(more.filters?.[0]).toEqual({
      length: 20,
      max: 80,
      min: 20,
      type: "ivRank",
    });
    const series = StrategyDefinitionSchema.parse(
      withFilters({
        condition: {
          left: { field: "close", type: "price" },
          op: "crossesAbove",
          right: { length: 200, name: "sma", offset: 1, type: "indicator" },
        },
        series: "ES=F",
        type: "series",
      })
    );
    expect(series.filters?.[0]).toEqual({
      condition: {
        left: { field: "close", type: "price" },
        op: "crossesAbove",
        right: {
          length: 200,
          name: "sma",
          offset: 1,
          source: "close",
          type: "indicator",
        },
      },
      series: "ES=F",
      type: "series",
    });
  });

  it("lists the series ids and IV indices of the contract", () => {
    expect(STRATEGY_SERIES_IDS).toHaveLength(32);
    for (const index of Object.values(STRATEGY_IV_INDEX))
      expect(STRATEGY_SERIES_IDS).toContain(index);
    expect(STRATEGY_IV_INDEX).toMatchObject({ QQQ: "VXN", SPY: "VIX" });
  });

  it.each([
    [
      "an ivRank without bounds",
      { type: "ivRank" },
      "filters.0: ivRank needs min, max or both",
    ],
    [
      "an ivRank min above max",
      { max: 10, min: 20, type: "ivRank" },
      "filters.0.min: ivRank min must not be above max",
    ],
    [
      "a short ivRank window",
      { length: 19, min: 1, type: "ivRank" },
      "filters.0.length: Too small: expected number to be >=20",
    ],
    [
      "a term structure without bounds",
      { type: "vixTermStructure" },
      "filters.0: vixTermStructure needs minRatio, maxRatio or both",
    ],
    [
      "a term structure min above max",
      { maxRatio: 0.9, minRatio: 1, type: "vixTermStructure" },
      "filters.0.minRatio: vixTermStructure minRatio must not be above maxRatio",
    ],
    [
      "repeated months",
      { months: [3, 3], type: "calendarWindow", window: "months" },
      "filters.0.months: Months must not repeat",
    ],
    [
      "a turn of month starting after the month end",
      { fromDay: 1, toDay: 3, type: "calendarWindow", window: "turnOfMonth" },
      "filters.0.fromDay: Too big: expected number to be <=-1",
    ],
  ])("rejects %s", (_, filter, issue) => {
    expect(issuesOf(withFilters(filter))).toEqual([issue]);
  });

  it("rejects unknown filter types, windows and series", () => {
    expect(issuesOf(withFilters({ type: "moon" })).length).toBe(1);
    expect(
      issuesOf(withFilters({ type: "calendarWindow", window: "eclipse" }))
        .length
    ).toBe(1);
    expect(
      issuesOf(
        withFilters({
          condition: minimal.entry.all[0],
          series: "BTC",
          type: "series",
        })
      ).length
    ).toBe(1);
  });

  it("allows only the series close in a series condition", () => {
    const seriesOn = (
      left: unknown,
      right: unknown = { type: "const", value: 1 }
    ) =>
      issuesOf(
        withFilters({
          condition: { left, op: ">", right },
          series: "GC=F",
          type: "series",
        })
      );
    const message =
      "filters.0.condition: A series condition reads the series close only: use the close price and close-sourced indicators other than atr, adx and rvol";
    expect(seriesOn({ field: "close", type: "price" })).toEqual([]);
    expect(seriesOn({ length: 5, name: "zscore", type: "indicator" })).toEqual(
      []
    );
    expect(seriesOn({ field: "high", type: "price" })).toEqual([message]);
    expect(
      seriesOn({ length: 5, name: "sma", source: "low", type: "indicator" })
    ).toEqual([message]);
    expect(seriesOn({ length: 5, name: "atr", type: "indicator" })).toEqual([
      message,
    ]);
    expect(
      seriesOn(
        { field: "close", type: "price" },
        { length: 5, name: "rvol", type: "indicator" }
      )
    ).toEqual([message]);
  });

  it("keeps at most four filters of any type", () => {
    const filter = { type: "calendarWindow", window: "opexWeek" };
    expect(issuesOf(withFilters(filter, filter, filter, filter))).toEqual([]);
    expect(
      issuesOf(withFilters(filter, filter, filter, filter, filter)).length
    ).toBe(1);
  });
});

describe("options block", () => {
  const credit = {
    dte: { min: 21, target: 45 },
    exitDte: 7,
    maxLossPct: 2,
    profitTakePct: 50,
    shortDelta: 0.2,
    structure: "putCreditVertical",
    widthSigma: 0.5,
  };
  const debit = {
    dte: { min: 20, target: 30 },
    longDelta: 0.6,
    maxLossPct: 1,
    structure: "callDebitVertical",
    widthSigma: 1,
  };

  it("accepts credit and debit verticals and adds no defaults", () => {
    expect(
      StrategyDefinitionSchema.parse({ ...minimal, options: credit }).options
    ).toEqual(credit);
    expect(
      StrategyDefinitionSchema.parse({ ...minimal, options: debit }).options
    ).toEqual(debit);
    const bare = { ...debit, longDelta: undefined };
    expect(
      JSON.stringify(
        StrategyDefinitionSchema.parse({ ...minimal, options: bare }).options
      )
    ).toBe(
      '{"dte":{"min":20,"target":30},"maxLossPct":1,"structure":"callDebitVertical","widthSigma":1}'
    );
    expect(STRATEGY_OPTION_IS_DEBIT.putDebitVertical).toBe(true);
    expect(STRATEGY_OPTION_IS_DEBIT.callCreditVertical).toBe(false);
  });

  it.each([
    [
      "a loss budget above 2%",
      { ...credit, maxLossPct: 2.5 },
      "options.maxLossPct: maxLossPct must be at most 2 (percent of equity per trade)",
    ],
    [
      "a zero loss budget",
      { ...credit, maxLossPct: 0 },
      "options.maxLossPct: Too small: expected number to be >0",
    ],
    [
      "a long delta on a credit vertical",
      { ...credit, longDelta: 0.5 },
      "options.structure: Debit verticals take longDelta and credit verticals take shortDelta",
    ],
    [
      "a short delta on a debit vertical",
      { ...debit, shortDelta: 0.3 },
      "options.structure: Debit verticals take longDelta and credit verticals take shortDelta",
    ],
    [
      "an exit DTE at the minimum DTE",
      { ...credit, exitDte: 21 },
      "options.exitDte: exitDte must be below dte.min, or a new spread closes at once",
    ],
    [
      "a minimum DTE above the target",
      { ...credit, dte: { min: 50, target: 45 } },
      "options.dte.min: dte.min must not be above dte.target",
    ],
    [
      "a width out of range",
      { ...credit, widthSigma: 4 },
      "options.widthSigma: Too big: expected number to be <=3",
    ],
  ])("rejects %s", (_, options, issue) => {
    expect(issuesOf({ ...minimal, options })).toEqual([issue]);
  });

  it("needs sizing from the options block and no stop or target", () => {
    expect(
      issuesOf({
        ...minimal,
        options: credit,
        sizing: { mode: "riskPct", riskPct: 1 },
        stopLoss: { kind: "pct", pct: 5 },
      })
    ).toEqual([
      "sizing: Option strategies size by options.maxLossPct; remove the riskPct sizing",
      "options: Option strategies exit by profitTakePct, exitDte and exit conditions; remove the stop loss and take profit",
    ]);
    expect(
      issuesOf({
        ...minimal,
        options: credit,
        takeProfit: { kind: "pct", pct: 5 },
      })
    ).toEqual([
      "options: Option strategies exit by profitTakePct, exitDte and exit conditions; remove the stop loss and take profit",
    ]);
    expect(
      issuesOf({ ...minimal, options: credit, sizing: { mode: "allIn" } })
    ).toEqual([]);
  });
});

describe("canonical JSON of existing definitions", () => {
  // SHA-256 of the canonical JSON before the series filters and options block were added. A
  // change here changes the stored revision of every saved definition.
  const PINNED: Record<string, string> = {
    "library:O01":
      "d05f524216f4ef1cdd17bc2114c452c01419f3c5fbeaff19e27f591c25c16288",
    "library:O02":
      "96fd0cb83d0c1aae950bb65fa0dc91264c7621f4a1e5f6c51faac3873bc0aa4d",
    "library:O06":
      "4bc1f8655263643ac5007b47ff727eccebcf688fcc222f76721c8b908d0e2ee9",
    "library:O12":
      "fcabedc721f943101c78b3629085739a211d897424ecc376607458591109737b",
    "library:O13":
      "4e9e7e1aa88d6eae3397b4106f3d7fb0deeccae9f7880af244ea859ec21e8689",
    "library:O18":
      "3c1f9a2fb47dfd02eae236b1a8caa1af9cc95db492160d6d86f330813b18c7b7",
    "library:W01":
      "1c58493ca940d385c401ca56f4d5ae9ca6a419e4ac4cbfa42845a12349cbd72b",
    "library:W03":
      "adbd90bf5a5b946e3cff50e0e332c1eacc25094b6510a5415788a779eea1f676",
    "library:W09":
      "f085568726f96f5d4f1cfa6f94ef50bb5b7fe240c561e5152e3054683453b712",
    sector: "08728a5a301fb75b302514cd867fb434214d349e32006b916bf1f0152e556792",
    "template:atrExpansion":
      "6a5d1fe8b3f0e872d6f7b7e5efa7ad2dbbb117deede9a1071f1c04368942f9ab",
    "template:donchianBreakout":
      "cf5f9d48f3facbed4d5cdddc4ce85a3be313f245a98733befc295a526128c0d9",
    "template:rsiReversion":
      "7e3ce45c98e0b2e0ac951bfbc49a521aaebaa40a1db0244efe319fb564df59ea",
    "template:smaCross":
      "50d2f28d689f5429a1edac0631448a27c925bd39bfb9d9b5bb7b4e9dd1ac3619",
  };

  it("keeps the revisions of templates, library and sector-filtered definitions", async () => {
    const library = JSON.parse(
      readFileSync(
        new URL(
          "../../../research/backtests/quantjourney/library.json",
          import.meta.url
        ),
        "utf8"
      )
    ) as { strategies: { id: string; dsl: unknown }[] };
    const definitions: [string, unknown][] = [
      ...Object.entries(STRATEGY_TEMPLATES).map(
        ([id, template]): [string, unknown] => [`template:${id}`, template]
      ),
      [
        "sector",
        {
          ...STRATEGY_TEMPLATES.smaCross,
          filters: [
            {
              quadrants: ["leading", "improving"],
              sector: "XLK",
              type: "sectorQuadrant",
            },
          ],
        },
      ],
      ...library.strategies
        .filter((strategy) => strategy.dsl !== null)
        .map((strategy): [string, unknown] => [
          `library:${strategy.id}`,
          strategy.dsl,
        ]),
    ];
    const hashes: Record<string, string> = {};
    for (const [id, definition] of definitions) {
      const parsed = StrategyDefinitionSchema.parse(definition);
      expect("options" in parsed).toBe(false);
      hashes[id] = await sha256Hex(canonicalJson(parsed));
    }
    expect(hashes).toEqual(PINNED);
  });
});

describe("serverStrategyRefusal", () => {
  const options = {
    dte: { min: 21, target: 45 },
    maxLossPct: 2,
    structure: "putCreditVertical" as const,
    widthSigma: 0.5,
  };
  const parsed = (extra: Record<string, unknown>) =>
    StrategyDefinitionSchema.parse({ ...minimal, ...extra });

  it("lets equity definitions with sector and calendar filters through", () => {
    expect(serverStrategyRefusal(parsed({}))).toBeUndefined();
    expect(serverStrategyRefusal({})).toBeUndefined();
    expect(
      serverStrategyRefusal(
        parsed({
          filters: [
            { quadrants: ["leading"], sector: "XLK", type: "sectorQuadrant" },
            { type: "calendarWindow", window: "opexWeek" },
          ],
        })
      )
    ).toBeUndefined();
  });

  it("refuses an options block first, then the series filters by type", () => {
    expect(
      serverStrategyRefusal(
        parsed({ filters: [{ max: 30, type: "ivRank" }], options })
      )
    ).toBe(STRATEGY_OPTIONS_REFUSAL);
    expect(STRATEGY_OPTIONS_REFUSAL.code).toBe(STRATEGY_OPTIONS_UNSUPPORTED);
    expect(
      serverStrategyRefusal(
        parsed({
          filters: [
            { max: 30, type: "ivRank" },
            { min: 10, type: "ivRank" },
            { maxRatio: 1, type: "vixTermStructure" },
            { type: "calendarWindow", window: "opexWeek" },
          ],
        })
      )
    ).toEqual({
      code: STRATEGY_SERIES_FILTERS_UNSUPPORTED,
      message:
        "STRATEGY_SERIES_FILTERS_UNSUPPORTED: the ivRank, vixTermStructure filters need daily series that this path does not load; backtest runs and the research runners load them. sectorQuadrant and calendarWindow filters work here.",
    });
  });
});

describe("serverStrategyRefusal with a timeframe", () => {
  const calendar = StrategyDefinitionSchema.parse({
    ...minimal,
    filters: [{ type: "calendarWindow", window: "opexWeek" }],
  });

  it("refuses calendarWindow filters on intraday timeframes only", () => {
    expect(STRATEGY_DAILY_TIMEFRAMES).toEqual(["1d", "1w"]);
    expect(serverStrategyRefusal(calendar, "1d")).toBeUndefined();
    expect(serverStrategyRefusal(calendar, "1w")).toBeUndefined();
    expect(serverStrategyRefusal(calendar)).toBeUndefined();
    expect(serverStrategyRefusal(calendar, "1m")).toBe(
      STRATEGY_CALENDAR_INTRADAY_REFUSAL
    );
    expect(serverStrategyRefusal(calendar, "5m")?.code).toBe(
      STRATEGY_CALENDAR_INTRADAY_UNSUPPORTED
    );
    expect(
      serverStrategyRefusal(StrategyDefinitionSchema.parse(minimal), "1m")
    ).toBeUndefined();
  });
});

describe("options bounds", () => {
  const base = {
    dte: { min: 21, target: 45 },
    maxLossPct: 2,
    structure: "putCreditVertical",
    widthSigma: 0.5,
  };
  const ok = (options: Record<string, unknown>) =>
    validateStrategyDefinition({ ...minimal, options }).ok;

  it.each([
    ["maxLossPct exactly 2", { maxLossPct: 2 }, true],
    ["maxLossPct just above 2", { maxLossPct: 2.000_001 }, false],
    ["a tiny maxLossPct", { maxLossPct: 0.01 }, true],
    ["shortDelta 0.05", { shortDelta: 0.05 }, true],
    ["shortDelta 0.95", { shortDelta: 0.95 }, true],
    ["shortDelta below 0.05", { shortDelta: 0.049 }, false],
    ["shortDelta above 0.95", { shortDelta: 0.951 }, false],
    [
      "longDelta 0.05 on a debit vertical",
      { longDelta: 0.05, structure: "callDebitVertical" },
      true,
    ],
    [
      "longDelta 0.95 on a debit vertical",
      { longDelta: 0.95, structure: "putDebitVertical" },
      true,
    ],
    [
      "longDelta above 0.95",
      { longDelta: 0.96, structure: "callDebitVertical" },
      false,
    ],
    ["profitTakePct 1", { profitTakePct: 1 }, true],
    ["profitTakePct 100", { profitTakePct: 100 }, true],
    ["profitTakePct below 1", { profitTakePct: 0.5 }, false],
    ["profitTakePct above 100", { profitTakePct: 101 }, false],
    ["widthSigma 0.1", { widthSigma: 0.1 }, true],
    ["widthSigma 3", { widthSigma: 3 }, true],
    ["widthSigma below 0.1", { widthSigma: 0.09 }, false],
    ["dte.target 7 with min 1", { dte: { min: 1, target: 7 } }, true],
    ["dte.target 6", { dte: { min: 1, target: 6 } }, false],
    ["dte.target 400", { dte: { min: 30, target: 400 } }, true],
    ["exitDte 0", { exitDte: 0 }, true],
    ["a fractional exitDte", { exitDte: 1.5 }, false],
  ])("%s", (_, change, valid) => {
    expect(ok({ ...base, ...change })).toBe(valid);
  });
});

describe("expression trees", () => {
  const close = { field: "close", type: "price" } as const;
  const zero = { type: "const", value: 0 } as const;
  const series = (ref: string, offset?: number): StrategyExprInput =>
    ({
      series: ref,
      type: "series",
      ...(offset === undefined ? {} : { offset }),
    }) as StrategyExprInput;
  /** `depth` levels: change of change of ... of the close. */
  const nested = (depth: number): StrategyExprInput => {
    let expr: StrategyExprInput = close;
    for (let level = 1; level < depth; level += 1)
      expr = { length: 1, of: expr, type: "change" };
    return expr;
  };
  /** A math tree of `leaves` close leaves (2 × leaves − 1 nodes), at most 6 levels for 32 leaves. */
  const wide = (leaves: number): StrategyExprInput => {
    let level: StrategyExprInput[] = Array.from(
      { length: leaves },
      () => close
    );
    while (level.length > 1) {
      const next: StrategyExprInput[] = [];
      for (let index = 0; index + 1 < level.length; index += 2)
        next.push({
          left: level[index] as StrategyExprInput,
          op: "add",
          right: level[index + 1] as StrategyExprInput,
          type: "math",
        });
      if (level.length % 2 === 1) next.push(level.at(-1) as StrategyExprInput);
      level = next;
    }
    return level[0] as StrategyExprInput;
  };
  const condition = (
    left: StrategyExprInput,
    right: StrategyExprInput = zero
  ) => ({
    ...minimal,
    entry: { all: [{ left, op: ">", right }] },
  });
  const issues = (value: unknown) => {
    const result = validateStrategyDefinition(value);
    return result.ok
      ? []
      : result.issues.map((issue) => `${issue.path}: ${issue.message}`);
  };
  const regression: StrategyExprInput = {
    lag: 1,
    length: 20,
    type: "regression",
    x: series("$future"),
    y: { length: 1, of: close, type: "change" },
  };
  const every: StrategyExprInput = {
    left: {
      left: { length: 252, of: series("$tr"), offset: 1, type: "change" },
      op: "div",
      right: { length: 20, of: series("VIX", 2), type: "returnStdev" },
      type: "math",
    },
    op: "sub",
    right: {
      left: regression,
      op: "mul",
      right: { minCount: 3, monthsAhead: 1, of: close, type: "seasonal" },
      type: "math",
    },
    type: "math",
  };

  it("parses every expression type and keeps the canonical JSON of the input", () => {
    const parsed = StrategyDefinitionSchema.parse(condition(every));
    expect(parsed.entry.all[0]?.left).toEqual(every);
    expect(canonicalJson(parsed.entry.all[0]?.left)).toBe(canonicalJson(every));
    expect(StrategyExprSchema.parse(series("$iv"))).toEqual(series("$iv"));
    // Leaves inside a tree get their defaults.
    expect(
      StrategyExprSchema.parse({
        length: 2,
        of: { length: 5, name: "sma", type: "indicator" },
        type: "returnStdev",
      })
    ).toEqual({
      length: 2,
      of: { length: 5, name: "sma", source: "close", type: "indicator" },
      type: "returnStdev",
    });
  });

  it("measures depth and nodes and lists the series in tree order", () => {
    expect(strategyExprSize(close)).toEqual({ depth: 1, nodes: 1 });
    expect(strategyExprSize(every)).toEqual({ depth: 5, nodes: 13 });
    expect(strategyExprSize(nested(STRATEGY_DSL_MAX_EXPR_DEPTH))).toEqual({
      depth: 6,
      nodes: 6,
    });
    expect(strategyExprSeries(every)).toEqual(["$tr", "VIX", "$future"]);
    expect(strategyExprSeries(close)).toEqual([]);
  });

  it.each([
    ["an unknown series", series("BTC"), "entry.all.0.left.series"],
    ["a negative offset", series("VIX", -1), "entry.all.0.left.offset"],
    [
      "an unknown math op",
      { left: close, op: "pow", right: close, type: "math" },
      "entry.all.0.left.op",
    ],
    [
      "a zero change length",
      { length: 0, of: close, type: "change" },
      "entry.all.0.left.length",
    ],
    [
      "a returnStdev of one return",
      { length: 1, of: close, type: "returnStdev" },
      "entry.all.0.left.length",
    ],
    [
      "a regression of two points",
      { ...regression, length: 2 },
      "entry.all.0.left.length",
    ],
    [
      "a negative regression lag",
      { ...regression, lag: -1 },
      "entry.all.0.left.lag",
    ],
    [
      "a seasonal 12 months ahead",
      { minCount: 1, monthsAhead: 12, of: close, type: "seasonal" },
      "entry.all.0.left.monthsAhead",
    ],
    [
      "a seasonal without values",
      { minCount: 0, monthsAhead: 0, of: close, type: "seasonal" },
      "entry.all.0.left.minCount",
    ],
    [
      "an unknown key",
      { length: 1, of: close, type: "change", window: 3 },
      "entry.all.0.left",
    ],
    [
      "a bad nested leaf",
      { length: 1, of: { field: "volume", type: "price" }, type: "change" },
      "entry.all.0.left.of.field",
    ],
  ])("rejects %s", (_label, left, path) => {
    const result = validateStrategyDefinition(
      condition(left as StrategyExprInput)
    );
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.issues.map((issue) => issue.path)).toContain(path);
  });

  it("limits the depth of each expression and the nodes of a condition", () => {
    expect(issues(condition(nested(STRATEGY_DSL_MAX_EXPR_DEPTH)))).toEqual([]);
    expect(issues(condition(nested(STRATEGY_DSL_MAX_EXPR_DEPTH + 1)))).toEqual([
      "entry.all.0: An expression may nest at most 6 levels",
    ]);
    expect(issues(condition(close, nested(7)))).toEqual([
      "entry.all.0: An expression may nest at most 6 levels",
    ]);
    // 39 nodes on the left and the constant: 40.
    expect(strategyExprSize(wide(20)).nodes).toBe(39);
    expect(issues(condition(wide(20)))).toEqual([]);
    expect(strategyExprSize(wide(21))).toEqual({ depth: 6, nodes: 41 });
    expect(issues(condition(wide(20), close))).toEqual([]);
    expect(issues(condition(wide(20), wide(2)))).toEqual([
      `entry.all.0: A condition may hold at most ${STRATEGY_DSL_MAX_EXPR_NODES} expression nodes`,
    ]);
  });

  it("lets a series filter read a relative ref, but the close only", () => {
    const filter = (left: StrategyExprInput, ref = "$iv") => ({
      ...minimal,
      filters: [
        {
          condition: { left, op: "<", right: zero },
          series: ref,
          type: "series",
        },
      ],
    });
    expect(issues(filter(close))).toEqual([]);
    expect(issues(filter(close, "$tr"))).toEqual([]);
    expect(issues(filter(close, "BTC"))).toEqual([
      expect.stringMatching(/^filters\.0\.series: /u),
    ]);
    const closeOnly =
      "filters.0.condition: A series condition reads the series close only: use the close price and close-sourced indicators other than atr, adx and rvol";
    for (const left of [
      series("VIX"),
      { left: close, op: "add", right: close, type: "math" },
      { length: 2, of: close, type: "returnStdev" },
    ] as StrategyExprInput[])
      expect(issues(filter(left))).toEqual([closeOnly]);
  });

  it("resolves the relative refs per symbol", () => {
    expect(resolveStrategySeries("VIX", undefined)).toBe("VIX");
    expect(resolveStrategySeries("SPY:TR", "QQQ")).toBe("SPY:TR");
    expect(resolveStrategySeries("$tr", "SPY")).toBe("SPY:TR");
    expect(resolveStrategySeries("$iv", "GLD")).toBe("GVZ");
    expect(resolveStrategySeries("$future", "USO")).toBe("CL=F");
    expect(resolveStrategySeries("$future", undefined)).toBeUndefined();
    expect(resolveStrategySeries("$iv", "XLK")).toBeUndefined();
    for (const table of [
      STRATEGY_TOTAL_RETURN,
      STRATEGY_FUTURE_TWIN,
      STRATEGY_IV_INDEX,
    ]) {
      expect(Object.keys(table).sort()).toEqual([
        "DIA",
        "GLD",
        "IWM",
        "QQQ",
        "SLV",
        "SPY",
        "USO",
      ]);
      for (const id of Object.values(table))
        expect(STRATEGY_SERIES_IDS).toContain(id);
    }
  });
});

describe("portfolio block", () => {
  const options = {
    dte: { min: 21, target: 45 },
    maxLossPct: 2,
    shortDelta: 0.2,
    structure: "putCreditVertical" as const,
    widthSigma: 0.5,
  };
  const always = {
    left: { field: "close", type: "price" },
    op: ">",
    right: { type: "const", value: 0 },
  };
  const opex = { type: "calendarWindow", window: "opexWeek" };
  const leg = { entry: { all: [always] }, filters: [opex], options };
  const withPortfolio = (portfolio: Record<string, unknown>, extra = {}) => ({
    ...minimal,
    entry: { all: [always] },
    filters: [opex],
    options,
    portfolio,
    ...extra,
  });
  const issues = (value: unknown) => {
    const result = validateStrategyDefinition(value);
    return result.ok
      ? []
      : result.issues.map((issue) => `${issue.path}: ${issue.message}`);
  };

  it("accepts each policy with its own fields and keeps optional fields absent", () => {
    for (const portfolio of [
      { policy: "roll", symbols: ["SPY"] },
      {
        frame: "monthly",
        legs: [leg],
        policy: "roll",
        select: {
          score: {
            length: 1,
            of: { series: "$tr", type: "series" },
            type: "change",
          },
          tieBreak: { series: "$iv", type: "series" },
          top: 2,
        },
        symbols: ["SPY", "QQQ", "GLD"],
      },
      { cadence: "monthEnd", policy: "flat", symbols: ["USO"] },
      { policy: "window", shift: 5, symbols: ["SPY", "IWM"] },
      { legs: [leg, leg, leg], policy: "window", shift: 1, symbols: ["DIA"] },
    ]) {
      const result = validateStrategyDefinition(withPortfolio(portfolio));
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.definition.portfolio).toEqual(portfolio);
    }
  });

  it.each([
    [{ policy: "hold", symbols: ["SPY"] }, "portfolio.policy"],
    [{ policy: "roll", symbols: [] }, "portfolio.symbols"],
    [{ policy: "roll", symbols: ["XLK"] }, "portfolio.symbols.0"],
    [
      { policy: "roll", symbols: ["SPY", "SPY"] },
      "portfolio.symbols: Portfolio symbols must not repeat",
    ],
    [
      { policy: "flat", symbols: ["SPY"] },
      "portfolio.cadence: cadence is required with the flat policy and only there",
    ],
    [
      { cadence: "daily", policy: "roll", symbols: ["SPY"] },
      "portfolio.cadence: cadence is required with the flat policy and only there",
    ],
    [
      { frame: "monthly", policy: "window", symbols: ["SPY"] },
      "portfolio.frame: frame monthly needs the roll policy",
    ],
    [
      {
        policy: "window",
        select: { score: { field: "close", type: "price" }, top: 1 },
        symbols: ["SPY"],
      },
      "portfolio.select: select needs the roll policy",
    ],
    [
      { policy: "roll", shift: 1, symbols: ["SPY"] },
      "portfolio.shift: shift needs the window policy",
    ],
    [{ policy: "window", shift: 6, symbols: ["SPY"] }, "portfolio.shift"],
    [
      { legs: [leg, leg, leg, leg], policy: "roll", symbols: ["SPY"] },
      "portfolio.legs",
    ],
    [
      {
        legs: [{ ...leg, entry: { all: [] } }],
        policy: "roll",
        symbols: ["SPY"],
      },
      "portfolio.legs.0.entry.all",
    ],
    [
      { legs: [{ entry: leg.entry }], policy: "roll", symbols: ["SPY"] },
      "portfolio.legs.0.options",
    ],
    [
      {
        policy: "roll",
        select: { score: { field: "close", type: "price" }, top: 8 },
        symbols: ["SPY"],
      },
      "portfolio.select.top",
    ],
  ])("rejects %j", (portfolio, expected) => {
    const found = issues(withPortfolio(portfolio));
    expect(
      found.some(
        (issue) => issue === expected || issue.startsWith(`${expected}: `)
      )
    ).toBe(true);
  });

  it("limits the selection scores like a condition side", () => {
    let deep: StrategyExprInput = { field: "close", type: "price" };
    for (let level = 1; level <= STRATEGY_DSL_MAX_EXPR_DEPTH; level += 1)
      deep = { length: 1, of: deep, type: "change" };
    const select = (score: StrategyExprInput, tieBreak?: StrategyExprInput) =>
      withPortfolio({
        policy: "roll",
        select: {
          score,
          top: 1,
          ...(tieBreak === undefined ? {} : { tieBreak }),
        },
        symbols: ["SPY"],
      });
    expect(issues(select(deep))).toEqual([
      "portfolio.select.score: An expression may nest at most 6 levels",
    ]);
    expect(issues(select({ field: "close", type: "price" }, deep))).toEqual([
      "portfolio.select.tieBreak: An expression may nest at most 6 levels",
    ]);
  });

  it("needs an options block", () => {
    const { options: _, ...noOptions } = withPortfolio({
      policy: "roll",
      symbols: ["SPY"],
    });
    expect(issues(noOptions)).toEqual([
      "portfolio: A portfolio block trades option verticals; add an options block",
    ]);
  });

  it.each([
    [
      "an offset close",
      {
        entry: {
          all: [
            { ...always, left: { field: "close", offset: 1, type: "price" } },
          ],
        },
      },
    ],
    [
      "an open",
      {
        entry: { all: [{ ...always, left: { field: "open", type: "price" } }] },
      },
    ],
    [
      "an indicator",
      {
        entry: {
          all: [
            { ...always, left: { length: 2, name: "sma", type: "indicator" } },
          ],
        },
      },
    ],
    ["a >= entry", { entry: { all: [{ ...always, op: ">=" }] } }],
    [
      "a close > 1 entry",
      { entry: { all: [{ ...always, right: { type: "const", value: 1 } }] } },
    ],
    [
      "a close > close entry",
      {
        entry: {
          all: [{ ...always, right: { field: "close", type: "price" } }],
        },
      },
    ],
    ["two entry conditions", { entry: { all: [always, always] } }],
    ["an exit", { exit: { any: [always] } }],
    ["no filters", { filters: undefined }],
    ["a series filter", { filters: [opex, { max: 30, type: "ivRank" }] }],
  ])("refuses a shifted window whose leg has %s", (_label, change) => {
    const message =
      "portfolio.shift: A shifted window reads ahead: every leg needs the entry close > 0, no exit and calendarWindow filters only";
    const portfolio = { policy: "window", shift: 2, symbols: ["SPY"] };
    expect(issues(withPortfolio(portfolio))).toEqual([]);
    expect(issues(withPortfolio(portfolio, change))).toEqual([message]);
    expect(
      issues(
        withPortfolio({ ...portfolio, legs: [leg, { ...leg, ...change }] })
      )
    ).toEqual([message]);
    // Without a shift the same legs are fine.
    expect(
      issues(
        withPortfolio({
          legs: [{ ...leg, ...change }],
          policy: "window",
          symbols: ["SPY"],
        })
      )
    ).toEqual([]);
  });

  it("takes an explicit offset 0 on a shifted window entry as no offset", () => {
    const zero = {
      entry: {
        all: [
          { ...always, left: { field: "close", offset: 0, type: "price" } },
        ],
      },
    };
    const portfolio = { policy: "window", shift: 2, symbols: ["SPY"] };
    expect(issues(withPortfolio(portfolio, zero))).toEqual([]);
    expect(
      issues(withPortfolio({ ...portfolio, legs: [{ ...leg, ...zero }] }))
    ).toEqual([]);
  });

  it.each(["atr", "adx", "rvol"])(
    "refuses %s anywhere in a monthly frame definition",
    (name) => {
      const indicator = { length: 5, name, type: "indicator" };
      const condition = { ...always, left: indicator };
      const message = `portfolio.frame: ${STRATEGY_MONTHLY_INDICATOR_MESSAGE}`;
      const roll = { policy: "roll", symbols: ["SPY"] };
      const monthly = { ...roll, frame: "monthly" };
      // Daily bars have a range and volume.
      expect(
        issues(withPortfolio(roll, { entry: { all: [condition] } }))
      ).toEqual([]);
      expect(
        issues(withPortfolio(monthly, { entry: { all: [condition] } }))
      ).toEqual([message]);
      expect(
        issues(withPortfolio(monthly, { exit: { any: [condition] } }))
      ).toEqual([message]);
      expect(
        issues(
          withPortfolio({
            ...monthly,
            legs: [{ ...leg, exit: { any: [condition] } }],
          })
        )
      ).toEqual([message]);
      const nested = {
        left: indicator,
        op: "div",
        right: { type: "const", value: 2 },
        type: "math",
      };
      expect(
        issues(withPortfolio({ ...monthly, select: { score: nested, top: 1 } }))
      ).toEqual([message]);
      expect(
        issues(
          withPortfolio({
            ...monthly,
            select: {
              score: { series: "$tr", type: "series" },
              tieBreak: indicator,
              top: 1,
            },
          })
        )
      ).toEqual([message]);
    }
  );

  it("keeps other indicators on the monthly frame", () => {
    const sma = { length: 5, name: "sma", type: "indicator" };
    expect(
      issues(
        withPortfolio(
          { frame: "monthly", policy: "roll", symbols: ["SPY"] },
          { entry: { all: [{ ...always, left: sma }] } }
        )
      )
    ).toEqual([]);
  });

  it("refuses a 20000-level selection score without overflowing the stack", () => {
    let deep: unknown = { series: "$tr", type: "series" };
    for (let level = 0; level < 20_000; level += 1)
      deep = { length: 1, of: deep, type: "change" };
    const message = `An expression may nest at most ${STRATEGY_DSL_MAX_EXPR_DEPTH} levels`;
    const roll = { policy: "roll", symbols: ["SPY"] };
    expect(
      issues(withPortfolio({ ...roll, select: { score: deep, top: 1 } }))
    ).toEqual([`portfolio.select.score: ${message}`]);
    expect(
      issues(
        withPortfolio({
          ...roll,
          select: {
            score: { series: "$tr", type: "series" },
            tieBreak: deep,
            top: 1,
          },
        })
      )
    ).toEqual([`portfolio.select.tieBreak: ${message}`]);
  });

  it("limits the nodes of a selection score", () => {
    const full = (depth: number): unknown =>
      depth === 1
        ? { series: "$tr", type: "series" }
        : {
            left: full(depth - 1),
            op: "add",
            right: full(depth - 1),
            type: "math",
          };
    // 1 + 31 + 15 = 47 nodes, 6 levels.
    const score = { left: full(5), op: "add", right: full(4), type: "math" };
    expect(
      issues(
        withPortfolio({
          policy: "roll",
          select: { score, top: 1 },
          symbols: ["SPY"],
        })
      )
    ).toEqual([
      `portfolio.select.score: A condition may hold at most ${STRATEGY_DSL_MAX_EXPR_NODES} expression nodes`,
    ]);
  });
});

describe("deeply nested expressions", () => {
  const message = `An expression may nest at most ${STRATEGY_DSL_MAX_EXPR_DEPTH} levels`;
  const nest = (levels: number, wrap: (of: unknown) => unknown) => {
    let expr: unknown = { field: "close", type: "price" };
    for (let level = 0; level < levels; level += 1) expr = wrap(expr);
    return expr;
  };
  const one = { type: "const", value: 1 };

  it.each([
    ["change", (of: unknown) => ({ length: 1, of, type: "change" })],
    [
      "math",
      (left: unknown) => ({ left, op: "add", right: one, type: "math" }),
    ],
    [
      "regression",
      (y: unknown) => ({ lag: 0, length: 3, type: "regression", x: one, y }),
    ],
  ])(
    "refuses 20000 levels of %s on either side without overflowing the stack",
    (_label, wrap) => {
      const deep = nest(20_000, wrap);
      for (const condition of [
        { left: deep, op: ">", right: one },
        { left: one, op: ">", right: deep },
      ] as const) {
        const result = StrategyDefinitionSchema.safeParse({
          ...minimal,
          entry: { all: [condition] },
        });
        expect(result.success).toBe(false);
        expect(
          result.error?.issues.map((issue) => [
            issue.path.join("."),
            issue.message,
          ])
        ).toEqual([["entry.all.0", message]]);
      }
    }
  );

  it("still accepts the deepest allowed expression", () => {
    const deep = nest(STRATEGY_DSL_MAX_EXPR_DEPTH - 1, (of) => ({
      length: 1,
      of,
      type: "change",
    }));
    const result = StrategyDefinitionSchema.safeParse({
      ...minimal,
      entry: { all: [{ left: deep, op: ">", right: one }] },
    });
    expect(result.success).toBe(true);
  });

  it("leaves a missing or non-object child to the parse, not to the depth check", () => {
    for (const child of [{}, { of: null }, { of: 5 }]) {
      // The broken node sits at the deepest allowed level.
      const broken = nest(STRATEGY_DSL_MAX_EXPR_DEPTH - 1, (of) => ({
        length: 1,
        of,
        type: "change",
      }));
      let node = broken as { of: unknown };
      for (let level = 2; level < STRATEGY_DSL_MAX_EXPR_DEPTH; level += 1)
        node = node.of as { of: unknown };
      node.of = { length: 1, type: "change", ...child };
      const result = StrategyDefinitionSchema.safeParse({
        ...minimal,
        entry: { all: [{ left: broken, op: ">", right: one }] },
      });
      expect(result.success).toBe(false);
      expect(result.error?.issues.map((issue) => issue.message)).not.toContain(
        message
      );
    }
  });
});

describe("resolveStrategySeries", () => {
  it("reads only own symbols of the relative tables", () => {
    for (const ref of ["$tr", "$iv", "$future"] as const)
      for (const symbol of [
        "constructor",
        "toString",
        "__proto__",
        "hasOwnProperty",
      ])
        expect(resolveStrategySeries(ref, symbol)).toBeUndefined();
    expect(resolveStrategySeries("$tr", "SPY")).toBe("SPY:TR");
  });
});

describe("strategySeriesRefs", () => {
  const close = { field: "close", type: "price" } as const;
  const options = {
    dte: { min: 21, target: 45 },
    maxLossPct: 2,
    shortDelta: 0.2,
    structure: "putCreditVertical" as const,
    widthSigma: 0.5,
  };

  it("lists filters, condition expressions, legs and the selection, first use first", () => {
    const definition = StrategyDefinitionSchema.parse({
      ...minimal,
      entry: {
        all: [
          {
            left: { series: "ES=F", type: "series" },
            op: ">",
            right: {
              length: 3,
              of: { series: "$tr", type: "series" },
              type: "change",
            },
          },
        ],
      },
      exit: {
        any: [
          { left: close, op: "<", right: { series: "$iv", type: "series" } },
        ],
      },
      filters: [
        { max: 30, type: "ivRank" },
        { maxTermRatio: 1, maxVix: 20, type: "volRegime" },
        { quadrants: ["leading"], sector: "XLK", type: "sectorQuadrant" },
      ],
      options,
      portfolio: {
        legs: [
          {
            entry: {
              all: [
                {
                  left: close,
                  op: ">",
                  right: { series: "GC=F", type: "series" },
                },
              ],
            },
            filters: [
              { maxRatio: 1, type: "vixTermStructure" },
              {
                condition: { left: close, op: ">", right: close },
                series: "TNX",
                type: "series",
              },
            ],
            options,
          },
        ],
        policy: "roll",
        select: {
          score: { series: "IRX", type: "series" },
          tieBreak: { series: "EY_TNX_RATIO", type: "series" },
          top: 1,
        },
        symbols: ["SPY"],
      },
    });
    expect(strategySeriesRefs(definition)).toEqual([
      "$iv",
      "VIX",
      "VIX3M",
      "SPY",
      "ES=F",
      "$tr",
      "TNX",
      "GC=F",
      "IRX",
      "EY_TNX_RATIO",
    ]);
    expect(strategySeriesRefs({})).toEqual([]);
    expect(
      strategySeriesRefs({
        portfolio: StrategyDefinitionSchema.parse({
          ...minimal,
          options,
          portfolio: {
            policy: "roll",
            select: { score: { series: "VXN", type: "series" }, top: 1 },
            symbols: ["QQQ"],
          },
        }).portfolio,
      })
    ).toEqual(["VXN"]);
  });
});

describe("serverStrategyRefusal with support flags", () => {
  const options = {
    dte: { min: 21, target: 45 },
    maxLossPct: 2,
    shortDelta: 0.2,
    structure: "putCreditVertical" as const,
    widthSigma: 0.5,
  };
  const reads = StrategyDefinitionSchema.parse({
    ...minimal,
    entry: {
      all: [
        {
          left: { series: "$tr", type: "series" },
          op: ">",
          right: { type: "const", value: 1 },
        },
      ],
    },
  });
  const always = {
    left: { field: "close", type: "price" },
    op: ">",
    right: { type: "const", value: 0 },
  };
  const readsVix = {
    left: { field: "close", type: "price" },
    op: "<",
    right: { series: "VIX", type: "series" },
  };
  const seriesExpressions =
    "STRATEGY_SERIES_FILTERS_UNSUPPORTED: series expressions need daily series that this path does not load; backtest runs and the research runners load them. sectorQuadrant and calendarWindow filters work here.";

  it("refuses options without the options runner and off daily bars", () => {
    const withOptions = { ...reads, options };
    expect(serverStrategyRefusal(withOptions, "1d", { series: true })).toBe(
      STRATEGY_OPTIONS_REFUSAL
    );
    expect(
      serverStrategyRefusal(withOptions, "1w", { options: true, series: true })
    ).toBe(STRATEGY_OPTIONS_TIMEFRAME_REFUSAL);
    expect(
      serverStrategyRefusal(withOptions, undefined, {
        options: true,
        series: true,
      })
    ).toBeUndefined();
    expect(
      serverStrategyRefusal(withOptions, "1d", { options: true })?.message
    ).toBe(seriesExpressions);
  });

  it("refuses series expressions and series filters without series support", () => {
    expect(serverStrategyRefusal(reads)).toEqual({
      code: STRATEGY_SERIES_FILTERS_UNSUPPORTED,
      message: seriesExpressions,
    });
    expect(
      serverStrategyRefusal(reads, "1d", { series: true })
    ).toBeUndefined();
    expect(
      serverStrategyRefusal({
        filters: [
          {
            condition: StrategyDefinitionSchema.parse(minimal).entry
              .all[0] as never,
            series: "VIX",
            type: "series",
          },
        ],
      })?.message
    ).toMatch(/^STRATEGY_SERIES_FILTERS_UNSUPPORTED: the series filters need/u);
    const calendar = {
      ...reads,
      filters: [
        { type: "calendarWindow" as const, window: "opexWeek" as const },
      ],
    };
    expect(serverStrategyRefusal(calendar, "5m", { series: true })).toBe(
      STRATEGY_CALENDAR_INTRADAY_REFUSAL
    );
    expect(serverStrategyRefusal(calendar, "5m")?.message).toBe(
      seriesExpressions
    );
  });

  it.each([
    ["entry.all", { entry: { all: [readsVix] } }],
    ["entry.any", { entry: { all: [always], any: [always, readsVix] } }],
    ["exit.any", { exit: { any: [readsVix] } }],
  ])("refuses a series read in %s", (_list, change) => {
    const definition = StrategyDefinitionSchema.parse({
      ...minimal,
      entry: { all: [always] },
      ...change,
    });
    expect(serverStrategyRefusal(definition)?.message).toBe(seriesExpressions);
    expect(
      serverStrategyRefusal(definition, "1d", { series: true })
    ).toBeUndefined();
  });

  it.each([
    ["a leg entry.all", { entry: { all: [readsVix] } }],
    ["a leg exit.any", { exit: { any: [readsVix] } }],
  ])("refuses a series read in %s", (_list, change) => {
    const definition = StrategyDefinitionSchema.parse({
      ...minimal,
      entry: { all: [always] },
      options,
      portfolio: {
        legs: [{ entry: { all: [always] }, options, ...change }],
        policy: "roll",
        symbols: ["SPY"],
      },
    });
    expect(
      serverStrategyRefusal(definition, "1d", { options: true })?.message
    ).toBe(seriesExpressions);
  });

  it("refuses management and maxLeverage with an options block", () => {
    const withStop = { ...minimal, options, stopLoss: { kind: "pct", pct: 2 } };
    expect(issuesOf({ ...withStop, management: { breakevenR: 1 } })).toContain(
      "management: Option strategies exit by profitTakePct, exitDte and exit conditions; remove management"
    );
    // maxLeverage lives in riskPct sizing only, which an options block refuses.
    expect(
      issuesOf({
        ...minimal,
        options,
        sizing: { maxLeverage: 2, mode: "riskPct", riskPct: 1 },
      })
    ).toContain(
      "sizing: Option strategies size by options.maxLossPct; remove the riskPct sizing"
    );
  });
});

describe("DSL extensions: timeframe, breaks, oncePerLevel, entry.any, management, maxLeverage", () => {
  const close = { field: "close", type: "price" } as const;
  const dailyHigh = {
    length: 20,
    name: "highest",
    source: "high",
    timeframe: "1d",
    type: "indicator",
  } as const;
  const breakout = {
    left: close,
    oncePerLevel: true,
    op: "breaksAbove",
    right: dailyHigh,
  } as const;
  const withStop = { ...minimal, stopLoss: { kind: "pct", pct: 2 } } as const;

  it("accepts a daily indicator, breaks with oncePerLevel and entry.any alone", () => {
    const definition = {
      ...withStop,
      entry: {
        all: [],
        any: [breakout, { ...breakout, op: "breaksBelow" }],
      },
      management: {
        breakevenR: 2,
        trail: { activateR: 1, length: 14, multiple: 2 },
      },
      sizing: { maxLeverage: 20, mode: "riskPct", riskPct: 1 },
    };
    expect(issuesOf(definition)).toEqual([]);
    expect(StrategyDefinitionSchema.parse(definition).entry.any?.[0]).toEqual(
      breakout
    );
  });

  it("adds no timeframe, oncePerLevel, any, management or maxLeverage by default", () => {
    const parsed = StrategyDefinitionSchema.parse({
      ...minimal,
      sizing: { mode: "riskPct", riskPct: 1 },
      stopLoss: { kind: "pct", pct: 2 },
    });
    expect(parsed.entry).toEqual(minimal.entry);
    expect("management" in parsed).toBe(false);
    expect(parsed.sizing).toEqual({ mode: "riskPct", riskPct: 1 });
  });

  it.each([
    [
      "rvol on daily bars",
      {
        ...minimal,
        entry: {
          all: [
            {
              left: {
                length: 5,
                name: "rvol",
                timeframe: "1d",
                type: "indicator",
              },
              op: ">",
              right: { type: "const", value: 2 },
            },
          ],
        },
      },
      "entry.all.0.left.timeframe: rvol has no timeframe; it already compares whole sessions",
    ],
    [
      "an unknown timeframe",
      {
        ...minimal,
        entry: {
          all: [{ ...breakout, right: { ...dailyHigh, timeframe: "1h" } }],
        },
      },
      'entry.all.0.right.timeframe: Invalid input: expected "1d"',
    ],
    [
      "oncePerLevel on a comparison",
      {
        ...minimal,
        entry: { all: [{ ...breakout, op: ">=" }] },
      },
      "entry.all.0.oncePerLevel: oncePerLevel works only with crossesAbove, crossesBelow, breaksAbove and breaksBelow",
    ],
    [
      "no condition in entry.all or entry.any",
      { ...minimal, entry: { all: [], any: [] } },
      "entry: Entry needs at least one condition in entry.all or entry.any",
    ],
    [
      "management without a stop",
      { ...minimal, management: { breakevenR: 1 } },
      "management: management moves the stop loss; add a stop loss",
    ],
    [
      "an empty management block",
      { ...withStop, management: {} },
      "management: management needs trail, breakevenR or both",
    ],
    [
      "a breakeven level of 0",
      { ...withStop, management: { breakevenR: 0 } },
      "management.breakevenR: Too small: expected number to be >0",
    ],
    [
      "a trail without its ATR length",
      { ...withStop, management: { trail: { activateR: 1, multiple: 2 } } },
      "management.trail.length: Invalid input: expected number, received undefined",
    ],
    [
      "maxLeverage below 1",
      {
        ...withStop,
        sizing: { maxLeverage: 0.5, mode: "riskPct", riskPct: 1 },
      },
      "sizing.maxLeverage: Too small: expected number to be >=1",
    ],
    [
      "maxLeverage above 50",
      { ...withStop, sizing: { maxLeverage: 51, mode: "riskPct", riskPct: 1 } },
      "sizing.maxLeverage: Too big: expected number to be <=50",
    ],
  ])("rejects %s", (_, value, issue) => {
    expect(issuesOf(value)).toEqual([issue]);
  });

  it("rejects maxLeverage with allIn sizing", () => {
    expect(
      issuesOf({ ...withStop, sizing: { maxLeverage: 2, mode: "allIn" } })
    ).not.toEqual([]);
  });

  it("rejects management on an options strategy", () => {
    expect(
      issuesOf({
        ...minimal,
        management: { breakevenR: 1 },
        options: {
          dte: { min: 21, target: 45 },
          exitDte: 7,
          maxLossPct: 2,
          profitTakePct: 50,
          shortDelta: 0.2,
          structure: "putCreditVertical",
          widthSigma: 0.5,
        },
      })
    ).toContain(
      "management: Option strategies exit by profitTakePct, exitDte and exit conditions; remove management"
    );
  });

  it.each([
    ["oncePerLevel", { oncePerLevel: false }],
    [
      "a 1d indicator",
      { right: { length: 5, name: "sma", timeframe: "1d", type: "indicator" } },
    ],
    [
      "a 1d indicator on the left",
      { left: { length: 5, name: "sma", timeframe: "1d", type: "indicator" } },
    ],
  ])("rejects a series condition with %s", (_, extra) => {
    expect(
      issuesOf(
        withFilters({
          condition: {
            left: close,
            op: "crossesAbove",
            right: { length: 5, name: "sma", type: "indicator" },
            ...extra,
          },
          series: "VIX",
          type: "series",
        })
      )
    ).toEqual([
      "filters.0.condition: A series condition takes no oncePerLevel or timeframe: the series has one value per date",
    ]);
  });
});

describe("intraday block, session indicators, side and volTarget sizing", () => {
  const intraday = {
    close: "16:00",
    entryFrom: "10:00",
    entryTo: "15:30",
    open: "09:30",
    timezone: "America/New_York",
  } as const;
  const close = { field: "close", type: "price" } as const;
  const vwap = { name: "vwap", type: "indicator" } as const;
  const sessionReturn = {
    from: "open",
    name: "sessionReturn",
    to: "10:30",
    type: "indicator",
  } as const;
  const upper = {
    band: "upper",
    length: 14,
    name: "noiseBand",
    type: "indicator",
  } as const;
  const withIndicators = {
    ...minimal,
    entry: {
      all: [
        { left: close, op: ">", right: vwap },
        { left: sessionReturn, op: ">", right: { type: "const", value: 0 } },
      ],
      any: [{ left: close, op: "crossesAbove", right: upper }],
    },
    exit: {
      any: [
        {
          left: close,
          op: "<",
          right: { ...upper, band: "lower", multiple: 2 },
        },
      ],
    },
    intraday,
  };
  const volTarget = {
    length: 14,
    maxLeverage: 4,
    mode: "volTarget",
    targetPct: 2,
  } as const;
  const options = {
    dte: { min: 21, target: 45 },
    exitDte: 7,
    maxLossPct: 2,
    profitTakePct: 50,
    shortDelta: 0.2,
    structure: "putCreditVertical",
    widthSigma: 0.5,
  } as const;

  it("accepts the intraday block, the session indicators, side short and volTarget, adding no defaults", () => {
    const definition = {
      ...withIndicators,
      intraday: { ...intraday, decisionEvery: 30 },
      side: "short",
      sizing: volTarget,
    };
    expect(issuesOf(definition)).toEqual([]);
    const parsed = StrategyDefinitionSchema.parse(definition);
    expect(parsed.intraday).toEqual({ ...intraday, decisionEvery: 30 });
    expect(parsed.side).toBe("short");
    expect(parsed.sizing).toEqual(volTarget);
    expect(parsed.entry.all[0]?.right).toEqual(vwap);
    expect(parsed.exit.any[0]?.right).toEqual({
      ...upper,
      band: "lower",
      multiple: 2,
    });
    // No side, intraday or noiseBand multiple when absent.
    const plain = StrategyDefinitionSchema.parse({
      ...withIndicators,
      intraday,
    });
    expect(plain.side).toBeUndefined();
    expect(plain.intraday?.decisionEvery).toBeUndefined();
    expect(plain.entry.any?.[0]?.right).toEqual(upper);
    expect(issuesOf({ ...minimal, side: "long" })).toEqual([]);
    expect(
      issuesOf({
        ...withIndicators,
        entry: {
          all: [
            {
              left: close,
              op: ">",
              right: { ...sessionReturn, from: "prevClose" },
            },
          ],
        },
      })
    ).toEqual([]);
    expect(
      issuesOf({
        ...withIndicators,
        entry: {
          all: [
            {
              left: close,
              op: ">",
              right: { ...sessionReturn, from: "10:00" },
            },
          ],
        },
      })
    ).toEqual([]);
  });

  it.each([
    [
      "a session indicator without an intraday block",
      { ...withIndicators, intraday: undefined },
      [
        "entry.all.0.right: vwap reads the intraday session; add an intraday block",
        "entry.all.1.left: sessionReturn reads the intraday session; add an intraday block",
        "entry.any.0.right: noiseBand reads the intraday session; add an intraday block",
        "exit.any.0.right: noiseBand reads the intraday session; add an intraday block",
      ],
    ],
    [
      "a session indicator inside an expression tree without an intraday block",
      {
        ...withIndicators,
        entry: {
          all: [
            {
              left: { left: close, op: "add", right: close, type: "math" },
              op: ">",
              right: {
                left: close,
                op: "sub",
                right: { name: "vwap", type: "indicator" },
                type: "math",
              },
            },
          ],
        },
        exit: { any: [] },
        intraday: undefined,
      },
      [
        "entry.all.0.right: vwap reads the intraday session; add an intraday block",
      ],
    ],
    [
      "sessionReturn from at to",
      {
        ...minimal,
        entry: {
          all: [
            {
              left: { ...sessionReturn, from: "10:30" },
              op: ">",
              right: close,
            },
          ],
        },
        intraday,
      },
      ["entry.all.0.left.from: sessionReturn from must be before to"],
    ],
    [
      "sessionReturn from after to",
      {
        ...minimal,
        entry: {
          all: [
            {
              left: { ...sessionReturn, from: "11:00" },
              op: ">",
              right: close,
            },
          ],
        },
        intraday,
      },
      ["entry.all.0.left.from: sessionReturn from must be before to"],
    ],
    [
      "intraday open after close",
      { ...minimal, intraday: { ...intraday, close: "09:00" } },
      [
        "intraday.close: intraday open must be before close",
        "intraday.entryFrom: The entry window must be inside the session: open < entryFrom <= entryTo < close",
      ],
    ],
    [
      "entryFrom at open",
      { ...minimal, intraday: { ...intraday, entryFrom: "09:30" } },
      [
        "intraday.entryFrom: The entry window must be inside the session: open < entryFrom <= entryTo < close",
      ],
    ],
    [
      "entryFrom after entryTo",
      { ...minimal, intraday: { ...intraday, entryFrom: "15:45" } },
      [
        "intraday.entryFrom: The entry window must be inside the session: open < entryFrom <= entryTo < close",
      ],
    ],
    [
      "entryTo at close",
      { ...minimal, intraday: { ...intraday, entryTo: "16:00" } },
      [
        "intraday.entryFrom: The entry window must be inside the session: open < entryFrom <= entryTo < close",
      ],
    ],
    [
      "side short with management",
      {
        ...minimal,
        management: { breakevenR: 1 },
        side: "short",
        stopLoss: { kind: "pct", pct: 2 },
      },
      [
        "management: management raises a long stop; a short definition takes no management",
      ],
    ],
    [
      "side short with options",
      { ...minimal, options, side: "short" },
      [
        "side: Option strategies take their direction from options.structure; remove side",
      ],
    ],
    [
      "options with volTarget",
      { ...minimal, options, sizing: volTarget },
      [
        "sizing: Option strategies size by options.maxLossPct; remove the volTarget sizing",
      ],
    ],
    [
      "options with intraday",
      { ...minimal, intraday, options },
      [
        "intraday: Option strategies run on daily bars; remove the intraday block",
      ],
    ],
    [
      "calendarWindow with intraday",
      {
        ...minimal,
        filters: [
          {
            fromDay: -2,
            toDay: 3,
            type: "calendarWindow",
            window: "turnOfMonth",
          },
        ],
        intraday,
      },
      [
        "filters: calendarWindow filters run on daily bars only; remove them or the intraday block",
      ],
    ],
    [
      "a series condition on a session indicator",
      {
        ...minimal,
        filters: [
          {
            condition: { left: close, op: ">", right: vwap },
            series: "ES=F",
            type: "series",
          },
        ],
        intraday,
      },
      [
        "filters.0.condition: A series condition reads the series close only: use the close price and close-sourced indicators other than atr, adx and rvol",
      ],
    ],
  ])("refuses %s", (_label, definition, expected) => {
    expect(issuesOf(definition)).toEqual(expected);
  });

  it.each([
    ["side", { ...minimal, side: "both" }],
    ["timezone", { ...minimal, intraday: { ...intraday, timezone: "UTC" } }],
    [
      "a time that is not HH:MM",
      { ...minimal, intraday: { ...intraday, open: "9:30" } },
    ],
    [
      "decisionEvery 0",
      { ...minimal, intraday: { ...intraday, decisionEvery: 0 } },
    ],
    [
      "decisionEvery above 390",
      { ...minimal, intraday: { ...intraday, decisionEvery: 391 } },
    ],
    [
      "decisionEvery not whole",
      { ...minimal, intraday: { ...intraday, decisionEvery: 1.5 } },
    ],
    [
      "an unknown intraday key",
      { ...minimal, intraday: { ...intraday, tz: "x" } },
    ],
    ["volTarget length 1", { ...minimal, sizing: { ...volTarget, length: 1 } }],
    [
      "volTarget length above 252",
      { ...minimal, sizing: { ...volTarget, length: 253 } },
    ],
    [
      "volTarget maxLeverage 0",
      { ...minimal, sizing: { ...volTarget, maxLeverage: 0 } },
    ],
    [
      "volTarget maxLeverage above 50",
      { ...minimal, sizing: { ...volTarget, maxLeverage: 51 } },
    ],
    [
      "volTarget targetPct 0",
      { ...minimal, sizing: { ...volTarget, targetPct: 0 } },
    ],
    [
      "volTarget targetPct above 100",
      { ...minimal, sizing: { ...volTarget, targetPct: 101 } },
    ],
    [
      "noiseBand length 0",
      {
        ...withIndicators,
        exit: {
          any: [{ left: close, op: "<", right: { ...upper, length: 0 } }],
        },
      },
    ],
    [
      "noiseBand length above 60",
      {
        ...withIndicators,
        exit: {
          any: [{ left: close, op: "<", right: { ...upper, length: 61 } }],
        },
      },
    ],
    [
      "noiseBand multiple 0",
      {
        ...withIndicators,
        exit: {
          any: [{ left: close, op: "<", right: { ...upper, multiple: 0 } }],
        },
      },
    ],
    [
      "noiseBand band",
      {
        ...withIndicators,
        exit: {
          any: [{ left: close, op: "<", right: { ...upper, band: "middle" } }],
        },
      },
    ],
    [
      "vwap with a length",
      {
        ...withIndicators,
        exit: {
          any: [{ left: close, op: "<", right: { ...vwap, length: 3 } }],
        },
      },
    ],
    [
      "sessionReturn from anchor",
      {
        ...withIndicators,
        exit: {
          any: [
            {
              left: close,
              op: "<",
              right: { ...sessionReturn, from: "close" },
            },
          ],
        },
      },
    ],
  ])("refuses an invalid %s", (_label, definition) => {
    expect(issuesOf(definition)).not.toEqual([]);
  });

  it("refuses the intraday block on a daily timeframe (STRATEGY_INTRADAY_DAILY_UNSUPPORTED)", () => {
    const definition = StrategyDefinitionSchema.parse({ ...minimal, intraday });
    for (const timeframe of STRATEGY_DAILY_TIMEFRAMES)
      expect(serverStrategyRefusal(definition, timeframe)).toBe(
        STRATEGY_INTRADAY_DAILY_REFUSAL
      );
    expect(STRATEGY_INTRADAY_DAILY_REFUSAL.code).toBe(
      STRATEGY_INTRADAY_DAILY_UNSUPPORTED
    );
    expect(
      STRATEGY_INTRADAY_DAILY_REFUSAL.message.startsWith(
        `${STRATEGY_INTRADAY_DAILY_UNSUPPORTED}: `
      )
    ).toBe(true);
    expect(serverStrategyRefusal(definition, "5m")).toBeUndefined();
    expect(serverStrategyRefusal(definition)).toBeUndefined();
  });
});
