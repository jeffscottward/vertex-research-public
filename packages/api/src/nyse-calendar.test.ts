import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  isNyseEarlyClose,
  isNyseTradingDay,
  isoDayOf,
  nyseCloseMinute,
  previousNyseTradingDay,
  utcDay,
  weekday,
} from "./nyse-calendar.ts";

/** The exchange-sourced holiday and early-close list of the QuantVPS deploy guard. */
const deployCalendar = (): Readonly<{
  closed: ReadonlySet<string>;
  early: ReadonlySet<string>;
  first: number;
  last: number;
}> => {
  const text = readFileSync(
    new URL("../../../infra/quantvps/nyse-calendar.txt", import.meta.url),
    "utf8"
  );
  const years = /^years (\d{4})-(\d{4})$/mu.exec(text);
  if (years === null) throw new Error("nyse-calendar.txt has no years line");
  const datesOf = (kind: string): ReadonlySet<string> =>
    new Set(
      [
        ...text.matchAll(
          new RegExp(`^(\\d{4}-\\d{2}-\\d{2}) ${kind}\\b`, "gmu")
        ),
      ].map((match) => String(match[1]))
    );
  return {
    closed: datesOf("closed"),
    early: datesOf("early:1300"),
    first: utcDay(Number(years[1]), 0, 1),
    last: utcDay(Number(years[2]), 11, 31),
  };
};

describe("NYSE calendar parity with infra/quantvps/nyse-calendar.txt", () => {
  it("has the same trading days and early closes on every day of the covered years", () => {
    const { closed, early, first, last } = deployCalendar();
    expect(closed.size).toBeGreaterThan(30);
    expect(early.size).toBeGreaterThan(5);
    for (let day = first; day <= last; day += 1) {
      const iso = isoDayOf(day);
      const weekend = weekday(day) === 0 || weekday(day) === 6;
      expect({ iso, trading: isNyseTradingDay(day) }).toEqual({
        iso,
        trading: !(weekend || closed.has(iso)),
      });
      expect({ early: isNyseEarlyClose(day), iso }).toEqual({
        early: early.has(iso),
        iso,
      });
    }
  });
});

describe("isNyseEarlyClose and nyseCloseMinute", () => {
  it("moves a close 180 minutes earlier only on an early close", () => {
    // 2026-11-27: the day after Thanksgiving (early close); 2026-11-23: a regular Monday.
    expect(nyseCloseMinute(utcDay(2026, 10, 27), 16 * 60 + 15)).toBe(
      13 * 60 + 15
    );
    expect(nyseCloseMinute(utcDay(2026, 10, 27), 20 * 60)).toBe(17 * 60);
    expect(nyseCloseMinute(utcDay(2026, 10, 23), 16 * 60 + 15)).toBe(
      16 * 60 + 15
    );
  });

  it("is false on a holiday and a weekend, even on an early-close date", () => {
    // Thanksgiving; 3 July 2026 (observed Independence Day); 24 December 2022 (a Saturday).
    expect(isNyseEarlyClose(utcDay(2026, 10, 26))).toBe(false);
    expect(isNyseEarlyClose(utcDay(2026, 6, 3))).toBe(false);
    expect(isNyseEarlyClose(utcDay(2022, 11, 24))).toBe(false);
    expect(isNyseEarlyClose(utcDay(2028, 6, 3))).toBe(true);
    expect(isNyseEarlyClose(utcDay(2026, 11, 24))).toBe(true);
  });
});

describe("previousNyseTradingDay", () => {
  it("skips weekends and holidays", () => {
    expect(previousNyseTradingDay(utcDay(2026, 10, 27))).toBe("2026-11-25");
    expect(previousNyseTradingDay(utcDay(2026, 10, 30))).toBe("2026-11-27");
  });
});
