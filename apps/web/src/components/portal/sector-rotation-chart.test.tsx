// @vitest-environment jsdom
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  CHART_SIZE,
  chartDomain,
  projectPoint,
  SectorRotationChart,
  type SectorRotationChartProps,
  segmentOpacity,
  seriesColor,
  tailPoints,
  tailSegments,
} from "./sector-rotation-chart.tsx";
import {
  laggardSeries,
  leaderSeries,
  rotationPoint,
} from "./sector-rotation-test-fixtures.ts";

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

const props = (
  overrides: Partial<SectorRotationChartProps> = {}
): SectorRotationChartProps => ({
  benchmark: "SPY",
  date: "2026-10-30",
  highlighted: null,
  onHighlight: vi.fn(),
  series: [leaderSeries(), laggardSeries()],
  tailLength: 10,
  timeframe: "weekly",
  ...overrides,
});

describe("sector rotation chart helpers", () => {
  it("builds a domain that holds 100 and every point, with a pad", () => {
    expect(chartDomain([])).toEqual({
      xMax: 100.56,
      xMin: 99.44,
      yMax: 100.56,
      yMin: 99.44,
    });
    const domain = chartDomain([
      { momentum: 102, ratio: 90 },
      { momentum: 99, ratio: 101 },
    ]);
    expect(domain.xMin).toBeCloseTo(89.34);
    expect(domain.xMax).toBeCloseTo(101.66);
    expect(domain.yMin).toBeCloseTo(98.82);
    return expect(domain.yMax).toBeCloseTo(102.18);
  });

  it("projects 100/100 to the center and grows y upward", () => {
    const domain = chartDomain([
      { momentum: 99, ratio: 99 },
      { momentum: 101, ratio: 101 },
    ]);
    expect(projectPoint({ momentum: 100, ratio: 100 }, domain)).toEqual({
      x: CHART_SIZE / 2,
      y: CHART_SIZE / 2,
    });
    const top = projectPoint(
      { momentum: domain.yMax, ratio: domain.xMax },
      domain
    );
    expect(top.x).toBeCloseTo(CHART_SIZE - 40);
    return expect(top.y).toBeCloseTo(40);
  });

  it("slices the tail up to a date", () => {
    const points = leaderSeries().points;
    expect(tailPoints(points, null, 2).map((point) => point.date)).toEqual([
      "2026-10-23",
      "2026-10-30",
    ]);
    expect(
      tailPoints(points, "2026-10-20", 10).map((point) => point.date)
    ).toEqual(["2026-10-09", "2026-10-16"]);
    return expect(tailPoints(points, "2026-01-01", 5)).toEqual([]);
  });

  it("pairs tail positions and fades older segments", () => {
    const a = { x: 0, y: 0 };
    const b = { x: 1, y: 1 };
    const c = { x: 2, y: 2 };
    expect(tailSegments([a])).toEqual([]);
    expect(tailSegments([a, b, c])).toEqual([
      { from: a, to: b },
      { from: b, to: c },
    ]);
    expect(segmentOpacity(0, 4)).toBeCloseTo(0.4);
    return expect(segmentOpacity(3, 4)).toBe(1);
  });

  return it("repeats the five chart colors", () => {
    expect(seriesColor(0)).toEqual({
      fill: "fill-chart-1",
      stroke: "stroke-chart-1",
    });
    expect(seriesColor(6).stroke).toBe("stroke-chart-2");
    return expect(seriesColor(Number.NaN).stroke).toBe("stroke-chart-1");
  });
});

describe("SectorRotationChart", () => {
  it("draws quadrants, tails, heads and an accessible summary", async () => {
    const { container } = await render(<SectorRotationChart {...props()} />);
    const svg = container.querySelector('svg[role="img"]');
    expect(svg?.getAttribute("aria-label")).toBe(
      "Sector rotation map against SPY, 2026-10-30: XLK leading, XLE improving."
    );
    const text = container.textContent;
    for (const label of ["Leading", "Weakening", "Lagging", "Improving"])
      expect(text).toContain(label);
    expect(container.querySelectorAll('[data-series="XLK"] line')).toHaveLength(
      3
    );
    expect(container.querySelectorAll('[data-series="XLE"] line')).toHaveLength(
      2
    );
    expect(container.querySelector("figcaption")?.textContent).toContain(
      "Tails show up to 10 weeks to 2026-10-30"
    );
    return expect(container.querySelector("[data-tooltip]")).toBeNull();
  });

  it("hides series without a point yet and reports an empty map", async () => {
    const early = await render(
      <SectorRotationChart {...props({ date: "2026-10-09", tailLength: 5 })} />
    );
    expect(early.container.querySelector('[data-series="XLE"]')).toBeNull();
    const empty = await render(
      <SectorRotationChart
        {...props({ date: null, series: [], timeframe: "daily" })}
      />
    );
    expect(
      empty.container.querySelector("svg")?.getAttribute("aria-label")
    ).toBe("Sector rotation map against SPY, latest: no points.");
    return expect(
      empty.container.querySelector("figcaption")?.textContent
    ).toContain("Tails show up to 10 days to the latest date");
  });

  it("highlights a series on hover and shows its tooltip", async () => {
    const onHighlight = vi.fn();
    const { container, root } = await render(
      <SectorRotationChart {...props({ onHighlight })} />
    );
    const head = container.querySelector('[data-head="XLE"]');
    await act(async () => {
      head?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      head?.dispatchEvent(new MouseEvent("mouseout", { bubbles: true }));
    });
    expect(onHighlight.mock.calls).toEqual([["XLE"], [null]]);
    await act(async () =>
      root.render(<SectorRotationChart {...props({ highlighted: "XLE" })} />)
    );
    expect(
      container.querySelector('[data-series="XLK"]')?.getAttribute("opacity")
    ).toBe("0.25");
    expect(
      container.querySelector('[data-series="XLE"]')?.getAttribute("opacity")
    ).toBe("1");
    expect(container.querySelector("[data-tooltip]")?.textContent).toBe(
      "XLEImproving · ratio 98.60 · momentum 100.202026-10-30"
    );
    await act(async () =>
      root.render(<SectorRotationChart {...props({ highlighted: "XLK" })} />)
    );
    return expect(
      container.querySelector("[data-tooltip]")?.textContent
    ).toContain("XLK · Technology");
  });

  return it("keeps a single-point tail as a head only", async () => {
    const { container } = await render(
      <SectorRotationChart
        {...props({
          series: [
            {
              latest: null,
              name: null,
              points: [rotationPoint("2026-10-30", 100, 100, "leading")],
              symbol: "AAA",
            },
          ],
        })}
      />
    );
    expect(container.querySelectorAll('[data-series="AAA"] line')).toHaveLength(
      0
    );
    return expect(container.querySelector('[data-head="AAA"]')).not.toBeNull();
  });
});
