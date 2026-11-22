// @vitest-environment jsdom
import type { FlowSnapshotEvent } from "@darkfactory/api";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { flowEventsToChartMarkers } from "../../features/order-flow/order-flow-markers.ts";
import {
  type FlowEventsLoadState,
  OrderFlowMarksBar,
} from "./order-flow-marks-bar.tsx";

const testGlobal = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
const previousAct = testGlobal.IS_REACT_ACT_ENVIRONMENT;
beforeAll(() => {
  testGlobal.IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  if (previousAct === undefined) delete testGlobal.IS_REACT_ACT_ENVIRONMENT;
  else testGlobal.IS_REACT_ACT_ENVIRONMENT = previousAct;
});
const roots: Root[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.replaceChildren();
});
const renderBar = async (element: ReactElement) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(element);
  });
  return container;
};

const T0 = Date.UTC(2026, 10, 9, 15, 0, 0);
const candles = [
  {
    close: 590.5,
    high: 591,
    id: "1",
    low: 590,
    open: 590.2,
    timestamp: T0,
    volume: 1000,
  },
];

describe("OrderFlowMarksBar", () => {
  it("renders nothing when disabled, idle, or ready without a summary", async () => {
    const off = await renderBar(
      <OrderFlowMarksBar
        enabled={false}
        priceDigits={2}
        state={{ type: "loading" }}
        summary={null}
      />
    );
    expect(off.textContent).toBe("");
    const idle = await renderBar(
      <OrderFlowMarksBar
        enabled={true}
        priceDigits={2}
        state={{ type: "idle" }}
        summary={null}
      />
    );
    expect(idle.textContent).toBe("");
    const noSummary = await renderBar(
      <OrderFlowMarksBar
        enabled={true}
        priceDigits={2}
        state={{ events: [], truncated: false, type: "ready" }}
        summary={null}
      />
    );
    expect(noSummary.textContent).toBe("");
  });

  it("renders unsupported, loading, forbidden and error states honestly", async () => {
    const cases: readonly [FlowEventsLoadState, string, string][] = [
      [
        { secType: "STK", symbol: "NVDA", type: "unsupported" },
        "unsupported",
        "NVDA STK",
      ],
      [{ type: "loading" }, "loading", "Loading stored order-flow marks"],
      [{ type: "forbidden" }, "forbidden", "Operator access required"],
      [
        { message: "storage unavailable", type: "error" },
        "error",
        "storage unavailable",
      ],
    ];
    for (const [state, status, expected] of cases) {
      const host = await renderBar(
        <OrderFlowMarksBar
          enabled={true}
          priceDigits={2}
          state={state}
          summary={null}
        />
      );
      expect(
        host.querySelector(`[data-flow-marks-status="${status}"]`)?.textContent
      ).toContain(expected);
    }
  });

  it("renders empty summary with and without outside events", async () => {
    const empty = flowEventsToChartMarkers([], candles, 60);
    const host1 = await renderBar(
      <OrderFlowMarksBar
        enabled={true}
        priceDigits={2}
        state={{ events: [], truncated: false, type: "ready" }}
        summary={empty}
      />
    );
    expect(host1.textContent).toContain("none in loaded bars");
    expect(host1.querySelector("[data-flow-marks-list]")).toBeNull();

    const outsideOnly: FlowSnapshotEvent[] = [
      {
        at: new Date(T0 - 3_600_000).toISOString(),
        detail: "1 stacked buy imbalance",
        direction: "bullish",
        kind: "stacked_imbalance",
        premium: null,
        price: 589,
        size: null,
      },
    ];
    const host2 = await renderBar(
      <OrderFlowMarksBar
        enabled={true}
        priceDigits={2}
        state={{ events: outsideOnly, truncated: false, type: "ready" }}
        summary={flowEventsToChartMarkers(outsideOnly, candles, 60)}
      />
    );
    expect(host2.textContent).toContain("1 outside loaded bars");
    expect(host2.textContent).toContain("Show 1 mark");
  });

  it("renders counts, truncation note and expandable details for all event directions", async () => {
    const events: FlowSnapshotEvent[] = [
      {
        at: new Date(T0 + 10_000).toISOString(),
        detail: "1 stacked buy imbalance",
        direction: "bullish",
        kind: "stacked_imbalance",
        premium: null,
        price: 590.25,
        size: null,
      },
      {
        at: new Date(T0 + 20_000).toISOString(),
        detail: "1 stacked sell imbalance",
        direction: "bearish",
        kind: "stacked_imbalance",
        premium: null,
        price: null,
        size: null,
      },
      {
        at: new Date(T0 + 30_000).toISOString(),
        detail: "Selling absorbed",
        direction: "bullish",
        kind: "absorption",
        premium: null,
        price: 590.1,
        size: 500,
      },
      {
        at: new Date(T0 + 40_000).toISOString(),
        detail: "Buying absorbed",
        direction: "bearish",
        kind: "absorption",
        premium: null,
        price: 590.9,
        size: 600,
      },
      {
        at: new Date(T0 + 45_000).toISOString(),
        detail: "Neutral stacked imbalance",
        direction: "neutral",
        kind: "stacked_imbalance",
        premium: null,
        price: 590.4,
        size: null,
      },
      {
        at: "unparseable-time",
        detail: "Neutral absorption",
        direction: "neutral",
        kind: "absorption",
        premium: null,
        price: 590.5,
        size: 100,
      },
    ];
    const summary = flowEventsToChartMarkers(events, candles, 60);
    const host = await renderBar(
      <OrderFlowMarksBar
        enabled={true}
        priceDigits={2}
        state={{ events, truncated: true, type: "ready" }}
        summary={summary}
      />
    );
    expect(host.textContent).toContain("▲ SI buy: 1");
    expect(host.textContent).toContain("▼ SI sell: 1");
    expect(host.textContent).toContain("◆ ABS bullish: 1");
    expect(host.textContent).toContain("◆ ABS bearish: 1");
    expect(host.textContent).toContain("1 outside loaded bars");
    expect(host.textContent).toContain("newest 200 shown");
    expect(host.textContent).toContain("Show 6 marks");
    expect(host.querySelector("summary")?.className).toContain("min-h-11");
    const list = host.querySelector("[data-flow-marks-list]");
    expect(list?.textContent).toContain("@ 590.25");
    expect(list?.textContent).toContain("• SI");
    expect(list?.textContent).toContain("◆ ABS");
    expect(list?.textContent).toContain("unparseable-time");
  });
});
