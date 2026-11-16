import { nyseSession } from "./strategy-dsl-compile.ts";

/** One instant at which the research screen runs, with the names of the rules that set it. */
export type ResearchScreenSlot = Readonly<{
  at: Date;
  labels: readonly string[];
}>;

/** Last year for which the NYSE holiday and early-close list was checked against the exchange. */
export const LAST_VERIFIED_CALENDAR_YEAR = 2028;

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const GRID_MS = 4 * HOUR_MS;
const GRID_LABEL = "Every 4 hours";
/** A session's bars count as due this long after its close. */
const BARS_DUE_AFTER_CLOSE_MS = 2 * HOUR_MS;
const BARS_DUE_SEARCH_DAYS = 10;

const NEW_YORK_YEAR = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  year: "numeric",
});

/**
 * Checkpoints of the New York calendar date `day` (UTC day number) as [instant, label]; none when
 * the day is not an NYSE trading day. 09:00 and 12:00 New York time are taken from the 09:30 open.
 */
const checkpointsOf = (day: number): readonly (readonly [number, string])[] => {
  const session = nyseSession(day);
  if (session === null) return [];
  const open = session.open.getTime();
  const close = session.close.getTime();
  return [
    [open - 30 * MINUTE_MS, "9 AM"],
    [open + 150 * MINUTE_MS, "Noon"],
    [close - 30 * MINUTE_MS, "30 minutes before close"],
    [close + 2 * HOUR_MS, "2 hours after close"],
  ];
};

/**
 * Slots with `after < at <= until`, ascending: the grid every 4 hours from 00:00 UTC on every day,
 * and on NYSE trading days the New York checkpoints. Rules at one instant share one slot, the grid
 * label first.
 */
export const slotsBetween = (
  after: Date,
  until: Date
): ResearchScreenSlot[] => {
  const from = after.getTime();
  const to = until.getTime();
  const labels = new Map<number, string[]>();
  for (
    let at = (Math.floor(from / GRID_MS) + 1) * GRID_MS;
    at <= to;
    at += GRID_MS
  )
    labels.set(at, [GRID_LABEL]);
  // A New York date lies within one UTC day of the UTC date of any of its checkpoints.
  const lastDay = Math.floor(to / DAY_MS) + 1;
  for (let day = Math.floor(from / DAY_MS) - 1; day <= lastDay; day += 1)
    for (const [at, label] of checkpointsOf(day))
      if (at > from && at <= to)
        labels.set(at, [...(labels.get(at) ?? []), label]);
  return [...labels.entries()]
    .sort(([left], [right]) => left - right)
    .map(([at, names]) => ({ at: new Date(at), labels: names }));
};

/** The newest slot at or before `now`; the grid gives one in every 4 hours. */
export const newestSlotAtOrBefore = (now: Date): ResearchScreenSlot =>
  slotsBetween(new Date(now.getTime() - GRID_MS), now).at(
    -1
  ) as ResearchScreenSlot;

/**
 * New York date (YYYY-MM-DD) of the newest NYSE session whose close is at least 2 hours before
 * `now`. Searches back 10 days; null only for an invalid `now`.
 */
export const barsDueSessionDate = (now: Date): string | null => {
  const instant = now.getTime();
  // The due instant of a New York date is on the same UTC date, so no later date can be due.
  const newest = Math.floor(instant / DAY_MS);
  for (let back = 0; back <= BARS_DUE_SEARCH_DAYS; back += 1) {
    const session = nyseSession(newest - back);
    if (
      session !== null &&
      session.close.getTime() + BARS_DUE_AFTER_CLOSE_MS <= instant
    )
      return new Date((newest - back) * DAY_MS).toISOString().slice(0, 10);
  }
  return null;
};

/** True when the New York year of `now` is covered by the verified calendar. */
export const calendarVerified = (now: Date): boolean =>
  Number(NEW_YORK_YEAR.format(now)) <= LAST_VERIFIED_CALENDAR_YEAR;
