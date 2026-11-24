// @vitest-environment jsdom
import type {
  OptionsAnalyticsInput,
  OptionsAnalyticsOutput,
} from "@darkfactory/api";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  createBrowserOptionsAnalyticsGateway,
  type OptionsAnalyticsGateway,
} from "./options-analytics-client.ts";
import { OptionsAnalyticsPanel } from "./options-analytics-panel.tsx";

const testGlobal = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
const previousAct = testGlobal.IS_REACT_ACT_ENVIRONMENT;
beforeAll(() => {
  testGlobal.IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  if (previousAct === undefined) {
    delete testGlobal.IS_REACT_ACT_ENVIRONMENT;
    return;
  }
  testGlobal.IS_REACT_ACT_ENVIRONMENT = previousAct;
});

let root: Root | null = null;
let host: HTMLDivElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.restoreAllMocks();
});

const render = async (
  gateway: OptionsAnalyticsGateway | undefined,
  symbol = "NVDA"
): Promise<HTMLElement> => {
  host = document.createElement("div");
  document.body.append(host);
  const mounted = createRoot(host);
  root = mounted;
  await act(async () => {
    mounted.render(<OptionsAnalyticsPanel gateway={gateway} symbol={symbol} />);
  });
  return host;
};

const FACTOR_KEYS = [
  "dealerSign",
  "regime",
  "freshness",
  "expiryMix",
  "levels",
  "flow",
  "dex",
  "charm",
  "vanna",
  "ivRegime",
  "events",
] as const;

// Dummy GEX context: one chip per factor, tones cycle through neutral, caution and alert.
const context: OptionsAnalyticsOutput["context"] = {
  dealerSignAssumption: "dealers long calls, short puts",
  expiry: {
    monthlyOpexDays: 1,
    nextExpiry: "2026-10-23",
    nextExpiryDte: 1,
    nextMonthlyOpex: "2026-10-23",
  },
  factors: FACTOR_KEYS.map((key, index) => ({
    detail: `Why ${key} matters.`,
    key,
    label: `Label ${key}`,
    tone: (["neutral", "caution", "alert"] as const)[index % 3] ?? "neutral",
    value: `Value ${key}`,
  })),
  flow: {
    bearishPremium: 250_000,
    bias: "bullish",
    bullishPremium: 1_000_000,
    newestTradeAt: "2026-10-22T14:10:00.000Z",
    weekShare: 0.2,
    zeroDteShare: 0,
  },
  greeks: { netCharm: -1000, netDex: 5_000_000, netVanna: 2000 },
  iv: { backIv: 0.4, frontIv: 0.5, regime: "inverted" },
  levels: {
    callWall: null,
    callWallMoves: null,
    dailyMove: 3,
    flip: 98.684,
    flipMoves: -0.4,
    putWall: 90,
    putWallMoves: -3.3,
  },
  regime: "positive",
  session: "morning",
};

