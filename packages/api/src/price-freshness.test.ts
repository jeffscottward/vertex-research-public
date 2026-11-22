import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { OPENBB_DAILY_BAR_SYMBOLS } from "./contracts/openbb.ts";
import { nyseHolidays } from "./nyse-calendar.ts";
import {
  diffFreshnessIncident,
  evaluatePriceFreshness,
  expectedFreshnessSession,
  formatFreshnessAlertMessage,
  formatFreshnessRecoveryMessage,
  freshnessKeyOf,
  nyseSessionsBehind,
  OPENBB_ALL_DAILY_SERIES_IDS,
  OPENBB_FRESHNESS_IN_FLIGHT_LEASE_MS,
  thresholdForSeries,
} from "./price-freshness.ts";

const DAY_MS = 86_400_000;

const allFreshInputs = (lastDate: string) => ({
  bars: OPENBB_DAILY_BAR_SYMBOLS.map((symbol) => ({ lastDate, symbol })),
  series: OPENBB_ALL_DAILY_SERIES_IDS.map((id) => ({ id, lastDate })),
});

describe("nyse-calendar parity with Python nyse_closures.py", () => {
  it("matches every listed 2024-2028 NYSE closure 1:1", () => {
    const pyText = readFileSync(
      new URL(
        "../../../services/openbb/vertex_openbb/jobs/nyse_closures.py",
        import.meta.url
      ),
      "utf8"
    );
    const pyDates = [...pyText.matchAll(/"(\d{4}-\d{2}-\d{2})"/gu)]
      .map((match) => String(match[1]))
      .sort();
    const tsDates: string[] = [];
    for (let year = 2024; year <= 2028; year += 1)
      for (const day of nyseHolidays(year))
        tsDates.push(new Date(day * DAY_MS).toISOString().slice(0, 10));
    expect(tsDates.sort()).toEqual(pyDates);
    expect(tsDates).toHaveLength(50);
    // Pre-2022 has no Juneteenth holiday (9 regular holidays in 2021).
    expect(nyseHolidays(2021).size).toBe(9);
  });
});

describe("expectedFreshnessSession (06:00 ET SLA)", () => {
  it("rolls to the prior NYSE session at 06:00 America/New_York and holds earlier session at 05:59", () => {
    // Tuesday 2026-11-24 05:59 EST (UTC-5 = 10:59Z) -> Friday 2026-11-20
    expect(expectedFreshnessSession(new Date("2026-11-24T10:59:00Z"))).toBe(
      "2026-11-20"
    );
    // Tuesday 2026-11-24 06:00 EST (UTC-5 = 11:00Z) -> Monday 2026-11-23
    expect(expectedFreshnessSession(new Date("2026-11-24T11:00:00Z"))).toBe(
      "2026-11-23"
    );
    // Tuesday 2026-11-24 18:30 EST -> still Monday 2026-11-23 (never flips at 16:00 ET)
    expect(expectedFreshnessSession(new Date("2026-11-24T23:30:00Z"))).toBe(
      "2026-11-23"
    );
  });

  it("handles weekends, Saturday 06:15 ET, NYSE holidays, special closure 2025-01-09, and DST", () => {
    // Saturday 2026-11-21 06:15 EST -> Friday 2026-11-20
    expect(expectedFreshnessSession(new Date("2026-11-21T11:15:00Z"))).toBe(
      "2026-11-20"
    );
    // Sunday 2026-11-22 12:00 EST -> Friday 2026-11-20
    expect(expectedFreshnessSession(new Date("2026-11-22T17:00:00Z"))).toBe(
      "2026-11-20"
    );
    // Friday 2026-11-27 06:15 EST (day after Thanksgiving 2026-11-26) -> Wednesday 2026-11-25
    expect(expectedFreshnessSession(new Date("2026-11-27T11:15:00Z"))).toBe(
      "2026-11-25"
    );
    // Friday 2025-01-10 06:15 EST (day after special closure 2025-01-09) -> Wednesday 2025-01-08
    expect(expectedFreshnessSession(new Date("2025-01-10T11:15:00Z"))).toBe(
      "2025-01-08"
    );
    // Spring-forward Sunday 2026-03-08 06:15 EDT (UTC-4 = 10:15Z) -> Friday 2026-03-06
    expect(expectedFreshnessSession(new Date("2026-03-08T10:15:00Z"))).toBe(
      "2026-03-06"
    );
    // Fall-back Sunday 2026-11-01 06:15 EST (UTC-5 = 11:15Z) -> Friday 2026-10-30
    expect(expectedFreshnessSession(new Date("2026-11-01T11:15:00Z"))).toBe(
      "2026-10-30"
    );
  });
});

