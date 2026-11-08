import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AnalyticsEquityPoint } from "../../packages/api/src/backtest-analytics.ts";
import { fakeNautilus } from "./dsl-engine.test-support.ts";
import { NAUTILUS_ENGINE_ID, TYPESCRIPT_ENGINE_ID } from "./dsl-engine.ts";
import {
  type AdapterRun,
  adapterRun,
  applyGates,
  beatsBothHalves,
  benchmarkEquity,
  buildResults,
  combineSleeves,
  comparisonFlags,
  DOC_PATH,
  equityFromReturns,
  failureNote,
  fileInputs,
  type LibraryDoc,
  type LibraryStrategy,
  libraryDocSchema,
  loadLibrary,
  type Published,
  parsePriceCsv,
  primarySummary,
  RESEARCH_DIR,
  type RerunInputs,
  rerunStrategy,
  runDslSleeves,
  runQuantJourneyCli,
  type SeriesSummary,
  type StrategyResult,
  summarize,
  TRIALS,
} from "./quantjourney.ts";
import { num, pct, renderDoc, verdict } from "./quantjourney-render.ts";

const repoRoot = join(import.meta.dirname, "..", "..");
const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0))
    rmSync(dir, { force: true, recursive: true });
});
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "qj-test-"));
  temps.push(dir);
  return dir;
};

// ------------------------------------------------------------------ fixtures

const days = (count: number, start = Date.UTC(2020, 0, 1)): string[] =>
  Array.from({ length: count }, (_, i) =>
    new Date(start + i * 86_400_000).toISOString().slice(0, 10)
  );

// A rising-then-falling price path; adj_close is half of close (a 2:1 dividend adjustment).
const csv = (dates: readonly string[], slope = 1): string => {
  const lines = dates.map((date, i) => {
    const close = 100 + slope * 20 * Math.sin(i / 15) + i * 0.1 * slope;
    return `${date},${close},${close + 1},${close - 1},${close},${close / 2},1000`;
  });
  return `date,open,high,low,close,adj_close,volume\n${lines.join("\n")}\n`;
};

const point = (t: string, equity: number): AnalyticsEquityPoint => ({
  equity,
  t,
});

const series = (overrides: Partial<SeriesSummary> = {}): SeriesSummary => ({
  cagr: 0.1,
  end: "2010-01-01",
  excessKurtosis: 0,
  firstHalf: { cagr: 0.1, sharpe: 1 },
  maxDrawdown: -0.1,
  meanReturn: 0.001,
  periods: 2520,
  periodsPerYear: 252,
  secondHalf: { cagr: 0.1, sharpe: 1 },
  sharpe: 3,
  skew: 0,
  start: "2000-01-01",
  stdReturn: 0.005,
  totalReturn: 1,
  volatility: 0.08,
  ...overrides,
});

const result = (overrides: Partial<StrategyResult> = {}): StrategyResult => ({
  adapter: null,
  adapterVertexCost: null,
  benchmark: null,
  dsl: null,
  flags: [],
  gate: null,
  id: "W01",
  note: null,
  primary: null,
  status: "run",
  ...overrides,
});

const published = (overrides: Partial<Published> = {}): Published => ({
  benchmarkReturnPct: 100,
  beta: 0.2,
  cagrPct: 3,
  calmar: 0.2,
  maxDrawdownPct: -20,
  profitFactor: 1.5,
  profitFactorInfinite: false,
  sharpe: 0.3,
  sortino: 0.4,
  totalReturnPct: 100,
  trades: 10,
  volatilityPct: 10,
  winRatePct: 50,
  ...overrides,
});

const adapter = (qj: Partial<AdapterRun["qj"]> = {}): AdapterRun => ({
  qj: { maxDrawdown: -0.2, sharpe: 0.3, totalReturn: 1, ...qj },
  summary: series(),
});

const sma = (length: number) =>
  ({ length, name: "sma", source: "close", type: "indicator" }) as const;

