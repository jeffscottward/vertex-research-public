// @vitest-environment jsdom
import {
  assessSweepRobustness,
  type BacktestRun,
  type BacktestSweepOutput,
  type BacktestSweepParam,
  type InstantBacktestSeries,
  sweepCoordinates,
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
  cellSubmitInput,
  defaultAxes,
  defaultDimensions,
  describeCell,
  formatSweepMetric,
  heatmapView,
  moveAxis,
  robustnessFor,
  type SweepForm,
  toSweepInput,
} from "./backtest-sweeps-model.ts";
import {
  type BacktestSweepsGateway,
  BacktestSweepsWorkspace,
  createBacktestSweepsGateway,
  createBrowserBacktestSweepsGateway,
} from "./backtest-sweeps-workspace.tsx";
import { DEFAULT_INSTANT_PARAMS } from "./instant-backtest-workspace.tsx";

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
const cellButton = (prefix: string) =>
  [...document.querySelectorAll("[data-sweep-heatmap] button")].find((node) =>
    node.getAttribute("aria-label")?.startsWith(prefix)
  ) as HTMLButtonElement;
const click = (target: HTMLElement) => settle(() => target.click());
const text = () => document.body.textContent ?? "";

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
const QQQ: InstantBacktestSeries = {
  ...SPY,
  firstT: 10 * DAY_MS,
  lastT: 50 * DAY_MS,
  symbol: "QQQ",
};

/** Builds a sweep output whose totalReturn is `values`; null marks a rejected cell. */
const outputOf = (
  dimensions: readonly Readonly<{
    param: BacktestSweepParam;
    values: number[];
  }>[],
  values: readonly (number | null)[]
): BacktestSweepOutput => {
  const shape = dimensions.map((dimension) => dimension.values.length);
  const robustness = assessSweepRobustness(shape, values);
  return {
    bars: 100,
    cells: values.map((value, index) => {
      const coordinates = sweepCoordinates(index, shape);
      return {
        coordinates,
        error: value === null ? "fast must be shorter than slow" : null,
        metrics: {
          cagr: value,
          maxDrawdown: value === null ? null : -0.1,
          profitFactor: value === null ? null : 1.5,
          // Sharpe ranks the cells in the opposite order to total return.
          sharpe: value === null ? null : 1 - value,
          sortino: null,
          totalReturn: value,
          winRate: value === null ? null : 0.5,
        },
        params: coordinates.map(
          (position, dimension) =>
            dimensions[dimension]?.values[position] as number
        ),
        robustness: {
          neighbourMean: robustness.neighbourMean[index] as number | null,
          neighbours: robustness.neighbours[index] as number,
          rank: robustness.rank[index] as number | null,
          spike: robustness.spike[index] as boolean,
          worst: robustness.worst[index] as number | null,
        },
        trades: value === null ? null : 4,
      };
    }),
    computeMs: 12,
    dimensions: dimensions.map((dimension) => ({ ...dimension })),
    engineVersion: "instant-1",
    firstT: 0,
    from: "1970-01-01",
    lastT: 99 * DAY_MS,
    metric: "totalReturn",
    ranking: [...robustness.ranking],
    seriesSha256: "e".repeat(64),
    spikeRatio: 0.5,
    symbol: "SPY",
    timeframe: "1d",
    to: "1970-04-10",
  };
};

// fast \ slow   20     30     40
// 10           0.05   0.10   0.12
// 20           --     0.80   0.11    <- 0.80 is an isolated spike
// 30           --     --     0.13
const GRID = outputOf(
  [
    { param: "fast", values: [10, 20, 30] },
    { param: "slow", values: [20, 30, 40] },
  ],
  [0.05, 0.1, 0.12, null, 0.8, 0.11, null, null, 0.13]
);

const runOf = (id: string): BacktestRun =>
  ({ id, status: "queued" }) as unknown as BacktestRun;

const gatewayOf = (
  overrides: Partial<BacktestSweepsGateway> = {}
): BacktestSweepsGateway => ({
  series: vi.fn(async () => [SPY, QQQ]),
  submit: vi.fn(async () => runOf("run-9")),
  sweep: vi.fn(async () => GRID),
  ...overrides,
});

