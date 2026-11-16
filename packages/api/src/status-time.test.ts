import { describe, expect, it } from "vitest";
import { utcClock } from "./server/status-time.ts";

describe("utcClock", () => {
  it("formats HH:MM UTC", () => {
    expect(utcClock(new Date("2026-11-16T14:02:59Z"))).toBe("14:02 UTC");
    expect(utcClock("2026-11-16T09:05:00Z")).toBe("09:05 UTC");
    expect(utcClock(Date.parse("2026-11-16T23:59:00Z"))).toBe("23:59 UTC");
  });
  it("names an unparsable time", () => {
    expect(utcClock("not a time")).toBe("time not recorded");
    expect(utcClock(Number.NaN)).toBe("time not recorded");
  });
});
