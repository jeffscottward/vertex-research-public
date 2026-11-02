import { describe, expect, it } from "vitest";

import {
  alertMessage,
  DEFAULT_DRIFT_THRESHOLDS,
  type DriftBaseline,
  type DriftCheck,
  type DriftCheckKey,
  DriftInputError,
  type DriftPoint,
  type DriftTrade,
  escalations,
  evaluateDrift,
  levelsOf,
  longestLosingStreak,
  overallLevel,
  profitFactorOf,
  resolveThresholds,
  validateThresholds,
} from "./forward-drift.ts";

const DAY = 86_400_000;

/** Equity path from per-step returns, one point per day, starting at 100. */
const path = (returns: readonly number[], start = 100): DriftPoint[] => {
  const points: DriftPoint[] = [{ equity: start, t: 0 }];
  let equity = start;
  returns.forEach((value, index) => {
    equity *= 1 + value;
    points.push({ equity, t: (index + 1) * DAY });
  });
  return points;
};

const alternating = (up: number, down: number, steps: number): number[] =>
  Array.from({ length: steps }, (_, index) => (index % 2 === 0 ? up : -down));

const repeat = (value: number, count: number): number[] =>
  Array.from({ length: count }, () => value);

const trades = (pnls: readonly number[]): DriftTrade[] =>
  pnls.map((pnl, index) => ({ pnl, t: index * DAY }));

const baseline: DriftBaseline = {
  equity: path(alternating(0.01, 0.005, 100)),
  maxConsecutiveLosses: 4,
  maxDrawdownPct: 0.1,
  profitFactor: 2,
  winRate: 0.5,
};

const check = (
  key: DriftCheckKey,
  forward: Readonly<{ points?: DriftPoint[]; trades?: DriftTrade[] }>,
  base: DriftBaseline = baseline
): DriftCheck => {
  const result = evaluateDrift(base, {
    points: forward.points ?? [],
    trades: forward.trades ?? [],
  });
  const found = result.checks.find((entry) => entry.key === key);
  if (found === undefined) throw new Error(`missing check ${key}`);
  return found;
};

/** Equity points 100 -> 100 -> 100 x (1 - drop). */
const drop = (fraction: number): DriftPoint[] => [
  { equity: 100, t: 0 },
  { equity: 100, t: DAY },
  { equity: 100 * (1 - fraction), t: 2 * DAY },
];

describe("drawdown check", () => {
  it("stays ok below the baseline drawdown", () => {
    const result = check("drawdown", { points: drop(0.05) });
    expect(result.level).toBe("ok");
    expect(result.forward).toBeCloseTo(0.05, 10);
    expect(result.ratio).toBeCloseTo(0.5, 10);
  });

  it("warns at the baseline drawdown", () => {
    const result = check("drawdown", { points: drop(0.1) });
    expect(result.level).toBe("warn");
    expect(result.ratio).toBeCloseTo(1, 10);
    expect(result.reason).toContain("warn threshold 1");
  });

  it("alerts at 1.5 x the baseline drawdown", () => {
    const result = check("drawdown", { points: drop(0.15) });
    expect(result.level).toBe("alert");
    expect(result.reason).toContain("alert threshold 1.5");
  });

  it("uses the 1% floor when the baseline had no drawdown", () => {
    const result = check(
      "drawdown",
      { points: drop(0.005) },
      { ...baseline, maxDrawdownPct: 0 }
    );
    expect(result.ratio).toBeCloseTo(0.5, 10);
    expect(result.level).toBe("ok");
  });

  it("is insufficient with fewer than 2 points", () => {
    const result = check("drawdown", { points: [{ equity: 100, t: 0 }] });
    expect(result.level).toBe("insufficient");
    expect(result.forward).toBeNull();
    expect(result.ratio).toBeNull();
  });
});

