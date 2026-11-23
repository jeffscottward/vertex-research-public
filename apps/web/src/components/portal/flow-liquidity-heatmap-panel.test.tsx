// @vitest-environment jsdom
import type { FlowLiquidityHeatmap } from "@darkfactory/api";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  depthStatusLine,
  heatmapRuleLine,
  LIQUIDITY_HEATMAP_EMPTY,
  LIQUIDITY_HEATMAP_LOADING,
} from "../../features/flow/liquidity-heatmap-view-model.ts";
import { labFlowLiquidityHeatmap } from "../../lab/fixtures/flow.ts";
import { FlowLiquidityHeatmapPanel } from "./flow-liquidity-heatmap-panel.tsx";

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

const es = labFlowLiquidityHeatmap("ES", 120);
const nq = labFlowLiquidityHeatmap("NQ", 120);
const emptyDoc = labFlowLiquidityHeatmap("NQ", 390);
const failure = {
  code: "SERVICE_UNAVAILABLE",
  failedAt: Date.parse("2026-11-23T15:00:00.000Z"),
  kind: "error" as const,
  message: "history timeout",
};

const stateOf = (container: HTMLElement) =>
  container
    .querySelector("[data-flow-heatmap]")
    ?.getAttribute("data-flow-heatmap-state");

