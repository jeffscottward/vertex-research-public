import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { InstantTrade } from "../../packages/api/src/instant-backtest-engine.ts";
import { scaledTimeout } from "../lib/test-timeout-scale.ts";
import {
  assertGapExit,
  GOLDEN_FIXTURE,
  runGoldenCli,
} from "./nautilus-golden.ts";

const repoRoot = join(import.meta.dirname, "..", "..");

const trade: InstantTrade = {
  entryIndex: 1,
  entryPrice: 100,
  exitIndex: 2,
  exitPrice: 95,
  exitReason: "stop",
  netReturn: -0.05,
  pnl: -0.05,
  units: 0.01,
};

describe("buildGolden", () => {
  // Drift check: the TS engine and the Python fixture must not part. When this fails, rerun
  // `bun run research:nautilus-golden` and the Python tests in services/research.
  it(
    "rebuilds the committed golden.json byte for byte",
    () => {
      const read: string[] = [];
      const written = new Map<string, string>();
      const out: string[] = [];
      const code = runGoldenCli({
        readText: (path) => {
          read.push(path);
          return readFileSync(join(repoRoot, path), "utf8");
        },
        stdout: { write: (line) => out.push(line) },
        writeText: (path, value) => written.set(path, value),
      });
      expect(code).toBe(0);
      expect([...written.keys()]).toEqual([GOLDEN_FIXTURE]);
      expect(out).toEqual([`wrote ${GOLDEN_FIXTURE}\n`]);
      const text = written.get(GOLDEN_FIXTURE) ?? "";
      const committed = readFileSync(join(repoRoot, GOLDEN_FIXTURE), "utf8");
      expect(text === committed).toBe(true);
      expect(createHash("sha256").update(text).digest("hex")).toBe(
        createHash("sha256").update(committed).digest("hex")
      );
      expect(read).toEqual([
        "tests/fixtures/golden/QQQ-1d.csv",
        "tests/fixtures/golden/SPY-1d.csv",
        "research/backtests/quantjourney/library.json",
      ]);
    },
    scaledTimeout(60_000)
  );
});

describe("assertGapExit", () => {
  it("accepts the expected exit and rejects any other", () => {
    expect(() => assertGapExit("case", trade, "stop", 95)).not.toThrow();
    expect(() => assertGapExit("case", undefined, "stop", 95)).toThrow(
      "case: unexpected first trade undefined"
    );
    expect(() =>
      assertGapExit("case", { ...trade, exitIndex: 3 }, "stop", 95)
    ).toThrow("case: unexpected first trade");
    expect(() => assertGapExit("case", trade, "target", 95)).toThrow(
      "unexpected first trade"
    );
    expect(() => assertGapExit("case", trade, "stop", 96)).toThrow(
      "unexpected first trade"
    );
  });
});
