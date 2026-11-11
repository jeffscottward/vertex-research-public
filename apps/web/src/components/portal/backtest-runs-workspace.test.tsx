// @vitest-environment jsdom
import {
  type BacktestRun,
  type BacktestRunReportOutput,
  type InstantBacktestSeries,
  OPTIONS_EXIT_REASONS,
  STRATEGY_OPTION_SYMBOLS,
  STRATEGY_TEMPLATES,
  type StrategyDefinitionGetOutput,
  StrategyDefinitionSchema,
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

import {
  COST_PROFILE_OPTIONS,
  costRows,
  definitionRunHref,
  definitionSeries,
  describeLinkedDefinition,
  describeRevision,
  describeUniverseBatch,
  describeUniversePlan,
  EXIT_REASON_LABELS,
  exitReasonLabel,
  isCostProfilePresetId,
  isCalendarDate,
  isFinished,
  isNotFound,
  isoDate,
  type LinkedDefinition,
  latestSucceededRunId,
  loadLinkedDefinition,
  metricRows,
  type OptionsBook,
  optionsLinkSymbol,
  optionsDefaultFrom,
  optionsMetricRows,
  optionsRunSymbols,
  optionsSignalRows,
  optionTradesHeading,
  pickInitialRunId,
  readDefinitionLink,
  replayGeometry,
  ruleSwitchDates,
  runsOptionsDefinition,
  todayUtc,
  toSubmitInput,
  toUniverseSubmitInputs,
} from "./backtest-runs-model.ts";
import {
  type BacktestRunsGateway,
  BacktestRunsWorkspace,
  createBacktestRunsGateway,
  createBrowserBacktestRunsGateway,
} from "./backtest-runs-workspace.tsx";
import { DEFAULT_INSTANT_PARAMS } from "./instant-backtest-workspace.tsx";

vi.mock("../../features/charts/backtest-series.tsx", () => ({
  BacktestSeriesChart: ({
    points,
    caption,
  }: {
    points: readonly unknown[];
    caption: string;
  }) => <figure data-points={points.length}>{caption}</figure>,
}));

const testGlobal = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
const previousAct = testGlobal.IS_REACT_ACT_ENVIRONMENT;
beforeAll(() => {
  testGlobal.IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  if (previousAct === undefined) delete testGlobal.IS_REACT_ACT_ENVIRONMENT;
  else testGlobal.IS_REACT_ACT_ENVIRONMENT = previousAct;
});
const roots: Root[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.replaceChildren();
  window.history.replaceState(null, "", "/");
  vi.useRealTimers();
});

