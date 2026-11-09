import { describe, expect, it } from "vitest";

import { toPaletteItems } from "../components/command-palette.tsx";
import { PORTAL_SIDEBAR_GROUPS, SETTINGS_NAVIGATION } from "./navigation.ts";
import {
  type PaletteEntry,
  type PaletteGroup,
  type PaletteItem,
  paletteGroups,
} from "./palette-commands.ts";

const items: PaletteItem[] = [
  { group: "Workspace", href: "/dashboard", label: "Mission control" },
  { group: "Workspace", href: "/backtests", label: "Backtests" },
  { group: "Records", href: "/audit", label: "Audit" },
];

const headings = (groups: readonly PaletteGroup[]): string[] =>
  groups.map((group) => group.heading);

const entries = (query: string): PaletteEntry[] =>
  paletteGroups(items, query).flatMap((group) => group.entries);

const hrefs = (query: string): string[] =>
  entries(query).flatMap((entry) => (entry.kind === "go" ? [entry.href] : []));

/** The first entry for a query (the one Enter acts on). */
const top = (query: string): PaletteEntry | undefined => entries(query)[0];

describe("paletteGroups commands", () => {
  it.each([
    ["chart NVDA 1D", "/charts?symbol=NVDA", "Chart NVDA · 1D"],
    ["chart nvda 1d", "/charts?symbol=NVDA", "Chart NVDA · 1D"],
    ["chart NVDA", "/charts?symbol=NVDA", "Chart NVDA · 1D"],
    ["chart NVDA 1W", "/charts?symbol=NVDA&interval=1W", "Chart NVDA · 1W"],
    [
      "options AAPL 2026-12-19",
      "/stock/AAPL?expiry=2026-12-19&tab=options",
      "Options AAPL · 2026-12-19",
    ],
    [
      "options AAPL",
      "/stock/AAPL?tab=options",
      "Options AAPL · nearest expiry",
    ],
    ["stock nvda", "/stock/NVDA", "Open NVDA"],
    ["stock NVDA 1W", "/stock/NVDA?interval=1W", "Open NVDA · 1W"],
    ["analytics TSLA", "/stock/TSLA?tab=analytics", "Analytics TSLA"],
  ])("%s opens %s", (query, href, label) => {
    expect(paletteGroups(items, query)[0]?.heading).toBe("Commands");
    return expect(top(query)).toMatchObject({ href, kind: "go", label });
  });

  it("accepts command aliases in any case", () => {
    expect(top("c NVDA")).toMatchObject({ href: "/charts?symbol=NVDA" });
    expect(top("Charts NVDA")).toMatchObject({ href: "/charts?symbol=NVDA" });
    expect(top("opt AAPL")).toMatchObject({ href: "/stock/AAPL?tab=options" });
    expect(top("o AAPL")).toMatchObject({ href: "/stock/AAPL?tab=options" });
    expect(top("option AAPL")).toMatchObject({
      href: "/stock/AAPL?tab=options",
    });
    expect(top("quote msft")).toMatchObject({ href: "/stock/MSFT" });
    return expect(top("s msft")).toMatchObject({ href: "/stock/MSFT" });
  });

  it.each([
    ["1m", "1m"],
    ["1M", "1M"],
    ["1h", "1h"],
    ["1H", "1h"],
    ["1d", "1D"],
    ["1w", "1W"],
    ["15M", "15m"],
    ["daily", "1D"],
    ["Day", "1D"],
    ["week", "1W"],
    ["weekly", "1W"],
    ["month", "1M"],
    ["monthly", "1M"],
    ["hour", "1h"],
  ])("reads the interval %s as %s", (token, interval) =>
    expect(top(`chart SPY ${token}`)).toMatchObject({
      label: `Chart SPY · ${interval}`,
    })
  );

  it.each([
    ["chart NVDA 1Y", '"1Y" is not an interval: 1m 5m 15m 30m 1h 1D 1W 1M'],
    ["chart NVDA constructor", '"constructor" is not an interval'],
    ["options AAPL 2026-02-31", '"2026-02-31" is not a date'],
    ["options AAPL soon", '"soon" is not a date'],
    ["chart 123", '"123" is not a ticker'],
    ["chart NVDA 1W extra", 'Too many words after "1W"'],
    ["analytics TSLA 1W", '"1W" is not expected'],
  ])("%s gives a hint and no page to open", (query, problem) => {
    const [entry] = paletteGroups(items, query)[0]?.entries ?? [];
    expect(entry?.kind).toBe("hint");
    expect(entry?.label).toContain(problem);
    return expect(entry?.label).toMatch(/Use: \w+ <ticker>/u);
  });

  it("offers the command template while the ticker is missing", () => {
    expect(top("chart")).toEqual({
      fill: "chart ",
      hint: "chart <ticker> [interval]",
      id: "complete:chart",
      kind: "complete",
      label: "Chart",
    });
    return expect(top("options ")).toMatchObject({
      fill: "options ",
      hint: "options <ticker> [YYYY-MM-DD]",
      kind: "complete",
    });
  });

  it("lists matching pages after the command template", () => {
    const charts = { group: "Research", href: "/charts", label: "Charts" };
    const groups = paletteGroups([...items, charts], "chart");
    // CHART is also ticker-shaped, so its stock rows follow the page.
    expect(headings(groups)).toEqual(["Commands", "Pages", "Ticker"]);
    expect(groups[0]?.entries.map((entry) => entry.id)).toEqual([
      "complete:chart",
    ]);
    return expect(groups[1]?.entries.map((entry) => entry.id)).toEqual([
      "page:Research:/charts",
    ]);
  });

  it("keeps tickers that are also aliases (C, O, S, OPT)", () => {
    const groups = paletteGroups(items, "c");
    expect(headings(groups)).toEqual(["Commands", "Pages", "Ticker"]);
    expect(top("c")).toMatchObject({ fill: "chart ", kind: "complete" });
    expect(hrefs("o")).toContain("/stock/O");
    expect(hrefs("opt")).toContain("/stock/OPT");
    expect(top("c 1w")).toMatchObject({ href: "/stock/C?interval=1W" });
    return expect(top("c nvda")).toMatchObject({
      href: "/charts?symbol=NVDA",
      kind: "go",
    });
  });

  it("keeps the hint for a full command name with a wrong argument", () =>
    expect(top("chart 1y")).toMatchObject({ kind: "hint" }));
});

