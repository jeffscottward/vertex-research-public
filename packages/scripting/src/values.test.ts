import { describe, expect, it } from "vitest";

import { Series, Site } from "./series.ts";
import { color, isColor, num, scalarEquals, typeOf } from "./values.ts";

describe("values", () => {
  it("names every runtime type", () => {
    expect(typeOf(undefined)).toBe("nothing");
    expect(typeOf(null)).toBe("na");
    expect(typeOf([1, 2])).toBe("tuple");
    expect(typeOf(color("#FFFFFF"))).toBe("color");
    expect(typeOf(1)).toBe("number");
    expect(typeOf("a")).toBe("string");
    expect(typeOf(true)).toBe("boolean");
  });

  it("recognizes colors and lower-cases their hex", () => {
    expect(color("#ABCDEF")).toEqual({ color: "#abcdef" });
    expect(isColor({ color: "#000000" })).toBe(true);
    expect(isColor(null)).toBe(false);
    expect(isColor([1])).toBe(false);
    expect(isColor("#000000")).toBe(false);
    expect(isColor({ hex: "#000000" })).toBe(false);
  });

  it("turns non-finite numbers into na", () => {
    expect(num(1.5)).toBe(1.5);
    expect(num(Number.NaN)).toBeNull();
    expect(num(Number.POSITIVE_INFINITY)).toBeNull();
  });

  it("compares colors by hex and other scalars by identity", () => {
    expect(scalarEquals(color("#FF0000"), color("#ff0000"))).toBe(true);
    expect(scalarEquals(color("#ff0000"), color("#00ff00"))).toBe(false);
    expect(scalarEquals(color("#ff0000"), "#ff0000")).toBe(false);
    expect(scalarEquals("a", "a")).toBe(true);
    expect(scalarEquals(1, 2)).toBe(false);
  });
});

describe("series", () => {
  it("keeps one entry per bar and reads na beyond its history", () => {
    const series = new Series();
    expect(series.back(0)).toBeNull();
    series.set(0, 1);
    series.set(0, 2);
    series.set(1, 3);
    expect(series.length).toBe(2);
    expect([series.back(0), series.back(1), series.back(2)]).toEqual([
      3,
      2,
      null,
    ]);
  });

  it("commits site accumulators only when the bar advances", () => {
    const site = new Site();
    // store before any previous() call has nothing to update.
    site.store("acc", 99);
    expect(site.previous("acc", 0, 0)).toBe(0);
    site.store("acc", 5);
    // Asking again on the same bar still sees the value as of the previous bar.
    expect(site.previous("acc", 0, 0)).toBe(0);
    expect(site.previous("acc", 1, 0)).toBe(5);
    expect(site.series("buf")).toBe(site.series("buf"));
    expect(site.record("buf", 0, 7).back(0)).toBe(7);
  });
});
