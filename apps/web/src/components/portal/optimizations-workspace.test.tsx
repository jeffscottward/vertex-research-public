// @vitest-environment jsdom
import {
  computeOptimizationAnalytics,
  type OptimizationGetOutput,
  type OptimizationRunOutput,
  type OptimizationSummaryOutput,
} from "@darkfactory/api";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import type { OptimizationsGateway } from "./agent-ops-client.tsx";
import {
  availableTabs,
  formatBinRange,
  formatMetricMap,
  formatProbability,
  heatClass,
  sortTrials,
  tabKeyTarget,
} from "./optimizations-model.ts";
import { OptimizationsWorkspace } from "./optimizations-workspace.tsx";

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
  } else testGlobal.IS_REACT_ACT_ENVIRONMENT = previousAct;
  return;
});
const roots: Root[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.replaceChildren();
  window.history.replaceState(null, "", "/");
  return;
});

const flush = async () => ({
  ...(await (async () => {
    const results = {};
    for (let i = 0; i < 20; i += 1)
      Object.assign(results, await Promise.resolve());
    return results;
  })()),
});
const at = new Date("2026-01-02T03:04:05.000Z");

const mount = async (element: ReactElement) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(element);
    return await flush();
  });
  return container;
};

const button = (
  label: string,
  scope: ParentNode = document
): HTMLButtonElement => {
  const found = [...scope.querySelectorAll("button")].find((node) => {
    return (
      node.getAttribute("aria-label") === label ||
      node.textContent?.trim() === label
    );
  });
  if (found === undefined) throw new Error(`Missing button ${label}`);
  return found;
};

const click = async (element: HTMLElement) => {
  return await act(async () => {
    element.click();
    return await flush();
  });
};

const quadratic = (a: number, b: number) =>
  10 - (a - 2) ** 2 - 0.1 * (b - 2) ** 2;

const gridTrials = (): OptimizationRunOutput["trials"] => {
  const rows: OptimizationRunOutput["trials"] = [];
  for (const a of [1, 2, 3]) {
    for (const b of [1, 2, 3]) {
      rows.push({
        index: rows.length,
        params: { a, b },
        score: quadratic(a, b),
        status: "ok",
        metrics: { sharpe: quadratic(a, b) },
      });
    }
  }
  rows.push({
    index: 9,
    params: { a: 3, b: 3 },
    score: null,
    status: "failed",
    reason: "all markets failed",
  });
  return rows;
};

const diagnostics = {
  deflatedSharpe: {
    sharpe: 0.12,
    nTrials: 9,
    sharpeVariance: 0.01,
    nObservations: 300,
    skew: 0,
    kurtosis: 3,
    expectedMaxSharpe: 0.09,
    z: 1.2,
    probability: 0.884,
  },
  deflatedSharpeReason: null,
  pbo: {
    pbo: 0.25,
    nTrials: 9,
    nPeriodsUsed: 296,
    nPartitions: 8,
    nCombinations: 70,
    metric: "sharpe" as const,
  },
  pboReason: null,
};

const run = (
  overrides: Partial<OptimizationRunOutput> = {}
): OptimizationRunOutput => {
  const base = {
    id: "opt-1",
    taskId: "task-1",
    strategyId: "s-hmm",
    strategyName: "HMM forward filter",
    method: "grid" as const,
    objectives: [{ metric: "sharpe", direction: "maximize" as const }],
    validation: {
      mode: "is_oos" as const,
      params: { nObservations: 300, isFraction: 0.7, topK: 2 },
    },
    markets: ["ES", "NQ", "CL", "GC"],
    seed: 7,
    trialCount: 10,
    stopReason: "exhausted" as const,
    best: {
      trialIndex: 4,
      params: { a: 2, b: 2 },
      score: 10,
      metrics: { sharpe: 10 },
    },
    diagnostics,
    notes: null,
    createdAt: at,
    trials: gridTrials(),
    paretoFront: [],
    folds: [],
    marketRanking: [],
    oos: {
      mode: "is_oos" as const,
      inSample: { start: 0, end: 210 },
      outOfSample: { start: 210, end: 300 },
      selected: {
        trialIndex: 4,
        params: { a: 2, b: 2 },
        inSampleScore: 10,
        score: 7.5,
        degradation: -2.5,
        status: "ok" as const,
      },
      topK: [
        {
          trialIndex: 4,
          params: { a: 2, b: 2 },
          inSampleScore: 10,
          score: 7.5,
          degradation: -2.5,
          status: "ok" as const,
        },
      ],
      reason: null,
    },
    ...overrides,
  };
  return {
    ...base,
    analytics: computeOptimizationAnalytics({
      method: base.method,
      objectives: base.objectives,
      trials: base.trials,
    }),
  };
};

