// @vitest-environment jsdom
import type { StrategyGetOutput } from "@darkfactory/api";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { StrategyLibraryGateway } from "./agent-ops-client.tsx";
import { StrategyDetail } from "./strategy-library-detail.tsx";
import type { StrategyTab } from "./strategy-library-model.ts";

// Strategy library detail: overview edits, tab keys, the parameter and preset editors and the
// backtest table, mounted directly (the workspace tests cover loading and routing).

const testGlobal: typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean } =
  globalThis;
const roots: Root[] = [];
beforeAll(() => {
  testGlobal.IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

const mount = async (element: ReactElement) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(element));
  return container;
};
const setValue = async (
  element: HTMLInputElement | HTMLTextAreaElement,
  value: string
) => {
  const prototype =
    element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(
      element,
      value
    );
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
// A submit event skips the browser's own constraint checks, so the form's checks run.
const submit = async (form: HTMLFormElement) => {
  await act(async () => {
    form.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true })
    );
  });
};
const click = async (element: Element) => {
  await act(async () => {
    (element as HTMLElement).click();
  });
};
const buttonLabeled = (label: string) =>
  document.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement;

const at = new Date("2026-11-08T12:00:00.000Z");
const strategy = (
  overrides: Partial<StrategyGetOutput["strategy"]> = {}
): StrategyGetOutput["strategy"] => ({
  backtestCount: 0,
  createdAt: at,
  description: null,
  favorite: false,
  id: "s-1",
  kind: "python",
  latestBacktest: null,
  vertexStudy: null,
  name: "Trend",
  params: [],
  presetCount: 0,
  priority: "normal",
  externalValidation: null,
  section: null,
  slug: "trend",
  sourceRef: null,
  status: "idea",
  tags: [],
  updatedAt: at,
  ...overrides,
});
// A third party's claim, in the shape migration 0065 stores for the volume spike breakout row.
const CLAIM = {
  claimedMethod:
    "10,500 strategies ranked by total net R with no correction for the number of strategies tried.",
  claimedMetrics: [
    { label: "Rank", value: "1 of 10,500 by total net R" },
    { label: "Win rate", value: "14%" },
    { label: "Win rate", value: "out-of-sample 17%" },
  ],
  publishedOn: "2026-09-24",
  sourceAuthor: "Lil Fish (@not_a_lil_fish), YouTube",
  sourceTitle: "I Backtested 10,000 Strategies",
  sourceUrl: "https://youtu.be/XLMG6-SATRk",
};
const badgeKeys = (container: Element) =>
  [...container.querySelectorAll("[data-strategy-badge]")].map((badge) => [
    badge.getAttribute("data-strategy-badge"),
    badge.textContent,
  ]);
const LOOKBACK = {
  default: 20,
  max: 250,
  min: 5,
  name: "lookback",
  step: 1,
  title: "Lookback",
  type: "integer" as const,
};
const PRESET = {
  createdAt: at,
  id: "p-1",
  name: "fast",
  strategyId: "s-1",
  updatedAt: at,
  values: { lookback: 10 },
};

const gatewayOf = (
  overrides: Partial<StrategyLibraryGateway> = {}
): StrategyLibraryGateway => ({
  create: vi.fn(),
  get: vi.fn(),
  list: vi.fn(),
  removePreset: vi.fn(async () => undefined),
  savePreset: vi.fn(async (input) => ({ ...PRESET, name: input.name })),
  update: vi.fn(async () => strategy()),
  ...overrides,
});

const detailOf = ({
  detail = { backtests: [], presets: [], strategy: strategy() },
  gateway = gatewayOf(),
  onTab = vi.fn(),
  tab = "overview",
}: Readonly<{
  detail?: StrategyGetOutput;
  gateway?: StrategyLibraryGateway;
  onTab?: (tab: StrategyTab) => void;
  tab?: StrategyTab;
}> = {}) => (
  <StrategyDetail
    describeFailure={(error) => `failed: ${String(error)}`}
    detail={detail}
    gateway={gateway}
    onChanged={async () => undefined}
    onClose={() => undefined}
    onTab={onTab}
    researchStudies={{ get: async () => Promise.reject(new Error("none")) }}
    tab={tab}
  />
);

