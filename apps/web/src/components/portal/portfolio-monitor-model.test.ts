import { describe, expect, it } from "vitest";

import {
  fixtureExecution,
  fixtureOrder,
  fixturePosition,
  fixtureSnapshot,
} from "./portfolio-monitor-fixture.ts";
import {
  CASH_SLICE,
  DASH,
  DEFAULT_COLUMN_CONFIG,
  DEFAULT_REFRESH_INTERVAL,
  DEFAULT_SORT,
  accountLabel,
  ageSeconds,
  allocationSlices,
  clock,
  completedClock,
  completedReason,
  completedToday,
  dailyPnlPct,
  donutArc,
  executionClock,
  executionsNewestFirst,
  groupOrders,
  ibkrTimeKey,
  isGatewayLive,
  isOptionPosition,
  ladderScale,
  localDayKey,
  failureGraceMs,
  failureVisible,
  monitorHealth,
  moveColumn,
  nextSort,
  normalizeColumnConfig,
  holdingKind,
  holdingBadge,
  holdingLabel,
  normalizeInterval,
  normalizeSort,
  orderStatusLabel,
  orderStatusTitle,
  orderStatusTone,
  pct,
  pnlBars,
  pnlClass,
  pnlTone,
  positionTotals,
  price,
  qty,
  signed,
  sortPositions,
  staleAfterSeconds,
  stopLadder,
  summaryStats,
  toggleColumn,
  usd,
  visibleColumns,
} from "./portfolio-monitor-model.ts";

const NOW = Date.parse("2026-10-09T15:00:00.000Z");

describe("portfolio monitor number formatting", () => {
  it("formats money, prices, quantities and percents", () => {
    expect(usd(1234.5)).toBe("$1,235");
    expect(usd(1234.5, 2)).toBe("$1,234.50");
    expect(usd(null)).toBe(DASH);
    expect(usd(Number.NaN)).toBe(DASH);
    expect(price(123.456)).toBe("123.46");
    expect(price(1.234_56)).toBe("1.2346");
    expect(price(undefined)).toBe(DASH);
    expect(qty(1500.123_456)).toBe("1,500.1235");
    expect(qty(null)).toBe(DASH);
    expect(pct(12.345)).toBe("12.35%");
    expect(pct(12.345, 1)).toBe("12.3%");
    return expect(pct(null)).toBe(DASH);
  });

  return it("signs P&L and picks a tone", () => {
    expect(signed(250)).toBe("+$250");
    expect(signed(-250)).toBe("-$250");
    expect(signed(0)).toBe("$0");
    expect(signed(null)).toBe(DASH);
    expect(pnlTone(1)).toBe("positive");
    expect(pnlTone(-1)).toBe("negative");
    expect(pnlTone(0)).toBe("flat");
    expect(pnlTone(null)).toBe("none");
    expect(pnlTone(Number.POSITIVE_INFINITY)).toBe("none");
    expect(pnlClass(1)).toBe("text-success-foreground");
    expect(pnlClass(-1)).toBe("text-destructive");
    return expect(pnlClass(0)).toBe("");
  });
});

describe("portfolio monitor time helpers", () => {
  it("formats clock times and ages", () => {
    expect(clock("2026-10-09T15:00:00.000Z")).toMatch(/^\d{2}:\d{2}:\d{2}$/u);
    expect(clock(NOW)).toMatch(/^\d{2}:\d{2}:\d{2}$/u);
    expect(clock(null)).toBe(DASH);
    expect(clock("not a time")).toBe(DASH);
    expect(ageSeconds("2026-10-09T14:59:50.000Z", NOW)).toBe(10);
    expect(ageSeconds("2026-10-09T15:00:10.000Z", NOW)).toBe(0);
    return expect(ageSeconds(null, NOW)).toBeNull();
  });

  return it("builds the local YYYYMMDD day key", () => {
    expect(localDayKey(new Date(2026, 0, 5, 23, 59))).toBe("20260105");
    return expect(localDayKey(new Date(2026, 10, 25, 0, 1))).toBe("20261125");
  });
});