describe("FlowLiquidityHeatmapPanel", () => {
  it("renders loading state with reserved height and group title for SPY/ES", async () => {
    const container = await mount(
      <FlowLiquidityHeatmapPanel
        document={null}
        failure={null}
        refreshMs={60_000}
        symbol="SPY"
      />
    );
    expect(stateOf(container)).toBe("loading");
    expect(container.textContent).toContain(
      "Liquidity heatmap (ES, the future of the S&P 500 group)"
    );
    expect(container.textContent).toContain(LIQUIDITY_HEATMAP_LOADING);
    expect(container.querySelector("[data-flow-heatmap]")?.className).toContain(
      "min-h-96"
    );
  });

  it("renders failed state alone and keeps the last document below when present", async () => {
    const failedOnly = await mount(
      <FlowLiquidityHeatmapPanel
        document={null}
        failure={failure}
        refreshMs={60_000}
        symbol="ES"
      />
    );
    expect(stateOf(failedOnly)).toBe("failed");
    expect(
      failedOnly.querySelector("[data-flow-heatmap-error]")?.textContent
    ).toContain("SERVICE_UNAVAILABLE: history timeout");
    expect(failedOnly.querySelector("[data-flow-heatmap-svg]")).toBeNull();

    const failedWithDoc = await mount(
      <FlowLiquidityHeatmapPanel
        document={es}
        failure={failure}
        refreshMs={60_000}
        symbol="ES"
      />
    );
    expect(stateOf(failedWithDoc)).toBe("failed");
    expect(
      failedWithDoc.querySelector("[data-flow-heatmap-error]")?.textContent
    ).toContain("retrying every 60 s");
    expect(
      failedWithDoc.querySelector("[data-flow-heatmap-svg]")
    ).not.toBeNull();
  });

  it("renders empty recorded-depth state honestly without SVG chart or tables", async () => {
    const container = await mount(
      <FlowLiquidityHeatmapPanel
        document={emptyDoc}
        failure={null}
        refreshMs={60_000}
        symbol="QQQ"
      />
    );
    expect(stateOf(container)).toBe("document");
    expect(
      container.querySelector("[data-flow-heatmap-empty]")?.textContent
    ).toBe(LIQUIDITY_HEATMAP_EMPTY);
    expect(container.querySelector("[data-flow-heatmap-svg]")).toBeNull();
    expect(
      container.querySelectorAll("[data-flow-heatmap-wall-row]")
    ).toHaveLength(0);
    expect(
      container.querySelectorAll("[data-flow-heatmap-trade-row]")
    ).toHaveLength(0);
  });

  it("renders full ES streamed heatmap with cells, gaps, mid/BBO lines, trade dots, DOM bars, walls, trades, and interactive keyboard/pointer inspection", async () => {
    const container = await mount(
      <FlowLiquidityHeatmapPanel
        document={es}
        failure={null}
        refreshMs={60_000}
        symbol="ES"
      />
    );
    expect(stateOf(container)).toBe("document");
    expect(
      container.querySelector("[data-flow-heatmap-status]")?.textContent
    ).toBe(depthStatusLine(es));
    expect(
      container.querySelector("[data-flow-heatmap-rule]")?.textContent
    ).toBe(heatmapRuleLine(es));
    expect(
      container.querySelectorAll("[data-flow-heatmap-cell]").length
    ).toBeGreaterThan(0);
    expect(
      container.querySelectorAll("[data-flow-heatmap-gap]").length
    ).toBeGreaterThan(0);
    expect(
      container.querySelectorAll("[data-flow-heatmap-mid]").length
    ).toBeGreaterThan(0);
    expect(
      container.querySelectorAll("[data-flow-heatmap-bbo='bid']").length
    ).toBeGreaterThan(0);
    expect(
      container.querySelectorAll("[data-flow-heatmap-bbo='ask']").length
    ).toBeGreaterThan(0);
    expect(
      container.querySelectorAll("[data-flow-heatmap-trade]").length
    ).toBeGreaterThan(0);
    expect(
      container.querySelectorAll("[data-flow-heatmap-dom]").length
    ).toBeGreaterThan(0);
    expect(
      container.querySelectorAll("[data-flow-heatmap-wall-row]").length
    ).toBeGreaterThan(0);
    expect(
      container.querySelectorAll("[data-flow-heatmap-trade-row]").length
    ).toBeGreaterThan(0);

    const slider = container.querySelector<HTMLDivElement>(
      "[data-flow-heatmap-interactive]"
    );
    expect(slider).not.toBeNull();
    expect(slider?.getAttribute("role")).toBe("slider");

    const inspectText = () =>
      container.querySelector("[data-flow-heatmap-inspect]")?.textContent ?? "";
    const initialInspect = inspectText();
    expect(initialInspect.length).toBeGreaterThan(0);

    // Keyboard scrubbing: Home -> ArrowRight -> End -> ArrowLeft -> ignored key -> Escape
    await act(async () => {
      slider?.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, key: "Home" })
      );
    });
    expect(slider?.getAttribute("aria-valuenow")).toBe("1");

    await act(async () => {
      slider?.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, key: "ArrowRight" })
      );
    });
    expect(slider?.getAttribute("aria-valuenow")).toBe("2");

    await act(async () => {
      slider?.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, key: "End" })
      );
    });
    expect(slider?.getAttribute("aria-valuenow")).toBe(
      String(es.columns.length)
    );

    await act(async () => {
      slider?.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, key: "ArrowLeft" })
      );
    });
    expect(slider?.getAttribute("aria-valuenow")).toBe(
      String(es.columns.length - 1)
    );

    await act(async () => {
      slider?.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, key: "Tab" })
      );
    });
    expect(slider?.getAttribute("aria-valuenow")).toBe(
      String(es.columns.length - 1)
    );

    await act(async () => {
      slider?.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, key: "Escape" })
      );
    });
    expect(inspectText()).toBe(initialInspect);

    // Pointer hover measures the SVG rect (honoring scroll offset and min-width on narrow viewports)
    const svg = container.querySelector<SVGSVGElement>(
      "[data-flow-heatmap-svg]"
    );
    expect(svg).not.toBeNull();
    const zeroRectSpy = vi
      .spyOn(svg as SVGSVGElement, "getBoundingClientRect")
      .mockReturnValue({
        bottom: 0,
        height: 0,
        left: 0,
        right: 0,
        toJSON: () => ({}),
        top: 0,
        width: 0,
        x: 0,
        y: 0,
      });
    await act(async () => {
      svg?.dispatchEvent(
        new MouseEvent("pointermove", { bubbles: true, clientX: 200 })
      );
    });
    zeroRectSpy.mockReturnValue({
      bottom: 340,
      height: 340,
      left: -80,
      right: 840,
      toJSON: () => ({}),
      top: 0,
      width: 920,
      x: -80,
      y: 0,
    });
    await act(async () => {
      svg?.dispatchEvent(
        new MouseEvent("pointermove", { bubbles: true, clientX: 40 })
      );
    });
    expect(Number(slider?.getAttribute("aria-valuenow"))).toBeLessThan(30);

    await act(async () => {
      slider?.dispatchEvent(
        new MouseEvent("pointerout", { bubbles: true, relatedTarget: null })
      );
    });
    expect(inspectText()).toBe(initialInspect);
  });

  it("handles sampled NQ fixture, isolated mid dots, and empty-columns edge cases safely", async () => {
    const nqContainer = await mount(
      <FlowLiquidityHeatmapPanel
        document={nq}
        failure={null}
        refreshMs={60_000}
        symbol="NQ"
      />
    );
    expect(nqContainer.textContent).toContain("Sampled 1m");

    // Synthetic document with isolated single mid dot, no walls, no trades, and no recorded cols edge
    const isolatedDotDoc: FlowLiquidityHeatmap = {
      ...es,
      columns: [
        {
          bestAsk: 6001.25,
          bestBid: 6001,
          capture: "streamed",
          cells: [{ p: 0, s: 50, side: "bid" }],
          mid: 6001.125,
          state: "recorded",
          t: es.axisStart,
        },
      ],
      currentDom: [],
      priceLevels: [6001],
      priceMax: 6001,
      priceMin: 6001,
      totals: {
        coveragePct: 100,
        largeTrades: 0,
        recordedColumns: 1,
        snapshots: 1,
        totalColumns: 1,
      },
      trades: [],
      walls: [],
    };
    const dotContainer = await mount(
      <FlowLiquidityHeatmapPanel
        document={isolatedDotDoc}
        failure={null}
        refreshMs={60_000}
        symbol="ES"
      />
    );
    expect(
      dotContainer.querySelectorAll("[data-flow-heatmap-mid-dot]")
    ).toHaveLength(1);
    expect(
      dotContainer.querySelectorAll("[data-flow-heatmap-wall-row]")
    ).toHaveLength(0);

    // Defensive edge: recordedColumns > 0 with columns=[] (no activeIndex, no crosshair, no inspect strip)
    // Walls-only doc covers TradesTable empty branch; trades-only doc covers WallsTable empty branch
    const wallsOnly = await mount(
      <FlowLiquidityHeatmapPanel
        document={{ ...es, trades: [] }}
        failure={null}
        refreshMs={60_000}
        symbol="ES"
      />
    );
    expect(
      wallsOnly.querySelectorAll("[data-flow-heatmap-wall-row]").length
    ).toBeGreaterThan(0);
    expect(
      wallsOnly.querySelectorAll("[data-flow-heatmap-trade-row]")
    ).toHaveLength(0);

    const tradesOnly = await mount(
      <FlowLiquidityHeatmapPanel
        document={{ ...es, walls: [] }}
        failure={null}
        refreshMs={60_000}
        symbol="ES"
      />
    );
    expect(
      tradesOnly.querySelectorAll("[data-flow-heatmap-wall-row]")
    ).toHaveLength(0);
    expect(
      tradesOnly.querySelectorAll("[data-flow-heatmap-trade-row]").length
    ).toBeGreaterThan(0);

    // Defensive doc where columns has only no_data (defaultInspectIndex === null) for activeIndex ?? 0
    const noDataColsDoc: FlowLiquidityHeatmap = {
      ...isolatedDotDoc,
      columns: [
        {
          bestAsk: null,
          bestBid: null,
          capture: null,
          cells: [],
          mid: null,
          state: "no_data",
          t: es.axisStart,
        },
      ],
    };
    const noDataSliderContainer = await mount(
      <FlowLiquidityHeatmapPanel
        document={noDataColsDoc}
        failure={null}
        refreshMs={60_000}
        symbol="ES"
      />
    );
    await act(async () => {
      noDataSliderContainer
        .querySelector("[data-flow-heatmap-interactive]")
        ?.dispatchEvent(
          new KeyboardEvent("keydown", { bubbles: true, key: "ArrowRight" })
        );
    });

    const zeroColsDoc: FlowLiquidityHeatmap = {
      ...isolatedDotDoc,
      columns: [],
    };
    const zeroColsContainer = await mount(
      <FlowLiquidityHeatmapPanel
        document={zeroColsDoc}
        failure={null}
        refreshMs={60_000}
        symbol="ES"
      />
    );
    const slider = zeroColsContainer.querySelector<HTMLDivElement>(
      "[data-flow-heatmap-interactive]"
    );
    expect(
      zeroColsContainer.querySelector("[data-flow-heatmap-crosshair]")
    ).toBeNull();
    expect(
      zeroColsContainer.querySelector("[data-flow-heatmap-inspect]")
    ).toBeNull();
    await act(async () => {
      slider?.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, key: "ArrowRight" })
      );
      slider?.dispatchEvent(
        new MouseEvent("pointermove", { bubbles: true, clientX: 200 })
      );
    });
  });
});
