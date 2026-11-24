// @vitest-environment jsdom
import type {
  FlowOffExchangeBar,
  FlowOffExchangeLevel,
  FlowOffExchangeLevels,
  FlowOffExchangePrint,
} from "@darkfactory/api";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FlowOffExchangeLevelsPanel } from "./flow-off-exchange-levels-panel.tsx";

const testGlobal: typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean } =
  globalThis;
const roots: Root[] = [];
beforeAll(() => {
  testGlobal.IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.replaceChildren();
});

const render = async (element: ReactElement) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(element));
  return { container, root };
};

const makeBar = (
  overrides: Partial<FlowOffExchangeBar> = {}
): FlowOffExchangeBar => ({
  close: 590.5,
  coveredSeconds: 300,
  high: 591,
  low: 590,
  offExchangeShare: 0.42,
  offExchangeVolume: 42_000,
  open: 590.1,
  possibleSeconds: 900,
  session: "2026-11-20",
  start: "2026-11-20T14:30:00.000Z",
  volume: 100_000,
  vwap: 590.4,
  ...overrides,
});

const makePrint = (
  overrides: Partial<FlowOffExchangePrint> = {}
): FlowOffExchangePrint => ({
  at: "2026-11-20T15:00:00.000Z",
  direction: "bullish",
  key: "print:1:590.5:25000:FINRA",
  levelIndex: 0,
  notional: 14_762_500,
  price: 590.5,
  session: "2026-11-20",
  size: 25_000,
  ...overrides,
});

const makeLevel = (
  overrides: Partial<FlowOffExchangeLevel> = {}
): FlowOffExchangeLevel => ({
  bandHigh: 590.75,
  bandLow: 590.25,
  buyShares: 25_000,
  distanceFromSpot: 0.5,
  distancePct: 0.000_847,
  dominantDirection: "bullish",
  firstAt: "2026-11-20T15:00:00.000Z",
  lastAt: "2026-11-20T16:00:00.000Z",
  maxPrice: 590.6,
  minPrice: 590.4,
  neutralShares: 0,
  price: 590.5,
  prints: 2,
  rank: 1,
  sellShares: 5000,
  totalNotional: 17_715_000,
  totalShares: 30_000,
  ...overrides,
});

const makeResponse = (
  overrides: Partial<FlowOffExchangeLevels> = {}
): FlowOffExchangeLevels => ({
  anchorSession: "2026-11-20",
  bars: [
    makeBar({ start: "2026-11-20T14:30:00.000Z" }),
    makeBar({
      close: 591.2,
      high: 591.5,
      low: 590.4,
      offExchangeShare: 0.5,
      start: "2026-11-20T14:45:00.000Z",
      vwap: 590.9,
    }),
  ],
  bucketMinutes: 15,
  finraWeekly: [
    {
      atsShare: 0.38,
      atsShares: 38_000_000,
      atsTrades: 70_000,
      avgAtsTradeSize: 543,
      lastUpdated: "2026-11-23",
      nonAtsShares: 62_000_000,
      nonAtsTrades: 130_000,
      tier: "T1",
      totalShares: 100_000_000,
      weekStart: "2026-11-16",
    },
  ],
  latestPrice: 590,
  latestPriceAt: "2026-11-20T19:00:00.000Z",
  levels: [
    makeLevel({ dominantDirection: "bullish", price: 590.5, rank: 1 }),
    makeLevel({
      bandHigh: 590.6,
      bandLow: 590.45,
      dominantDirection: "bearish",
      price: 590.52,
      rank: 2,
      totalNotional: 10_000_000,
    }),
  ],
  prints: [makePrint({ key: "p1", levelIndex: 0 })],
  range: "5d",
  rules: {
    capture: "sampled",
    clusterStep: 0.25,
    finraMaxWeeks: 8,
    maxLevels: 10,
    maxPrints: 500,
    minPrintShares: 10_000,
    readCap: 2000,
    version: "flow-off-exchange-levels-rules.v1",
  },
  schemaVersion: "flow-off-exchange-levels.v1",
  sessions: ["2026-11-20"],
  symbol: "SPY",
  ticks: {
    ageSeconds: 45,
    lastOkAt: "2026-11-20T18:59:15.000Z",
    lastStatus: "ok",
    message: null,
    sessionOpen: true,
    source: "ticks",
    state: "fresh",
  },
  totals: {
    barsCount: 2,
    buyShares: 25_000,
    coveredSeconds: 600,
    neutralShares: 0,
    omittedLevels: 0,
    omittedPrints: 0,
    prints: 1,
    sampledOffExchangeShare: 0.46,
    sampledOffExchangeVolume: 92_000,
    sampledVolume: 200_000,
    sellShares: 5000,
    totalClusterCount: 2,
    totalNotional: 27_715_000,
    totalShares: 60_000,
    truncated: false,
  },
  windowEnd: "2026-11-20T21:00:00.000Z",
  windowStart: "2026-11-20T14:30:00.000Z",
  ...overrides,
});

