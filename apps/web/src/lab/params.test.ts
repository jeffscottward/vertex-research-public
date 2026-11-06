import { describe, expect, it } from "vitest";

import {
  readLabChoice,
  readLabSymbol,
  readLabTheme,
  toLabSearchParams,
  withLabParam,
} from "./params.ts";

describe("lab query params", () => {
  it("converts Next.js searchParams, keeping repeated values", () => {
    const params = toLabSearchParams({
      missing: undefined,
      symbol: "NVDA",
      tag: ["a", "b"],
    });
    expect(params.toString()).toBe("symbol=NVDA&tag=a&tag=b");
  });

  it("reads the theme, dark by default", () => {
    expect(readLabTheme(new URLSearchParams())).toBe("dark");
    expect(readLabTheme(new URLSearchParams("theme=light"))).toBe("light");
    expect(readLabTheme(new URLSearchParams("theme=%20light%20"))).toBe(
      "light"
    );
    expect(readLabTheme(new URLSearchParams("theme=blue"))).toBe("dark");
  });

  it("reads a choice from an allowed list", () => {
    const choices = ["1D", "1W"] as const;
    expect(
      readLabChoice(
        new URLSearchParams("interval=1W"),
        "interval",
        choices,
        "1D"
      )
    ).toBe("1W");
    expect(
      readLabChoice(
        new URLSearchParams("interval=5m"),
        "interval",
        choices,
        "1D"
      )
    ).toBe("1D");
  });

  it("reads and upper-cases a ticker symbol", () => {
    expect(readLabSymbol(new URLSearchParams("symbol=nvda"), "SPY")).toBe(
      "NVDA"
    );
    expect(readLabSymbol(new URLSearchParams("symbol=BRK.B"), "SPY")).toBe(
      "BRK.B"
    );
    expect(readLabSymbol(new URLSearchParams("symbol=1bad"), "SPY")).toBe(
      "SPY"
    );
    expect(readLabSymbol(new URLSearchParams(), "SPY")).toBe("SPY");
    expect(
      readLabSymbol(new URLSearchParams("ticker=msft"), "SPY", "ticker")
    ).toBe("MSFT");
  });

  it("replaces one param and keeps the others", () => {
    expect(
      withLabParam(
        "/lab/charts",
        new URLSearchParams("symbol=NVDA&theme=dark"),
        "theme",
        "light"
      )
    ).toBe("/lab/charts?symbol=NVDA&theme=light");
  });
});
