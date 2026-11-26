// @vitest-environment jsdom
import type { GexProfilePoint } from "@darkfactory/api";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { GexSpotCurve, type GexSpotCurveProps } from "./gex-spot-curve.tsx";

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
});

const renderCurve = async (props: GexSpotCurveProps): Promise<HTMLElement> => {
  host = document.createElement("div");
  document.body.append(host);
  const mounted = createRoot(host);
  root = mounted;
  await act(async () => {
    mounted.render(<GexSpotCurve {...props} />);
  });
  return host;
};

const sampleProfile: readonly GexProfilePoint[] = [
  { gex: -1_500_000_000, spot: 70 },
  { gex: -2_500_000, spot: 85 },
  { gex: -45_000, spot: 95 },
  { gex: 250, spot: 100 },
  { gex: 1_800_000, spot: 115 },
  { gex: 3_200_000, spot: 130 },
];

describe("GexSpotCurve", () => {
  it("renders the SVG line chart with zero line, spot marker, flip marker and hidden table", async () => {
    const view = await renderCurve({
      flip: 99.72,
      profile: sampleProfile,
      spot: 101,
    });
    expect(
      view
        .querySelector("[data-gex-spot-curve]")
        ?.getAttribute("data-gex-spot-curve-state")
    ).toBe("ready");
    expect(view.textContent).toContain("GEX vs hypothetical spot");
    const svg = view.querySelector("svg[role='img']");
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute("aria-label")).toContain("$70.00 to $130.00");
    expect(svg?.getAttribute("aria-label")).toContain("Spot $101.00");
    expect(svg?.getAttribute("aria-label")).toContain("Zero-gamma flip $99.72");

    const line = view.querySelector("[data-gex-curve-line]");
    expect(line?.getAttribute("d")).toMatch(/^M.+ L.+$/);
    expect(line?.getAttribute("stroke")).toBe("var(--primary)");
    expect(view.innerHTML).not.toContain("var(--color-");
    expect(view.querySelector("[data-gex-zero-line]")).not.toBeNull();
    expect(view.querySelector("[data-gex-positive-area]")).not.toBeNull();
    expect(view.querySelector("[data-gex-negative-area]")).not.toBeNull();

    const spotMarker = view.querySelector("[data-gex-spot-marker]");
    expect(spotMarker?.getAttribute("data-spot")).toBe("101.00");
    expect(spotMarker?.textContent).toContain("Spot $101.00");
    expect(spotMarker?.querySelector("text")?.getAttribute("fill")).toBe(
      "var(--info-foreground)"
    );

    const flipMarker = view.querySelector("[data-gex-flip-marker]");
    expect(flipMarker?.getAttribute("data-flip")).toBe("99.72");
    expect(flipMarker?.textContent).toContain("Flip $99.72");
    expect(flipMarker?.querySelector("text")?.getAttribute("fill")).toBe(
      "var(--warning-foreground)"
    );
    const table = view.querySelector(
      ".sr-only > table[data-gex-spot-curve-table]"
    );
    expect(table).not.toBeNull();
    const rows = [...(table?.querySelectorAll("tbody tr") ?? [])].map((row) =>
      [...row.querySelectorAll("td")].map((cell) => cell.textContent)
    );
    expect(rows).toEqual([
      ["$70.00", "-$1.50B"],
      ["$85.00", "-$2.50M"],
      ["$95.00", "-$45.0K"],
      ["$100.00", "$250"],
      ["$115.00", "$1.80M"],
      ["$130.00", "$3.20M"],
    ]);
  });

  it("handles no flip crossing, missing or out-of-range markers, flat zero, and asymmetric scales", async () => {
    // All-positive curve with no flip crossing and spot === null.
    let view = await renderCurve({
      flip: null,
      profile: [
        { gex: 100_000, spot: 70 },
        { gex: 500_000, spot: 100 },
        { gex: 200_000, spot: 130 },
      ],
      spot: null,
    });
    expect(view.querySelector("[data-gex-spot-marker]")).toBeNull();
    expect(view.querySelector("[data-gex-flip-marker]")).toBeNull();
    expect(view.textContent).toContain("Zero-gamma flip: no zero crossing");
    expect(
      view.querySelector("svg[role='img']")?.getAttribute("aria-label")
    ).toContain("No zero-gamma crossing in sweep.");
    act(() => root?.unmount());

    // Heavily positive curve with tiny negative tail (zeroY below plot midpoint)
    // plus duplicate spot entry and flip inside range so both flipLabelY and
    // zero-span interpolation branches run.
    view = await renderCurve({
      flip: 72,
      profile: [
        { gex: -0.2, spot: 70 },
        { gex: 2_000_000, spot: 100 },
        { gex: 2_000_000, spot: 100 },
        { gex: 5_000_000, spot: 130 },
      ],
      spot: 100,
    });
    expect(view.querySelector("[data-gex-spot-marker]")).not.toBeNull();
    expect(view.querySelector("[data-gex-flip-marker]")).not.toBeNull();
    expect(view.textContent).not.toContain("-$0");
    expect(
      view.querySelector("[data-gex-spot-curve-table] tbody tr td:nth-child(2)")
        ?.textContent
    ).toBe("$0");
    act(() => root?.unmount());

    // All-zero profile with out-of-range spot (below minSpot) and flip (above maxSpot).
    view = await renderCurve({
      flip: 200,
      profile: [
        { gex: 0, spot: 70 },
        { gex: 0, spot: 130 },
      ],
      spot: 50,
    });
    expect(view.querySelector("[data-gex-zero-line]")).not.toBeNull();
    expect(view.querySelector("[data-gex-spot-marker]")).toBeNull();
    expect(view.querySelector("[data-gex-flip-marker]")).toBeNull();
    expect(view.textContent).toContain("Spot $50.00 (outside sweep)");
    expect(view.textContent).toContain(
      "Zero-gamma flip $200.00 (outside sweep)"
    );
    act(() => root?.unmount());

    // Out-of-range spot above maxSpot and flip below minSpot.
    view = await renderCurve({
      flip: 50,
      profile: [
        { gex: 0, spot: 70 },
        { gex: 0, spot: 130 },
      ],
      spot: 200,
    });
    expect(view.querySelector("[data-gex-spot-marker]")).toBeNull();
    expect(view.querySelector("[data-gex-flip-marker]")).toBeNull();
    act(() => root?.unmount());

    // Heavily negative curve with tiny positive tail (zeroY above plot midpoint,
    // rawMax > 0 but zeroY - maxY < MIN_TICK_GAP).
    view = await renderCurve({
      flip: null,
      profile: [
        { gex: -5_000_000, spot: 70 },
        { gex: -2_000_000, spot: 100 },
        { gex: 10_000, spot: 130 },
      ],
      spot: 100,
    });
    expect(view.querySelector("[data-gex-spot-marker]")).not.toBeNull();
    expect(view.querySelector("[data-gex-flip-marker]")).toBeNull();
    act(() => root?.unmount());

    // Unsorted profile is ordered ascending by spot for plotting, interpolation and the table.
    view = await renderCurve({
      flip: 95,
      profile: [
        { gex: 200_000, spot: 130 },
        { gex: -200_000, spot: 70 },
        { gex: 50_000, spot: 100 },
      ],
      spot: 100,
    });
    const sortedSpots = [
      ...view.querySelectorAll("[data-gex-spot-curve-table] tbody tr"),
    ].map((row) => row.querySelectorAll("td")[0]?.textContent);
    expect(sortedSpots).toEqual(["$70.00", "$100.00", "$130.00"]);
    expect(view.querySelector("[data-gex-spot-marker]")).not.toBeNull();
    expect(view.querySelector("[data-gex-flip-marker]")).not.toBeNull();
    act(() => root?.unmount());

    // Sub-dollar GEX range does not emit duplicate "$0" Y-axis ticks, and non-finite markers are omitted cleanly.
    view = await renderCurve({
      flip: Number.NaN,
      profile: [
        { gex: -0.2, spot: 70 },
        { gex: 0.2, spot: 130 },
      ],
      spot: Number.NaN,
    });
    const zeroTicks = [...view.querySelectorAll("svg[role='img'] text")].filter(
      (node) => node.textContent === "$0"
    );
    expect(zeroTicks).toHaveLength(1);
    expect(view.textContent).not.toContain("NaN");
  });

  it("renders a no-data state naming why when the profile cannot be drawn", async () => {
    let view = await renderCurve({
      flip: null,
      noDataReason:
        "Not computed: no front ATM IV in the QuantData option chain.",
      profile: [],
      spot: 101,
    });
    expect(
      view
        .querySelector("[data-gex-spot-curve]")
        ?.getAttribute("data-gex-spot-curve-state")
    ).toBe("empty");
    expect(view.querySelector("[role='status']")?.textContent).toBe(
      "Not computed: no front ATM IV in the QuantData option chain."
    );
    expect(view.querySelector("svg[role='img']")).toBeNull();
    expect(view.querySelector("[data-gex-spot-curve-table]")).toBeNull();
    act(() => root?.unmount());

    view = await renderCurve({ flip: null, profile: [], spot: null });
    expect(view.querySelector("[role='status']")?.textContent).toContain(
      "no spot price"
    );
    act(() => root?.unmount());

    view = await renderCurve({ flip: null, profile: [], spot: 0 });
    expect(view.querySelector("[role='status']")?.textContent).toContain(
      "no spot price"
    );
    act(() => root?.unmount());

    view = await renderCurve({ flip: null, profile: [], spot: 101 });
    expect(view.querySelector("[role='status']")?.textContent).toContain(
      "strike open interest and front ATM IV"
    );
    act(() => root?.unmount());

    view = await renderCurve({
      flip: null,
      noDataReason: "Caller fallback that should not hide 1-point reason.",
      profile: [{ gex: 100, spot: 100 }],
      spot: null,
    });
    expect(view.querySelector("[role='status']")?.textContent).toContain(
      "at least two hypothetical spot points"
    );
    act(() => root?.unmount());

    view = await renderCurve({
      flip: null,
      profile: [
        { gex: 100, spot: 100 },
        { gex: 200, spot: 100 },
      ],
      spot: 100,
    });
    expect(view.querySelector("[role='status']")?.textContent).toContain(
      "zero price width"
    );
  });
});
