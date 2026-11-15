import { describe, expect, it } from "vitest";

import {
  ARM_WINDOW_SESSIONS,
  armingBefore,
  type BreadthDay,
  classifyPct,
  evaluate,
  fireRule,
  sharePct,
  toSessions,
} from "./classifier.ts";

/** A final session with up volume `up`% of the total and advancers `adv`% of the issues. */
const day = (
  date: string,
  up: number,
  adv: number | null = up,
  final = true
): BreadthDay => ({
  adv: adv === null ? 0 : adv,
  asOf: "t",
  date,
  decl: adv === null ? 0 : 100 - adv,
  dvol: (100 - up) * 10,
  final,
  source: "test",
  uvol: up * 10,
});

/** NYSE USI:UVOL/DVOL/ADV/DECL daily values from TradingView (the backfill of 2026-11-06). */
const real = (
  date: string,
  uvol: number,
  dvol: number,
  adv: number,
  decl: number
): BreadthDay => ({
  adv,
  asOf: "2026-11-06T20:42:30.372Z",
  date,
  decl,
  dvol,
  final: true,
  source: "tradingview",
  uvol,
});

const APRIL_2025: BreadthDay[] = [
  real("2025-03-28", 239_482_610, 1_446_919_510, 590, 2186),
  real("2025-03-31", 1_052_356_380, 610_870_590, 1726, 1031),
  real("2025-04-01", 834_430_660, 742_993_010, 1467, 1268),
  real("2025-04-02", 1_016_418_580, 465_016_570, 1857, 868),
  real("2025-04-03", 182_507_385, 1_356_363_630, 368, 2303),
  real("2025-04-04", 135_690_235, 1_793_822_290, 233, 2357),
  real("2025-04-07", 680_560_958, 1_377_423_810, 529, 2019),
  real("2025-04-08", 206_357_025, 1_457_587_520, 617, 1975),
  real("2025-04-09", 2_076_253_230, 29_575_500, 2433, 111),
  real("2025-04-10", 212_375_836, 1_310_411_990, 283, 2329),
];

describe("sharePct and classifyPct", () => {
  it("computes the share with two decimals and rejects empty or negative pairs", () => {
    expect(sharePct(1, 3)).toBe(25);
    expect(sharePct(2, 1)).toBe(66.67);
    expect(sharePct(0, 0)).toBeNull();
    expect(sharePct(-1, 5)).toBeNull();
    expect(sharePct(Number.NaN, 1)).toBeNull();
  });

  it("classifies the four thresholds inclusively", () => {
    expect(classifyPct(90)).toBe("UP_90");
    expect(classifyPct(89.99)).toBe("UP_80");
    expect(classifyPct(80)).toBe("UP_80");
    expect(classifyPct(50)).toBe("NEUTRAL");
    expect(classifyPct(20)).toBe("DOWN_80");
    expect(classifyPct(10.01)).toBe("DOWN_80");
    expect(classifyPct(10)).toBe("DOWN_90");
  });

  it("sorts sessions and drops days without volume", () => {
    const rows = toSessions([
      day("2026-01-03", 50),
      { ...day("2026-01-02", 50), dvol: 0, uvol: 0 },
      day("2026-01-01", 40, null),
    ]);
    expect(rows.map((row) => row.date)).toEqual(["2026-01-01", "2026-01-03"]);
    expect(rows[0]?.advPct).toBeNull();
  });
});

describe("arming and the fire rule", () => {
  it("arms on an 80% down day in the window and flags strict for a 90% down day", () => {
    const rows = toSessions([day("d1", 8), day("d2", 50), day("d3", 18)]);
    expect(armingBefore(rows, 3)).toEqual({
      armedOn: "d3",
      strict: true,
      strictOn: "d1",
    });
    expect(armingBefore(rows, 1)).toEqual({
      armedOn: "d1",
      strict: true,
      strictOn: "d1",
    });
    expect(armingBefore(rows, 0)).toBeNull();
    expect(armingBefore(toSessions([day("d1", 15)]), 1)).toEqual({
      armedOn: "d1",
      strict: false,
      strictOn: null,
    });
  });

  it("grades 90% and back-to-back 80% days", () => {
    const [a, b, c, d] = toSessions([
      day("a", 92, 91),
      day("b", 92, 70),
      day("c", 85, 85),
      day("d", 70),
    ]);
    expect(fireRule(a!, undefined)).toEqual({
      grade: "major",
      trigger: "UP_90",
    });
    expect(fireRule(b!, undefined)).toEqual({
      grade: "volume-only",
      trigger: "UP_90",
    });
    expect(fireRule(c!, a)).toEqual({ grade: "major", trigger: "UP_80_X2" });
    expect(fireRule(c!, b)).toEqual({
      grade: "volume-only",
      trigger: "UP_80_X2",
    });
    expect(fireRule(c!, d)).toBeNull();
    expect(fireRule(c!, undefined)).toBeNull();
    expect(fireRule(d!, c)).toBeNull();
  });
});

