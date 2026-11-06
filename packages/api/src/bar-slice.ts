import type { BarColumns } from "./instant-backtest-engine.ts";

// Date-range slicing of bar columns (pure). A backtest run, a sweep, the Nautilus worker inputs
// and the Autopilot gate comparison all cut the stored bars this way, so every engine gets the
// same bars for the same date range.

const DAY_MS = 86_400_000;

/** Copies the bars whose time falls on or between the two UTC calendar dates. */
export const sliceColumnsByDate = <Columns extends BarColumns>(
  columns: Columns,
  from: string,
  to: string
): BarColumns => {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`) + DAY_MS;
  let first = 0;
  while (first < columns.t.length && (columns.t[first] as number) < start)
    first += 1;
  let last = first;
  while (last < columns.t.length && (columns.t[last] as number) < end)
    last += 1;
  return {
    c: columns.c.slice(first, last),
    h: columns.h.slice(first, last),
    l: columns.l.slice(first, last),
    o: columns.o.slice(first, last),
    t: columns.t.slice(first, last),
    ...(columns.v === undefined ? {} : { v: columns.v.slice(first, last) }),
  };
};
