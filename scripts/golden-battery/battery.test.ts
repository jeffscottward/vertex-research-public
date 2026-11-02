import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  type InstantTrade,
  runInstantBacktest,
} from "../../packages/api/src/instant-backtest-engine.ts";
import {
  buildGoldenResults,
  checkpointParity,
  compareTrades,
  firstFiniteBar,
  FIXTURE_HEADER,
  type GoldenBatteryIo,
  type GoldenInputs,
  type GoldenReference,
  type GoldenResults,
  loadGoldenInputs,
  parseFixtureCsv,
  RESULTS_PATH,
  renderSummary,
  runGoldenBatteryCli,
  runGoldenCase,
  SUMMARY_PATH,
  TOLERANCE,
  withinTolerance,
} from "./battery.ts";

type ReferenceCase = GoldenReference["cases"][number];

const repoRoot = join(import.meta.dirname, "..", "..");
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

// adj_close equals close, so the bars are not rescaled.
// SMA(1)/SMA(2): fast moves above slow on bar 2 (fill at the bar 3 open 11.5) and falls to or
// below it on bar 4 (fill at the bar 5 open 10.5).
const CSV = [
  FIXTURE_HEADER,
  "2020-01-01,10,10,10,10,10,100",
  "2020-01-02,10,10,9,9,9,100",
  "2020-01-03,9,11,9,11,11,100",
  "2020-01-06,11.5,12,11.5,12,12,100",
  "2020-01-07,12,12,10,10,10,100",
  "2020-01-08,10.5,13,10.5,13,13,100",
].join("\n");

const SMA_RULE = { kind: "smaCross", fast: 1, slow: 2 } as const;

const INDICATOR_NAMES = [
  "sma_20",
  "sma_50",
  "rsi_14",
  "ema_20",
  "smma_20",
  "lwma_20",
  "atr_14",
  "bollinger_upper",
  "bollinger_middle",
  "bollinger_lower",
  "sar",
  "macd",
  "macd_signal",
  "macd_histogram",
  "stoch_k",
  "stoch_d",
  "plus_di",
  "minus_di",
  "adx",
];

/** A reference case equal to the engine output, for testing the comparison logic only. */
const engineCase = (
  csv: string,
  rule: ReferenceCase["rule"] = SMA_RULE
): ReferenceCase => {
  const run = runInstantBacktest(parseFixtureCsv(csv), {
    rule,
    stopLossPct: 0,
    takeProfitPct: 0,
    costBps: 0,
  });
  const cagr = run.stats.cagr;
  if (cagr === null) throw new Error("test bars need a CAGR");
  return {
    id: "AAA-test",
    symbol: "AAA",
    rule,
    costBps: 0,
    trades: run.trades.map((trade) => ({
      entryIndex: trade.entryIndex,
      entryPrice: trade.entryPrice,
      exitIndex: trade.exitIndex,
      exitPrice: trade.exitPrice,
      exitReason: trade.exitReason,
      netReturn: trade.netReturn,
      pnl: trade.pnl,
    })),
    stats: {
      ...run.stats,
      cagr,
      finalEquity: run.equity.at(-1) as number,
    },
  };
};

const inputs = (
  reference: Partial<GoldenReference> = {},
  csv = CSV
): GoldenInputs => {
  const digest = sha(csv);
  return {
    manifest: {
      provider: "test provider",
      fetchedAt: "2026-01-01T00:00:00Z",
      generator: "test",
      range: { start: "2020-01-01", end: "2020-01-08" },
      fields: { date: "trading date" },
      adjustment: "none",
      delay: "end of day",
      license: "test only",
      files: {
        AAA: {
          file: "AAA-1d.csv",
          sha256: digest,
          downloadSha256: digest,
          rows: 6,
          first: "2020-01-01",
          last: "2020-01-08",
        },
      },
    },
    reference: {
      generator: "gen",
      backtestReference: "pandas",
      indicatorReference: "talib",
      fixtures: { AAA: digest },
      cases: [engineCase(csv)],
      indicatorCheckpoints: {
        AAA: {
          indexes: [0, 5],
          dates: ["2020-01-01", "2020-01-08"],
          firstDefined: Object.fromEntries(
            INDICATOR_NAMES.map((name) => [name, 1])
          ),
          values: Object.fromEntries(
            INDICATOR_NAMES.map((name) => [name, [null, null]])
          ),
        },
      },
      pythonLibraryParity: {
        AAA: {
          sma_20: {
            comparedBars: 5,
            missingBars: 0,
            maxAbsDiff: 1,
            maxRelDiff: 1e-12,
          },
          ema_20: {
            comparedBars: 0,
            missingBars: 0,
            maxAbsDiff: 0,
            maxRelDiff: 0,
          },
        },
      },
      ...reference,
    },
    fixtures: { AAA: { text: csv, sha256: digest } },
  };
};