const fixture = (
  overrides: Partial<OptionsAnalyticsOutput> = {}
): OptionsAnalyticsOutput => ({
  context,
  exposure: {
    gexExpiry: "2026-10-23",
    maxPain: 100,
    message: null,
    status: "ok",
    strikes: [
      {
        callOpenInterest: 10,
        gex: -2_500_000,
        putOpenInterest: 500,
        strike: 90,
      },
      { callOpenInterest: 300, gex: 1200, putOpenInterest: 300, strike: 100 },
      { callOpenInterest: 800, gex: null, putOpenInterest: 0, strike: 120 },
      { callOpenInterest: 5, gex: 50, putOpenInterest: 5, strike: 130 },
    ],
    totalGex: 3_400_000_000,
  },
  flow: {
    buckets: [],
    callPremium: 1_000_000,
    events: [
      {
        contract: "NVDA 2026-11-20 110C",
        expiry: "2026-11-20",
        flowType: "sweep",
        premium: 1_000_000,
        right: "call",
        sentiment: "bullish",
        size: 200,
        strike: 110,
        time: "2026-10-22T14:10:00.000Z",
        unusual: true,
      },
      {
        contract: "NVDA 2026-10-23 95P",
        expiry: "2026-10-23",
        flowType: null,
        premium: 250_000,
        right: "put",
        sentiment: "neutral",
        size: 50,
        strike: 95,
        time: "2026-10-22T13:05:00.000Z",
        unusual: false,
      },
    ],
    hours: 24,
    message: null,
    putPremium: 250_000,
    status: "ok",
  },
  notes: ["Research only."],
  rateLimited: false,
  receivedAt: "2026-10-22T15:00:00.000Z",
  retryAfterSeconds: null,
  source: "quantdata",
  spot: 101,
  strikeProfiles: {
    flow: {
      complete: true,
      newestTradeAt: "2026-10-22T14:10:00.000Z",
      offLadderTrades: 0,
      oldestTradeAt: "2026-10-22T13:05:00.000Z",
      source: "quantdata_page",
      trades: 2,
    },
    strikes: [
      {
        bearishPremium: 0,
        bullishPremium: 0,
        callOpenInterest: 10,
        callVolume: 0,
        holderPayout: 320_000,
        putOpenInterest: 500,
        putVolume: 0,
        strike: 90,
        trades: 0,
      },
      {
        bearishPremium: 250_000,
        bullishPremium: 1_000_000,
        callOpenInterest: 300,
        callVolume: 200,
        holderPayout: 25_000,
        putOpenInterest: 300,
        putVolume: 50,
        strike: 100,
        trades: 2,
      },
      {
        bearishPremium: 0,
        bullishPremium: 0,
        callOpenInterest: 800,
        callVolume: 0,
        holderPayout: 635_000,
        putOpenInterest: 0,
        putVolume: 0,
        strike: 120,
        trades: 0,
      },
      {
        bearishPremium: 0,
        bullishPremium: 0,
        callOpenInterest: 5,
        callVolume: 0,
        holderPayout: 1_740_000,
        putOpenInterest: 5,
        putVolume: 0,
        strike: 130,
        trades: 0,
      },
    ],
  },
  symbol: "NVDA",
  volatility: {
    message: null,
    skew: [
      { delta: -40, expiry: "2026-10-23", iv: 0.33, target: -40 },
      { delta: 25, expiry: "2026-10-23", iv: 0.25, target: 25 },
    ],
    status: "ok",
    surface: {
      moneyness: [0.9, 1, 1.1],
      rows: [{ dte: 1, expiry: "2026-10-23", ivs: [0.38, null, 0.25] }],
    },
    termStructure: [
      { atmIv: 0.28, dte: 1, expiry: "2026-10-23" },
      { atmIv: 0.29, dte: 29, expiry: "2026-11-20" },
    ],
  },
  ...overrides,
});

