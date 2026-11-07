import type { PortfolioMonitorExecution } from "@darkfactory/api";
import { describe, expect, it } from "vitest";

import {
  chronologicalFills,
  cumulativeRealized,
  formatMoney,
  formatNumber,
  formatPercent,
  formatSignedMoney,
  journalKpis,
  journalSymbolRows,
  journalTime,
  latestExecutions,
  lineGeometry,
  pnlTextClass,
  sideLabel,
} from "./trade-journal-model.ts";

const fill = (
  overrides: Partial<PortfolioMonitorExecution> = {}
): PortfolioMonitorExecution => ({
  avgPrice: 100,
  commission: 1,
  exchange: "SMART",
  execId: "e1",
  localSymbol: "",
  permId: null,
  orderRef: "",
  price: 100,
  realized: 0,
  secType: "STK",
  shares: 10,
  side: "BOT",
  symbol: "AAPL",
  time: "20261009 09:30:00 US/Eastern",
  ...overrides,
});

describe("sideLabel", () => {
  it("names IBKR and plain sides and keeps unknown text", () => {
    expect(sideLabel("BOT")).toBe("Buy");
    expect(sideLabel(" buy ")).toBe("Buy");
    expect(sideLabel("SLD")).toBe("Sell");
    expect(sideLabel("sell")).toBe("Sell");
    expect(sideLabel("SSHORT")).toBe("SSHORT");
  });
});

describe("chronologicalFills", () => {
  it("orders by IBKR time, oldest first, keeping arrival order for ties and unreadable times", () => {
    const late = fill({ execId: "late", time: "20261009 11:00:00" });
    const early = fill({ execId: "early", time: "20261009-09:00:00" });
    const tieA = fill({ execId: "tieA", time: "20261009 10:00:00" });
    const tieB = fill({ execId: "tieB", time: "20261009 10:00:00 US/Eastern" });
    const odd = fill({ execId: "odd", time: "yesterday" });
    expect(
      chronologicalFills([late, early, tieA, tieB, odd]).map((e) => e.execId)
    ).toEqual(["early", "tieA", "tieB", "late", "odd"]);
  });
});

describe("journalKpis", () => {
  it("totals fills, realized and commissions and scores closing fills only", () => {
    const kpis = journalKpis([
      fill({ commission: 1, realized: 0 }),
      fill({ commission: null, realized: null }),
      fill({ commission: 1.5, realized: 30 }),
      fill({ commission: 0.5, realized: 10 }),
      fill({ commission: 1, realized: -20 }),
    ]);
    expect(kpis).toEqual({
      avgLoss: -20,
      avgWin: 20,
      closing: 3,
      commissions: 4,
      fills: 5,
      losses: 1,
      realized: 20,
      winRate: 2 / 3,
      wins: 2,
    });
  });

  it("returns nulls for rates and averages without closing fills", () => {
    expect(journalKpis([])).toEqual({
      avgLoss: null,
      avgWin: null,
      closing: 0,
      commissions: 0,
      fills: 0,
      losses: 0,
      realized: 0,
      winRate: null,
      wins: 0,
    });
  });
});

describe("journalSymbolRows", () => {
  it("groups by symbol alphabetically with bought and sold shares", () => {
    expect(
      journalSymbolRows([
        fill({ shares: 5, side: "BOT", symbol: "MSFT" }),
        fill({ shares: 10, side: "BOT", symbol: "AAPL" }),
        fill({ realized: 12, shares: 4, side: "SLD", symbol: "AAPL" }),
        fill({ commission: 2, shares: null, side: "SLD", symbol: "AAPL" }),
      ])
    ).toEqual([
      {
        bought: 10,
        commissions: 4,
        fills: 3,
        realized: 12,
        secType: "STK",
        sold: 4,
        symbol: "AAPL",
        winRate: 1,
      },
      {
        bought: 5,
        commissions: 1,
        fills: 1,
        realized: 0,
        secType: "STK",
        sold: 0,
        symbol: "MSFT",
        winRate: null,
      },
    ]);
  });
});