const strategy = (
  overrides: Partial<LibraryStrategy> = {}
): LibraryStrategy => ({
  assetClass: "Equity ETFs",
  benchmark: "SPY",
  category: "weights",
  costs: "1 bp",
  dashboard: "https://backtester.quantjourney.cloud/strategies/x",
  dsl: null,
  file: "example_weights_01_x.py",
  github:
    "https://github.com/QuantJourneyOrg/quantjourney-bt/blob/main/strategies/x.py",
  granularity: "1d",
  id: "W01",
  mode: "weights",
  name: "Trend | test",
  orderType: null,
  period: { end: "2021-01-01", start: "2020-01-01" },
  published: published(),
  rebalance: "Daily",
  rerun: { reason: null, status: "run" },
  rules: "Hold while SMA 5 > SMA 10.",
  section: "QuantJourney weights",
  shortName: "Trend",
  slug: "quantjourney-w01-x",
  strategyType: null,
  styles: ["trend"],
  summary: "Trend",
  universe: ["AAA", "BBB"],
  ...overrides,
});

const dslDefinition: NonNullable<LibraryStrategy["dsl"]> = {
  entry: { all: [{ left: sma(5), op: ">", right: sma(10) }] },
  exit: { any: [{ left: sma(5), op: "<", right: sma(10) }] },
  name: "test",
  sizing: { mode: "allIn" },
  stopLoss: { kind: "none" },
  takeProfit: { kind: "none" },
  version: 1,
};

const library = (strategies: LibraryStrategy[]): LibraryDoc => ({
  count: strategies.length,
  source: {
    commit: "4f403d853833e1daa6de01c5b6c6cb3983dc0044",
    dashboards: "https://backtester.quantjourney.cloud/strategies",
    fetched: "2026-10-31",
    framing: "Not a leak.",
    license: "Apache-2.0",
    name: "QuantJourney",
    repository: "https://github.com/QuantJourneyOrg/quantjourney-bt",
    site: "https://quants.md",
    siteSnapshot: "snapshot.json",
    siteSnapshotSha256: "a".repeat(64),
  },
  strategies,
});

const adapterFile = (dates: readonly string[], drift: number) => ({
  index: dates.map((d) => `${d}T00:00:00+00:00`),
  qj_summary: { max_drawdown: -0.1, sharpe: 0.5, total_return: 0.4 },
  returns: dates.map((_, i) => (i === 0 ? null : drift + 0.01 * Math.sin(i))),
});

// ------------------------------------------------------------------ inventory

describe("QuantJourney inventory", () => {
  it("lists 50 unique strategies with valid slugs, links and DSL definitions", async () => {
    const doc = await loadLibrary(repoRoot);
    expect(doc.count).toBe(TRIALS);
    expect(doc.strategies).toHaveLength(TRIALS);
    expect(new Set(doc.strategies.map((s) => s.id)).size).toBe(TRIALS);
    expect(new Set(doc.strategies.map((s) => s.slug)).size).toBe(TRIALS);
    for (const s of doc.strategies) {
      expect(s.slug.startsWith(`quantjourney-${s.id.toLowerCase()}-`)).toBe(
        true
      );
      expect(s.github).toContain(`${doc.source.commit.slice(0, 0)}${s.file}`);
      expect(s.dashboard).toMatch(
        /^https:\/\/backtester\.quantjourney\.cloud\/strategies\//
      );
    }
    expect(
      doc.strategies.filter((s) => s.dsl !== null).map((s) => s.id)
    ).toEqual(["O01", "O02", "O06", "O12", "O13", "O18", "W01", "W03", "W09"]);
    return expect(
      doc.strategies
        .filter((s) => s.rerun.status === "no-data")
        .map((s) => s.id)
    ).toEqual(["O15", "O16", "W07", "W08"]);
  });

  it("keeps the generated doc in step with library.json and results.json", async () => {
    const out: string[] = [];
    const code = await runQuantJourneyCli(["--check"], {
      defaultPython: "python3",
      nautilus: fakeNautilus(),
      now: () => new Date(0),
      root: repoRoot,
      sha256: () => "",
      stderr: { write: (t: string) => out.push(t) },
      stdout: { write: (t: string) => out.push(t) },
    });
    expect(out.join("")).toBe("ok\n");
    return expect(code).toBe(0);
  });

  it("rejects an inventory entry with an invalid DSL definition", () => {
    const doc = library([strategy({ dsl: dslDefinition })]);
    expect(libraryDocSchema.safeParse(doc).success).toBe(true);
    const broken = {
      ...doc,
      strategies: [{ ...strategy(), dsl: { version: 2 } }],
    };
    return expect(libraryDocSchema.safeParse(broken).success).toBe(false);
  });
});

