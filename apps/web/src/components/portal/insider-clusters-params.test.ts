import { describe, expect, it } from "vitest";
import { parseInsiderClustersParams } from "./insider-clusters-params.ts";

describe("insider clusters params", () => {
  it("reads 7, 14 and 30", () => {
    expect(parseInsiderClustersParams({ days: "14" })).toEqual({ days: 14 });
    expect(parseInsiderClustersParams({ days: "30" })).toEqual({ days: 30 });
    expect(parseInsiderClustersParams({ days: "7" })).toEqual({ days: 7 });
  });
  it("falls back to 7 for anything else", () => {
    expect(parseInsiderClustersParams({})).toEqual({ days: 7 });
    expect(parseInsiderClustersParams({ days: "90" })).toEqual({ days: 7 });
    expect(parseInsiderClustersParams({ days: ["14"] })).toEqual({ days: 7 });
  });
});
