import { describe, expect, it } from "vitest";

import {
  enumLabel,
  formatAge,
  formatCount,
  formatDuration,
  formatMoney,
  formatNyDateTime,
  formatNyTime,
  formatPrice,
  formatRatio,
  formatShare,
  formatSigned,
  formatSignedPrice,
  formatSignedRatio,
  NO_VALUE,
  UNREADABLE_TIME,
} from "./format.ts";

describe("flow formatting", () => {
  it("formats money compactly", () => {
    expect(formatMoney(1_234_567)).toBe("$1.2M");
    expect(formatMoney(950_000)).toBe("$950K");
    expect(formatMoney(3_100_000_000)).toBe("$3.1B");
    expect(formatMoney(0)).toBe("$0");
    expect(formatMoney(-2_500_000)).toBe("-$2.5M");
    expect(formatMoney(null)).toBe(NO_VALUE);
  });

  it("formats counts compactly", () => {
    expect(formatCount(1_250_000)).toBe("1.3M");
    expect(formatCount(12)).toBe("12");
    expect(formatCount(null)).toBe(NO_VALUE);
  });

  it("signs deltas with a true minus", () => {
    expect(formatSigned(1234)).toBe("+1,234");
    expect(formatSigned(-1234)).toBe("−1,234");
    expect(formatSigned(0)).toBe("0");
  });

  it("signs ratios", () => {
    expect(formatSignedRatio(0.236)).toBe("+0.24");
    expect(formatSignedRatio(-0.5)).toBe("−0.50");
    expect(formatSignedRatio(0)).toBe("0.00");
    expect(formatSignedRatio(null)).toBe(NO_VALUE);
  });

  it("formats shares, ratios and prices", () => {
    expect(formatShare(0.416)).toBe("42%");
    expect(formatShare(null)).toBe(NO_VALUE);
    expect(formatRatio(0.656)).toBe("0.66");
    expect(formatRatio(null)).toBe(NO_VALUE);
    expect(formatPrice(5912.25)).toBe("5,912.25");
    expect(formatPrice(null)).toBe(NO_VALUE);
  });

  it("signs price differences", () => {
    expect(formatSignedPrice(18.5)).toBe("+18.50");
    expect(formatSignedPrice(-3.25)).toBe("−3.25");
    expect(formatSignedPrice(0)).toBe("0.00");
    expect(formatSignedPrice(null)).toBe(NO_VALUE);
  });

  it("formats ages", () => {
    expect(formatAge(null)).toBe("never");
    expect(formatAge(45)).toBe("45s");
    expect(formatAge(12 * 60 + 5)).toBe("12m");
    expect(formatAge(3 * 3600 + 5 * 60)).toBe("3h 5m");
    expect(formatAge(2 * 86_400 + 4 * 3600)).toBe("2d 4h");
  });

  it("formats durations", () => {
    expect(formatDuration(45)).toBe("45s");
    expect(formatDuration(120)).toBe("2m");
    expect(formatDuration(90)).toBe("1m 30s");
    expect(formatDuration(7200)).toBe("2h");
    expect(formatDuration(4500)).toBe("1h 15m");
  });

  it("formats New York times with the zone label", () => {
    expect(formatNyTime("2026-11-06T15:42:00.000Z")).toBe("10:42 AM EST");
    expect(formatNyTime("2026-10-30T20:00:00.000Z")).toBe("4:00 PM EDT");
    expect(formatNyDateTime("2026-11-06T20:59:00.000Z")).toBe(
      "Nov 6, 3:59 PM EST"
    );
    expect(formatNyTime("not a time")).toBe("unreadable time");
    expect(formatNyDateTime("not a time")).toBe(UNREADABLE_TIME);
  });

  it("names the default reason and takes the caller's reason for a null value", () => {
    expect(NO_VALUE).toBe("no value");
    expect(formatMoney(null, "not computed")).toBe("not computed");
    expect(formatCount(null, "no count")).toBe("no count");
    expect(formatSignedRatio(null, "no trades in window")).toBe(
      "no trades in window"
    );
    expect(formatShare(null, "no option premium")).toBe("no option premium");
    expect(formatRatio(null, "no call premium")).toBe("no call premium");
    expect(formatPrice(null, "no bid")).toBe("no bid");
    expect(formatSignedPrice(null, "too few buckets")).toBe("too few buckets");
    expect(formatMoney(5, "not computed")).toBe("$5");
  });

  it("labels an enum value and names a value without a label", () => {
    const labels: Partial<Record<"up" | "down", string>> = { up: "Up" };
    expect(enumLabel(labels, "up")).toBe("Up");
    expect(enumLabel(labels, "down")).toBe(
      'Value "down" has no label in this page version · reload the page'
    );
    expect(enumLabel(labels, "sideways")).toBe(
      'Value "sideways" has no label in this page version · reload the page'
    );
    expect(enumLabel(labels, "constructor")).toBe(
      'Value "constructor" has no label in this page version · reload the page'
    );
  });
});