const form: SweepForm = {
  dimensions: defaultDimensions("smaCross"),
  from: "1970-01-01",
  metric: "sharpe",
  params: DEFAULT_INSTANT_PARAMS,
  to: "1970-04-10",
};

describe("parameter sweep model", () => {
  it("builds the sweep request with defaults or names the first problem", () => {
    const built = toSweepInput(form, SPY);
    expect(built).toEqual({
      input: {
        costBps: 2,
        dimensions: [
          { from: 5, param: "fast", step: 5, to: 30 },
          { from: 40, param: "slow", step: 20, to: 200 },
        ],
        from: "1970-01-01",
        metric: "sharpe",
        rule: { fast: 50, kind: "smaCross", slow: 200 },
        stopLossPct: 0,
        symbol: "SPY",
        takeProfitPct: 0,
        timeframe: "1d",
        to: "1970-04-10",
      },
    });
    expect(
      toSweepInput({ ...form, params: { ...form.params, fast: 0 } }, SPY)
    ).toEqual({
      error: "Fast average (bars) must be a whole number from 1 to 500.",
    });
    expect(
      toSweepInput(
        {
          ...form,
          dimensions: [
            { from: 5, param: "fast", step: 5, to: 30 },
            { from: 40, param: "slow", step: 0.5, to: 200 },
          ],
        },
        SPY
      )
    ).toEqual({ error: "Dimension 2: slow needs whole numbers." });
    return expect(toSweepInput({ ...form, from: "1970-05-01" }, SPY)).toEqual({
      error: "from must not be after to.",
    });
  });

  it("formats percent and ratio metrics and describes cells", () => {
    expect(formatSweepMetric("totalReturn", 0.1234)).toBe("12.3%");
    expect(formatSweepMetric("maxDrawdown", -0.05)).toBe("-5.0%");
    expect(formatSweepMetric("sharpe", 1.234)).toBe("1.23");
    expect(formatSweepMetric("profitFactor", null)).toBe("n/a");
    expect(defaultDimensions("breakout").map((entry) => entry.param)).toEqual([
      "entryLookback",
      "exitLookback",
    ]);
    return expect(describeCell(GRID, 5)).toBe("fast 20, slow 40");
  });

  it("starts the heatmap at the best-ranked cell and swaps axes on conflict", () => {
    const axes = defaultAxes(GRID);
    expect(axes).toEqual({ fixed: [2, 2], x: 1, y: 0 });
    expect(moveAxis(axes, "x", 0)).toEqual({ fixed: [2, 2], x: 0, y: 1 });
    expect(moveAxis(axes, "y", 1)).toEqual({ fixed: [2, 2], x: 0, y: 1 });
    expect(moveAxis({ fixed: [0, 0, 0], x: 2, y: 0 }, "x", 1)).toEqual({
      fixed: [0, 0, 0],
      x: 1,
      y: 0,
    });
    const line = outputOf([{ param: "fast", values: [5, 10] }], [null, null]);
    return expect(defaultAxes(line)).toEqual({ fixed: [0], x: 0, y: null });
  });

  it("projects the slice with shading, spikes and the worst-neighbour mode", () => {
    const robustness = robustnessFor(GRID, "totalReturn");
    const view = heatmapView(
      GRID,
      robustness,
      "totalReturn",
      "value",
      defaultAxes(GRID)
    );
    expect(view.xValues).toEqual([20, 30, 40]);
    expect(view.yValues).toEqual([10, 20, 30]);
    const spike = view.rows[1]?.[1];
    expect(spike).toMatchObject({ index: 4, spike: true, value: 0.8 });
    expect(spike?.heat).toBe("bg-primary/60");
    expect(view.rows[1]?.[0]).toMatchObject({
      error: "fast must be shorter than slow",
      heat: "",
      rank: null,
      value: null,
    });
    const worst = heatmapView(
      GRID,
      robustness,
      "totalReturn",
      "worst",
      defaultAxes(GRID)
    );
    expect(worst.rows[1]?.[1]?.value).toBe(0.1);
    const empty = outputOf([{ param: "fast", values: [5, 10] }], [null, null]);
    const blank = heatmapView(
      empty,
      robustnessFor(empty, "sharpe"),
      "sharpe",
      "value",
      defaultAxes(empty)
    );
    expect(blank.yValues).toEqual([null]);
    return expect(blank.rows[0]?.map((cell) => cell.heat)).toEqual(["", ""]);
  });

  it("holds the other dimensions at their fixed values in a 3-D sweep", () => {
    const cube = outputOf(
      [
        { param: "fast", values: [5, 10] },
        { param: "slow", values: [20, 30] },
        { param: "stopLossPct", values: [1, 2] },
      ],
      [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]
    );
    const view = heatmapView(
      cube,
      robustnessFor(cube, "totalReturn"),
      "totalReturn",
      "value",
      { fixed: [0, 0, 1], x: 1, y: 0 }
    );
    return expect(
      view.rows.map((row) => row.map((cell) => cell.index))
    ).toEqual([
      [1, 3],
      [5, 7],
    ]);
  });

  it("re-ranks for another metric and builds the full-run request for one cell", () => {
    expect(robustnessFor(GRID, "totalReturn").ranking[0]).toBe(8);
    expect(robustnessFor(GRID, "sharpe").ranking[0]).toBe(0);
    const request = toSweepInput(form, SPY);
    if ("error" in request) throw new Error(request.error);
    expect(cellSubmitInput(request.input, GRID, 5)).toEqual({
      costBps: 2,
      from: "1970-01-01",
      rule: { fast: 20, kind: "smaCross", slow: 40 },
      stopLossPct: 0,
      symbol: "SPY",
      takeProfitPct: 0,
      timeframe: "1d",
      to: "1970-04-10",
    });
  });

  it("maps the API client calls", async () => {
    const client = {
      backtestRuns: {
        submit: vi.fn(async () => runOf("run-1")),
        sweep: vi.fn(async () => GRID),
      },
      instantBacktest: { series: vi.fn(async () => ({ series: [SPY] })) },
    };
    const gateway = createBacktestSweepsGateway(client as never);
    await expect(gateway.series()).resolves.toEqual([SPY]);
    await expect(gateway.sweep({} as never)).resolves.toBe(GRID);
    await gateway.submit({} as never);
    expect(client.backtestRuns.submit).toHaveBeenCalledTimes(1);
  });
});

