import { describe, expect, it } from "vitest";

import {
  compareSortValues,
  isEmptySortValue,
  numericSortKey,
  type SortDirection,
  type SortValue,
} from "./data-table-sort.ts";

const sortBy = (values: SortValue[], direction: SortDirection) =>
  [...values].sort((left, right) => compareSortValues(left, right, direction));

describe("compareSortValues", () => {
  it("sorts plain numbers numerically", () => {
    expect(sortBy([10, 2, -3, 1.5], "asc")).toEqual([-3, 1.5, 2, 10]);
    return expect(sortBy([10, 2, -3], "desc")).toEqual([10, 2, -3]);
  });

  it("sorts percent and currency strings numerically", () => {
    expect(sortBy(["12.5%", "2%", "-0.4%", ".5%"], "asc")).toEqual([
      "-0.4%",
      ".5%",
      "2%",
      "12.5%",
    ]);
    expect(sortBy(["$1,234", "$99", "-$5", "$-7"], "asc")).toEqual([
      "$-7",
      "-$5",
      "$99",
      "$1,234",
    ]);
    return expect(sortBy(["$1,234", "$99"], "desc")).toEqual(["$1,234", "$99"]);
  });

  it("sorts dates and ISO date strings chronologically", () => {
    const early = new Date("2025-01-02");
    const late = new Date("2026-10-21");
    expect(sortBy([late, early], "asc")).toEqual([early, late]);
    return expect(
      sortBy(["2026-10-21T10:00:00Z", "2025-01-02", "2026-02-01"], "desc")
    ).toEqual(["2026-10-21T10:00:00Z", "2026-02-01", "2025-01-02"]);
  });

  it("sorts text case-insensitively and falls back to text for invalid dates", () => {
    expect(sortBy(["beta", "Alpha", "gamma"], "asc")).toEqual([
      "Alpha",
      "beta",
      "gamma",
    ]);
    return expect(sortBy(["2026-99-99", "2026-01-01"], "asc")).toEqual([
      "2026-01-01",
      "2026-99-99",
    ]);
  });

  return it("keeps empty values last in both directions", () => {
    const values: SortValue[] = [
      "",
      3,
      null,
      "—",
      1,
      undefined,
      "-",
      Number.NaN,
      new Date("x"),
    ];
    expect(sortBy(values, "asc").slice(0, 2)).toEqual([1, 3]);
    expect(sortBy(values, "desc").slice(0, 2)).toEqual([3, 1]);
    expect(isEmptySortValue("  ")).toBe(true);
    expect(isEmptySortValue("a")).toBe(false);
    return expect(numericSortKey("abc")).toBeUndefined();
  });
});