const flush = async () => {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
};
const settle = async (work: () => void) => {
  await act(async () => {
    work();
    await flush();
  });
};
const mount = async (element: ReactElement) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await settle(() => root.render(element));
  return container;
};
const setNative = async (
  element: HTMLInputElement | HTMLSelectElement,
  value: string
) => {
  const prototype =
    element instanceof HTMLSelectElement
      ? HTMLSelectElement.prototype
      : HTMLInputElement.prototype;
  await settle(() => {
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(
      element,
      value
    );
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
};
const field = (label: string) => {
  const target = [...document.querySelectorAll("label")].find(
    (node) => node.textContent === label
  );
  return document.getElementById(
    target?.getAttribute("for") ?? ""
  ) as HTMLInputElement & HTMLSelectElement;
};
const button = (text: string) =>
  [...document.querySelectorAll("button")].find(
    (node) => node.textContent === text
  ) as HTMLButtonElement;

// Promise.withResolvers is outside this package's TypeScript lib target.
const deferred = <T,>() => {
  let resolve: (value: T) => void = () => undefined;
  let reject: (reason: unknown) => void = () => undefined;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, reject, resolve };
};

const DAY_MS = 86_400_000;
const SPY: InstantBacktestSeries = {
  barCount: 100,
  firstT: 0,
  importedAt: "2026-10-18T00:00:00.000Z",
  lastT: 99 * DAY_MS,
  source: "Test daily source",
  sourceSha256: "e".repeat(64),
  symbol: "SPY",
  timeframe: "1d",
};
const ES: InstantBacktestSeries = { ...SPY, symbol: "ES=F" };
const NQ: InstantBacktestSeries = {
  ...SPY,
  firstT: 10 * DAY_MS,
  lastT: 20 * DAY_MS,
  symbol: "NQ=F",
};
const CL: InstantBacktestSeries = {
  ...SPY,
  firstT: 200 * DAY_MS,
  lastT: 300 * DAY_MS,
  symbol: "CL=F",
};
const TEST: InstantBacktestSeries = { ...SPY, symbol: "TEST" };

const report: BacktestRunReportOutput = {
  bars: 3,
  equity: [
    { drawdownPct: 0, equity: 10_000, t: 0 },
    { drawdownPct: 0.02, equity: 9800, t: DAY_MS },
    { drawdownPct: 0, equity: 10_500, t: 2 * DAY_MS },
  ],
  firstT: 0,
  lastT: 2 * DAY_MS,
  metrics: {
    absoluteDrawdown: 0,
    averageLossTrade: -200,
    averageProfitTrade: 700,
    buyHoldReturn: 0.1,
    cagr: null,
    expectedPayoff: 250,
    exposure: 0.5,
    finalEquity: 10_500,
    grossLoss: -200,
    grossProfit: 700,
    initialDeposit: 10_000,
    largestLossTrade: -200,
    largestProfitTrade: 700,
    lossTrades: 1,
    maxConsecutiveLosses: 1,
    maxConsecutiveLossesMoney: -200,
    maxConsecutiveWins: 1,
    maxDrawdownAbs: 200,
    maxDrawdownPct: 0.02,
    maximalConsecutiveLoss: -200,
    maximalConsecutiveLossCount: 1,
    netProfit: 500,
    profitFactor: 3.5,
    profitTrades: 1,
    recoveryFactor: 2.5,
    sharpe: null,
    sortino: 1.2,
    totalReturn: 0.05,
    totalTrades: 2,
    winRate: 0.5,
  },
  prices: [
    { c: 10, h: 11, l: 9, o: 10, t: 0 },
    { c: 11, h: 12, l: 9, o: 10, t: DAY_MS },
    { c: 12, h: 13, l: 10, o: 11, t: 2 * DAY_MS },
  ],
  seriesSha256: "e".repeat(64),
  trades: [
    {
      balanceAfter: 9800,
      entryPrice: 10,
      entryT: 0,
      exitPrice: 9.8,
      exitReason: "stop",
      exitT: DAY_MS,
      n: 1,
      netReturn: -0.02,
      pnl: -200,
      units: 1000,
    },
    {
      balanceAfter: 10_500,
      entryPrice: 11,
      entryT: DAY_MS,
      exitPrice: 12,
      exitReason: "signal",
      exitT: 2 * DAY_MS,
      n: 2,
      netReturn: 0.07,
      pnl: 700,
      units: 700,
    },
  ],
  tradesTruncated: false,
};

const COSTS = {
  bps: 0,
  commission: 20,
  fees: 2,
  netProfitBeforeCosts: 530,
  profileId: "ibkr-test",
  profileLabel: "IBKR test",
  slippage: 5,
  spread: 3,
  total: 30,
};

const runOf = (overrides: Partial<BacktestRun> = {}): BacktestRun => ({
  createdAt: new Date(0),
  engineVersion: "instant-1",
  error: null,
  finishedAt: null,
  id: "run-1",
  report,
  spec: {
    costBps: 2,
    from: "1970-01-01",
    initialCapital: 10_000,
    rule: { fast: 50, kind: "smaCross", slow: 200 },
    stopLossPct: 0,
    symbol: "SPY",
    takeProfitPct: 0,
    timeframe: "1d",
    to: "1970-04-10",
  },
  startedAt: null,
  status: "succeeded",
  strategyId: null,
  strategyRevision: null,
  strategySnapshot: null,
  ...overrides,
});

const gatewayOf = (
  overrides: Partial<BacktestRunsGateway> = {}
): BacktestRunsGateway => ({
  get: vi.fn(async () => runOf()),
  list: vi.fn(async () => [runOf()]),
  series: vi.fn(async () => [SPY]),
  strategies: vi.fn(async () => [{ id: "s-1", name: "SMA cross" }]),
  submit: vi.fn(async () => runOf({ report: null, status: "queued" })),
  ...overrides,
});

describe("backtest runs model", () => {
  it("picks the run to open on load", () => {
    const runs = [
      { id: "a", status: "running" },
      { id: "b", status: "succeeded" },
      { id: "c", status: "succeeded" },
    ];
    expect(latestSucceededRunId(runs)).toBe("b");
    expect(latestSucceededRunId([])).toBeNull();
    expect(pickInitialRunId("c", runs)).toBe("c");
    expect(pickInitialRunId("a", runs)).toBe("a");
    expect(pickInitialRunId("zz", runs)).toBe("b");
    expect(pickInitialRunId(null, runs)).toBe("b");
    expect(isNotFound({ code: "NOT_FOUND" })).toBe(true);
    expect(isNotFound({ code: "STORAGE_ERROR" })).toBe(false);
    expect(isNotFound({})).toBe(false);
    expect(isNotFound(null)).toBe(false);
    expect(isNotFound("NOT_FOUND")).toBe(false);
  });

  const form = {
    costProfile: "" as const,
    from: "1970-01-01",
    initialCapital: 5000,
    params: DEFAULT_INSTANT_PARAMS,
    strategyId: "",
    to: "1970-04-10",
  };

  it("builds the submit request or explains the error", () => {
    expect(toSubmitInput(form, SPY)).toEqual({
      input: expect.objectContaining({
        from: "1970-01-01",
        initialCapital: 5000,
        strategyId: null,
        symbol: "SPY",
        to: "1970-04-10",
      }) as unknown,
    });
    expect(toSubmitInput(form, SPY)).not.toHaveProperty("input.costProfile");
    expect(
      toSubmitInput({ ...form, costProfile: "ibkr-pro-fixed-us-stock" }, SPY)
    ).toMatchObject({ input: { costProfile: "ibkr-pro-fixed-us-stock" } });
    expect(toSubmitInput({ ...form, strategyId: "s-1" }, SPY)).toMatchObject({
      input: { strategyId: "s-1" },
    });
    expect(
      toSubmitInput(
        { ...form, params: { ...DEFAULT_INSTANT_PARAMS, fast: 300 } },
        SPY
      )
    ).toHaveProperty("error");
    expect(toSubmitInput({ ...form, from: "" }, SPY)).toEqual({
      error: "Enter both dates as YYYY-MM-DD.",
    });
    expect(toSubmitInput({ ...form, from: "1971-01-01" }, SPY)).toEqual({
      error: "The start date must not be after the end date.",
    });
    expect(toSubmitInput({ ...form, initialCapital: 0 }, SPY)).toEqual({
      error: "Initial capital must be from 1 to 1,000,000,000.",
    });
  });

  it("builds one run per universe series with dates clipped to its bars", () => {
    const plan = toUniverseSubmitInputs(
      { ...form, from: "1970-01-05", to: "1970-04-10" },
      [ES, NQ, CL]
    );
    expect(plan.skipped).toBe(1);
    expect(
      plan.inputs.map((input) => [input.symbol, input.from, input.to])
    ).toEqual([
      ["ES=F", "1970-01-05", "1970-04-10"],
      ["NQ=F", "1970-01-11", "1970-01-21"],
    ]);
    expect(plan.inputs[0]).toMatchObject({ initialCapital: 5000 });
    // A form that cannot run skips every series.
    expect(
      toUniverseSubmitInputs(
        { ...form, params: { ...DEFAULT_INSTANT_PARAMS, fast: 300 } },
        [ES, NQ]
      )
    ).toEqual({
      firstError: "The fast average must be shorter than the slow average.",
      inputs: [],
      invalid: 2,
      skipped: 0,
    });
    // Empty clipped ranges and other errors are counted apart; the first error is kept.
    expect(
      toUniverseSubmitInputs({ ...form, initialCapital: 0 }, [ES, CL])
    ).toEqual({
      firstError: "Initial capital must be from 1 to 1,000,000,000.",
      inputs: [],
      invalid: 1,
      skipped: 1,
    });
    // A form whose own dates are invalid reports that error rather than an empty range.
    expect(
      toUniverseSubmitInputs(
        { ...form, from: "1970-02-01", to: "1970-01-01" },
        [ES]
      )
    ).toMatchObject({ invalid: 1, skipped: 0 });
    expect(toUniverseSubmitInputs({ ...form, to: "" }, [ES])).toMatchObject({
      invalid: 1,
      skipped: 0,
    });
    expect(
      describeUniversePlan({
        firstError: null,
        inputs: [],
        invalid: 1,
        skipped: 2,
      })
    ).toBe("0 runs, 3 skipped");
    expect(describeUniversePlan(toUniverseSubmitInputs(form, [ES]))).toBe(
      "1 run, 0 skipped"
    );
  });

  it("summarizes a universe batch", () => {
    expect(
      describeUniverseBatch({
        failure: null,
        label: "Core 7 futures",
        notSubmitted: 0,
        plan: { firstError: null, inputs: [], invalid: 0, skipped: 0 },
        submitted: 7,
      })
    ).toBe("Submitted 7 runs for Core 7 futures.");
    expect(
      describeUniverseBatch({
        failure: "Bar storage unavailable",
        label: "Core 7 ETF twins",
        notSubmitted: 3,
        plan: {
          firstError: "Initial capital must be from 1 to 1,000,000,000.",
          inputs: [],
          invalid: 1,
          skipped: 2,
        },
        submitted: 1,
      })
    ).toBe(
      "Submitted 1 run for Core 7 ETF twins. 3 not submitted. Skipped 2 series with no bars in the date range. Skipped 1 series that could not run: Initial capital must be from 1 to 1,000,000,000. Bar storage unavailable"
    );
  });

  it("lists cost profiles and shows gross versus net rows", () => {
    expect(COST_PROFILE_OPTIONS.map((option) => option.id)).toContain(
      "ibkr-pro-tiered-us-stock"
    );
    expect(COST_PROFILE_OPTIONS.map((option) => option.id)).not.toContain(
      "ibkr-pro-us-option"
    );
    expect(isCostProfilePresetId("zero")).toBe(true);
    expect(isCostProfilePresetId("nope")).toBe(false);
    expect(costRows(report)).toEqual([]);
    const rows = costRows({ ...report, costs: COSTS });
    expect(rows[0]).toEqual({ label: "Cost profile", value: "IBKR test" });
    expect(
      rows.find((row) => row.label === "Net profit before costs")?.value
    ).toBe("530.00");
    expect(rows.find((row) => row.label === "Total costs")?.value).toBe(
      "30.00"
    );
  });

  it("formats metric rows with n/a for missing values", () => {
    const rows = metricRows(report.metrics);
    expect(rows.find((row) => row.label === "Total net profit")?.value).toBe(
      "500.00"
    );
    expect(rows.find((row) => row.label === "Maximal drawdown")?.value).toBe(
      "200.00 (2.00%)"
    );
    expect(rows.find((row) => row.label === "Sharpe ratio")?.value).toBe("n/a");
    expect(rows.find((row) => row.label === "CAGR")?.value).toBe("n/a");
    expect(
      metricRows({ ...report.metrics, expectedPayoff: null }).find(
        (row) => row.label === "Expected payoff"
      )?.value
    ).toBe("n/a");
    expect(describeRevision(runOf())).toBe(" No strategy linked.");
    expect(
      describeRevision({
        strategyRevision: "a".repeat(64),
        strategySnapshot: null,
      })
    ).toBe(" No strategy linked.");
    expect(
      describeRevision({
        strategyRevision: "abcdef0123456789",
        strategySnapshot: {
          id: "s",
          kind: "native",
          name: "SMA",
          params: [],
          slug: "s",
          sourceRef: null,
          updatedAt: "x",
        },
      })
    ).toBe(" Strategy SMA revision abcdef012345….");
    expect(isoDate(DAY_MS)).toBe("1970-01-02");
    expect(isFinished(runOf())).toBe(true);
    expect(isFinished(runOf({ status: "failed" }))).toBe(true);
    expect(isFinished(runOf({ status: "running" }))).toBe(false);
  });

  it("projects prices and the trades up to the replay step", () => {
    const geometry = replayGeometry(report, 1, 100, 40);
    expect(geometry.path.startsWith("M0.0,")).toBe(true);
    expect(geometry.markers).toEqual([
      expect.objectContaining({
        current: true,
        n: 1,
        win: false,
        x1: 0,
        x2: 50,
      }),
    ]);
    expect(geometry.cursorX).toBe(50);
    expect(replayGeometry(report, 0, 100, 40).cursorX).toBeNull();
    expect(replayGeometry({ prices: [], trades: [] }, 1, 100, 40)).toEqual({
      cursorX: null,
      markers: [],
      path: "",
    });
    const flat = replayGeometry(
      {
        prices: [
          { c: 1, h: 1, l: 1, o: 1, t: 0 },
          { c: 1, h: 1, l: 1, o: 1, t: 1 },
        ],
        trades: [],
      },
      0,
      10,
      10
    );
    expect(flat.path).toBe("M0.0,10.0L10.0,10.0");
  });

  it("maps the API client calls", async () => {
    const client = {
      backtestRuns: {
        get: vi.fn(async () => runOf()),
        list: vi.fn(async () => ({ runs: [runOf()] })),
        submit: vi.fn(async () => runOf()),
      },
      instantBacktest: { series: vi.fn(async () => ({ series: [SPY] })) },
      strategyLibrary: {
        list: vi.fn(async () => ({
          strategies: [{ id: "s-1", name: "A", slug: "a" }],
        })),
      },
    };
    const gateway = createBacktestRunsGateway(client as never);
    await expect(gateway.series()).resolves.toEqual([SPY]);
    await expect(gateway.strategies()).resolves.toEqual([
      { id: "s-1", name: "A" },
    ]);
    await gateway.submit({} as never);
    await gateway.get("run-1");
    await expect(gateway.list()).resolves.toHaveLength(1);
    expect(client.backtestRuns.get).toHaveBeenCalledWith({ id: "run-1" });
    expect(client.backtestRuns.list).toHaveBeenCalledWith({ limit: 50 });
  });
});

describe("BacktestRunsWorkspace", () => {
  it("submits a run, polls until it finishes and shows the report", async () => {
    let reads = 0;
    const gateway = gatewayOf({
      get: vi.fn(async () => {
        reads += 1;
        return reads === 1
          ? runOf({ report: null, status: "running" })
          : runOf({ report: { ...report, costs: COSTS } });
      }),
      list: vi.fn(async () => []),
    });
    await mount(<BacktestRunsWorkspace gateway={gateway} pollMs={1} />);
    expect(field("From").value).toBe("1970-01-01");
    expect(field("To").value).toBe("1970-04-10");
    await setNative(field("Strategy (optional)"), "s-1");
    await setNative(field("Initial capital"), "25000");
    await setNative(field("Cost profile"), "ibkr-pro-fixed-us-stock");
    await settle(() => button("Run backtest").click());
    expect(gateway.submit).toHaveBeenCalledWith(
      expect.objectContaining({
        costProfile: "ibkr-pro-fixed-us-stock",
        initialCapital: 25_000,
        strategyId: "s-1",
      })
    );
    await act(async () => {
      const { promise, resolve } = deferred<void>();
      setTimeout(resolve, 20);
      await promise;
      await flush();
    });
    expect(document.body.textContent).toContain("Total net profit");
    expect(document.body.textContent).toContain("Net profit before costs");
    expect(document.body.textContent).toContain("Trade 2 of 2");
    await settle(() => button("Previous trade").click());
    expect(document.body.textContent).toContain("Trade 1 of 2");
    await setNative(
      document.querySelector('input[type="range"]') as HTMLInputElement,
      "0"
    );
    expect(document.body.textContent).toContain("No trades shown (2 total)");
    await settle(() => button("Next trade").click());
    expect(document.body.textContent).toContain("Trade 1 of 2");
    expect(document.querySelectorAll("tbody tr")).toHaveLength(2);
    expect(document.querySelectorAll("figure")).toHaveLength(2);
    // 375 px: a padded wrapper scrolls the tab bar (the list itself must not clip the 44 px
    // trigger boxes), triggers keep their width, and the form selects shrink to the column.
    const tabList = document.querySelector('[role="tablist"]');
    expect(tabList?.className).not.toContain("overflow");
    const scroller = tabList?.parentElement;
    expect(scroller?.hasAttribute("data-report-tabs-scroll")).toBe(true);
    expect(scroller?.className).toContain("overflow-x-auto");
    expect(scroller?.className).toContain("py-1.5");
    const tabs = document.querySelectorAll('[role="tab"]');
    expect(tabs).toHaveLength(4);
    for (const tab of tabs) {
      expect(tab.className).toContain("flex-none");
      expect(tab.className).not.toMatch(/(^|\s)flex-1(\s|$)/);
    }
    const selects = document.querySelectorAll("form select");
    expect(selects.length).toBeGreaterThanOrEqual(5);
    for (const select of selects) {
      expect(select.className).toContain("min-w-0");
    }
  });

  it("switches rule fields and reports invalid input and submit failures", async () => {
    const gateway = gatewayOf({
      submit: vi.fn(async () => Promise.reject(new Error("boom"))),
    });
    await mount(<BacktestRunsWorkspace gateway={gateway} />);
    await setNative(field("Rule"), "breakout");
    expect(field("Entry lookback (bars)").value).toBe("20");
    await setNative(field("Entry lookback (bars)"), "30");
    await setNative(field("Exit lookback (bars)"), "15");
    await setNative(field("Trend average (bars, 0 = off)"), "100");
    await setNative(field("Stop-loss (%)"), "5");
    await setNative(field("Take-profit (%)"), "10");
    await setNative(field("Cost per side (bps)"), "1");
    await setNative(field("Cost profile"), "zero");
    await setNative(field("Cost profile"), "");
    await setNative(field("Rule"), "smaCross");
    await setNative(field("Fast average (bars)"), "250");
    expect(document.body.textContent).toContain(
      "The fast average must be shorter than the slow average."
    );
    expect(button("Run backtest").disabled).toBe(true);
    await setNative(field("Slow average (bars)"), "300");
    await setNative(field("Symbol and timeframe"), "SPY:1d");
    await setNative(field("From"), "1970-01-05");
    await setNative(field("To"), "1970-02-01");
    await settle(() => button("Run backtest").click());
    expect(gateway.submit).toHaveBeenCalledWith(
      expect.objectContaining({
        costBps: 1,
        from: "1970-01-05",
        rule: { fast: 250, kind: "smaCross", slow: 300 },
        stopLossPct: 5,
        takeProfitPct: 10,
        to: "1970-02-01",
      })
    );
    expect(document.querySelector('[role="alert"]')?.textContent).toBeTruthy();
  });

  it("opens the latest succeeded run with no input and keeps the URL clean", async () => {
    const gateway = gatewayOf({
      list: vi.fn(async () => [
        runOf({ id: "run-3", report: null, status: "running" }),
        runOf({ id: "run-2" }),
        runOf({ id: "run-1" }),
      ]),
    });
    await mount(<BacktestRunsWorkspace gateway={gateway} />);
    expect(gateway.get).toHaveBeenCalledWith("run-2");
    expect(gateway.get).toHaveBeenCalledTimes(1);
    expect(gateway.submit).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Total net profit");
    expect(window.location.search).toBe("");
    const listed = document.querySelectorAll<HTMLButtonElement>(
      'section[aria-label="Recent runs"] button'
    );
    await settle(() => listed[2]?.click());
    expect(window.location.search).toBe("?run=run-1");
    await setNative(field("Universe"), "all");
    expect(window.location.search).toBe("?run=run-1&universe=all");
    await setNative(field("Universe"), "core7-futures");
    expect(window.location.search).toBe("?run=run-1");
  });

  it("opens the run named in the URL, or the latest succeeded run", async () => {
    const list = vi.fn(async () => [
      runOf({ id: "run-9" }),
      runOf({ id: "run-1" }),
    ]);
    window.history.replaceState(null, "", "/backtest-runs?run=run-1");
    const gateway = gatewayOf({ list });
    await mount(<BacktestRunsWorkspace gateway={gateway} />);
    expect(gateway.get).toHaveBeenCalledWith("run-1");
    expect(window.location.search).toBe("?run=run-1");
    window.history.replaceState(null, "", "/backtest-runs?run=gone");
    const unknown = gatewayOf({ list });
    await mount(<BacktestRunsWorkspace gateway={unknown} />);
    expect(unknown.get).toHaveBeenCalledWith("run-9");
    expect(unknown.get).not.toHaveBeenCalledWith("gone");
    expect(window.location.search).toBe("");
  });

  it("falls back to the latest succeeded run when the page links an unknown run", async () => {
    const notFound = { code: "NOT_FOUND", message: "Backtest run not found" };
    window.history.replaceState(null, "", "/backtest-runs?run=missing-run");
    const get = vi.fn(async (id: string) =>
      id === "missing-run" ? Promise.reject(notFound) : runOf({ id })
    );
    const gateway = gatewayOf({
      get,
      list: vi.fn(async () => [runOf({ id: "run-2" })]),
    });
    // The real page passes any well-formed ?run= id as initialRunId.
    await mount(
      <BacktestRunsWorkspace gateway={gateway} initialRunId="missing-run" />
    );
    expect(get).toHaveBeenCalledWith("run-2");
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(document.body.textContent).toContain("Total net profit");
    expect(window.location.search).toBe("");
    expect(gateway.submit).not.toHaveBeenCalled();

    // No other succeeded run, or no list: the error stays.
    for (const list of [
      vi.fn(async () => [runOf({ id: "missing-run" })]),
      vi.fn(async () => [runOf({ report: null, status: "failed" })]),
      vi.fn(async () => Promise.reject(new Error("down"))),
    ]) {
      document.body.replaceChildren();
      await mount(
        <BacktestRunsWorkspace
          gateway={gatewayOf({ get, list })}
          initialRunId="missing-run"
        />
      );
      expect(document.querySelector('[role="alert"]')?.textContent).toContain(
        "Select the run in Recent runs"
      );
    }
  });

  it("ignores a fallback list that answers after the page closed", async () => {
    const notFound = { code: "NOT_FOUND", message: "Backtest run not found" };
    for (const outcome of ["resolve", "reject"] as const) {
      const late = deferred<BacktestRun[]>();
      const list = vi
        .fn<BacktestRunsGateway["list"]>()
        .mockResolvedValueOnce([runOf({ id: "run-2" })])
        .mockReturnValueOnce(late.promise);
      const get = vi.fn(async () => Promise.reject(notFound));
      await mount(
        <BacktestRunsWorkspace
          gateway={gatewayOf({ get, list })}
          initialRunId="missing-run"
        />
      );
      expect(list).toHaveBeenCalledTimes(2);
      for (const root of roots.splice(0)) await act(async () => root.unmount());
      await settle(() =>
        outcome === "resolve"
          ? late.resolve([runOf({ id: "run-3" })])
          : late.reject(new Error("down"))
      );
      expect(get).not.toHaveBeenCalledWith("run-3");
    }
  });

  it("opens nothing when no run succeeded", async () => {
    const gateway = gatewayOf({
      list: vi.fn(async () => [runOf({ report: null, status: "failed" })]),
    });
    await mount(<BacktestRunsWorkspace gateway={gateway} />);
    expect(gateway.get).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Recent runs");
  });

  it("opens a listed run and shows failed and pending runs", async () => {
    const gateway = gatewayOf({
      get: vi.fn(async (id: string) =>
        id === "run-2"
          ? runOf({
              error: "No stored 1d bars",
              report: null,
              status: "failed",
            })
          : runOf({ report: null, status: "queued" })
      ),
      list: vi.fn(async () => [
        runOf({
          id: "run-2",
          spec: {
            ...runOf().spec,
            rule: {
              entryLookback: 20,
              exitLookback: 10,
              kind: "breakout",
              trendSma: 50,
            },
          },
          strategySnapshot: {
            id: "s-1",
            kind: "native",
            name: "Breakout A",
            params: [],
            slug: "a",
            sourceRef: null,
            updatedAt: "x",
          },
        }),
        runOf({
          id: "run-3",
          spec: {
            ...runOf().spec,
            rule: {
              entryLookback: 5,
              exitLookback: 3,
              kind: "breakout",
              trendSma: 0,
            },
          },
        }),
        runOf({
          id: "run-4",
          spec: {
            ...runOf().spec,
            rule: {
              definition: StrategyDefinitionSchema.parse(
                STRATEGY_TEMPLATES.smaCross
              ),
              kind: "dsl",
            },
          },
        }),
        runOf({
          id: "run-5",
          spec: {
            ...runOf().spec,
            rule: { kind: "academy", rules: {}, structure: "iron_condor" },
          },
        }),
      ]),
    });
    await mount(
      <BacktestRunsWorkspace
        gateway={gateway}
        initialRunId="run-1"
        pollMs={60_000}
      />
    );
    expect(document.body.textContent).toContain("The backtest is queued.");
    expect(
      ([...document.querySelectorAll("li button")][3] as HTMLButtonElement)
        .textContent
    ).toContain("Academy: iron_condor");
    const listed = [
      ...document.querySelectorAll("li button"),
    ][0] as HTMLButtonElement;
    expect(listed.textContent).toContain("Breakout 20/10, trend 50");
    expect(listed.textContent).toContain("Breakout A");
    expect(
      ([...document.querySelectorAll("li button")][1] as HTMLButtonElement)
        .textContent
    ).toContain("Breakout 5/3 ·");
    expect(
      ([...document.querySelectorAll("li button")][2] as HTMLButtonElement)
        .textContent
    ).toContain("Definition: SMA cross");
    await settle(() => listed.click());
    expect(document.body.textContent).toContain(
      "The backtest failed: No stored 1d bars"
    );
  });

  it("resets the date range when another series is chosen", async () => {
    const QQQ = {
      ...SPY,
      firstT: 10 * DAY_MS,
      lastT: 20 * DAY_MS,
      symbol: "QQQ",
    };
    await mount(
      <BacktestRunsWorkspace
        gateway={gatewayOf({ series: vi.fn(async () => [SPY, QQQ]) })}
      />
    );
    await setNative(field("Symbol and timeframe"), "QQQ:1d");
    expect(field("From").value).toBe("1970-01-11");
    expect(field("To").value).toBe("1970-01-21");
    await setNative(field("Symbol and timeframe"), "missing");
    expect(field("From").value).toBe("1970-01-11");
  });

  const optionValues = (label: string) =>
    [...field(label).options].map((option) => option.value);
  const batchButton = (label: string) =>
    button(`Run on every series in ${label}`) as HTMLButtonElement | undefined;

  it("preselects Core 7 futures and its first stored series", async () => {
    await mount(
      <BacktestRunsWorkspace
        gateway={gatewayOf({
          series: vi.fn(async () => [
            { ...SPY, symbol: "BTCUSDT" },
            NQ,
            SPY,
            TEST,
          ]),
        })}
      />
    );
    expect(field("Universe").value).toBe("core7-futures");
    expect(field("Symbol and timeframe").value).toBe("NQ=F:1d");
    expect(optionValues("Symbol and timeframe")).toEqual(["NQ=F:1d"]);
    expect(field("From").value).toBe("1970-01-11");
    expect(field("To").value).toBe("1970-01-21");
    // One stored member: no batch button.
    expect(batchButton("Core 7 futures")).toBeUndefined();

    await setNative(field("Universe"), "core7-etf-twins");
    expect(optionValues("Symbol and timeframe")).toEqual(["SPY:1d"]);
    expect(field("From").value).toBe("1970-01-01");
    expect(field("To").value).toBe("1970-04-10");
    await setNative(field("Universe"), "all");
    expect(optionValues("Symbol and timeframe")).toHaveLength(4);
    expect(field("Symbol and timeframe").value).toBe("BTCUSDT:1d");
  });

  it("shows every stored series when no Core 7 future is stored", async () => {
    await mount(
      <BacktestRunsWorkspace
        gateway={gatewayOf({ series: vi.fn(async () => [SPY, TEST]) })}
      />
    );
    expect(field("Universe").value).toBe("core7-futures");
    expect(field("Symbol and timeframe").value).toBe("SPY:1d");
    expect(optionValues("Symbol and timeframe")).toEqual(["SPY:1d", "TEST:1d"]);
    expect(document.body.textContent).toContain(
      "No stored bars for Core 7 futures yet. Showing all stored series."
    );
    expect(batchButton("Core 7 futures")).toBeUndefined();
    await setNative(field("Universe"), "core7-etf-twins");
    expect(optionValues("Symbol and timeframe")).toEqual(["SPY:1d"]);
  });

  it("reads universe and strategy from the URL", async () => {
    try {
      window.history.replaceState(
        null,
        "",
        "/backtest-runs?strategy=s-1&universe=core7-etf-twins"
      );
      await mount(
        <BacktestRunsWorkspace
          gateway={gatewayOf({ series: vi.fn(async () => [ES, SPY]) })}
        />
      );
      expect(field("Universe").value).toBe("core7-etf-twins");
      expect(field("Symbol and timeframe").value).toBe("SPY:1d");
      expect(field("Strategy (optional)").value).toBe("s-1");
      for (const root of roots.splice(0)) await act(async () => root.unmount());
      document.body.replaceChildren();

      window.history.replaceState(
        null,
        "",
        "/backtest-runs?strategy=unknown&universe=nasdaq"
      );
      await mount(
        <BacktestRunsWorkspace
          gateway={gatewayOf({ series: vi.fn(async () => [SPY, ES]) })}
        />
      );
      expect(field("Universe").value).toBe("core7-futures");
      expect(field("Symbol and timeframe").value).toBe("ES=F:1d");
      expect(field("Strategy (optional)").value).toBe("");
    } finally {
      window.history.replaceState(null, "", "/");
    }
  });

  it("submits one run per series of the universe with clipped dates", async () => {
    const submit = vi.fn(async () => runOf({ report: null, status: "queued" }));
    const list = vi.fn(async () => [runOf()]);
    await mount(
      <BacktestRunsWorkspace
        gateway={gatewayOf({
          list,
          series: vi.fn(async () => [CL, SPY, NQ, ES]),
          submit,
        })}
      />
    );
    expect(field("Symbol and timeframe").value).toBe("ES=F:1d");
    expect(optionValues("Symbol and timeframe")).toEqual([
      "ES=F:1d",
      "NQ=F:1d",
      "CL=F:1d",
    ]);
    const plan = () =>
      document.querySelector("[data-universe-plan]")?.textContent;
    expect(plan()).toBe("2 runs, 1 skipped");
    await setNative(field("From"), "1970-01-15");
    const listCalls = list.mock.calls.length;
    await settle(() => batchButton("Core 7 futures")?.click());
    expect(
      submit.mock.calls.map((call: readonly unknown[]) => {
        const input = call[0] as { symbol: string; from: string; to: string };
        return [input.symbol, input.from, input.to];
      })
    ).toEqual([
      ["ES=F", "1970-01-15", "1970-04-10"],
      ["NQ=F", "1970-01-15", "1970-01-21"],
    ]);
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      "Submitted 2 runs for Core 7 futures. Skipped 1 series with no bars in the date range."
    );
    expect(list.mock.calls.length).toBe(listCalls + 1);

    // A range with no bars in any series: zero planned runs disable the batch button.
    await setNative(field("From"), "1970-04-11");
    await setNative(field("To"), "1970-04-20");
    expect(plan()).toBe("0 runs, 3 skipped");
    expect(batchButton("Core 7 futures")?.disabled).toBe(true);
    // An invalid form disables the batch button too.
    await setNative(field("From"), "");
    expect(batchButton("Core 7 futures")?.disabled).toBe(true);
    // "All stored series" has no batch button.
    await setNative(field("Universe"), "all");
    expect(batchButton("All stored series")).toBeUndefined();
  });

  it("reports how many runs were submitted before a failure", async () => {
    let calls = 0;
    const submit = vi.fn(async () => {
      calls += 1;
      if (calls === 2)
        return Promise.reject({
          code: "STORAGE_ERROR",
          message: "Bar storage unavailable",
        });
      return runOf({ report: null, status: "queued" });
    });
    await mount(
      <BacktestRunsWorkspace
        gateway={gatewayOf({ series: vi.fn(async () => [ES, NQ]), submit })}
      />
    );
    await settle(() => batchButton("Core 7 futures")?.click());
    expect(submit).toHaveBeenCalledTimes(2);
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      "Submitted 1 run for Core 7 futures. 1 not submitted. Bar storage unavailable"
    );
    expect(batchButton("Core 7 futures")?.disabled).toBe(false);
  });

  it("ignores form submits while the input is invalid", async () => {
    const gateway = gatewayOf();
    await mount(<BacktestRunsWorkspace gateway={gateway} />);
    await setNative(field("From"), "");
    await settle(() =>
      document
        .querySelector("form")
        ?.dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true })
        )
    );
    expect(gateway.submit).not.toHaveBeenCalled();
  });

  it("stops polling at the read limit and shows truncated trade lists", async () => {
    const get = vi.fn(async () =>
      runOf({
        report: { ...report, tradesTruncated: true },
        status: "running",
      })
    );
    await mount(
      <BacktestRunsWorkspace
        gateway={gatewayOf({ get })}
        initialRunId="run-1"
        pollMax={2}
        pollMs={1}
      />
    );
    await act(async () => {
      const { promise, resolve } = deferred<void>();
      setTimeout(resolve, 30);
      await promise;
      await flush();
    });
    expect(get).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).toContain(
      "The run has not finished yet. Select it in Recent runs to check again."
    );
    const listed = [
      ...document.querySelectorAll("li button"),
    ][0] as HTMLButtonElement;
    await settle(() => listed.click());
    expect(get.mock.calls.length).toBeGreaterThan(2);
    expect(document.body.textContent).toContain("Trades (first 2)");
  });

  it("ignores results that arrive after unmount", async () => {
    const series = deferred<readonly InstantBacktestSeries[]>();
    const read = deferred<BacktestRun>();
    const failedRead = deferred<BacktestRun>();
    let calls = 0;
    const gateway = gatewayOf({
      get: vi.fn(() => {
        calls += 1;
        return calls === 1 ? read.promise : failedRead.promise;
      }),
      series: vi.fn(() => series.promise),
    });
    await mount(
      <BacktestRunsWorkspace gateway={gateway} initialRunId="run-1" />
    );
    await mount(
      <BacktestRunsWorkspace gateway={gateway} initialRunId="run-2" />
    );
    for (const root of roots.splice(0)) await act(async () => root.unmount());
    await act(async () => {
      series.resolve([SPY]);
      read.resolve(runOf());
      failedRead.reject(new Error("late"));
      await flush();
    });
    expect(document.body.textContent).toBe("");

    const rejected = deferred<readonly InstantBacktestSeries[]>();
    await mount(
      <BacktestRunsWorkspace
        gateway={gatewayOf({ series: vi.fn(() => rejected.promise) })}
      />
    );
    for (const root of roots.splice(0)) await act(async () => root.unmount());
    await act(async () => {
      rejected.reject(new Error("late"));
      await flush();
    });
    expect(document.body.textContent).toBe("");
  });

  it("uses the browser API client by default", async () => {
    const fetch = vi.fn(async () => Promise.reject(new TypeError("offline")));
    vi.stubGlobal("fetch", fetch);
    await mount(<BacktestRunsWorkspace />);
    expect(document.querySelector('[role="alert"]')).not.toBeNull();
    const gateway = createBrowserBacktestRunsGateway();
    await expect(gateway.submit({} as never)).rejects.toBeDefined();
    await expect(gateway.get("run-1")).rejects.toBeDefined();
    expect(fetch.mock.calls.length).toBeGreaterThanOrEqual(5);
    vi.unstubAllGlobals();
  });

  it("shows empty, forbidden, error and read-failure states", async () => {
    await mount(
      <BacktestRunsWorkspace
        gateway={gatewayOf({
          list: vi.fn(async () => Promise.reject(new Error("x"))),
          series: vi.fn(async () => []),
        })}
      />
    );
    expect(document.body.textContent).toContain("No stored bar series.");
    expect(document.body.textContent).toContain("No runs yet.");
    document.body.replaceChildren();

    await mount(
      <BacktestRunsWorkspace
        gateway={gatewayOf({
          series: vi.fn(async () =>
            Promise.reject({
              code: "FORBIDDEN",
              message: "Operator access required",
            })
          ),
        })}
      />
    );
    expect(document.body.textContent).toContain("operator");
    document.body.replaceChildren();

    await mount(
      <BacktestRunsWorkspace
        gateway={gatewayOf({
          series: vi.fn(async () => Promise.reject(new Error("down"))),
        })}
      />
    );
    expect(document.querySelector('[role="alert"]')).not.toBeNull();
    document.body.replaceChildren();

    await mount(
      <BacktestRunsWorkspace
        gateway={gatewayOf({
          get: vi.fn(async () => Promise.reject(new Error("gone"))),
        })}
        initialRunId="run-1"
      />
    );
    expect(document.querySelector('[role="alert"]')).not.toBeNull();
  });
});

