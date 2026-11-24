// @vitest-environment jsdom
import type { FlowStrikeHeatmap } from "@darkfactory/api";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { buildStrikeHeatmapGrid } from "../../features/flow/strike-heatmap-view-model.ts";
import { labFlowStrikeHeatmap } from "../../lab/fixtures/flow.ts";
import { FlowStrikeHeatmapPanel } from "./flow-strike-heatmap-panel.tsx";

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
  return container;
};

describe("FlowStrikeHeatmapPanel", () => {
  it("renders loading, updating, and failure states with Retry and bucket switching", async () => {
    const onBucket = vi.fn();
    const onRetry = vi.fn();

    const loadingHost = await render(
      <FlowStrikeHeatmapPanel
        bucketMinutes={15}
        document={null}
        failure={null}
        onBucketMinutesChange={onBucket}
        onRetry={onRetry}
        pending
        refreshMs={60_000}
        symbol="SPY"
      />
    );
    expect(
      loadingHost
        .querySelector("[data-flow-strike-heatmap]")
        ?.getAttribute("data-flow-strike-heatmap-state")
    ).toBe("loading");
    expect(loadingHost.textContent).toContain("Loading options flow heatmap");
    expect(
      loadingHost.querySelector("[data-flow-strike-heatmap-updating]")
    ).toBeNull();

    // Clicking active 15m does nothing; clicking 5m invokes callback
    const btn15 = loadingHost.querySelector<HTMLButtonElement>(
      '[data-flow-strike-heatmap-bucket="15"]'
    );
    const btn5 = loadingHost.querySelector<HTMLButtonElement>(
      '[data-flow-strike-heatmap-bucket="5"]'
    );
    await act(async () => btn15?.click());
    expect(onBucket).not.toHaveBeenCalled();
    await act(async () => btn5?.click());
    expect(onBucket).toHaveBeenCalledWith(5);

    // Failure over a previously loaded 15m document while requesting 5m keeps the grid visible
    const spyDoc = labFlowStrikeHeatmap("SPY", 15);
    const failedHost = await render(
      <FlowStrikeHeatmapPanel
        bucketMinutes={5}
        document={spyDoc}
        failure={{
          code: "STORAGE_ERROR",
          failedAt: Date.parse("2026-10-30T15:00:00.000Z"),
          message: "timeout",
        }}
        onBucketMinutesChange={onBucket}
        onRetry={onRetry}
        pending
        refreshMs={60_000}
        symbol="SPY"
      />
    );
    expect(
      failedHost
        .querySelector("[data-flow-strike-heatmap]")
        ?.getAttribute("data-flow-strike-heatmap-state")
    ).toBe("failed");
    expect(
      failedHost.querySelector("[data-flow-strike-heatmap-updating]")
        ?.textContent
    ).toContain("Updating 5m grid");
    expect(
      failedHost.querySelector("[data-flow-strike-heatmap-error]")?.textContent
    ).toContain("Showing previous 15m grid.");
    expect(
      failedHost.querySelector("[data-flow-strike-heatmap-table]")
    ).not.toBeNull();

    const retryBtn = failedHost.querySelector<HTMLButtonElement>(
      "[data-flow-strike-heatmap-retry]"
    );
    await act(async () => retryBtn?.click());
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("renders empty-session, no-cells, and strikes-without-cells responses cleanly", async () => {
    const spy = labFlowStrikeHeatmap("SPY", 15);
    const emptySession: FlowStrikeHeatmap = {
      ...spy,
      cells: [],
      session: null,
      slots: [],
      storedUntil: null,
      strikes: [],
      totals: {
        ...spy.totals,
        latestPrice: null,
        omittedStrikes: 0,
        prints: 0,
        shownStrikes: 0,
        totalStrikes: 0,
      },
      unread: null,
    };

    const emptyHost = await render(
      <FlowStrikeHeatmapPanel
        bucketMinutes={15}
        document={emptySession}
        failure={null}
        onBucketMinutesChange={vi.fn()}
        onRetry={vi.fn()}
        pending={false}
        refreshMs={60_000}
        symbol="SPY"
      />
    );
    expect(
      emptyHost.querySelector("[data-flow-strike-heatmap-empty]")?.textContent
    ).toContain("No option prints stored for SPY");

    const noStrikes: FlowStrikeHeatmap = {
      ...emptySession,
      session: "2026-10-30",
    };
    const noStrikesHost = await render(
      <FlowStrikeHeatmapPanel
        bucketMinutes={15}
        document={noStrikes}
        failure={null}
        onBucketMinutesChange={vi.fn()}
        onRetry={vi.fn()}
        pending={false}
        refreshMs={60_000}
        symbol="SPY"
      />
    );
    expect(
      noStrikesHost.querySelector("[data-flow-strike-heatmap-no-cells]")
        ?.textContent
    ).toContain("No regular-session option print stored");

    // Strikes present, zero cells -> inspector omitted cleanly
    const noCells: FlowStrikeHeatmap = {
      ...spy,
      cells: [],
      strikes: spy.strikes.slice(0, 1),
      totals: { ...spy.totals, latestPrice: null, omittedStrikes: 0 },
    };
    const noCellsHost = await render(
      <FlowStrikeHeatmapPanel
        bucketMinutes={15}
        document={noCells}
        failure={null}
        onBucketMinutesChange={vi.fn()}
        onRetry={vi.fn()}
        pending={false}
        refreshMs={60_000}
        symbol="SPY"
      />
    );
    expect(
      noCellsHost.querySelector("[data-flow-strike-heatmap-inspector]")
    ).toBeNull();
    expect(
      noCellsHost.querySelector("[data-flow-strike-heatmap-spot]")
    ).toBeNull();
  });

  it("renders SPY between-strikes spot, unread gap, omitted disclosure, flat cells, and pointer/keyboard inspection", async () => {
    const spy = labFlowStrikeHeatmap("SPY", 15);
    const host = await render(
      <FlowStrikeHeatmapPanel
        bucketMinutes={15}
        document={spy}
        failure={null}
        onBucketMinutesChange={vi.fn()}
        onRetry={vi.fn()}
        pending={false}
        refreshMs={60_000}
        symbol="SPY"
      />
    );
    expect(
      host
        .querySelector("[data-flow-strike-heatmap]")
        ?.getAttribute("data-flow-strike-heatmap-state")
    ).toBe("response");
    expect(
      host.querySelector('[data-flow-strike-heatmap-spot="between"]')
    ).not.toBeNull();
    expect(
      host.querySelector("[data-flow-strike-heatmap-legend-unread]")
    ).not.toBeNull();
    expect(
      host.querySelector('[data-flow-strike-heatmap-unread="true"]')
    ).not.toBeNull();
    expect(
      host.querySelector('[data-flow-strike-heatmap-cell-unread="true"]')
    ).not.toBeNull();
    expect(
      host.querySelector("[data-flow-strike-heatmap-omitted]")?.textContent
    ).toContain("3 minor strikes");
    expect(
      host.querySelector('[data-flow-strike-heatmap-direction="flat"]')
    ).not.toBeNull();
    expect(
      host.querySelector('[data-flow-strike-heatmap-direction="bull"]')
    ).not.toBeNull();
    expect(
      host.querySelector('[data-flow-strike-heatmap-direction="bear"]')
    ).not.toBeNull();

    // Roving tabindex: exactly one cell has tabIndex=0
    const allCells = [
      ...host.querySelectorAll<HTMLButtonElement>(
        "[data-flow-strike-heatmap-cell]"
      ),
    ];
    expect(allCells.filter((el) => el.tabIndex === 0)).toHaveLength(1);

    // Click another cell and verify inspector updates + roving tabIndex moves
    const targetCell = allCells.find((el) => el.tabIndex === -1);
    expect(targetCell).toBeDefined();
    await act(async () => targetCell?.click());
    expect(targetCell?.tabIndex).toBe(0);
    expect(targetCell?.getAttribute("aria-pressed")).toBe("true");
    const targetStrike = targetCell
      ?.getAttribute("data-flow-strike-heatmap-cell")
      ?.split(":")[0];
    expect(
      host.querySelector("[data-flow-strike-heatmap-inspector]")?.textContent
    ).toContain(`SPY strike ${targetStrike}`);

    // Focus selects cell; non-navigation key does not change selection
    const firstCell = allCells[0];
    await act(async () => {
      firstCell?.focus();
    });
    const firstKey = firstCell?.getAttribute("data-flow-strike-heatmap-cell");
    await act(async () => {
      firstCell?.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, key: "Enter" })
      );
    });
    expect(
      host
        .querySelector('[data-flow-strike-heatmap-cell][tabindex="0"]')
        ?.getAttribute("data-flow-strike-heatmap-cell")
    ).toBe(firstKey);

    // ArrowLeft at leftmost active cell stays put; ArrowRight moves to next active cell
    await act(async () => {
      firstCell?.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, key: "ArrowLeft" })
      );
    });
    expect(
      host
        .querySelector('[data-flow-strike-heatmap-cell][tabindex="0"]')
        ?.getAttribute("data-flow-strike-heatmap-cell")
    ).toBe(firstKey);

    await act(async () => {
      firstCell?.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, key: "ArrowRight" })
      );
    });
    const movedKey = host
      .querySelector('[data-flow-strike-heatmap-cell][tabindex="0"]')
      ?.getAttribute("data-flow-strike-heatmap-cell");
    expect(movedKey).not.toBe(firstKey);
    expect(
      document.activeElement?.getAttribute("data-flow-strike-heatmap-cell")
    ).toBe(movedKey);
  });

  it("renders ES exact-strike spot badge, above-all, and below-all spot dividers", async () => {
    const es = labFlowStrikeHeatmap("ES", 30);
    const esHost = await render(
      <FlowStrikeHeatmapPanel
        bucketMinutes={30}
        document={es}
        failure={null}
        onBucketMinutesChange={vi.fn()}
        onRetry={vi.fn()}
        pending={false}
        refreshMs={60_000}
        symbol="ES"
      />
    );
    expect(
      esHost.querySelector('[data-flow-strike-heatmap-spot="at"]')
    ).not.toBeNull();
    expect(
      esHost.querySelector("[data-flow-strike-heatmap-spot-summary]")
        ?.textContent
    ).toContain("SPX spot 5,810.00");
    expect(
      esHost.querySelector("[data-flow-strike-heatmap-omitted]")
    ).toBeNull();
    expect(
      esHost.querySelector("[data-flow-strike-heatmap-legend-unread]")
    ).toBeNull();

    // Above-all spot divider
    const aboveDoc: FlowStrikeHeatmap = {
      ...es,
      totals: { ...es.totals, latestPrice: 6000 },
    };
    const aboveHost = await render(
      <FlowStrikeHeatmapPanel
        bucketMinutes={30}
        document={aboveDoc}
        failure={null}
        onBucketMinutesChange={vi.fn()}
        onRetry={vi.fn()}
        pending={false}
        refreshMs={60_000}
        symbol="ES"
      />
    );
    expect(
      aboveHost.querySelector('[data-flow-strike-heatmap-spot="above-all"]')
    ).not.toBeNull();

    // Below-all spot divider
    const belowDoc: FlowStrikeHeatmap = {
      ...es,
      totals: { ...es.totals, latestPrice: 5500 },
    };
    const belowHost = await render(
      <FlowStrikeHeatmapPanel
        bucketMinutes={30}
        document={belowDoc}
        failure={null}
        onBucketMinutesChange={vi.fn()}
        onRetry={vi.fn()}
        pending={false}
        refreshMs={60_000}
        symbol="ES"
      />
    );
    expect(
      belowHost.querySelector('[data-flow-strike-heatmap-spot="below-all"]')
    ).not.toBeNull();
  });

  it("renders a cell on an unread slot with hatched pattern and zero-net strike totals cleanly", async () => {
    const es = labFlowStrikeHeatmap("ES", 30);
    const slot0 = es.slots[0];
    const strike0 = es.strikes[0];
    const cell0 = es.cells[0];
    if (slot0 === undefined || strike0 === undefined || cell0 === undefined)
      throw new Error("Expected fixture data");

    const custom: FlowStrikeHeatmap = {
      ...es,
      cells: [
        {
          ...cell0,
          netPremium: 0,
          slotIndex: slot0.index,
          strike: strike0.strike,
        },
      ],
      slots: [{ ...slot0, price: null, unread: true }],
      strikes: [{ ...strike0, netPremium: 0 }],
    };
    const host = await render(
      <FlowStrikeHeatmapPanel
        bucketMinutes={30}
        document={custom}
        failure={null}
        onBucketMinutesChange={vi.fn()}
        onRetry={vi.fn()}
        pending={false}
        refreshMs={60_000}
        symbol="ES"
      />
    );
    const btn = host.querySelector<HTMLButtonElement>(
      "[data-flow-strike-heatmap-cell]"
    );
    expect(btn?.style.backgroundImage).toContain("repeating-linear-gradient");
    expect(host.textContent).toContain("$0");
  });

  it("renders hard failure without a prior grid and resets selected cell on bucket change", async () => {
    const onRetry = vi.fn();
    const hardErrorHost = await render(
      <FlowStrikeHeatmapPanel
        bucketMinutes={15}
        document={null}
        failure={{
          code: "INTERNAL_SERVER_ERROR",
          failedAt: Date.UTC(2026, 9, 30, 15, 0, 0),
          message: "Database busy",
        }}
        onBucketMinutesChange={vi.fn()}
        onRetry={onRetry}
        pending={false}
        refreshMs={60_000}
        symbol="SPY"
      />
    );
    expect(
      hardErrorHost
        .querySelector("[data-flow-strike-heatmap]")
        ?.getAttribute("data-flow-strike-heatmap-state")
    ).toBe("failed");
    expect(
      hardErrorHost.querySelector("[data-flow-strike-heatmap-error]")
        ?.textContent
    ).toContain("Database busy");
    hardErrorHost
      .querySelector<HTMLButtonElement>("[data-flow-strike-heatmap-retry]")
      ?.click();
    expect(onRetry).toHaveBeenCalledTimes(1);

    const doc15 = labFlowStrikeHeatmap("ES", 15);
    const doc5 = labFlowStrikeHeatmap("ES", 5);
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const renderPanel = async (doc: FlowStrikeHeatmap) => {
      await act(async () => {
        root.render(
          <FlowStrikeHeatmapPanel
            bucketMinutes={doc.bucketMinutes}
            document={doc}
            failure={null}
            onBucketMinutesChange={vi.fn()}
            onRetry={vi.fn()}
            pending={false}
            refreshMs={60_000}
            symbol="ES"
          />
        );
      });
    };
    await renderPanel(doc15);
    const firstCell = host.querySelector<HTMLButtonElement>(
      "[data-flow-strike-heatmap-cell]"
    );
    expect(firstCell).not.toBeNull();
    await act(async () => {
      firstCell?.click();
    });
    const clickedKey = firstCell?.getAttribute("data-flow-strike-heatmap-cell");
    expect(clickedKey).not.toBeNull();
    await renderPanel(doc5);
    const activeCell = host.querySelector<HTMLButtonElement>(
      '[data-flow-strike-heatmap-cell][tabindex="0"]'
    );
    const expectedDefault = buildStrikeHeatmapGrid(doc5).defaultSelectedKey;
    expect(activeCell?.getAttribute("data-flow-strike-heatmap-cell")).toBe(
      expectedDefault
    );
    await act(async () => {
      root.unmount();
    });
    host.remove();
  });
});
