// Regular NYSE full-day holiday calendar (UTC day numbers: days since 1970-01-01).
// Leaf module shared by strategy-dsl-compile.ts and price-freshness.ts without coupling
// OpenBB freshness checks to the strategy DSL compiler.

const DAY_MS = 86_400_000;

/** 0 Sunday to 6 Saturday of a UTC day number (days since 1970-01-01, a Thursday). */
export const weekday = (day: number): number => (((day + 4) % 7) + 7) % 7;

/** UTC day number of a calendar date (month is 0-indexed: 0 January to 11 December). */
export const utcDay = (year: number, month: number, date: number): number =>
  Date.UTC(year, month, date) / DAY_MS;

/** UTC day of the `n`th `day` (0 Sunday to 6 Saturday) of a month (0 January). */
export const nthWeekday = (
  year: number,
  month: number,
  day: number,
  n: number
): number => {
  const first = utcDay(year, month, 1);
  return first + ((day - weekday(first) + 7) % 7) + 7 * (n - 1);
};

const lastWeekday = (year: number, month: number, day: number): number => {
  const last = utcDay(year, month + 1, 1) - 1;
  return last - ((weekday(last) - day + 7) % 7);
};

/** A Saturday holiday is observed on Friday, a Sunday holiday on Monday. */
const observed = (day: number): number => {
  const of = weekday(day);
  if (of === 6) return day - 1;
  return of === 0 ? day + 1 : day;
};

/** Gregorian Easter Sunday (anonymous Gregorian algorithm) as a UTC day. */
const easterSunday = (year: number): number => {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const h =
    (19 * a +
      b -
      Math.floor(b / 4) -
      Math.floor((b - Math.floor((b + 8) / 25) + 1) / 3) +
      15) %
    30;
  const l = (32 + 2 * (b % 4) + 2 * Math.floor(c / 4) - h - (c % 4)) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  return utcDay(year, month - 1, ((h + l - 7 * m + 114) % 31) + 1);
};

/**
 * Special NYSE full-day closures since 1998 (not set by the holiday rules): September 11 attacks,
 * the national days of mourning for Presidents Reagan, Ford, G. H. W. Bush and Carter, and
 * Hurricane Sandy. Python mirror: signals.NYSE_SPECIAL_CLOSURES.
 */
export const NYSE_SPECIAL_CLOSURES: readonly string[] = [
  "2001-09-11",
  "2001-09-12",
  "2001-09-13",
  "2001-09-14",
  "2004-06-11",
  "2007-01-02",
  "2012-10-29",
  "2012-10-30",
  "2018-12-05",
  "2025-01-09",
];

const holidayCache = new Map<number, ReadonlySet<number>>();

/**
 * Regular NYSE full-day holidays of a year as UTC days, the rules since 1998 (the same rules as
 * the research calendar, qc_ports calendar.is_nyse_holiday): New Year (not observed on a Saturday),
 * Martin Luther King Jr. Day, Washington's Birthday, Good Friday, Memorial Day, Juneteenth (from
 * 2022), Independence Day, Labor Day, Thanksgiving and Christmas, plus the special closures of
 * NYSE_SPECIAL_CLOSURES in that year.
 */
export const nyseHolidays = (year: number): ReadonlySet<number> => {
  const cached = holidayCache.get(year);
  if (cached !== undefined) return cached;
  const days = new Set<number>([
    nthWeekday(year, 0, 1, 3),
    nthWeekday(year, 1, 1, 3),
    easterSunday(year) - 2,
    lastWeekday(year, 4, 1),
    observed(utcDay(year, 6, 4)),
    nthWeekday(year, 8, 1, 1),
    nthWeekday(year, 10, 4, 4),
    observed(utcDay(year, 11, 25)),
  ]);
  const newYear = utcDay(year, 0, 1);
  if (weekday(newYear) !== 6) days.add(observed(newYear));
  if (year >= 2022) days.add(observed(utcDay(year, 5, 19)));
  for (const date of NYSE_SPECIAL_CLOSURES)
    if (date.startsWith(`${year}-`)) days.add(Date.parse(date) / DAY_MS);
  holidayCache.set(year, days);
  return days;
};

/** A weekday that is not an NYSE holiday (UTC day number). */
export const isNyseTradingDay = (day: number): boolean => {
  const of = weekday(day);
  return (
    of >= 1 &&
    of <= 5 &&
    !nyseHolidays(new Date(day * DAY_MS).getUTCFullYear()).has(day)
  );
};

/** UTC day number of a `YYYY-MM-DD` date. */
export const utcDayOfIso = (iso: string): number =>
  Date.parse(`${iso}T00:00:00Z`) / DAY_MS;

/** `YYYY-MM-DD` of a UTC day number. */
export const isoDayOf = (day: number): string =>
  new Date(day * DAY_MS).toISOString().slice(0, 10);

/** Most recent NYSE trading day strictly before `todayUtcDay`, formatted as `YYYY-MM-DD`. */
export const previousNyseTradingDay = (todayUtcDay: number): string => {
  let day = todayUtcDay - 1;
  while (!isNyseTradingDay(day)) day -= 1;
  return isoDayOf(day);
};

/**
 * NYSE early close (13:00 instead of 16:00 New York) on a trading day: 3 July, 24 December and
 * the day after Thanksgiving. False on a day that is not a trading day.
 */
export const isNyseEarlyClose = (day: number): boolean => {
  if (!isNyseTradingDay(day)) return false;
  const date = new Date(day * DAY_MS);
  const month = date.getUTCMonth();
  const dayOfMonth = date.getUTCDate();
  return (
    (month === 6 && dayOfMonth === 3) ||
    (month === 11 && dayOfMonth === 24) ||
    day === nthWeekday(date.getUTCFullYear(), 10, 4, 4) + 1
  );
};

/**
 * Minutes by which an NYSE early close (13:00 instead of 16:00 New York) moves each NYSE-calendar
 * window close of that day earlier.
 */
const NYSE_EARLY_CLOSE_SHIFT_MINUTES = 180;

/**
 * The close (New York minutes after midnight) on the UTC day `day` of a window whose regular close
 * is `regularCloseMinute`: 180 minutes earlier on an NYSE early close.
 */
export const nyseCloseMinute = (
  day: number,
  regularCloseMinute: number
): number =>
  isNyseEarlyClose(day)
    ? regularCloseMinute - NYSE_EARLY_CLOSE_SHIFT_MINUTES
    : regularCloseMinute;
