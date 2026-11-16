// "14:02 UTC" for status texts (owner rule 2026-11-11: name since when); "Nov 14 14:02 UTC" when the
// instant is not on the UTC day of `now`. Built from UTC fields, no locale APIs. Unparsable input: "time not recorded".
const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

const toMs = (value: Date | string | number): number =>
  value instanceof Date
    ? value.getTime()
    : typeof value === "number"
      ? value
      : Date.parse(value);

export const utcClock = (
  at: Date | string | number,
  now: Date | number = Date.now()
): string => {
  const ms = toMs(at);
  if (!Number.isFinite(ms)) return "time not recorded";
  const iso = new Date(ms).toISOString();
  const clock = `${iso.slice(11, 16)} UTC`;
  const nowMs = toMs(now);
  if (
    Number.isFinite(nowMs) &&
    new Date(nowMs).toISOString().slice(0, 10) === iso.slice(0, 10)
  )
    return clock;
  const date = new Date(ms);
  return `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()} ${clock}`;
};