describe("losing streak check", () => {
  it("is ok at the baseline streak", () => {
    expect(
      check("losingStreak", { trades: trades([1, -1, -1, -1, -1, 2]) }).level
    ).toBe("ok");
  });

  it("warns at 1.25 x the baseline streak", () => {
    const result = check("losingStreak", {
      trades: trades([-1, -1, -1, -1, -1]),
    });
    expect(result.forward).toBe(5);
    expect(result.level).toBe("warn");
  });

  it("alerts at 1.5 x the baseline streak", () => {
    const result = check("losingStreak", { trades: trades(repeat(-1, 6)) });
    expect(result.level).toBe("alert");
  });

  it("divides by at least one trade when the baseline had no losing streak", () => {
    const result = check(
      "losingStreak",
      { trades: trades([-1, -1]) },
      { ...baseline, maxConsecutiveLosses: 0 }
    );
    expect(result.ratio).toBe(2);
    expect(result.level).toBe("alert");
  });

  it("is insufficient without trades", () => {
    expect(check("losingStreak", {}).level).toBe("insufficient");
  });
});

/** Five wins of `win` and five losses of 1: profit factor = win. */
const pfTrades = (win: number): DriftTrade[] =>
  trades([win, -1, win, -1, win, -1, win, -1, win, -1]);

describe("rolling profit factor check", () => {
  it("is ok above 0.75 x the baseline", () => {
    const result = check("profitFactor", { trades: pfTrades(1.6) });
    expect(result.forward).toBeCloseTo(1.6, 10);
    expect(result.level).toBe("ok");
  });

  it("warns at 0.75 x the baseline", () => {
    expect(check("profitFactor", { trades: pfTrades(1.5) }).level).toBe("warn");
  });

  it("alerts at 0.5 x the baseline", () => {
    expect(check("profitFactor", { trades: pfTrades(1) }).level).toBe("alert");
  });

  it("uses only the last 20 trades", () => {
    const bad = repeat(-5, 10);
    const good = Array.from({ length: 20 }, (_, index) =>
      index % 2 === 0 ? 3 : -1
    );
    const result = check("profitFactor", { trades: trades([...bad, ...good]) });
    expect(result.sample).toBe(20);
    expect(result.forward).toBeCloseTo(3, 10);
    expect(result.level).toBe("ok");
  });

  it("is insufficient with fewer than 10 trades", () => {
    const result = check("profitFactor", { trades: trades([1, -1, 1]) });
    expect(result.level).toBe("insufficient");
    expect(result.reason).toBe("Needs at least 10 closed forward trades");
  });

  it("is ok without a losing trade in the window", () => {
    const result = check("profitFactor", { trades: trades(repeat(1, 10)) });
    expect(result.level).toBe("ok");
    expect(result.forward).toBeNull();
    expect(result.reason).toBe("No losing trade in the window");
  });

  it("is insufficient when the baseline has no profit factor", () => {
    const result = check(
      "profitFactor",
      { trades: pfTrades(1) },
      { ...baseline, profitFactor: null }
    );
    expect(result.level).toBe("insufficient");
    expect(result.reason).toContain("no positive profit factor");
  });
});

/** Ten trades with `wins` winners. */
const winTrades = (wins: number): DriftTrade[] =>
  trades(Array.from({ length: 10 }, (_, index) => (index < wins ? 1 : -0.1)));

describe("rolling win rate check", () => {
  it("is ok at the baseline win rate", () => {
    expect(check("winRate", { trades: winTrades(5) }).level).toBe("ok");
  });

  it("warns at 0.8 x the baseline", () => {
    const result = check("winRate", { trades: winTrades(4) });
    expect(result.forward).toBeCloseTo(0.4, 10);
    expect(result.level).toBe("warn");
  });

  it("alerts at 0.6 x the baseline", () => {
    expect(check("winRate", { trades: winTrades(3) }).level).toBe("alert");
  });

  it("is insufficient with fewer than 10 trades or without trades", () => {
    expect(check("winRate", { trades: trades([1, -1]) }).level).toBe(
      "insufficient"
    );
    const none = check("winRate", {});
    expect(none.level).toBe("insufficient");
    expect(none.forward).toBeNull();
  });

  it("is insufficient when the baseline win rate is not positive", () => {
    expect(
      check("winRate", { trades: winTrades(3) }, { ...baseline, winRate: 0 })
        .level
    ).toBe("insufficient");
  });
});