// Options runs: the options book of report.options and the stored-definition link of the strategy
// library (?definition=<id>&sha=…).
const OPTIONS_BOOK: OptionsBook = {
  capital: 100_000,
  metrics: {
    cagr: 0.05,
    days: 365,
    deflatedSharpe: 0.91,
    end: "2026-11-06",
    expectedMaxSharpe: null,
    exposure: 0.4,
    finalEquity: 105_000,
    maxDrawdown: -0.12,
    maxOpenRisk: 0.02,
    nTrials: 1,
    sharpe: 0.8,
    sharpeVariance: 0.01,
    skipped: 3,
    staleIvExits: 1,
    start: "1993-10-29",
    totalReturn: 0.05,
    trades: 3,
    winRate: 0.5,
    worstMonth: "2008-10",
    worstMonthReturn: -0.07,
  },
  nautilusGap: 0.000_012,
  signals: { SPY: 4 },
  symbols: ["SPY", "QQQ"],
  trades: [
    {
      contracts: 2,
      entryDate: "1993-11-01",
      entryFee: 1.3,
      entryPrice: 2.5,
      exitDate: "1993-11-30",
      exitFee: 1.3,
      exitPrice: 3.75,
      exitReason: "profitTake",
      expiry: "1993-12-17",
      id: 1,
      longStrike: 46,
      pnl: 247.4,
      returnOnRisk: 0.49,
      shortStrike: 48,
      structure: "callDebitVertical",
      symbol: "SPY",
    },
    {
      contracts: 1,
      entryDate: "1993-12-01",
      entryFee: 0.65,
      entryPrice: 2.1,
      exitDate: "1993-12-02",
      exitFee: 0.65,
      exitPrice: 1.5,
      exitReason: "stale-iv",
      expiry: "1994-01-21",
      id: 2,
      longStrike: 47,
      pnl: -61.3,
      returnOnRisk: -0.29,
      shortStrike: 49,
      structure: "callDebitVertical",
      symbol: "QQQ",
    },
  ],
  tradesTruncated: false,
};

