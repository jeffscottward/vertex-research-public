import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { STRUCTURE_DEFS } from "../../packages/academy/src/structures.ts";
import { scaledTimeout } from "../lib/test-timeout-scale.ts";
import {
  ACADEMY_GOLDEN_FIXTURE,
  buildSeries,
  casePlans,
  runAcademyGoldenCli,
  runCase,
} from "./academy-golden.ts";

const repoRoot = join(import.meta.dirname, "..", "..");
const FLOAT_REL_TOL = 1e-9;

/**
 * Path of the first difference between two JSON values, or null. Everything must be equal except
 * that two numbers may differ by FLOAT_REL_TOL (relative): the fixture is written with bun
 * (JavaScriptCore) and this test runs on Node (V8), whose Math.exp and Math.log differ in the last
 * bits. Trades, bars, labels, counts and texts are compared exactly.
 */
const firstDifference = (
  left: unknown,
  right: unknown,
  path = "$"
): string | null => {
  if (typeof left === "number" && typeof right === "number") {
    const scale = Math.max(Math.abs(left), Math.abs(right), 1e-12);
    return Math.abs(left - right) <= FLOAT_REL_TOL * scale ? null : path;
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) return `${path}.length`;
    for (const [index, value] of left.entries()) {
      const found = firstDifference(value, right[index], `${path}[${index}]`);
      if (found !== null) return found;
    }
    return null;
  }
  if (
    typeof left === "object" &&
    typeof right === "object" &&
    left !== null &&
    right !== null &&
    !Array.isArray(left) &&
    !Array.isArray(right)
  ) {
    const keys = Object.keys(left);
    if (keys.join() !== Object.keys(right).join()) return `${path} keys`;
    for (const key of keys) {
      const found = firstDifference(
        (left as Record<string, unknown>)[key],
        (right as Record<string, unknown>)[key],
        `${path}.${key}`
      );
      if (found !== null) return found;
    }
    return null;
  }
  return left === right ? null : path;
};

describe("academy golden fixture", () => {
  // Drift check: the TypeScript Academy engine and the Python fixture must not part. When this fails,
  // rerun `bun run research:academy-golden` and the Python tests in services/research
  // (tests/test_nautilus_backtest_academy.py).
  it(
    "rebuilds the committed academy-golden.json",
    () => {
      const written = new Map<string, string>();
      const out: string[] = [];
      const code = runAcademyGoldenCli({
        stdout: { write: (line) => out.push(line) },
        writeText: (path, value) => written.set(path, value),
      });
      expect(code).toBe(0);
      expect([...written.keys()]).toEqual([ACADEMY_GOLDEN_FIXTURE]);
      expect(out).toEqual([`wrote ${ACADEMY_GOLDEN_FIXTURE}\n`]);
      const committed = readFileSync(
        join(repoRoot, ACADEMY_GOLDEN_FIXTURE),
        "utf8"
      );
      expect(
        firstDifference(
          JSON.parse(written.get(ACADEMY_GOLDEN_FIXTURE) ?? "null"),
          JSON.parse(committed)
        )
      ).toBeNull();
    },
    scaledTimeout(60_000)
  );

  it("runs every structure with its default rules on every series", () => {
    const plans = casePlans();
    for (const series of ["mid", "high", "low"])
      expect(
        plans
          .filter(
            (plan) =>
              plan.series === series && Object.keys(plan.rules).length === 0
          )
          .map((plan) => plan.structure)
      ).toEqual(expect.arrayContaining(Object.keys(STRUCTURE_DEFS)));
    expect(Object.keys(STRUCTURE_DEFS)).toHaveLength(19);
    expect(new Set(plans.map((plan) => plan.id)).size).toBe(plans.length);
  });

  it("builds weekday bars with a missing implied volatility every 37th bar", () => {
    const series = buildSeries({
      bars: 40,
      drift: 0,
      id: "t",
      iv: true,
      seed: 1,
      shocks: { 3: 0.1 },
      start: 50,
      vol: 0.2,
    });
    expect(series.t).toHaveLength(40);
    expect(
      series.t.every((time) => {
        const day = new Date(time).getUTCDay();
        return day >= 1 && day <= 5;
      })
    ).toBe(true);
    expect(series.iv?.[11]).toBeNull();
    expect(series.iv?.[12]).toBeGreaterThan(0);
    expect(buildSeries({ ...plan(), iv: false }).iv).toBeUndefined();
  });

  it("finds the first difference outside the float tolerance", () => {
    const value = { a: [1, { b: "x", c: 2.5 }], d: null };
    expect(firstDifference(value, structuredClone(value))).toBeNull();
    expect(
      firstDifference(value, { a: [1, { b: "x", c: 2.5 + 1e-12 }], d: null })
    ).toBeNull();
    expect(
      firstDifference(value, { a: [1, { b: "x", c: 2.6 }], d: null })
    ).toBe("$.a[1].c");
    expect(firstDifference(value, { a: [1], d: null })).toBe("$.a.length");
    expect(
      firstDifference(value, { a: [1, { b: "y", c: 2.5 }], d: null })
    ).toBe("$.a[1].b");
    expect(
      firstDifference(value, { a: [1, { b: "x", e: 2.5 }], d: null })
    ).toBe("$.a[1] keys");
    expect(firstDifference(value, { a: [1, [2]], d: null })).toBe("$.a[1]");
    expect(firstDifference({ d: null }, { d: 1 })).toBe("$.d");
  });

  it("records an input error as the case result", () => {
    const series = buildSeries(plan());
    expect(
      runCase(
        {
          bars: 59,
          capital: 1000,
          id: "short",
          rules: {},
          series: "t",
          structure: "long_call",
        },
        series
      )
    ).toEqual({
      bars: 59,
      capital: 1000,
      error: "the backtest needs at least 60 daily bars",
      id: "short",
      rules: {},
      series: "t",
      structure: "long_call",
    });
  });
});

function plan() {
  return {
    bars: 80,
    drift: 0,
    id: "t",
    iv: true,
    seed: 7,
    shocks: {},
    start: 50,
    vol: 0.2,
  };
}
