// @vitest-environment jsdom
import type {
  EngineComparisonRun,
  InstantBacktestRunInput,
  InstantBacktestRunOutput,
  InstantBacktestSeries,
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
  DEFAULT_INSTANT_PARAMS,
  formatPercent,
  formatRatio,
  type InstantBacktestGateway,
  InstantBacktestWorkspace,
  toRunInput,
} from "./instant-backtest-workspace.tsx";
import type { EngineComparisonGateway } from "./engine-comparison.tsx";

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
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

const flush = async () => {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
};

const mount = async (element: ReactElement) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(element);
    await flush();
  });
  return { container, root };
};

const DAY_MS = 86_400_000;
const SPY: InstantBacktestSeries = {
  symbol: "SPY",
  timeframe: "1d",
  source: "Test daily source",
  sourceSha256: "e".repeat(64),
  barCount: 8487,
  firstT: 0,
  lastT: 100 * DAY_MS,
  importedAt: "2026-10-18T12:00:00.000Z",
};
const BTC: InstantBacktestSeries = {
  ...SPY,
  symbol: "BTCUSDT",
  timeframe: "1m",
  barCount: 525_600,
};

const output = (
  input: InstantBacktestRunInput,
  totalReturn: number
): InstantBacktestRunOutput => ({
  series: input.symbol === "SPY" ? SPY : BTC,
  stats: {
    bars: 8487,
    totalReturn,
    cagr: 0.0928,
    maxDrawdown: -0.38,
    sharpe: 0.72,
    sortino: null,
    trades: 18,
    winRate: 0.72,
    profitFactor: null,
    exposure: 0.75,
    buyHoldReturn: 30.7,
    buyHoldMaxDrawdown: -0.55,
  },
  equity: [
    { t: 0, equity: 1 },
    { t: 100 * DAY_MS, equity: 1 + totalReturn },
  ],
  timing: { cache: "hit", loadMs: 0.4, computeMs: 1.25 },
});

type Pending = Readonly<{
  input: InstantBacktestRunInput;
  resolve: (value: InstantBacktestRunOutput) => void;
  reject: (error: unknown) => void;
}>;

const controlledGateway = (
  seriesResult: () => Promise<{ series: InstantBacktestSeries[] }>
) => {
  const pending: Pending[] = [];
  const gateway: InstantBacktestGateway = {
    series: vi.fn(seriesResult),
    // The web tsconfig targets a lib without Promise.withResolvers, so the executor form stays.
    run: vi.fn(
      (input: InstantBacktestRunInput) =>
        new Promise<InstantBacktestRunOutput>((resolve, reject) => {
          pending.push({ input, resolve, reject });
        })
    ),
  };
  return { gateway, pending };
};

const settle = async (work: () => void) => {
  await act(async () => {
    work();
    await flush();
  });
};