describe("paletteGroups completions", () => {
  it("offers every command template, then every page, for an empty query", () => {
    const groups = paletteGroups(items, "  ");
    expect(headings(groups)).toEqual(["Commands", "Pages"]);
    expect(groups[0]?.entries.map((entry) => entry.id)).toEqual([
      "complete:chart",
      "complete:options",
      "complete:stock",
      "complete:analytics",
    ]);
    return expect(hrefs("")).toEqual(["/dashboard", "/backtests", "/audit"]);
  });

  it("completes a partial command name before anything else", () => {
    expect(top("ch")).toMatchObject({ fill: "chart ", kind: "complete" });
    expect(top("OPT")).toMatchObject({ fill: "options ", kind: "complete" });
    return expect(
      paletteGroups(items, "an")[0]?.entries.map((entry) => entry.id)
    ).toEqual(["complete:analytics"]);
  });
});

describe("paletteGroups tickers", () => {
  it("offers the stock page, chart and options for a bare ticker", () => {
    const groups = paletteGroups(items, "nvda");
    expect(headings(groups)).toEqual(["Ticker"]);
    expect(groups[0]?.entries.map((entry) => entry.label)).toEqual([
      "Open NVDA",
      "Chart NVDA · 1D",
      "Options NVDA · nearest expiry",
    ]);
    return expect(hrefs("nvda")).toEqual([
      "/stock/NVDA",
      "/charts?symbol=NVDA",
      "/stock/NVDA?tab=options",
    ]);
  });

  it("passes a ticker's interval to the stock page and chart", () => {
    expect(top("NVDA 1W")).toMatchObject({
      href: "/stock/NVDA?interval=1W",
      label: "Open NVDA · 1W",
    });
    return expect(hrefs("NVDA 1W")).toEqual([
      "/stock/NVDA?interval=1W",
      "/charts?symbol=NVDA&interval=1W",
      "/stock/NVDA?tab=options",
    ]);
  });

  it("keeps page matches ahead of the ticker", () => {
    expect(headings(paletteGroups(items, "audit"))).toEqual([
      "Pages",
      "Ticker",
    ]);
    return expect(hrefs("audit").slice(0, 2)).toEqual([
      "/audit",
      "/stock/AUDIT",
    ]);
  });

  it("offers no ticker for text that is not one", () => {
    expect(headings(paletteGroups(items, "mission control"))).toEqual([
      "Pages",
    ]);
    expect(headings(paletteGroups(items, "nvda soon"))).toEqual([]);
    return expect(headings(paletteGroups(items, "nvda 1W 1D"))).toEqual([]);
  });
});

describe("paletteGroups with the real portal navigation", () => {
  const portal = toPaletteItems([
    ...PORTAL_SIDEBAR_GROUPS.map((group) => ({
      group: group.label,
      items: group.items,
    })),
    { group: "Settings", items: SETTINGS_NAVIGATION },
  ]);
  const first = (query: string): PaletteEntry | undefined =>
    paletteGroups(portal, query).flatMap((group) => group.entries)[0];

  it.each(["nvda", "aapl", "msft", "tsla", "coin", "intc", "spy", "amd"])(
    "Enter on %s opens its stock page, not a loosely matching page",
    (ticker) =>
      expect(first(ticker)).toMatchObject({
        href: `/stock/${ticker.toUpperCase()}`,
      })
  );

  it.each([
    ["audit", "/audit"],
    ["portfolio", "/portfolio"],
    ["backtests", "/backtests"],
  ])("Enter on %s still opens the page %s", (query, href) =>
    expect(first(query)).toMatchObject({ href })
  );
});

describe("paletteGroups pages", () => {
  it("fuzzy-matches label, group or path, best match first", () => {
    expect(hrefs("bkt")).toContain("/backtests");
    expect(hrefs("rec")[0]).toBe("/audit");
    expect(hrefs("dashboard")[0]).toBe("/dashboard");
    return expect(hrefs("zzzzzzz")).toEqual([]);
  });

  it("shows the page group as the detail", () =>
    expect(top("mission control")).toEqual({
      detail: "Workspace",
      href: "/dashboard",
      id: "page:Workspace:/dashboard",
      kind: "go",
      label: "Mission control",
    }));
});