describe("FlowOffExchangeLevelsPanel", () => {
  it("renders loading, pending, failure without document, and range/retry callbacks", async () => {
    const onRangeChange = vi.fn();
    const onRetry = vi.fn();

    const { container, root } = await render(
      <FlowOffExchangeLevelsPanel
        document={null}
        failure={null}
        onRangeChange={onRangeChange}
        onRetry={onRetry}
        pending
        range="5d"
        refreshMs={60_000}
        symbol="SPY"
      />
    );

    expect(
      container.querySelector("[data-flow-off-exchange-loading]")?.textContent
    ).toContain("Loading off-exchange print levels");
    expect(
      container.querySelector("[data-flow-off-exchange-pending]")?.textContent
    ).toBe("Updating…");

    // Clicking active range does not trigger callback; clicking 1d triggers callback
    const btn5d = container.querySelector<HTMLButtonElement>(
      '[data-flow-off-exchange-range="5d"]'
    );
    const btn1d = container.querySelector<HTMLButtonElement>(
      '[data-flow-off-exchange-range="1d"]'
    );
    await act(async () => {
      btn5d?.click();
      btn1d?.click();
    });
    expect(onRangeChange).toHaveBeenCalledTimes(1);
    expect(onRangeChange).toHaveBeenCalledWith("1d");

    // Render failure without document
    await act(async () => {
      root.render(
        <FlowOffExchangeLevelsPanel
          document={null}
          failure={{
            code: "UNAVAILABLE",
            failedAt: Date.parse("2026-11-20T19:00:00.000Z"),
            message: "db down",
          }}
          onRangeChange={onRangeChange}
          onRetry={onRetry}
          pending={false}
          range="5d"
          refreshMs={60_000}
          symbol="SPY"
        />
      );
    });
    expect(
      container.querySelector("[data-flow-off-exchange-error]")?.textContent
    ).toContain("Off-exchange levels not loaded");
    expect(
      container.querySelector("[data-flow-off-exchange-loading]")
    ).toBeNull();

    const retryBtn = container.querySelector<HTMLButtonElement>(
      "[data-flow-off-exchange-retry]"
    );
    await act(async () => {
      retryBtn?.click();
    });
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("renders chart, share sub-panel, interactive level table, keyboard nav, inspector, and FINRA strip", async () => {
    const response = makeResponse({
      bars: [
        makeBar({ start: "2026-11-20T14:30:00.000Z" }),
        makeBar({
          close: 591.2,
          high: 591.5,
          low: 590.4,
          offExchangeShare: 0.5,
          start: "2026-11-20T14:45:00.000Z",
          vwap: 590.9,
        }),
        // Isolated bar after > 30m gap exercises isolated price/VWAP markers
        makeBar({
          close: 591.4,
          high: 591.6,
          low: 591.0,
          offExchangeShare: 0.4,
          start: "2026-11-20T16:15:00.000Z",
          vwap: 591.3,
        }),
      ],
      prints: [
        makePrint({ direction: "bullish", key: "p1", levelIndex: 0 }),
        makePrint({
          at: "2026-11-20T15:10:00.000Z",
          direction: "bearish",
          key: "p-bear",
          levelIndex: null,
          price: 590.9,
        }),
        makePrint({
          at: "2026-11-20T15:20:00.000Z",
          direction: "neutral",
          key: "p-neut",
          levelIndex: null,
          price: 591.1,
        }),
      ],
      totals: {
        ...makeResponse().totals,
        omittedLevels: 2,
        totalClusterCount: 4,
      },
    });
    const { container, root } = await render(
      <FlowOffExchangeLevelsPanel
        document={response}
        failure={null}
        onRangeChange={vi.fn()}
        onRetry={vi.fn()}
        pending={false}
        range="5d"
        refreshMs={60_000}
        symbol="SPY"
      />
    );

    expect(
      container.querySelector("[data-flow-off-exchange-chart]")
    ).not.toBeNull();
    expect(
      container.querySelector('[role="region"][tabindex="0"]')
    ).not.toBeNull();
    expect(
      container
        .querySelector('[data-flow-off-exchange-line="1"] rect')
        ?.getAttribute("fill")
    ).toBe("var(--color-success)");
    expect(
      container.querySelector('[data-flow-off-exchange-shape="circle"]')
    ).not.toBeNull();
    expect(
      container.querySelector('[data-flow-off-exchange-shape="diamond"]')
    ).not.toBeNull();
    expect(
      container.querySelector('[data-flow-off-exchange-shape="square"]')
    ).not.toBeNull();
    expect(
      container.querySelector("[data-flow-off-exchange-price-point]")
    ).not.toBeNull();
    expect(
      container.querySelector("[data-flow-off-exchange-vwap-point]")
    ).not.toBeNull();
    expect(
      container.querySelector("[data-flow-off-exchange-share-chart]")
    ).not.toBeNull();
    expect(
      container.querySelector("[data-flow-off-exchange-omitted]")?.textContent
    ).toContain("2 smaller bands omitted");
    expect(
      container.querySelector("[data-flow-off-exchange-spot]")
    ).not.toBeNull();
    expect(
      container.querySelector("[data-flow-off-exchange-finra]")?.textContent
    ).toContain("Updated 2026-11-23");
    expect(
      container.querySelector("[data-flow-off-exchange-inspector]")
    ).toBeNull();

    // Select level #1 via button click
    const level1Btn = container.querySelector<HTMLButtonElement>(
      '[data-flow-off-exchange-level="1"]'
    );
    await act(async () => {
      level1Btn?.click();
    });
    expect(
      container.querySelector("[data-flow-off-exchange-inspector]")?.textContent
    ).toContain("Level #1");
    expect(
      container.querySelector("[data-flow-off-exchange-inspector]")?.textContent
    ).toContain("25K @ $590.50");

    // Keyboard navigation: ArrowDown moves to level #2 (which has no individual prints -> cap note)
    await act(async () => {
      level1Btn?.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, key: "ArrowDown" })
      );
    });
    expect(
      container.querySelector("[data-flow-off-exchange-inspector]")?.textContent
    ).toContain("Level #2");
    expect(
      container.querySelector("[data-flow-off-exchange-inspector]")?.textContent
    ).toContain("outside the newest print cap");

    // Ignored key does not change selection
    const level2Btn = container.querySelector<HTMLButtonElement>(
      '[data-flow-off-exchange-level="2"]'
    );
    await act(async () => {
      level2Btn?.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, key: "Tab" })
      );
    });
    expect(
      container.querySelector("[data-flow-off-exchange-inspector]")?.textContent
    ).toContain("Level #2");

    // Clicking active level #2 toggles selection off
    await act(async () => {
      level2Btn?.click();
    });
    expect(
      container.querySelector("[data-flow-off-exchange-inspector]")
    ).toBeNull();

    // Re-select level #1 then press Escape via keyboard, then re-select and click Clear selection
    await act(async () => {
      level1Btn?.click();
    });
    await act(async () => {
      level1Btn?.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, key: "Escape" })
      );
    });
    expect(
      container.querySelector("[data-flow-off-exchange-inspector]")
    ).toBeNull();

    await act(async () => {
      level1Btn?.click();
    });
    const closeBtn = container.querySelector<HTMLButtonElement>(
      "[data-flow-off-exchange-inspector-close]"
    );
    await act(async () => {
      closeBtn?.click();
    });
    expect(
      container.querySelector("[data-flow-off-exchange-inspector]")
    ).toBeNull();

    // Switching response range clears stale selection automatically
    await act(async () => {
      level1Btn?.click();
    });
    expect(
      container.querySelector("[data-flow-off-exchange-inspector]")
    ).not.toBeNull();
    await act(async () => {
      root.render(
        <FlowOffExchangeLevelsPanel
          document={makeResponse({ range: "1d" })}
          failure={null}
          onRangeChange={vi.fn()}
          onRetry={vi.fn()}
          pending={false}
          range="1d"
          refreshMs={60_000}
          symbol="SPY"
        />
      );
    });
    expect(
      container.querySelector("[data-flow-off-exchange-inspector]")
    ).toBeNull();
  });

  it("renders empty states (no bars+prints, bars without prints, no FINRA, null spot, null lastUpdated)", async () => {
    const empty = makeResponse({
      bars: [],
      finraWeekly: [],
      latestPrice: null,
      levels: [],
      prints: [],
      sessions: [],
    });
    const { container, root } = await render(
      <FlowOffExchangeLevelsPanel
        document={empty}
        failure={null}
        onRangeChange={vi.fn()}
        onRetry={vi.fn()}
        pending={false}
        range="5d"
        refreshMs={60_000}
        symbol="SPY"
      />
    );
    expect(
      container.querySelector("[data-flow-off-exchange-empty]")?.textContent
    ).toContain("No stored SPY tick minutes");
    expect(
      container.querySelector("[data-flow-off-exchange-chart]")
    ).toBeNull();
    expect(
      container.querySelector("[data-flow-off-exchange-finra]")?.textContent
    ).toContain("No FINRA weekly OTC rows");

    // Bars present, but no off-exchange prints, null spot, FINRA with null lastUpdated
    const barsNoPrints = makeResponse({
      finraWeekly: [
        {
          atsShare: 0.38,
          atsShares: 38_000_000,
          atsTrades: 70_000,
          avgAtsTradeSize: 543,
          lastUpdated: null,
          nonAtsShares: 62_000_000,
          nonAtsTrades: 130_000,
          tier: null,
          totalShares: 100_000_000,
          weekStart: "2026-11-16",
        },
      ],
      latestPrice: null,
      levels: [],
      prints: [],
    });
    await act(async () => {
      root.render(
        <FlowOffExchangeLevelsPanel
          document={barsNoPrints}
          failure={null}
          onRangeChange={vi.fn()}
          onRetry={vi.fn()}
          pending={false}
          range="5d"
          refreshMs={60_000}
          symbol="SPY"
        />
      );
    });
    expect(
      container.querySelector("[data-flow-off-exchange-chart]")
    ).not.toBeNull();
    expect(container.querySelector("[data-flow-off-exchange-spot]")).toBeNull();
    expect(
      container.querySelector("[data-flow-off-exchange-no-prints]")?.textContent
    ).toContain("No FINRA TRF prints");
    expect(
      container.querySelector("[data-flow-off-exchange-finra]")?.textContent
    ).not.toContain("Updated ");
  });
});