// ------------------------------------------------------------------ statistics

describe("price data and series statistics", () => {
  it("adjusts OHLC by adj_close / close and drops rows outside the period or without prices", () => {
    const text =
      "date,open,high,low,close,adj_close,volume\n" +
      "2019-12-31,10,11,9,10,5,1\n" +
      "2020-01-02,10,12,8,10,5,1\n" +
      "2020-01-03,0,12,8,10,5,1\n" +
      "2020-01-06T14:30:00+00:00,20,22,18,20,20,1\n" +
      "2021-01-01,10,11,9,10,5,1\n";
    const table = parsePriceCsv(text, "2020-01-01", "2021-01-01");
    expect(table.dates).toEqual(["2020-01-02", "2020-01-06T14:30:00+00:00"]);
    expect([...table.bars.o]).toEqual([5, 20]);
    expect([...table.bars.h]).toEqual([6, 22]);
    expect([...table.bars.c]).toEqual([5, 20]);
    return expect(table.adjClose).toEqual([5, 20]);
  });

  it("summarizes equity with halves and returns null for short series", () => {
    expect(summarize([point("2020-01-01", 1)])).toBeNull();
    const tiny = summarize([
      point("2020-01-01", 1),
      point("2020-06-01", 1.1),
      point("2021-01-01", 1.2),
    ]);
    expect(tiny?.firstHalf).toEqual({ cagr: 0, sharpe: null });
    const dates = days(400);
    const equity = equityFromReturns(
      dates,
      dates.map((_, i) => (i === 0 ? null : 0.001 + 0.01 * Math.sin(i)))
    );
    expect(equity[0]).toEqual(point(dates[0] ?? "", 1));
    const s = summarize(equity);
    expect(s?.periods).toBe(399);
    expect(s?.start).toBe(dates[0]);
    expect(s?.firstHalf.sharpe).not.toBeNull();
    return expect(s?.stdReturn).toBeGreaterThan(0);
  });

  it("builds benchmark equity on the strategy dates and combines sleeves", () => {
    const table = parsePriceCsv(csv(days(5)), "2000-01-01", "2100-01-01");
    expect(
      benchmarkEquity(table, "2020-01-02", "2020-01-04").map((p) => p.t)
    ).toEqual(["2020-01-02", "2020-01-03", "2020-01-04"]);
    return expect(
      combineSleeves([
        [point("2020-01-01", 1), point("2020-01-03", 2)],
        [point("2020-01-02", 1), point("2020-01-03", 1.5)],
      ])
    ).toEqual([
      point("2020-01-01", 1),
      point("2020-01-02", 1),
      point("2020-01-03", 1.75),
    ]);
  });

  it("runs a DSL definition per instrument sleeve", () => {
    const dates = days(200);
    const tables = new Map([
      ["AAA", parsePriceCsv(csv(dates), "2000-01-01", "2100-01-01")],
      ["BBB", parsePriceCsv(csv(dates, -1), "2000-01-01", "2100-01-01")],
    ]);
    expect(runDslSleeves(strategy(), tables, 10)).toBeNull();
    const equity = runDslSleeves(strategy({ dsl: dslDefinition }), tables, 10);
    expect(equity).toHaveLength(200);
    expect(equity?.[0]?.equity).toBe(1);
    return expect(() =>
      runDslSleeves(
        strategy({ dsl: dslDefinition, universe: ["ZZZ"] }),
        tables,
        10
      )
    ).toThrow("missing data for ZZZ");
  });
});

// ------------------------------------------------------------------ comparison and gates

