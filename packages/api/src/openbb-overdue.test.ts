import { describe, expect, it } from "vitest";

import {
  OPENBB_JOB_METADATA,
  OPENBB_JOBS,
  OpenbbIngestBatchSchema,
  OpenbbIngestInputSchema,
} from "./contracts/openbb.ts";
import { previousNyseTradingDay, utcDay } from "./nyse-calendar.ts";
import {
  diffOverdueIncident,
  elapsedTradingDayMs,
  evaluateForm4Overdue,
  evaluateOpenbbSources,
  formatOverdueAlertMessage,
  formatOverdueRecoveryMessage,
  isMarketPremiumSessionOpen,
  NON_PREMIUM_FLOW_SOURCES,
  nyWallTimeUtcMs,
  OPENBB_MONITORED_OVERDUE_KEYS,
  type OverdueJobRunInput,
  sourceKeyOf,
  tradingDayDeadline,
} from "./openbb-overdue.ts";

const HOUR_MS = 3_600_000;

const healthyRuns = (at: Date): OverdueJobRunInput[] =>
  OPENBB_JOBS.map((job) => ({
    job,
    latest: { error: null, finishedAt: at, status: "ok" },
    latestUsable: { finishedAt: at, status: "ok" },
  }));

describe("nyWallTimeUtcMs, elapsedTradingDayMs, and tradingDayDeadline", () => {
  it("handles DST spring-forward (23 h Sunday) and fall-back (25 h Sunday) accurately", () => {
    // 2026-03-08 is US DST spring-forward Sunday; 2026-03-09 Monday is EDT (UTC-4).
    const sunStart = nyWallTimeUtcMs(utcDay(2026, 2, 8), 0, 0);
    const monStart = nyWallTimeUtcMs(utcDay(2026, 2, 9), 0, 0);
    expect((monStart - sunStart) / HOUR_MS).toBe(23);
    expect(new Date(monStart).toISOString()).toBe("2026-03-09T04:00:00.000Z");

    // 2026-11-01 is US DST fall-back Sunday; 2026-11-02 Monday is EST (UTC-5).
    const fallSunStart = nyWallTimeUtcMs(utcDay(2026, 10, 1), 0, 0);
    const fallMonStart = nyWallTimeUtcMs(utcDay(2026, 10, 2), 0, 0);
    expect((fallMonStart - fallSunStart) / HOUR_MS).toBe(25);
    expect(new Date(fallMonStart).toISOString()).toBe(
      "2026-11-02T05:00:00.000Z"
    );
  });

  it("pauses trading-day clock over weekends and NYSE holidays", () => {
    // 2026-07-02 Thu 18:00 EDT (22:00Z) -> 2026-07-06 Mon 12:00 EDT (16:00Z).
    // 2026-07-03 Fri is Independence Day observed (NYSE closed), Sat/Sun closed.
    // Thu remaining = 6 h (18:00..24:00 EDT), Mon = 12 h (00:00..12:00 EDT) => 18 h.
    const thu = new Date("2026-07-02T22:00:00.000Z");
    const mon = new Date("2026-07-06T16:00:00.000Z");
    expect(elapsedTradingDayMs(thu, mon) / HOUR_MS).toBe(18);
    expect(elapsedTradingDayMs(mon, thu)).toBe(0);

    // 30 trading-day hours from Thu 18:00 EDT = 6 h Thu + 24 h Mon => Tue 00:00 EDT (04:00Z).
    const deadline = tradingDayDeadline(thu, 30 * HOUR_MS);
    expect(deadline.toISOString()).toBe("2026-07-07T04:00:00.000Z");
    expect(elapsedTradingDayMs(thu, deadline)).toBe(30 * HOUR_MS);
  });

  it("finds previousNyseTradingDay skipping weekends and holidays", () => {
    // Monday 2026-07-06 -> Thursday 2026-07-02 (Friday 2026-07-03 is observed July 4th)
    expect(previousNyseTradingDay(utcDay(2026, 6, 6))).toBe("2026-07-02");
    // Tuesday 2026-11-24 -> Monday 2026-11-23
    expect(previousNyseTradingDay(utcDay(2026, 10, 24))).toBe("2026-11-23");
  });
});

