import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { BarColumns } from "../../packages/api/src/instant-backtest-engine.ts";
import {
  STRATEGY_TEMPLATES,
  StrategyDefinitionSchema,
} from "../../packages/api/src/strategy-dsl.ts";
import { fakeNautilus } from "./dsl-engine.test-support.ts";
import {
  catchNautilusErrors,
  type DslJob,
  engineOptions,
  engineParity,
  NAUTILUS_ENGINE_ID,
  nautilusRunner,
  parityFailure,
  prepareEngine,
  TYPESCRIPT_ENGINE_ID,
  typescriptRunner,
} from "./dsl-engine.ts";

const bars = (size: number, drift: number): BarColumns => {
  const c = Float64Array.from(
    { length: size },
    (_, i) => 100 + i * drift + 5 * Math.sin(i / 7)
  );
  return {
    c,
    h: c.map((value) => value + 1),
    l: c.map((value) => value - 1),
    o: c.map((value) => value - 0.2),
    t: Float64Array.from(
      { length: size },
      (_, i) => Date.UTC(2020, 0, 1) + i * 86_400_000
    ),
  };
};
const definition = StrategyDefinitionSchema.parse(STRATEGY_TEMPLATES.smaCross);
const a = bars(300, 0.1);
const b: BarColumns = {
  ...bars(300, -0.05),
  v: Float64Array.from({ length: 300 }, (_, i) => 1000 + i),
};
const jobs: DslJob[] = [
  { bars: a, costBps: 10, definition },
  { bars: b, costBps: 10, definition },
  { bars: a, costBps: 10, definition }, // repeated job: one case
];
const io = (nautilus = fakeNautilus()) => ({
  ...nautilus,
  python: "py",
  root: "/repo",
});

describe("nautilusRunner", () => {
  it("runs one batch per bar series and answers each job from it", () => {
    const nautilus = fakeNautilus();
    const runner = nautilusRunner(jobs, io(nautilus));
    expect(nautilus.calls).toHaveLength(2);
    expect(nautilus.removed).toEqual(["/fake/nautilus-1"]);
    expect(runner(b, definition, 10)).toEqual(
      typescriptRunner(b, definition, 10)
    );
    expect(() => runner(a, definition, 5)).toThrow("was not run up front");
    return expect(() => runner(bars(10, 1), definition, 10)).toThrow(
      "was not run up front"
    );
  });

  it("fails on a failed process, another engine, or an input error", () => {
    const failed = fakeNautilus({ status: 3 });
    expect(() => nautilusRunner(jobs, io(failed))).toThrow(
      "nautilus batch failed (boom)"
    );
    expect(failed.removed).toEqual(["/fake/nautilus-1"]); // also after a failure
    expect(() => nautilusRunner(jobs, { ...io(), python: "missing" })).toThrow(
      "nautilus batch failed (spawnSync missing ENOENT)"
    );
    expect(() =>
      nautilusRunner(jobs, {
        ...io(),
        spawn: () => ({ status: 9, stderr: null }),
      })
    ).toThrow("nautilus batch failed (status 9)");
    expect(() =>
      nautilusRunner(
        jobs,
        io(fakeNautilus({ engine: "nautilus-trader-1.0.0" }))
      )
    ).toThrow(`expected ${NAUTILUS_ENGINE_ID}`);
    const nautilus = fakeNautilus();
    const failing = {
      ...io(nautilus),
      spawn: (python: string, args: readonly string[], cwd: string) => {
        const run = nautilus.spawn(python, args, cwd);
        const output = args.at(-1) as string;
        const batch = JSON.parse(nautilus.readText(output));
        batch.results[0] = { error: "series too short", id: "0" };
        nautilus.writeText(output, JSON.stringify(batch));
        return run;
      },
    };
    expect(() => nautilusRunner(jobs, failing)).toThrow(
      "nautilus input error: series too short"
    );
    const answering = (results: readonly object[]) => ({
      ...io(nautilus),
      spawn: (python: string, args: readonly string[], cwd: string) => {
        const run = nautilus.spawn(python, args, cwd);
        nautilus.writeText(
          args.at(-1) as string,
          JSON.stringify({ engine: NAUTILUS_ENGINE_ID, results })
        );
        return run;
      },
    });
    expect(() => nautilus.readText("/none")).toThrow("no file /none");
    expect(() => nautilusRunner(jobs, answering([{ id: "0" }]))).toThrow(
      "nautilus input error: no result"
    );
    const result = { equity: [1], stats: {}, trades: [] };
    expect(() =>
      nautilusRunner(
        jobs,
        answering([
          { id: "0", result },
          { id: "0", result },
        ])
      )
    ).toThrow("unknown or repeated batch case 0");
    expect(() =>
      nautilusRunner(jobs.slice(0, 1), answering([{ id: " ", result }]))
    ).toThrow("unknown or repeated batch case  ");
    expect(() => nautilusRunner(jobs, answering([]))).toThrow(
      "nautilus batch returned 0 of 1 cases"
    );
    return expect(() => nautilusRunner(jobs, answering([{ id: "9" }]))).toThrow(
      "unknown or repeated batch case 9"
    );
  });
});