describe("comparison flags and gates", () => {
  it("flags return, drawdown and Sharpe gaps against the published numbers", () => {
    expect(comparisonFlags(null, adapter())).toEqual([]);
    expect(comparisonFlags(published(), null)).toEqual([]);
    expect(comparisonFlags(published(), adapter())).toEqual([]);
    expect(
      comparisonFlags(
        published(),
        adapter({ maxDrawdown: -0.3, sharpe: 0.6, totalReturn: 2 })
      )
    ).toEqual(["total return", "max drawdown", "Sharpe"]);
    return expect(
      comparisonFlags(
        published({ sharpe: null }),
        adapter({ maxDrawdown: null, sharpe: null, totalReturn: null })
      )
    ).toEqual([]);
  });

  it("picks the primary series and compares both halves with the benchmark", () => {
    expect(primarySummary(result({ dsl: series(), primary: "dsl" }))).toEqual(
      series()
    );
    expect(primarySummary(result({ primary: "adapter" }))).toBeNull();
    expect(
      primarySummary(
        result({ adapterVertexCost: adapter(), primary: "adapter" })
      )
    ).toEqual(series());
    expect(primarySummary(result())).toBeNull();
    const weak = series({
      firstHalf: { cagr: 0.01, sharpe: 0.1 },
      secondHalf: { cagr: 0.01, sharpe: null },
    });
    expect(beatsBothHalves(series(), null)).toBe(false);
    expect(beatsBothHalves(series(), weak)).toBe(true);
    expect(beatsBothHalves(weak, series())).toBe(false);
    expect(
      beatsBothHalves(series({ firstHalf: { cagr: 0.2, sharpe: null } }), weak)
    ).toBe(false);
    return expect(
      beatsBothHalves(series({ secondHalf: { cagr: 0.001, sharpe: 2 } }), weak)
    ).toBe(false);
  });

  it("applies the deflated Sharpe and q-value gates across the trial ledger", () => {
    const weak = series({
      firstHalf: { cagr: 0, sharpe: 0 },
      secondHalf: { cagr: 0, sharpe: 0 },
    });
    const gated = applyGates(
      [
        result({ benchmark: weak, dsl: series(), id: "A", primary: "dsl" }),
        result({
          adapterVertexCost: {
            ...adapter(),
            summary: series({
              excessKurtosis: null,
              meanReturn: 0.0001,
              skew: null,
              stdReturn: 0.02,
            }),
          },
          benchmark: weak,
          id: "B",
          primary: "adapter",
        }),
        result({ id: "C", status: "no-data" }),
      ],
      3
    );
    expect(gated[0]?.gate?.pass).toBe(true);
    expect(gated[0]?.gate?.deflatedSharpeProbability).toBeGreaterThan(0.95);
    expect(gated[1]?.gate?.pass).toBe(false);
    expect(gated[2]?.gate).toBeNull();
    const alone = applyGates([
      result({ dsl: series({ stdReturn: 0 }), id: "D", primary: "dsl" }),
    ]);
    expect(alone[0]?.gate).toEqual({
      beatsBenchmarkBothHalves: false,
      deflatedSharpeProbability: null,
      pass: false,
      qValue: null,
    });
    const single = applyGates([
      result({ benchmark: weak, dsl: series(), id: "E", primary: "dsl" }),
    ]);
    expect(single[0]?.gate?.deflatedSharpeProbability).toBeNull();
    return expect(single[0]?.gate?.pass).toBe(false);
  });
});

// ------------------------------------------------------------------ re-run assembly