const summary = (value: OptimizationRunOutput): OptimizationSummaryOutput => {
  const {
    trials,
    paretoFront,
    folds,
    marketRanking: _ranking,
    oos: _oos,
    analytics: _analytics,
    ...rest
  } = value;
  return {
    ...rest,
    storedTrialCount: trials.length,
    foldCount: folds.length,
    paretoCount: paretoFront.length,
    taskTitle: "Optimize HMM",
  };
};

const task = {
  id: "task-1",
  kind: "optimization" as const,
  agent: "omp",
  title: "Optimize HMM",
  summary: null,
  status: "succeeded" as const,
  metrics: {},
  links: [],
  paperId: null,
  createdAt: at,
  updatedAt: at,
  startedAt: at,
  finishedAt: at,
};

const gatewayWith = (
  runs: OptimizationRunOutput[] = [run()]
): OptimizationsGateway & {
  [K in keyof OptimizationsGateway]: ReturnType<typeof vi.fn>;
} => {
  return {
    list: vi.fn(async () => runs.map(summary)),
    get: vi.fn(async (id: string): Promise<OptimizationGetOutput> => {
      const found = runs.find((row) => row.id === id);
      if (found === undefined) throw new Error("Record not found");
      return { optimization: found, task };
    }),
  } as unknown as OptimizationsGateway & {
    [K in keyof OptimizationsGateway]: ReturnType<typeof vi.fn>;
  };
};

describe("optimization view helpers", () => {
  it("sorts trials by score for the run direction with missing scores last, and filters status", () => {
    const trials = [
      { index: 0, score: 1, status: "ok" as const },
      { index: 1, score: null, status: "failed" as const },
      { index: 2, score: 3, status: "ok" as const },
      { index: 3, score: 2, status: "ok" as const },
    ];
    expect(
      sortTrials(trials, "maximize", "best", "all").map((trial) => trial.index)
    ).toEqual([2, 3, 0, 1]);
    expect(
      sortTrials(trials, "minimize", "best", "all").map((trial) => trial.index)
    ).toEqual([0, 3, 2, 1]);
    expect(
      sortTrials(trials, "maximize", "worst", "ok").map((trial) => trial.index)
    ).toEqual([0, 3, 2]);
    return expect(
      sortTrials(trials, "maximize", "index", "failed").map(
        (trial) => trial.index
      )
    ).toEqual([1]);
  });

  it("offers Pareto and Folds tabs only when they apply and cycles tabs by keyboard", () => {
    expect(
      availableTabs({
        method: "grid",
        validation: { mode: "single", params: {} },
      })
    ).toEqual(["overview", "trials", "importance", "profiles"]);
    expect(
      availableTabs({
        method: "pareto",
        validation: { mode: "single", params: {} },
      })
    ).toContain("pareto");
    expect(
      availableTabs({
        method: "tpe",
        validation: { mode: "walk_forward", params: {} },
      })
    ).toContain("folds");
    const tabs = ["overview", "trials", "importance", "profiles"] as const;
    expect(tabKeyTarget("ArrowRight", "profiles", tabs)).toBe("overview");
    expect(tabKeyTarget("ArrowLeft", "overview", tabs)).toBe("profiles");
    expect(tabKeyTarget("End", "overview", tabs)).toBe("profiles");
    return expect(tabKeyTarget("Enter", "overview", tabs)).toBeNull();
  });

  return it("shades better cells darker for the run direction and formats bins", () => {
    expect(heatClass(10, 0, 10, "maximize")).toBe("bg-primary/60");
    expect(heatClass(10, 0, 10, "minimize")).toBe("bg-primary/5");
    expect(heatClass(null, 0, 10, "maximize")).toBe("");
    expect(formatBinRange({ low: 2, high: 2 })).toBe("2");
    expect(formatBinRange({ low: 0.5, high: 1.25 })).toBe("0.5 – 1.25");
    expect(formatProbability(2.4e-7)).toBe("<0.1%");
    expect(formatProbability(0.999_99)).toBe(">99.9%");
    expect(formatProbability(0)).toBe("0.0%");
    return expect(formatMetricMap({ sharpe: 2.056_250_000_000_000_4 })).toBe(
      "sharpe=2.0563"
    );
  });
});

