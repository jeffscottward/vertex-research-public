import { describe, expect, it } from "vitest";
import {
  congressTradesSearch,
  normalizeTicker,
  parseCongressTradesParams,
} from "./congress-trades-params.ts";

describe("congress trades params", () => {
  it("falls back to the defaults for missing or unknown values", () => {
    expect(parseCongressTradesParams({})).toEqual({
      chamber: "",
      days: 30,
      member: "",
      ticker: "",
    });
    return expect(
      parseCongressTradesParams({
        chamber: "assembly",
        days: "45",
        member: "x".repeat(201),
        ticker: ["ACME"],
      })
    ).toEqual({ chamber: "", days: 30, member: "", ticker: "" });
  });

  it("reads every known value and normalizes the ticker", () =>
    expect(
      parseCongressTradesParams({
        chamber: "senate",
        days: "7",
        member: "Avery",
        ticker: " acme ",
      })
    ).toEqual({ chamber: "senate", days: 7, member: "Avery", ticker: "ACME" }));

  it("trims the member and drops a blank one", () => {
    expect(parseCongressTradesParams({ member: "   " }).member).toBe("");
    expect(parseCongressTradesParams({ member: "\t\n" }).member).toBe("");
    expect(
      parseCongressTradesParams({ member: ` ${"x".repeat(200)} ` }).member
    ).toBe("x".repeat(200));
    return expect(
      parseCongressTradesParams({ member: "  Hon. Avery Example " }).member
    ).toBe("Hon. Avery Example");
  });

  it("drops a ticker that breaks the symbol rule", () => {
    expect(normalizeTicker("not a ticker")).toBe("");
    return expect(normalizeTicker("brk.b")).toBe("BRK.B");
  });

  return it("writes only the non-default values", () => {
    expect(
      congressTradesSearch({ chamber: "", days: 30, member: "", ticker: "" })
    ).toBe("");
    return expect(
      congressTradesSearch({
        chamber: "house",
        days: 90,
        member: "Avery Example",
        ticker: "ACME",
      })
    ).toBe("?days=90&chamber=house&ticker=ACME&member=Avery+Example");
  });
});