describe("re-run assembly", () => {
  const dates = days(300);
  const prices: RerunInputs["prices"] = (symbol, _granularity, start, end) =>
    parsePriceCsv(csv(dates, symbol === "BBB" ? -1 : 1), start, end);

  it("reads adapter files and explains a missing Vertex-cost run", () => {
    expect(adapterRun(undefined)).toBeNull();
    expect(
      adapterRun({ ...adapterFile(dates.slice(0, 1), 0), returns: [null] })
    ).toBeNull();
    expect(adapterRun(adapterFile(dates, 0.001))?.qj.sharpe).toBe(0.5);
    expect(failureNote({ error: "ValueError: NAV became non-positive" })).toBe(
      "The Vertex-cost run failed in the QuantJourney engine: ValueError: NAV became non-positive."
    );
    return expect(failureNote(undefined)).toBe(
      "The adapter did not produce a usable Vertex-cost run."
    );
  });

  it("re-runs DSL, adapter-only, hourly, missing and no-data strategies", () => {
    const files: Record<string, unknown> = {
      W01: adapterFile(dates, 0.001),
      "W01.cost10": adapterFile(dates, 0.0005),
      W02: adapterFile(dates, 0.002),
      "W02.cost10": adapterFile(dates, 0.001),
      "W09.cost10": adapterFile(dates, 0.001),
      "W10.cost10": { error: "boom" },
      W22: adapterFile(dates, 0.001),
      "W22.cost10": { error: "NAV became non-positive" },
    };
    const inputs: RerunInputs = {
      adapterFile: (id, suffix) => files[`${id}${suffix}`],
      prices,
    };
    const dsl = rerunStrategy(strategy({ dsl: dslDefinition }), inputs);
    expect(dsl.primary).toBe("dsl");
    expect(dsl.benchmark?.periods).toBeGreaterThan(100);
    expect(dsl.flags).toEqual(["total return", "max drawdown", "Sharpe"]);
    const plain = rerunStrategy(
      strategy({ id: "W02", published: null }),
      inputs
    );
    expect(plain.primary).toBe("adapter");
    expect(plain.flags).toEqual([]);
    const hourly = rerunStrategy(
      strategy({ granularity: "1h", id: "W09" }),
      inputs
    );
    expect(hourly.adapter).toBeNull();
    expect(hourly.primary).toBe("adapter");
    const failed = rerunStrategy(strategy({ id: "W10" }), inputs);
    expect(failed).toMatchObject({
      benchmark: null,
      primary: null,
      status: "error",
    });
    expect(failed.note).toContain("boom");
    expect(rerunStrategy(strategy({ id: "W22" }), inputs)).toMatchObject({
      gate: null,
      primary: null,
      status: "run",
    });
    return expect(
      rerunStrategy(
        strategy({
          id: "O15",
          rerun: { reason: "no bars", status: "no-data" },
        }),
        inputs
      )
    ).toMatchObject({ note: "no bars", status: "no-data" });
  });

  it("reads data and run files from folders", async () => {
    const data = tempDir();
    const runs = tempDir();
    mkdirSync(join(data, "daily"));
    mkdirSync(join(data, "hourly"));
    writeFileSync(join(data, "daily", "AAA.csv"), csv(dates));
    writeFileSync(join(data, "daily", "SPY.csv"), csv(dates));
    writeFileSync(join(data, "hourly", "HHH.csv"), csv(dates));
    writeFileSync(
      join(runs, "W01.cost10.json"),
      JSON.stringify(adapterFile(dates, 0.001))
    );
    writeFileSync(
      join(runs, "W01.json"),
      JSON.stringify(adapterFile(dates, 0.001))
    );
    const doc = library([
      strategy({ universe: ["AAA"] }),
      strategy({ granularity: "1h", id: "W09", universe: ["HHH"] }),
      strategy({ id: "W10", universe: ["BBB"] }),
    ]);
    const inputs = await fileInputs(doc, data, runs);
    expect(adapterRun(inputs.adapterFile("W01", ""))).not.toBeNull();
    expect(inputs.adapterFile("W09", "")).toBeUndefined();
    expect(
      inputs.prices("HHH", "1h", "2000-01-01", "2100-01-01").dates
    ).toHaveLength(300);
    expect(() =>
      inputs.prices("BBB", "1d", "2000-01-01", "2100-01-01")
    ).toThrow("missing data for BBB");
    const built = buildResults(doc, inputs, {
      generated: "2026-10-31",
      manifestSha256: "m",
      source: "s",
    });
    expect(built.trials).toBe(TRIALS);
    return expect(built.strategies.map((s) => s.status)).toEqual([
      "run",
      "error",
      "error",
    ]);
  });
});

// ------------------------------------------------------------------ CLI and rendering