describe("portfolio monitor preferences", () =>
  it("accepts only known refresh intervals", () => {
    expect(normalizeInterval(5)).toBe(5);
    expect(normalizeInterval(30)).toBe(30);
    expect(normalizeInterval(7)).toBe(DEFAULT_REFRESH_INTERVAL);
    return expect(normalizeInterval("10")).toBe(DEFAULT_REFRESH_INTERVAL);
  }));

describe("portfolio monitor health rule", () => {
  const health = (input: Partial<Parameters<typeof monitorHealth>[0]>) => {
    return monitorHealth({
      snapshot: fixtureSnapshot({}, NOW),
      failureKind: null,
      nowMs: NOW,
      intervalS: 10,
      ...input,
    }).label;
  };

  it("reports failures before snapshot state", () => {
    expect(health({ failureKind: "not-configured" })).toBe("Not configured");
    expect(health({ failureKind: "forbidden" })).toBe(
      "Operator access required"
    );
    expect(health({ failureKind: "unavailable" })).toBe("Server unreachable");
    expect(health({ failureKind: "error", snapshot: null })).toBe(
      "Server unreachable"
    );
    return expect(health({ snapshot: null })).toBe("Loading");
  });

  it("reports gateway state, staleness and live data", () => {
    expect(
      health({
        snapshot: fixtureSnapshot(
          { status: { gateway: "starting", connected: false } },
          NOW
        ),
      })
    ).toBe("Gateway starting");
    expect(
      health({
        snapshot: fixtureSnapshot(
          { status: { gateway: "disconnected", connected: false } },
          NOW
        ),
      })
    ).toBe("Gateway disconnected");
    expect(
      health({
        snapshot: fixtureSnapshot({ status: { connected: false } }, NOW),
      })
    ).toBe("Gateway disconnected");
    expect(
      health({ snapshot: fixtureSnapshot({ status: { dataAsOf: null } }, NOW) })
    ).toBe("Stale");
    expect(health({ nowMs: NOW + 40_000 })).toBe("Stale");
    expect(health({ nowMs: NOW + 40_000, intervalS: 15 })).toBe("Live");
    expect(health({})).toBe("Live");
    expect(staleAfterSeconds(5)).toBe(30);
    return expect(staleAfterSeconds(30)).toBe(90);
  });

  it("says Updating during a retry and shows a failure only after its grace window", () => {
    expect(health({ retrying: true })).toBe("Updating…");
    expect(health({ retrying: true, snapshot: null })).toBe("Loading");
    expect(failureGraceMs(5)).toBe(20_000);
    expect(failureGraceMs(30)).toBe(60_000);
    const visible = (
      kind: string,
      failingSince: number | null,
      nowMs: number
    ) => failureVisible({ kind, failingSince, nowMs, intervalS: 10 });
    expect(visible("error", NOW, NOW + 19_999)).toBe(false);
    expect(visible("unavailable", NOW, NOW + 20_000)).toBe(true);
    expect(visible("error", null, NOW)).toBe(true);
    return expect(visible("unauthorized", NOW, NOW)).toBe(true);
  });

  return it("labels the account mode without any account id", () => {
    expect(accountLabel("live")).toBe("Live account · read-only");
    expect(accountLabel("paper")).toBe("Paper account · read-only");
    expect(accountLabel("unknown")).toBe("Account mode unknown");
    expect(isGatewayLive(fixtureSnapshot({}, NOW))).toBe(true);
    return expect(
      isGatewayLive(
        fixtureSnapshot({ status: { gateway: "disconnected" } }, NOW)
      )
    ).toBe(false);
  });
});

