// @vitest-environment jsdom
import type { FlowGex, FlowSnapshot } from "@darkfactory/api";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { buildFlowPriceOverlayLevels } from "../../features/flow/gamma-levels-view-model.ts";
import {
  FlowGammaLevelsChart,
  FlowGammaLevelsStrip,
  SvgGammaLevelLines,
} from "./flow-gamma-levels-chart.tsx";

const testGlobal = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
beforeAll(() => {
  testGlobal.IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  delete testGlobal.IS_REACT_ACT_ENVIRONMENT;
});
const roots: Root[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.replaceChildren();
});

const mount = async (node: React.ReactElement): Promise<HTMLDivElement> => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => root.render(node));
  return host;
};

const gex = (overrides: Partial<FlowGex> = {}): FlowGex => ({
  at: "2026-11-25T15:30:00Z",
  basis: 0,
  ivRegime: "contango",
  levels: {
    callWall: 615,
    flip: 602,
    kingNode: 615,
    maxPain: null,
    putWall: 590,
  },
  netDex: 1e6,
  regime: "positive",
  spot: 605,
  symbolLevels: {
    callWall: 615,
    flip: 602,
    kingNode: 615,
    maxPain: null,
    putWall: 590,
  },
  ticker: "SPY",
  totalGex: 1e9,
  zeroDteShare: 0.4,
  ...overrides,
});

const snapshot = (overrides: Partial<FlowSnapshot> = {}): FlowSnapshot =>
  ({
    confluence: { factors: [], summary: "neutral" },
    events: [],
    freshness: [],
    gex: gex(),
    minutes: [
      {
        bearishPremium: 0,
        bookPressure: 0,
        bullishPremium: 0,
        buyVolume: 10,
        callPremium: 0,
        close: 604,
        coveredSeconds: 60,
        cvd: 5,
        delta: 5,
        minute: "2026-11-25T14:30:00Z",
        optionTrades: 0,
        putPremium: 0,
        sellVolume: 5,
        trades: 5,
        volume: 15,
        vwap: 603.5,
      },
      {
        bearishPremium: 0,
        bookPressure: 0,
        bullishPremium: 0,
        buyVolume: 10,
        callPremium: 0,
        close: 606,
        coveredSeconds: 60,
        cvd: 10,
        delta: 5,
        minute: "2026-11-25T14:31:00Z",
        optionTrades: 0,
        putPremium: 0,
        sellVolume: 5,
        trades: 5,
        volume: 15,
        vwap: 604.5,
      },
    ],
    notes: [],
    optionsFlow: {
      bearishPremium: 0,
      bullishPremium: 0,
      callPremium: 0,
      putPremium: 0,
      topPrints: [],
      trades: 0,
    },
    orderFlow: { book: null, cvd: 0, delta: 0, volume: 0 },
    schemaVersion: "flow-snapshot.v1",
    symbol: "SPY",
    windowEnd: "2026-11-25T15:30:00Z",
    windowStart: "2026-11-25T13:30:00Z",
    ...overrides,
  }) as unknown as FlowSnapshot;