describe("CLI and rendering", () => {
  let nautilus = fakeNautilus();
  afterEach(() => {
    nautilus = fakeNautilus();
  });
  const io = (root: string, out: string[]) => ({
    defaultPython: "venv-python",
    nautilus,
    now: () => new Date("2026-10-31T12:00:00Z"),
    root,
    sha256: (text: string) => `sha:${text.length}`,
    stderr: { write: (t: string) => out.push(t) },
    stdout: { write: (t: string) => out.push(t) },
  });

  it("validates arguments, re-runs, writes and checks the doc", async () => {
    const root = tempDir();
    const data = tempDir();
    const runs = tempDir();
    mkdirSync(join(root, RESEARCH_DIR), { recursive: true });
    mkdirSync(join(root, "docs", "vertex-rebuild"), { recursive: true });
    mkdirSync(join(data, "daily"));
    const dates = days(300);
    for (const symbol of ["AAA", "SPY"]) {
      writeFileSync(join(data, "daily", `${symbol}.csv`), csv(dates));
    }
    writeFileSync(join(data, "manifest.json"), "{}");
    writeFileSync(
      join(runs, "W01.cost10.json"),
      JSON.stringify(adapterFile(dates, 0.001))
    );
    writeFileSync(
      join(root, RESEARCH_DIR, "library.json"),
      JSON.stringify(
        library([strategy({ dsl: dslDefinition, universe: ["AAA"] })])
      )
    );
    const out: string[] = [];
    expect(await runQuantJourneyCli(["--bogus"], io(root, out))).toBe(2);
    expect(await runQuantJourneyCli(["--rerun", "--data"], io(root, out))).toBe(
      2
    );
    expect(await runQuantJourneyCli(["--check"], io(root, out))).toBe(1);
    expect(await runQuantJourneyCli([], io(root, out))).toBe(0);
    const pending = await readFile(join(root, DOC_PATH), "utf8");
    expect(pending).toContain("- Re-run: pending.");
    expect(
      await runQuantJourneyCli(
        ["--rerun", "--data", data, "--runs", runs],
        io(root, out)
      )
    ).toBe(0);
    const results = JSON.parse(
      await readFile(join(root, RESEARCH_DIR, "results.json"), "utf8")
    );
    expect(results).toMatchObject({
      data: { manifestSha256: "sha:2" },
      engine: NAUTILUS_ENGINE_ID,
      engineParity: { against: TYPESCRIPT_ENGINE_ID, jobs: 1, pass: 1 },
      generated: "2026-10-31",
    });
    expect(nautilus.calls.map((call) => call.python)).toEqual(["venv-python"]);
    expect(await runQuantJourneyCli(["--check"], io(root, out))).toBe(0);
    expect(await readFile(join(root, DOC_PATH), "utf8")).toContain(
      `- Vertex re-run engine: \`${NAUTILUS_ENGINE_ID}\` (each job also run on \`${TYPESCRIPT_ENGINE_ID}\`: 1 of 1`
    );
    expect(out.join("")).toContain(
      "out of date: docs/vertex-rebuild/quantjourney-library.md"
    );
    // --engine typescript runs no batch; a Nautilus result outside the tolerance writes nothing.
    const rerun = ["--rerun", "--data", data, "--runs", runs];
    expect(
      await runQuantJourneyCli(
        [...rerun, "--engine", "typescript"],
        io(root, out)
      )
    ).toBe(0);
    expect(nautilus.calls).toHaveLength(1);
    const typescript = JSON.parse(
      await readFile(join(root, RESEARCH_DIR, "results.json"), "utf8")
    );
    expect(typescript).toMatchObject({
      engine: TYPESCRIPT_ENGINE_ID,
      engineParity: null,
    });
    expect(typescript.strategies).toEqual(results.strategies);
    expect(
      await runQuantJourneyCli([...rerun, "--engine", "qj"], io(root, out))
    ).toBe(2);
    expect(
      await runQuantJourneyCli([...rerun, "--runs", runs], io(root, out))
    ).toBe(2);
    expect(out.join("")).toContain("repeated argument: --runs");
    expect(
      await runQuantJourneyCli(["--engine", "typescript"], io(root, out))
    ).toBe(2);
    expect(
      await runQuantJourneyCli([...rerun, "--python", "missing"], io(root, out))
    ).toBe(1);
    expect(out.join("")).toContain(
      "nautilus batch failed (spawnSync missing ENOENT)"
    );
    nautilus = fakeNautilus({ scale: 1.01 });
    expect(await runQuantJourneyCli(rerun, io(root, out))).toBe(1);
    expect(out.join("")).toContain(
      "Nautilus differs from instant-2 on 1 of 1 jobs"
    );
    return expect(
      JSON.parse(
        await readFile(join(root, RESEARCH_DIR, "results.json"), "utf8")
      )
    ).toMatchObject({ engine: TYPESCRIPT_ENGINE_ID });
  });

  it("renders every verdict and empty cell", () => {
    expect(pct(null)).toBe("—");
    expect(pct(undefined)).toBe("—");
    expect(num(undefined)).toBe("—");
    expect(num(1.234_56, 3)).toBe("1.235");
    expect(verdict(undefined)).toBe("pending");
    expect(verdict(result({ status: "no-data" }))).toBe("not run: no data");
    expect(verdict(result({ status: "error" }))).toBe("fail: no usable run");
    const gate = {
      beatsBenchmarkBothHalves: true,
      deflatedSharpeProbability: 0.99,
      pass: true,
      qValue: 0.01,
    };
    expect(verdict(result({ gate }))).toBe("pass");
    expect(verdict(result({ gate: { ...gate, pass: false } }))).toBe("fail");
    expect(verdict(result({ gate: null }))).toBe(
      "fail: Vertex-cost run failed"
    );
    const closed = { ...gate, pass: false };
    const doc = library([
      strategy(),
      strategy({
        dsl: dslDefinition,
        id: "O01",
        orderType: "Market",
        published: null,
        rebalance: null,
      }),
      strategy({
        id: "WF01",
        orderType: null,
        rebalance: null,
        rerun: { reason: "x", status: "no-data" },
      }),
      ...["W11", "W12", "W13", "W14"].map((id) => strategy({ id })),
      strategy({ granularity: "1h", id: "W15" }),
    ]);
    const text = renderDoc(doc, {
      data: { manifestSha256: "m", source: "s" },
      generated: "2026-10-31",
      strategies: [
        result({
          adapter: adapter(),
          adapterVertexCost: adapter(),
          flags: ["Sharpe"],
          gate,
          primary: "adapter",
        }),
        result({
          benchmark: series(),
          dsl: series(),
          gate: { ...gate, beatsBenchmarkBothHalves: false, pass: false },
          id: "O01",
          primary: "dsl",
        }),
        result({ id: "ZZ", status: "no-data" }),
        result({
          gate: { ...gate, deflatedSharpeProbability: null, pass: false },
          id: "XX",
        }),
        result({
          gate: { ...gate, deflatedSharpeProbability: 0.5, pass: false },
          id: "YY",
        }),
        result({
          gate: { ...closed, deflatedSharpeProbability: null },
          id: "W11",
        }),
        result({
          gate: { ...closed, deflatedSharpeProbability: 0.5 },
          id: "W12",
        }),
        result({
          dsl: series({ sharpe: null }),
          gate: closed,
          id: "W13",
          primary: "dsl",
        }),
        result({
          dsl: series({ sharpe: -1 }),
          gate: closed,
          id: "W14",
          primary: "dsl",
        }),
        result({ dsl: series(), gate: closed, id: "W15", primary: "dsl" }),
      ],
      trials: 3,
      vertexCostBps: 10,
    });
    expect(text).toContain("|W01|Trend \\| test|");
    expect(text).toContain(
      "|O01|Trend \\| test|orders".replace("orders", "weights")
    );
    expect(text).toContain("Market");
    expect(text).toContain("no portfolio metrics (workflow)");
    expect(text).toContain("|WF01|");
    expect(text).toContain("no: intraday data");
    expect(text).toContain(
      "Highest deflated Sharpe probability among daily re-runs with a positive Sharpe: W01 Trend \\| test (0.990; Sharpe 3.00; 10.0 years); O01 Trend \\| test (0.990; Sharpe 3.00; 10.0 years)."
    );
    expect(text).toContain(
      "- Identical re-run series: W01 = O01 = W15. Each still counts as one of the 3 trials"
    );
    expect(
      renderDoc(library([strategy()]), {
        data: { manifestSha256: "m", source: "s" },
        generated: "2026-10-31",
        strategies: [result({ dsl: series(), gate, primary: "dsl" })],
        trials: 1,
        vertexCostBps: 10,
      })
    ).not.toContain("Identical re-run series");
    expect(text).toContain("|ZZ|—|—|—|—|—|—|not run: no data|");
    expect(text).toContain("|WF01|100.0% / 0.30 / -20.0%|—|—|—|—|");
    return expect(text).toContain(
      "Gates (3 trials, Vertex cost 10 bp per side): 1 pass."
    );
  });
});
