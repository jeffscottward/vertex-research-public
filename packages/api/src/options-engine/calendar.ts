/**
 * The US equity-options calendar of the qc-ports options runner, ported from
 * services/research/strategies/qc_ports/calendar.py (the parts the book needs).
 *
 * Trading days come from the bar dates where they exist and from the NYSE holiday rules after
 * them. Monthly expiration = 3rd Friday of the month, or the prior trading day when that Friday
 * is not a trading day. The holiday rules are calendar.is_nyse_holiday: regular full-day
 * holidays since 1998 without the special closures (so not strategy-dsl-compile's nyseHolidays,
 * which adds them). Days are UTC day numbers (days since 1970-01-01).
 */

const DAY_MS = 86_400_000;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/u;

/** Python's a % b for b > 0 (never negative). */
const mod = (a: number, b: number): number => ((a % b) + b) % b;

const dayOf = (year: number, month: number, day: number): number =>
  Date.UTC(year, month - 1, day) / DAY_MS;

/** ISO date (YYYY-MM-DD) of a day number. */
export const formatDay = (day: number): string =>
  new Date(day * DAY_MS).toISOString().slice(0, 10);

/** Day number of an ISO date (YYYY-MM-DD, years 1000-9999), as date.fromisoformat. */
export const parseDay = (value: string): number => {
  const match = ISO_DATE.exec(value);
  const day =
    match === null
      ? 0
      : dayOf(Number(match[1]), Number(match[2]), Number(match[3]));
  if (match === null || formatDay(day) !== value)
    throw new Error(`Invalid isoformat string: '${value}'`);
  return day;
};

/** Python date.weekday(): 0 Monday to 6 Sunday (day 0, 1970-01-01, is a Thursday). */
export const weekday = (day: number): number => mod(day + 3, 7);

const yearOf = (day: number): number => new Date(day * DAY_MS).getUTCFullYear();

/** Gregorian Easter Sunday (anonymous Gregorian algorithm). */
export const easter = (year: number): number => {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = mod(19 * a + b - d - g + 15, 30);
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = mod(32 + 2 * e + 2 * i - h - k, 7);
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  return dayOf(year, month, ((h + l - 7 * m + 114) % 31) + 1);
};

/** The n-th `day` (0 Monday) of a month (1 January). */
const nthWeekday = (
  year: number,
  month: number,
  day: number,
  n: number
): number => {
  const first = dayOf(year, month, 1);
  return first + mod(day - weekday(first), 7) + 7 * (n - 1);
};

const lastWeekday = (year: number, month: number, day: number): number => {
  const last = dayOf(year + Math.floor(month / 12), (month % 12) + 1, 1) - 1;
  return last - mod(weekday(last) - day, 7);
};

/** A Saturday holiday is observed on Friday, a Sunday holiday on Monday. */
const observed = (day: number): number => {
  const of = weekday(day);
  if (of === 5) return day - 1;
  return of === 6 ? day + 1 : day;
};

const holidayCache = new Map<number, ReadonlySet<number>>();

const holidays = (year: number): ReadonlySet<number> => {
  const cached = holidayCache.get(year);
  if (cached !== undefined) return cached;
  const days = new Set([
    nthWeekday(year, 1, 0, 3), // Martin Luther King Jr. Day
    nthWeekday(year, 2, 0, 3), // Washington's Birthday
    easter(year) - 2, // Good Friday
    lastWeekday(year, 5, 0), // Memorial Day
    observed(dayOf(year, 7, 4)),
    nthWeekday(year, 9, 0, 1), // Labor Day
    nthWeekday(year, 11, 3, 4), // Thanksgiving
    observed(dayOf(year, 12, 25)),
  ]);
  const newYear = dayOf(year, 1, 1);
  if (weekday(newYear) !== 5) days.add(observed(newYear)); // no Dec 31 for a Saturday New Year
  if (year >= 2022) days.add(observed(dayOf(year, 6, 19)));
  holidayCache.set(year, days);
  return days;
};

/** Regular NYSE full-day holidays (rules since 1998; special closures are not modeled). */
export const isNyseHoliday = (day: number): boolean =>
  holidays(yearOf(day)).has(day);

/** Trading days: the given bar dates, extended after the last one by the NYSE rules. */
export class TradingCalendar {
  readonly first: number;
  readonly last: number;
  readonly #days: ReadonlySet<number>;

  constructor(dates: Iterable<string>) {
    const days = [...new Set([...dates].map(parseDay))].sort((a, b) => a - b);
    if (days.length === 0)
      throw new Error("TradingCalendar needs at least one date");
    this.#days = new Set(days);
    this.first = days[0] as number;
    this.last = days.at(-1) as number;
  }

  isTradingDay(day: number): boolean {
    if (this.first <= day && day <= this.last) return this.#days.has(day);
    return weekday(day) < 5 && !isNyseHoliday(day);
  }

  previousTradingDay(day: number): number {
    let previous = day - 1;
    while (!this.isTradingDay(previous)) previous -= 1;
    return previous;
  }
}

/** 3rd Friday, or the prior trading day when the 3rd Friday is not a trading day. */
export const monthlyExpiration = (
  year: number,
  month: number,
  calendar: TradingCalendar
): number => {
  const friday = nthWeekday(year, month, 4, 3);
  return calendar.isTradingDay(friday)
    ? friday
    : calendar.previousTradingDay(friday);
};

/** Monthly expirations on or after `day`, scanning `months` calendar months from its month. */
export const expirationsAfter = (
  day: number,
  months: number,
  calendar: TradingCalendar
): number[] => {
  const start = new Date(day * DAY_MS);
  const out: number[] = [];
  for (let offset = 0; offset <= months; offset++) {
    const serial = start.getUTCFullYear() * 12 + start.getUTCMonth() + offset;
    const expiry = monthlyExpiration(
      Math.floor(serial / 12),
      (serial % 12) + 1,
      calendar
    );
    if (expiry >= day) out.push(expiry);
  }
  return out;
};
