// @vitest-environment jsdom
import type { Breadth90Day } from "@darkfactory/api";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { Breadth90Chart, KIND_LABEL } from "./breadth-90-chart.tsx";

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

const THRESHOLDS = { down80: 20, down90: 10, up80: 80, up90: 90 };

const day = (overrides: Partial<Breadth90Day> = {}): Breadth90Day => ({
  adv: 2400,
  advPct: 82.5,
  date: "2026-11-05",
  decl: 509,
  dvol: 100,
  final: true,
  kind: "UP_80",
  source: "tradingview",
  sourceAsOf: "2026-11-05T21:10:00.000Z",
  updatedAt: "2026-11-05T21:15:00.000Z",
  upPct: 84.2,
  uvol: 900,
  ...overrides,
});

const render = async (days: readonly Breadth90Day[]) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () =>
    root.render(<Breadth90Chart days={days} thresholds={THRESHOLDS} />)
  );
  return container;
};

describe("Breadth90Chart", () => {
  it("draws one bar per session with the four reference lines and a hidden table", async () => {
    const container = await render([
      day({ advPct: null, date: "2026-11-04", kind: "DOWN_90", upPct: 0 }),
      day(),
      day({ date: "2026-11-06", final: false, kind: "UP_90", upPct: 93.1 }),
    ]);
    const svg = container.querySelector("svg");
    expect(svg?.getAttribute("role")).toBe("img");
    expect(svg?.getAttribute("aria-label")).toBe(
      "Up-volume share of the last 3 NYSE sessions, 2026-11-04 to 2026-11-06. Latest 93.1% (intraday). Reference lines at 10, 20, 80, 90%."
    );
    expect(
      [...container.querySelectorAll("[data-threshold]")].map((line) =>
        line.getAttribute("data-threshold")
      )
    ).toEqual(["10", "20", "80", "90"]);
    const bars = [...container.querySelectorAll("rect")];
    expect(bars.map((bar) => bar.dataset["kind"])).toEqual([
      "DOWN_90",
      "UP_80",
      "UP_90",
    ]);
    // A zero share still draws a visible sliver.
    expect(bars[0]?.getAttribute("height")).toBe("1");
    expect(bars[2]?.dataset["final"]).toBe("false");
    expect(bars[2]?.getAttribute("stroke-dasharray")).toBe("3 2");
    expect(bars[1]?.getAttribute("stroke-dasharray")).toBeNull();
    expect(bars[2]?.querySelector("title")?.textContent).toBe(
      "2026-11-06: 93.1% up volume, 90% up day (intraday)"
    );
    expect(bars[1]?.querySelector("title")?.textContent).toBe(
      "2026-11-05: 84.2% up volume, 80% up day"
    );
    const rows = [...container.querySelectorAll("tbody tr")].map(
      (row) => row.textContent
    );
    expect(rows).toEqual([
      "2026-11-040.0—90% down dayClose",
      "2026-11-0584.282.580% up dayClose",
      "2026-11-0693.182.590% up dayIntraday",
    ]);
    expect(container.querySelector("caption")?.textContent).toBe(
      "Breadth-90 sessions"
    );
  });

  it("summarises a closed latest session and an empty chart", async () => {
    const closed = await render([day()]);
    expect(closed.querySelector("svg")?.getAttribute("aria-label")).toContain(
      "Latest 84.2%. Reference"
    );
    const empty = await render([]);
    expect(empty.querySelector("svg")?.getAttribute("aria-label")).toBe(
      "No sessions yet."
    );
    expect(empty.querySelectorAll("rect")).toHaveLength(0);
  });

  it("names every day kind", () => {
    expect(Object.keys(KIND_LABEL).sort()).toEqual([
      "DOWN_80",
      "DOWN_90",
      "NEUTRAL",
      "UP_80",
      "UP_90",
    ]);
  });
});