describe("parseFixtureCsv", () => {
  it("scales open, high, low and close by adj_close/close", () => {
    const bars = parseFixtureCsv(
      `${FIXTURE_HEADER}\n2020-01-02,20,22,18,20,10,5\n`
    );
    expect(Array.from(bars.t)).toEqual([Date.UTC(2020, 0, 2)]);
    expect([bars.o[0], bars.h[0], bars.l[0], bars.c[0]]).toEqual([
      10, 11, 9, 10,
    ]);
  });

  it("rejects a wrong header", () => {
    expect(() => parseFixtureCsv("t,o,h,l,c\n")).toThrow(
      "fixture must start with the header"
    );
  });

  it.each([
    "2020-01-02,1,1,1,1,1",
    "2020-01-02,1,1,1,x,1,1",
    "2020-01-02,1,1,1,0,1,1",
    "not-a-date,1,1,1,1,1,1",
  ])("rejects the bar %s", (line) => {
    expect(() => parseFixtureCsv(`${FIXTURE_HEADER}\n${line}`)).toThrow(
      "fixture line 2 is not a valid bar"
    );
  });
});

describe("withinTolerance", () => {
  it("scales the tolerance with values above 1 and keeps it absolute below 1", () => {
    expect(withinTolerance(1000, 1000 + 1000 * TOLERANCE * 0.5)).toBe(true);
    expect(withinTolerance(0, TOLERANCE * 2)).toBe(false);
  });

  it("needs both sides null or both numbers", () => {
    expect(withinTolerance(null, null)).toBe(true);
    expect(withinTolerance(null, 1)).toBe(false);
    expect(withinTolerance(1, null)).toBe(false);
  });
});

describe("compareTrades", () => {
  const reference = engineCase(CSV).trades;
  const trade = reference[0] as ReferenceCase["trades"][number];
  // Reference trades carry no position size; Vertex trades do. compareTrades ignores units.
  const asVertex = (
    trades: readonly ReferenceCase["trades"][number][]
  ): InstantTrade[] => trades.map((item) => ({ ...item, units: 1 }));

  it("passes identical trades", () => {
    expect(compareTrades(asVertex(reference), reference)).toEqual({
      vertexCount: 1,
      referenceCount: 1,
      sameBarsAndReasons: true,
      maxPriceDiff: 0,
      maxPnlDiff: 0,
      pass: true,
    });
  });

  it("fails a missing trade", () => {
    expect(compareTrades([], reference)).toMatchObject({
      vertexCount: 0,
      referenceCount: 1,
      sameBarsAndReasons: false,
      pass: false,
    });
  });

  it("fails an extra Vertex trade", () => {
    expect(
      compareTrades(asVertex([...reference, trade]), reference)
    ).toMatchObject({
      vertexCount: 2,
      referenceCount: 1,
      sameBarsAndReasons: false,
      pass: false,
    });
  });

  it("fails a trade that exits on another bar or for another reason", () => {
    expect(
      compareTrades(asVertex([{ ...trade, exitIndex: 4 }]), reference).pass
    ).toBe(false);
    expect(
      compareTrades(asVertex([{ ...trade, exitReason: "end" }]), reference).pass
    ).toBe(false);
  });

  it("fails prices or P&L outside the tolerance and reports the difference", () => {
    const moved = compareTrades(
      asVertex([{ ...trade, exitPrice: trade.exitPrice + 0.01 }]),
      reference
    );
    expect(moved.pass).toBe(false);
    expect(moved.maxPriceDiff).toBeCloseTo(0.01);
    const pnl = compareTrades(
      asVertex([{ ...trade, pnl: trade.pnl + 1e-6 }]),
      reference
    );
    expect(pnl.pass).toBe(false);
    expect(pnl.maxPnlDiff).toBeCloseTo(1e-6);
  });
});