describe("isMarketPremiumSessionOpen", () => {
  it("is true during NYSE trading hours 09:30-16:14 ET and false outside or on holidays", () => {
    // Mon 2026-11-23 (EST, UTC-5): 09:29 ET = 14:29Z, 09:30 ET = 14:30Z, 16:15 ET = 21:15Z
    expect(isMarketPremiumSessionOpen(new Date("2026-11-23T14:29:00Z"))).toBe(
      false
    );
    expect(isMarketPremiumSessionOpen(new Date("2026-11-23T14:30:00Z"))).toBe(
      true
    );
    expect(isMarketPremiumSessionOpen(new Date("2026-11-23T21:14:00Z"))).toBe(
      true
    );
    expect(isMarketPremiumSessionOpen(new Date("2026-11-23T21:15:00Z"))).toBe(
      false
    );
    // Thanksgiving 2026-11-26 Thu at 12:00 ET (17:00Z)
    expect(isMarketPremiumSessionOpen(new Date("2026-11-26T17:00:00Z"))).toBe(
      false
    );
    // Sunday 2026-11-22 at 12:00 ET
    expect(isMarketPremiumSessionOpen(new Date("2026-11-22T17:00:00Z"))).toBe(
      false
    );
  });

  it("ends at 13:15 ET on an NYSE early close", () => {
    // Fri 2026-11-27 (day after Thanksgiving, EST): 13:14 ET = 18:14Z, 13:15 ET = 18:15Z
    expect(isMarketPremiumSessionOpen(new Date("2026-11-27T18:14:00Z"))).toBe(
      true
    );
    expect(isMarketPremiumSessionOpen(new Date("2026-11-27T18:15:00Z"))).toBe(
      false
    );
  });
});

describe("evaluateOpenbbSources on an NYSE early close", () => {
  const evaluateAt = (
    now: Date,
    flow: NonNullable<Parameters<typeof evaluateOpenbbSources>[0]["flow"]>
  ) => {
    const evaluation = evaluateOpenbbSources({
      flow,
      form4Days: [],
      now,
      runs: healthyRuns(now),
      shortVolumeNewestDate: null,
    });
    return {
      clearable: evaluation.clearableKeys,
      overdue: new Map(
        evaluation.sources.map((source) => [
          sourceKeyOf(source),
          source.overdue,
        ])
      ),
    };
  };
  const samplesAt = (options: Date, depth: Date) => ({
    marketPremiumSessions: [],
    samples: {
      latest: [],
      latestOk: [
        {
          at: options,
          message: null,
          source: "options" as const,
          status: "ok",
        },
        { at: depth, message: null, source: "depth" as const, status: "ok" },
      ],
    },
  });

  it("expects no option or stock tape sample after the early close", () => {
    // 2026-11-27 14:00 ET; newest options read 13:10 ET, newest depth read 12:59 ET.
    const early = evaluateAt(
      new Date("2026-11-27T19:00:00Z"),
      samplesAt(
        new Date("2026-11-27T18:10:00Z"),
        new Date("2026-11-27T17:59:00Z")
      )
    );
    expect(early.overdue.get("flow:options")).toBe(false);
    expect(early.overdue.get("flow:depth")).toBe(false);
    // Control: the same clock times on a regular Friday are overdue.
    const regular = evaluateAt(
      new Date("2026-11-20T19:00:00Z"),
      samplesAt(
        new Date("2026-11-20T18:10:00Z"),
        new Date("2026-11-20T17:59:00Z")
      )
    );
    expect(regular.overdue.get("flow:options")).toBe(true);
    expect(regular.overdue.get("flow:depth")).toBe(true);
  });

  it("clears the market premium alert from a capture at or after 12:45 ET", () => {
    const session = (capturedAt: Date) => ({
      marketPremiumSessions: [
        {
          capturedAt,
          lastAttemptAt: capturedAt,
          lastMessage: null,
          sessionDate: "2026-11-27",
          status: "partial" as const,
        },
      ],
    });
    const now = new Date("2026-11-27T18:30:00Z"); // 13:30 ET
    expect(
      evaluateAt(now, session(new Date("2026-11-27T18:00:00Z"))).clearable
    ).toContain("flow:market_premium");
    expect(
      evaluateAt(now, session(new Date("2026-11-27T17:40:00Z"))).clearable
    ).not.toContain("flow:market_premium");
  });
});

