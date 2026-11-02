// @vitest-environment jsdom
import type {
  BacktestGetOutput,
  BacktestResultSummaryOutput,
  ResearchPaperOutput,
} from "@darkfactory/api";
// Test-only relative import: analytics run server-side and stay out of the browser bundle.
import { computeBacktestAnalytics } from "../../../../../packages/api/src/backtest-analytics.ts";
import { evaluateAgentRatings } from "../../../../../packages/api/src/agent-rating-placebo.ts";
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

import type { BacktestsGateway, PapersGateway } from "./agent-ops-client.tsx";
import {
  BacktestsWorkspace,
  formatPercent,
  formatReported,
} from "./backtests-workspace.tsx";
import { PapersWorkspace } from "./papers-workspace.tsx";

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
const roots: Root[] = [];
const unmountAll = async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  return document.body.replaceChildren();
};
afterEach(unmountAll);

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

const clickButton = async (label: string) => {
  const button = [...document.querySelectorAll("button")].find((node) => {
    return (
      node.getAttribute("aria-label") === label ||
      node.textContent?.trim() === label
    );
  });
  if (button === undefined) throw new Error(`Missing button ${label}`);
  return await act(async () => {
    button.click();
    return await flush();
  });
};

const setValue = async (element: HTMLInputElement, value: string) => {
  return await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value"
    )!.set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    return await flush();
  });
};

const summaryRow = (
  overrides: Partial<BacktestResultSummaryOutput> = {}
): BacktestResultSummaryOutput => ({
  id: "bt-1",
  taskId: "task-1",
  paperId: null,
  strategyId: null,
  strategy: "jump-model v1",
  instruments: "SPY",
  periodStart: "2020-01-01",
  periodEnd: "2023-12-31",
  dataSource: "Yahoo adjusted closes",
  isSplit: null,
  metrics: { sharpe: 0.61, cagr: 0.084 },
  maxDrawdown: -0.2134,
  tradeCount: 2,
  notes: null,
  createdAt: at,
  pointCount: 0,
  foldCount: 1,
  taskTitle: "Backtest jump model",
  ...overrides,
});

const detailTrades = [
  {
    entry_t: "2020-02-03",
    exit_t: "2020-03-02",
    side: "long" as const,
    qty: 10,
    entry_px: 330.5,
    exit_px: 300.25,
    pnl: -302.5,
    sl: 299,
    regime: "bear",
  },
  {
    entry_t: "2020-04-01",
    exit_t: "2020-06-01",
    side: "short" as const,
    qty: 5,
    entry_px: 250,
    exit_px: 300,
    pnl: -250,
    commission: 1.25,
  },
];
const detailEquity = [
  { t: "2020-01-01", equity: 10_000 },
  { t: "2020-02-01", equity: 10_100 },
  { t: "2020-03-01", equity: 9800 },
  { t: "2020-04-01", equity: 9900 },
];

const detail = (): BacktestGetOutput => ({
  backtest: {
    ...summaryRow(),
    isSplit: {
      in_sample: {
        start: "2020-01-01",
        end: "2021-12-31",
        metrics: { sharpe: 0.9 },
      },
      out_of_sample: {
        start: "2022-01-01",
        end: "2023-12-31",
        metrics: { sharpe: 0.3 },
      },
    },
    equity: [],
    drawdown: [],
    trades: detailTrades,
    folds: [
      {
        label: "wf-1",
        train_start: "2020-01-01",
        train_end: "2021-12-31",
        test_start: "2022-01-01",
        test_end: "2022-12-31",
        metrics: { sharpe: 0.4 },
      },
    ],
    runConfig: { initialCapital: 10_000, timeframe: "1D", fillModel: "bar" },
    benchmark: null,
    ratingSeries: null,
    ratingEvaluation: null,
    analytics: computeBacktestAnalytics({
      id: "bt-1",
      equity: detailEquity,
      trades: detailTrades,
      initialCapital: 10_000,
    }),
  },
  task: {
    id: "task-1",
    kind: "backtest",
    agent: "omp",
    title: "Backtest jump model",
    summary: null,
    status: "needs_review",
    metrics: {},
    links: [],
    paperId: null,
    createdAt: at,
    updatedAt: at,
    startedAt: at,
    finishedAt: at,
  },
});

