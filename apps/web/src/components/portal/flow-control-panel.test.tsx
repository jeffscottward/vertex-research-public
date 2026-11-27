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
/** The sp500 document with a sampled tape in place of the streamed one. */
const sampled = {
  ...sp500,
  deepTrades: {
    ...sp500.deepTrades,
    capture: "sampled" as const,
    coverage: { seenSeconds: 558, share: 0.31, windowSeconds: 1800 },
  },
};
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
    // The state prints as words in plain text; the code stays in the attribute.
    const state = options?.querySelector("[data-flow-control-state]");
    expect(state?.textContent).toBe("Status:Buyers");
    expect(state?.getAttribute("data-plain")).toBe("true");
    expect(options?.textContent).toContain(
      "SPX options: bullish, call buying leads"
    );
    expect(options?.textContent).toContain("since ");
    expect(options?.textContent).toContain("Ratio 0.42 (enter ratio 0.30)");
    expect(options?.textContent).toContain("as of ");
    // Each freshness row is plain status text.
    const freshness = [
      ...container.querySelectorAll<HTMLElement>('li > [data-slot="badge"]'),
    ];
    expect(freshness.length).toBeGreaterThan(0);
    for (const row of freshness)
      expect(row.getAttribute("data-plain")).toBe("true");
  });

  it("keeps the warning colour on a stale freshness row", async () => {
    const { container } = await mount(
      panel({
        control: {
          ...sp500,
          freshness: sp500.freshness.map((row, index) =>
            index === 0 ? { ...row, state: "stale" as const } : row
          ),
        },
      })
    );
    const rows = [
      ...container.querySelectorAll<HTMLElement>('li > [data-slot="badge"]'),
    ];
    const stale = rows.filter(
      (row) => row.getAttribute("data-status") === "warning"
    );
    expect(stale).toHaveLength(1);
    expect(stale[0]?.getAttribute("data-plain")).toBe("true");
    expect(stale[0]?.textContent).toContain("stale");
    expect(stale[0]?.className.split(" ")).toContain("text-warning-foreground");
    for (const row of rows.filter((item) => item !== stale[0]))
      expect(row.className.split(" ")).not.toContain("text-warning-foreground");
  });

  it("shows the options, futures and agreement rows with their names, states and texts", async () => {
    const { container } = await mount(panel());
    const rows = [...container.querySelectorAll("[data-flow-control-side]")];
    expect(
      rows.map((row) => row.getAttribute("data-flow-control-side"))
    ).toEqual(["options", "futures", "agreement"]);
    expect(rows.map((row) => row.querySelector("span")?.textContent)).toEqual([
      "Options",
      "Futures",
      "Agreement",
    ]);
    const futures = rows[1];
    expect(
      futures
        ?.querySelector("[data-flow-control-state]")
        ?.getAttribute("data-flow-control-state")
    ).toBe("buyers");
    expect(futures?.textContent).toContain("ES futures: buyers in control");
    expect(futures?.textContent).toContain("since ");
    expect(futures?.textContent).toContain("Ratio 0.38 (enter ratio 0.30)");
    expect(futures?.textContent).toContain("as of ");
    expect(futures?.textContent).not.toContain("Deep-trade ratio");
    const agreement = rows[2];
    expect(
      agreement
        ?.querySelector("[data-flow-control-state]")
        ?.getAttribute("data-flow-control-state")
    ).toBe("agree");
    expect(agreement?.textContent).toContain(
      "Agree: buyers in control on both sides; ES futures and SPX options both show buyers in control (the agreement is not tested as an entry rule yet)"
    );
    expect(agreement?.textContent).toContain("since ");
    expect(agreement?.textContent).not.toContain("Ratio");
    expect(agreement?.textContent).not.toContain("as of ");
  });

  it("shows the futures detail for a hold and an agreement row that cannot compare", async () => {
    const { container } = await mount(panel({ control: nasdaq }));
    expect(
      container.querySelector('[data-flow-control-side="futures"]')?.textContent
    ).toContain(
      "NQ futures: balanced; Deep-trade ratio 0.41 over the last 30 min from 3 deep trades; enter ratio 0.30; not counted: fewer than 10 deep trades"
    );
    const agreement = container.querySelector(
      '[data-flow-control-side="agreement"]'
    );
    expect(
      agreement
        ?.querySelector("[data-flow-control-state]")
        ?.getAttribute("data-flow-control-state")
    ).toBe("not_comparable");
    expect(agreement?.textContent).toContain("Cannot compare; Options mixed");
    expect(agreement?.textContent).not.toContain("since ");
    expect(
      [...container.querySelectorAll("[data-flow-control-state]")].map(
        (item) => item.textContent
      )
    ).toEqual(["Status:Mixed", "Status:Balanced", "Status:Not comparable"]);
    expect(agreement?.textContent).not.toContain("not_comparable");
  });

  it("prints a side without data as words and names a state without a label", async () => {
    const control = {
      ...nasdaq,
      agreement: {
        ...nasdaq.agreement,
        state: "later_state" as typeof nasdaq.agreement.state,
      },
      options: { ...nasdaq.options, state: "no_data" as const },
    };
    const { container } = await mount(panel({ control }));
    const states = [...container.querySelectorAll("[data-flow-control-state]")];
    expect(states.map((item) => item.textContent)).toEqual([
      "Status:No data",
      "Status:Balanced",
      'Status:Value "later_state" has no label in this page version · reload the page',
    ]);
    expect(
      states.map((item) => item.getAttribute("data-flow-control-state"))
    ).toEqual(["no_data", "balanced", "later_state"]);
    // A state with a label prints no code. The state without a label is the stale-page message.
    for (const item of states.slice(0, 2))
      expect(item.textContent).not.toMatch(/[a-z]_[a-z]/);
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
      /^Net drift of SPX: call \$\S+, put \$\S+, call minus put \$\S+$/u
    );
    expect(chart?.querySelectorAll("polyline")).toHaveLength(3);
    expect(
      [...(chart?.querySelectorAll("polyline") ?? [])].map((line) => [
        line.getAttribute("data-flow-net-drift-line"),
        line.getAttribute("stroke-dasharray"),
      ])
    ).toEqual([
      ["call", null],
      ["put", "6 3"],
      ["difference", "2 2"],
    ]);
    expect(
      container.querySelector("[data-flow-net-drift-legend]")?.textContent
    ).toBe("CallPutCall minus put");
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
    ).toBe("Net drift of SPX: call, put and call minus put, no bucket yet");
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

  it("shows the deep trades section of a streamed tape: limit, coverage sentence, labelled sum, chart name", async () => {
    const { container } = await mount(panel());
    const section = container.querySelector('[data-flow-deep-trades="ES"]');
    expect(section?.querySelector("h3")?.textContent).toBe("Deep trades: ES");
    expect(section?.textContent).toContain(
      "A deep trade is one print of at least 40 contracts on ES."
    );
    expect(
      section?.querySelector("[data-flow-deep-coverage]")?.textContent
    ).toBe(
      "Streamed tape: 97% of seconds covered in the last 30 min (1,746 of 1,800 s); not checked against a second source."
    );
    expect(section?.textContent).toContain(
      "Sum of deep trades since 09:30 ET (streamed tape)"
    );
    expect(section?.textContent).not.toContain("sampled");
    expect(section?.textContent).not.toContain("lower bound");
    const chart = section?.querySelector("[data-flow-deep-chart]");
    expect(chart?.getAttribute("role")).toBe("img");
    expect(chart?.getAttribute("aria-label")).toMatch(
      /^Sum of deep trades: \+\d+ contracts /u
    );
    expect(chart?.querySelectorAll("polyline")).toHaveLength(3);
  });

  it("keeps the sampled words in the deep trades section of a sampled tape", async () => {
    const { container } = await mount(panel({ control: sampled }));
    const section = container.querySelector('[data-flow-deep-trades="ES"]');
    expect(
      section?.querySelector("[data-flow-deep-coverage]")?.textContent
    ).toContain("Tape seen: about 31% of seconds in the last 30 min");
    expect(section?.textContent).toContain("Every sum is a lower bound.");
    expect(section?.textContent).toContain(
      "Sum of sampled deep trades since 09:30 ET"
    );
    expect(
      section
        ?.querySelector("[data-flow-deep-chart]")
        ?.getAttribute("aria-label")
    ).toMatch(/^Sum of sampled deep trades: /u);
  });

  it("lists trades and absorption marks", async () => {
    const { container } = await mount(panel());
    const trades = container.querySelectorAll("[data-flow-deep-trade]");
    expect(trades).toHaveLength(14);
    expect(trades[0]?.textContent).toMatch(/ ET.*(Buy|Sell)/u);
    expect(container.querySelectorAll("[data-flow-absorption]")).toHaveLength(
      2
    );
    expect(container.querySelector("[data-flow-deep-empty]")).toBeNull();
    const more = await mount(
      panel({
        control: {
          ...sp500,
          deepTrades: { ...sp500.deepTrades, totalTrades: 143 },
        },
      })
    );
    expect(more.container.textContent).toContain(
      "Showing the newest 14 of 143 deep trades"
    );
  });

  it("names the deep trades table and its scroll region for assistive technology", async () => {
    const { container } = await mount(panel());
    const region = container.querySelector(
      '[data-flow-deep-trades="ES"] [role="region"]'
    );
    expect(region?.getAttribute("aria-label")).toBe(
      "Deep trades, newest first"
    );
    expect(region?.getAttribute("tabindex")).toBe("0");
    expect(region?.querySelector("caption")?.textContent).toBe(
      "Deep trades of ES, newest first"
    );
    const heads = [...(region?.querySelectorAll("th") ?? [])];
    expect(heads.map((head) => head.textContent)).toEqual([
      "Time",
      "Side",
      "Size",
      "Price",
      "Rule",
    ]);
    for (const head of heads) expect(head.getAttribute("scope")).toBe("col");
  });

  it("says that the streamed tape or the sampled tape holds no deep trade", async () => {
    const without = (control: typeof sp500) => ({
      ...control,
      deepTrades: {
        ...control.deepTrades,
        absorptions: [],
        limitSize: null,
        trades: [],
      },
    });
    const { container, rerender } = await mount(
      panel({ control: without(sp500) })
    );
    expect(container.querySelector("[data-flow-deep-empty]")?.textContent).toBe(
      "No deep trade on the streamed tape since 09:30 ET."
    );
    expect(container.querySelector("[data-flow-absorption]")).toBeNull();
    expect(container.textContent).not.toContain("A deep trade is one print");
    await rerender(panel({ control: without(sampled) }));
    expect(container.querySelector("[data-flow-deep-empty]")?.textContent).toBe(
      "No deep trade in the sampled tape since 09:30 ET."
    );
  });

  it("shows the FOMC line and the levels line", async () => {
    const { container } = await mount(panel({ control: nasdaq }));
    expect(
      container.querySelector("[data-flow-session-event]")?.textContent
    ).toBe("FOMC meeting day.");
    expect(container.querySelector("[data-flow-levels]")).toBeNull();
    const sp = await mount(panel());
    expect(sp.container.querySelector("[data-flow-session-event]")).toBeNull();
    expect(
      sp.container.querySelector("[data-flow-levels]")?.textContent
    ).toContain("SPX session (from one-minute closes");
  });
});