describe("engineParity", () => {
  it("passes equal engines and counts every job outside the tolerance", () => {
    const equal = prepareEngine("nautilus", io())(jobs);
    expect(equal.engine).toBe(NAUTILUS_ENGINE_ID);
    expect(equal.parity).toEqual({
      against: TYPESCRIPT_ENGINE_ID,
      equityRelTolerance: 1e-5,
      jobs: 3,
      maxEquityRel: 0,
      pass: 3,
    });
    expect(parityFailure(equal.parity)).toBeNull();
    expect(prepareEngine("typescript", io())(jobs)).toMatchObject({
      engine: TYPESCRIPT_ENGINE_ID,
      parity: null,
    });
    const off = engineParity(
      jobs,
      nautilusRunner(jobs, io(fakeNautilus({ scale: 1.001 })))
    );
    expect(off.pass).toBe(0);
    expect(off.maxEquityRel).toBeGreaterThan(1e-4);
    expect(parityFailure(off)).toContain("on 3 of 3 jobs");
    const short = engineParity(jobs.slice(0, 1), () => [1]);
    return expect(short).toMatchObject({
      maxEquityRel: Number.POSITIVE_INFINITY,
      pass: 0,
    });
  });
});

describe("engineOptions", () => {
  it("defaults to Nautilus and the default Python", () => {
    expect(engineOptions(["--data", "d"], "py")).toEqual({
      engine: "nautilus",
      python: "py",
    });
    expect(
      engineOptions(["--engine", "typescript", "--python", "/v/python"], "py")
    ).toEqual({
      engine: "typescript",
      python: "/v/python",
    });
    expect(engineOptions([], undefined)).toEqual({
      engine: "nautilus",
      python: "python3",
    });
    expect(engineOptions(["--python", "venv/bin/python"], undefined)).toEqual({
      engine: "nautilus",
      python: resolve("venv/bin/python"),
    });
    expect(engineOptions(["--engine", "stdlib"], "py")).toBeNull();
    expect(engineOptions(["--python", "--engine"], "py")).toBeNull();
    return expect(engineOptions(["--python"], "py")).toBeNull();
  });
});

describe("catchNautilusErrors", () => {
  it("prints a Nautilus error with the hint and throws any other error", () => {
    const out: string[] = [];
    const stderr = { write: (text: string) => out.push(text) };
    expect(catchNautilusErrors(() => 7, stderr)).toBe(7);
    expect(
      catchNautilusErrors(() => {
        throw new Error("nautilus batch failed (ENOENT)");
      }, stderr)
    ).toBeNull();
    expect(out.join("")).toContain(
      "nautilus batch failed (ENOENT); pass --python"
    );
    expect(() =>
      catchNautilusErrors(() => {
        throw new Error("missing data for SPY");
      }, stderr)
    ).toThrow("missing data for SPY");
    return expect(() =>
      catchNautilusErrors(() => {
        throw "nautilus text";
      }, stderr)
    ).toThrow();
  });
});
