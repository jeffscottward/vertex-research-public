// Time texts for status lines (status language rule: a status names since when).
// One format for every status text: "HH:MM UTC", with the date when the time is not on the
// current UTC day, so a failure of yesterday does not read as one of today.

const toDate = (time: Date | number): Date =>
  typeof time === "number" ? new Date(time) : time;

/** Text for a time that the source did not send or that cannot be read as a time. */
export const TIME_NOT_REPORTED = "time not reported by source";

/** 10000-01-01T00:00:00Z: the first instant with a six-digit ISO year. */
const MAX_ISO_EPOCH = Date.UTC(10_000, 0, 1);

/**
 * "14:05 UTC", or "2026-11-18 14:05 UTC" when `time` is not on the UTC day of `now`.
 * An invalid time gives TIME_NOT_REPORTED instead of a RangeError. A time at or before
 * 1970-01-01 00:00 UTC also does: it is a missing time that a source sent as 0, and showing it
 * as a date would turn missing data into a fake time.
 */
export const utcClock = (
  time: Date | number,
  now: Date = new Date()
): string => {
  const epoch = toDate(time).getTime();
  // After year 9999 toISOString has a six-digit year, and the slices below would cut it into
  // a fake time (an epoch sent in microseconds lands there).
  if (!Number.isFinite(epoch) || epoch <= 0 || epoch >= MAX_ISO_EPOCH) {
    return TIME_NOT_REPORTED;
  }
  const iso = new Date(epoch).toISOString();
  const clock = `${iso.slice(11, 16)} UTC`;
  return Number.isFinite(now.getTime()) &&
    iso.slice(0, 10) === now.toISOString().slice(0, 10)
    ? clock
    : `${iso.slice(0, 10)} ${clock}`;
};

/** Badge text of a workspace whose load request failed at `failedAt` (epoch milliseconds). */
export const loadFailedLabel = (
  failedAt: number,
  now: Date = new Date()
): string => {
  const time = utcClock(failedAt, now);
  return time === TIME_NOT_REPORTED
    ? `Load failed (${TIME_NOT_REPORTED})`
    : `Load failed ${time}`;
};

// A date and time with a zone ("2026-11-19T14:05:00Z", "…+00:00"). A date alone, or a time
// without a zone, is not an instant: formatting it would show a clock time nobody sent.
const ISO_INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

// The text names a real calendar day and clock time. Date would roll "2026-02-30" over to
// March 2 and "24:00" over to the next day: a time the source did not send.
const isCalendarInstant = (text: string): boolean => {
  const match = ISO_INSTANT.exec(text);
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const calendar = new Date(Date.UTC(year, month - 1, day));
  return (
    calendar.getUTCFullYear() === year &&
    calendar.getUTCMonth() + 1 === month &&
    calendar.getUTCDate() === day &&
    Number(match[4]) <= 23 &&
    Number(match[5]) <= 59 &&
    Number(match[6] ?? "0") <= 59
  );
};

/**
 * utcClock for a time as the API sends it (ISO date-time text with a zone, epoch milliseconds or
 * a Date). A missing time, or a text that is not such a date-time, gives TIME_NOT_REPORTED and never an "Invalid Date".
 */
export const statusTime = (
  time: Date | number | string | null | undefined,
  now: Date = new Date()
): string => {
  if (time === null || time === undefined || time === "") {
    return TIME_NOT_REPORTED;
  }
  if (typeof time === "string" && !isCalendarInstant(time)) {
    return TIME_NOT_REPORTED;
  }
  return utcClock(time instanceof Date ? time : new Date(time), now);
};