describe("nyseSessionsBehind", () => {
  it("counts only NYSE trading days strictly after lastDate up to expectedSession", () => {
    expect(nyseSessionsBehind("2026-11-20", "2026-11-20")).toBe(0);
    expect(nyseSessionsBehind("2026-11-23", "2026-11-20")).toBe(0);
    // Across Thanksgiving (2026-11-26 closed): 24, 25, 27 = 3 sessions
    expect(nyseSessionsBehind("2026-11-23", "2026-11-27")).toBe(3);
    // Bond holiday 1-session lag: 2026-11-10 -> 2026-11-11 (Veterans Day, NYSE open) = 1
    expect(nyseSessionsBehind("2026-11-10", "2026-11-11")).toBe(1);
    // Special closure 2025-01-09 skipped: 2025-01-08 -> 2025-01-10 = 1 session
    expect(nyseSessionsBehind("2025-01-08", "2025-01-10")).toBe(1);
  });
});

describe("evaluatePriceFreshness and thresholds", () => {
  it("monitors all 31 daily series and 14 1d bar series with exact thresholds", () => {
    expect(OPENBB_ALL_DAILY_SERIES_IDS).toHaveLength(31);
    expect(OPENBB_DAILY_BAR_SYMBOLS).toHaveLength(14);
    expect(thresholdForSeries("daily_series", "SPY")).toEqual({
      clearSessions: 1,
      maxSessions: 2,
    });
    expect(thresholdForSeries("daily_bars", "SPY")).toEqual({
      clearSessions: 1,
      maxSessions: 2,
    });
    expect(thresholdForSeries("daily_series", "EY_TNX_RATIO")).toEqual({
      clearSessions: 24,
      maxSessions: 25,
    });

    const fresh = evaluatePriceFreshness({
      ...allFreshInputs("2026-11-20"),
      expectedSession: "2026-11-20",
    });
    expect(fresh.monitoredKeys).toHaveLength(45);
    expect(fresh.stale).toEqual([]);
    expect(fresh.clearableKeys).toHaveLength(45);
  });

  it("distinguishes 0/1/2 (not stale), 3 (stale), missing (stale), and EY_TNX_RATIO 25 vs 26", () => {
    const base = allFreshInputs("2026-11-25");
    // Expected: Wed 2026-11-25
    // Tue 2026-11-24 = 1 behind (clearable, e.g. bond holiday on IRX/TNX)
    // Mon 2026-11-23 = 2 behind (hysteresis band: neither stale nor clearable)
    // Fri 2026-11-20 = 3 behind (stale)
    const series = base.series
      .filter((entry) => entry.id !== "VIX") // VIX missing
      .map((entry) => {
        if (entry.id === "IRX") return { id: "IRX", lastDate: "2026-11-24" };
        if (entry.id === "QQQ") return { id: "QQQ", lastDate: "2026-11-23" };
        if (entry.id === "SPY") return { id: "SPY", lastDate: "2026-11-20" };
        if (entry.id === "EY_TNX_RATIO")
          return { id: "EY_TNX_RATIO", lastDate: "2026-10-21" }; // 25 NYSE sessions behind 2026-11-25
        return entry;
      });
    const bars = base.bars
      .filter((entry) => entry.symbol !== "DIA") // DIA bars missing
      .map((entry) =>
        entry.symbol === "SPY"
          ? { lastDate: "2026-11-20", symbol: "SPY" }
          : entry
      );

    expect(nyseSessionsBehind("2026-10-21", "2026-11-25")).toBe(25);
    const result = evaluatePriceFreshness({
      bars,
      expectedSession: "2026-11-25",
      series,
    });
    expect(result.stale).toEqual([
      {
        id: "SPY",
        lastDate: "2026-11-20",
        maxSessionsBehind: 2,
        sessionsBehind: 3,
        table: "daily_series",
      },
      {
        id: "VIX",
        lastDate: null,
        maxSessionsBehind: 2,
        sessionsBehind: null,
        table: "daily_series",
      },
      {
        id: "DIA",
        lastDate: null,
        maxSessionsBehind: 2,
        sessionsBehind: null,
        table: "daily_bars",
      },
      {
        id: "SPY",
        lastDate: "2026-11-20",
        maxSessionsBehind: 2,
        sessionsBehind: 3,
        table: "daily_bars",
      },
    ]);
    expect(result.clearableKeys).toContain("daily_series:IRX");
    expect(result.clearableKeys).not.toContain("daily_series:QQQ");
    expect(result.clearableKeys).not.toContain("daily_series:EY_TNX_RATIO");

    // 26 sessions behind makes EY_TNX_RATIO stale
    expect(nyseSessionsBehind("2026-10-20", "2026-11-25")).toBe(26);
    const eyStale = evaluatePriceFreshness({
      bars: base.bars,
      expectedSession: "2026-11-25",
      series: base.series.map((entry) =>
        entry.id === "EY_TNX_RATIO"
          ? { id: "EY_TNX_RATIO", lastDate: "2026-10-20" }
          : entry
      ),
    });
    expect(eyStale.stale).toEqual([
      {
        id: "EY_TNX_RATIO",
        lastDate: "2026-10-20",
        maxSessionsBehind: 25,
        sessionsBehind: 26,
        table: "daily_series",
      },
    ]);
  });
});

