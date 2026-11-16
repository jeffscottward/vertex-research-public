// @vitest-environment jsdom
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { LAB_NOW } from "../../lab/fixtures/core.ts";
import { labFlowControl } from "../../lab/fixtures/flow.ts";
import { FlowControlPanel } from "./flow-control-panel.tsx";

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
    rerender: (next: ReactElement) => act(async () => root.render(next)),
  };
};

const sp500 = labFlowControl("sp500");
const nasdaq = labFlowControl("nasdaq100");
const panel = (
  overrides: Partial<Parameters<typeof FlowControlPanel>[0]> = {}
) => (
  <FlowControlPanel
    control={sp500}
    failure={null}
    now={LAB_NOW}
    refreshMs={60_000}
    {...overrides}
  />
);

const select = async (element: Element | null, value: string) => {
  if (!(element instanceof HTMLSelectElement)) throw new Error("no select");
  await act(async () => {
    element.value = value;
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
};

describe("FlowControlPanel", () => {
  it("shows the three state lines with their text states and times", async () => {
    const { container } = await mount(panel());
    const options = container.querySelector(
      '[data-flow-control-side="options"]'
    );
    expect(
      options
        ?.querySelector("[data-flow-control-state]")
        ?.getAttribute("data-flow-control-state")
    ).toBe("buyers");
    expect(options?.textContent).toContain("buyers");
    expect(options?.textContent).toContain(
      "SPX options: bullish, call buying leads"
    );
    expect(options?.textContent).toContain("since ");
    expect(options?.textContent).toContain("Ratio 0.42 (enter ratio 0.30)");
    expect(options?.textContent).toContain("as of ");
  });

  it("shows one futures line that joins the not-collected label and the agreement sentence, and no agreement row", async () => {
    const { container } = await mount(panel());
    expect(container.querySelectorAll("[data-flow-control-side]")).toHaveLength(
      2
    );
    expect(
      container.querySelector('[data-flow-control-side="futures"]')?.textContent
    ).toContain(
      "Futures: deep trades not collected yet; futures and options agreement is not compared or tested"
    );
    expect(container.textContent).not.toContain("Cannot compare");
  });

  it("shows the age notice and neutral badges for an old document", async () => {
    const { container } = await mount(
      panel({ now: new Date(LAB_NOW.getTime() + 10 * 60_000) })
    );
    expect(
      container.querySelector("[data-flow-control-age]")?.textContent
    ).toBe("Data is 10 min old, refreshing");
  });

  it("shows the study line and the cross-check line", async () => {
    const { container } = await mount(panel());
    expect(
      container.querySelector("[data-flow-control-study]")?.textContent
    ).toBe("Options-side continuation rule (modelled fills): not tested yet");
    expect(
      container.querySelector("[data-flow-control-cross]")?.textContent
    ).toContain("point the same way");
    expect(container.querySelector("[data-flow-control-age]")).toBeNull();
  });

  it("starts on the primary ticker and all expiries and switches both", async () => {
    const { container } = await mount(panel());
    expect(
      container
        .querySelector("[data-flow-net-drift]")
        ?.getAttribute("data-flow-net-drift")
    ).toBe("SPX");
    await select(
      container.querySelector("[data-flow-net-drift-ticker]"),
      "SPY"
    );
    expect(
      container
        .querySelector("[data-flow-net-drift]")
        ?.getAttribute("data-flow-net-drift")
    ).toBe("SPY");
    await select(
      container.querySelector("[data-flow-net-drift-view]"),
      "zero_dte"
    );
    expect(container.textContent).not.toContain("Slope per minute");
    await select(
      container.querySelector("[data-flow-net-drift-view]"),
      "longer"
    );
    await select(container.querySelector("[data-flow-net-drift-view]"), "bad");
    expect(
      (
        container.querySelector(
          "[data-flow-net-drift-view]"
        ) as HTMLSelectElement
      ).value
    ).toBe("longer");
  });

  it("goes back to the defaults when the group changes", async () => {
    const { container, rerender } = await mount(panel());
    await select(
      container.querySelector("[data-flow-net-drift-ticker]"),
      "SPY"
    );
    await select(
      container.querySelector("[data-flow-net-drift-view]"),
      "zero_dte"
    );
    await rerender(panel({ control: nasdaq }));
    expect(
      container
        .querySelector("[data-flow-net-drift]")
        ?.getAttribute("data-flow-net-drift")
    ).toBe("QQQ");
    expect(
      (
        container.querySelector(
          "[data-flow-net-drift-view]"
        ) as HTMLSelectElement
      ).value
    ).toBe("total");
  });

  it("draws the chart and names its current value for assistive technology", async () => {
    const { container } = await mount(panel());
    const chart = container.querySelector("[data-flow-net-drift-chart]");
    expect(chart?.getAttribute("aria-label")).toMatch(
      /^Net drift of SPX: call minus put \$/u
    );
    expect(chart?.querySelectorAll("polyline")).toHaveLength(3);
    const empty = {
      ...sp500,
      netDrift: sp500.netDrift.map((series) => ({
        ...series,
        totals: { ...series.totals, total: null, zeroDte: null },
      })),
    };
    const second = await mount(panel({ control: empty }));
    expect(
      second.container
        .querySelector("[data-flow-net-drift-chart]")
        ?.getAttribute("aria-label")
    ).toBe("Net drift of SPX: call minus put no bucket yet");
    await select(
      second.container.querySelector("[data-flow-net-drift-view]"),
      "zero_dte"
    );
    const none = await mount(panel({ control: { ...sp500, netDrift: [] } }));
    expect(none.container.querySelector("[data-flow-net-drift]")).toBeNull();
  });

  it("shows the loading text before the first document", async () => {
    const { container } = await mount(panel({ control: null }));
    expect(
      container.querySelector("[data-flow-control-empty]")?.textContent
    ).toBe("Loading the control document");
  });

  it("shows a failure without a document and with an earlier document", async () => {
    const failure = { code: "STORAGE_ERROR", message: "down" };
    const { container } = await mount(panel({ control: null, failure }));
    expect(
      container.querySelector("[data-flow-control-empty]")?.textContent
    ).toBe(
      "Control document failed to load (STORAGE_ERROR: down). The next automatic refresh retries."
    );
    const earlier = await mount(panel({ failure }));
    expect(
      earlier.container.querySelector("[data-flow-control-error]")?.textContent
    ).toMatch(
      /^Refresh failed \(STORAGE_ERROR: down\)\. Showing the document of /u
    );
  });
});
