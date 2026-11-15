import { describe, expect, it } from "vitest";
import {
  barsDueSessionDate,
  calendarVerified,
  LAST_VERIFIED_CALENDAR_YEAR,
  newestSlotAtOrBefore,
  slotsBetween,
} from "./research-screen-slots.ts";

const GRID = "Every 4 hours";

const between = (after: string, until: string) =>
  slotsBetween(new Date(after), new Date(until));

const labelsAt = (
  slots: readonly { at: Date; labels: readonly string[] }[],
  at: string
) => slots.find((slot) => slot.at.getTime() === Date.parse(at))?.labels;

describe("slotsBetween", () => {
  it("gives 57 slots in the Thanksgiving week of 2026", () => {
    const slots = between("2026-11-23T05:00:00Z", "2026-11-30T05:00:00Z");
    expect(slots).toHaveLength(57);
    // New York is 5 hours behind UTC in this week.
    const perDate = new Map<string, number>();
    for (const slot of slots) {
      const date = new Date(slot.at.getTime() - 5 * 3_600_000)
        .toISOString()
        .slice(0, 10);
      perDate.set(date, (perDate.get(date) ?? 0) + 1);
    }
    expect([...perDate.entries()]).toEqual([
      ["2026-11-23", 10],
      ["2026-11-24", 10],
      ["2026-11-25", 10],
      ["2026-11-26", 6],
      ["2026-11-27", 9],
      ["2026-11-28", 6],
      ["2026-11-29", 6],
    ]);
    const times = slots.map((slot) => slot.at.getTime());
    expect(times).toEqual([...times].sort((left, right) => left - right));
    expect(new Set(times).size).toBe(57);
  });

  it("follows the early close on the day after Thanksgiving", () => {
    const slots = between("2026-11-27T05:00:00Z", "2026-11-28T05:00:00Z");
    expect(slots.map((slot) => [slot.at.toISOString(), slot.labels])).toEqual([
      ["2026-11-27T08:00:00.000Z", [GRID]],
      ["2026-11-27T12:00:00.000Z", [GRID]],
      ["2026-11-27T14:00:00.000Z", ["9 AM"]],
      ["2026-11-27T16:00:00.000Z", [GRID]],
      ["2026-11-27T17:00:00.000Z", ["Noon"]],
      ["2026-11-27T17:30:00.000Z", ["30 minutes before close"]],
      ["2026-11-27T20:00:00.000Z", [GRID, "2 hours after close"]],
      ["2026-11-28T00:00:00.000Z", [GRID]],
      ["2026-11-28T04:00:00.000Z", [GRID]],
    ]);
  });

  it("gives 9 slots on a normal summer trading day", () => {
    const slots = between("2026-07-01T04:00:00Z", "2026-07-02T04:00:00Z");
    expect(slots).toHaveLength(9);
    expect(labelsAt(slots, "2026-07-01T13:00:00Z")).toEqual(["9 AM"]);
    expect(labelsAt(slots, "2026-07-01T16:00:00Z")).toEqual([GRID, "Noon"]);
    expect(labelsAt(slots, "2026-07-01T19:30:00Z")).toEqual([
      "30 minutes before close",
    ]);
    expect(labelsAt(slots, "2026-07-01T22:00:00Z")).toEqual([
      "2 hours after close",
    ]);
  });

  it("gives 10 slots on a normal winter trading day", () => {
    const slots = between("2026-12-01T05:00:00Z", "2026-12-02T05:00:00Z");
    expect(slots).toHaveLength(10);
    expect(labelsAt(slots, "2026-12-01T14:00:00Z")).toEqual(["9 AM"]);
    expect(labelsAt(slots, "2026-12-01T17:00:00Z")).toEqual(["Noon"]);
    expect(labelsAt(slots, "2026-12-01T20:30:00Z")).toEqual([
      "30 minutes before close",
    ]);
    expect(labelsAt(slots, "2026-12-01T23:00:00Z")).toEqual([
      "2 hours after close",
    ]);
  });

  it("includes a slot at `until` and excludes a slot at `after`", () => {
    expect(
      between("2026-12-01T12:00:00Z", "2026-12-01T14:00:00Z").map((slot) =>
        slot.at.toISOString()
      )
    ).toEqual(["2026-12-01T14:00:00.000Z"]);
    expect(
      between("2026-12-01T14:00:00Z", "2026-12-01T16:00:00Z").map((slot) =>
        slot.at.toISOString()
      )
    ).toEqual(["2026-12-01T16:00:00.000Z"]);
    expect(between("2026-12-01T14:00:00Z", "2026-12-01T15:59:59Z")).toEqual([]);
    expect(between("2026-12-01T16:00:00Z", "2026-12-01T12:00:00Z")).toEqual([]);
  });
});