describe("evaluateForm4Overdue", () => {
  const now = new Date("2026-11-23T15:30:00.000Z"); // Mon 10:30 ET

  it("is healthy with recent usable run and complete index day", () => {
    const res = evaluateForm4Overdue({
      days: [{ complete: true, indexDay: "2026-11-20" }],
      lastOkAt: new Date("2026-11-23T12:00:00.000Z"),
      now,
    });
    expect(res).toEqual({
      incompleteDays: [],
      newestCompleteDay: "2026-11-20",
      overdue: false,
      overdueSince: null,
      reason: null,
    });
  });

  it("marks overdue when never run, run older than 30 h, incomplete index day, or no complete day in 7d", () => {
    expect(
      evaluateForm4Overdue({ days: [], lastOkAt: null, now }).overdue
    ).toBe(true);

    const staleRun = evaluateForm4Overdue({
      days: [{ complete: true, indexDay: "2026-11-20" }],
      lastOkAt: new Date(now.getTime() - 31 * HOUR_MS),
      now,
    });
    expect(staleRun.overdue).toBe(true);
    expect(staleRun.overdueSince?.toISOString()).toBe(
      new Date(now.getTime() - HOUR_MS).toISOString()
    );

    // Incomplete yesterday before 10:00 ET is not overdue; at 10:00 ET it is overdue
    const before10 = new Date("2026-11-23T14:59:00.000Z"); // 09:59 ET
    expect(
      evaluateForm4Overdue({
        days: [
          { complete: false, indexDay: "2026-11-22" },
          { complete: true, indexDay: "2026-11-20" },
        ],
        lastOkAt: new Date("2026-11-23T12:00:00.000Z"),
        now: before10,
      }).overdue
    ).toBe(false);

    const at10 = new Date("2026-11-23T15:00:00.000Z"); // 10:00 ET
    const lateYday = evaluateForm4Overdue({
      days: [
        { complete: false, indexDay: "2026-11-22" },
        { complete: true, indexDay: "2026-11-20" },
      ],
      lastOkAt: new Date("2026-11-23T12:00:00.000Z"),
      now: at10,
    });
    expect(lateYday.overdue).toBe(true);
    expect(lateYday.reason).toContain("2026-11-22");

    // Incomplete older than yesterday is overdue even before 10:00 ET, anchored to earliest late day + 1 at 10:00 ET
    const olderLate = evaluateForm4Overdue({
      days: [
        { complete: false, indexDay: "2026-11-20" },
        { complete: false, indexDay: "2026-11-18" },
        { complete: false, indexDay: "2026-11-19" },
        { complete: true, indexDay: "2026-11-21" },
      ],
      lastOkAt: new Date("2026-11-23T12:00:00.000Z"),
      now: before10,
    });
    expect(olderLate.overdue).toBe(true);
    expect(olderLate.overdueSince?.toISOString()).toBe(
      "2026-11-19T15:00:00.000Z"
    );

    // No complete day in last 7 calendar days
    const noWeek = evaluateForm4Overdue({
      days: [{ complete: true, indexDay: "2026-11-10" }],
      lastOkAt: new Date("2026-11-23T12:00:00.000Z"),
      now,
    });
    expect(noWeek.overdue).toBe(true);
    expect(noWeek.reason).toContain("last 7 days");
  });
});

