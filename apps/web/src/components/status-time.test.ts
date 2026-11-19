import { describe, expect, it } from "vitest";
import {
  loadFailedLabel,
  statusTime,
  TIME_NOT_REPORTED,
  utcClock,
} from "./status-time.ts";

const NOW = new Date("2026-11-19T15:30:00Z");

describe("utcClock", () => {
  it("prints the UTC hour and minute for a time on the current UTC day", () => {
    expect(utcClock(new Date("2026-11-19T14:05:59Z"), NOW)).toBe("14:05 UTC");
    expect(utcClock(Date.parse("2026-11-19T00:00:00Z"), NOW)).toBe("00:00 UTC");
  });

  it("adds the date for a time on another UTC day", () => {
    expect(utcClock(Date.parse("2026-11-18T23:59:00Z"), NOW)).toBe(
      "2026-11-18 23:59 UTC"
    );
  });

  it("compares with the present day when no reference time is given", () => {
    expect(utcClock(new Date())).toMatch(/^\d{2}:\d{2} UTC$/);
  });
});

describe("loadFailedLabel", () => {
  it("names the failure and its time", () => {
    expect(loadFailedLabel(Date.parse("2026-11-19T14:05:00Z"), NOW)).toBe(
      "Load failed 14:05 UTC"
    );
    expect(loadFailedLabel(Date.now())).toMatch(
      /^Load failed \d{2}:\d{2} UTC$/
    );
  });
});

describe("statusTime", () => {
  it("formats ISO text, epoch milliseconds and a Date", () => {
    expect(statusTime("2026-11-19T14:05:00Z", NOW)).toBe("14:05 UTC");
    expect(statusTime(Date.parse("2026-11-18T14:05:00Z"), NOW)).toBe(
      "2026-11-18 14:05 UTC"
    );
    expect(statusTime(new Date("2026-11-19T01:02:00Z"), NOW)).toBe("01:02 UTC");
    expect(statusTime(new Date().toISOString())).toMatch(/^\d{2}:\d{2} UTC$/);
  });

  it("names a missing or unreadable time", () => {
    expect(statusTime(null)).toBe(TIME_NOT_REPORTED);
    expect(statusTime(undefined)).toBe(TIME_NOT_REPORTED);
    expect(statusTime("")).toBe(TIME_NOT_REPORTED);
    expect(statusTime("not a time", NOW)).toBe("time not reported by source");
    expect(statusTime(Number.NaN, NOW)).toBe(TIME_NOT_REPORTED);
  });
});