describe("Sharpe check", () => {
  it("is ok when the forward series behaves like the baseline", () => {
    const result = check("sharpe", {
      points: path(alternating(0.01, 0.005, 40)),
    });
    expect(result.ratio).toBeCloseTo(1, 1);
    expect(result.level).toBe("ok");
  });

  it("warns when the forward Sharpe falls to half of the baseline or less", () => {
    const result = check("sharpe", {
      points: path(alternating(0.01, 0.009, 40)),
    });
    expect(result.ratio).toBeGreaterThan(0);
    expect(result.ratio).toBeLessThanOrEqual(0.5);
    expect(result.level).toBe("warn");
  });

  it("alerts when the forward Sharpe is not positive", () => {
    const result = check("sharpe", {
      points: path(alternating(0.005, 0.01, 40)),
    });
    expect(result.ratio).toBeLessThan(0);
    expect(result.level).toBe("alert");
  });

  it("keeps a flat forward series insufficient instead of alerting", () => {
    const flat = Array.from({ length: 25 }, (_, index) => ({
      equity: 100,
      t: index * DAY,
    }));
    const result = check("sharpe", { points: flat });
    expect(result.forward).toBeNull();
    expect(result.level).toBe("insufficient");
    expect(result.reason).toBe(
      "Paper returns do not vary, so Sharpe is undefined"
    );
  });

  it("is insufficient with fewer than 20 returns", () => {
    const result = check("sharpe", {
      points: path(alternating(0.01, 0.005, 10)),
    });
    expect(result.level).toBe("insufficient");
    expect(result.sample).toBe(10);
  });

  it("is insufficient when the baseline Sharpe is not positive or missing", () => {
    const losing = { ...baseline, equity: path(alternating(0.005, 0.01, 40)) };
    expect(
      check("sharpe", { points: path(alternating(0.01, 0.005, 40)) }, losing)
        .level
    ).toBe("insufficient");
    const short = { ...baseline, equity: [{ equity: 100, t: 0 }] };
    const result = check("sharpe", {}, short);
    expect(result.baseline).toBeNull();
    expect(result.forward).toBeNull();
  });
});

describe("evaluateDrift", () => {
  it("reports the most severe level over all checks", () => {
    const result = evaluateDrift(baseline, {
      points: drop(0.1),
      trades: trades(repeat(-1, 6)),
    });
    expect(result.level).toBe("alert");
    expect(result.checks.map((entry) => entry.key)).toEqual([
      "drawdown",
      "losingStreak",
      "profitFactor",
      "sharpe",
      "winRate",
    ]);
  });

  it("is insufficient when no check has enough data", () => {
    expect(evaluateDrift(baseline, { points: [], trades: [] }).level).toBe(
      "insufficient"
    );
  });

  it("rejects out-of-order data and non-positive equity", () => {
    expect(() =>
      evaluateDrift(baseline, {
        points: [
          { equity: 100, t: DAY },
          { equity: 100, t: 0 },
        ],
        trades: [],
      })
    ).toThrow(DriftInputError);
    expect(() =>
      evaluateDrift(baseline, {
        points: [],
        trades: [
          { pnl: 1, t: DAY },
          { pnl: 1, t: 0 },
        ],
      })
    ).toThrow("time order");
    expect(() =>
      evaluateDrift(baseline, { points: [{ equity: 0, t: 0 }], trades: [] })
    ).toThrow("positive");
  });

  it("applies custom thresholds", () => {
    const thresholds = resolveThresholds({ drawdown: { alert: 3, warn: 2 } });
    const result = evaluateDrift(
      baseline,
      { points: drop(0.15), trades: [] },
      thresholds
    );
    expect(result.checks[0]?.level).toBe("ok");
  });
});

describe("thresholds", () => {
  it("resolves defaults and partial overrides", () => {
    expect(resolveThresholds()).toEqual(DEFAULT_DRIFT_THRESHOLDS);
    expect(resolveThresholds({ winRate: { warn: 0.9 } }).winRate).toEqual({
      alert: 0.6,
      warn: 0.9,
    });
  });

  it("rejects an alert threshold on the wrong side of the warn threshold", () => {
    expect(() =>
      resolveThresholds({ drawdown: { alert: 0.5, warn: 1 } })
    ).toThrow(
      "Max drawdown alert threshold must be at or above the warn threshold"
    );
    expect(() =>
      resolveThresholds({ sharpe: { alert: 0.8, warn: 0.5 } })
    ).toThrow("Sharpe alert threshold must be at or below the warn threshold");
  });

  it("rejects non-finite thresholds", () => {
    expect(() =>
      validateThresholds({
        ...DEFAULT_DRIFT_THRESHOLDS,
        sharpe: { alert: Number.NaN, warn: 0.5 },
      })
    ).toThrow("Sharpe thresholds must be finite");
  });
});

