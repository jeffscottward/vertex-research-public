// @vitest-environment jsdom
import type {
  FlowOptionBubbles,
  FlowOptionBubblesItem,
} from "@darkfactory/api";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FlowOptionBubblesPanel } from "./flow-option-bubbles-panel.tsx";

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

const mount = async (element: ReactElement) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(element));
  return {
    container,
    rerender: async (next: ReactElement) => {
      await act(async () => root.render(next));
    },
  };
};

const click = async (element: Element | null) => {
  if (element === null) throw new Error("Expected element to click");
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
};

const keyDown = async (element: Element | null, key: string) => {
  if (element === null) throw new Error("Expected element for keydown");
  await act(async () => {
    element.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key })
    );
  });
};

const makeBubble = (
  id: string,
  overrides: Partial<FlowOptionBubblesItem> = {}
): FlowOptionBubblesItem => ({
  at: "2026-11-20T15:14:22.000Z",
  consolidation: "sweep",
  contract: "SPY 2026-11-27 685C",
  directionalSign: 1,
  dte: 7,
  expiry: "2026-11-27",
  goldenSweep: false,
  id,
  iv: 18.2,
  moneyness: "otm",
  opening: false,
  premium: 400_000,
  price: 3.2,
  right: "call",
  sentiment: "bullish",
  side: "ask",
  size: 1250,
  strike: 685,
  underlyingPrice: 683.4,
  unusual: false,
  volumeOverOi: false,
  ...overrides,
});

const makeDocument = (
  overrides: Partial<FlowOptionBubbles> = {}
): FlowOptionBubbles => ({
  bubbles: [
    makeBubble("b-1", {
      at: "2026-11-20T14:45:00.000Z",
      goldenSweep: true,
      opening: true,
      premium: 1_200_000,
      right: "call",
      side: "above_ask",
      underlyingPrice: 682.8,
      unusual: true,
      volumeOverOi: true,
    }),
    makeBubble("b-2", {
      at: "2026-11-20T15:30:00.000Z",
      consolidation: "block",
      contract: "SPY 2026-11-27 680P",
      directionalSign: -1,
      premium: 500_000,
      right: "put",
      sentiment: "bearish",
      side: "bid",
      strike: 680,
      underlyingPrice: 684.1,
    }),
    makeBubble("b-3", {
      at: "2026-11-20T16:15:00.000Z",
      directionalSign: 0,
      premium: 260_000,
      right: "call",
      sentiment: "neutral",
      side: "mid",
      underlyingPrice: 683.6,
    }),
    makeBubble("b-4", {
      at: "2026-11-20T16:20:00.000Z",
      contract: "SPY 2026-11-27 690C",
      directionalSign: 1,
      premium: 310_000,
      right: "call",
      side: "ask",
      strike: 690,
      underlyingPrice: null,
    }),
  ],
  gaps: [
    {
      end: "2026-11-20T16:00:00.000Z",
      start: "2026-11-20T15:45:00.000Z",
    },
  ],
  minPremiumUsd: 250_000,
  options: {
    ageSeconds: 18,
    lastOkAt: "2026-11-20T16:30:00.000Z",
    lastStatus: "ok",
    message: null,
    sessionOpen: true,
    source: "options",
    state: "fresh",
  },
  pricePoints: [
    { minute: "2026-11-20T14:44:00.000Z", price: 682.6, unread: false },
    { minute: "2026-11-20T14:45:00.000Z", price: 682.8, unread: false },
    { minute: "2026-11-20T15:30:00.000Z", price: 684.1, unread: false },
    { minute: "2026-11-20T16:15:00.000Z", price: 683.6, unread: false },
  ],
  rules: {
    defaultMinPremiumUsd: 250_000,
    maxBubbles: 120,
    retentionDays: 14,
    storedMinPremiumUsd: 10_000,
    version: "option-bubbles.v1",
  },
  schemaVersion: "flow-option-bubbles.v1",
  session: "2026-11-20",
  sessionEnd: "2026-11-20T21:15:00.000Z",
  sessionStart: "2026-11-20T14:30:00.000Z",
  storedUntil: "2026-11-20T16:20:00.000Z",
  symbol: "SPY",
  ticker: "SPY",
  totals: {
    askSidePremium: 1_510_000,
    bearishPremium: 500_000,
    bidSidePremium: 500_000,
    bullishPremium: 1_510_000,
    callBubbles: 3,
    callPremium: 1_770_000,
    latestPrice: 683.6,
    maxBubblePremium: 1_200_000,
    plottedBubbles: 3,
    putBubbles: 1,
    putPremium: 500_000,
    sessionGrossPremium: 9_500_000,
    sessionPrints: 210,
    shownBubbles: 4,
    unplottedBubbles: 1,
    unsignedPremium: 260_000,
  },
  truncated: false,
  unread: {
    from: "2026-11-20T15:45:00.000Z",
    ranges: 1,
    to: "2026-11-20T16:00:00.000Z",
  },
  ...overrides,
});