describe("OptionsAnalyticsPanel", () => {
  it("renders IV, GEX and flow sections for the symbol", async () => {
    const snapshot = vi.fn(async (_input: OptionsAnalyticsInput) => fixture());
    const view = await render({ snapshot });
    expect(snapshot).toHaveBeenCalledWith({ flowHours: 24, symbol: "NVDA" });
    expect(view.textContent).toContain("Options analytics · NVDA");
    expect(view.textContent).toContain("spot 101");
    expect(
      view.querySelectorAll("[data-term-structure] tbody tr")
    ).toHaveLength(2);
    expect(view.querySelector("[data-skew] tbody")?.textContent).toContain(
      "33.0%"
    );
    // Grid items shrink below their nowrap tables so the tables scroll inside
    // their own box at 375 px instead of widening the page.
    for (const table of ["[data-term-structure]", "[data-skew]"]) {
      const item = view.querySelector(table)?.closest(".space-y-1");
      expect(item?.classList.contains("min-w-0")).toBe(true);
    }
    const surface = [
      ...view.querySelectorAll("[data-iv-surface] tbody td"),
    ].slice(1);
    expect(surface.map((cell) => cell.textContent)).toEqual([
      "38.0%",
      "no IV",
      "25.0%",
    ]);
    expect(surface.map((cell) => cell.getAttribute("title"))).toEqual([
      null,
      "QuantData sent no IV for this point",
      null,
    ]);
    const gexCells = [
      ...view.querySelectorAll("[data-gex-table] tbody tr td:nth-child(4)"),
    ];
    expect(gexCells.map((cell) => cell.textContent)).toContain("not computed");
    expect(
      gexCells
        .filter((cell) => cell.textContent === "not computed")
        .map((cell) => cell.getAttribute("title"))
    ).toEqual(["GEX needs option-chain IV and a spot price"]);
    expect(gexCells.filter((cell) => cell.hasAttribute("title"))).toHaveLength(
      1
    );
    expect(view.querySelector("[data-total-gex]")?.hasAttribute("title")).toBe(
      false
    );
    expect(view.textContent).toContain("type not sent");
    expect(view.querySelector("[data-total-gex]")?.textContent).toBe("$3.40B");
    expect(view.querySelector("[data-spot-row]")?.textContent).toContain("100");
    // The GEX table lists the highest strike first, like the strike profiles.
    expect(
      [
        ...view.querySelectorAll("[data-gex-table] tbody tr td:first-child"),
      ].map((cell) => cell.textContent)
    ).toEqual(["130", "120", "100", "90"]);
    expect(view.querySelector("[data-strike-profiles]")?.textContent).toContain(
      "Strike profiles"
    );
    expect(view.querySelector("[data-gex-table]")?.textContent).toContain(
      "-$2.50M"
    );
    expect(view.querySelector("[data-gex-table]")?.textContent).toContain(
      "$1.2K"
    );
    expect(view.querySelector("[data-gex-table]")?.textContent).toContain(
      "$50"
    );
    expect(view.querySelector("[data-net-premium]")?.textContent).toBe(
      "$750.0K"
    );
    expect(view.querySelector("[data-flow-table]")?.textContent).toContain(
      "unusual"
    );
    return expect(view.textContent).toContain("Research only.");
  });

  it("shows the GEX context strip and the estimated levels next to GEX", async () => {
    const view = await render({ snapshot: async () => fixture() });
    const strip = view.querySelector("[data-gex-context]");
    expect(strip?.getAttribute("data-gex-regime")).toBe("positive");
    expect(strip?.textContent).toContain(
      "Read this before trusting the number"
    );
    // The strip sits inside the GEX section, before the GEX numbers.
    expect(
      strip?.closest("section[data-section-status]")?.textContent
    ).toContain("Gamma exposure and open interest");
    const chips = [...(strip?.querySelectorAll("li[data-factor]") ?? [])];
    expect(chips.map((chip) => chip.getAttribute("data-factor"))).toEqual([
      ...FACTOR_KEYS,
    ]);
    expect(
      chips.map((chip) => chip.getAttribute("data-tone")).slice(0, 3)
    ).toEqual(["neutral", "caution", "alert"]);
    // Tone is a visible word as well as a colour (WCAG 1.4.1); neutral chips have no badge.
    const badge = (index: number) =>
      chips[index]?.querySelector("[data-tone-badge]") ?? null;
    const visibleText = (element: Element | null) =>
      [...(element?.querySelectorAll("span:not(.sr-only)") ?? [])]
        .map((span) => span.textContent)
        .join("");
    expect(badge(0)).toBeNull();
    expect(visibleText(badge(1))).toBe("Caution");
    expect(badge(1)?.getAttribute("data-status")).toBe("warning");
    expect(visibleText(badge(2))).toBe("Check");
    expect(badge(2)?.getAttribute("data-status")).toBe("destructive");
    expect(chips[1]?.textContent).toBe(
      "Status:CautionLabel regimeValue regime"
    );
    expect(chips[1]?.className).toContain("border-warning-border");
    expect(chips[2]?.className).toContain("border-destructive-border");
    expect(
      view.querySelector("[data-gex-context-details]")?.textContent
    ).toContain("Why dex matters.");
    // Each chip is described by its entry in "What each badge means".
    const described = chips[6]?.getAttribute("aria-describedby") ?? "";
    expect(document.getElementById(described)?.textContent).toBe(
      "Why dex matters."
    );
    const level = (label: string) =>
      view.querySelector(`[data-gex-level="${label}"]`)?.textContent;
    expect(level("Gamma flip (est.)")).toBe("98.68");
    expect(level("Call wall (largest +GEX)")).toBe("no positive GEX");
    return expect(level("Put wall (largest -GEX)")).toBe("90.00");
  });

  it("puts each skew point under the target column it was chosen for", async () => {
    const base = fixture();
    const snapshot = vi.fn(async () =>
      fixture({
        volatility: {
          ...base.volatility,
          skew: [
            { delta: -17, expiry: "2026-10-23", iv: 0.31, target: -25 },
            { delta: -10, expiry: "2026-10-23", iv: 0.36, target: -10 },
          ],
        },
      })
    );
    const view = await render({ snapshot });
    const cells = [
      ...(view.querySelector("[data-skew] tbody tr")?.querySelectorAll("td") ??
        []),
    ].map((cell) => cell.textContent);
    // Columns: expiry, -40, -25, -10, +10, +25, +40.
    expect(cells.slice(1, 4)).toEqual(["no contract", "31.0%", "36.0%"]);
    const titles = [
      ...(view.querySelector("[data-skew] tbody tr")?.querySelectorAll("td") ??
        []),
    ].map((cell) => cell.getAttribute("title"));
    expect(titles.slice(1, 4)).toEqual([
      "No contract at this delta for this expiry",
      "Contract delta -17",
      "Contract delta -10",
    ]);
  });

  it("names each GEX level that has no value, by its cause", async () => {
    const base = fixture();
    const noLevels = {
      ...base.context,
      levels: {
        ...base.context.levels,
        callWall: null,
        flip: null,
        putWall: null,
      },
    };
    const level = (view: HTMLElement, label: string) =>
      view.querySelector(`[data-gex-level="${label}"]`)?.textContent;
    let view = await render({
      snapshot: async () => fixture({ context: noLevels }),
    });
    expect(level(view, "Gamma flip (est.)")).toBe("no zero crossing");
    expect(level(view, "Call wall (largest +GEX)")).toBe("no positive GEX");
    expect(level(view, "Put wall (largest -GEX)")).toBe("no negative GEX");
    act(() => root?.unmount());
    view = await render({
      snapshot: async () =>
        fixture({
          context: noLevels,
          exposure: { ...base.exposure, totalGex: null },
        }),
    });
    expect(level(view, "Gamma flip (est.)")).toBe("not computed");
    expect(level(view, "Call wall (largest +GEX)")).toBe("not computed");
    expect(level(view, "Put wall (largest -GEX)")).toBe("not computed");
    act(() => root?.unmount());
    // Total GEX computed, but no front ATM IV: the server computes no level at all.
    view = await render({
      snapshot: async () =>
        fixture({
          context: {
            ...noLevels,
            levels: { ...noLevels.levels, dailyMove: null },
          },
        }),
    });
    expect(level(view, "Gamma flip (est.)")).toBe("not computed");
    expect(level(view, "Call wall (largest +GEX)")).toBe("not computed");
    expect(level(view, "Put wall (largest -GEX)")).toBe("not computed");
  });

  it("changes the flow window, refreshes and drops stale responses", async () => {
    let release: (value: OptionsAnalyticsOutput) => void = () => undefined;
    const snapshot = vi
      .fn<(input: OptionsAnalyticsInput) => Promise<OptionsAnalyticsOutput>>()
      .mockResolvedValueOnce(fixture())
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve;
          })
      )
      .mockResolvedValue(fixture({ spot: null }));
    const view = await render({ snapshot });
    const select = view.querySelector("select");
    await act(async () => {
      if (select === null) throw new Error("no select");
      select.value = "6";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(snapshot).toHaveBeenLastCalledWith({ flowHours: 6, symbol: "NVDA" });
    expect(view.textContent).toContain("Loading options analytics");
    await act(async () => {
      if (select === null) throw new Error("no select");
      select.value = "72";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => {
      release(fixture({ symbol: "STALE" }));
    });
    expect(view.textContent).toContain(
      "· spot not received from QuantData · received 15:00:00 UTC"
    );
    await act(async () => {
      view.querySelector("button")?.click();
    });
    expect(snapshot).toHaveBeenCalledTimes(4);
    return expect(view.querySelector("[data-spot-row]")).toBeNull();
  });

  it("shows section messages, rate limits and errors", async () => {
    const empty = fixture({
      exposure: {
        ...fixture().exposure,
        gexExpiry: null,
        maxPain: null,
        totalGex: null,
      },
      rateLimited: true,
      retryAfterSeconds: null,
      volatility: {
        ...fixture().volatility,
        message: "No IV.",
        status: "empty",
      },
    });
    let view = await render({ snapshot: async () => empty });
    expect(view.textContent).toContain("retry in about 60 s");
    expect(view.textContent).toContain("No IV.");
    expect(view.querySelector("[data-term-structure]")).toBeNull();
    expect(view.querySelector("[data-total-gex]")?.textContent).toBe(
      "not computed"
    );
    expect(view.querySelector("[data-total-gex]")?.getAttribute("title")).toBe(
      "GEX needs option-chain IV and a spot price"
    );
    expect(view.textContent).toContain("no open interest");
    expect(view.textContent).toContain("no IV expiry");
    act(() => root?.unmount());
    view = await render({
      snapshot: async () => {
        throw Object.assign(new Error("QuantData is not configured"), {
          code: "NOT_CONFIGURED",
        });
      },
    });
    expect(
      view.querySelector("[data-error-code]")?.getAttribute("data-error-code")
    ).toBe("NOT_CONFIGURED");
    act(() => root?.unmount());
    view = await render({
      snapshot: async () =>
        fixture({
          exposure: {
            ...fixture().exposure,
            message: "QuantData openInterest: HTTP 500.",
            status: "unavailable",
          },
        }),
    });
    expect(view.querySelector("[data-gex-table]")).toBeNull();
    act(() => root?.unmount());
    let fail: (error: unknown) => void = () => undefined;
    let calls = 0;
    view = await render({
      snapshot: () => {
        calls += 1;
        return calls === 1
          ? new Promise((_resolve, reject) => {
              fail = reject;
            })
          : Promise.resolve(
              fixture({ rateLimited: true, retryAfterSeconds: 9 })
            );
      },
    });
    const select = view.querySelector("select");
    await act(async () => {
      if (select === null) throw new Error("no select");
      select.value = "1";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => {
      fail(new Error("late"));
    });
    return expect(view.textContent).toContain("retry in about 9 s");
  });

  it("renders unavailable QuantData HTTP 401/403 sections as role=alert with owner credential rotation notice", async () => {
    const view = await render({
      snapshot: async () =>
        fixture({
          flow: {
            ...fixture().flow,
            message:
              "QuantData orderFlow: HTTP 401 (authentication failed — check QUANTDATA_API_KEY).",
            status: "unavailable",
          },
          volatility: {
            ...fixture().volatility,
            message: "QuantData termStructure: HTTP 503.",
            status: "unavailable",
          },
        }),
    });
    const authAlert = view.querySelector("[data-auth-error]");
    expect(authAlert?.getAttribute("role")).toBe("alert");
    expect(authAlert?.textContent).toContain("HTTP 401");
    expect(authAlert?.textContent).toContain(
      "Owner action required: rotate the upstream provider credential"
    );
    const alerts = [...view.querySelectorAll('[role="alert"]')];
    expect(alerts.some((el) => el.textContent?.includes("HTTP 503"))).toBe(
      true
    );
  });

  it("uses the browser gateway by default", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json({ json: fixture() }));
    const view = await render(undefined);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(fetchSpy).toHaveBeenCalled();
    const gateway = createBrowserOptionsAnalyticsGateway();
    await gateway.snapshot({ symbol: "SPY" }).catch(() => undefined);
    await gateway.snapshot({ symbol: "SPY" }).catch(() => undefined);
    expect(fetchSpy.mock.calls.length).toBeGreaterThanOrEqual(3);
    return expect(view.textContent).toContain("Options analytics");
  });
});