describe("formatFreshnessAlertMessage and formatFreshnessRecoveryMessage", () => {
  it("stays ASCII-only and within strict byte bounds even when all 45 series are stale", () => {
    const allStale = evaluatePriceFreshness({
      bars: [],
      expectedSession: "2026-11-20",
      series: [],
    }).stale;
    expect(allStale).toHaveLength(45);
    const alert = formatFreshnessAlertMessage(allStale, 45, "2026-11-20");
    expect(Buffer.byteLength(alert.title, "utf8")).toBeLessThanOrEqual(120);
    expect(Buffer.byteLength(alert.body, "utf8")).toBeLessThanOrEqual(1000);
    expect(alert.title).toBe(
      "Vertex: 45 daily price/bar series stale (2026-11-20)"
    );
    expect(alert.body).toContain("+37 more");

    // Worst-case dated items (longer than "(missing)" labels, including EY_TNX_RATIO 26d)
    const datedStale = evaluatePriceFreshness({
      bars: OPENBB_DAILY_BAR_SYMBOLS.map((symbol) => ({
        lastDate: "2026-11-10",
        symbol,
      })),
      expectedSession: "2026-11-20",
      series: OPENBB_ALL_DAILY_SERIES_IDS.map((id) => ({
        id,
        lastDate: id === "EY_TNX_RATIO" ? "2026-10-14" : "2026-11-10",
      })),
    }).stale;
    expect(datedStale).toHaveLength(45);
    const datedAlert = formatFreshnessAlertMessage(
      datedStale,
      45,
      "2026-11-20"
    );
    expect(Buffer.byteLength(datedAlert.title, "utf8")).toBeLessThanOrEqual(
      120
    );
    expect(Buffer.byteLength(datedAlert.body, "utf8")).toBeLessThanOrEqual(
      1000
    );
    expect(datedAlert.body).toContain("EY_TNX_RATIO (27d, last 2026-10-14)");
    expect(/^[ -~]+$/u.test(datedAlert.body)).toBe(true);
    expect(alert.body).toContain("Total stale: 45/45; expected 2026-11-20");
    expect(/^[\x20-\x7e]+$/u.test(alert.title)).toBe(true);
    expect(/^[\x20-\x7e]+$/u.test(alert.body)).toBe(true);

    const recovery = formatFreshnessRecoveryMessage(45, "2026-11-20");
    expect(Buffer.byteLength(recovery.title, "utf8")).toBeLessThanOrEqual(120);
    expect(Buffer.byteLength(recovery.body, "utf8")).toBeLessThanOrEqual(400);
    expect(recovery.body).toBe(
      "All 31 daily series and 14 1d bar series are fresh as of 2026-11-20 (45 recovered)."
    );
  });
});

