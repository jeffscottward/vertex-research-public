// @vitest-environment jsdom
import {
  type BacktestRun,
  type BacktestRunReportOutput,
  type InstantBacktestSeries,
  STRATEGY_TEMPLATES,
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
  describeRevision,
  describeUniverseBatch,
  describeUniversePlan,
  isFinished,
  isoDate,
  COST_PROFILE_OPTIONS,
  costRows,
  isCostProfilePresetId,
  metricRows,
  replayGeometry,
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
  return { promise, resolve, reject };
};

const DAY_MS = 86_400_000;
const SPY: InstantBacktestSeries = {
  symbol: "SPY",
  timeframe: "1d",
  source: "Test daily source",
  sourceSha256: "e".repeat(64),
  barCount: 100,
  firstT: 0,
  lastT: 99 * DAY_MS,
  importedAt: "2026-10-18T00:00:00.000Z",
};
const ES: InstantBacktestSeries = { ...SPY, symbol: "ES=F" };
const NQ: InstantBacktestSeries = {
  ...SPY,
  symbol: "NQ=F",
  firstT: 10 * DAY_MS,
  lastT: 20 * DAY_MS,
};
const CL: InstantBacktestSeries = {
  ...SPY,
  symbol: "CL=F",
  firstT: 200 * DAY_MS,
  lastT: 300 * DAY_MS,
};
const TEST: InstantBacktestSeries = { ...SPY, symbol: "TEST" };