describe("StrategyDetail", () => {
  it("edits every overview field and reports a failed save", async () => {
    const gateway = gatewayOf({
      update: vi.fn(async () => Promise.reject("offline")),
    });
    const container = await mount(
      detailOf({
        detail: {
          backtests: [],
          presets: [],
          strategy: strategy({ kind: "lab" as never }),
        },
        gateway,
      })
    );
    // An unknown kind is shown as stored, in the header and the overview.
    expect(container.querySelector("p")?.textContent).toContain("lab");
    expect(container.querySelector("dl dd")?.textContent).toBe("lab");
    const form = container.querySelector(
      "[data-strategy-overview-form]"
    ) as HTMLFormElement;
    const [name, section, tags, sourceRef] = [
      ...form.querySelectorAll("input"),
    ] as HTMLInputElement[];
    await setValue(name as HTMLInputElement, "Trend v2");
    await setValue(section as HTMLInputElement, "Momentum");
    await setValue(tags as HTMLInputElement, "a, b");
    await setValue(sourceRef as HTMLInputElement, "services/x.py");
    await setValue(
      form.querySelector("textarea") as HTMLTextAreaElement,
      "Notes"
    );
    await submit(form);
    expect(gateway.update).toHaveBeenCalledWith({
      description: "Notes",
      id: "s-1",
      name: "Trend v2",
      section: "Momentum",
      sourceRef: "services/x.py",
      status: "idea",
      tags: ["a", "b"],
    });
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "failed: offline"
    );
  });

  it("shows both badges and the external claim as the source's claim, with no arm, order or deploy control", async () => {
    const claimed = strategy({
      externalValidation: CLAIM,
      id: "strategy-seed-volume-spike-breakout",
      priority: "high",
      slug: "volume-spike-breakout",
      status: "backtested",
      tags: ["research-only", "backtest-study", "externally-pre-validated"],
      vertexStudy: { kind: "strategy-backtest", verdict: "no-edge" },
    });
    const container = await mount(
      detailOf({ detail: { backtests: [], presets: [], strategy: claimed } })
    );
    // The header shows Vertex's own study result before the source's claim.
    expect(badgeKeys(container)).toEqual([
      ["high-priority", "High priority"],
      [
        "vertex-result",
        "Vertex study: No edge (Vertex research result, not a trading signal)",
      ],
      [
        "externally-pre-validated",
        "Externally pre-validated (source claim, not validated by Vertex)",
      ],
    ]);
    expect(
      container
        .querySelector('[data-strategy-badge="externally-pre-validated"]')
        ?.getAttribute("title")
    ).toContain("not a Vertex validation");
    expect(
      container.querySelector('[data-strategy-priority="high"]')?.textContent
    ).toBe("High priority");
    expect(
      container.querySelector("[data-strategy-external-validation]")
        ?.textContent
    ).toBe("Externally pre-validated (source claim, not validated by Vertex)");
    // Visible text is the label alone; screen readers also hear that it is a claim (not via title).
    const external = container.querySelector(
      "[data-strategy-external-validation]"
    ) as HTMLElement;
    const srOnly = external.querySelector("span.sr-only") as HTMLElement;
    expect(srOnly.textContent).toBe(" (source claim, not validated by Vertex)");
    expect(
      [...external.childNodes]
        .filter((node) => node !== srOnly)
        .map((node) => node.textContent)
        .join("")
    ).toBe("Externally pre-validated");
    expect(external.getAttribute("title")).toBe(
      "A third party published a backtest of this strategy. This is the source's claim, not a Vertex validation."
    );
    expect(
      container.querySelector('[data-strategy-priority="high"] .sr-only')
    ).toBeNull();
    const block = container.querySelector(
      '[data-strategy-external-claim="strategy-seed-volume-spike-breakout"]'
    ) as HTMLElement;
    expect(block.querySelector("h3")?.textContent).toBe(
      "External claim (not validated by Vertex)"
    );
    expect(block.getAttribute("aria-labelledby")).toBe(
      block.querySelector("h3")?.id
    );
    const link = block.querySelector(
      "[data-strategy-external-claim-source]"
    ) as HTMLAnchorElement;
    expect(link.textContent).toBe("I Backtested 10,000 Strategies");
    expect(link.getAttribute("href")).toBe("https://youtu.be/XLMG6-SATRk");
    expect(link.getAttribute("rel")).toBe("noreferrer noopener");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(
      block.querySelector("[data-external-claim-author]")?.textContent
    ).toBe("Lil Fish (@not_a_lil_fish), YouTube");
    expect(
      block.querySelector("[data-external-claim-published] time")?.textContent
    ).toBe("2026-09-24");
    expect(
      block
        .querySelector("[data-external-claim-published] time")
        ?.getAttribute("datetime")
    ).toBe("2026-09-24");
    expect(
      block.querySelector("[data-external-claim-method]")?.textContent
    ).toBe(CLAIM.claimedMethod);
    const metrics = block.querySelector(
      "[data-external-claim-metrics]"
    ) as HTMLElement;
    expect(
      [...metrics.querySelectorAll("dt")].map((term) => term.textContent)
    ).toEqual(["Rank", "Win rate", "Win rate"]);
    expect(
      [...metrics.querySelectorAll("dd")].map((value) => value.textContent)
    ).toEqual(["1 of 10,500 by total net R", "14%", "out-of-sample 17%"]);
    expect(
      block.querySelector("[data-external-claim-notice]")?.textContent
    ).toBe(
      "This is the source's claim. Vertex shows its own test result on the Backtests tab. A strategy counts as validated by Vertex only after the Vertex replication and gates pass."
    );
    // Research only: the notice stays and no deployment, order or arm control exists anywhere.
    expect(
      container.querySelector(
        '[data-strategy-research-only="strategy-seed-volume-spike-breakout"]'
      )?.textContent
    ).toBe("Research only: no deployment");
    expect(
      container.querySelector("[data-strategy-request-deployment]")
    ).toBeNull();
    expect(
      container.querySelector("[data-strategy-academy-lesson]")
    ).toBeNull();
    const controls = [
      ...container.querySelectorAll("button, a, input, select, textarea"),
    ].map((control) =>
      `${control.textContent} ${control.getAttribute("aria-label") ?? ""} ${control.getAttribute("href") ?? ""}`.toLowerCase()
    );
    expect(controls.length).toBeGreaterThan(0);
    for (const control of controls)
      expect(control).not.toMatch(/\b(arm|order|deploy\w*|go live|trade)\b/u);
    return expect(block.querySelectorAll("button, input, select")).toHaveLength(
      0
    );
  });

  it("shows no badge and no claim block for a normal-priority strategy without an external claim", async () => {
    const container = await mount(detailOf());
    expect(container.querySelector("[data-strategy-badges]")).toBeNull();
    expect(container.querySelector("[data-strategy-priority]")).toBeNull();
    expect(
      container.querySelector("[data-strategy-external-validation]")
    ).toBeNull();
    expect(
      container.querySelector("[data-strategy-external-claim]")
    ).toBeNull();
    expect(container.textContent).not.toContain("High priority");
    expect(container.textContent).not.toContain("pre-validated");
    return expect(container.textContent).not.toContain("External claim");
  });

  it("shows each badge on its own: priority alone, and a claim alone", async () => {
    const high = await mount(
      detailOf({
        detail: {
          backtests: [],
          presets: [],
          strategy: strategy({ priority: "high" }),
        },
      })
    );
    expect(badgeKeys(high)).toEqual([["high-priority", "High priority"]]);
    expect(high.querySelector("[data-strategy-external-claim]")).toBeNull();
    // Not tagged research-only: the claim adds no control and changes none.
    expect(
      high.querySelectorAll("[data-strategy-request-deployment]")
    ).toHaveLength(1);
    const claimed = await mount(
      detailOf({
        detail: {
          backtests: [],
          presets: [],
          strategy: strategy({ externalValidation: CLAIM }),
        },
      })
    );
    expect(badgeKeys(claimed)).toEqual([
      [
        "externally-pre-validated",
        "Externally pre-validated (source claim, not validated by Vertex)",
      ],
    ]);
    expect(
      claimed.querySelectorAll("[data-strategy-external-claim]")
    ).toHaveLength(1);
    const parameters = await mount(
      detailOf({
        detail: {
          backtests: [],
          presets: [],
          strategy: strategy({ externalValidation: CLAIM }),
        },
        tab: "parameters",
      })
    );
    // The claim block belongs to the Overview tab; the header badge stays on every tab.
    expect(
      parameters.querySelector("[data-strategy-external-claim]")
    ).toBeNull();
    return expect(badgeKeys(parameters)).toHaveLength(1);
  });

  it("moves between tabs with the arrow, Home and End keys and by click", async () => {
    const onTab = vi.fn();
    const container = await mount(detailOf({ onTab }));
    const tablist = container.querySelector('[role="tablist"]') as HTMLElement;
    const press = async (key: string) =>
      act(async () => {
        tablist.dispatchEvent(
          new KeyboardEvent("keydown", { bubbles: true, key })
        );
      });
    for (const key of ["ArrowRight", "ArrowLeft", "Home", "End", "a"])
      await press(key);
    expect(onTab.mock.calls).toEqual([
      ["parameters"],
      ["backtests"],
      ["overview"],
      ["backtests"],
    ]);
    await click(
      container.querySelector('[data-tab="parameters"]') as HTMLElement
    );
    expect(onTab).toHaveBeenLastCalledWith("parameters");
  });

  it("shows empty parameter and preset editors", async () => {
    const container = await mount(detailOf({ tab: "parameters" }));
    expect(container.textContent).toContain("No parameters.");
    expect(container.textContent).toContain("Define parameters first.");
  });

  it("rejects invalid preset values and reports preset write failures", async () => {
    const gateway = gatewayOf({
      removePreset: vi.fn(async () => Promise.reject("locked")),
      savePreset: vi.fn(async () => Promise.reject("busy")),
    });
    const container = await mount(
      detailOf({
        detail: {
          backtests: [],
          presets: [PRESET],
          strategy: strategy({ params: [LOOKBACK] }),
        },
        gateway,
        tab: "parameters",
      })
    );
    const form = container.querySelector(
      "[data-preset-form]"
    ) as HTMLFormElement;
    await setValue(
      form.querySelector("input:not([id])") as HTMLInputElement,
      "slow"
    );
    await setValue(
      form.querySelector("#preset-param-lookback") as HTMLInputElement,
      "1.5"
    );
    await submit(form);
    expect(container.textContent).toContain("Lookback must be a whole number.");
    expect(gateway.savePreset).not.toHaveBeenCalled();
    await setValue(
      form.querySelector("#preset-param-lookback") as HTMLInputElement,
      "30"
    );
    await submit(form);
    expect(container.textContent).toContain("failed: busy");
    await click(buttonLabeled("Delete fast"));
    expect(container.textContent).toContain("failed: locked");
  });

  it("copies presets, shows the text when the clipboard fails and clears it on delete", async () => {
    const writeText = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("denied"));
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const gateway = gatewayOf();
    const container = await mount(
      detailOf({
        detail: {
          backtests: [],
          presets: [PRESET, { ...PRESET, id: "p-2", name: "slow" }],
          strategy: strategy({ params: [LOOKBACK] }),
        },
        gateway,
        tab: "parameters",
      })
    );
    await click(buttonLabeled("Copy slow"));
    expect(container.textContent).toContain("Copied preset slow.");
    await click(buttonLabeled("Copy fast"));
    expect(writeText).toHaveBeenLastCalledWith(
      "# trend preset fast\nlookback=10"
    );
    expect(container.textContent).toContain(
      "Clipboard unavailable; preset fast text is shown below."
    );
    expect(
      container.querySelector('[data-preset-export="fast"]')
    ).not.toBeNull();
    // Deleting another preset keeps the shown text; deleting this one clears it.
    await click(buttonLabeled("Delete slow"));
    expect(
      container.querySelector('[data-preset-export="fast"]')
    ).not.toBeNull();
    await click(buttonLabeled("Delete fast"));
    expect(container.querySelector("[data-preset-export]")).toBeNull();
    expect(gateway.removePreset).toHaveBeenLastCalledWith("s-1", "p-1");
  });

  it("names a linked backtest by its task id when it has no task title", async () => {
    const container = await mount(
      detailOf({
        detail: {
          backtests: [
            {
              createdAt: at,
              dataSource: "fixture",
              foldCount: 0,
              id: "bt-1",
              instruments: "SPY",
              isSplit: null,
              maxDrawdown: -0.08,
              metrics: { sharpe: 0.7 },
              notes: null,
              paperId: null,
              periodEnd: "2020-12-31",
              periodStart: "2020-01-01",
              pointCount: 10,
              strategy: "trend v1",
              strategyId: "s-1",
              taskId: "task-1",
              taskTitle: null,
              tradeCount: 3,
            },
          ],
          presets: [],
          strategy: strategy(),
        },
        tab: "backtests",
      })
    );
    expect(container.querySelector("tbody tr")?.textContent).toContain(
      "task-1"
    );
  });
});
