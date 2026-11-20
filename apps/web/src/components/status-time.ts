// Time texts for status lines (status language rule: a status names since when).
// One format for every status text: "HH:MM UTC", with the date when the time is not on the
// current UTC day, so a failure of yesterday does not read as one of today.

const toDate = (time: Date | number): Date =>
  typeof time === "number" ? new Date(time) : time;

/** "14:05 UTC", or "2026-11-18 14:05 UTC" when `time` is not on the UTC day of `now`. */
export const utcClock = (
  time: Date | number,
  now: Date = new Date()
): string => {
  const iso = toDate(time).toISOString();
  const clock = `${iso.slice(11, 16)} UTC`;
  return iso.slice(0, 10) === now.toISOString().slice(0, 10)
    ? clock
    : `${iso.slice(0, 10)} ${clock}`;
};

/** Badge text of a workspace whose load request failed at `failedAt` (epoch milliseconds). */
export const loadFailedLabel = (
  failedAt: number,
  now: Date = new Date()
): string => `Load failed ${utcClock(failedAt, now)}`;

// A date and time with a zone ("2026-11-19T14:05:00Z", "…+00:00"). A date alone, or a time
// without a zone, is not an instant: formatting it would show a clock time nobody sent.
const ISO_INSTANT =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

/** Text for a time that the source did not send or that cannot be read as a time. */
export const TIME_NOT_REPORTED = "time not reported by source";

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
  if (typeof time === "string" && !ISO_INSTANT.test(time)) {
    return TIME_NOT_REPORTED;
  }
  const date = time instanceof Date ? time : new Date(time);
  return Number.isFinite(date.getTime())
    ? utcClock(date, now)
    : TIME_NOT_REPORTED;
};