describe("escalations", () => {
  const evaluated = (
    levels: Partial<Record<DriftCheckKey, DriftCheck["level"]>>
  ) =>
    evaluateDrift(baseline, { points: [], trades: [] }).checks.map((entry) => ({
      ...entry,
      level: levels[entry.key] ?? entry.level,
    }));

  it("raises a check that reaches warn or alert for the first time", () => {
    const raised = escalations(
      {},
      evaluated({ drawdown: "warn", winRate: "alert" })
    );
    expect(raised.map((entry) => entry.key)).toEqual(["drawdown", "winRate"]);
  });

  it("does not repeat an unchanged or falling level", () => {
    expect(
      escalations({ drawdown: "warn" }, evaluated({ drawdown: "warn" }))
    ).toEqual([]);
    expect(
      escalations({ drawdown: "alert" }, evaluated({ drawdown: "warn" }))
    ).toEqual([]);
  });

  it("raises warn to alert, and again after a return to ok or insufficient", () => {
    expect(
      escalations({ drawdown: "warn" }, evaluated({ drawdown: "alert" }))
    ).toHaveLength(1);
    expect(
      escalations({ drawdown: "ok" }, evaluated({ drawdown: "warn" }))
    ).toHaveLength(1);
    expect(
      escalations({ drawdown: "insufficient" }, evaluated({ drawdown: "warn" }))
    ).toHaveLength(1);
  });

  it("stores the level of each check", () => {
    expect(levelsOf(evaluated({ sharpe: "warn" }))).toEqual({
      drawdown: "insufficient",
      losingStreak: "insufficient",
      profitFactor: "insufficient",
      sharpe: "warn",
      winRate: "insufficient",
    });
  });
});

describe("helpers", () => {
  it("counts losing streaks; a zero trade ends the streak", () => {
    expect(longestLosingStreak(trades([-1, -1, 0, -1, 1, -1, -1, -1]))).toBe(3);
  });

  it("computes the profit factor", () => {
    expect(profitFactorOf(trades([3, -1, -2]))).toBe(1);
    expect(profitFactorOf(trades([3, 0]))).toBeNull();
  });

  it("orders overall levels by severity", () => {
    expect(overallLevel([{ level: "ok" }, { level: "insufficient" }])).toBe(
      "ok"
    );
    expect(
      overallLevel([{ level: "warn" }, { level: "alert" }, { level: "ok" }])
    ).toBe("alert");
    expect(overallLevel([])).toBe("insufficient");
  });

  it("writes alert text with units for each check", () => {
    const result = evaluateDrift(baseline, {
      points: drop(0.15),
      trades: [...trades(repeat(-1, 6)), ...trades([1, 1, 1, 1])].map(
        (trade, index) => ({
          ...trade,
          t: index,
        })
      ),
    });
    const byKey = (key: DriftCheckKey): DriftCheck =>
      result.checks.find((entry) => entry.key === key) as DriftCheck;
    expect(alertMessage(byKey("drawdown"))).toBe(
      "Max drawdown alert: forward 15.00% vs baseline 10.00% (ratio 1.50; warn at 1, alert at 1.5)"
    );
    expect(alertMessage(byKey("losingStreak"))).toContain(
      "forward 6 trades vs baseline 4 trades"
    );
    expect(alertMessage(byKey("profitFactor"))).toContain(
      "forward 0.67 vs baseline 2.00 (ratio 0.33"
    );
    expect(alertMessage(byKey("sharpe"))).toContain("(ratio n/a;");
    expect(
      alertMessage(
        evaluateDrift(baseline, { points: [], trades: [] })
          .checks[0] as DriftCheck
      )
    ).toContain("forward n/a");
  });
});
