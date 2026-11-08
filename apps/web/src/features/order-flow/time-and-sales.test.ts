import { describe, expect, it } from "vitest";

import {
  formatClock,
  resolveTimeZone,
  tickCoverage,
  timeAndSalesRows,
  timeZoneLabel,
} from "./time-and-sales.ts";
import type { SignedTrade } from "@darkfactory/api";

const at = (iso: string) => Date.parse(iso) / 1000;
const trade = (iso: string, price: number): SignedTrade => ({
  ask: price,
  bid: price - 0.01,
  conditions: null,
  method: "quote",
  price,
  side: "buy",
  size: 100,
  t: at(iso),
  venue: "ARCA",
});

describe("time and sales", () => {
  it("lists prints newest first with exchange-zone clock times", () => {
    const rows = timeAndSalesRows(
      [
        trade("2026-10-30T18:02:11Z", 100),
        trade("2026-10-30T18:03:40Z", 100.01),
      ],
      "US/Eastern"
    );
    expect(rows.map((row) => `${row.time} ${row.price}`)).toEqual([
      "14:03:40 100.01",
      "14:02:11 100",
    ]);
    expect(rows[0]).toMatchObject({ method: "quote", side: "buy" });
    expect(new Set(rows.map((row) => row.key)).size).toBe(2);
  });

  it("words the coverage of the fetched window", () => {
    const trades = Array.from({ length: 500 }, (_, index) =>
      trade(index === 0 ? "2026-10-30T18:02:11Z" : "2026-10-30T18:03:40Z", 100)
    );
    expect(tickCoverage(trades, "US/Eastern").label).toBe(
      "500 trades, 14:02:11-14:03:40 ET"
    );
    expect(
      tickCoverage([trade("2026-10-30T18:02:11Z", 1)], "US/Central").label
    ).toBe("1 trade, 13:02:11-13:02:11 CT");
    expect(tickCoverage([], "UTC")).toEqual({
      count: 0,
      first: null,
      label: "0 trades",
      last: null,
    });
  });

  it("falls back to UTC for a missing or unknown zone", () => {
    expect(resolveTimeZone(null)).toBe("UTC");
    expect(resolveTimeZone("Not/AZone")).toBe("UTC");
    expect(resolveTimeZone("Europe/London")).toBe("Europe/London");
    expect(timeZoneLabel("UTC")).toBe("UTC");
    expect(timeZoneLabel("Europe/London")).toMatch(/GMT|BST|UTC/);
    expect(formatClock(at("2026-10-30T00:00:05Z"), "UTC")).toBe("00:00:05");
  });
});