describe("backtests workspace", () => {
  it("lists reported Sharpe and CAGR, derived max drawdown, source and task link", async () => {
    const gateway: BacktestsGateway = {
      list: vi.fn(async () => [summaryRow()]),
      get: vi.fn(async () => detail()),
    };
    const container = await mount(
      <BacktestsWorkspace gateway={gateway} initialBacktestId={null} />
    );
    const row = container.querySelector('[data-backtest-id="bt-1"]')!;
    expect(row.querySelector('[data-col="sharpe"]')?.textContent).toBe("0.61");
    expect(row.querySelector('[data-col="cagr"]')?.textContent).toBe("0.084");
    expect(row.querySelector('[data-col="max-dd"]')?.textContent).toBe(
      "-21.34%"
    );
    expect(row.textContent).toContain("Yahoo adjusted closes");
    return expect(
      row.querySelector('a[href="/agents?task=task-1"]')?.textContent
    ).toBe("Backtest jump model");
  });

  it("keeps the wide results table inside a positioned scroll box", async () => {
    const gateway: BacktestsGateway = {
      list: vi.fn(async () => [summaryRow()]),
      get: vi.fn(async () => detail()),
    };
    const container = await mount(
      <BacktestsWorkspace gateway={gateway} initialBacktestId={null} />
    );
    const scroll = container.querySelector("[data-backtest-results-scroll]");
    expect(scroll?.querySelector("table th .sr-only")?.textContent).toBe(
      "Actions"
    );
    return expect(scroll?.className.split(" ")).toEqual(
      expect.arrayContaining(["relative", "overflow-x-auto"])
    );
  });

  it("opens detail with provenance, split, folds and trades", async () => {
    const gateway: BacktestsGateway = {
      list: vi.fn(async () => [summaryRow()]),
      get: vi.fn(async () => detail()),
    };
    const container = await mount(
      <BacktestsWorkspace gateway={gateway} initialBacktestId={null} />
    );
    await clickButton("Open jump-model v1");
    expect(gateway.get).toHaveBeenCalledWith("bt-1");
    const section = container.querySelector('[data-backtest-detail="bt-1"]')!;
    expect(section.textContent).toContain("Yahoo adjusted closes");
    expect(
      section.querySelector('[data-provenance="agent-reported"]')?.textContent
    ).toContain("agent-reported");
    expect(section.querySelector("[data-run-config]")?.textContent).toBe(
      "capital 10,000 · timeframe 1D · fills bar"
    );
    expect(section.textContent).toContain("No equity series reported.");
    expect(
      section.querySelector('[data-stat="Net P&L"]')?.textContent
    ).toContain("-552.5");
    expect(
      section.querySelector('[data-stat="Win rate"]')?.textContent
    ).toContain("0.0%");
    expect(window.location.search).toBe("?id=bt-1");

    await clickButton("Trades");
    expect(section.querySelectorAll("[data-trade-index]")).toHaveLength(2);
    expect(
      section.querySelector('[data-trade-index="0"]')?.textContent
    ).toContain("bear");
    expect(section.querySelector("[data-distribution]")).not.toBeNull();
    expect(window.location.search).toBe("?id=bt-1&tab=trades");

    await clickButton("Risk");
    expect(
      section.querySelector('[data-monte-carlo="bootstrap"]')
    ).not.toBeNull();
    expect(section.querySelector('[data-interval="Win rate"]')).not.toBeNull();

    await clickButton("Periods");
    expect(
      section.querySelector("[data-monthly-returns]")?.textContent
    ).toContain("2020");
    expect(section.querySelector("[data-drawdown-periods]")).not.toBeNull();

    await clickButton("Regimes");
    expect(section.querySelector("[data-regimes]")?.textContent).toContain(
      "bear"
    );

    await clickButton("Validation");
    expect(
      section.querySelector('[data-split="Out-of-sample"]')?.textContent
    ).toContain("2022-01-01");
    expect(section.querySelector('[data-fold="wf-1"]')?.textContent).toContain(
      "sharpe=0.4"
    );
    expect(section.textContent).toContain("No benchmark reported.");

    await clickButton("Close");
    return expect(window.location.search).toBe("");
  });

  it("shows the Placebo tab only when the result has a rating evaluation", async () => {
    window.history.replaceState(null, "", "/backtests?id=bt-1&tab=placebo");
    const plain: BacktestsGateway = {
      list: vi.fn(async () => []),
      get: vi.fn(async () => detail()),
    };
    const withoutSeries = await mount(
      <BacktestsWorkspace gateway={plain} initialBacktestId="bt-1" />
    );
    expect(withoutSeries.querySelector('[data-tab="placebo"]')).toBeNull();
    // A placebo link without a rating series falls back to the overview panel.
    expect(
      withoutSeries.querySelector('[role="tabpanel"]')?.getAttribute("id")
    ).toBe("backtest-panel-overview");
    await unmountAll();

    const ratingSeries = {
      symbol: "SPY",
      timeframe: "1d",
      costBps: 10,
      decisions: [
        { date: "2024-01-02", rating: "buy" as const },
        { date: "2024-01-03", rating: "sell" as const },
      ],
    };
    const rated = detail();
    rated.backtest.ratingSeries = ratingSeries;
    rated.backtest.ratingEvaluation = {
      status: "unavailable",
      reason: "no_bars",
    };
    const gateway: BacktestsGateway = {
      list: vi.fn(async () => []),
      get: vi.fn(async () => rated),
    };
    const container = await mount(
      <BacktestsWorkspace gateway={gateway} initialBacktestId="bt-1" />
    );
    expect(
      container
        .querySelector('[data-tab="placebo"]')
        ?.getAttribute("aria-selected")
    ).toBe("true");
    expect(container.querySelector('[data-placebo="no_bars"]')).not.toBeNull();
    await clickButton("Overview");
    await clickButton("Placebo");
    expect(window.location.search).toBe("?id=bt-1&tab=placebo");
    expect(container.querySelector("[data-research-notice]")?.textContent).toBe(
      "Research only. Agent ratings never place orders."
    );

    const close = Array.from({ length: 30 }, (_, index) => 100 + index);
    const ready = evaluateAgentRatings({
      bars: {
        t: Float64Array.from(close, (_, index) => Date.UTC(2024, 0, 1 + index)),
        o: Float64Array.from(close),
        c: Float64Array.from(close),
      },
      series: ratingSeries,
      seedKey: "bt-1",
    });
    const readyGateway: BacktestsGateway = {
      list: vi.fn(async () => []),
      get: vi.fn(async () => ({
        ...rated,
        backtest: { ...rated.backtest, ratingEvaluation: ready },
      })),
    };
    await unmountAll();
    const replay = await mount(
      <BacktestsWorkspace gateway={readyGateway} initialBacktestId="bt-1" />
    );
    expect(replay.querySelector('[data-placebo="ready"]')).not.toBeNull();
    expect(replay.textContent).toContain("Agents finished at the");
    window.history.replaceState(null, "", "/backtests");
  });

  it("moves between the detail tabs with the arrow, Home and End keys", async () => {
    window.history.replaceState(null, "", "/backtests?id=bt-1");
    const gateway: BacktestsGateway = {
      list: vi.fn(async () => []),
      get: vi.fn(async () => detail()),
    };
    const container = await mount(
      <BacktestsWorkspace gateway={gateway} initialBacktestId="bt-1" />
    );
    const tablist = container.querySelector('[role="tablist"]');
    if (tablist === null) throw new Error("Missing tablist");
    const press = async (key: string) => {
      const event = new KeyboardEvent("keydown", {
        key,
        bubbles: true,
        cancelable: true,
      });
      await act(async () => {
        (document.activeElement ?? tablist).dispatchEvent(event);
        return await flush();
      });
      return event.defaultPrevented;
    };
    const selected = () =>
      container
        .querySelector('[role="tab"][aria-selected="true"]')
        ?.getAttribute("data-tab");
    const focused = () => document.activeElement?.getAttribute("data-tab");
    container
      .querySelector<HTMLButtonElement>('[data-tab="overview"]')
      ?.focus();
    expect(await press("ArrowRight")).toBe(true);
    expect([selected(), focused()]).toEqual(["trades", "trades"]);
    expect(
      container.querySelector('[data-tab="trades"]')?.getAttribute("tabindex")
    ).toBe("0");
    expect(await press("End")).toBe(true);
    expect([selected(), focused()]).toEqual(["validation", "validation"]);
    expect(await press("ArrowRight")).toBe(true);
    expect([selected(), focused()]).toEqual(["overview", "overview"]);
    expect(await press("ArrowLeft")).toBe(true);
    expect([selected(), focused()]).toEqual(["validation", "validation"]);
    expect(await press("Home")).toBe(true);
    expect([selected(), focused()]).toEqual(["overview", "overview"]);
    expect(await press("Enter")).toBe(false);
    expect(selected()).toBe("overview");
    window.history.replaceState(null, "", "/backtests");
  });

  it("opens the id passed in and shows operator denial", async () => {
    const gateway: BacktestsGateway = {
      list: vi.fn(async () => []),
      get: vi.fn(async () => detail()),
    };
    await mount(
      <BacktestsWorkspace gateway={gateway} initialBacktestId="bt-1" />
    );
    expect(gateway.get).toHaveBeenCalledWith("bt-1");
    const denied: BacktestsGateway = {
      list: vi.fn(async () => {
        throw Object.assign(new Error("x"), { code: "FORBIDDEN" });
      }),
      get: vi.fn(),
    };
    const container = await mount(
      <BacktestsWorkspace gateway={denied} initialBacktestId={null} />
    );
    return expect(
      container.querySelector('[data-operator-access="required"]')
    ).not.toBeNull();
  });

  return it("formats reported and derived values without rescaling reported metrics", () => {
    expect(formatReported(null)).toBe("—");
    expect(formatReported(1.5)).toBe("1.5");
    expect(formatReported("n/a")).toBe("n/a");
    return expect(formatPercent(-0.5)).toBe("-50.00%");
  });
});

