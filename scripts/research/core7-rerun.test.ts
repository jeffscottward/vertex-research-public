import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ADAPTER_REASON,
  buildCore7Results,
  buyAndHoldEquity,
  CORE7_COST_BPS,
  CORE7_DIR,
  combinedRun,
  compact,
  core7Symbols,
  core7Table,
  type DataFile,
  dslEquity,
  HOURLY_REASON,
  importableRows,
  manifestDataFile,
  RESULTS_PATH,
  rebased,
  rerunOnCore7,
  runCore7RerunCli,
} from "./core7-rerun.ts";
import { fakeNautilus } from "./dsl-engine.test-support.ts";
import {
  NAUTILUS_ENGINE_ID,
  nautilusEngine,
  TYPESCRIPT_ENGINE_ID,
} from "./dsl-engine.ts";
import {
  type LibraryDoc,
  type LibraryStrategy,
  loadLibrary,
  parsePriceCsv,
  RESEARCH_DIR,
} from "./quantjourney.ts";

const repoRoot = join(import.meta.dirname, "..", "..");
const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0))
    rmSync(dir, { force: true, recursive: true });
});
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "core7-test-"));
  temps.push(dir);
  return dir;
};

// ------------------------------------------------------------------ fixtures

const days = (count: number, start = Date.UTC(2020, 0, 1)): string[] =>
  Array.from({ length: count }, (_, i) =>
    new Date(start + i * 86_400_000).toISOString().slice(0, 10)
  );

// A rising-then-falling price path; adj_close equals close (no dividends).
const csv = (dates: readonly string[], slope = 1): string => {
  const lines = dates.map((date, i) => {
    const close = 100 + slope * 20 * Math.sin(i / 15) + i * 0.1 * slope;
    return `${date},${close},${close + 1},${close - 1},${close},${close},1000`;
  });
  return `date,open,high,low,close,adj_close,volume\n${lines.join("\n")}\n`;
};

const sha = (char: string): string => char.repeat(64);
const file = (char = "a"): DataFile => ({
  manifestSha256: sha(char),
  normalizedSha256: sha("b"),
  sourceSha256: sha("c"),
});

const library = await loadLibrary(repoRoot);
const byId = (id: string): LibraryStrategy => {
  const found = library.strategies.find((s) => s.id === id);
  if (found === undefined) throw new Error(`no ${id} in library.json`);
  return found;
};
// O01 has a daily DSL definition, W09 an hourly one and O03 none.
const sample: LibraryDoc = {
  ...library,
  strategies: [byId("O01"), byId("W09"), byId("O03")],
};

// Futures from 2020-01-01, ETFs from 2020-02-01: the common window starts on 2020-02-01.
const texts = (): Map<string, string> =>
  new Map(
    core7Symbols().map((symbol, k) => [
      symbol,
      symbol.endsWith("=F")
        ? csv(days(240), 1 + k / 10)
        : csv(days(220, Date.UTC(2020, 1, 1)), 1 + k / 10),
    ])
  );
const files = (): Map<string, DataFile> =>
  new Map(core7Symbols().map((symbol) => [symbol, file()]));

// ------------------------------------------------------------------ tests

describe("Core 7 price data", () => {
  it("lists both universes, futures first", () => {
    expect(core7Symbols()).toEqual([
      "ES=F",
      "NQ=F",
      "YM=F",
      "RTY=F",
      "GC=F",
      "SI=F",
      "CL=F",
      "SPY",
      "QQQ",
      "DIA",
      "IWM",
      "GLD",
      "SLV",
      "USO",
    ]);
  });

  it("drops rows the importer rejects and keeps the rest unchanged", () => {
    const text = [
      "date,open,high,low,close,adj_close,volume",
      "2020-01-01,10,11,9,10,10,5",
      "2020-01-02,10,9.5,9,10,10,5", // high below open and close
      "2020-01-03,10,11,10.5,10,10,5", // low above open and close
      "2020-01-04,-1,11,9,10,10,5", // non-positive price
      "2020-01-05,10,12,8,11,11,",
    ].join("\n");
    const table = core7Table(text);
    expect(table.dates).toEqual(["2020-01-01", "2020-01-05"]);
    expect(Array.from(table.bars.h)).toEqual([11, 12]);
    expect(Array.from(table.bars.l)).toEqual([9, 8]);
    expect(Array.from(table.bars.o)).toEqual([10, 10]);
    expect(Array.from(table.bars.c)).toEqual([10, 11]);
    expect(Array.from(table.bars.t)).toEqual([
      Date.parse("2020-01-01"),
      Date.parse("2020-01-05"),
    ]);
    expect(table.adjClose).toEqual([10, 11]);
    const full = parsePriceCsv(text, "0000-01-01", "9999-12-31");
    return expect(importableRows(full).dates).toEqual(table.dates);
  });
});

