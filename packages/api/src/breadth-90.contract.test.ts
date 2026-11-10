import { describe, expect, it } from "vitest";

import { appContract } from "./contract.ts";
import {
  BREADTH90_MAX_COLLECT_DAYS,
  BREADTH90_THRESHOLDS,
  Breadth90CollectInputSchema,
  Breadth90GetInputSchema,
  Breadth90GetOutputSchema,
} from "./contracts/breadth-90.ts";

// The exact body scripts/breadth-90/tick.ts pushes (pushToVertex).
const tickPush = () => ({
  armedOn: "2026-10-28",
  asOf: "2026-11-06T21:15:00.000Z",
  basket: {
    asOf: "2026-11-05",
    reportPath: "~/Documents/reports/trading/dip-basket/report.md",
    rulesNote: "Research only.",
    summary: "Dip basket: 3 tiers",
    tiers: [
      {
        id: "core",
        label: "Core",
        tickers: ["SPY", "QQQ"],
        weightPctNlv: 20,
      },
      { id: "tier-2", label: "Tier 2", tickers: [], weightPctNlv: null },
    ],
  },
  days: [
    {
      adv: 610,
      advPct: 20.9,
      date: "2026-10-28",
      decl: 2300,
      dvol: 1_500_000_000,
      final: true,
      kind: "DOWN_90",
      source: "tradingview",
      sourceAsOf: "2026-10-28T21:10:00.000Z",
      upPct: 8.4,
      uvol: 137_000_000,
    },
    {
      adv: 2500,
      advPct: null,
      date: "2026-11-06",
      decl: 0,
      dvol: 90_000_000,
      final: false,
      kind: "UP_90",
      source: "wsj",
      sourceAsOf: "11/06/26 3:30 PM EST",
      upPct: 93.1,
      uvol: 1_210_000_000,
    },
  ],
  events: [
    {
      advPct: 20.9,
      armedOn: "2026-10-28",
      date: "2026-10-28",
      grade: null,
      kind: "ARMED",
      strict: true,
      tier: "strict",
      trigger: null,
      upPct: 8.4,
    },
    {
      advPct: null,
      armedOn: "2026-10-28",
      date: "2026-11-06",
      grade: "volume-only",
      kind: "FORMING",
      strict: true,
      tier: "volume-only",
      trigger: "UP_90",
      upPct: 93.1,
    },
  ],
  sessionsLeft: 23,
  state: "FORMING",
  strict: true,
});

describe("breadth90 contract", () => {
  it("is registered with collect and get", () => {
    expect(Object.keys(appContract.breadth90).sort()).toEqual([
      "collect",
      "get",
    ]);
  });

  it("accepts the tick push unchanged", () => {
    expect(Breadth90CollectInputSchema.parse(tickPush())).toEqual(tickPush());
    expect(
      Breadth90CollectInputSchema.parse({
        ...tickPush(),
        armedOn: null,
        basket: {
          asOf: null,
          reportPath: null,
          rulesNote: null,
          summary: null,
          tiers: [],
        },
        events: [],
        sessionsLeft: null,
        state: "IDLE",
        strict: false,
      }).state
    ).toBe("IDLE");
  });

  it("rejects malformed pushes", () => {
    const push = tickPush();
    const [dayOne] = push.days;
    const [eventOne] = push.events;
    for (const bad of [
      { ...push, state: "ARMING" },
      { ...push, asOf: "yesterday" },
      { ...push, armedOn: "10/28/2026" },
      { ...push, sessionsLeft: -1 },
      { ...push, sessionsLeft: 1.5 },
      { ...push, extra: true },
      { ...push, basket: { ...push.basket, extra: 1 } },
      { ...push, days: [{ ...dayOne, upPct: 100.5 }] },
      { ...push, days: [{ ...dayOne, advPct: -1 }] },
      { ...push, days: [{ ...dayOne, uvol: -1 }] },
      { ...push, days: [{ ...dayOne, kind: "UP_70" }] },
      { ...push, days: [{ ...dayOne, source: "" }] },
      { ...push, days: [{ ...dayOne, sourceAsOf: "" }] },
      { ...push, days: [{ ...dayOne, uvol: Number.POSITIVE_INFINITY }] },
      { ...push, events: [{ ...eventOne, tier: "gold" }] },
      { ...push, events: [{ ...eventOne, trigger: "UP_95" }] },
      { ...push, events: [{ ...eventOne, grade: "minor" }] },
      { ...push, events: [{ ...eventOne, kind: "SOLD" }] },
      {
        ...push,
        days: Array.from(
          { length: BREADTH90_MAX_COLLECT_DAYS + 1 },
          () => dayOne
        ),
      },
    ])
      expect(Breadth90CollectInputSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects duplicate sessions and events with a clear message", () => {
    const push = tickPush();
    const [dayOne] = push.days;
    const [eventOne] = push.events;
    const days = Breadth90CollectInputSchema.safeParse({
      ...push,
      days: [dayOne, { ...dayOne, final: false }],
    });
    expect(days.error?.issues).toEqual([
      expect.objectContaining({
        message: `days must have unique dates; ${dayOne?.date} appears twice`,
        path: ["days", 1],
      }),
    ]);
    const events = Breadth90CollectInputSchema.safeParse({
      ...push,
      events: [eventOne, { ...eventOne, grade: "volume-only" }],
    });
    expect(events.error?.issues).toEqual([
      expect.objectContaining({
        message: `events must be unique by (kind, date, tier); ${eventOne?.kind}|${eventOne?.date}|${eventOne?.tier} appears twice`,
        path: ["events", 1],
      }),
    ]);
    // The same date under another kind or tier is a different event.
    expect(
      Breadth90CollectInputSchema.safeParse({
        ...push,
        events: [eventOne, { ...eventOne, tier: "standard" }],
      }).success
    ).toBe(true);
  });

  it("takes no get input and describes the card output", () => {
    expect(Breadth90GetInputSchema.parse({})).toEqual({});
    expect(Breadth90GetInputSchema.safeParse({ limit: 5 }).success).toBe(false);
    expect(
      Breadth90GetOutputSchema.parse({
        days: [],
        events: [],
        status: null,
        thresholds: BREADTH90_THRESHOLDS,
      })
    ).toEqual({
      days: [],
      events: [],
      status: null,
      thresholds: { down80: 20, down90: 10, up80: 80, up90: 90 },
    });
  });
});