describe("FlowGammaLevelsChart & SVG helpers", () => {
  it("renders nothing when gex has no levels or helper inputs are empty", async () => {
    const empty = await mount(
      <FlowGammaLevelsChart snapshot={snapshot({ gex: null })} />
    );
    expect(empty.textContent).toBe("");

    const noLines = await mount(
      <svg aria-hidden="true">
        <SvgGammaLevelLines chartWidth={500} chartX={40} lines={[]} />
      </svg>
    );
    expect(noLines.querySelector("[data-flow-gamma-lines]")).toBeNull();
  });

  it("renders intraday price line, VWAP, gamma level lines, shifted leaders, and legend", async () => {
    const host = await mount(<FlowGammaLevelsChart snapshot={snapshot()} />);
    expect(host.querySelector("[data-flow-gex-price-chart]")).not.toBeNull();
    expect(host.querySelector("[data-flow-gex-price-line]")).not.toBeNull();
    expect(host.querySelector("[data-flow-gex-vwap]")).not.toBeNull();
    expect(
      host.querySelector('[data-flow-gamma-line="callWall+kingNode"]')
    ).not.toBeNull();
    // Late-session close sits past 65% of chartWidth -> right-aligned ("end") Last label.
    const lateClose = await mount(
      <FlowGammaLevelsChart
        snapshot={snapshot({
          minutes: [
            {
              bearishPremium: 0,
              bookPressure: 0,
              bullishPremium: 0,
              buyVolume: 10,
              callPremium: 0,
              close: 606,
              coveredSeconds: 60,
              cvd: 10,
              delta: 5,
              minute: "2026-11-25T15:25:00Z",
              optionTrades: 0,
              putPremium: 0,
              sellVolume: 5,
              trades: 5,
              volume: 15,
              vwap: 605,
            },
          ],
        })}
      />
    );
    expect(
      lateClose
        .querySelector("[data-flow-gex-spot] text")
        ?.getAttribute("text-anchor")
    ).toBe("end");
    expect(host.textContent).toContain("▲★ Call wall · King 615.00");
    expect(host.textContent).toContain("Max pain:not computed");

    // Spot-only fallback (no minute series) and null spot path.
    const spotOnly = await mount(
      <FlowGammaLevelsChart snapshot={snapshot({ minutes: [] })} />
    );
    expect(spotOnly.textContent).toContain("no intraday tape closes");
    expect(spotOnly.querySelector("[data-flow-gex-spot] line")).not.toBeNull();

    const noSpot = await mount(
      <FlowGammaLevelsChart
        snapshot={snapshot({ gex: gex({ spot: null }), minutes: [] })}
      />
    );
    expect(noSpot.querySelector("[data-flow-gex-spot]")).toBeNull();

    // Shifted label pill renders a leader connector.
    const shifted = await mount(
      <svg aria-hidden="true">
        <SvgGammaLevelLines
          chartWidth={500}
          chartX={40}
          lines={[
            {
              accentColor: "var(--vx-gold)",
              color: "var(--warning)",
              dashArray: "8 4",
              glyphs: "⇄",
              hasKingNode: false,
              isMergedWithKing: false,
              key: "flip",
              labelY: 96,
              pillText: "⇄ Flip 602.00",
              price: 602,
              primaryKind: "flip",
              shortLabel: "Flip",
              strokeWidth: 1.75,
              y: 80,
            },
          ]}
        />
      </svg>
    );
    // The pill sits at the left edge of the plot; its leader runs from the pill to the line.
    expect(shifted.querySelector("rect")?.getAttribute("x")).toBe("44");
    expect(shifted.querySelector("text")?.getAttribute("text-anchor")).toBe(
      "start"
    );
    const [levelLine, leader] = [...shifted.querySelectorAll("line")];
    expect(shifted.querySelectorAll("line")).toHaveLength(2);
    expect(levelLine?.getAttribute("x1")).toBe("40");
    expect(levelLine?.getAttribute("x2")).toBe("540");
    expect(
      ["x1", "y1", "x2", "y2"].map((name) => leader?.getAttribute(name))
    ).toEqual(["137", "96", "145", "80"]);
  });

  it("states the as-of time, the levels in range for screen readers, and the levels off the scale", async () => {
    const levelsFor = (priceMin: number, priceMax: number, spot = 605) => {
      const built = buildFlowPriceOverlayLevels({
        chartHeight: 200,
        chartY: 16,
        gex: gex({ spot: spot === 0 ? null : spot }),
        priceMax,
        priceMin,
        symbol: "SPY",
      });
      if (built === null) throw new Error("fixture has no gamma levels");
      return built;
    };
    const host = await mount(
      <FlowGammaLevelsStrip levels={levelsFor(600, 610)} />
    );
    expect(host.querySelector("[data-flow-gamma-as-of]")?.textContent).toBe(
      "Gamma levels: GEX estimate as of Nov 25, 10:30 AM EST"
    );
    const inRange = host.querySelector("[data-flow-gamma-in-range]");
    expect(inRange?.textContent).toBe("In range: ⇄ Flip 602.00");
    expect(inRange?.className).toBe("sr-only");
    expect(host.textContent).toContain("↑ Above range:");
    expect(host.textContent).toContain("▲★ Call wall · King 615.00 (+1.7%)");
    expect(host.textContent).toContain("↓ Below range:");
    expect(host.textContent).toContain("▼ Put wall 590.00 (-2.5%)");

    // Above only, no reference price: no distance text and no "below" list.
    const aboveOnly = await mount(
      <FlowGammaLevelsStrip levels={levelsFor(580, 610, 0)} />
    );
    expect(aboveOnly.textContent).toContain("▲★ Call wall · King 615.00");
    expect(aboveOnly.textContent).not.toContain("%");
    expect(aboveOnly.textContent).not.toContain("↓ Below range:");

    // Below only, and no level inside the range: no in-range text.
    const belowOnly = await mount(
      <FlowGammaLevelsStrip levels={levelsFor(616, 630)} />
    );
    expect(belowOnly.textContent).toContain("▼ Put wall 590.00 (-2.5%)");
    expect(belowOnly.textContent).not.toContain("↑ Above range:");
    expect(belowOnly.querySelector("[data-flow-gamma-in-range]")).toBeNull();
  });
});