describe("equity series", () => {
  it("rebases a window and summarizes it", () => {
    const equity = [
      { equity: 2, t: "2020-01-01" },
      { equity: 4, t: "2020-01-02" },
      { equity: 5, t: "2020-01-03" },
    ];
    expect(rebased(equity, "2020-01-02", "2020-01-03")).toEqual([
      { equity: 1, t: "2020-01-02" },
      { equity: 1.25, t: "2020-01-03" },
    ]);
    expect(rebased(equity, "2021-01-01", "2021-01-02")).toEqual([]);
    return expect(compact(null)).toBeNull();
  });

  it("combines sleeves on the common window only", () => {
    const table = core7Table(csv(days(120)));
    const late = core7Table(csv(days(100, Date.UTC(2020, 0, 11)), 2));
    const combined = combinedRun([
      buyAndHoldEquity(table),
      buyAndHoldEquity(late),
    ]);
    expect(combined.window).toEqual({ end: "2020-04-19", start: "2020-01-11" });
    expect(combined.summary).toMatchObject({
      end: "2020-04-19",
      start: "2020-01-11",
    });
    // Disjoint sleeves have no common window.
    const apart = core7Table(csv(days(50, Date.UTC(2021, 0, 1))));
    return expect(
      combinedRun([buyAndHoldEquity(table), buyAndHoldEquity(apart)]).summary
    ).toBeNull();
  });

  it("runs a DSL definition at the Vertex cost by default", () => {
    const table = core7Table(csv(days(200)));
    const definition = byId("O01").dsl;
    if (definition === null) throw new Error("O01 needs a DSL definition");
    const equity = dslEquity(table, definition);
    expect(equity).toHaveLength(200);
    expect(CORE7_COST_BPS).toBe(10);
    return expect(dslEquity(table, definition, 0)).not.toEqual(equity);
  });
});