describe("runGoldenCase", () => {
  const bars = parseFixtureCsv(CSV);

  it("passes when the engine matches the reference, by hand", () => {
    const reference = engineCase(CSV);
    expect(reference.trades).toEqual([
      {
        entryIndex: 3,
        exitIndex: 5,
        entryPrice: 11.5,
        exitPrice: 10.5,
        netReturn: 10.5 / 11.5 - 1,
        pnl: 10.5 / 11.5 - 1,
        exitReason: "signal",
      },
    ]);
    const result = runGoldenCase(bars, reference);
    expect(result.pass).toBe(true);
    expect(
      result.metrics.find((metric) => metric.name === "finalEquity")
    ).toEqual({
      name: "finalEquity",
      vertex: 10.5 / 11.5,
      reference: 10.5 / 11.5,
      absDiff: 0,
      pass: true,
    });
  });

  it("fails on a metric difference, a bar count difference or a trade difference", () => {
    const reference = engineCase(CSV);
    expect(
      runGoldenCase(bars, {
        ...reference,
        stats: { ...reference.stats, maxDrawdown: -0.5 },
      }).pass
    ).toBe(false);
    expect(
      runGoldenCase(bars, {
        ...reference,
        stats: { ...reference.stats, bars: 7 },
      }).pass
    ).toBe(false);
    expect(runGoldenCase(bars, { ...reference, trades: [] }).pass).toBe(false);
  });

  it("compares null ratios when no trade happens", () => {
    // RSI(2) never leaves 30..70 on this series, so the account stays flat.
    const flat = [
      FIXTURE_HEADER,
      "2020-01-01,10,10,10,10,10,1",
      "2020-01-02,10,11,10,11,11,1",
      "2020-01-03,11,11,10,10,10,1",
      "2020-01-06,10,11,10,11,11,1",
      "2020-01-07,11,11,10,10,10,1",
    ].join("\n");
    const rule = {
      kind: "rsiReversion",
      period: 2,
      oversold: 30,
      overbought: 70,
    } as const;
    const result = runGoldenCase(parseFixtureCsv(flat), engineCase(flat, rule));
    expect(result.pass).toBe(true);
    expect(
      result.metrics.find((metric) => metric.name === "sharpe")
    ).toMatchObject({ vertex: null, reference: null, absDiff: null });
    expect(
      runGoldenCase(parseFixtureCsv(flat), {
        ...engineCase(flat, rule),
        stats: { ...engineCase(flat, rule).stats, sharpe: 1 },
      }).pass
    ).toBe(false);
  });
});

describe("checkpointParity", () => {
  it("compares only the bars the reference defines", () => {
    expect(
      checkpointParity(Float64Array.of(1, 2, 3, 4), [null, 2, 4], [0, 1, 3])
    ).toEqual({ comparedBars: 2, missingBars: 0, maxAbsDiff: 0, pass: true });
  });

  it("counts a missing, NaN or out-of-range value as missing", () => {
    expect(
      checkpointParity([null, Number.NaN, 3], [1, 2, 3, 4], [0, 1, 2, 9])
    ).toEqual({ comparedBars: 1, missingBars: 3, maxAbsDiff: 0, pass: false });
  });

  it("fails a value outside the tolerance and a series with nothing to compare", () => {
    expect(checkpointParity([1, 2.5], [1, 2], [0, 1])).toEqual({
      comparedBars: 2,
      missingBars: 0,
      maxAbsDiff: 0.5,
      pass: false,
    });
    expect(checkpointParity([1, 2], [], [0, 1]).pass).toBe(false);
  });
});

describe("firstFiniteBar", () => {
  it("skips null and NaN warmup values", () => {
    expect(firstFiniteBar([null, Number.NaN, 3])).toBe(2);
    expect(firstFiniteBar(Float64Array.of(Number.NaN))).toBeNull();
  });
});