describe("portfolio monitor summary", () => {
  it("derives the twelve stats with sub lines", () => {
    const stats = summaryStats(fixtureSnapshot({}, NOW));
    expect(stats.map((stat) => stat.label)).toEqual([
      "Net Liquidation",
      "Daily P&L",
      "Unrealized P&L",
      "Realized P&L",
      "Cash",
      "Gross Position Value",
      "Buying Power",
      "Available Funds",
      "Excess Liquidity",
      "Initial Margin",
      "Maintenance Margin",
      "Equity w/ Loan",
    ]);
    const byKey = Object.fromEntries(stats.map((stat) => [stat.key, stat]));
    expect(byKey["netLiquidation"]?.value).toBe("$20,000");
    expect(byKey["daily"]).toMatchObject({
      value: "+$200",
      tone: "positive",
      sub: "1.01% of start NLV",
    });
    expect(byKey["cash"]?.sub).toBe("Settled $8,500");
    expect(byKey["grossPositionValue"]?.sub).toBe("55% of NLV");
    expect(byKey["excessLiquidity"]?.sub).toBe("Cushion 47.5%");
    expect(byKey["maintMargin"]?.sub).toBe("12.5% of equity");
    return expect(byKey["realized"]?.tone).toBe("flat");
  });

  it("leaves sub lines empty when inputs are missing", () => {
    const snapshot = fixtureSnapshot(
      {
        summary: {
          ...fixtureSnapshot({}, NOW).summary,
          netLiquidation: null,
          settledCash: null,
          grossPositionValue: null,
          cushion: null,
          maintMarginReq: null,
        },
        pnl: { daily: null, unrealized: null, realized: null },
      },
      NOW
    );
    const stats = summaryStats(snapshot);
    expect(stats.every((stat) => stat.sub === null)).toBe(true);
    expect(stats[0]?.value).toBe(DASH);
    return expect(stats[1]?.tone).toBe("none");
  });

  return it("computes daily P&L against the start-of-day NLV", () => {
    expect(dailyPnlPct(100, 10_100)).toBeCloseTo(1);
    expect(dailyPnlPct(null, 100)).toBeNull();
    expect(dailyPnlPct(100, null)).toBeNull();
    expect(dailyPnlPct(100, 100)).toBeNull();
    return expect(dailyPnlPct(Number.NaN, 100)).toBeNull();
  });
});

describe("portfolio monitor holding type", () => {
  it("maps IBKR security types to Shares or Contract", () => {
    expect(holdingKind("STK")).toBe("Shares");
    expect(holdingKind(" etf ")).toBe("Shares");
    expect(holdingKind("OPT")).toBe("Contract");
    expect(holdingKind("FUT")).toBe("Contract");
    return expect(holdingKind("CASH")).toBe("Other");
  });

  it("labels options with right and expiry when the symbol shows them", () => {
    expect(holdingLabel(fixturePosition({ secType: "STK" }))).toBe("Shares");
    expect(
      holdingLabel(
        fixturePosition({
          description: "SPY   261218C00500000",
          secType: "OPT",
        })
      )
    ).toBe("Call 2026-12-18");
    expect(
      holdingLabel(
        fixturePosition({
          description: "QQQ   270115P00400000",
          secType: "OPT",
        })
      )
    ).toBe("Put 2027-01-15");
    expect(
      holdingLabel(fixturePosition({ description: "ESZ6", secType: "FUT" }))
    ).toBe("Contract");
    expect(holdingLabel(fixturePosition({ secType: "CASH" }))).toBe("CASH");
    return expect(holdingLabel(fixturePosition({ secType: "" }))).toBe("—");
  });
});

