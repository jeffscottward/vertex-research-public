import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { OWNER_RISK_CAPS } from "../../packages/api/src/risk-allocator.ts";
import { readMarketWatchCaps, runOwnerCapsCheck } from "./cli.ts";

const checkout = (leapsPct = "6.0"): string => {
  const root = mkdtempSync(join(tmpdir(), "mwb-"));
  mkdirSync(join(root, "market_watch/copyrot"), { recursive: true });
  mkdirSync(join(root, "market_watch/reentry"), { recursive: true });
  writeFileSync(
    join(root, "market_watch/premium_caps.py"),
    `LEAPS_MIN_DTE = 365\nLEAPS_PREMIUM_PCT = ${leapsPct}\nSHORT_PREMIUM_PCT = 2.0\n`
  );
  writeFileSync(
    join(root, "market_watch/copyrot/copybook.py"),
    "    total_pct: float = 50.0\n    name_pct: float = 10.0\n"
  );
  writeFileSync(
    join(root, "market_watch/reentry/runner.py"),
    "OPTIONS_ONLY = True  # owner rule\n"
  );
  return root;
};

const capture = () => {
  const lines: string[] = [];
  return { lines, out: { write: (line: string) => lines.push(line) } };
};

describe("owner caps check", () => {
  it("reads the market-watch-bot constants", () => {
    expect(readMarketWatchCaps(checkout())).toEqual({
      copyBookNamePct: 10,
      copyBookTotalPct: 50,
      leapsMinDte: 365,
      leapsPremiumPct: 6,
      optionsOnly: true,
      shortPremiumPct: 2,
    });
  });

  it("does not read name_pct from a longer field such as premium_name_pct", () => {
    const root = checkout();
    writeFileSync(
      join(root, "market_watch/copyrot/copybook.py"),
      "    premium_name_pct: float = 3.0\n    total_pct: float = 50.0\n    name_pct: float = 10.0\n"
    );
    expect(readMarketWatchCaps(root).copyBookNamePct).toBe(10);
  });

  it("compares a live cap with no pending change directly", () => {
    const live = {
      ...OWNER_RISK_CAPS,
      leapsPremiumPct: 6,
      leapsPremiumPending: null,
    };
    expect(
      runOwnerCapsCheck(["bun", "x", checkout()], {}, capture().out, live)
    ).toBe(0);
  });

  it("passes on a match from argv and reports drift from the env path", () => {
    const ok = capture();
    expect(runOwnerCapsCheck(["bun", "x", checkout()], {}, ok.out)).toBe(0);
    expect(ok.lines.join("")).toContain("matches");
    const bad = capture();
    expect(
      runOwnerCapsCheck(
        ["bun", "x"],
        { MARKET_WATCH_BOT_DIR: checkout("15.0") },
        bad.out,
        OWNER_RISK_CAPS
      )
    ).toBe(1);
    expect(bad.lines.join("")).toContain(
      "drift: leapsPremiumPct snapshot=6 market-watch-bot=15"
    );
  });

  it("fails on a missing checkout or constant", () => {
    const missing = capture();
    expect(
      runOwnerCapsCheck(
        ["bun", "x", join(tmpdir(), "no-such-mwb")],
        {},
        missing.out
      )
    ).toBe(1);
    const root = checkout();
    writeFileSync(join(root, "market_watch/reentry/runner.py"), "\n");
    expect(() => readMarketWatchCaps(root)).toThrow("OPTIONS_ONLY not found");
    expect(
      runOwnerCapsCheck(["bun", "x"], { HOME: "/nonexistent" }, capture().out)
    ).toBeTypeOf("number");
  });
});