const report: BacktestRunReportOutput = {
  bars: 3,
  firstT: 0,
  lastT: 2 * DAY_MS,
  seriesSha256: "e".repeat(64),
  metrics: {
    initialDeposit: 10_000,
    finalEquity: 10_500,
    netProfit: 500,
    grossProfit: 700,
    grossLoss: -200,
    profitFactor: 3.5,
    expectedPayoff: 250,
    totalTrades: 2,
    profitTrades: 1,
    lossTrades: 1,
    winRate: 0.5,
    largestProfitTrade: 700,
    largestLossTrade: -200,
    averageProfitTrade: 700,
    averageLossTrade: -200,
    maxConsecutiveWins: 1,
    maxConsecutiveLosses: 1,
    maxConsecutiveLossesMoney: -200,
    maximalConsecutiveLoss: -200,
    maximalConsecutiveLossCount: 1,
    absoluteDrawdown: 0,
    maxDrawdownAbs: 200,
    maxDrawdownPct: 0.02,
    recoveryFactor: 2.5,
    sharpe: null,
    sortino: 1.2,
    totalReturn: 0.05,
    cagr: null,
    exposure: 0.5,
    buyHoldReturn: 0.1,
  },
  equity: [
    { t: 0, equity: 10_000, drawdownPct: 0 },
    { t: DAY_MS, equity: 9800, drawdownPct: 0.02 },
    { t: 2 * DAY_MS, equity: 10_500, drawdownPct: 0 },
  ],
  prices: [
    { t: 0, o: 10, h: 11, l: 9, c: 10 },
    { t: DAY_MS, o: 10, h: 12, l: 9, c: 11 },
    { t: 2 * DAY_MS, o: 11, h: 13, l: 10, c: 12 },
  ],
  trades: [
    {
      n: 1,
      entryT: 0,
      exitT: DAY_MS,
      entryPrice: 10,
      exitPrice: 9.8,
      units: 1000,
      pnl: -200,
      netReturn: -0.02,
      exitReason: "stop",
      balanceAfter: 9800,
    },
    {
      n: 2,
      entryT: DAY_MS,
      exitT: 2 * DAY_MS,
      entryPrice: 11,
      exitPrice: 12,
      units: 700,
      pnl: 700,
      netReturn: 0.07,
      exitReason: "signal",
      balanceAfter: 10_500,
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
  id: "run-1",
  status: "succeeded",
  strategyId: null,
  strategyRevision: null,
  strategySnapshot: null,
  spec: {
    symbol: "SPY",
    timeframe: "1d",
    from: "1970-01-01",
    to: "1970-04-10",
    rule: { kind: "smaCross", fast: 50, slow: 200 },
    stopLossPct: 0,
    takeProfitPct: 0,
    costBps: 2,
    initialCapital: 10_000,
  },
  engineVersion: "instant-1",
  error: null,
  createdAt: new Date(0),
  startedAt: null,
  finishedAt: null,
  report,
  ...overrides,
});

const gatewayOf = (
  overrides: Partial<BacktestRunsGateway> = {}
): BacktestRunsGateway => ({
  series: vi.fn(async () => [SPY]),
  strategies: vi.fn(async () => [{ id: "s-1", name: "SMA cross" }]),
  submit: vi.fn(async () => runOf({ status: "queued", report: null })),
  get: vi.fn(async () => runOf()),
  list: vi.fn(async () => [runOf()]),
  ...overrides,
});

describe("backtest runs model", () => {
  const form = {
    params: DEFAULT_INSTANT_PARAMS,
    from: "1970-01-01",
    to: "1970-04-10",
    initialCapital: 5000,
    strategyId: "",
    costProfile: "" as const,
  };

  it("builds the submit request or explains the error", () => {
    expect(toSubmitInput(form, SPY)).toEqual({
      input: expect.objectContaining({
        symbol: "SPY",
        from: "1970-01-01",
        to: "1970-04-10",
        initialCapital: 5000,
        strategyId: null,
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
          slug: "s",
          name: "SMA",
          kind: "native",
          sourceRef: null,
          params: [],
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
        n: 1,
        x1: 0,
        x2: 50,
        win: false,
        current: true,
      }),
    ]);
    expect(geometry.cursorX).toBe(50);
    expect(replayGeometry(report, 0, 100, 40).cursorX).toBeNull();
    expect(replayGeometry({ prices: [], trades: [] }, 1, 100, 40)).toEqual({
      path: "",
      markers: [],
      cursorX: null,
    });
    const flat = replayGeometry(
      {
        prices: [
          { t: 0, o: 1, h: 1, l: 1, c: 1 },
          { t: 1, o: 1, h: 1, l: 1, c: 1 },
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
      instantBacktest: { series: vi.fn(async () => ({ series: [SPY] })) },
      strategyLibrary: {
        list: vi.fn(async () => ({
          strategies: [{ id: "s-1", name: "A", slug: "a" }],
        })),
      },
      backtestRuns: {
        submit: vi.fn(async () => runOf()),
        get: vi.fn(async () => runOf()),
        list: vi.fn(async () => ({ runs: [runOf()] })),
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
          ? runOf({ status: "running", report: null })
          : runOf({ report: { ...report, costs: COSTS } });
      }),
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
        strategyId: "s-1",
        initialCapital: 25_000,
        costProfile: "ibkr-pro-fixed-us-stock",
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
        from: "1970-01-05",
        to: "1970-02-01",
        stopLossPct: 5,
        takeProfitPct: 10,
        costBps: 1,
        rule: { kind: "smaCross", fast: 250, slow: 300 },
      })
    );
    expect(document.querySelector('[role="alert"]')?.textContent).toBeTruthy();
  });

  it("opens the run named in the URL", async () => {
    const gateway = gatewayOf();
    window.history.replaceState(null, "", "/backtest-runs?run=run-9");
    try {
      await mount(<BacktestRunsWorkspace gateway={gateway} />);
    } finally {
      window.history.replaceState(null, "", "/");
    }
    expect(gateway.get).toHaveBeenCalledWith("run-9");
    window.history.replaceState(null, "", "/backtest-runs?run=");
    const empty = gatewayOf();
    try {
      await mount(<BacktestRunsWorkspace gateway={empty} />);
    } finally {
      window.history.replaceState(null, "", "/");
    }
    expect(empty.get).not.toHaveBeenCalled();
  });

  it("opens a listed run and shows failed and pending runs", async () => {
    const gateway = gatewayOf({
      list: vi.fn(async () => [
        runOf({
          id: "run-2",
          strategySnapshot: {
            id: "s-1",
            slug: "a",
            name: "Breakout A",
            kind: "native",
            sourceRef: null,
            params: [],
            updatedAt: "x",
          },
          spec: {
            ...runOf().spec,
            rule: {
              kind: "breakout",
              entryLookback: 20,
              exitLookback: 10,
              trendSma: 50,
            },
          },
        }),
        runOf({
          id: "run-3",
          spec: {
            ...runOf().spec,
            rule: {
              kind: "breakout",
              entryLookback: 5,
              exitLookback: 3,
              trendSma: 0,
            },
          },
        }),
        runOf({
          id: "run-4",
          spec: {
            ...runOf().spec,
            rule: {
              kind: "dsl",
              definition: StrategyDefinitionSchema.parse(
                STRATEGY_TEMPLATES.smaCross
              ),
            },
          },
        }),
      ]),
      get: vi.fn(async (id: string) =>
        id === "run-2"
          ? runOf({
              status: "failed",
              error: "No stored 1d bars",
              report: null,
            })
          : runOf({ status: "queued", report: null })
      ),
    });
    await mount(
      <BacktestRunsWorkspace
        gateway={gateway}
        initialRunId="run-1"
        pollMs={60_000}
      />
    );
    expect(document.body.textContent).toContain("The backtest is queued.");
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
      symbol: "QQQ",
      firstT: 10 * DAY_MS,
      lastT: 20 * DAY_MS,
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
    const submit = vi.fn(async () => runOf({ status: "queued", report: null }));
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
      return runOf({ status: "queued", report: null });
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
        status: "running",
        report: { ...report, tradesTruncated: true },
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
      series: vi.fn(() => series.promise),
      get: vi.fn(() => {
        calls += 1;
        return calls === 1 ? read.promise : failedRead.promise;
      }),
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
          series: vi.fn(async () => []),
          list: vi.fn(async () => Promise.reject(new Error("x"))),
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