describe("FlowOptionBubblesPanel", () => {
  it("renders loading, idle-null, error with Retry, and empty-session states", async () => {
    const onRetry = vi.fn();
    const { container, rerender } = await mount(
      <FlowOptionBubblesPanel
        document={null}
        failure={null}
        minPremiumUsd={250_000}
        onMinPremiumChange={vi.fn()}
        onRetry={onRetry}
        pending={true}
        refreshMs={60_000}
        symbol="SPY"
      />
    );
    expect(container.textContent).toContain("Loading option print bubbles…");

    await rerender(
      <FlowOptionBubblesPanel
        document={null}
        failure={{
          code: "STORAGE_ERROR",
          failedAt: Date.parse("2026-11-20T16:00:00.000Z"),
          message: "query failed",
        }}
        minPremiumUsd={250_000}
        onMinPremiumChange={vi.fn()}
        onRetry={onRetry}
        pending={false}
        refreshMs={60_000}
        symbol="ES"
      />
    );
    expect(
      container.querySelector("[data-flow-option-bubbles-error]")?.textContent
    ).toContain("STORAGE_ERROR");
    await click(container.querySelector("[data-flow-option-bubbles-retry]"));
    expect(onRetry).toHaveBeenCalledTimes(1);

    await rerender(
      <FlowOptionBubblesPanel
        document={makeDocument({
          bubbles: [],
          gaps: [],
          pricePoints: [],
          session: null,
          sessionEnd: null,
          sessionStart: null,
          storedUntil: null,
          unread: null,
        })}
        failure={null}
        minPremiumUsd={250_000}
        onMinPremiumChange={vi.fn()}
        onRetry={onRetry}
        pending={false}
        refreshMs={60_000}
        symbol="SPY"
      />
    );
    expect(
      container.querySelector("[data-flow-option-bubbles-empty]")?.textContent
    ).toBe("No option prints stored for SPY in the last 14 days.");
  });

  it("renders chart bubbles, handles threshold/filter switching, keyboard nav, inspector, and table row sync", async () => {
    const onMinPremiumChange = vi.fn();
    const doc = makeDocument();
    const { container } = await mount(
      <FlowOptionBubblesPanel
        document={doc}
        failure={null}
        minPremiumUsd={250_000}
        onMinPremiumChange={onMinPremiumChange}
        onRetry={vi.fn()}
        pending={false}
        refreshMs={60_000}
        symbol="SPY"
      />
    );

    expect(
      container.querySelector("[data-flow-option-bubbles-chart]")
    ).not.toBeNull();
    expect(
      container.querySelectorAll("[data-flow-option-bubble]")
    ).toHaveLength(3);
    expect(
      container.querySelectorAll("[data-flow-option-bubbles-gap]")
    ).toHaveLength(1);
    expect(
      container.querySelector("[data-flow-option-bubbles-spot]")
    ).not.toBeNull();
    expect(
      container.querySelector("[data-flow-option-bubbles-disclosure]")
        ?.textContent
    ).toContain("1 big print reported no underlying price");

    // Threshold selector ignores clicking active option, fires on new option
    await click(
      container.querySelector('[data-flow-option-bubbles-floor="250000"]')
    );
    expect(onMinPremiumChange).not.toHaveBeenCalled();
    await click(
      container.querySelector('[data-flow-option-bubbles-floor="500000"]')
    );
    expect(onMinPremiumChange).toHaveBeenCalledWith(500_000);

    // Click bubble to pin inspector, click again to toggle off
    const b1 = container.querySelector('[data-flow-option-bubble="b-1"]');
    await click(b1);
    expect(
      container.querySelector("[data-flow-option-bubbles-inspector]")
        ?.textContent
    ).toContain("Golden sweep");
    expect(
      container.querySelector("[data-flow-option-bubble-ring]")
    ).not.toBeNull();
    await click(b1);
    expect(
      container.querySelector("[data-flow-option-bubbles-inspector]")
    ).toBeNull();

    // Keyboard navigation across chronological bubbles
    await keyDown(b1, "Enter");
    expect(
      container.querySelector("[data-flow-option-bubbles-inspector]")
        ?.textContent
    ).toContain("SPY 2026-11-27 685C");

    await keyDown(b1, "ArrowRight");
    expect(
      container.querySelector("[data-flow-option-bubbles-inspector]")
        ?.textContent
    ).toContain("SPY 2026-11-27 680P");

    const b2 = container.querySelector('[data-flow-option-bubble="b-2"]');
    await keyDown(b2, "ArrowLeft");
    expect(
      container.querySelector("[data-flow-option-bubbles-inspector]")
        ?.textContent
    ).toContain("SPY 2026-11-27 685C");

    await keyDown(b1, "End");
    expect(
      container.querySelector("[data-flow-option-bubbles-inspector]")
        ?.textContent
    ).toContain("Unsigned flow");

    const b3 = container.querySelector('[data-flow-option-bubble="b-3"]');
    await keyDown(b3, "Home");
    expect(
      container.querySelector("[data-flow-option-bubbles-inspector]")
        ?.textContent
    ).toContain("Above ask");

    // Consecutive ArrowRight on focused element moves DOM focus b1 -> b2 -> b3 without toggling off,
    // and pressing ArrowRight at the end keeps b3 selected
    await keyDown(b1, "ArrowRight");
    expect(document.activeElement).toBe(b2);
    await keyDown(document.activeElement, "ArrowRight");
    expect(document.activeElement).toBe(b3);
    expect(
      container.querySelector("[data-flow-option-bubbles-inspector]")
        ?.textContent
    ).toContain("Unsigned flow");
    await keyDown(document.activeElement, "ArrowRight");
    expect(document.activeElement).toBe(b3);
    expect(
      container.querySelector("[data-flow-option-bubbles-inspector]")
        ?.textContent
    ).toContain("Unsigned flow");
    await keyDown(b1, "Tab");
    await keyDown(b1, "Escape");
    expect(
      container.querySelector("[data-flow-option-bubbles-inspector]")
    ).toBeNull();

    await keyDown(b2, " ");
    expect(
      container.querySelector("[data-flow-option-bubbles-inspector]")
    ).not.toBeNull();
    await click(container.querySelector("[data-flow-option-bubbles-clear]"));
    expect(
      container.querySelector("[data-flow-option-bubbles-inspector]")
    ).toBeNull();

    // Select unplotted print from table row -> opens inspector with "Price not reported"
    await click(
      container.querySelector('[data-flow-option-bubble-row="b-4"] button')
    );
    expect(
      container.querySelector("[data-flow-option-bubbles-inspector]")
        ?.textContent
    ).toContain("SPY price not reported");

    // Client-side right and side filters reset active selection and filter chart bubbles
    await click(
      container.querySelector('[data-flow-option-bubbles-right-filter="put"]')
    );
    expect(
      container.querySelectorAll("[data-flow-option-bubble]")
    ).toHaveLength(1);
    expect(
      container.querySelector("[data-flow-option-bubbles-inspector]")
    ).toBeNull();

    await click(
      container.querySelector('[data-flow-option-bubbles-side-filter="ask"]')
    );
    expect(
      container.querySelector("[data-flow-option-bubbles-no-matches]")
        ?.textContent
    ).toContain("matching put ask-side");
  });

  it("renders no-plot message when session has no price points and no bubbles, and supports Show all / Show top 12 rows", async () => {
    const { container, rerender } = await mount(
      <FlowOptionBubblesPanel
        document={makeDocument({
          bubbles: [],
          gaps: [],
          pricePoints: [],
          totals: {
            ...makeDocument().totals,
            latestPrice: null,
            shownBubbles: 0,
            unplottedBubbles: 0,
          },
          unread: null,
        })}
        failure={null}
        minPremiumUsd={250_000}
        onMinPremiumChange={vi.fn()}
        onRetry={vi.fn()}
        pending={false}
        refreshMs={60_000}
        symbol="SPY"
      />
    );

    expect(
      container.querySelector("[data-flow-option-bubbles-chart]")
    ).toBeNull();
    expect(
      container.querySelector("[data-flow-option-bubbles-no-matches]")
    ).not.toBeNull();
    // Unplotted-only session (no price points, matching prints lack underlyingPrice):
    // hides chart with explicit message while keeping TopPrintsTable and BubbleInspector working
    await rerender(
      <FlowOptionBubblesPanel
        document={makeDocument({
          bubbles: [
            makeBubble("only-unplotted", {
              contract: "SPY 2026-11-27 695C",
              premium: 420_000,
              underlyingPrice: null,
            }),
          ],
          gaps: [],
          pricePoints: [],
          totals: {
            ...makeDocument().totals,
            latestPrice: null,
            plottedBubbles: 0,
            shownBubbles: 1,
            unplottedBubbles: 1,
          },
          unread: null,
        })}
        failure={null}
        minPremiumUsd={250_000}
        onMinPremiumChange={vi.fn()}
        onRetry={vi.fn()}
        pending={false}
        refreshMs={60_000}
        symbol="SPY"
      />
    );
    expect(
      container.querySelector("[data-flow-option-bubbles-chart]")
    ).toBeNull();
    expect(
      container.querySelector("[data-flow-option-bubbles-unplotted-only]")
        ?.textContent
    ).toContain("Inspect matching prints in the table below");
    expect(
      container.querySelector('[data-flow-option-bubble-row="only-unplotted"]')
    ).not.toBeNull();
    await click(
      container.querySelector(
        '[data-flow-option-bubble-row="only-unplotted"] button'
      )
    );
    expect(
      container.querySelector("[data-flow-option-bubbles-inspector]")
        ?.textContent
    ).toContain("SPY 2026-11-27 695C");

    const manyBubbles = Array.from({ length: 14 }, (_, i) =>
      makeBubble(`many-${i}`, {
        at: new Date(
          Date.parse("2026-11-20T14:40:00.000Z") + i * 60_000
        ).toISOString(),
        premium: i === 0 ? 15_000_000 : 250_000 + i * 10_000,
        underlyingPrice: 683 + i * 0.05,
      })
    );
    await rerender(
      <FlowOptionBubblesPanel
        document={makeDocument({
          bubbles: manyBubbles,
          gaps: [],
          totals: {
            ...makeDocument().totals,
            latestPrice: null,
            shownBubbles: 14,
            unplottedBubbles: 0,
          },
          unread: null,
        })}
        failure={null}
        minPremiumUsd={250_000}
        onMinPremiumChange={vi.fn()}
        onRetry={vi.fn()}
        pending={false}
        refreshMs={60_000}
        symbol="SPY"
      />
    );

    expect(
      container.querySelectorAll("[data-flow-option-bubble-row]")
    ).toHaveLength(12);
    const toggle = container.querySelector(
      "[data-flow-option-bubbles-toggle-rows]"
    );
    expect(toggle?.textContent).toBe("Show all 14 prints");
    await click(toggle);
    expect(
      container.querySelectorAll("[data-flow-option-bubble-row]")
    ).toHaveLength(14);
    expect(toggle?.textContent).toBe("Show top 12");
    // Refreshing within the same scope drops inspector if the selected bubble is gone
    await click(container.querySelector('[data-flow-option-bubble="many-0"]'));
    expect(
      container.querySelector("[data-flow-option-bubbles-inspector]")
    ).not.toBeNull();
    await rerender(
      <FlowOptionBubblesPanel
        document={makeDocument({
          bubbles: manyBubbles.slice(1),
          gaps: [],
          totals: {
            ...makeDocument().totals,
            latestPrice: null,
            shownBubbles: 13,
            unplottedBubbles: 0,
          },
          unread: null,
        })}
        failure={null}
        minPremiumUsd={250_000}
        onMinPremiumChange={vi.fn()}
        onRetry={vi.fn()}
        pending={false}
        refreshMs={60_000}
        symbol="SPY"
      />
    );
    expect(
      container.querySelector("[data-flow-option-bubbles-inspector]")
    ).toBeNull();
  });
});
