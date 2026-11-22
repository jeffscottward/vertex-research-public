// @vitest-environment jsdom
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  buildTapeSpeedChart,
  burstRows,
  ruleSentence,
  tapeFaultLine,
  tapeLine,
  tapeSpeedAriaLabel,
  tapeSpeedCaption,
  tapeSpeedLegend,
} from "../../features/flow/tape-speed-view-model.ts";
import { labFlowTapeSpeed } from "../../lab/fixtures/flow.ts";
import { FlowTapeSpeedPanel } from "./flow-tape-speed-panel.tsx";

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

const es = labFlowTapeSpeed("ES", 120);
const nq = labFlowTapeSpeed("NQ", 120);
const nothing = labFlowTapeSpeed("NQ", 390);
const failure = {
  code: "STORAGE_ERROR",
  failedAt: Date.UTC(2026, 10, 20, 21, 5),
  message: "down",
};
const stateOf = (container: HTMLElement) =>
  container
    .querySelector("[data-flow-tape-speed]")
    ?.getAttribute("data-flow-tape-state");
const textOf = (container: HTMLElement, selector: string) =>
  container.querySelector(selector)?.textContent;

describe("FlowTapeSpeedPanel", () => {
  it("shows the loading text before the first answer", async () => {
    const container = await mount(
      <FlowTapeSpeedPanel
        document={null}
        failure={null}
        refreshMs={60_000}
        symbol="ES"
      />
    );
    expect(stateOf(container)).toBe("loading");
    expect(textOf(container, '[role="status"]')).toBe("Loading tape speed…");
    expect(container.querySelector("h2")?.textContent).toBe("Tape speed (ES)");
    expect(container.querySelector("svg")).toBeNull();
    // The panel keeps the height of the charts while it has no document.
    expect(
      container.querySelector("[data-flow-tape-speed]")?.className
    ).toContain("min-h-80");
  });

  it("names the future and its group in the title for SPY and QQQ", async () => {
    const spy = await mount(
      <FlowTapeSpeedPanel
        document={es}
        failure={null}
        refreshMs={60_000}
        symbol="SPY"
      />
    );
    expect(spy.querySelector("h2")?.textContent).toBe(
      "Tape speed (ES, the future of the S&P 500 group)"
    );
    expect(
      spy
        .querySelector("[data-flow-tape-speed]")
        ?.getAttribute("data-flow-tape-speed")
    ).toBe("ES");
    const qqq = await mount(
      <FlowTapeSpeedPanel
        document={nq}
        failure={null}
        refreshMs={60_000}
        symbol="QQQ"
      />
    );
    expect(qqq.querySelector("h2")?.textContent).toBe(
      "Tape speed (NQ, the future of the Nasdaq 100 group)"
    );
  });

  it("shows the error line alone without a document, and above the last document with one", async () => {
    const alone = await mount(
      <FlowTapeSpeedPanel
        document={null}
        failure={failure}
        refreshMs={60_000}
        symbol="ES"
      />
    );
    expect(stateOf(alone)).toBe("failed");
    // The label of the page: it holds the date when the failure is not of today.
    expect(textOf(alone, "[data-flow-tape-error]")).toBe(
      "Load failed 2026-11-20 21:05 UTC · Tape speed not loaded: STORAGE_ERROR: down · retrying every 60 s"
    );
    expect(
      alone.querySelector("[data-flow-tape-error]")?.getAttribute("role")
    ).toBe("alert");
    expect(alone.querySelector("svg")).toBeNull();
    expect(alone.textContent).not.toContain("Loading tape speed");

    const kept = await mount(
      <FlowTapeSpeedPanel
        document={es}
        failure={failure}
        refreshMs={5000}
        symbol="ES"
      />
    );
    expect(stateOf(kept)).toBe("failed");
    expect(textOf(kept, "[data-flow-tape-error]")).toContain(
      "retrying every 5 s"
    );
    expect(kept.querySelectorAll("[data-flow-tape-chart]")).toHaveLength(2);
  });

  it("draws both charts, the shades, one tick per bar and one mark per bar with a burst", async () => {
    const container = await mount(
      <FlowTapeSpeedPanel
        document={es}
        failure={null}
        refreshMs={60_000}
        symbol="ES"
      />
    );
    const chart = buildTapeSpeedChart(es);
    expect(stateOf(container)).toBe("document");
    expect(
      container.querySelector("[data-flow-tape-speed]")?.className
    ).not.toContain("min-h-80");
    const [trades, contracts] = [
      ...container.querySelectorAll("[data-flow-tape-chart]"),
    ];
    expect(trades?.getAttribute("data-flow-tape-chart")).toBe("trades");
    expect(trades?.getAttribute("aria-label")).toBe(
      tapeSpeedAriaLabel(chart, "trades")
    );
    expect(trades?.getAttribute("role")).toBe("img");
    expect(trades?.getAttribute("viewBox")).toBe(
      `0 0 ${chart.width} ${chart.height}`
    );
    expect(contracts?.getAttribute("aria-label")).toBe(
      tapeSpeedAriaLabel(chart, "contracts")
    );
    expect(trades?.querySelectorAll("[data-flow-tape-bar]")).toHaveLength(
      chart.counted
    );
    expect(trades?.querySelectorAll("[data-flow-tape-tick]")).toHaveLength(
      chart.counted
    );
    expect(contracts?.querySelectorAll("[data-flow-tape-bar]")).toHaveLength(
      chart.counted
    );
    // Bars 170 to 175 of the fixture are partly covered.
    expect(
      trades?.querySelectorAll('[data-flow-tape-bar="partial"]')
    ).toHaveLength(6);
    expect(
      [...(trades?.querySelectorAll("[data-flow-tape-shade]") ?? [])].map(
        (shade) => [
          shade.getAttribute("data-flow-tape-shade"),
          shade.getAttribute("width"),
        ]
      )
    ).toEqual(chart.shades.map((shade) => [shade.state, String(shade.width)]));
    const marks = [
      ...container.querySelectorAll<HTMLElement>("[data-flow-tape-mark]"),
    ];
    expect(marks.map((mark) => mark.style.left)).toEqual(
      chart.marks.map((mark) => `${mark.leftPercent}%`)
    );
    expect(marks).toHaveLength(4);
    expect(
      container
        .querySelector("[data-flow-tape-marks]")
        ?.getAttribute("aria-hidden")
    ).toBe("true");
  });

  it("shows the texts of the view-model: tape line, caption, legend, rule sentence and burst rows", async () => {
    const container = await mount(
      <FlowTapeSpeedPanel
        document={es}
        failure={null}
        refreshMs={60_000}
        symbol="ES"
      />
    );
    const chart = buildTapeSpeedChart(es);
    expect(textOf(container, "[data-flow-tape-line]")).toBe(tapeLine(es));
    expect(textOf(container, "figcaption")).toBe(tapeSpeedCaption(chart));
    expect(
      [...container.querySelectorAll("[data-flow-tape-legend]")].map(
        (entry) => entry.textContent
      )
    ).toEqual(tapeSpeedLegend(chart).map((entry) => entry.text));
    expect(textOf(container, "[data-flow-tape-rule]")).toBe(
      ruleSentence(es.rules)
    );
    const rows = [...container.querySelectorAll("[data-flow-tape-burst]")].map(
      (row) => [...row.querySelectorAll("td")].map((cell) => cell.textContent)
    );
    expect(rows).toEqual(
      burstRows(es).map((row) => [
        row.time,
        row.seconds,
        row.peakTrades,
        row.contracts,
        row.baseline,
        row.multiple,
      ])
    );
    expect(
      [...container.querySelectorAll("th")].map((cell) => cell.textContent)
    ).toEqual([
      "Time (ET)",
      "Seconds",
      "Peak trades/s",
      "Contracts",
      "Baseline",
      "Multiple",
    ]);
    // The table has a caption, and its scrolling region can be reached with the keyboard.
    const region = container.querySelector('[role="region"]');
    expect(region?.getAttribute("aria-label")).toBe("Bursts, oldest first");
    expect(region?.getAttribute("tabindex")).toBe("0");
    expect(region?.querySelector("caption")?.textContent).toBe(
      "Bursts of ES in this window, oldest first"
    );
    // Every covered second was evaluated, three bursts are all listed, and no write failed.
    expect(container.querySelector("[data-flow-tape-evaluated]")).toBeNull();
    expect(container.querySelector("[data-flow-tape-count]")).toBeNull();
    expect(container.querySelector("[data-flow-tape-fault]")).toBeNull();
    expect(container.querySelector("[data-flow-tape-empty]")).toBeNull();
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("shows a write fault, the unevaluated seconds and no burst table for the NQ fixture", async () => {
    const container = await mount(
      <FlowTapeSpeedPanel
        document={nq}
        failure={null}
        refreshMs={60_000}
        symbol="NQ"
      />
    );
    const fault = container.querySelector("[data-flow-tape-fault]");
    expect(fault?.getAttribute("role")).toBe("alert");
    // The badge names the kind; the sentence comes from the view-model.
    expect(fault?.textContent).toContain("Write fault");
    expect(fault?.querySelector(":scope > span:last-child")?.textContent).toBe(
      tapeFaultLine(nq)
    );
    expect(tapeFaultLine(nq)).toBe(
      "Per-second counts are not being stored: (PostgresError 42501)"
    );
    expect(textOf(container, "[data-flow-tape-evaluated]")).toMatch(
      /^Rule evaluated on [\d,]+ of [\d,]+ covered seconds; it needs 300 covered seconds in the 10 minutes before a second\.$/u
    );
    expect(textOf(container, "[data-flow-tape-count]")).toBe(
      "No burst in this window."
    );
    expect(container.querySelector("table")).toBeNull();
    expect(container.querySelectorAll("[data-flow-tape-mark]")).toHaveLength(0);
    expect(
      [...container.querySelectorAll("[data-flow-tape-legend]")].map((entry) =>
        entry.getAttribute("data-flow-tape-legend")
      )
    ).toEqual(["not_recorded", "after_stored"]);
  });

  it("says how many bursts the table shows when the window has more", async () => {
    const container = await mount(
      <FlowTapeSpeedPanel
        document={{ ...es, totals: { ...es.totals, bursts: 73 } }}
        failure={null}
        refreshMs={60_000}
        symbol="ES"
      />
    );
    expect(container.querySelectorAll("[data-flow-tape-burst]")).toHaveLength(
      3
    );
    expect(textOf(container, "[data-flow-tape-count]")).toBe(
      "Showing the newest 3 of 73 bursts."
    );
  });

  it("shows no legend when every bar is counted", async () => {
    const counted = es.bars.filter((bar) => bar.state === "counted");
    const container = await mount(
      <FlowTapeSpeedPanel
        document={{ ...es, bars: counted.slice(0, 6) }}
        failure={null}
        refreshMs={60_000}
        symbol="ES"
      />
    );
    expect(container.querySelectorAll("[data-flow-tape-bar]")).toHaveLength(12);
    expect(container.querySelector("[data-flow-tape-shade]")).toBeNull();
    expect(container.querySelector("[data-flow-tape-legend]")).toBeNull();
  });

  it("draws shades only and says that the window has no counts", async () => {
    const container = await mount(
      <FlowTapeSpeedPanel
        document={nothing}
        failure={null}
        refreshMs={60_000}
        symbol="NQ"
      />
    );
    expect(stateOf(container)).toBe("document");
    expect(textOf(container, "[data-flow-tape-empty]")).toBe(
      "No per-second counts in this window."
    );
    expect(container.querySelectorAll("[data-flow-tape-bar]")).toHaveLength(0);
    expect(
      container.querySelectorAll('[data-flow-tape-shade="no_data"]')
    ).toHaveLength(2);
    expect(textOf(container, "[data-flow-tape-line]")).toContain(
      "Tape NQ: never collected · no per-second counts in this window"
    );
  });
});