describe("portfolio monitor columns", () => {
  it("normalizes stored layouts", () => {
    expect(normalizeColumnConfig(null)).toEqual(DEFAULT_COLUMN_CONFIG);
    expect(normalizeColumnConfig("bad")).toEqual(DEFAULT_COLUMN_CONFIG);
    const normalized = normalizeColumnConfig({
      order: ["last", "gone", "last", "symbol"],
      hidden: ["symbol", "gone", "position"],
    });
    expect(normalized.order.slice(0, 3)).toEqual(["last", "symbol", "type"]);
    expect(normalized.order).toHaveLength(12);
    expect(normalized.hidden).toEqual(["position"]);
    expect(normalizeColumnConfig({ order: "x" }).hidden).toEqual(
      DEFAULT_COLUMN_CONFIG.hidden
    );
    return expect(normalizeColumnConfig({ order: [] }).order).toEqual(
      DEFAULT_COLUMN_CONFIG.order
    );
  });

  it("toggles and moves columns but never hides Symbol", () => {
    expect(toggleColumn(DEFAULT_COLUMN_CONFIG, "symbol")).toBe(
      DEFAULT_COLUMN_CONFIG
    );
    const hidden = toggleColumn(DEFAULT_COLUMN_CONFIG, "last");
    expect(hidden.hidden).toContain("last");
    expect(toggleColumn(hidden, "last").hidden).not.toContain("last");
    const moved = moveColumn(DEFAULT_COLUMN_CONFIG, 1, -1);
    expect(moved.order.slice(0, 2)).toEqual(["type", "symbol"]);
    expect(moveColumn(DEFAULT_COLUMN_CONFIG, 0, -1)).toBe(
      DEFAULT_COLUMN_CONFIG
    );
    expect(moveColumn(DEFAULT_COLUMN_CONFIG, 11, 1)).toBe(
      DEFAULT_COLUMN_CONFIG
    );
    expect(moveColumn(DEFAULT_COLUMN_CONFIG, -1, 1)).toBe(
      DEFAULT_COLUMN_CONFIG
    );
    expect(moveColumn(DEFAULT_COLUMN_CONFIG, 12, -1)).toBe(
      DEFAULT_COLUMN_CONFIG
    );
    expect(
      visibleColumns(DEFAULT_COLUMN_CONFIG).map((column) => column.id)
    ).not.toContain("costBasis");
    return expect(visibleColumns(DEFAULT_COLUMN_CONFIG)).toHaveLength(10);
  });

  it("sorts positions by number or text in both directions", () => {
    const positions = [
      fixturePosition({
        id: "a",
        description: "",
        symbol: "CHARLIE",
        marketValue: null,
        secType: "OPT",
      }),
      fixturePosition({ id: "b", description: "ALPHA", marketValue: 10 }),
      fixturePosition({ id: "c", description: "BRAVO", marketValue: 30 }),
    ];
    expect(
      sortPositions(positions, DEFAULT_SORT).map((position) => position.id)
    ).toEqual(["c", "b", "a"]);
    expect(
      sortPositions(positions, { id: "symbol", dir: 1 }).map(
        (position) => position.id
      )
    ).toEqual(["b", "c", "a"]);
    expect(
      sortPositions(positions, { id: "type", dir: -1 }).map(
        (position) => position.id
      )
    ).toEqual(["b", "c", "a"]);
    expect(
      sortPositions(positions, { id: "type", dir: 1 }).map(
        (position) => position.id
      )
    ).toEqual(["a", "b", "c"]);
    expect(normalizeSort({ id: "last", dir: 1 })).toEqual({
      id: "last",
      dir: 1,
    });
    expect(normalizeSort({ id: "last", dir: 2 })).toBe(DEFAULT_SORT);
    expect(normalizeSort(null)).toBe(DEFAULT_SORT);
    expect(nextSort(DEFAULT_SORT, "marketValue")).toEqual({
      id: "marketValue",
      dir: 1,
    });
    expect(nextSort({ id: "marketValue", dir: 1 }, "marketValue")).toEqual({
      id: "marketValue",
      dir: -1,
    });
    return expect(nextSort(DEFAULT_SORT, "last")).toEqual({
      id: "last",
      dir: -1,
    });
  });

  return it("totals positions and treats missing values as zero", () => {
    const totals = positionTotals([
      fixturePosition(),
      fixturePosition({ marketValue: null, dailyPnl: null, realized: 5 }),
    ]);
    return expect(totals).toEqual({
      marketValue: 6000,
      dailyPnl: 120,
      unrealized: 2000,
      weightPct: 60,
      costBasis: 10_000,
      realized: 5,
    });
  });
});