describe("re-run assembly", () => {
  it("re-runs daily DSL strategies and lists the others with a reason", () => {
    const tables = new Map(
      [...texts()].map(([symbol, text]) => [symbol, core7Table(text)])
    );
    expect(rerunOnCore7(byId("O03"), tables)).toEqual({
      id: "O03",
      name: byId("O03").name,
      reason: ADAPTER_REASON,
      status: "not-run",
    });
    expect(rerunOnCore7(byId("W09"), tables)).toMatchObject({
      reason: HOURLY_REASON,
      status: "not-run",
    });
    const run = rerunOnCore7(byId("O01"), tables);
    if (run.status !== "run") throw new Error("O01 must run");
    expect(run.universes.map((u) => u.id)).toEqual([
      "core7-futures",
      "core7-etf-twins",
    ]);
    expect(run.universes[0]?.symbols.map((s) => s.symbol)).toEqual(
      core7Symbols().slice(0, 7)
    );
    expect(run.universes[0]?.combined.window.start).toBe("2020-01-01");
    expect(run.universes[1]?.combined.window.start).toBe("2020-02-01");
    tables.delete("SPY");
    return expect(() => rerunOnCore7(byId("O01"), tables)).toThrow(
      "missing data for SPY"
    );
  });

  it("builds the results document with the research-only header", () => {
    const results = buildCore7Results(sample, texts(), {
      files: files(),
      generated: "2026-11-03T00:00:00.000Z",
    });
    expect(results).toMatchObject({
      costBps: 10,
      engine: TYPESCRIPT_ENGINE_ID,
      engineParity: null,
      generated: "2026-11-03T00:00:00.000Z",
      promoted: [],
      researchOnly: true,
    });
    expect(results.data.symbols["ES=F"]).toEqual({
      ...file(),
      bars: 240,
      first: "2020-01-01",
      last: "2020-08-27",
    });
    expect(results.buyAndHold).toHaveLength(2);
    expect(results.strategies.map((s) => s.status)).toEqual([
      "run",
      "not-run",
      "not-run",
    ]);
    const noText = texts();
    noText.delete("USO");
    expect(() =>
      buildCore7Results(sample, noText, { files: files(), generated: "g" })
    ).toThrow("missing data for USO");
    const noFile = files();
    noFile.delete("CL=F");
    return expect(() =>
      buildCore7Results(sample, texts(), { files: noFile, generated: "g" })
    ).toThrow("missing manifest for CL=F");
  });

  it("runs every daily DSL job on Nautilus in one batch per symbol", () => {
    const nautilus = fakeNautilus();
    const results = buildCore7Results(
      sample,
      texts(),
      { files: files(), generated: "g" },
      (jobs) =>
        nautilusEngine(jobs, { ...nautilus, python: "py", root: "/repo" })
    );
    const typescript = buildCore7Results(sample, texts(), {
      files: files(),
      generated: "g",
    });
    expect(nautilus.calls).toHaveLength(core7Symbols().length);
    expect(nautilus.calls[0]?.args.slice(0, 3)).toEqual([
      "-m",
      "nautilus_backtest",
      "batch",
    ]);
    expect(nautilus.calls[0]).toMatchObject({
      cwd: "/repo/services/research",
      python: "py",
    });
    expect(results.engine).toBe(NAUTILUS_ENGINE_ID);
    expect(results.engineParity).toMatchObject({
      against: TYPESCRIPT_ENGINE_ID,
      jobs: core7Symbols().length,
      maxEquityRel: 0,
      pass: core7Symbols().length,
    });
    return expect(results.strategies).toEqual(typescript.strategies);
  });
});

