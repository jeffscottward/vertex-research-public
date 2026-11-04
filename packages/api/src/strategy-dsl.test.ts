import { describe, expect, it } from "vitest";

import {
  parseStrategyDefinitionText,
  STRATEGY_TEMPLATES,
  StrategyDefinitionSchema,
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
    ["no entry conditions", { ...minimal, entry: { all: [] } }, "entry.all"],
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