describe("portfolio monitor orders", () => {
  it("labels and explains IBKR order statuses", () => {
    expect(orderStatusLabel("PreSubmitted")).toBe("Held at IBKR");
    expect(orderStatusLabel("Submitted")).toBe("At exchange");
    expect(orderStatusLabel("Filled")).toBe("Filled");
    expect(orderStatusLabel("")).toBe(DASH);
    expect(orderStatusTitle("PreSubmitted")).toMatch(/held on IBKR servers/u);
    expect(orderStatusTitle("Submitted")).toMatch(/resting at the exchange/u);
    expect(orderStatusTitle("Filled")).toBeUndefined();
    expect(orderStatusTone("Filled")).toBe("success");
    expect(orderStatusTone("Cancelled")).toBe("destructive");
    expect(orderStatusTone("PreSubmitted")).toBe("warning");
    expect(orderStatusTone("Submitted")).toBe("info");
    return expect(orderStatusTone("Unknown")).toBe("neutral");
  });

  it("groups by symbol and nests children sorted by stop or limit, highest first", () => {
    const orders = [
      fixtureOrder({ key: "z", symbol: "ZULU", stopPrice: 1 }),
      fixtureOrder({
        key: "p",
        symbol: "ALPHA",
        stopPrice: null,
        limitPrice: 58,
        action: "BUY",
      }),
      fixtureOrder({ key: "c1", parentKey: "p", stopPrice: 50 }),
      fixtureOrder({ key: "c2", parentKey: "p", stopPrice: 55 }),
      fixtureOrder({
        key: "c3",
        parentKey: "p",
        stopPrice: null,
        limitPrice: null,
      }),
      fixtureOrder({ key: "g", parentKey: "c2", stopPrice: 54 }),
      fixtureOrder({ key: "orphan", parentKey: "missing", stopPrice: 70 }),
      fixtureOrder({ key: "self", parentKey: "self", stopPrice: 10 }),
      fixtureOrder({ key: "self", stopPrice: 9 }),
    ];
    const groups = groupOrders(orders);
    expect(groups.map((group) => group.symbol)).toEqual(["ALPHA", "ZULU"]);
    return expect(
      groups[0]?.rows.map((row) => [row.order.key, row.depth])
    ).toEqual([
      ["orphan", 0],
      ["p", 0],
      ["c2", 1],
      ["g", 2],
      ["c1", 1],
      ["c3", 1],
      ["self", 0],
    ]);
  });

  return it("keeps completed orders from today and orders without a time", () => {
    const now = new Date(2026, 9, 9, 12);
    const kept = completedToday(
      [
        fixtureOrder({
          key: "a",
          completedTime: "20261009 10:00:00 US/Eastern",
        }),
        fixtureOrder({
          key: "b",
          completedTime: "20261008 10:00:00 US/Eastern",
        }),
        fixtureOrder({ key: "c", completedTime: "" }),
      ],
      now
    );
    expect(kept.map((order) => order.key)).toEqual(["a", "c"]);
    expect(completedClock("20261009 10:00:00 US/Eastern")).toBe("10:00:00");
    expect(completedClock("20261009-10:00:00")).toBe("10:00:00");
    expect(completedClock("short")).toBe("short");
    expect(completedReason("Cancelled by test: reason\nmore")).toBe(
      "Cancelled by test"
    );
    return expect(completedReason("")).toBe("");
  });
});

