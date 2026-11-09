import { describe, expect, it } from "vitest";
import {
  easter,
  expirationsAfter,
  formatDay,
  isNyseHoliday,
  monthlyExpiration,
  parseDay,
  TradingCalendar,
  weekday,
} from "./calendar.ts";

const days = (...dates: string[]) => dates.map(parseDay);

describe("dates", () => {
  it("parses and formats ISO dates as UTC day numbers", () => {
    expect(parseDay("1970-01-02")).toBe(1);
    expect(formatDay(parseDay("2024-02-29"))).toBe("2024-02-29");
    expect(weekday(parseDay("2024-11-04"))).toBe(0); // Monday
    expect(weekday(-1)).toBe(2); // 1969-12-31, a Wednesday
    for (const bad of ["2024-02-30", "2024-1-05", "20240105"])
      expect(() => parseDay(bad)).toThrow(`Invalid isoformat string: '${bad}'`);
  });

  it("computes Gregorian Easter", () => {
    expect([2024, 2025, 2000].map((year) => formatDay(easter(year)))).toEqual([
      "2024-03-31",
      "2025-04-20",
      "2000-04-23",
    ]);
  });
});

describe("NYSE holidays", () => {
  it("observes weekend holidays and the rule changes", () => {
    const holidays = days(
      "2023-01-02", // New Year on a Sunday
      "2020-07-03", // Independence Day on a Saturday
      "2021-07-05", // Independence Day on a Sunday
      "2022-06-20", // Juneteenth on a Sunday, from 2022
      "2024-03-29", // Good Friday
      "2024-11-28" // Thanksgiving
    );
    expect(holidays.map(isNyseHoliday)).toEqual(holidays.map(() => true));
    // A Saturday New Year is not observed on Dec 31; no Juneteenth before 2022.
    expect(
      days("2021-12-31", "2021-06-18", "2024-11-27").map(isNyseHoliday)
    ).toEqual([false, false, false]);
    expect(isNyseHoliday(parseDay("2023-01-02"))).toBe(true); // cached year
  });
});

describe("TradingCalendar and monthly expirations", () => {
  const calendar = new TradingCalendar([
    "2024-01-02",
    "2024-01-03",
    "2024-01-05",
    "2024-01-03",
  ]);

  it("uses the bar dates inside their range and the NYSE rules after it", () => {
    expect([calendar.first, calendar.last].map(formatDay)).toEqual([
      "2024-01-02",
      "2024-01-05",
    ]);
    expect(
      days(
        "2024-01-03",
        "2024-01-04",
        "2024-01-08",
        "2024-01-15",
        "2024-01-13"
      ).map((day) => calendar.isTradingDay(day))
    ).toEqual([true, false, true, false, false]);
    expect(formatDay(calendar.previousTradingDay(parseDay("2024-01-05")))).toBe(
      "2024-01-03"
    );
    expect(() => new TradingCalendar([])).toThrow(
      "TradingCalendar needs at least one date"
    );
  });

  it("moves an expiration off a closed 3rd Friday", () => {
    expect(formatDay(monthlyExpiration(2024, 1, calendar))).toBe("2024-01-19");
    expect(formatDay(monthlyExpiration(2022, 4, calendar))).toBe("2022-04-14"); // Good Friday
    expect(formatDay(monthlyExpiration(2026, 6, calendar))).toBe("2026-06-18"); // Juneteenth
    const gappy = new TradingCalendar(["2024-01-17", "2024-01-31"]);
    expect(formatDay(monthlyExpiration(2024, 1, gappy))).toBe("2024-01-17");
  });

  it("lists the expirations from the start month", () => {
    expect(
      expirationsAfter(parseDay("2024-11-16"), 2, calendar).map(formatDay)
    ).toEqual(["2024-12-20", "2025-01-17"]);
    expect(
      expirationsAfter(parseDay("2024-11-15"), 0, calendar).map(formatDay)
    ).toEqual(["2024-11-15"]);
  });
});
