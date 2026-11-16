import { describe, expect, it } from "vitest";
import { utcClock } from "./server/status-time.ts";

const NOW = new Date("2026-11-16T15:00:00Z");

describe("utcClock", () => {
  it("formats HH:MM UTC on the same UTC day", () => {
    expect(utcClock(new Date("2026-11-16T14:02:59Z"), NOW)).toBe("14:02 UTC");
    expect(utcClock("2026-11-16T09:05:00Z", NOW.getTime())).toBe("09:05 UTC");
    expect(utcClock(Date.parse("2026-11-16T23:59:00Z"), NOW)).toBe("23:59 UTC");
  });
  it("adds the date on another UTC day", () => {
    expect(utcClock("2026-11-14T14:02:00Z", NOW)).toBe("Nov 14 14:02 UTC");
    expect(utcClock("2026-11-17T00:00:00Z", NOW)).toBe("Nov 17 00:00 UTC");
  });
  it("adds the date across a year boundary", () => {
    expect(
      utcClock("2026-12-31T23:59:00Z", new Date("2027-01-01T00:01:00Z"))
    ).toBe("Dec 31 23:59 UTC");
  });
  it("names an unparsable time", () => {
    expect(utcClock("not a time", NOW)).toBe("time not recorded");
    expect(utcClock(Number.NaN)).toBe("time not recorded");
    expect(utcClock("2026-11-14T14:02:00Z", Number.NaN)).toBe(
      "Nov 14 14:02 UTC"
    );
  });
  it("defaults now to the current time", () => {
    expect(utcClock(new Date())).toMatch(/^\d\d:\d\d UTC$/u);
  });
});