describe("portfolio monitor executions", () => {
  it("puts the newest execution first", () => {
    const rows = executionsNewestFirst([
      fixtureExecution({ execId: "old", time: "20261009 09:00:00 US/Eastern" }),
      fixtureExecution({ execId: "new", time: "20261009-10:00:00" }),
      fixtureExecution({ execId: "same", time: "20261009 10:00:00" }),
      fixtureExecution({
        execId: "day-before",
        time: "20261008 15:59:00 US/Eastern",
      }),
    ]);
    expect(rows.map((row) => row.execId)).toEqual([
      "same",
      "new",
      "old",
      "day-before",
    ]);
    const unreadable = executionsNewestFirst([
      fixtureExecution({ execId: "a", time: "bad" }),
      fixtureExecution({ execId: "b", time: "20261009 10:00:00" }),
      fixtureExecution({ execId: "c", time: "" }),
    ]);
    return expect(unreadable.map((row) => row.execId)).toEqual(["c", "b", "a"]);
  });

  return it("shows the clock part of the execution time", () => {
    expect(executionClock("20261009 09:30:00 US/Eastern")).toBe(
      "09:30:00 US/Eastern"
    );
    expect(executionClock("20261009-09:30:00")).toBe("09:30:00");
    expect(executionClock("raw")).toBe("raw");
    expect(ibkrTimeKey(" 20261009 09:30:00 ")).toBe("20261009 09:30:00");
    return expect(ibkrTimeKey("2026-10-09T14:00:00.000Z")).toBeNull();
  });
});

describe("portfolio monitor stop ladders", () => {
  it("finds exit-side stop rungs on the same contract, highest first", () => {
    const position = fixturePosition({ last: 60 });
    const ladder = stopLadder(position, [
      fixtureOrder({ key: "a", stopPrice: 55, remaining: 30 }),
      fixtureOrder({ key: "b", stopPrice: 57, remaining: null, qty: 20 }),
      fixtureOrder({ key: "c", stopPrice: 58, remaining: null, qty: null }),
      fixtureOrder({ key: "buy", action: "BUY", stopPrice: 70 }),
      fixtureOrder({ key: "other", conId: "9999", stopPrice: 59 }),
      fixtureOrder({ key: "lmt", stopPrice: null, limitPrice: 65 }),
    ]);
    expect(ladder.exitSide).toBe("SELL");
    expect(ladder.rungs.map((order) => order.key)).toEqual(["c", "b", "a"]);
    expect(ladder.coveredQty).toBe(50);
    expect(ladder.nearest?.stop).toBe(58);
    expect(ladder.nearest?.side).toBe("below");
    return expect(ladder.nearest?.pct).toBeCloseTo(3.333, 2);
  });

  it("handles short positions, missing prices and stops above last", () => {
    const short = stopLadder(fixturePosition({ position: -10, last: 50 }), [
      fixtureOrder({ key: "a", action: "BUY", stopPrice: 55 }),
      fixtureOrder({ key: "b", action: "BUY", stopPrice: 52 }),
    ]);
    expect(short.exitSide).toBe("BUY");
    expect(short.nearest).toMatchObject({ stop: 52, side: "above" });
    expect(
      stopLadder(fixturePosition({ position: -10, last: 60 }), [
        fixtureOrder({ action: "BUY", stopPrice: 55 }),
      ]).nearest
    ).toBeNull();
    expect(
      stopLadder(fixturePosition({ last: 50 }), [
        fixtureOrder({ stopPrice: 55 }),
      ]).nearest
    ).toBeNull();
    expect(
      stopLadder(fixturePosition({ last: null }), [fixtureOrder()]).nearest
    ).toBeNull();
    return expect(stopLadder(fixturePosition(), []).rungs).toEqual([]);
  });

  return it("scales ladder prices with padding", () => {
    const scale = ladderScale(
      stopLadder(fixturePosition({ last: 60, avgPrice: 50 }), [
        fixtureOrder({ stopPrice: 55 }),
      ])
    )!;
    expect(scale.low).toBe(50);
    expect(scale.high).toBe(60);
    expect(scale.at(50)).toBeGreaterThan(0);
    expect(scale.at(60)).toBeLessThan(100);
    expect(
      ladderScale(
        stopLadder(fixturePosition({ last: null, avgPrice: null }), [])
      )
    ).toBeNull();
    expect(
      ladderScale(
        stopLadder(fixturePosition({ last: 10, avgPrice: 10 }), [])
      )!.at(10)
    ).toBeCloseTo(50);
    return expect(
      ladderScale(
        stopLadder(fixturePosition({ last: 0, avgPrice: 0 }), [])
      )!.at(0)
    ).toBeCloseTo(50);
  });
});