const QC_DEFINITION = StrategyDefinitionSchema.parse({
  entry: {
    all: [
      {
        left: { field: "close", type: "price" },
        op: ">",
        right: { length: 10, name: "sma", type: "indicator" },
      },
    ],
  },
  name: "10-month SMA trend",
  options: {
    dte: { min: 45, target: 60 },
    longDelta: 0.5,
    maxLossPct: 2,
    structure: "callDebitVertical",
    widthSigma: 1,
  },
  portfolio: {
    frame: "monthly",
    policy: "roll",
    symbols: ["SPY", "QQQ"],
  },
  sizing: { mode: "allIn" },
  stopLoss: { kind: "none" },
  takeProfit: { kind: "none" },
  version: 1,
});
const SHA_PINNED = "a".repeat(64);
const SHA_LATEST = "b".repeat(64);
const revisionOf = (
  revision: number,
  sha256: string,
  definition = QC_DEFINITION
) => ({
  createdAt: new Date(0),
  definition,
  id: "qc-asset-class-trend",
  name: definition.name,
  note: null,
  revision,
  sha256,
});
// Revision 2 is the latest; revision 1 is the one the library row pins.
const definitionGetter = (definition = QC_DEFINITION) =>
  vi.fn(async (_id: string, revision?: number) => ({
    history: [
      {
        createdAt: new Date(0),
        name: "x",
        note: null,
        revision: 2,
        sha256: SHA_LATEST,
      },
      {
        createdAt: new Date(0),
        name: "x",
        note: null,
        revision: 1,
        sha256: SHA_PINNED,
      },
    ],
    revision:
      revision === 1
        ? revisionOf(1, SHA_PINNED, definition)
        : revisionOf(2, SHA_LATEST, definition),
  }));