describe("evaluateOpenbbSources", () => {
  const now = new Date("2026-11-23T16:00:00.000Z"); // Mon 11:00 ET (in session)

  it("marks every monitored source healthy when fresh", () => {
    const evalRes = evaluateOpenbbSources({
      flow: {
        marketPremiumSessions: [
          {
            capturedAt: new Date("2026-11-23T15:50:00.000Z"),
            lastAttemptAt: new Date("2026-11-23T15:50:00.000Z"),
            lastMessage: null,
            sessionDate: "2026-11-23",
            status: "partial",
          },
        ],
        samples: {
          latest: NON_PREMIUM_FLOW_SOURCES.map((source) => ({
            at: new Date("2026-11-23T15:59:00.000Z"),
            message: null,
            source,
            status: "ok",
          })),
          latestOk: NON_PREMIUM_FLOW_SOURCES.map((source) => ({
            at: new Date("2026-11-23T15:59:00.000Z"),
            message: null,
            source,
            status: "ok",
          })),
        },
      },
      form4Days: [{ complete: true, indexDay: "2026-11-20" }],
      now,
      runs: healthyRuns(new Date("2026-11-23T15:00:00.000Z")),
      shortVolumeNewestDate: "2026-11-20",
    });
    expect(evalRes.monitoredKeys).toEqual(OPENBB_MONITORED_OVERDUE_KEYS);
    expect(evalRes.overdueMonitored).toEqual([]);
    expect(evalRes.sources.every((source) => !source.overdue)).toBe(true);
  });

  it("detects overdue calendar, trading-day, blocked_upstream, FINRA 10:00 ET, and flow sources", () => {
    const longError = `HTTP 403 unavailable ${"x".repeat(350)}`;
    const runs: OverdueJobRunInput[] = healthyRuns(
      new Date("2026-11-23T15:00:00.000Z")
    ).map((entry) => {
      if (entry.job === "congress-house") {
        return {
          job: entry.job,
          latest: {
            error: longError,
            finishedAt: now,
            status: "blocked_upstream",
          },
          latestUsable: {
            finishedAt: new Date(now.getTime() - 35 * HOUR_MS),
            status: "ok",
          },
        };
      }
      if (entry.job === "congress-senate") {
        return { job: entry.job, latest: null, latestUsable: null };
      }
      if (entry.job === "cboe-vol-indices") {
        return {
          job: entry.job,
          latest: { error: null, finishedAt: now, status: "failed" },
          latestUsable: {
            finishedAt: new Date("2026-11-18T12:00:00.000Z"),
            status: "ok",
          },
        };
      }
      if (entry.job === "sec-form4") {
        return {
          job: entry.job,
          latest: {
            error: "HTTP 403 from sec.gov",
            finishedAt: now,
            status: "blocked_upstream",
          },
          latestUsable: null,
        };
      }
      return entry;
    });

    const evalRes = evaluateOpenbbSources({
      flow: {
        marketPremiumSessions: [
          {
            capturedAt: new Date("2026-11-23T14:35:00.000Z"),
            lastAttemptAt: new Date("2026-11-23T15:55:00.000Z"),
            lastMessage: "QuantData unavailable timeout",
            sessionDate: "2026-11-23",
            status: "partial",
          },
        ],
        samples: {
          latest: [
            {
              at: new Date("2026-11-23T15:59:00.000Z"),
              message: "feed timeout",
              source: "options",
              status: "failed",
            },
          ],
          latestOk: [
            {
              at: new Date("2026-11-23T15:40:00.000Z"),
              message: null,
              source: "options",
              status: "ok",
            },
            {
              at: new Date("2026-11-23T15:50:00.000Z"),
              message: null,
              source: "depth",
              status: "ok",
            },
          ],
        },
      },
      form4Days: [],
      now,
      runs,
      shortVolumeNewestDate: "2026-11-19", // behind expected Fri 2026-11-20
    });

    const byKey = new Map(evalRes.sources.map((s) => [sourceKeyOf(s), s]));
    const house = byKey.get("openbb:congress-house");
    expect(house?.overdue).toBe(true);
    expect(house?.reason).toContain("blocked upstream");
    expect(house?.reason).not.toMatch(/unavailable/iu);
    expect((house?.reason ?? "").length).toBeLessThanOrEqual(300);

    expect(byKey.get("openbb:congress-senate")?.overdue).toBe(true);
    expect(byKey.get("openbb:cboe-vol-indices")?.overdue).toBe(true);
    expect(byKey.get("openbb:sec-form4")?.overdue).toBe(true);
    expect(byKey.get("openbb:finra-short-volume")?.overdue).toBe(true);
    expect(byKey.get("openbb:finra-short-volume")?.reason).toContain(
      "2026-11-20"
    );

    const mp = byKey.get("flow:market_premium");
    expect(mp?.overdue).toBe(true);
    expect(mp?.reason).not.toMatch(/unavailable/iu);
    expect(byKey.get("flow:options")?.overdue).toBe(true);
    expect(byKey.get("flow:depth")?.overdue).toBe(true);
    expect(byKey.get("flow:ticks")?.overdue).toBe(true);
    expect(byKey.get("flow:gex")?.overdue).toBe(true);
    expect(byKey.get("flow:net_drift")?.overdue).toBe(true);
    // Only flow:market_premium is in overdueMonitored among flow sources
    expect(
      evalRes.overdueMonitored
        .filter((item) => item.kind === "flow")
        .map((i) => i.source)
    ).toEqual(["market_premium"]);
  });

  it("handles finra-short-volume null date, market_premium no-capture in session, and off-hours clearable guard", () => {
    // 1. In session at 10:05 ET with no market_premium capture yet, and null shortVolumeNewestDate
    const inSessNoCap = evaluateOpenbbSources({
      flow: { marketPremiumSessions: [] },
      form4Days: [{ complete: true, indexDay: "2026-11-20" }],
      now: new Date("2026-11-23T15:05:00.000Z"), // 10:05 ET
      runs: healthyRuns(new Date("2026-11-23T15:00:00.000Z")),
      shortVolumeNewestDate: null,
    });
    expect(
      inSessNoCap.sources.find((s) => s.source === "finra-short-volume")?.reason
    ).toContain("No short volume rows");
    expect(
      inSessNoCap.sources.find((s) => s.source === "market_premium")?.overdue
    ).toBe(true);

    // 2. In session at 09:40 ET (within first 30 min) with no capture yet: not overdue, NOT clearable
    const earlyOpen = evaluateOpenbbSources({
      flow: { marketPremiumSessions: [] },
      form4Days: [{ complete: true, indexDay: "2026-11-20" }],
      now: new Date("2026-11-23T14:40:00.000Z"), // 09:40 ET
      runs: healthyRuns(new Date("2026-11-23T14:30:00.000Z")),
      shortVolumeNewestDate: "2026-11-20",
    });
    expect(
      earlyOpen.sources.find((s) => s.source === "market_premium")?.overdue
    ).toBe(false);
    expect(earlyOpen.clearableKeys).not.toContain("flow:market_premium");

    // 3. Off-hours (16:20 ET) after a 14:00 ET partial capture: NOT overdue, NOT clearable (prevents false recovery!)
    const afterCloseStale = evaluateOpenbbSources({
      flow: {
        marketPremiumSessions: [
          {
            capturedAt: new Date("2026-11-23T19:00:00.000Z"), // 14:00 ET
            lastAttemptAt: new Date("2026-11-23T21:10:00.000Z"),
            lastMessage: "HTTP 502",
            sessionDate: "2026-11-23",
            status: "partial",
          },
        ],
        samples: { latest: [], latestOk: [] },
      },
      form4Days: [{ complete: true, indexDay: "2026-11-20" }],
      now: new Date("2026-11-23T21:20:00.000Z"), // 16:20 ET
      runs: healthyRuns(new Date("2026-11-23T21:00:00.000Z")),
      shortVolumeNewestDate: "2026-11-20",
    });
    expect(
      afterCloseStale.sources.find((s) => s.source === "market_premium")
        ?.overdue
    ).toBe(false);
    expect(afterCloseStale.clearableKeys).not.toContain("flow:market_premium");

    // 4. Off-hours after a 16:00 ET partial capture (>= 15:45 ET): IS clearable
    const afterCloseFresh = evaluateOpenbbSources({
      flow: {
        marketPremiumSessions: [
          {
            capturedAt: new Date("2026-11-23T21:00:00.000Z"), // 16:00 ET
            lastAttemptAt: new Date("2026-11-23T21:00:00.000Z"),
            lastMessage: null,
            sessionDate: "2026-11-23",
            status: "partial",
          },
        ],
      },
      form4Days: [{ complete: true, indexDay: "2026-11-20" }],
      now: new Date("2026-11-23T21:20:00.000Z"),
      runs: healthyRuns(new Date("2026-11-23T21:00:00.000Z")),
      shortVolumeNewestDate: "2026-11-20",
    });
    expect(afterCloseFresh.clearableKeys).toContain("flow:market_premium");

    // 5. Off-hours when newest session is status "complete": IS clearable
    const afterCloseComplete = evaluateOpenbbSources({
      flow: {
        marketPremiumSessions: [
          {
            capturedAt: new Date("2026-11-24T05:10:00.000Z"),
            lastAttemptAt: new Date("2026-11-24T05:10:00.000Z"),
            lastMessage: null,
            sessionDate: "2026-11-23",
            status: "complete",
          },
        ],
      },
      form4Days: [{ complete: true, indexDay: "2026-11-20" }],
      now: new Date("2026-11-24T06:00:00.000Z"),
      runs: healthyRuns(new Date("2026-11-24T05:00:00.000Z")),
      shortVolumeNewestDate: "2026-11-20",
    });
    expect(afterCloseComplete.clearableKeys).toContain("flow:market_premium");

    // 5b. Weekend with empty sessions and empty flow samples (covers !isNyseTradingDay for flow samples & newestSession === undefined)
    const weekendEmpty = evaluateOpenbbSources({
      flow: {
        marketPremiumSessions: [],
        samples: { latest: [], latestOk: [] },
      },
      form4Days: [{ complete: true, indexDay: "2026-11-20" }],
      now: new Date("2026-11-22T17:00:00.000Z"), // Sunday 12:00 ET
      runs: healthyRuns(new Date("2026-11-22T15:00:00.000Z")),
      shortVolumeNewestDate: "2026-11-20",
    });
    expect(weekendEmpty.sources.every((s) => !s.overdue)).toBe(true);

    // 5c. Multiple sessions trigger newest-first sort comparator
    const multiSessions = evaluateOpenbbSources({
      flow: {
        marketPremiumSessions: [
          {
            capturedAt: new Date("2026-11-20T21:00:00.000Z"),
            lastAttemptAt: new Date("2026-11-20T21:00:00.000Z"),
            lastMessage: null,
            sessionDate: "2026-11-20",
            status: "complete",
          },
          {
            capturedAt: new Date("2026-11-23T21:00:00.000Z"),
            lastAttemptAt: new Date("2026-11-23T21:00:00.000Z"),
            lastMessage: null,
            sessionDate: "2026-11-23",
            status: "partial",
          },
        ],
      },
      form4Days: [{ complete: true, indexDay: "2026-11-20" }],
      now: new Date("2026-11-23T21:20:00.000Z"),
      runs: healthyRuns(new Date("2026-11-23T21:00:00.000Z")),
      shortVolumeNewestDate: "2026-11-20",
    });
    expect(multiSessions.clearableKeys).toContain("flow:market_premium");

    // 5b. Off-hours after close on Mon 2026-11-23 when today has NO session row (only Fri 2026-11-20 complete): NOT clearable
    const missedTodayAfterClose = evaluateOpenbbSources({
      flow: {
        marketPremiumSessions: [
          {
            capturedAt: new Date("2026-11-20T21:00:00.000Z"),
            lastAttemptAt: new Date("2026-11-21T05:00:00.000Z"),
            lastMessage: null,
            sessionDate: "2026-11-20",
            status: "complete",
          },
        ],
        samples: { latest: [], latestOk: [] },
      },
      form4Days: [{ complete: true, indexDay: "2026-11-20" }],
      now: new Date("2026-11-23T21:20:00.000Z"), // Mon 16:20 ET (post-close)
      runs: healthyRuns(new Date("2026-11-23T21:00:00.000Z")),
      shortVolumeNewestDate: "2026-11-20",
    });
    expect(missedTodayAfterClose.clearableKeys).not.toContain(
      "flow:market_premium"
    );

    // 5c. Off-hours pre-open Tue 2026-11-24 08:00 ET when Mon 2026-11-23 is complete: clearable
    const preOpenComplete = evaluateOpenbbSources({
      flow: {
        marketPremiumSessions: [
          {
            capturedAt: new Date("2026-11-23T21:00:00.000Z"),
            lastAttemptAt: new Date("2026-11-24T05:00:00.000Z"),
            lastMessage: null,
            sessionDate: "2026-11-23",
            status: "complete",
          },
        ],
        samples: { latest: [], latestOk: [] },
      },
      form4Days: [{ complete: true, indexDay: "2026-11-23" }],
      now: new Date("2026-11-24T13:00:00.000Z"), // Tue 08:00 ET (pre-open)
      runs: healthyRuns(new Date("2026-11-24T12:00:00.000Z")),
      shortVolumeNewestDate: "2026-11-20",
    });
    expect(preOpenComplete.clearableKeys).toContain("flow:market_premium");

    // 5c2. Weekday NYSE holiday (Thanksgiving Thu 2026-11-26) with a holiday unavailable/no_data row does NOT shadow Wed 2026-11-25 complete
    const holidayShadow = evaluateOpenbbSources({
      flow: {
        marketPremiumSessions: [
          {
            capturedAt: null,
            lastAttemptAt: new Date("2026-11-26T16:00:00.000Z"),
            lastMessage: "market closed",
            sessionDate: "2026-11-26",
            status: "unavailable",
          },
          {
            capturedAt: new Date("2026-11-25T21:00:00.000Z"),
            lastAttemptAt: new Date("2026-11-26T05:00:00.000Z"),
            lastMessage: null,
            sessionDate: "2026-11-25",
            status: "complete",
          },
        ],
        samples: { latest: [], latestOk: [] },
      },
      form4Days: [{ complete: true, indexDay: "2026-11-25" }],
      now: new Date("2026-11-27T13:00:00.000Z"), // Fri 2026-11-27 08:00 ET (pre-open after Thanksgiving)
      runs: healthyRuns(new Date("2026-11-27T12:00:00.000Z")),
      shortVolumeNewestDate: "2026-11-25",
    });
    expect(holidayShadow.clearableKeys).toContain("flow:market_premium");

    // 5d. finra-short-volume stays overdue past midnight (Tue 00:05 ET) and on weekends when behind previous trading day
    const finraMidnight = evaluateOpenbbSources({
      form4Days: [{ complete: true, indexDay: "2026-11-23" }],
      now: new Date("2026-11-24T05:05:00.000Z"), // Tue 00:05 ET (latestDueTradingDay = Mon 2026-11-23, expects Fri 2026-11-20)
      runs: healthyRuns(new Date("2026-11-24T04:00:00.000Z")),
      shortVolumeNewestDate: "2026-11-19",
    });
    const finraMidEntry = finraMidnight.sources.find(
      (src) => src.source === "finra-short-volume"
    );
    expect(finraMidEntry?.overdue).toBe(true);
    expect(finraMidEntry?.overdueSince?.toISOString()).toBe(
      "2026-11-23T15:00:00.000Z"
    );
    expect(finraMidnight.clearableKeys).not.toContain(
      "openbb:finra-short-volume"
    );

    const finraWeekend = evaluateOpenbbSources({
      form4Days: [{ complete: true, indexDay: "2026-11-20" }],
      now: new Date("2026-11-21T17:00:00.000Z"), // Sat 12:00 ET (latestDueTradingDay = Fri 2026-11-20, expects Thu 2026-11-19)
      runs: healthyRuns(new Date("2026-11-21T16:00:00.000Z")),
      shortVolumeNewestDate: "2026-11-18",
    });
    expect(
      finraWeekend.sources.find((src) => src.source === "finra-short-volume")
        ?.overdue
    ).toBe(true);

    // 6. Without flow input, only OpenBB sources are returned
    const noFlow = evaluateOpenbbSources({
      form4Days: [{ complete: true, indexDay: "2026-11-20" }],
      now: new Date("2026-11-23T15:05:00.000Z"),
      runs: healthyRuns(new Date("2026-11-23T15:00:00.000Z")),
      shortVolumeNewestDate: "2026-11-20",
    });
    expect(noFlow.sources).toHaveLength(OPENBB_JOBS.length);
  });
});