describe("evaluate", () => {
  it("reproduces April 2025: armed 03-28, strict 04-04, fired major on 04-09", () => {
    const result = evaluate(APRIL_2025);
    expect(
      result.events.map((event) => `${event.kind}:${event.date}:${event.tier}`)
    ).toEqual([
      "ARMED:2025-03-28:standard",
      "ARMED:2025-04-04:strict",
      "FIRED:2025-04-09:major",
      // The fire used the arming up; the 04-10 80% down day arms again.
      "ARMED:2025-04-10:standard",
    ]);
    const fired = result.events[2];
    expect(fired).toMatchObject({
      advPct: 95.64,
      armedOn: "2025-04-08",
      strict: true,
      trigger: "UP_90",
      upPct: 98.6,
    });
    // 04-10 is the session after the fire: still shown as FIRED.
    expect(result.state).toBe("FIRED");
    expect(result.lastFired?.date).toBe("2025-04-09");
    expect(result.armedOn).toBe("2025-04-10");
  });

  it("is ARMED (non-strict) on 2026-11-06 by the 2026-11-05 84% down day; the intraday 54.75% does not form", () => {
    const result = evaluate([
      real("2026-11-04", 1_204_820_090, 510_798_815, 2014, 655),
      real("2026-11-05", 287_938_584, 1_471_385_180, 393, 2276),
      {
        ...real("2026-11-06", 301_103_572, 248_847_000, 1494, 1221),
        final: false,
      },
    ]);
    expect(result.sessions[1]).toMatchObject({
      advPct: 14.72,
      date: "2026-11-05",
      kind: "DOWN_80",
      upPct: 16.37,
    });
    expect(result.state).toBe("ARMED");
    expect(result.strict).toBe(false);
    expect(result.armedOn).toBe("2026-11-05");
    expect(result.sessionsLeft).toBe(ARM_WINDOW_SESSIONS);
    expect(result.latest).toMatchObject({ date: "2026-11-06", final: false });
    expect(result.events.map((event) => event.kind)).toEqual(["ARMED"]);
  });

  it("forms intraday on a 90% reading or an 80% reading after an 80% session", () => {
    const forming90 = evaluate([
      day("d1", 15),
      day("d2", 50),
      day("d3", 93, 85, false),
    ]);
    expect(forming90.state).toBe("FORMING");
    expect(forming90.events.at(-1)).toMatchObject({
      grade: "volume-only",
      kind: "FORMING",
      tier: "volume-only",
      trigger: "UP_90",
    });
    const forming80 = evaluate([
      day("d1", 15),
      day("d2", 82, 81),
      day("d3", 84, 84, false),
    ]);
    expect(forming80.events.at(-1)).toMatchObject({
      grade: "major",
      kind: "FORMING",
      trigger: "UP_80_X2",
    });
    expect(
      evaluate([day("d1", 15), day("d2", 50), day("d3", 84, 84, false)]).state
    ).toBe("ARMED");
    // Unarmed: an intraday 95% reading is no FORMING.
    expect(evaluate([day("d1", 50), day("d2", 95, 95, false)]).state).toBe(
      "IDLE"
    );
  });

  it("fires on back-to-back 80% days, notices an unarmed thrust and ignores an early unfinished day", () => {
    const result = evaluate([
      day("d0", 95),
      day("d1", 15),
      day("d2", 82),
      day("d3", 83),
      day("d4", 50),
      day("d5", 50),
    ]);
    expect(result.events.map((event) => `${event.kind}:${event.date}`)).toEqual(
      ["THRUST:d0", "ARMED:d1", "FIRED:d3"]
    );
    // The fire used the arming up: no new down day, so IDLE.
    expect(result.state).toBe("IDLE");
    const early = evaluate([day("d0", 50, 50, false), day("d1", 50)]);
    expect(early.sessions.map((row) => row.date)).toEqual(["d1"]);
    expect(early.state).toBe("IDLE");
    expect(evaluate([]).latest).toBeNull();
  });

  it("keeps FIRED through the next session, which cannot form or fire again without a new down day", () => {
    expect(evaluate([day("d1", 15), day("d2", 95)]).state).toBe("FIRED");
    const next = evaluate([
      day("d1", 15),
      day("d2", 95),
      day("d3", 95, 95, false),
    ]);
    expect(next.state).toBe("FIRED");
    expect(next.events.map((event) => event.kind)).toEqual(["ARMED", "FIRED"]);
    const again = evaluate([
      day("d1", 15),
      day("d2", 95),
      day("d3", 85),
      day("d4", 95),
      day("d5", 50),
    ]);
    expect(again.events.map((event) => `${event.kind}:${event.date}`)).toEqual([
      "ARMED:d1",
      "FIRED:d2",
      "THRUST:d4",
    ]);
    const rearmed = evaluate([
      day("d1", 15),
      day("d2", 95),
      day("d3", 12),
      day("d4", 92, 92),
    ]);
    expect(
      rearmed.events.map((event) => `${event.kind}:${event.date}`)
    ).toEqual(["ARMED:d1", "FIRED:d2", "ARMED:d3", "FIRED:d4"]);
  });

  it("disarms when the arming day leaves the 30-session window", () => {
    const quiet = Array.from({ length: ARM_WINDOW_SESSIONS }, (_, index) =>
      day(`e${String(index).padStart(2, "0")}`, 50)
    );
    const armed = evaluate([day("d1", 15), ...quiet.slice(0, -1)]);
    expect(armed.state).toBe("ARMED");
    expect(armed.sessionsLeft).toBe(1);
    const expired = evaluate([day("d1", 15), ...quiet]);
    expect(expired.state).toBe("IDLE");
    expect(expired.sessionsLeft).toBeNull();
  });

  it("emits a new ARMED event when a 90% down day upgrades an armed window to strict", () => {
    const result = evaluate([
      day("d1", 15),
      day("d2", 18),
      day("d3", 9),
      day("d4", 5),
    ]);
    expect(
      result.events.map((event) => `${event.kind}:${event.date}:${event.tier}`)
    ).toEqual(["ARMED:d1:standard", "ARMED:d3:strict"]);
  });
});