describe("CLI", () => {
  const io = (root: string, out: string[]) => ({
    defaultPython: "venv-python",
    nautilus,
    now: () => new Date("2026-11-03T12:00:00.000Z"),
    root,
    sha256: (text: string) => `sha:${text.length}`,
    stderr: { write: (text: string) => out.push(text) },
    stdout: { write: (text: string) => out.push(text) },
  });
  let nautilus = fakeNautilus();
  afterEach(() => {
    nautilus = fakeNautilus();
  });

  it("rejects bad arguments", async () => {
    const out: string[] = [];
    expect(await runCore7RerunCli([], io(tempDir(), out))).toBe(2);
    expect(await runCore7RerunCli(["--bogus", "x"], io(tempDir(), out))).toBe(
      2
    );
    const data = ["--data", tempDir()];
    for (const extra of [
      ["--engine", "ts"],
      ["--python"],
      ["--engine"],
      ["--data", "again"],
    ])
      expect(
        await runCore7RerunCli([...data, ...extra], io(tempDir(), out))
      ).toBe(2);
    return expect(out.join("")).toContain("usage: bun run research:core7");
  });

  const setup = (): Readonly<{
    root: string;
    data: string;
    manifest: string;
  }> => {
    const root = tempDir();
    const data = tempDir();
    mkdirSync(join(root, RESEARCH_DIR), { recursive: true });
    mkdirSync(join(root, CORE7_DIR), { recursive: true });
    mkdirSync(join(data, "daily"));
    mkdirSync(join(data, "import"));
    writeFileSync(
      join(root, RESEARCH_DIR, "library.json"),
      JSON.stringify(sample)
    );
    const manifest = JSON.stringify({
      normalizedSha256: sha("d"),
      sourceSha256: sha("e"),
      symbol: "X",
    });
    for (const [symbol, text] of texts()) {
      writeFileSync(join(data, "daily", `${symbol}.csv`), text);
      writeFileSync(
        join(data, "import", `${symbol}-1d.manifest.json`),
        manifest
      );
    }
    return { data, manifest, root };
  };

  it("reads the data directory and writes rerun-results.json (Nautilus by default)", async () => {
    const { data, manifest, root } = setup();
    const out: string[] = [];
    expect(await runCore7RerunCli(["--data", data], io(root, out))).toBe(0);
    expect(out.join("")).toBe(
      `wrote ${RESULTS_PATH} (${NAUTILUS_ENGINE_ID})\n`
    );
    expect(nautilus.calls[0]?.python).toBe("venv-python");
    const written = JSON.parse(
      await readFile(join(root, RESULTS_PATH), "utf8")
    );
    expect(written.generated).toBe("2026-11-03T12:00:00.000Z");
    expect(written.engine).toBe(NAUTILUS_ENGINE_ID);
    expect(written.engineParity.pass).toBe(written.engineParity.jobs);
    return expect(written.data.symbols.SPY).toMatchObject({
      manifestSha256: `sha:${manifest.length}`,
      normalizedSha256: sha("d"),
      sourceSha256: sha("e"),
    });
  });

  it("keeps the TypeScript engine behind --engine typescript", async () => {
    const { data, root } = setup();
    const out: string[] = [];
    expect(
      await runCore7RerunCli(
        ["--engine", "typescript", "--data", data],
        io(root, out)
      )
    ).toBe(0);
    expect(nautilus.calls).toHaveLength(0);
    const written = JSON.parse(
      await readFile(join(root, RESULTS_PATH), "utf8")
    );
    return expect(written).toMatchObject({
      engine: TYPESCRIPT_ENGINE_ID,
      engineParity: null,
    });
  });

  it("prints one line with a hint when the Nautilus batch cannot run", async () => {
    const { data, root } = setup();
    const out: string[] = [];
    expect(
      await runCore7RerunCli(
        ["--data", data, "--python", "missing"],
        io(root, out)
      )
    ).toBe(1);
    expect(out.join("")).toContain(
      "nautilus batch failed (spawnSync missing ENOENT); pass --python"
    );
    return expect(readFile(join(root, RESULTS_PATH), "utf8")).rejects.toThrow();
  });

  it("writes nothing when Nautilus is outside the parity tolerance", async () => {
    const { data, root } = setup();
    nautilus = fakeNautilus({ scale: 1.001 });
    const out: string[] = [];
    expect(
      await runCore7RerunCli(
        ["--data", data, "--python", "/v/bin/python"],
        io(root, out)
      )
    ).toBe(1);
    expect(nautilus.calls[0]?.python).toBe("/v/bin/python");
    expect(out.join("")).toContain("Nautilus differs from");
    return expect(readFile(join(root, RESULTS_PATH), "utf8")).rejects.toThrow();
  });
});

describe("manifestDataFile", () => {
  const base = { normalizedSha256: sha("b"), sourceSha256: sha("c") };
  it("labels the bars from the manifest's source spans, its source text or the neutral label", () => {
    const spans = {
      rows: {
        ibkr: { first: "2024-11-11", last: "2026-11-06" },
        yahoo: { first: "2000-09-18", last: "2024-11-08" },
      },
    };
    expect(
      manifestDataFile(JSON.stringify({ ...base, sources: spans }), sha("a"))
    ).toEqual({
      ...file(),
      source: "ibkr 2024-11-11..2026-11-06, yahoo 2000-09-18..2024-11-08",
    });
    expect(
      manifestDataFile(
        JSON.stringify({ ...base, source: "Yahoo Finance chart v8" }),
        sha("a")
      ).source
    ).toBe("Yahoo Finance chart v8");
    expect(manifestDataFile(JSON.stringify(base), sha("a")).source).toBe(
      "IBKR first, Yahoo fills gaps"
    );
  });
});