describe("BacktestSweepsWorkspace", () => {
  it("runs a sweep, shows the heatmap and queues a full backtest for a cell", async () => {
    const gateway = gatewayOf();
    await mount(<BacktestSweepsWorkspace gateway={gateway} />);
    expect(field("From").value).toBe("1970-01-01");
    await click(button("Run sweep"));
    expect(gateway.sweep).toHaveBeenCalledWith(
      expect.objectContaining({
        dimensions: defaultDimensions("smaCross"),
        metric: "totalReturn",
        symbol: "SPY",
      })
    );
    expect(text()).toContain("9 cells over 100 bars");
    expect(text()).toContain("1 isolated spike for total return");
    expect(
      document.querySelectorAll("[data-sweep-heatmap] [data-spike]")
    ).toHaveLength(1);
    expect(cellButton("fast 20, slow 30").getAttribute("aria-label")).toContain(
      "isolated spike"
    );
    // The best-ranked cell is selected first.
    expect(text()).toContain("Cell: fast 30, slow 40");
    expect(cellButton("fast 30, slow 40").getAttribute("aria-pressed")).toBe(
      "true"
    );

    await click(cellButton("fast 20, slow 30"));
    expect(text()).toContain("Isolated spike: the neighbours average less");
    await click(button("Run full backtest"));
    expect(gateway.submit).toHaveBeenCalledWith(
      expect.objectContaining({
        rule: { fast: 20, kind: "smaCross", slow: 30 },
        symbol: "SPY",
      })
    );
    const link = [...document.querySelectorAll("a")].find(
      (node) => node.textContent === "Open the backtest report"
    );
    expect(link?.getAttribute("href")).toBe("/backtest-runs?run=run-9");
    expect(button("Run full backtest").disabled).toBe(true);

    await click(cellButton("fast 20, slow 20"));
    expect(text()).toContain("Not run: fast must be shorter than slow");
    expect(text()).toContain("Robust ranknot ranked");
    expect(button("Run full backtest").disabled).toBe(true);
  });

  it("re-ranks by metric, colours by the worst neighbour and swaps axes", async () => {
    await mount(<BacktestSweepsWorkspace gateway={gatewayOf()} />);
    await click(button("Run sweep"));
    const ranked = () =>
      [
        ...document.querySelectorAll(
          '[aria-label="Most robust cells"] tbody button'
        ),
      ].map((node) => node.textContent);
    expect(ranked()[0]).toBe("fast 30, slow 40");
    await setNative(field("Metric"), "sharpe");
    expect(ranked()[0]).toBe("fast 10, slow 20");
    expect(text()).toContain("for sharpe ratio");
    // The selection follows the best cell for the new metric.
    expect(text()).toContain("Cell: fast 10, slow 20");
    await setNative(field("Colour by"), "worst");
    expect(text()).toContain("(worst in neighbourhood)");
    await setNative(field("Colour by"), "value");
    await setNative(field("Columns"), "0");
    expect(field("Rows").value).toBe("1");
    await setNative(field("Rows"), "0");
    expect(field("Columns").value).toBe("1");
    const rows = document.querySelectorAll(
      '[aria-label="Most robust cells"] tbody tr'
    );
    expect(rows).toHaveLength(6);
    await click(button("fast 20, slow 30"));
    expect(text()).toContain("Cell: fast 20, slow 30");
  });

  it("shows fixed values for extra dimensions and handles a grid without ranked cells", async () => {
    const cube = outputOf(
      [
        { param: "fast", values: [5, 10] },
        { param: "slow", values: [20, 30] },
        { param: "stopLossPct", values: [1, 2] },
      ],
      [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]
    );
    const sweep = vi.fn(async () => cube);
    await mount(<BacktestSweepsWorkspace gateway={gatewayOf({ sweep })} />);
    await click(button("Run sweep"));
    // Columns show the last dimension, rows the first; slow is held at the best cell's value.
    expect(field("Fixed Slow average").value).toBe("1");
    expect(text()).toContain("Cell: fast 10, slow 30, stopLossPct 2");
    expect(cellButton("fast 10, slow 20, stopLossPct 2")).toBeUndefined();
    await setNative(field("Fixed Slow average"), "0");
    expect(cellButton("fast 10, slow 20, stopLossPct 2")).toBeDefined();

    sweep.mockResolvedValueOnce(
      outputOf([{ param: "fast", values: [5, 10] }], [null, null])
    );
    await click(button("Run sweep"));
    expect(text()).toContain("0 isolated spikes");
    expect(document.querySelector('[aria-label="Selected cell"]')).toBeNull();
    expect(cellButton("fast 5").getAttribute("aria-label")).toContain(
      "not ranked"
    );
    expect(field("Rows")).toBeNull();
    await setNative(field("Metric"), "sharpe");
    expect(document.querySelector('[aria-label="Selected cell"]')).toBeNull();
  });

  it("edits the grid: rule switch, add, change and remove dimensions", async () => {
    const gateway = gatewayOf();
    await mount(<BacktestSweepsWorkspace gateway={gateway} />);
    await setNative(field("Rule"), "breakout");
    expect(field("Dimension 1 parameter").value).toBe("entryLookback");
    expect(field("Trend average (bars, 0 = off)")).not.toBeNull();
    await click(button("Add dimension"));
    expect(field("Dimension 3 parameter").value).toBe("trendSma");
    expect(field("Dimension 3 to").value).toBe("4");
    await click(button("Add dimension"));
    expect(field("Dimension 4 parameter").value).toBe("stopLossPct");
    expect(button("Add dimension").disabled).toBe(true);
    await setNative(field("Dimension 4 parameter"), "takeProfitPct");
    await setNative(field("Dimension 4 from"), "2");
    await setNative(field("Dimension 4 to"), "6");
    await setNative(field("Dimension 4 step"), "2");
    await click(button("Remove dimension 3"));
    expect(field("Dimension 3 parameter").value).toBe("takeProfitPct");
    await setNative(field("Rule"), "smaCross");
    await setNative(field("Dimension 2 step"), "0.5");
    expect(text()).toContain("Dimension 2: slow needs whole numbers.");
    expect(button("Run sweep").disabled).toBe(true);
    const formNode = document.querySelector("form") as HTMLFormElement;
    await settle(() => formNode.requestSubmit());
    expect(gateway.sweep).not.toHaveBeenCalled();
    await click(button("Remove dimension 2"));
    expect(button("Remove dimension 1")).toBeUndefined();
    await click(button("Add dimension"));
    await click(button("Add dimension"));
    await click(button("Add dimension"));
    expect(button("Add dimension").disabled).toBe(true);
    for (const label of [
      "Fast average (bars)",
      "Slow average (bars)",
      "Stop-loss (%)",
      "Take-profit (%)",
      "Cost per side (bps)",
    ])
      await setNative(field(label), "3");
    await setNative(field("To"), "1970-02-01");
    await setNative(field("From"), "1970-01-05");
    await setNative(field("Symbol and timeframe"), "QQQ:1d");
    expect(field("From").value).toBe("1970-01-11");
    expect(field("To").value).toBe("1970-02-20");
  });

  it("reports sweep and full-run failures and allows a retry", async () => {
    const submit = vi
      .fn()
      .mockRejectedValueOnce(new Error("down"))
      .mockResolvedValueOnce(runOf("run-2"));
    const sweep = vi
      .fn()
      .mockRejectedValueOnce(new Error("busy"))
      .mockResolvedValue(GRID);
    await mount(
      <BacktestSweepsWorkspace gateway={gatewayOf({ submit, sweep })} />
    );
    await click(button("Run sweep"));
    expect(document.querySelector('[role="alert"]')).not.toBeNull();
    expect(document.querySelector('[aria-label="Sweep results"]')).toBeNull();
    await click(button("Run sweep"));
    await click(button("Run full backtest"));
    expect(
      document.querySelector('[aria-label="Selected cell"] [role="alert"]')
    ).not.toBeNull();
    await click(button("Run full backtest"));
    expect(text()).toContain("Open the backtest report");
  });

  it("shows the running state while a sweep and a full run are pending", async () => {
    const sweep = deferred<BacktestSweepOutput>();
    const submit = deferred<BacktestRun>();
    await mount(
      <BacktestSweepsWorkspace
        gateway={gatewayOf({
          submit: vi.fn(() => submit.promise),
          sweep: vi.fn(() => sweep.promise),
        })}
      />
    );
    await click(button("Run sweep"));
    expect(button("Running sweep…").disabled).toBe(true);
    await settle(() => sweep.resolve(GRID));
    await click(button("Run full backtest"));
    expect(button("Queuing…").disabled).toBe(true);
    await settle(() => submit.resolve(runOf("run-3")));
    expect(text()).toContain("Open the backtest report");
  });

  it("ignores series that arrive after unmount", async () => {
    const series = deferred<readonly InstantBacktestSeries[]>();
    await mount(
      <BacktestSweepsWorkspace
        gateway={gatewayOf({ series: vi.fn(() => series.promise) })}
      />
    );
    expect(text()).toContain("Loading series…");
    for (const root of roots.splice(0)) await act(async () => root.unmount());
    await act(async () => {
      series.resolve([SPY]);
      await flush();
    });
    const rejected = deferred<readonly InstantBacktestSeries[]>();
    await mount(
      <BacktestSweepsWorkspace
        gateway={gatewayOf({ series: vi.fn(() => rejected.promise) })}
      />
    );
    for (const root of roots.splice(0)) await act(async () => root.unmount());
    await act(async () => {
      rejected.reject(new Error("late"));
      await flush();
    });
    expect(text()).toBe("");
  });

  it("uses the browser API client by default", async () => {
    const fetch = vi.fn(async () => Promise.reject(new TypeError("offline")));
    vi.stubGlobal("fetch", fetch);
    await mount(<BacktestSweepsWorkspace />);
    expect(document.querySelector('[role="alert"]')).not.toBeNull();
    const gateway = createBrowserBacktestSweepsGateway();
    await expect(gateway.sweep({} as never)).rejects.toBeDefined();
    await expect(gateway.submit({} as never)).rejects.toBeDefined();
    expect(fetch).toHaveBeenCalledTimes(3);
    vi.unstubAllGlobals();
  });

  it("preselects Core 7 futures and its first stored series, and follows a universe change", async () => {
    const ES: InstantBacktestSeries = {
      ...SPY,
      firstT: 5 * DAY_MS,
      lastT: 60 * DAY_MS,
      symbol: "ES=F",
    };
    const TEST: InstantBacktestSeries = { ...SPY, symbol: "TEST" };
    await mount(
      <BacktestSweepsWorkspace
        gateway={gatewayOf({
          series: vi.fn(async () => [
            { ...SPY, symbol: "BTCUSDT", timeframe: "1m" as const },
            ES,
            SPY,
            TEST,
          ]),
        })}
      />
    );
    const options = () =>
      [...field("Symbol and timeframe").options].map((option) => option.value);
    expect(field("Universe").value).toBe("core7-futures");
    expect(field("Symbol and timeframe").value).toBe("ES=F:1d");
    expect(options()).toEqual(["ES=F:1d"]);
    expect(field("From").value).toBe("1970-01-06");
    expect(field("To").value).toBe("1970-03-02");
    await setNative(field("Universe"), "core7-etf-twins");
    expect(options()).toEqual(["SPY:1d"]);
    expect(field("From").value).toBe("1970-01-01");
    expect(field("To").value).toBe("1970-04-10");
    await setNative(field("Universe"), "all");
    expect(options()).toHaveLength(4);
    expect(field("Symbol and timeframe").value).toBe("BTCUSDT:1m");
  });

  it("keeps the universe choice when the series list reloads", async () => {
    const ES: InstantBacktestSeries = { ...SPY, symbol: "ES=F" };
    await mount(
      <BacktestSweepsWorkspace
        gateway={gatewayOf({ series: vi.fn(async () => [ES, SPY]) })}
      />
    );
    await setNative(field("Universe"), "core7-etf-twins");
    const root = roots.at(-1);
    await settle(() =>
      root?.render(
        <BacktestSweepsWorkspace
          gateway={gatewayOf({ series: vi.fn(async () => [ES, SPY]) })}
        />
      )
    );
    expect(field("Universe").value).toBe("core7-etf-twins");
    expect(field("Symbol and timeframe").value).toBe("SPY:1d");
  });

  it("shows every stored series when no Core 7 future is stored", async () => {
    await mount(<BacktestSweepsWorkspace gateway={gatewayOf()} />);
    expect(field("Universe").value).toBe("core7-futures");
    expect(field("Symbol and timeframe").value).toBe("SPY:1d");
    expect(field("Symbol and timeframe").options).toHaveLength(2);
    expect(text()).toContain(
      "No stored bars for Core 7 futures yet. Showing all stored series."
    );
    await setNative(field("Universe"), "core7-etf-twins");
    expect(
      [...field("Symbol and timeframe").options].map((option) => option.value)
    ).toEqual(["SPY:1d", "QQQ:1d"]);
  });

  it("shows empty, forbidden and error states", async () => {
    await mount(
      <BacktestSweepsWorkspace
        gateway={gatewayOf({ series: vi.fn(async () => []) })}
      />
    );
    expect(text()).toContain("No stored bar series.");
    expect(button("Run sweep").disabled).toBe(true);
    document.body.replaceChildren();

    await mount(
      <BacktestSweepsWorkspace
        gateway={gatewayOf({
          series: vi.fn(async () =>
            Promise.reject({ code: "FORBIDDEN", message: "Operator" })
          ),
        })}
      />
    );
    expect(text()).toContain("Backtest runs are limited to operators.");
    document.body.replaceChildren();

    await mount(
      <BacktestSweepsWorkspace
        gateway={gatewayOf({
          series: vi.fn(async () => Promise.reject(new Error("down"))),
        })}
      />
    );
    expect(document.querySelector('[role="alert"]')).not.toBeNull();
  });
});
