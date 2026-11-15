// NYSE session calendar for the breadth-90 tick (New York time). Full-day closures and 13:00 early
// closes for 2025-2027 from the NYSE holiday schedule; extend the lists before 2028.

const NYSE_HOLIDAYS: ReadonlySet<string> = new Set([
  "2025-01-01",
  "2025-01-09",
  "2025-01-20",
  "2025-02-17",
  "2025-04-18",
  "2025-05-26",
  "2025-06-19",
  "2025-07-04",
  "2025-09-01",
  "2025-11-27",
  "2025-12-25",
  "2026-01-01",
  "2026-01-19",
  "2026-02-16",
  "2026-04-03",
  "2026-05-25",
  "2026-06-19",
  "2026-07-03",
  "2026-09-07",
  "2026-11-26",
  "2026-12-25",
  "2027-01-01",
  "2027-01-18",
  "2027-02-15",
  "2027-03-26",
  "2027-05-31",
  "2027-06-18",
  "2027-07-05",
  "2027-09-06",
  "2027-11-25",
  "2027-12-24",
]);

const NYSE_EARLY_CLOSES: ReadonlySet<string> = new Set([
  "2025-07-03",
  "2025-11-28",
  "2025-12-24",
  "2026-11-27",
  "2026-12-24",
  "2027-11-26",
]);

const PARTS = new Intl.DateTimeFormat("en-US", {
  day: "2-digit",
  hour: "2-digit",
  hourCycle: "h23",
  minute: "2-digit",
  month: "2-digit",
  timeZone: "America/New_York",
  weekday: "short",
  year: "numeric",
});

export type NyTime = Readonly<{
  date: string;
  minutes: number;
  weekday: string;
}>;

/** New York calendar date (YYYY-MM-DD), minutes after midnight and weekday for an instant. */
export const nyTime = (instant: Date): NyTime => {
  const part = Object.fromEntries(
    PARTS.formatToParts(instant).map((item) => [item.type, item.value])
  );
  return {
    date: `${part["year"]}-${part["month"]}-${part["day"]}`,
    minutes: Number(part["hour"]) * 60 + Number(part["minute"]),
    weekday: String(part["weekday"]),
  };
};

export const isTradingDay = (date: string): boolean => {
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
  return weekday !== 0 && weekday !== 6 && !NYSE_HOLIDAYS.has(date);
};

/** Session close in New York minutes after midnight (16:00, or 13:00 on an early close). */
export const closeMinutes = (date: string): number =>
  NYSE_EARLY_CLOSES.has(date) ? 13 * 60 : 16 * 60;

export const OPEN_MINUTES = 9 * 60 + 30;
