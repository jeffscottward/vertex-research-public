// What: pure DataTable sort comparator (owner rules 2026-10-21): numbers, currency, percents and dates compare numerically; text compares case-insensitively; empty values always sort last in both directions.
// Used by: packages/ui/src/client/data-table.tsx.
// See: packages/ui/src/data-table-sort.test.ts.

export type SortDirection = "asc" | "desc";
export type SortValue = string | number | Date | null | undefined;

const NUMERIC =
  /^[-+]?[$€£]?\s*[-+]?\d[\d,]*(?:\.\d+)?\s*%?$|^[-+]?[$€£]?\s*\.\d+\s*%?$/;
const DATE_LIKE = /^\d{4}-\d{2}-\d{2}/;

export const isEmptySortValue = (value: SortValue): boolean => {
  if (value === null || value === undefined) return true;
  if (typeof value === "number") return Number.isNaN(value);
  if (value instanceof Date) return Number.isNaN(value.getTime());
  const trimmed = value.trim();
  return trimmed === "" || trimmed === "—" || trimmed === "-";
};

/** Numeric key for numbers, dates, ISO-date strings, currency and percent strings; undefined for text. */
export const numericSortKey = (value: SortValue): number | undefined => {
  if (typeof value === "number") return value;
  if (value instanceof Date) return value.getTime();
  const trimmed = String(value).trim();
  if (NUMERIC.test(trimmed)) {
    const negative = trimmed.startsWith("-") || /^[$€£]\s*-/.test(trimmed);
    const magnitude = Number(trimmed.replace(/[^\d.]/g, ""));
    return negative ? -magnitude : magnitude;
  }
  if (DATE_LIKE.test(trimmed)) {
    const time = Date.parse(trimmed);
    if (!Number.isNaN(time)) return time;
  }
  return undefined;
};

const collator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});

export const compareSortValues = (
  left: SortValue,
  right: SortValue,
  direction: SortDirection
): number => {
  const leftEmpty = isEmptySortValue(left);
  const rightEmpty = isEmptySortValue(right);
  if (leftEmpty || rightEmpty) {
    return Number(leftEmpty) - Number(rightEmpty);
  }
  const sign = direction === "asc" ? 1 : -1;
  const leftNumber = numericSortKey(left);
  const rightNumber = numericSortKey(right);
  if (leftNumber !== undefined && rightNumber !== undefined) {
    return sign * (leftNumber - rightNumber);
  }
  return sign * collator.compare(String(left), String(right));
};