describe("newestSlotAtOrBefore", () => {
  it("gives the slot at the instant itself", () => {
    expect(newestSlotAtOrBefore(new Date("2026-12-01T20:30:00Z"))).toEqual({
      at: new Date("2026-12-01T20:30:00Z"),
      labels: ["30 minutes before close"],
    });
  });

  it("gives the previous slot one millisecond earlier", () => {
    expect(newestSlotAtOrBefore(new Date("2026-12-01T20:29:59.999Z"))).toEqual({
      at: new Date("2026-12-01T20:00:00Z"),
      labels: [GRID],
    });
    expect(newestSlotAtOrBefore(new Date("2026-11-29T03:59:59.999Z"))).toEqual({
      at: new Date("2026-11-29T00:00:00Z"),
      labels: [GRID],
    });
  });
});

describe("barsDueSessionDate", () => {
  const due = (now: string) => barsDueSessionDate(new Date(now));

  it("gives the previous session before the close and up to 2 hours after it", () => {
    expect(due("2026-12-01T15:00:00Z")).toBe("2026-11-30");
    expect(due("2026-12-01T22:00:00Z")).toBe("2026-11-30");
    expect(due("2026-12-01T22:59:59.999Z")).toBe("2026-11-30");
  });

  it("gives the day itself exactly 2 hours after the close", () => {
    expect(due("2026-12-01T23:00:00Z")).toBe("2026-12-01");
    expect(due("2026-07-01T22:00:00Z")).toBe("2026-07-01");
    // After midnight UTC, still the evening of the same New York date.
    expect(due("2026-12-02T02:00:00Z")).toBe("2026-12-01");
  });

  it("gives Friday on a Sunday", () => {
    expect(due("2026-12-06T15:00:00Z")).toBe("2026-12-04");
  });

  it("follows an early close", () => {
    expect(due("2026-11-27T19:59:59Z")).toBe("2026-11-25");
    expect(due("2026-11-27T20:00:00Z")).toBe("2026-11-27");
  });

  it("gives null for an invalid date", () => {
    expect(barsDueSessionDate(new Date(Number.NaN))).toBeNull();
  });
});

describe("calendarVerified", () => {
  it("is true through the last verified New York year", () => {
    expect(LAST_VERIFIED_CALENDAR_YEAR).toBe(2028);
    expect(calendarVerified(new Date("2028-06-01T12:00:00Z"))).toBe(true);
    // 23:00 on 31 December 2028 in New York.
    expect(calendarVerified(new Date("2029-01-01T04:00:00Z"))).toBe(true);
    expect(calendarVerified(new Date("2029-01-01T05:00:00Z"))).toBe(false);
    expect(calendarVerified(new Date("2029-06-01T12:00:00Z"))).toBe(false);
  });

  it("is still ahead of the real clock", () => {
    // The holiday and early-close list must be verified for later years before this date, and
    // LAST_VERIFIED_CALENDAR_YEAR raised.
    expect(Date.now()).toBeLessThan(Date.parse("2028-07-01T00:00:00Z"));
  });
});