describe("diffFreshnessIncident state machine", () => {
  const NOW = new Date("2026-11-24T11:15:00Z");
  const baseEval = evaluatePriceFreshness({
    ...allFreshInputs("2026-11-23"),
    expectedSession: "2026-11-23",
  });
  const spySeriesStale = {
    id: "SPY",
    lastDate: "2026-11-18",
    maxSessionsBehind: 2,
    sessionsBehind: 3,
    table: "daily_series" as const,
  };
  const qqqBarsStale = {
    id: "QQQ",
    lastDate: "2026-11-18",
    maxSessionsBehind: 2,
    sessionsBehind: 3,
    table: "daily_bars" as const,
  };

  it("returns noop in steady fresh state", () => {
    const diff = diffFreshnessIncident({
      activeKeys: [],
      clearableKeys: baseEval.clearableKeys,
      expectedSession: "2026-11-23",
      monitoredKeys: baseEval.monitoredKeys,
      now: NOW,
      pendingDelivery: null,
      pendingEventId: null,
      stale: [],
      updatedAt: null,
    });
    expect(diff.action).toBe("noop");
    expect(diff.alert).toBeNull();
  });

  it("blocks concurrent double-send within the 60 s in-flight lease and allows retry after expiry", () => {
    const inFlight = diffFreshnessIncident({
      activeKeys: [],
      clearableKeys: baseEval.clearableKeys.filter(
        (k) => k !== freshnessKeyOf(spySeriesStale)
      ),
      expectedSession: "2026-11-23",
      monitoredKeys: baseEval.monitoredKeys,
      now: NOW,
      pendingDelivery: "pending",
      pendingEventId: "evt-1",
      stale: [spySeriesStale],
      updatedAt: new Date(
        NOW.getTime() - (OPENBB_FRESHNESS_IN_FLIGHT_LEASE_MS - 1000)
      ),
    });
    expect(inFlight.action).toBe("in-flight");
    expect(inFlight.alert).toBeNull();

    const expired = diffFreshnessIncident({
      activeKeys: [],
      clearableKeys: baseEval.clearableKeys.filter(
        (k) => k !== freshnessKeyOf(spySeriesStale)
      ),
      expectedSession: "2026-11-23",
      monitoredKeys: baseEval.monitoredKeys,
      now: NOW,
      pendingDelivery: "pending",
      pendingEventId: "evt-1",
      stale: [spySeriesStale],
      updatedAt: new Date(NOW.getTime() - OPENBB_FRESHNESS_IN_FLIGHT_LEASE_MS),
    });
    expect(expired.action).toBe("alert");
    expect(expired.newlyStale).toEqual([spySeriesStale]);

    // Phase 4 chat handoff: pendingDelivery "not-configured" or "failed" also honors the 60 s lease
    for (const pendingDelivery of ["not-configured", "failed"] as const) {
      const handoff = diffFreshnessIncident({
        activeKeys: [],
        clearableKeys: baseEval.clearableKeys.filter(
          (k) => k !== freshnessKeyOf(spySeriesStale)
        ),
        expectedSession: "2026-11-23",
        monitoredKeys: baseEval.monitoredKeys,
        now: NOW,
        pendingDelivery,
        pendingEventId: "evt-phase4",
        stale: [spySeriesStale],
        updatedAt: new Date(NOW.getTime() - 15_000),
      });
      expect(handoff.action).toBe("in-flight");
    }
  });

  it("handles open -> repeat noop -> expansion -> partial prune -> re-break -> hysteresis -> full recovery", () => {
    const open = diffFreshnessIncident({
      activeKeys: [],
      clearableKeys: baseEval.clearableKeys.filter(
        (k) => k !== "daily_series:SPY"
      ),
      expectedSession: "2026-11-23",
      monitoredKeys: baseEval.monitoredKeys,
      now: NOW,
      pendingDelivery: null,
      pendingEventId: null,
      stale: [spySeriesStale],
      updatedAt: null,
    });
    expect(open.action).toBe("alert");
    expect(open.nextActiveKeys).toEqual(["daily_series:SPY"]);
    expect(open.idempotencySource).toBe(
      "price-freshness:alert:2026-11-23:daily_series:SPY"
    );

    // Repeat with same stale key -> noop
    const repeat = diffFreshnessIncident({
      activeKeys: ["daily_series:SPY"],
      clearableKeys: baseEval.clearableKeys.filter(
        (k) => k !== "daily_series:SPY"
      ),
      expectedSession: "2026-11-23",
      monitoredKeys: baseEval.monitoredKeys,
      now: NOW,
      pendingDelivery: null,
      pendingEventId: null,
      stale: [spySeriesStale],
      updatedAt: null,
    });
    expect(repeat.action).toBe("noop");

    // Second unit joins -> alerts ONLY for newlyStale (QQQ bars), nextActive has both
    const expand = diffFreshnessIncident({
      activeKeys: ["daily_series:SPY"],
      clearableKeys: baseEval.clearableKeys.filter(
        (k) => k !== "daily_series:SPY" && k !== "daily_bars:QQQ"
      ),
      expectedSession: "2026-11-23",
      monitoredKeys: baseEval.monitoredKeys,
      now: NOW,
      pendingDelivery: null,
      pendingEventId: null,
      stale: [spySeriesStale, qqqBarsStale],
      updatedAt: null,
    });
    expect(expand.action).toBe("alert");
    expect(expand.newlyStale).toEqual([qqqBarsStale]);
    expect(expand.alert?.title).toBe(
      "Vertex: 1 daily price/bar series stale (2026-11-23)"
    );
    expect(expand.alert?.body).toContain("QQQ 1d bars (3d, last 2026-11-18)");
    expect(expand.alert?.body).toContain("Total stale: 2/45");
    expect(expand.nextActiveKeys).toEqual([
      "daily_bars:QQQ",
      "daily_series:SPY",
    ]);

    // Partial recovery: SPY catches up (clearable), QQQ stays stale -> prune-active (no alert)
    const partial = diffFreshnessIncident({
      activeKeys: ["daily_bars:QQQ", "daily_series:SPY"],
      clearableKeys: baseEval.clearableKeys.filter(
        (k) => k !== "daily_bars:QQQ"
      ),
      expectedSession: "2026-11-23",
      monitoredKeys: baseEval.monitoredKeys,
      now: NOW,
      pendingDelivery: null,
      pendingEventId: null,
      stale: [qqqBarsStale],
      updatedAt: null,
    });
    expect(partial.action).toBe("prune-active");
    expect(partial.alert).toBeNull();
    expect(partial.nextActiveKeys).toEqual(["daily_bars:QQQ"]);

    // Hysteresis: QQQ moves to 2 sessions behind (neither stale nor clearable) -> stays active, noop
    const hysteresis = diffFreshnessIncident({
      activeKeys: ["daily_bars:QQQ"],
      clearableKeys: baseEval.clearableKeys.filter(
        (k) => k !== "daily_bars:QQQ"
      ),
      expectedSession: "2026-11-23",
      monitoredKeys: baseEval.monitoredKeys,
      now: NOW,
      pendingDelivery: null,
      pendingEventId: null,
      stale: [],
      updatedAt: null,
    });
    expect(hysteresis.action).toBe("noop");
    expect(hysteresis.nextActiveKeys).toEqual(["daily_bars:QQQ"]);

    // Full recovery: QQQ clears (<= 1 session behind) -> recovery alert
    const recovered = diffFreshnessIncident({
      activeKeys: ["daily_bars:QQQ"],
      clearableKeys: baseEval.clearableKeys,
      expectedSession: "2026-11-23",
      monitoredKeys: baseEval.monitoredKeys,
      now: NOW,
      pendingDelivery: null,
      pendingEventId: null,
      stale: [],
      updatedAt: null,
    });
    expect(recovered.action).toBe("recovery");
    expect(recovered.nextActiveKeys).toEqual([]);
    expect(recovered.idempotencySource).toBe(
      "price-freshness:recovery:2026-11-23:daily_bars:QQQ"
    );
  });

  it("clears obsolete pending state silently when heal-before-delivery or expansion-heal happens, and prunes retired keys", () => {
    // Undelivered alert healed before retry (activeKeys still [], pendingEventId set)
    const healedBeforeSend = diffFreshnessIncident({
      activeKeys: [],
      clearableKeys: baseEval.clearableKeys,
      expectedSession: "2026-11-23",
      monitoredKeys: baseEval.monitoredKeys,
      now: NOW,
      pendingDelivery: "failed",
      pendingEventId: "evt-stale",
      stale: [],
      updatedAt: new Date(NOW.getTime() - 120_000),
    });
    expect(healedBeforeSend.action).toBe("clear-pending");
    expect(healedBeforeSend.alert).toBeNull();

    // Expanded alert failed delivery, then newly stale QQQ healed while SPY stayed stale
    const expandedHealed = diffFreshnessIncident({
      activeKeys: ["daily_series:SPY"],
      clearableKeys: baseEval.clearableKeys.filter(
        (k) => k !== "daily_series:SPY"
      ),
      expectedSession: "2026-11-23",
      monitoredKeys: baseEval.monitoredKeys,
      now: NOW,
      pendingDelivery: "failed",
      pendingEventId: "evt-expand",
      stale: [spySeriesStale],
      updatedAt: new Date(NOW.getTime() - 120_000),
    });
    expect(expandedHealed.action).toBe("clear-pending");

    // Retired key no longer in monitoredKeys is silently pruned rather than trapped forever
    const retired = diffFreshnessIncident({
      activeKeys: ["daily_series:RETIRED_OLD", "daily_series:SPY"],
      clearableKeys: baseEval.clearableKeys.filter(
        (k) => k !== "daily_series:SPY"
      ),
      expectedSession: "2026-11-23",
      monitoredKeys: baseEval.monitoredKeys,
      now: NOW,
      pendingDelivery: null,
      pendingEventId: null,
      stale: [spySeriesStale],
      updatedAt: null,
    });
    expect(retired.action).toBe("prune-active");
    expect(retired.nextActiveKeys).toEqual(["daily_series:SPY"]);

    // Single retired active key with everything else healthy triggers recovery
    const retiredOnly = diffFreshnessIncident({
      activeKeys: ["daily_series:RETIRED_OLD"],
      clearableKeys: baseEval.clearableKeys,
      expectedSession: "2026-11-23",
      monitoredKeys: baseEval.monitoredKeys,
      now: NOW,
      pendingDelivery: null,
      pendingEventId: null,
      stale: [],
      updatedAt: null,
    });
    expect(retiredOnly.action).toBe("recovery");
  });

  it("rejects malformed or impossible ISO dates in nyseSessionsBehind instead of returning 0", () => {
    expect(() => nyseSessionsBehind("not-a-date", "2026-11-23")).toThrow(
      "Invalid ISO date"
    );
    expect(() => nyseSessionsBehind("2026-02-30", "2026-11-23")).toThrow(
      "Invalid ISO calendar date"
    );
    expect(() => nyseSessionsBehind("2026-11-20", "2026-13-01")).toThrow(
      "Invalid ISO calendar date"
    );
  });
});