const setNative = async (
  element: HTMLInputElement | HTMLSelectElement,
  value: string,
  eventName: "input" | "change"
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
    element.dispatchEvent(new Event(eventName, { bubbles: true }));
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

const statText = (label: string) =>
  document.querySelector(`[data-stat="${label}"] dd`)?.textContent;

const statusText = () =>
  document.querySelector("[data-instant-status]")?.textContent ?? "";

/** One Nautilus comparison run as backtestRuns.comparisons.list returns it. */
const nautilusRun = (
  overrides: Partial<EngineComparisonRun> = {}
): EngineComparisonRun => ({
  comparison: {
    feature: "instant",
    groupId: "g-1",
    label: "SPY 1d smaCross",
    typescript: {
      host: "QuantVPS web",
      stats: {
        bars: 2,
        buyHoldMaxDrawdown: 0,
        buyHoldReturn: 0,
        cagr: null,
        exposure: 0,
        maxDrawdown: 0,
        profitFactor: null,
        sharpe: null,
        sortino: null,
        totalReturn: 0,
        trades: 0,
        winRate: null,
      },
      tradeCount: 0,
      trades: [],
      wallMs: 1,
    },
  },
  createdAt: new Date(0),
  differences: { items: [], ok: true },
  engineRun: {
    cpuMs: 10,
    gpu: "not used (Nautilus engine is CPU-only)",
    host: "rig-1",
    processCases: 1,
    processes: 1,
    processWallMs: 500,
    wallMs: 400,
  },
  engineVersion: "nautilus-trader-1.227.0",
  error: null,
  finishedAt: new Date(1000),
  from: "1970-01-01",
  id: "n-1",
  queueWaitMs: 2000,
  startedAt: new Date(2000),
  status: "succeeded",
  symbol: "SPY",
  timeframe: "1d",
  to: "1970-04-10",
  ...overrides,
});

const comparisonsOf = (
  runs: EngineComparisonRun[]
): EngineComparisonGateway => ({
  comparisons: vi.fn(async () => ({ runs })),
});

describe("toRunInput and formatters", () => {
  it("builds both rule requests and explains invalid parameters", () => {
    expect(toRunInput(DEFAULT_INSTANT_PARAMS, SPY)).toEqual({
      input: {
        symbol: "SPY",
        timeframe: "1d",
        rule: { kind: "smaCross", fast: 50, slow: 200 },
        stopLossPct: 0,
        takeProfitPct: 0,
        costBps: 2,
      },
    });
    expect(
      toRunInput({ ...DEFAULT_INSTANT_PARAMS, ruleKind: "breakout" }, BTC)
    ).toMatchObject({
      input: {
        symbol: "BTCUSDT",
        rule: {
          kind: "breakout",
          entryLookback: 20,
          exitLookback: 10,
          trendSma: 0,
        },
      },
    });
    expect(toRunInput({ ...DEFAULT_INSTANT_PARAMS, fast: 2.5 }, SPY)).toEqual({
      error: "Fast average (bars) must be a whole number from 1 to 500.",
    });
    expect(
      toRunInput({ ...DEFAULT_INSTANT_PARAMS, stopLossPct: 80 }, SPY)
    ).toEqual({ error: "Stop-loss (% below entry) must be from 0 to 50." });
    expect(
      toRunInput({ ...DEFAULT_INSTANT_PARAMS, fast: 300, slow: 200 }, SPY)
    ).toEqual({
      error: "The fast average must be shorter than the slow average.",
    });
  });

  it("formats missing values as n/a", () => {
    expect(formatPercent(0.1234)).toBe("12.3%");
    expect(formatPercent(null)).toBe("n/a");
    expect(formatRatio(1.234)).toBe("1.23");
    expect(formatRatio(null)).toBe("n/a");
  });
});

describe("InstantBacktestWorkspace", () => {
  it("re-runs on each parameter change and keeps only the newest result", async () => {
    const { gateway, pending } = controlledGateway(async () => ({
      series: [SPY, BTC],
    }));
    await mount(<InstantBacktestWorkspace gateway={gateway} />);
    expect(pending).toHaveLength(1);
    expect(statusText()).toBe("Running…");
    await settle(() => pending[0]?.resolve(output(pending[0].input, 0.5)));
    expect(statText("Total return")).toBe("50.0%");
    expect(statText("Sortino")).toBe("n/a");
    expect(statusText()).toMatch(
      /^Updated in \d+ ms \(server compute 1\.3 ms, bar load 0\.4 ms, cache hit\)\.$/u
    );
    expect(document.querySelector("figure")?.dataset["points"]).toBe("2");
    expect(document.body.textContent).toContain(
      "8,487 bars, 1970-01-01 to 1970-04-11"
    );

    await setNative(field("Fast average (bars)"), "20", "input");
    await setNative(
      document.querySelector(
        'input[aria-label="Fast average (bars) slider"]'
      ) as HTMLInputElement,
      "30",
      "input"
    );
    // One request is in flight; the slider change waits as the single queued request.
    expect(pending.map((entry) => entry.input.rule)).toEqual([
      { kind: "smaCross", fast: 50, slow: 200 },
      { kind: "smaCross", fast: 20, slow: 200 },
    ]);
    // The previous result stays visible while the new run is in flight.
    expect(statText("Total return")).toBe("50.0%");
    await settle(() => pending[1]?.resolve(output(pending[1].input, 0.9)));
    // The superseded result is not shown; the queued parameters are sent instead.
    expect(statText("Total return")).toBe("50.0%");
    expect(statusText()).toBe("Running…");
    expect(pending[2]?.input.rule).toEqual({
      kind: "smaCross",
      fast: 30,
      slow: 200,
    });
    await settle(() => pending[2]?.resolve(output(pending[2].input, 0.3)));
    expect(statText("Total return")).toBe("30.0%");
    await setNative(field("Cost per side (basis points)"), "3", "input");
    await setNative(field("Cost per side (basis points)"), "4", "input");
    expect(pending).toHaveLength(4);
    await settle(() => pending[3]?.reject(new Error("superseded")));
    expect(statusText()).toBe("Running…");
    expect(pending[4]?.input.costBps).toBe(4);
    await settle(() => pending[4]?.resolve(output(pending[4].input, 0.2)));
    expect(statText("Total return")).toBe("20.0%");
    expect(statusText()).toMatch(/^Updated in/u);
    const submit = new Event("submit", { bubbles: true, cancelable: true });
    await settle(() => document.querySelector("form")?.dispatchEvent(submit));
    expect(submit.defaultPrevented).toBe(true);
  });

  it("switches rule and series, ignores blank input and blocks invalid parameters", async () => {
    const { gateway, pending } = controlledGateway(async () => ({
      series: [SPY, BTC],
    }));
    const resolveLatest = () =>
      settle(() => {
        const latest = pending.at(-1);
        latest?.resolve(output(latest.input, 0.1));
      });
    await mount(<InstantBacktestWorkspace gateway={gateway} />);
    await resolveLatest();
    await setNative(field("Rule"), "breakout", "change");
    expect(pending.at(-1)?.input.rule).toEqual({
      kind: "breakout",
      entryLookback: 20,
      exitLookback: 10,
      trendSma: 0,
    });
    expect(document.body.textContent).toContain("0 turns the filter off.");
    await resolveLatest();
    await setNative(
      field("Trend filter: close above average of N bars"),
      "50",
      "input"
    );
    expect(pending.at(-1)?.input.rule).toMatchObject({ trendSma: 50 });
    await resolveLatest();
    await setNative(field("Bars"), "BTCUSDT:1m", "change");
    expect(pending.at(-1)?.input).toMatchObject({
      symbol: "BTCUSDT",
      timeframe: "1m",
    });
    await resolveLatest();
    const count = pending.length;
    await setNative(field("Stop-loss (% below entry)"), "", "input");
    expect(pending).toHaveLength(count);
    await setNative(field("Rule"), "smaCross", "change");
    await setNative(field("Fast average (bars)"), "250", "input");
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      "The fast average must be shorter than the slow average."
    );
    expect(pending).toHaveLength(count + 1);
    // The response for the earlier valid inputs arrives after they became invalid: ignored.
    await resolveLatest();
    expect(document.querySelector("[data-instant-results]")).toBeNull();
    await setNative(field("Fast average (bars)"), "20", "input");
    await setNative(field("Fast average (bars)"), "300", "input");
    await settle(() => pending.at(-1)?.reject(new Error("late")));
    expect(pending).toHaveLength(count + 2);
    expect(document.querySelector('[role="alert"]')).not.toBeNull();
    expect(document.querySelector("[data-instant-results]")).toBeNull();
  });

  it("preselects Core 7 futures and its first stored series, and follows a universe change", async () => {
    const ES: InstantBacktestSeries = { ...SPY, symbol: "ES=F" };
    const TEST: InstantBacktestSeries = { ...SPY, symbol: "TEST" };
    const { gateway, pending } = controlledGateway(async () => ({
      series: [BTC, ES, SPY, TEST],
    }));
    await mount(<InstantBacktestWorkspace gateway={gateway} />);
    expect(field("Universe").value).toBe("core7-futures");
    expect(field("Bars").value).toBe("ES=F:1d");
    expect([...field("Bars").options].map((option) => option.value)).toEqual([
      "ES=F:1d",
    ]);
    expect(pending.at(-1)?.input.symbol).toBe("ES=F");
    expect(document.querySelector("[data-universe-fallback]")).toBeNull();
    // One request is in flight at a time; finish it so the next one is sent.
    await settle(() => pending[0]?.resolve(output(pending[0].input, 0.1)));
    await setNative(field("Universe"), "core7-etf-twins", "change");
    expect([...field("Bars").options].map((option) => option.value)).toEqual([
      "SPY:1d",
    ]);
    expect(pending.at(-1)?.input.symbol).toBe("SPY");

    await setNative(field("Universe"), "all", "change");
    expect(field("Bars").options).toHaveLength(4);
    expect(field("Bars").value).toBe("BTCUSDT:1m");
  });

  it("keeps the universe choice when the series list reloads", async () => {
    const ES: InstantBacktestSeries = { ...SPY, symbol: "ES=F" };
    const first = controlledGateway(async () => ({ series: [ES, SPY] }));
    const { root } = await mount(
      <InstantBacktestWorkspace gateway={first.gateway} />
    );
    await setNative(field("Universe"), "core7-etf-twins", "change");
    const second = controlledGateway(async () => ({ series: [ES, SPY] }));
    await act(async () => {
      root.render(<InstantBacktestWorkspace gateway={second.gateway} />);
      await flush();
    });
    expect(field("Universe").value).toBe("core7-etf-twins");
    expect(field("Bars").value).toBe("SPY:1d");
  });

  it("shows every stored series when no Core 7 future is stored", async () => {
    const TEST: InstantBacktestSeries = { ...SPY, symbol: "TEST" };
    const { gateway } = controlledGateway(async () => ({
      series: [SPY, TEST],
    }));
    await mount(<InstantBacktestWorkspace gateway={gateway} />);
    expect(field("Universe").value).toBe("core7-futures");
    expect(field("Bars").value).toBe("SPY:1d");
    expect(field("Bars").options).toHaveLength(2);
    expect(
      document.querySelector("[data-universe-fallback]")?.textContent
    ).toBe("No stored bars for Core 7 futures yet. Showing all stored series.");
    await setNative(field("Universe"), "core7-etf-twins", "change");
    expect([...field("Bars").options].map((option) => option.value)).toEqual([
      "SPY:1d",
    ]);
    expect(document.querySelector("[data-universe-fallback]")).toBeNull();
  });

  it("shows run errors and keeps the last result", async () => {
    const { gateway, pending } = controlledGateway(async () => ({
      series: [SPY],
    }));
    await mount(<InstantBacktestWorkspace gateway={gateway} />);
    await settle(() => pending[0]?.resolve(output(pending[0].input, 0.5)));
    await setNative(field("Cost per side (basis points)"), "5", "input");
    await settle(() =>
      pending[1]?.reject({
        code: "BAD_REQUEST",
        message: "slow must be an integer from 1 to 8487",
      })
    );
    expect(statusText()).toBe("slow must be an integer from 1 to 8487");
    expect(statText("Total return")).toBe("50.0%");
  });

  it("explains forbidden, failed and empty series lists", async () => {
    await mount(
      <InstantBacktestWorkspace
        gateway={
          controlledGateway(async () => {
            throw { code: "FORBIDDEN", message: "Operator access required" };
          }).gateway
        }
      />
    );
    expect(document.querySelector("[data-operator-access]")).not.toBeNull();
    document.body.replaceChildren();
    await mount(
      <InstantBacktestWorkspace
        gateway={
          controlledGateway(async () => {
            throw { code: "STORAGE_ERROR", message: "Bar storage unavailable" };
          }).gateway
        }
      />
    );
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      "Bar storage unavailable"
    );
    document.body.replaceChildren();
    await mount(
      <InstantBacktestWorkspace
        gateway={controlledGateway(async () => ({ series: [] })).gateway}
      />
    );
    expect(document.body.textContent).toContain("No stored bar series yet.");
  });

  it("ignores series responses that arrive after unmount", async () => {
    interface SeriesList {
      series: InstantBacktestSeries[];
    }
    let resolveLate: (value: SeriesList) => void = () => undefined;
    let rejectLate: (error: unknown) => void = () => undefined;
    const first = controlledGateway(
      () =>
        new Promise<SeriesList>((resolve) => {
          resolveLate = resolve;
        })
    );
    const second = controlledGateway(
      () =>
        new Promise<SeriesList>((_, reject) => {
          rejectLate = reject;
        })
    );
    const a = await mount(<InstantBacktestWorkspace gateway={first.gateway} />);
    const b = await mount(
      <InstantBacktestWorkspace gateway={second.gateway} />
    );
    expect(document.body.textContent).toContain("Loading stored bar series");
    await act(async () => {
      a.root.unmount();
      b.root.unmount();
    });
    roots.splice(0);
    await settle(() => {
      resolveLate({ series: [SPY] });
      rejectLate(new Error("late"));
    });
    expect(first.pending).toHaveLength(0);
  });

  it("uses the browser oRPC client when no gateway is given", async () => {
    const fetch = vi.fn(async (request: Request) => {
      const path = new URL(request.url).pathname;
      const body = path.endsWith("/series")
        ? { series: [SPY] }
        : output(
            {
              symbol: "SPY",
              timeframe: "1d",
              rule: { kind: "smaCross", fast: 50, slow: 200 },
              stopLossPct: 0,
              takeProfitPct: 0,
              costBps: 2,
            },
            0.25
          );
      return Response.json({ json: body });
    });
    vi.stubGlobal("fetch", fetch);
    await mount(<InstantBacktestWorkspace />);
    await act(async () => {
      await flush();
      await new Promise((resolve) => setTimeout(resolve, 10));
      await flush();
    });
    expect(statText("Total return")).toBe("25.0%");
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe("instant backtest engine comparison", () => {
  it("shows the TypeScript timing at once and the Nautilus card of the queued run", async () => {
    const { gateway, pending } = controlledGateway(async () => ({
      series: [SPY],
    }));
    const comparisons = comparisonsOf([nautilusRun()]);
    await mount(
      <InstantBacktestWorkspace
        comparisonGateway={comparisons}
        gateway={gateway}
      />
    );
    expect(document.querySelector("[data-engine-comparison]")).toBeNull();
    await settle(() =>
      pending[0]?.resolve({
        ...output(pending[0].input, 0.5),
        comparison: { groupId: "g-1", host: "QuantVPS web", wallMs: 1 },
      })
    );
    expect(document.querySelector("[data-engine]")?.textContent).toMatch(
      /^TypeScript · QuantVPS web · \d+ ms \(round trip\) · engine 1 ms$/u
    );
    expect(
      document.querySelector("[data-nautilus-card]")?.textContent
    ).toContain("Nautilus · rig-1 · 400 ms (queue 2.0 s)Status:match");
    expect(comparisons.comparisons).toHaveBeenCalledWith("g-1");
    // A run whose comparison could not be queued shows the reason only.
    await setNative(field("Cost per side (basis points)"), "5", "input");
    await settle(() =>
      pending[1]?.resolve({
        ...output(pending[1].input, 0.4),
        comparison: {
          error: "Nautilus comparison could not be queued",
          groupId: null,
          host: "QuantVPS web",
          wallMs: 1,
        },
      })
    );
    expect(
      document
        .querySelector("[data-nautilus-card]")
        ?.getAttribute("data-nautilus-card")
    ).toBe("error");
  });
});