describe("buildGoldenResults", () => {
  it("builds failing results when no indicator checkpoint is defined", () => {
    const results = buildGoldenResults(inputs());
    expect(results.summary).toEqual({
      cases: 1,
      casesPassed: 1,
      indicatorChecks: 23,
      indicatorChecksPassed: 1,
    });
    expect(results.pass).toBe(false);
    expect(results.dataSource.files["AAA"]).toEqual({
      path: "tests/fixtures/golden/AAA-1d.csv",
      sha256: sha(CSV),
      rows: 6,
      first: "2020-01-01",
      last: "2020-01-08",
    });
    expect(
      results.indicators.filter((check) => check.layer === "python")
    ).toEqual([
      expect.objectContaining({ indicator: "sma_20", pass: true }),
      expect.objectContaining({ indicator: "ema_20", pass: false }),
    ]);
  });

  it("accepts a symbol without Python parity records", () => {
    const results = buildGoldenResults(inputs({ pythonLibraryParity: {} }));
    expect(results.indicators.some((check) => check.layer === "python")).toBe(
      false
    );
  });

  it("rejects a fixture that does not match the manifest or the reference", () => {
    const base = inputs();
    expect(() =>
      buildGoldenResults({
        ...base,
        fixtures: { AAA: { text: CSV, sha256: "0".repeat(64) } },
      })
    ).toThrow("AAA fixture does not match");
    expect(() => buildGoldenResults({ ...base, fixtures: {} })).toThrow(
      "AAA fixture does not match"
    );
    expect(() =>
      buildGoldenResults({
        ...base,
        manifest: { ...base.manifest, files: {} },
      })
    ).toThrow("AAA fixture does not match");
  });

  it("rejects a case for an unknown symbol and missing checkpoints", () => {
    const base = inputs();
    expect(() =>
      buildGoldenResults(
        inputs({ cases: [{ ...engineCase(CSV), symbol: "BBB" }] })
      )
    ).toThrow("no fixture for BBB");
    expect(() =>
      buildGoldenResults(inputs({ indicatorCheckpoints: {} }))
    ).toThrow("reference has no indicator checkpoints for AAA");
    const checkpoints = base.reference.indicatorCheckpoints["AAA"];
    expect(() =>
      buildGoldenResults(
        inputs({
          indicatorCheckpoints: {
            AAA: {
              indexes: checkpoints?.indexes ?? [],
              dates: checkpoints?.dates ?? [],
              firstDefined: checkpoints?.firstDefined ?? {},
              values: {},
            },
          },
        })
      )
    ).toThrow("reference has no checkpoints for sma_20");
  });
});

describe("renderSummary", () => {
  it("marks failures and prints n/a for undefined ratios", () => {
    const results = buildGoldenResults(inputs());
    const caseResult = results.cases[0];
    if (caseResult === undefined) throw new Error("expected one case");
    const text = renderSummary({
      ...results,
      cases: [
        {
          ...caseResult,
          pass: false,
          metrics: caseResult.metrics.map((metric) =>
            metric.name === "sharpe" || metric.name === "winRate"
              ? { ...metric, vertex: null, absDiff: null }
              : metric
          ),
        },
      ],
    });
    expect(text).toContain("Overall: **FAIL**");
    expect(text).toContain("|AAA-test|1/1|0.9130|");
    expect(text).toContain("|n/a|");
    expect(text).toContain("|FAIL|");
  });

  it("rejects a case without a required metric", () => {
    const results = buildGoldenResults(inputs());
    const caseResult = results.cases[0];
    if (caseResult === undefined) throw new Error("expected one case");
    expect(() =>
      renderSummary({ ...results, cases: [{ ...caseResult, metrics: [] }] })
    ).toThrow("case AAA-test lacks finalEquity");
  });
});

const memoryIo = (files: Record<string, string>) => {
  const written: Record<string, string> = {};
  const output: string[] = [];
  const errors: string[] = [];
  const io: GoldenBatteryIo = {
    root: "/repo",
    readText: (path) => {
      const text = written[path] ?? files[path];
      if (text === undefined) throw new Error(`no file ${path}`);
      return text;
    },
    writeText: (path, text) => {
      written[path] = text;
    },
    stdout: { write: (text: string) => output.push(text) },
    stderr: { write: (text: string) => errors.push(text) },
  };
  return { errors, io, output, written };
};