describe("journal trades and contracts", () => {
  it("counts partial fills of one order (permId) as one trade", () => {
    const kpis = journalKpis([
      fill({ execId: "a", permId: 7, realized: 25 }),
      fill({ execId: "b", permId: 7, realized: 25 }),
      fill({ execId: "c", permId: 7, realized: 50 }),
      fill({ execId: "d", permId: 8, realized: -40 }),
      fill({ execId: "e", permId: null, realized: -10 }),
    ]);
    expect(kpis.closing).toBe(3);
    expect(kpis.wins).toBe(1);
    expect(kpis.losses).toBe(2);
    expect(kpis.avgWin).toBe(100);
    expect(kpis.avgLoss).toBe(-25);
    return expect(kpis.realized).toBe(50);
  });

  it("keeps only the latest correction of an execution", () =>
    expect(
      latestExecutions([
        fill({ execId: "x.01.01", realized: 5 }),
        fill({ execId: "y.01.01" }),
        fill({ execId: "x.01.02", realized: 6 }),
        fill({ execId: "plain" }),
      ]).map((execution) => execution.execId)
    ).toEqual(["y.01.01", "x.01.02", "plain"]));

  it("keeps an older correction out even when it arrives last, and ids without a numeric version", () =>
    expect(
      latestExecutions([
        fill({ execId: "x.01.02" }),
        fill({ execId: "x.01.01" }),
        fill({ execId: "z.abc" }),
      ]).map((execution) => execution.execId)
    ).toEqual(["x.01.02", "z.abc"]));

  it("orders contracts sharing a label by security type", () =>
    expect(
      journalSymbolRows([
        fill({ secType: "STK", symbol: "AAPL" }),
        fill({ secType: "OPT", symbol: "AAPL" }),
      ]).map((row) => row.secType)
    ).toEqual(["OPT", "STK"]));

  it("separates option contracts from their stock", () =>
    expect(
      journalSymbolRows([
        fill({ localSymbol: "AAPL", secType: "STK", symbol: "AAPL" }),
        fill({
          localSymbol: "AAPL  261120C00200000",
          secType: "OPT",
          shares: 1,
          symbol: "AAPL",
        }),
      ]).map((row) => [row.secType, row.symbol, row.bought])
    ).toEqual([
      ["STK", "AAPL", 10],
      ["OPT", "AAPL  261120C00200000", 1],
    ]));

  it("puts fills without a readable time after timed fills", () =>
    expect(
      chronologicalFills([
        fill({ execId: "u1", time: "?" }),
        fill({ execId: "t2", time: "20261009 10:00:00" }),
        fill({ execId: "t1", time: "20261009 09:00:00" }),
      ]).map((execution) => execution.execId)
    ).toEqual(["t1", "t2", "u1"]));
});

describe("cumulativeRealized", () => {
  it("runs the realized total over closing fills, oldest first", () => {
    expect(
      cumulativeRealized([
        fill({ realized: -5, time: "20261009 11:00:00" }),
        fill({ realized: 10, time: "20261009 09:00:00" }),
        fill({ realized: 0, time: "20261009 10:00:00" }),
        fill({ realized: null, time: "20261009 10:30:00" }),
      ])
    ).toEqual([
      { time: "20261009 09:00:00", value: 10 },
      { time: "20261009 11:00:00", value: 5 },
    ]);
  });
});

describe("lineGeometry", () => {
  it("scales the 0 start and each point to the box", () => {
    expect(
      lineGeometry(
        [
          { time: "a", value: 10 },
          { time: "b", value: -10 },
        ],
        100,
        50
      )
    ).toEqual({ path: "M0 25 L50 0 L100 50", zeroY: 25 });
  });

  it("draws a flat line at the bottom when there is no range", () => {
    expect(lineGeometry([], 100, 50)).toEqual({ path: "M0 50", zeroY: 50 });
    expect(lineGeometry([{ time: "a", value: 0 }], 90, 30)).toEqual({
      path: "M0 30 L90 30",
      zeroY: 30,
    });
  });
});

describe("formatters", () => {
  it("formats money, signed money, percent and numbers with a dash for null", () => {
    expect(formatMoney(1234.5)).toBe("$1,234.50");
    expect(formatMoney(null)).toBe("—");
    expect(formatSignedMoney(12)).toBe("+$12.00");
    expect(formatSignedMoney(-3)).toBe("-$3.00");
    expect(formatSignedMoney(0)).toBe("$0.00");
    expect(formatSignedMoney(null)).toBe("—");
    expect(formatPercent(2 / 3)).toBe("67%");
    expect(formatPercent(null)).toBe("—");
    expect(formatNumber(1500.123_45)).toBe("1,500.1235");
    expect(formatNumber(null)).toBe("—");
  });

  it("colours profit and loss only", () => {
    expect(pnlTextClass(1)).toBe("text-success-foreground");
    expect(pnlTextClass(-1)).toBe("text-destructive");
    expect(pnlTextClass(0)).toBe("");
    expect(pnlTextClass(null)).toBe("");
  });

  it("formats IBKR times as ISO-like dates and keeps other text", () => {
    expect(journalTime("20261009 09:30:00 US/Eastern")).toBe(
      "2026-10-09 09:30:00 US/Eastern"
    );
    expect(journalTime("20261009-09:30:00")).toBe("2026-10-09 09:30:00");
    expect(journalTime("later")).toBe("later");
  });
});