describe("optimizations workspace", () => {
  it("lists runs with method, markets, validation, trials, best score, DSR and PBO", async () => {
    const container = await mount(
      <OptimizationsWorkspace
        gateway={gatewayWith()}
        initialOptimizationId={null}
        initialStrategyId={null}
      />
    );
    const row = container.querySelector('[data-optimization-id="opt-1"]')!;
    expect(row.querySelector("th")?.textContent).toContain(
      "HMM forward filter"
    );
    expect(row.querySelector('[data-col="method"]')?.textContent).toBe("Grid");
    expect(row.querySelector('[data-col="markets"]')?.textContent).toBe(
      "ES, NQ, CL +1"
    );
    expect(row.querySelector('[data-col="validation"]')?.textContent).toBe(
      "IS / OOS"
    );
    expect(row.querySelector('[data-col="trials"]')?.textContent).toBe("10");
    expect(row.querySelector('[data-col="best"]')?.textContent).toBe("10");
    expect(row.querySelector('[data-col="dsr"]')?.textContent).toBe("88.4%");
    return expect(row.querySelector('[data-col="pbo"]')?.textContent).toBe(
      "25.0%"
    );
  });

  it("shows the operator notice instead of the runs when the API answers FORBIDDEN", async () => {
    const gateway = gatewayWith();
    gateway.list.mockRejectedValueOnce(
      Object.assign(new Error("x"), { code: "FORBIDDEN" })
    );
    const container = await mount(
      <OptimizationsWorkspace
        gateway={gateway}
        initialOptimizationId={null}
        initialStrategyId={null}
      />
    );
    expect(
      container
        .querySelector('[data-operator-access="required"]')
        ?.getAttribute("data-operator-feature")
    ).toBe("optimizations");
    return expect(container.querySelector("[data-optimization-id]")).toBeNull();
  });

  it("filters by strategy from ?strategy= and shows a reset link", async () => {
    window.history.replaceState(null, "", "/optimizations?strategy=s-hmm");
    const gateway = gatewayWith();
    const container = await mount(
      <OptimizationsWorkspace gateway={gateway} initialOptimizationId={null} />
    );
    expect(gateway.list).toHaveBeenCalledWith({ strategyId: "s-hmm" });
    return expect(
      container
        .querySelector('[data-strategy-filter="s-hmm"] a')
        ?.getAttribute("href")
    ).toBe("/optimizations");
  });

  it("opens a run on Overview with best params, copyable JSON, OOS report and diagnostics", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const container = await mount(
      <OptimizationsWorkspace
        gateway={gatewayWith()}
        initialOptimizationId={null}
        initialStrategyId={null}
      />
    );
    await click(button("Open HMM forward filter"));
    expect(window.location.search).toBe("?id=opt-1");
    const detail = container.querySelector(
      '[data-optimization-detail="opt-1"]'
    )!;
    expect(
      [...detail.querySelectorAll('[role="tab"]')].map(
        (node) => node.textContent
      )
    ).toEqual(["Overview", "Trials", "Importance", "Profiles"]);
    expect(
      [...detail.querySelectorAll("[data-best-params] tbody tr")].map(
        (node) => node.textContent
      )
    ).toEqual(["a2", "b2"]);
    expect(detail.querySelector("[data-best-json]")?.textContent).toBe(
      '{\n  "a": 2,\n  "b": 2\n}'
    );
    await click(button("Copy best parameters as JSON"));
    expect(writeText).toHaveBeenCalledWith('{\n  "a": 2,\n  "b": 2\n}');
    expect(
      detail.querySelector('[data-oos-row="Selected"]')?.textContent
    ).toContain("7.5");
    expect(
      detail.querySelector('[data-stat="Probability"] dd')?.textContent
    ).toBe("88.4%");
    expect(detail.querySelector('[data-stat="PBO"] dd')?.textContent).toBe(
      "25.0%"
    );
    return expect(
      detail.querySelector('[data-stat="Trials"] dd')?.textContent
    ).toBe("10 / 10 · 9 ok");
  });

  it("restores a deep link to a tab and keeps the address bar in sync with keyboard tab changes", async () => {
    window.history.replaceState(
      null,
      "",
      "/optimizations?id=opt-1&tab=importance"
    );
    const container = await mount(
      <OptimizationsWorkspace gateway={gatewayWith()} />
    );
    const selected = container.querySelector(
      '[role="tab"][aria-selected="true"]'
    )!;
    expect(selected.getAttribute("data-tab")).toBe("importance");
    expect(
      [...container.querySelectorAll("[data-importance]")].map((node) =>
        node.getAttribute("data-importance")
      )
    ).toEqual(["a", "b"]);
    expect(
      container.querySelector('[data-importance="a"]')?.textContent
    ).toContain("99.0%");
    const tablist = container.querySelector('[role="tablist"]')!;
    await act(async () => {
      tablist.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })
      );
      return await flush();
    });
    expect(
      container
        .querySelector('[role="tab"][aria-selected="true"]')
        ?.getAttribute("data-tab")
    ).toBe("profiles");
    expect(document.activeElement?.id).toBe("optimization-tab-profiles");
    expect(window.location.search).toBe("?id=opt-1&tab=profiles");
    expect(container.querySelectorAll("[data-profile]")).toHaveLength(2);
    expect(
      container.querySelector('[data-heatmap] [data-cell="1-1"]')?.textContent
    ).toBe("10");
    return expect(
      container.querySelector('[data-heatmap] [data-cell="1-1"]')?.className
    ).toContain("bg-primary/60");
  });

  it("sorts trials by score from the header and filters failed trials", async () => {
    window.history.replaceState(null, "", "/optimizations?id=opt-1&tab=trials");
    const container = await mount(
      <OptimizationsWorkspace gateway={gatewayWith()} />
    );
    const indices = () =>
      [...container.querySelectorAll("[data-trial-index]")].map((node) =>
        node.getAttribute("data-trial-index")
      );
    expect(indices()[0]).toBe("4");
    expect(indices().at(-1)).toBe("9");
    await click(
      container.querySelector<HTMLButtonElement>("[data-sort-score]")!
    );
    expect(
      container.querySelector("th[aria-sort]")?.getAttribute("aria-sort")
    ).toBe("ascending");
    expect(indices()[0]).toBe("0");
    const select = container.querySelector<HTMLSelectElement>(
      '[aria-label="Trial status filter"]'
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLSelectElement.prototype,
        "value"
      )!.set!.call(select, "failed");
      select.dispatchEvent(new Event("change", { bubbles: true }));
      return await flush();
    });
    expect(indices()).toEqual(["9"]);
    return expect(
      container.querySelector("[data-trial-index='9']")?.textContent
    ).toContain("all markets failed");
  });

  it("shows the Pareto front for Pareto runs and walk-forward folds for walk-forward runs", async () => {
    const pareto = run({
      id: "opt-p",
      method: "pareto",
      best: null,
      oos: null,
      diagnostics: null,
      objectives: [
        { metric: "sharpe", direction: "maximize" },
        { metric: "dd", direction: "minimize" },
      ],
      validation: { mode: "single", params: { nObservations: 300 } },
      paretoFront: [
        {
          trialIndex: 2,
          params: { a: 1, b: 3 },
          values: { sharpe: 1.4, dd: 0.12 },
        },
      ],
    });
    const walk = run({
      id: "opt-w",
      validation: {
        mode: "walk_forward",
        params: { nObservations: 300, trainLength: 100, testLength: 50 },
      },
      oos: {
        mode: "walk_forward",
        stitchedScore: 0.8,
        stitchedMetrics: { ES: { sharpe: 0.8 } },
        droppedMarkets: [],
        reason: null,
      },
      folds: [
        {
          index: 0,
          train: { start: 0, end: 100 },
          test: { start: 100, end: 150 },
          seed: 7,
          stopReason: "budget",
          trialCount: 5,
          bestTrialIndex: 4,
          params: { a: 2, b: 2 },
          oos: {
            trialIndex: 4,
            params: { a: 2, b: 2 },
            inSampleScore: 10,
            score: 6,
            degradation: -4,
            status: "ok",
          },
          diagnostics,
        },
      ],
    });
    const gateway = gatewayWith([pareto, walk]);
    window.history.replaceState(null, "", "/optimizations?id=opt-p&tab=pareto");
    const container = await mount(<OptimizationsWorkspace gateway={gateway} />);
    expect(
      container.querySelector('[data-pareto-trial="2"]')?.textContent
    ).toContain("1.4");
    expect(
      container.querySelector('[role="tab"][data-tab="folds"]')
    ).toBeNull();
    await click(button("Close"));
    await click(
      button(
        "Open HMM forward filter",
        container.querySelector('[data-optimization-id="opt-w"]')!
      )
    );
    await click(
      container.querySelector<HTMLButtonElement>(
        '[role="tab"][data-tab="folds"]'
      )!
    );
    const fold = container.querySelector('[data-fold="0"]')!;
    expect(fold.textContent).toContain("[0, 100)");
    expect(fold.textContent).toContain("a=2, b=2");
    expect(fold.textContent).toContain("88.4%");
    return expect(window.location.search).toBe("?id=opt-w&tab=folds");
  });

  return it("falls back to Overview when a deep-linked tab does not apply and surfaces load errors", async () => {
    window.history.replaceState(null, "", "/optimizations?id=opt-1&tab=pareto");
    const container = await mount(
      <OptimizationsWorkspace gateway={gatewayWith()} />
    );
    expect(
      container
        .querySelector('[role="tab"][aria-selected="true"]')
        ?.getAttribute("data-tab")
    ).toBe("overview");
    const failing = gatewayWith();
    failing.list.mockRejectedValueOnce(new Error("boom"));
    const errored = await mount(
      <OptimizationsWorkspace
        gateway={failing}
        initialOptimizationId="missing"
        initialStrategyId={null}
      />
    );
    return expect(errored.querySelectorAll('[role="alert"]').length).toBe(2);
  });
});