describe("runGoldenBatteryCli", () => {
  const base = inputs();
  const files = {
    "/repo/tests/fixtures/golden/manifest.json": JSON.stringify(base.manifest),
    "/repo/tests/fixtures/golden/golden-reference.json": JSON.stringify(
      base.reference
    ),
    "/repo/tests/fixtures/golden/AAA-1d.csv": CSV,
  };

  it("prints usage for an unknown mode", () => {
    const { errors, io } = memoryIo(files);
    expect(runGoldenBatteryCli(["run"], io)).toBe(2);
    expect(errors.join("")).toContain("usage:");
  });

  it("writes both outputs, reports failing checks and then finds them fresh", () => {
    const { errors, io, output, written } = memoryIo(files);
    expect(runGoldenBatteryCli(["write"], io)).toBe(1);
    expect(Object.keys(written).sort()).toEqual([
      `/repo/${RESULTS_PATH}`,
      `/repo/${SUMMARY_PATH}`,
    ]);
    expect(output.join("")).toContain("golden battery FAIL: 1/1 cases");
    // check fails because the indicator checks fail; the outputs are fresh.
    expect(runGoldenBatteryCli(["check"], io)).toBe(1);
    expect(errors).toEqual([]);
  });

  it("reports stale outputs", () => {
    const { errors, io } = memoryIo({
      ...files,
      [`/repo/${RESULTS_PATH}`]: "{}",
      [`/repo/${SUMMARY_PATH}`]: "",
    });
    expect(runGoldenBatteryCli(["check"], io)).toBe(1);
    expect(errors.join("")).toContain("is stale");
  });

  it("reports a stale summary when the results are fresh", () => {
    const first = memoryIo(files);
    runGoldenBatteryCli(["write"], first.io);
    const { errors, io } = memoryIo({
      ...files,
      [`/repo/${RESULTS_PATH}`]: first.written[`/repo/${RESULTS_PATH}`] ?? "",
      [`/repo/${SUMMARY_PATH}`]: "old",
    });
    expect(runGoldenBatteryCli(["check"], io)).toBe(1);
    expect(errors.join("")).toContain("is stale");
  });
});

describe("golden battery on the frozen SPY and QQQ fixtures", () => {
  const io: GoldenBatteryIo = {
    root: repoRoot,
    stdout: { write: () => true },
    stderr: { write: (text: string) => process.stderr.write(text) },
  };
  const results: GoldenResults = buildGoldenResults(loadGoldenInputs(io));

  it("matches the pandas reference on every case within the tolerance", () => {
    expect(results.cases.map((item) => item.id)).toEqual([
      "SPY-sma-20-50-0bps",
      "SPY-sma-20-50-5bps",
      "SPY-rsi-14-30-70-0bps",
      "SPY-rsi-14-30-70-5bps",
      "QQQ-sma-20-50-0bps",
      "QQQ-sma-20-50-5bps",
      "QQQ-rsi-14-30-70-0bps",
      "QQQ-rsi-14-30-70-5bps",
    ]);
    for (const item of results.cases) {
      expect(item.trades, item.id).toMatchObject({
        sameBarsAndReasons: true,
        pass: true,
      });
      expect(item.trades.vertexCount, item.id).toBeGreaterThan(5);
      expect(
        item.metrics.filter((metric) => !metric.pass),
        item.id
      ).toEqual([]);
    }
  });

  it("matches the indicator references in every layer", () => {
    expect(results.indicators.filter((check) => !check.pass)).toEqual([]);
    expect(results.summary.indicatorChecks).toBe(80);
    expect(results.pass).toBe(true);
  });

  it("fails an indicator that starts on another bar than the reference", () => {
    const loaded = loadGoldenInputs(io);
    const spy = loaded.reference.indicatorCheckpoints["SPY"];
    if (spy === undefined) throw new Error("expected SPY checkpoints");
    const shifted = buildGoldenResults({
      ...loaded,
      reference: {
        ...loaded.reference,
        indicatorCheckpoints: {
          ...loaded.reference.indicatorCheckpoints,
          SPY: { ...spy, firstDefined: { ...spy.firstDefined, sma_20: 18 } },
        },
      },
    });
    expect(
      shifted.indicators
        .filter((check) => !check.pass)
        .map((check) => `${check.layer}:${check.symbol}:${check.indicator}`)
    ).toEqual(["engine:SPY:sma_20", "chart:SPY:sma_20"]);
  });

  it("keeps the committed results.json and summary.md current", () => {
    expect(runGoldenBatteryCli(["check"], io)).toBe(0);
  });

  it("writes fresh outputs to the file system in write mode", () => {
    const temporary = mkdtempSync(join(tmpdir(), "golden-battery-"));
    try {
      cpSync(
        join(repoRoot, "tests/fixtures/golden"),
        join(temporary, "tests/fixtures/golden"),
        { recursive: true }
      );
      const target = { ...io, root: temporary };
      expect(runGoldenBatteryCli(["write"], target)).toBe(0);
      expect(readFileSync(join(temporary, SUMMARY_PATH), "utf8")).toBe(
        readFileSync(join(repoRoot, SUMMARY_PATH), "utf8")
      );
      expect(runGoldenBatteryCli(["check"], target)).toBe(0);
    } finally {
      rmSync(temporary, { force: true, recursive: true });
    }
  });
});
