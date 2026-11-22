// @vitest-environment jsdom
import type { FlowHedgingPressure } from "@darkfactory/api";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  hedgingAriaLabel,
  hedgingCountsLine,
  hedgingHeaderLine,
  hedgingLargestLine,
  hedgingRuleText,
  hedgingTotalsLine,
} from "../../features/flow/hedging-pressure-view-model.ts";
import { labFlowHedgingPressure } from "../../lab/fixtures/flow.ts";
import { FlowHedgingPressurePanel } from "./flow-hedging-pressure-panel.tsx";

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
  return container;
};

const spy = labFlowHedgingPressure("SPY");
const es = labFlowHedgingPressure("ES");
const empty: FlowHedgingPressure = {
  ...es,
  points: [],
  session: null,
  storedUntil: null,
  unread: null,
};
// 2026-10-30 16:05 New York.
const failure = {
  code: "STORAGE_ERROR",
  failedAt: Date.UTC(2026, 9, 30, 20, 5),
  message: "down",
};
const stateOf = (container: HTMLElement) =>
  container
    .querySelector("[data-flow-hedging]")
    ?.getAttribute("data-flow-hedging-state");
const textOf = (container: HTMLElement, selector: string) =>
  container.querySelector(selector)?.textContent;

describe("FlowHedgingPressurePanel", () => {
  it("shows the loading text and keeps the height of the charts before the first answer", async () => {
    const container = await mount(
      <FlowHedgingPressurePanel
        document={null}
        failure={null}
        refreshMs={60_000}
        symbol="SPY"
      />
    );
    expect(stateOf(container)).toBe("loading");
    expect(textOf(container, '[role="status"]')).toBe(
      "Loading hedging pressure…"
    );
    expect(container.querySelector("h2")?.textContent).toBe(
      "Hedging pressure · SPY options"
    );
    expect(container.querySelector("svg")).toBeNull();
    expect(container.querySelector("[data-flow-hedging]")?.className).toContain(
      "min-h-72"
    );
  });

  it("shows the error line alone when the first call failed", async () => {
    const container = await mount(
      <FlowHedgingPressurePanel
        document={null}
        failure={failure}
        refreshMs={60_000}
        symbol="ES"
      />
    );
    expect(stateOf(container)).toBe("failed");
    expect(textOf(container, '[role="alert"]')).toBe(
      "Hedging pressure not loaded: STORAGE_ERROR: down · retrying with the next refresh at 16:06 ET"
    );
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(container.querySelector("svg")).toBeNull();
  });

  it("keeps the last response below the error line", async () => {
    const container = await mount(
      <FlowHedgingPressurePanel
        document={spy}
        failure={failure}
        refreshMs={60_000}
        symbol="SPY"
      />
    );
    expect(stateOf(container)).toBe("failed");
    expect(container.querySelector("[data-flow-hedging-error]")).not.toBeNull();
    expect(
      container.querySelector('[data-flow-hedging-chart="pressure"]')
    ).not.toBeNull();
  });

  it("shows the empty line for a symbol without a stored print", async () => {
    const container = await mount(
      <FlowHedgingPressurePanel
        document={empty}
        failure={null}
        refreshMs={60_000}
        symbol="ES"
      />
    );
    expect(stateOf(container)).toBe("response");
    expect(container.querySelector("h2")?.textContent).toBe(
      "Hedging pressure · SPX options (ES)"
    );
    expect(textOf(container, "[data-flow-hedging-empty]")).toBe(
      "No option prints stored for ES in the last 14 days."
    );
    expect(container.querySelector("svg")).toBeNull();
    expect(container.querySelector("[data-flow-hedging-rule]")).toBeNull();
  });

  it("shows the no-point line and the counts when no print of the session was counted", async () => {
    const container = await mount(
      <FlowHedgingPressurePanel
        document={{ ...es, points: [], storedUntil: null }}
        failure={null}
        refreshMs={60_000}
        symbol="ES"
      />
    );
    expect(textOf(container, "[data-flow-hedging-no-points]")).toBe(
      "No counted print in this session."
    );
    expect(container.querySelector("svg")).toBeNull();
    expect(textOf(container, "[data-flow-hedging-counts]")).toBe(
      hedgingCountsLine(es)
    );
  });

  it("draws the three lines, the zero line, the ticks, the price and the legend", async () => {
    const container = await mount(
      <FlowHedgingPressurePanel
        document={es}
        failure={null}
        refreshMs={60_000}
        symbol="ES"
      />
    );
    const lines = [
      ...container.querySelectorAll("[data-flow-hedging-line]"),
    ].map((line) => line.getAttribute("data-flow-hedging-line"));
    expect(lines).toEqual(["puts", "calls", "net", "price"]);
    const style = (key: string) => {
      const line = container.querySelector(`[data-flow-hedging-line="${key}"]`);
      return [
        line?.getAttribute("stroke"),
        line?.getAttribute("stroke-dasharray"),
        line?.getAttribute("stroke-width"),
        line?.getAttribute("vector-effect"),
      ];
    };
    expect(style("net")).toEqual([
      "currentColor",
      null,
      "2",
      "non-scaling-stroke",
    ]);
    expect(style("calls")).toEqual([
      "var(--color-info)",
      "6 3",
      "1.5",
      "non-scaling-stroke",
    ]);
    expect(style("puts")).toEqual([
      "var(--color-warning)",
      "1.5 3",
      "1.5",
      "non-scaling-stroke",
    ]);
    expect(container.querySelector("[data-flow-hedging-zero]")).not.toBeNull();
    const ticks = container.querySelectorAll("[data-flow-hedging-tick]");
    expect(ticks.length).toBeGreaterThanOrEqual(3);
    expect(ticks.length).toBeLessThanOrEqual(5);
    expect([...ticks].map((tick) => tick.textContent)).toContain("$0");
    expect(container.querySelector("[data-flow-hedging-unread]")).toBeNull();
    expect(
      [...container.querySelectorAll("[data-flow-hedging-legend]")].map(
        (entry) => entry.getAttribute("data-flow-hedging-legend")
      )
    ).toEqual(["net", "calls", "puts"]);
    expect(container.querySelectorAll("h3")[1]?.textContent).toBe(
      "SPX index price"
    );
    expect(textOf(container, "[data-flow-hedging-price-high]")).not.toBe("");
    expect(textOf(container, "[data-flow-hedging-totals]")).toBe(
      hedgingTotalsLine(es)
    );
    expect(textOf(container, "[data-flow-hedging-largest]")).toBe(
      hedgingLargestLine(es)
    );
    expect(textOf(container, "[data-flow-hedging-counts]")).toContain(
      "312 not signed (mid or unknown) · 14 not priced · 57 IV adjusted"
    );
    expect(textOf(container, "[data-flow-hedging-rule]")).toBe(
      hedgingRuleText(es.rules)
    );
  });

  it("labels each chart as an image with the session, the end values and the largest minutes", async () => {
    const container = await mount(
      <FlowHedgingPressurePanel
        document={spy}
        failure={null}
        refreshMs={60_000}
        symbol="SPY"
      />
    );
    const pressure = container.querySelector(
      '[data-flow-hedging-chart="pressure"]'
    );
    expect(pressure?.getAttribute("role")).toBe("img");
    expect(pressure?.getAttribute("aria-label")).toBe(hedgingAriaLabel(spy));
    expect(pressure?.getAttribute("aria-label")).toContain(
      "session 2026-10-30"
    );
    const price = container.querySelector('[data-flow-hedging-chart="price"]');
    expect(price?.getAttribute("role")).toBe("img");
    expect(price?.getAttribute("aria-label")).toMatch(
      /^SPY price, session 2026-10-30: low [\d.,]+, high [\d.,]+$/u
    );
    expect(container.querySelector("button")).toBeNull();
  });

  it("shades the unread span and names it in the header and the legend", async () => {
    const container = await mount(
      <FlowHedgingPressurePanel
        document={spy}
        failure={null}
        refreshMs={60_000}
        symbol="SPY"
      />
    );
    expect(
      container.querySelector("[data-flow-hedging-unread]")
    ).not.toBeNull();
    expect(textOf(container, "[data-flow-hedging-header]")).toBe(
      "Session 2026-10-30 · as of 15:59 ET · options fresh · Incomplete: prints of 11:10–11:25 ET not read yet; earlier parts of the line can still change."
    );
    expect(
      container.querySelector('[data-flow-hedging-legend="unread"]')
        ?.textContent
    ).toBe("Not read yet (open collector gap)");
  });

  it("names the read cap in the header of a truncated response", async () => {
    const truncated = { ...es, truncated: true };
    const container = await mount(
      <FlowHedgingPressurePanel
        document={truncated}
        failure={null}
        refreshMs={60_000}
        symbol="ES"
      />
    );
    expect(textOf(container, "[data-flow-hedging-header]")).toBe(
      hedgingHeaderLine(truncated)
    );
    expect(textOf(container, "[data-flow-hedging-header]")).toContain(
      "read cap reached, prints after 15:59 ET not counted"
    );
  });

  it("draws no price line when no point has a price", async () => {
    const container = await mount(
      <FlowHedgingPressurePanel
        document={{
          ...es,
          points: es.points.map((point) => ({ ...point, price: null })),
        }}
        failure={null}
        refreshMs={60_000}
        symbol="ES"
      />
    );
    expect(
      container.querySelector('[data-flow-hedging-line="price"]')
    ).toBeNull();
    expect(
      container
        .querySelector('[data-flow-hedging-chart="price"]')
        ?.getAttribute("aria-label")
    ).toBe("SPX index price, session 2026-10-30: no price");
  });
});