describe("diffOverdueIncident and message formatting", () => {
  const now = new Date("2026-11-23T16:00:00.000Z");
  const makeOverdue = (source: string, overdueSince: Date | null = now) => ({
    kind: "openbb" as const,
    label: source,
    lastOkAt: null,
    lastRunAt: null,
    lastStatus: null,
    maxAgeSeconds: 108_000,
    overdue: true,
    overdueSince,
    reason: "stale",
    smartMoney: true,
    source,
  });

  it("formats alert messages with singular/plural and +N overflow cap, plus recovery", () => {
    const single = formatOverdueAlertMessage(
      [makeOverdue("congress-house", null)],
      1,
      23
    );
    expect(single.title).toBe("Vertex: 1 data source overdue");
    expect(single.body).toContain("congress-house (no usable run)");

    // When overdueSince is null but a usable run exists (e.g. Form 4 no complete day in 7d), use reason (or "overdue")
    const withReason = formatOverdueAlertMessage(
      [
        {
          ...makeOverdue("sec-form4", null),
          lastOkAt: now,
          reason: "No complete Form 4 index day in the last 7 days",
        },
        {
          ...makeOverdue("sec-13f", null),
          lastOkAt: now,
          reason: null,
        },
      ],
      2,
      23
    );
    expect(withReason.body).toContain(
      "sec-form4 (No complete Form 4 index day in the last 7 days)"
    );
    expect(withReason.body).toContain("sec-13f (overdue)");

    const many = formatOverdueAlertMessage(
      Array.from({ length: 10 }, (_, idx) => makeOverdue(`job-${idx}`, now)),
      10,
      23
    );
    expect(many.title).toBe("Vertex: 10 data sources overdue");
    expect(many.body).toContain("+2 more");
    expect(many.body).toContain("10/23");

    const rec = formatOverdueRecoveryMessage(2, 23);
    expect(rec.title).toContain("current again");
    expect(rec.body).toContain("2 recovered");
  });

  it("covers all 6 diffOverdueIncident actions and anchors idempotencySource on lastTransitionAt", () => {
    const monitored = ["openbb:congress-house", "openbb:congress-senate"];
    const house = makeOverdue("congress-house");

    // 1. in-flight lease
    expect(
      diffOverdueIncident({
        activeKeys: [],
        clearableKeys: monitored,
        lastTransitionAt: null,
        monitoredKeys: monitored,
        now,
        overdue: [house],
        pendingEventId: "evt-1",
        updatedAt: new Date(now.getTime() - 10_000),
      }).action
    ).toBe("in-flight");

    // 2. alert (with distinct idempotency keys before vs after a recovery transition)
    const alert1 = diffOverdueIncident({
      activeKeys: [],
      clearableKeys: ["openbb:congress-senate"],
      lastTransitionAt: null,
      monitoredKeys: monitored,
      now,
      overdue: [house],
      pendingEventId: null,
      updatedAt: null,
    });
    expect(alert1.action).toBe("alert");
    const alert2 = diffOverdueIncident({
      activeKeys: [],
      clearableKeys: ["openbb:congress-senate"],
      lastTransitionAt: new Date("2026-11-23T15:30:00.000Z"),
      monitoredKeys: monitored,
      now,
      overdue: [house],
      pendingEventId: null,
      updatedAt: null,
    });
    expect(alert2.action).toBe("alert");
    expect(alert1.idempotencySource).not.toBe(alert2.idempotencySource);

    // 3. recovery
    const rec = diffOverdueIncident({
      activeKeys: ["openbb:congress-house"],
      clearableKeys: monitored,
      lastTransitionAt: new Date("2026-11-23T14:00:00.000Z"),
      monitoredKeys: monitored,
      now,
      overdue: [],
      pendingEventId: null,
      updatedAt: null,
    });
    expect(rec.action).toBe("recovery");
    expect(rec.nextActiveKeys).toEqual([]);

    // 4. prune-active (partial recovery)
    const prune = diffOverdueIncident({
      activeKeys: ["openbb:congress-house", "openbb:congress-senate"],
      clearableKeys: ["openbb:congress-senate"],
      lastTransitionAt: null,
      monitoredKeys: monitored,
      now,
      overdue: [house],
      pendingEventId: null,
      updatedAt: null,
    });
    expect(prune.action).toBe("prune-active");
    expect(prune.nextActiveKeys).toEqual(["openbb:congress-house"]);

    // 5. clear-pending (obsolete pending after lease expired)
    const clearPending = diffOverdueIncident({
      activeKeys: [],
      clearableKeys: monitored,
      lastTransitionAt: null,
      monitoredKeys: monitored,
      now,
      overdue: [],
      pendingEventId: "evt-old",
      updatedAt: new Date(now.getTime() - 120_000),
    });
    expect(clearPending.action).toBe("clear-pending");

    // 6. noop (steady state with unchanged activeKeys of same length and empty steady state)
    const noopActive = diffOverdueIncident({
      activeKeys: ["openbb:congress-house"],
      clearableKeys: ["openbb:congress-senate"],
      lastTransitionAt: null,
      monitoredKeys: monitored,
      now,
      overdue: [house],
      pendingEventId: null,
      updatedAt: null,
    });
    expect(noopActive.action).toBe("noop");

    const noopClean = diffOverdueIncident({
      activeKeys: [],
      clearableKeys: monitored,
      lastTransitionAt: null,
      monitoredKeys: monitored,
      now,
      overdue: [],
      pendingEventId: null,
      updatedAt: null,
    });
    expect(noopClean.action).toBe("noop");

    // Metadata coverage sanity check
    expect(Object.keys(OPENBB_JOB_METADATA).sort()).toEqual(
      [...OPENBB_JOBS].sort()
    );

    // Retired table is rejected on the table discriminator (valid row shape)
    const retiredTable = OpenbbIngestBatchSchema.safeParse({
      rows: [
        {
          accessionNumber: "0001140361-26-039785",
          acquiredDisposed: "D",
          filingDate: "2026-10-15",
          ownerName: "Example Insider",
          ownerTitle: "Officer",
          price: 100,
          rowNumber: 1,
          shares: 10,
          sharesAfter: 90,
          symbol: "AAPL",
          transactionCode: "S",
          transactionDate: "2026-10-14",
          url: "https://www.sec.gov/Archives/edgar/data/320193/000114036126039785/form4.xml",
        },
      ],
      table: "sec_insider_trades",
    });
    expect(retiredTable.success).toBe(false);
    if (!retiredTable.success) {
      expect(retiredTable.error.issues.some((i) => i.path[0] === "table")).toBe(
        true
      );
    }

    // Retired job is rejected on the job enum (valid sec_filings batch shape)
    const retiredJob = OpenbbIngestInputSchema.safeParse({
      batch: {
        rows: [
          {
            accessionNumber: "0000320193-26-000024",
            cik: "0000320193",
            description: "10-Q",
            filingDate: "2026-11-02",
            formType: "10-Q",
            reportDate: "2026-09-26",
            symbol: "AAPL",
            url: "https://www.sec.gov/Archives/edgar/data/320193/000032019326000024/aapl-20261102.htm",
          },
        ],
        table: "sec_filings",
      },
      job: "sec-insider",
    });
    expect(retiredJob.success).toBe(false);
    if (!retiredJob.success) {
      expect(retiredJob.error.issues.some((i) => i.path[0] === "job")).toBe(
        true
      );
    }
  });
});