const LINKED: LinkedDefinition = {
  definition: QC_DEFINITION,
  id: "qc-asset-class-trend",
  name: "10-month SMA trend",
  pinned: true,
  revision: 1,
  sha256: SHA_PINNED,
};

describe("backtest runs model: options book and definition links", () => {
  it("labels every exit reason and keeps an unknown one as stored", () => {
    // Every reason the options contract can store has its own label.
    for (const reason of OPTIONS_EXIT_REASONS) {
      expect(exitReasonLabel(reason)).toBe(EXIT_REASON_LABELS[reason]);
      expect(exitReasonLabel(reason)).not.toBe(reason);
    }
    for (const reason of ["signal", "stop", "target", "end"] as const)
      expect(exitReasonLabel(reason)).not.toBe(reason);
    expect(exitReasonLabel("stale-iv")).toBe("Stale IV");
    expect(exitReasonLabel("margin-call")).toBe("margin-call");
  });

  it("formats the options metrics, signals and the trades heading", () => {
    const rows = Object.fromEntries(
      optionsMetricRows(OPTIONS_BOOK).map((row) => [row.label, row.value])
    );
    expect(rows).toEqual({
      CAGR: "5.00%",
      Capital: "100,000.00",
      End: "2026-11-06",
      Exposure: "40.00%",
      "Final equity": "105,000.00",
      "Max drawdown": "-12.00%",
      "Max open risk": "2.00%",
      "Nautilus gap (largest daily equity gap)": "0.0012%",
      "Probabilistic Sharpe (1 trial)": "0.91",
      "Sharpe ratio": "0.80",
      "Skipped entries": "3",
      "Stale-IV exits": "1",
      Start: "1993-10-29",
      "Total return": "5.00%",
      Trades: "3",
      "Win rate": "50.00%",
      "Worst month": "2008-10 (-7.00%)",
    });
    const bare = optionsMetricRows({
      ...OPTIONS_BOOK,
      metrics: {
        ...OPTIONS_BOOK.metrics,
        maxDrawdown: 0.2,
        worstMonth: null,
        worstMonthReturn: null,
      },
      nautilusGap: null,
    });
    expect(bare.map((row) => row.label)).not.toContain(
      "Nautilus gap (largest daily equity gap)"
    );
    expect(bare.find((row) => row.label === "Worst month")?.value).toBe("n/a");
    expect(bare.find((row) => row.label === "Max drawdown")?.value).toBe(
      "-20.00%"
    );
    expect(optionsSignalRows(OPTIONS_BOOK)).toEqual([
      { signals: 4, symbol: "SPY" },
      { signals: 0, symbol: "QQQ" },
    ]);
    expect(optionTradesHeading(OPTIONS_BOOK)).toBe(
      "Option trades (first 2 of 3)"
    );
    expect(
      optionTradesHeading({
        ...OPTIONS_BOOK,
        metrics: { ...OPTIONS_BOOK.metrics, trades: 2 },
      })
    ).toBe("Option trades");
  });

  it("reads and writes definition links", () => {
    expect(readDefinitionLink("")).toBeNull();
    expect(readDefinitionLink("?definition=%20")).toBeNull();
    const href = definitionRunHref({
      costBps: 0,
      from: "1993-10-29",
      id: "qc-asset-class-trend",
      initialCapital: 100_000,
      sha256: SHA_PINNED,
      strategyId: "strategy-seed-qc-asset-class-trend",
      symbol: null,
      timeframe: "1d",
      to: "2026-11-06",
    });
    expect(href).toBe(
      `/backtest-runs?definition=qc-asset-class-trend&sha=${SHA_PINNED}&strategy=strategy-seed-qc-asset-class-trend&timeframe=1d&from=1993-10-29&to=2026-11-06&initialCapital=100000&costBps=0`
    );
    expect(readDefinitionLink(href.slice(href.indexOf("?")))).toEqual({
      costBps: 0,
      from: "1993-10-29",
      id: "qc-asset-class-trend",
      initialCapital: 100_000,
      sha256: SHA_PINNED,
      symbol: null,
      timeframe: "1d",
      to: "2026-11-06",
    });
    expect(
      readDefinitionLink(
        "?definition=d&sha=XYZ&from=1993-1-2&to=soon&initialCapital=lots&costBps=&symbol=QQQ"
      )
    ).toEqual({
      costBps: null,
      from: null,
      id: "d",
      initialCapital: null,
      sha256: null,
      symbol: "QQQ",
      timeframe: "1d",
      to: null,
    });
    // Dates must be real calendar days, and a start after the end drops both.
    expect(isCalendarDate("2024-02-29")).toBe(true);
    expect(isCalendarDate("2023-02-29")).toBe(false);
    expect(isCalendarDate("2026-13-01")).toBe(false);
    expect(isCalendarDate("2026-1-01")).toBe(false);
    expect(
      readDefinitionLink("?definition=d&from=2026-02-30&to=2026-04-31")
    ).toMatchObject({ from: null, to: null });
    expect(
      readDefinitionLink("?definition=d&from=2026-02-01&to=2026-04-31")
    ).toMatchObject({ from: "2026-02-01", to: null });
    expect(
      readDefinitionLink("?definition=d&from=2026-05-01&to=2026-04-30")
    ).toMatchObject({ from: null, to: null });
    expect(
      readDefinitionLink("?definition=d&from=2026-04-30&to=2026-04-30")
    ).toMatchObject({ from: "2026-04-30", to: "2026-04-30" });
    expect(
      definitionRunHref({
        costBps: null,
        from: null,
        id: "d",
        initialCapital: null,
        sha256: null,
        strategyId: null,
        symbol: "SPY",
        timeframe: "1w",
        to: null,
      })
    ).toBe("/backtest-runs?definition=d&symbol=SPY&timeframe=1w");
  });

  it("loads the pinned revision, else the latest one", async () => {
    const get = definitionGetter();
    await expect(
      loadLinkedDefinition(get, { id: "qc", sha256: null })
    ).resolves.toMatchObject({ pinned: true, revision: 2 });
    await expect(
      loadLinkedDefinition(get, { id: "qc", sha256: SHA_LATEST })
    ).resolves.toMatchObject({ pinned: true, revision: 2 });
    expect(get).toHaveBeenCalledTimes(2);
    await expect(
      loadLinkedDefinition(get, { id: "qc", sha256: SHA_PINNED })
    ).resolves.toEqual(LINKED);
    expect(get).toHaveBeenLastCalledWith("qc", 1);
    await expect(
      loadLinkedDefinition(get, { id: "qc", sha256: "c".repeat(64) })
    ).resolves.toMatchObject({ pinned: false, revision: 2 });
  });

  it("picks the series of a link and describes the definition", () => {
    const series: InstantBacktestSeries[] = [
      SPY,
      ES,
      { ...SPY, symbol: "QQQ", timeframe: "1m" },
    ];
    const daily = { symbol: null, timeframe: "1d" };
    // Definitions without options run on the stored bar series the link names.
    expect(definitionSeries(series, daily)).toBeUndefined();
    expect(
      definitionSeries(series, { ...daily, symbol: "NOPE" })
    ).toBeUndefined();
    expect(definitionSeries(series, { ...daily, symbol: "ES=F" })).toBe(ES);
    expect(definitionSeries(series, { symbol: "QQQ", timeframe: "1m" })).toBe(
      series[2]
    );
    // Options definitions run on a store symbol: a portfolio member (stored bars or not), the
    // link symbol when it is one, else the first; without a portfolio any Core 7 ETF.
    expect(optionsRunSymbols(QC_DEFINITION)).toEqual(["SPY", "QQQ"]);
    expect(optionsLinkSymbol({ symbol: null }, QC_DEFINITION)).toBe("SPY");
    expect(optionsLinkSymbol({ symbol: "QQQ" }, QC_DEFINITION)).toBe("QQQ");
    expect(optionsLinkSymbol({ symbol: "GLD" }, QC_DEFINITION)).toBe("SPY");
    const { portfolio: _portfolio, ...single } = QC_DEFINITION;
    expect(optionsRunSymbols(single)).toEqual(STRATEGY_OPTION_SYMBOLS);
    expect(optionsLinkSymbol({ symbol: "GLD" }, single)).toBe("GLD");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-10T23:59:00Z"));
    expect(todayUtc()).toBe("2026-11-10");
    vi.setSystemTime(new Date("2026-11-11T00:00:00Z"));
    expect(todayUtc()).toBe("2026-11-11");
    expect(optionsDefaultFrom("2026-11-10")).toBe("2025-11-10");
    expect(optionsDefaultFrom("2024-02-29")).toBe("2023-03-01");
    // A rule switch moves the dates only when the data source changes.
    const plain = { definition: null, from: "2020-01-01", to: "2020-12-31" };
    const options = { definition: LINKED };
    expect(ruleSwitchDates(plain, { definition: null }, SPY)).toEqual({
      from: plain.from,
      storeDates: undefined,
      to: plain.to,
    });
    const onto = ruleSwitchDates(plain, options, SPY);
    expect(onto).toEqual({
      from: "2025-11-11",
      storeDates: undefined,
      to: "2026-11-11",
    });
    const off = ruleSwitchDates({ ...options, ...onto }, plain, SPY);
    expect(off).toEqual({
      from: isoDate(SPY.firstT),
      storeDates: { from: "2025-11-11", to: "2026-11-11" },
      to: isoDate(SPY.lastT),
    });
    expect(ruleSwitchDates({ ...plain, ...off }, options, SPY)).toEqual(onto);
    expect(ruleSwitchDates({ ...options, ...onto }, plain, undefined)).toEqual({
      ...onto,
      storeDates: { from: onto.from, to: onto.to },
    });
    expect(describeLinkedDefinition(LINKED)).toBe(
      "Strategy definition: qc-asset-class-trend revision 1 (sha aaaaaaaaaaaa…), 10-month SMA trend."
    );
    expect(describeLinkedDefinition({ ...LINKED, pinned: false })).toContain(
      "the latest revision is loaded"
    );
  });

  it("builds a dsl run request for a linked definition", () => {
    const form = {
      costProfile: "ibkr-pro-fixed-us-stock" as const,
      definition: LINKED,
      from: "1993-10-29",
      initialCapital: 100_000,
      params: { ...DEFAULT_INSTANT_PARAMS, costBps: 2, stopLossPct: 5 },
      strategyId: "s-1",
      to: "1970-04-10",
    };
    // An options definition sends a flat cost of 0 and no cost profile (the book charges its own).
    expect(runsOptionsDefinition(form)).toBe(true);
    expect(runsOptionsDefinition({ definition: null })).toBe(false);
    expect(runsOptionsDefinition({})).toBe(false);
    expect(toSubmitInput({ ...form, to: "2026-11-06" }, SPY)).toEqual({
      input: {
        costBps: 0,
        from: "1993-10-29",
        initialCapital: 100_000,
        rule: { definition: QC_DEFINITION, kind: "dsl" },
        strategyId: "s-1",
        symbol: "SPY",
        timeframe: "1d",
        to: "2026-11-06",
      },
    });
    // Only portfolio members run.
    expect(toSubmitInput({ ...form, to: "2026-11-06" }, ES)).toEqual({
      error: "The definition trades SPY, QQQ; choose one of them.",
    });
    // Without a portfolio an options definition trades any Core 7 ETF of the series store.
    const { portfolio: _portfolio, ...rest } = QC_DEFINITION;
    const single = {
      ...LINKED,
      definition: StrategyDefinitionSchema.parse(rest),
    };
    expect(
      toSubmitInput(
        { ...form, definition: single, to: "2026-11-06" },
        { symbol: "GLD", timeframe: "1d" }
      )
    ).toMatchObject({ input: { costBps: 0, symbol: "GLD", timeframe: "1d" } });
    expect(
      toSubmitInput({ ...form, definition: single, to: "2026-11-06" }, ES)
    ).toEqual({
      error: `The definition trades ${STRATEGY_OPTION_SYMBOLS.join(", ")}; choose one of them.`,
    });
    // A definition without options keeps the form's cost and profile.
    const sma = {
      ...LINKED,
      definition: StrategyDefinitionSchema.parse(STRATEGY_TEMPLATES.smaCross),
    };
    expect(runsOptionsDefinition({ definition: sma })).toBe(false);
    expect(
      toSubmitInput({ ...form, definition: sma, to: "2026-11-06" }, ES)
    ).toMatchObject({
      input: {
        costBps: 2,
        costProfile: "ibkr-pro-fixed-us-stock",
        symbol: "ES=F",
      },
    });
    expect(
      toSubmitInput(
        {
          ...form,
          definition: sma,
          params: { ...form.params, costBps: 900 },
          to: "2026-11-06",
        },
        SPY
      )
    ).toEqual({ error: "Cost per side must be from 0 to 500 bps." });
    expect(toSubmitInput({ ...form, definition: null }, SPY)).toEqual({
      error: "The start date must not be after the end date.",
    });
  });

  it("maps the definitions API", async () => {
    const get = vi.fn(async () => ({}));
    const gateway = createBacktestRunsGateway({
      backtestRuns: { definitions: { get } },
    } as never);
    await gateway.definition?.("qc");
    await gateway.definition?.("qc", 3);
    expect(get.mock.calls).toEqual([
      [{ id: "qc" }],
      [{ id: "qc", revision: 3 }],
    ]);
  });
});