describe("portfolio monitor charts", () => {
  it("builds allocation slices with a cash slice", () => {
    const slices = allocationSlices(
      [
        fixturePosition({ marketValue: 6000 }),
        fixturePosition({
          id: "2",
          description: "",
          symbol: "BRAVO",
          marketValue: 4000,
        }),
        fixturePosition({ id: "3", marketValue: -100 }),
        fixturePosition({ id: "4", marketValue: null }),
      ],
      20_000
    );
    expect(slices.map((slice) => [slice.name, slice.pctOfNlv])).toEqual([
      ["ALPHA", 30],
      ["BRAVO", 20],
      [CASH_SLICE, 50],
    ]);
    expect(
      allocationSlices([fixturePosition()], null).map((slice) => slice.pctOfNlv)
    ).toEqual([null]);
    return expect(
      allocationSlices([fixturePosition({ marketValue: 6000 })], 5000)
    ).toHaveLength(1);
  });

  it("builds rounded P&L bars sorted by unrealized", () => {
    const bars = pnlBars([
      fixturePosition({ symbol: "A", unrealized: -10.4, dailyPnl: null }),
      fixturePosition({ symbol: "B", unrealized: null, dailyPnl: 3.6 }),
      fixturePosition({ symbol: "C", unrealized: 99.6, dailyPnl: -1 }),
    ]);
    return expect(bars).toEqual([
      { name: "C", unrealized: 100, daily: -1 },
      { name: "B", unrealized: 0, daily: 4 },
      { name: "A", unrealized: -10, daily: 0 },
    ]);
  });

  return it("draws donut arcs, including a full ring", () => {
    expect(donutArc(100, 100, 90, 50, 0, Math.PI / 2)).toMatch(
      /^M100\.000 10\.000A90 90 0 0 1 /u
    );
    expect(donutArc(100, 100, 90, 50, 0, Math.PI * 1.5)).toContain(
      "A90 90 0 1 1"
    );
    return expect(donutArc(100, 100, 90, 50, 0, Math.PI * 2)).toContain(
      "A90 90 0 1 1"
    );
  });
});

describe("isOptionPosition", () => {
  it("matches OPT and FOP contracts only", () => {
    expect(
      ["OPT", "fop", " OPT ", "STK", "FUT", "BAG", ""].map((secType) =>
        isOptionPosition({ secType })
      )
    ).toEqual([true, true, true, false, false, false, false]);
  });

  it("builds compact coloured Type badges with the full words as label", () => {
    expect(
      holdingBadge(fixturePosition({ position: 10, secType: "STK" }))
    ).toEqual({ label: "Long shares", text: "STK (L)", tone: "long" });
    expect(
      holdingBadge(fixturePosition({ position: -5, secType: "STK" }))
    ).toEqual({ label: "Short shares", text: "STK (S)", tone: "short" });
    expect(
      holdingBadge(fixturePosition({ position: 0, secType: "STK" }))
    ).toEqual({ label: "Flat shares", text: "STK", tone: "flat" });
    expect(
      holdingBadge(
        fixturePosition({
          description: "SPY   261218C00500000",
          position: 2,
          secType: "OPT",
        })
      )
    ).toEqual({ label: "Long Call 2026-12-18", text: "C (L)", tone: "long" });
    expect(
      holdingBadge(
        fixturePosition({
          description: "IWM 20261113 285 P",
          position: -1,
          secType: "OPT",
        })
      )
    ).toEqual({ label: "Short Put", text: "P (S)", tone: "short" });
    expect(
      holdingBadge(
        fixturePosition({ description: "ESZ6", position: 1, secType: "FUT" })
      )
    ).toEqual({ label: "Long Contract", text: "FUT (L)", tone: "long" });
    return expect(
      holdingBadge(
        fixturePosition({
          description: "",
          position: 0,
          secType: "",
          symbol: "X",
        })
      )
    ).toEqual({ label: "Flat —", text: "—", tone: "flat" });
  });
});