describe("papers arXiv intake", () => {
  const paper = (
    overrides: Partial<ResearchPaperOutput> = {}
  ): ResearchPaperOutput => ({
    id: "p9",
    title: "Jump model",
    authors: "Yizhan Shu",
    year: 2024,
    sourceUrl: "https://arxiv.org/abs/2402.05272v3",
    identifier: "arXiv:2402.05272v3",
    kind: "paper",
    stage: "ingested",
    verdict: "pending",
    blockers: null,
    notes: "Abstract (arXiv API): x",
    reportedMetrics: {},
    reproducedMetrics: {},
    createdAt: at,
    updatedAt: at,
    ...overrides,
  });

  it("adds from arXiv, reports duplicates and states that SSRN is manual", async () => {
    const gateway: PapersGateway = {
      list: vi.fn(async () => []),
      add: vi.fn(),
      update: vi.fn(),
      addFromArxiv: vi
        .fn()
        .mockResolvedValueOnce({ paper: paper(), created: true })
        .mockResolvedValueOnce({ paper: paper(), created: false }),
    };
    const container = await mount(<PapersWorkspace gateway={gateway} />);
    const input = document.querySelector<HTMLInputElement>(
      '[aria-label="arXiv ID or URL"]'
    )!;
    await setValue(input, " 2402.05272 ");
    await clickButton("Add from arXiv");
    expect(gateway.addFromArxiv).toHaveBeenCalledWith("2402.05272");
    expect(
      container.querySelector('[data-paper-id="p9"] [data-stage]')?.textContent
    ).toBe("Ingested");
    expect(container.textContent).toContain(
      "Added arXiv:2402.05272v3 from the arXiv API"
    );
    await setValue(input, "arXiv:2402.05272v3");
    await clickButton("Add from arXiv");
    expect(container.textContent).toContain(
      "Already listed: arXiv:2402.05272v3"
    );
    return expect(container.querySelectorAll("[data-paper-id]")).toHaveLength(
      1
    );
  });

  return it("requires input before calling the API", async () => {
    const gateway: PapersGateway = {
      list: vi.fn(async () => []),
      add: vi.fn(),
      update: vi.fn(),
      addFromArxiv: vi.fn(),
    };
    const container = await mount(<PapersWorkspace gateway={gateway} />);
    await clickButton("Add from arXiv");
    expect(gateway.addFromArxiv).not.toHaveBeenCalled();
    return expect(container.textContent).toContain(
      "arXiv ID or URL is required."
    );
  });
});