describe("BacktestRunsWorkspace: options book and stored definitions", () => {
  const optionsRun = (book: OptionsBook) =>
    runOf({ report: { ...report, options: book } });

  it("shows the options book tab of an options run", async () => {
    await mount(
      <BacktestRunsWorkspace
        gateway={gatewayOf({
          get: vi.fn(async () => optionsRun(OPTIONS_BOOK)),
        })}
        initialRunId="run-1"
      />
    );
    const tabs = [...document.querySelectorAll('[role="tab"]')];
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      "Performance",
      "Options book",
      "Trades Analysis",
      "Trades Log",
      "Simulation",
    ]);
    const book = document.querySelector("[data-options-book]") as HTMLElement;
    expect(book.querySelector("[data-options-modeled]")?.textContent).toContain(
      "Black-Scholes on volatility-index proxies"
    );
    expect(book.textContent).toContain("Research only; no orders.");
    expect(book.textContent).toContain("Probabilistic Sharpe (1 trial)0.91");
    expect(book.textContent).toContain("Nautilus gap");
    expect(book.querySelector("[data-options-signals]")?.textContent).toBe(
      "SPY: 4QQQ: 0"
    );
    expect(
      book.querySelector('[aria-label="Option trades"] h3')?.textContent
    ).toBe("Option trades (first 2 of 3)");
    const rows = book.querySelectorAll("[data-option-trades] tbody tr");
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain("46 / 48");
    expect(rows[0]?.textContent).toContain("49.00%");
    expect(rows[0]?.textContent).toContain("Profit take");
    expect(rows[1]?.textContent).toContain("Stale IV");
    // 375 px: the wide table scrolls inside its own box, like the trades log.
    const scroller = book.querySelector("[data-option-trades]")?.parentElement;
    expect(scroller?.className).toContain("overflow-auto");
    // The trades log labels the extended exit reasons too.
    expect(document.body.textContent).toContain("Stop loss");
  });

  it("shows an options book without trades", async () => {
    await mount(
      <BacktestRunsWorkspace
        gateway={gatewayOf({
          get: vi.fn(async () =>
            optionsRun({
              ...OPTIONS_BOOK,
              metrics: { ...OPTIONS_BOOK.metrics, trades: 0 },
              nautilusGap: null,
              trades: [],
            })
          ),
        })}
        initialRunId="run-1"
      />
    );
    const book = document.querySelector("[data-options-book]") as HTMLElement;
    expect(book.textContent).toContain("No option trades.");
    expect(book.textContent).not.toContain("Nautilus gap");
    expect(book.querySelector("[data-option-trades]")).toBeNull();
  });

  it("opens an options link without dates and stored bars on a year to today", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-10T12:00:00Z"));
    window.history.replaceState(null, "", "/backtest-runs?definition=qc");
    await mount(
      <BacktestRunsWorkspace
        gateway={gatewayOf({
          definition: definitionGetter(),
          series: vi.fn(async () => []),
        })}
      />
    );
    expect(field("From").value).toBe("2025-11-10");
    expect(field("To").value).toBe("2026-11-10");
    // An options run needs no stored bars, so the import hint stays hidden.
    expect(document.body.textContent).not.toContain("No stored bar series");
    expect(button("Run backtest").disabled).toBe(false);
    await setNative(field("Rule"), "smaCross");
    expect(document.body.textContent).toContain("No stored bar series");
  });

  it("opens a stored definition from a strategy library link and runs it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-10T23:30:00Z"));
    window.history.replaceState(
      null,
      "",
      `/backtest-runs?definition=qc-asset-class-trend&sha=${SHA_PINNED}&strategy=s-1&timeframe=1d&from=1970-01-05&initialCapital=100000`
    );
    const definition = definitionGetter();
    const gateway = gatewayOf({
      definition,
      series: vi.fn(async () => [ES, SPY]),
    });
    await mount(<BacktestRunsWorkspace gateway={gateway} />);
    expect(definition.mock.calls).toEqual([
      ["qc-asset-class-trend"],
      ["qc-asset-class-trend", 1],
    ]);
    // Options runs read the daily series store: a portfolio member symbol replaces the universe
    // and stored-series selects, the link start is kept and the run ends today (UTC).
    expect(field("Universe")).toBeNull();
    expect(field("Symbol and timeframe")).toBeNull();
    const symbol = field("Symbol (daily series store, 1d)");
    expect(symbol.value).toBe("SPY");
    expect(Array.from(symbol.options, (option) => option.value)).toEqual([
      "SPY",
      "QQQ",
    ]);
    const help = document.getElementById(
      symbol.getAttribute("aria-describedby") ?? ""
    );
    expect(help?.textContent).toContain(
      "Options runs use the daily series store"
    );
    expect(field("From").value).toBe("1970-01-05");
    expect(field("To").value).toBe("2026-11-10");
    expect(field("Initial capital").value).toBe("100000");
    // The options book charges its own costs: flat cost and profile are locked off.
    expect(field("Cost per side (bps)").value).toBe("0");
    expect(field("Cost per side (bps)").disabled).toBe(true);
    expect(field("Cost profile").disabled).toBe(true);
    expect(
      document.querySelector("[data-options-costs]")?.textContent
    ).toContain("$0.65 per contract per leg plus half the bid-ask spread");
    expect(field("Strategy (optional)").value).toBe("s-1");
    expect(field("Rule").value).toBe("definition");
    const linked = document.querySelector("[data-linked-definition]");
    expect(linked?.getAttribute("data-linked-definition")).toBe(
      "qc-asset-class-trend"
    );
    expect(linked?.textContent).toContain(
      "Strategy definition: qc-asset-class-trend revision 1 (sha aaaaaaaaaaaa…)"
    );
    expect(linked?.textContent).toContain("Black-Scholes");
    expect(field("Stop-loss (%)")).toBeNull();
    await settle(() => button("Run backtest").click());
    expect(gateway.submit).toHaveBeenCalledWith({
      costBps: 0,
      from: "1970-01-05",
      initialCapital: 100_000,
      rule: { definition: QC_DEFINITION, kind: "dsl" },
      strategyId: "s-1",
      symbol: "SPY",
      timeframe: "1d",
      to: todayUtc(),
    });
    await setNative(field("Symbol (daily series store, 1d)"), "QQQ");
    await settle(() => button("Run backtest").click());
    expect(gateway.submit).toHaveBeenLastCalledWith(
      expect.objectContaining({ symbol: "QQQ", timeframe: "1d" })
    );

    await setNative(field("Rule"), "breakout");
    // Back on stored bars: the universe and series selects return, with the series dates (the
    // store dates may lie outside its bars).
    expect(field("Symbol and timeframe").value).toBe("ES=F:1d");
    expect(field("From").value).toBe(isoDate(ES.firstT));
    expect(field("To").value).toBe(isoDate(ES.lastT));
    expect(document.querySelector("[data-linked-definition]")).toBeNull();
    expect(field("Entry lookback (bars)")).not.toBeNull();
    expect(field("Stop-loss (%)")).not.toBeNull();
    await setNative(field("Rule"), "definition");
    expect(field("Rule").value).toBe("definition");
    // The options dates return with the definition.
    expect(field("From").value).toBe("1970-01-05");
    expect(field("To").value).toBe("2026-11-10");
    await setNative(field("Rule"), "smaCross");
    expect(field("Fast average (bars)")).not.toBeNull();
    await setNative(field("Rule"), "definition");
    await setNative(field("Rule"), "breakout");
    // The rule kind kept while the definition was selected.
    expect(field("Entry lookback (bars)")).not.toBeNull();

    // Costs picked for another rule are not sent with the options definition.
    expect(field("Cost per side (bps)").disabled).toBe(false);
    expect(field("Cost per side (bps)").value).toBe("2");
    await setNative(field("Cost per side (bps)"), "3");
    await setNative(field("Cost profile"), "ibkr-pro-fixed-us-stock");
    await setNative(field("Rule"), "definition");
    expect(field("Cost profile").value).toBe("");
    await settle(() => button("Run backtest").click());
    expect(gateway.submit).toHaveBeenLastCalledWith(
      expect.objectContaining({ costBps: 0 })
    );
    expect(gateway.submit).toHaveBeenLastCalledWith(
      expect.not.objectContaining({ costProfile: expect.anything() })
    );
    await setNative(field("Rule"), "breakout");
    expect(field("Cost per side (bps)").value).toBe("3");
    expect(field("Cost profile").value).toBe("ibkr-pro-fixed-us-stock");
  });

  it("offers no batch run over the universe for an options definition", async () => {
    window.history.replaceState(
      null,
      "",
      "/backtest-runs?definition=qc&universe=core7-etf-twins"
    );
    const QQQ = { ...SPY, symbol: "QQQ" };
    await mount(
      <BacktestRunsWorkspace
        gateway={gatewayOf({
          definition: definitionGetter(),
          series: vi.fn(async () => [SPY, QQQ]),
        })}
      />
    );
    const batch = () =>
      [...document.querySelectorAll("button")].find((node) =>
        node.textContent?.startsWith("Run on every series")
      );
    expect(field("Universe")).toBeNull();
    expect(batch()).toBeUndefined();
    expect(document.querySelector("[data-universe-plan]")).toBeNull();
    expect(button("Run backtest").disabled).toBe(false);
    // Back on a plain rule, the universe and its batch run are offered again.
    await setNative(field("Rule"), "smaCross");
    expect(field("Universe").value).toBe("core7-etf-twins");
    expect(field("Symbol and timeframe").value).toBe("SPY:1d");
    expect(batch()?.hasAttribute("disabled")).toBe(false);
    expect(document.querySelector("[data-universe-plan]")?.textContent).toBe(
      "2 runs, 0 skipped"
    );
  });

  it("keeps the form defaults a link leaves out and its universe when the series is in it", async () => {
    window.history.replaceState(
      null,
      "",
      "/backtest-runs?definition=sma&symbol=ES%3DF"
    );
    await mount(
      <BacktestRunsWorkspace
        gateway={gatewayOf({
          definition: definitionGetter(
            StrategyDefinitionSchema.parse(STRATEGY_TEMPLATES.smaCross)
          ),
          series: vi.fn(async () => [ES, SPY]),
        })}
      />
    );
    expect(field("Universe").value).toBe("core7-futures");
    expect(field("Symbol and timeframe").value).toBe("ES=F:1d");
    expect(field("From").value).toBe("1970-01-01");
    expect(field("Initial capital").value).toBe("10000");
    const linked = document.querySelector("[data-linked-definition]");
    expect(linked?.textContent).toContain("revision 2");
    expect(linked?.textContent).not.toContain("Black-Scholes");
    expect(linked?.textContent).toContain("Research only; no orders.");
    for (const root of roots.splice(0)) await act(async () => root.unmount());
    document.body.replaceChildren();

    // Without a portfolio, a link symbol with no stored series keeps the default series.
    window.history.replaceState(
      null,
      "",
      "/backtest-runs?definition=sma&symbol=NOPE"
    );
    await mount(
      <BacktestRunsWorkspace
        gateway={gatewayOf({
          definition: definitionGetter(
            StrategyDefinitionSchema.parse(STRATEGY_TEMPLATES.smaCross)
          ),
          series: vi.fn(async () => [ES, SPY]),
        })}
      />
    );
    expect(field("Universe").value).toBe("core7-futures");
    expect(field("Symbol and timeframe").value).toBe("ES=F:1d");
    expect(field("Rule").value).toBe("definition");
    for (const root of roots.splice(0)) await act(async () => root.unmount());
    document.body.replaceChildren();

    // A link series outside the universe lists every stored series.
    window.history.replaceState(
      null,
      "",
      "/backtest-runs?definition=sma&symbol=SPY"
    );
    await mount(
      <BacktestRunsWorkspace
        gateway={gatewayOf({
          definition: definitionGetter(
            StrategyDefinitionSchema.parse(STRATEGY_TEMPLATES.smaCross)
          ),
          series: vi.fn(async () => [ES, SPY]),
        })}
      />
    );
    expect(field("Universe").value).toBe("all");
    expect(field("Symbol and timeframe").value).toBe("SPY:1d");
    expect(field("To").value).toBe("1970-04-10");
    for (const root of roots.splice(0)) await act(async () => root.unmount());
    document.body.replaceChildren();

    // An options definition runs on a portfolio member even without stored bars for it: a
    // non-member link symbol takes the first member.
    window.history.replaceState(
      null,
      "",
      "/backtest-runs?definition=qc&symbol=NOPE"
    );
    await mount(
      <BacktestRunsWorkspace
        gateway={gatewayOf({
          definition: definitionGetter(),
          series: vi.fn(async () => [ES]),
        })}
      />
    );
    expect(field("Symbol (daily series store, 1d)").value).toBe("SPY");
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(document.querySelector('[role="status"]')).toBeNull();
    expect(button("Run backtest").disabled).toBe(false);
    for (const root of roots.splice(0)) await act(async () => root.unmount());
    document.body.replaceChildren();

    // Link dates outside the stored bars are kept as they are (the store slices to them).
    window.history.replaceState(
      null,
      "",
      "/backtest-runs?definition=qc&symbol=QQQ&from=1960-01-04&to=2026-11-06"
    );
    const gateway = gatewayOf({
      definition: definitionGetter(),
      series: vi.fn(async () => [SPY]),
    });
    await mount(<BacktestRunsWorkspace gateway={gateway} />);
    expect(field("Symbol (daily series store, 1d)").value).toBe("QQQ");
    expect(field("From").value).toBe("1960-01-04");
    expect(field("To").value).toBe("2026-11-06");
    await settle(() => button("Run backtest").click());
    expect(gateway.submit).toHaveBeenCalledWith(
      expect.objectContaining({
        from: "1960-01-04",
        symbol: "QQQ",
        timeframe: "1d",
        to: "2026-11-06",
      })
    );
  });

  it("ignores a definition link without a definitions API", async () => {
    window.history.replaceState(null, "", "/backtest-runs?definition=qc");
    await mount(<BacktestRunsWorkspace gateway={gatewayOf()} />);
    expect(field("Rule").value).toBe("smaCross");
    expect(document.querySelector("[data-linked-definition]")).toBeNull();
  });

  it("reports a definition that cannot be loaded", async () => {
    window.history.replaceState(null, "", "/backtest-runs?definition=missing");
    await mount(
      <BacktestRunsWorkspace
        gateway={gatewayOf({
          definition: vi.fn(async () =>
            Promise.reject({ code: "NOT_FOUND", message: "not found" })
          ),
        })}
      />
    );
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "The strategy definition missing could not be loaded."
    );
    expect(field("Rule").value).toBe("smaCross");
  });

  it("ignores a definition that arrives after unmount", async () => {
    window.history.replaceState(null, "", "/backtest-runs?definition=qc");
    const loaded = deferred<StrategyDefinitionGetOutput>();
    const failed = deferred<never>();
    await mount(
      <BacktestRunsWorkspace
        gateway={gatewayOf({ definition: vi.fn(() => loaded.promise) })}
      />
    );
    await mount(
      <BacktestRunsWorkspace
        gateway={gatewayOf({ definition: vi.fn(() => failed.promise) })}
      />
    );
    for (const root of roots.splice(0)) await act(async () => root.unmount());
    await act(async () => {
      loaded.resolve(await definitionGetter()("qc"));
      failed.reject(new Error("late"));
      await flush();
    });
    expect(document.body.textContent).toBe("");
  });

  it("reads definitions through the browser API client", async () => {
    const fetch = vi.fn(async () => Promise.reject(new TypeError("offline")));
    vi.stubGlobal("fetch", fetch);
    try {
      const gateway = createBrowserBacktestRunsGateway();
      await expect(gateway.definition?.("qc")).rejects.toBeDefined();
      await expect(gateway.definition?.("qc", 2)).rejects.toBeDefined();
      expect(fetch).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
