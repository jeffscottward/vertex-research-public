// @vitest-environment jsdom
import {
  type BacktestRun,
  type InstantBacktestSeries,
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
  defaultExpr,
  describeCondition,
  describeExpr,
  describeFilter,
  describeOptions,
  describePortfolio,
  INDICATOR_LABELS,
  isEditableExpr,
  lengthUnit,
  numberOf,
  pickBuilderRun,
  readBuilderQuery,
  replaceAt,
  seriesRefLabel,
  templateDefinition,
  toBuilderRunInput,
  usesSource,
  withOffset,
} from "./strategy-builder-model.ts";
import {
  type StrategyBuilderGateway,
  StrategyBuilderWorkspace,
} from "./strategy-builder-workspace.tsx";

const browserGateway = vi.hoisted(() => ({
  get: vi.fn(),
  list: vi.fn(async () => []),
  series: vi.fn(async () => []),
  submit: vi.fn(),
}));
vi.mock("./backtest-runs-workspace.tsx", () => ({
  createBrowserBacktestRunsGateway: () => browserGateway,
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
// Unmounts every root and clears the URL that a submit may have written.
const unmountAll = async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  window.history.replaceState(null, "", "/");
};
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
type Control = HTMLInputElement & HTMLSelectElement & HTMLTextAreaElement;
const setNative = async (element: Control, value: string) => {
  const node: Element = element;
  const prototype =
    node instanceof HTMLSelectElement
      ? HTMLSelectElement.prototype
      : node instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
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
const field = (label: string): Control => {
  const target = [...document.querySelectorAll("label")].find(
    (node) => node.textContent === label
  );
  const element = document.getElementById(target?.getAttribute("for") ?? "");
  if (element === null) throw new Error(`No field ${label}`);
  return element as Control;
};
const has = (label: string) =>
  [...document.querySelectorAll("label")].some(
    (node) => node.textContent === label
  );
const button = (text: string) => {
  const found = [...document.querySelectorAll("button")].find(
    (node) => node.textContent === text
  );
  if (found === undefined) throw new Error(`No button ${text}`);
  return found;
};
const definitionText = () => JSON.parse(field("Definition text").value);

// The TS lib here predates Promise.withResolvers, so build the same shape by hand.
const deferred = <T,>() => {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
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
  symbol: "QQQ",
};

const definition = templateDefinition("smaCross");
const runOf = (overrides: Partial<BacktestRun> = {}): BacktestRun => ({
  createdAt: new Date(0),
  engineVersion: "instant-1",
  error: null,
  finishedAt: null,
  id: "run-1",
  report: null,
  spec: {
    costBps: 0,
    from: "1970-01-01",
    initialCapital: 10_000,
    rule: { definition, kind: "dsl" },
    stopLossPct: 0,
    symbol: "SPY",
    takeProfitPct: 0,
    timeframe: "1d",
    to: "1970-04-10",
  },
  startedAt: null,
  status: "queued",
  strategyId: null,
  strategyRevision: "a".repeat(64),
  strategySnapshot: {
    id: "dsl:x",
    kind: "dsl",
    name: "SMA cross",
    params: [definition],
    slug: "dsl-x",
    sourceRef: null,
    updatedAt: "",
  },
  ...overrides,
});
const metrics = {
  absoluteDrawdown: 0,
  averageLossTrade: null,
  averageProfitTrade: null,
  buyHoldReturn: 0.1,
  cagr: null,
  expectedPayoff: null,
  exposure: 0.5,
  finalEquity: 10_500,
  grossLoss: 0,
  grossProfit: 500,
  initialDeposit: 10_000,
  largestLossTrade: null,
  largestProfitTrade: null,
  lossTrades: 0,
  maxConsecutiveLosses: 0,
  maxConsecutiveLossesMoney: 0,
  maxConsecutiveWins: 1,
  maxDrawdownAbs: 200,
  maxDrawdownPct: 0.02,
  maximalConsecutiveLoss: 0,
  maximalConsecutiveLossCount: 0,
  netProfit: 500,
  profitFactor: null,
  profitTrades: 1,
  recoveryFactor: null,
  sharpe: null,
  sortino: null,
  totalReturn: 0.05,
  totalTrades: 1,
  winRate: null,
};
const finished = runOf({
  report: {
    bars: 2,
    equity: [],
    firstT: 0,
    lastT: DAY_MS,
    metrics,
    prices: [],
    seriesSha256: "e".repeat(64),
    trades: [],
    tradesTruncated: false,
  },
  status: "succeeded",
});

const gatewayOf = (
  overrides: Partial<StrategyBuilderGateway> = {}
): StrategyBuilderGateway => ({
  get: vi.fn(async () => finished),
  list: vi.fn(async () => []),
  series: vi.fn(async () => [SPY, QQQ]),
  submit: vi.fn(async () => runOf()),
  ...overrides,
});

describe("strategy builder model", () => {
  const form = {
    costBps: 2,
    from: "1970-01-01",
    initialCapital: 5000,
    to: "1970-04-10",
  };

  it("reads the run and symbol deep link", () => {
    expect(readBuilderQuery("")).toEqual({ run: null, symbol: null });
    expect(readBuilderQuery("?run=%20r-2%20&symbol=ES%3DF")).toEqual({
      run: "r-2",
      symbol: "ES=F",
    });
    expect(readBuilderQuery("?run=&symbol=")).toEqual({
      run: null,
      symbol: null,
    });
  });

  it("picks the linked or newest finished builder run", () => {
    const old = runOf({
      createdAt: new Date(1),
      id: "old",
      status: "succeeded",
    });
    const recent = runOf({
      createdAt: new Date(5),
      id: "recent",
      spec: { ...old.spec, symbol: "QQQ" },
      status: "succeeded",
    });
    const queued = runOf({ createdAt: new Date(9), id: "queued" });
    const golden = runOf({
      createdAt: new Date(9),
      id: "golden",
      spec: { ...old.spec, rule: { fast: 10, kind: "smaCross", slow: 40 } },
      status: "succeeded",
    });
    const runs = [old, queued, golden, recent];
    expect(pickBuilderRun(runs, { run: null, symbol: null })?.run.id).toBe(
      "recent"
    );
    expect(pickBuilderRun(runs, { run: "old", symbol: null })?.run.id).toBe(
      "old"
    );
    expect(pickBuilderRun(runs, { run: "golden", symbol: null })?.run.id).toBe(
      "recent"
    );
    expect(pickBuilderRun(runs, { run: "queued", symbol: null })?.run.id).toBe(
      "queued"
    );
    expect(pickBuilderRun(runs, { run: null, symbol: "SPY" })).toEqual({
      definition,
      run: old,
    });
    expect(pickBuilderRun([queued, golden], { run: null, symbol: null })).toBe(
      null
    );
  });

  it("builds a dsl run request or explains the error", () => {
    expect(toBuilderRunInput(definition, SPY, form)).toEqual({
      input: {
        costBps: 2,
        from: "1970-01-01",
        initialCapital: 5000,
        rule: { definition, kind: "dsl" },
        symbol: "SPY",
        timeframe: "1d",
        to: "1970-04-10",
      },
    });
    expect(toBuilderRunInput(definition, SPY, { ...form, to: "" })).toEqual({
      error: "Enter both dates as YYYY-MM-DD.",
    });
    expect(
      toBuilderRunInput(definition, SPY, { ...form, from: "1971-01-01" })
    ).toEqual({ error: "The start date must not be after the end date." });
    expect(
      toBuilderRunInput(definition, SPY, { ...form, initialCapital: 0 })
    ).toEqual({ error: "Initial capital must be from 1 to 1,000,000,000." });
    expect(
      toBuilderRunInput(definition, SPY, { ...form, costBps: 501 })
    ).toEqual({ error: "Cost per side must be from 0 to 500 bps." });
  });

  it("reads number inputs and default expressions", () => {
    expect(numberOf(" ")).toBeNaN();
    expect(numberOf("2.5")).toBe(2.5);
    expect(defaultExpr("const")).toEqual({ type: "const", value: 0 });
    expect(defaultExpr("indicator")).toMatchObject({ name: "sma" });
    expect(replaceAt([1, 2], 0, 9)).toEqual([9, 2]);
  });

  it("labels indicators and sets or removes the bars-ago offset", () => {
    expect(INDICATOR_LABELS.adx).toBe("ADX (trend strength)");
    expect(INDICATOR_LABELS.rvol).toBe("Relative volume at time");
    expect([usesSource("sma"), usesSource("adx"), usesSource("rvol")]).toEqual([
      true,
      false,
      false,
    ]);
    expect([usesSource("zscore"), usesSource("realizedVol")]).toEqual([
      true,
      true,
    ]);
    expect([
      lengthUnit("rvol"),
      lengthUnit("adx"),
      lengthUnit("adx", "1d"),
      lengthUnit("rvol", "1d"),
    ]).toEqual(["sessions", "bars", "days", "sessions"]);
    const price = { field: "close", type: "price" } as const;
    expect(withOffset(price, "5")).toEqual({ ...price, offset: 5 });
    expect(withOffset({ ...price, offset: 5 }, "0")).toEqual(price);
    expect(withOffset({ ...price, offset: 5 }, " ")).toEqual(price);
    expect(Object.keys(withOffset(price, ""))).not.toContain("offset");
    expect(withOffset(price, "-1")).toEqual({ ...price, offset: -1 });
  });
});

describe("StrategyBuilderWorkspace", () => {
  it("edits the definition visually and keeps the text in sync", async () => {
    await mount(<StrategyBuilderWorkspace gateway={gatewayOf()} />);
    expect(document.body.textContent).toContain("The definition is valid.");
    expect(definitionText().name).toBe("SMA cross");

    await setNative(field("Strategy name"), "My cross");
    await setNative(field("Entry 1 left length (bars)"), "10");
    await setNative(field("Entry 1 left source"), "high");
    await setNative(field("Entry 1 comparison"), ">=");
    await setNative(field("Entry 1 right indicator"), "atr");
    expect(has("Entry 1 right source")).toBe(false);
    await setNative(field("Entry 1 left bars ago"), "5");
    await setNative(field("Exit 1 left input"), "price");
    await setNative(field("Exit 1 left price"), "low");
    await setNative(field("Exit 1 left bars ago"), "1");
    await setNative(field("Exit 1 left bars ago"), "");
    await setNative(field("Exit 1 right input"), "const");
    await setNative(field("Exit 1 right value"), "3");
    let text = definitionText();
    expect(text.name).toBe("My cross");
    expect(text.entry.all[0]).toEqual({
      left: {
        length: 10,
        name: "sma",
        offset: 5,
        source: "high",
        type: "indicator",
      },
      op: ">=",
      right: { length: 50, name: "atr", source: "close", type: "indicator" },
    });
    expect(
      Array.from(
        field("Entry 1 right indicator").querySelectorAll("option"),
        (option) => option.textContent
      )
    ).toContain("ADX (trend strength)");
    await setNative(field("Entry 1 right indicator"), "rvol");
    expect(has("Entry 1 right length (sessions)")).toBe(true);
    await setNative(field("Entry 1 right indicator"), "atr");
    expect(text.exit.any[0]).toEqual({
      left: { field: "low", type: "price" },
      op: "<=",
      right: { type: "const", value: 3 },
    });

    await settle(() => button("Add entry condition").click());
    expect(definitionText().entry.all).toHaveLength(2);
    await settle(() => button("Remove entry 2").click());
    await settle(() => button("Remove exit 1").click());
    expect(document.body.textContent).toContain("No conditions.");
    await settle(() => button("Add exit condition").click());

    await setNative(field("Position sizing"), "riskPct");
    expect(document.body.textContent).toContain(
      "sizing: Risk-percent sizing needs a stop loss"
    );
    await setNative(field("Risk per trade (%)"), "2");
    await setNative(field("Stop loss"), "atr");
    await setNative(field("Stop loss ATR length (bars)"), "10");
    await setNative(field("Stop loss ATR multiple"), "3");
    await setNative(field("Take profit"), "pct");
    await setNative(field("Take profit percent"), "");
    expect(document.body.textContent).toContain("takeProfit.pct");
    await setNative(field("Take profit percent"), "15");
    text = definitionText();
    expect(text.sizing).toEqual({ mode: "riskPct", riskPct: 2 });
    expect(text.stopLoss).toEqual({ kind: "atr", length: 10, multiple: 3 });
    expect(text.takeProfit).toEqual({ kind: "pct", pct: 15 });
    await setNative(field("Take profit"), "none");
    await setNative(field("Position sizing"), "allIn");
    expect(definitionText().sizing).toEqual({ mode: "allIn" });

    const sessionBox = document.querySelector(
      'input[type="checkbox"]'
    ) as HTMLInputElement;
    await settle(() => sessionBox.click());
    expect(document.body.textContent).toContain(
      "Daily bars are stamped 00:00 UTC."
    );
    await setNative(field("Session start (UTC)"), "14:00");
    await setNative(field("Session end (UTC)"), "15:00");
    expect(definitionText().session).toEqual({
      endUtc: "15:00",
      startUtc: "14:00",
    });
    await settle(() => sessionBox.click());
    expect(definitionText().session).toBeUndefined();

    await setNative(field("Template"), "donchianBreakout");
    expect(definitionText().name).toBe("Donchian breakout");
    await setNative(field("Template"), "");
    expect(definitionText().name).toBe("Donchian breakout");
  });

  it("validates text edits and disables the visual builder while invalid", async () => {
    await mount(<StrategyBuilderWorkspace gateway={gatewayOf()} />);
    await setNative(field("Definition text"), "{ broken");
    expect(document.body.textContent).toContain("(root): Not valid JSON");
    expect(document.querySelector('[role="note"]')).not.toBeNull();
    expect(field("Strategy name").closest("fieldset")?.disabled).toBe(true);
    expect(button("Run backtest").disabled).toBe(true);
    expect(document.body.textContent).toContain(
      "Fix the definition before you run a backtest."
    );

    const rsi = templateDefinition("rsiReversion");
    await setNative(field("Definition text"), JSON.stringify(rsi));
    expect(document.querySelector('[role="note"]')).toBeNull();
    expect(field("Strategy name").value).toBe("RSI reversion");
    expect(field("Entry 1 right value").value).toBe("30");
  });

  it("keeps entry.any, daily levels, management and maxLeverage through visual edits", async () => {
    await mount(<StrategyBuilderWorkspace gateway={gatewayOf()} />);
    const breakout = {
      left: { field: "close", type: "price" },
      oncePerLevel: true,
      op: "breaksAbove",
      right: {
        length: 20,
        name: "highest",
        source: "high",
        timeframe: "1d",
        type: "indicator",
      },
    };
    const definition = {
      entry: { all: [], any: [breakout] },
      management: {
        breakevenR: 2,
        trail: { activateR: 1, length: 14, multiple: 2 },
      },
      name: "Daily breakout",
      sizing: { maxLeverage: 20, mode: "riskPct", riskPct: 1 },
      stopLoss: { kind: "atr", length: 14, multiple: 2 },
      version: 1,
    };
    await setNative(field("Definition text"), JSON.stringify(definition));
    expect(document.body.textContent).toContain("The definition is valid.");
    expect(document.body.textContent).toContain(
      "This definition also uses entry.any, management, oncePerLevel, timeframe, maxLeverage."
    );

    await settle(() => button("Add entry condition").click());
    await setNative(field("Risk per trade (%)"), "2");
    const text = definitionText();
    expect(text.entry.all).toHaveLength(1);
    expect(text.entry.any).toEqual([breakout]);
    expect(text.management).toEqual(definition.management);
    expect(text.sizing).toEqual({ ...definition.sizing, riskPct: 2 });
  });

  it("drops oncePerLevel and timeframe when the new choice cannot take them", async () => {
    await mount(<StrategyBuilderWorkspace gateway={gatewayOf()} />);
    const daily = {
      length: 20,
      name: "highest",
      source: "high",
      timeframe: "1d",
      type: "indicator",
    };
    await setNative(
      field("Definition text"),
      JSON.stringify({
        entry: {
          all: [
            {
              left: { field: "close", type: "price" },
              oncePerLevel: true,
              op: "breaksAbove",
              right: daily,
            },
          ],
        },
        name: "Daily break",
        version: 1,
      })
    );
    expect(has("Entry 1 right length (days)")).toBe(true);
    await setNative(field("Entry 1 comparison"), "crossesAbove");
    expect(definitionText().entry.all[0].oncePerLevel).toBe(true);
    await setNative(field("Entry 1 comparison"), ">");
    await setNative(field("Entry 1 right indicator"), "lowest");
    expect(definitionText().entry.all[0]).toEqual({
      left: { field: "close", type: "price" },
      op: ">",
      right: { ...daily, name: "lowest" },
    });
    await setNative(field("Entry 1 right indicator"), "rvol");
    expect(definitionText().entry.all[0].right).toEqual({
      length: 20,
      name: "rvol",
      source: "high",
      type: "indicator",
    });
    expect(has("Entry 1 right length (sessions)")).toBe(true);
    expect(document.body.textContent).toContain("The definition is valid.");
    expect(document.body.textContent).not.toContain(
      "This definition also uses"
    );
  });

  it("runs a backtest of the definition and follows it to the result", async () => {
    vi.useFakeTimers();
    const gateway = gatewayOf({
      get: vi
        .fn<StrategyBuilderGateway["get"]>()
        .mockResolvedValueOnce(runOf({ status: "running" }))
        .mockResolvedValueOnce(finished),
    });
    await mount(<StrategyBuilderWorkspace gateway={gateway} pollMs={10} />);
    await setNative(field("Symbol and timeframe"), "QQQ:1d");
    expect(field("From").value).toBe("1970-01-11");
    await setNative(field("Symbol and timeframe"), "missing:1d");
    await setNative(field("Symbol and timeframe"), "SPY:1d");
    await setNative(field("From"), "1970-01-02");
    await setNative(field("To"), "1970-03-01");
    await setNative(field("Cost per side (bps)"), "3");
    await setNative(field("Initial capital"), "0");
    expect(document.body.textContent).toContain(
      "Initial capital must be from 1"
    );
    await settle(() =>
      document
        .querySelector("form")
        ?.dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true })
        )
    );
    expect(gateway.submit).not.toHaveBeenCalled();
    await setNative(field("Initial capital"), "25000");
    await settle(() => button("Run backtest").click());
    expect(gateway.submit).toHaveBeenCalledWith({
      costBps: 3,
      from: "1970-01-02",
      initialCapital: 25_000,
      rule: { definition, kind: "dsl" },
      symbol: "SPY",
      timeframe: "1d",
      to: "1970-03-01",
    });
    expect(document.body.textContent).toContain("The backtest is running.");
    expect(document.body.textContent).toContain(
      "Strategy SMA cross revision aaaaaaaaaaaa"
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20);
    });
    const result = document.querySelector(
      '[aria-label="Backtest result"]'
    ) as HTMLElement;
    expect(result.textContent).toContain("The backtest finished.");
    expect(result.textContent).toContain("Total net profit500.00");
    expect(result.querySelector("a")?.getAttribute("href")).toBe(
      "/backtest-runs?run=run-1"
    );
  });

  it("reports failed runs, poll limits and request errors", async () => {
    const failing = gatewayOf({
      get: vi.fn(async () =>
        runOf({ error: "No stored 1d bars", status: "failed" })
      ),
    });
    await mount(<StrategyBuilderWorkspace gateway={failing} />);
    await settle(() => button("Run backtest").click());
    expect(document.body.textContent).toContain(
      "The backtest failed: No stored 1d bars"
    );
    await unmountAll();

    await mount(
      <StrategyBuilderWorkspace
        gateway={gatewayOf({
          get: vi.fn(async () => runOf({ error: null, status: "failed" })),
        })}
      />
    );
    await settle(() => button("Run backtest").click());
    expect(document.body.textContent).toContain(
      "The backtest failed: unknown error"
    );
    await unmountAll();

    await mount(
      <StrategyBuilderWorkspace
        gateway={gatewayOf({ get: vi.fn(async () => runOf()) })}
        pollMax={1}
      />
    );
    await settle(() => button("Run backtest").click());
    expect(document.body.textContent).toContain(
      "The run has not finished yet."
    );
    await unmountAll();

    await mount(
      <StrategyBuilderWorkspace
        gateway={gatewayOf({
          get: vi.fn(async () => {
            throw new Error("down");
          }),
        })}
      />
    );
    await settle(() => button("Run backtest").click());
    expect(document.querySelector('[role="alert"]')?.textContent).toBeTruthy();
    await unmountAll();

    await mount(
      <StrategyBuilderWorkspace
        gateway={gatewayOf({
          submit: vi.fn(async () => {
            throw new Error("down");
          }),
        })}
      />
    );
    await settle(() => button("Run backtest").click());
    expect(document.querySelector('[role="alert"]')?.textContent).toBeTruthy();
    expect(button("Run backtest").disabled).toBe(false);
  });

  it("ignores results that arrive after unmount", async () => {
    let finishGet: (run: BacktestRun) => void = () => undefined;
    let failGet: (error: unknown) => void = () => undefined;
    const gateway = gatewayOf({
      get: vi
        .fn<StrategyBuilderGateway["get"]>()
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              finishGet = resolve;
            })
        )
        .mockImplementationOnce(
          () =>
            new Promise((_, reject) => {
              failGet = reject;
            })
        ),
    });
    await mount(<StrategyBuilderWorkspace gateway={gateway} />);
    await settle(() => button("Run backtest").click());
    await unmountAll();
    finishGet(finished);
    await flush();

    await mount(<StrategyBuilderWorkspace gateway={gateway} />);
    await settle(() => button("Run backtest").click());
    await unmountAll();
    failGet(new Error("late"));
    await flush();

    let finishSeries: (series: InstantBacktestSeries[]) => void = () =>
      undefined;
    let failSeries: (error: unknown) => void = () => undefined;
    await mount(
      <StrategyBuilderWorkspace
        gateway={gatewayOf({
          series: vi.fn<StrategyBuilderGateway["series"]>().mockImplementation(
            () =>
              new Promise((resolve) => {
                finishSeries = resolve;
              })
          ),
        })}
      />
    );
    await unmountAll();
    finishSeries([SPY]);
    await mount(
      <StrategyBuilderWorkspace
        gateway={gatewayOf({
          series: vi.fn<StrategyBuilderGateway["series"]>().mockImplementation(
            () =>
              new Promise((_, reject) => {
                failSeries = reject;
              })
          ),
        })}
      />
    );
    await unmountAll();
    failSeries(new Error("late"));
    await flush();
    expect(document.body.textContent).toBe("");
  });

  it("shows loading, access, error and empty states", async () => {
    await mount(
      <StrategyBuilderWorkspace
        gateway={gatewayOf({
          series: vi.fn(
            () => new Promise<InstantBacktestSeries[]>(() => undefined)
          ),
        })}
      />
    );
    expect(document.body.textContent).toContain("Loading series…");
    await unmountAll();

    await mount(
      <StrategyBuilderWorkspace
        gateway={gatewayOf({
          series: vi.fn(async () => {
            throw Object.assign(new Error("forbidden"), { code: "FORBIDDEN" });
          }),
        })}
      />
    );
    expect(document.body.textContent).toMatch(/operator/iu);
    await unmountAll();

    await mount(
      <StrategyBuilderWorkspace
        gateway={gatewayOf({
          series: vi.fn(async () => {
            throw new Error("down");
          }),
        })}
      />
    );
    expect(document.querySelector('[role="alert"]')).not.toBeNull();
    await unmountAll();

    await mount(<StrategyBuilderWorkspace />);
    expect(browserGateway.series).toHaveBeenCalled();
    expect(document.body.textContent).toContain("No stored bar series.");
    expect(button("Run backtest").disabled).toBe(true);
  });

  const ES: InstantBacktestSeries = {
    ...SPY,
    firstT: 20 * DAY_MS,
    symbol: "ES=F",
  };
  const loadedDefinition = { ...definition, name: "Loaded rule" };
  const stored = runOf({
    createdAt: new Date(3),
    id: "stored",
    spec: {
      ...runOf().spec,
      costBps: 4,
      from: "1970-01-05",
      initialCapital: 20_000,
      rule: { definition: loadedDefinition, kind: "dsl" },
      to: "1970-02-01",
    },
    status: "succeeded",
  });
  const older = runOf({
    createdAt: new Date(1),
    id: "older",
    spec: { ...stored.spec, symbol: "QQQ" },
    status: "succeeded",
  });

  it("opens on the Core 7 default with a notice when no builder run exists", async () => {
    const gateway = gatewayOf({ series: vi.fn(async () => [SPY, ES]) });
    await mount(<StrategyBuilderWorkspace gateway={gateway} />);
    expect(field("Symbol and timeframe").value).toBe("ES=F:1d");
    expect(field("From").value).toBe("1970-01-21");
    expect(definitionText()).toEqual(definition);
    expect(document.querySelector('[role="status"]')?.textContent).toContain(
      "No builder run exists yet."
    );
    expect(gateway.submit).not.toHaveBeenCalled();
    expect(gateway.get).not.toHaveBeenCalled();
    expect(window.location.search).toBe("");
  });

  it("shows the latest builder run on open without submitting", async () => {
    const gateway = gatewayOf({
      get: vi.fn(async () => ({ ...finished, id: "stored" })),
      list: vi.fn(async () => [older, stored]),
      series: vi.fn(async () => [SPY, ES]),
    });
    await mount(<StrategyBuilderWorkspace gateway={gateway} />);
    expect(gateway.get).toHaveBeenCalledWith("stored");
    expect(gateway.submit).not.toHaveBeenCalled();
    expect(definitionText().name).toBe("Loaded rule");
    expect(field("Symbol and timeframe").value).toBe("SPY:1d");
    expect(field("From").value).toBe("1970-01-05");
    expect(field("To").value).toBe("1970-02-01");
    expect(field("Initial capital").value).toBe("20000");
    expect(field("Cost per side (bps)").value).toBe("4");
    const result = document.querySelector('[aria-label="Backtest result"]');
    expect(result?.textContent).toContain("The backtest finished.");
    expect(document.querySelector('[role="status"]')).toBeNull();
  });

  it("applies run and symbol deep links and falls back when invalid", async () => {
    const list = vi.fn(async () => [older, stored]);
    window.history.replaceState(null, "", "/?run=older");
    let gateway = gatewayOf({ list, series: vi.fn(async () => [SPY, QQQ]) });
    await mount(<StrategyBuilderWorkspace gateway={gateway} />);
    expect(gateway.get).toHaveBeenCalledWith("older");
    expect(field("Symbol and timeframe").value).toBe("QQQ:1d");
    await unmountAll();

    window.history.replaceState(null, "", "/?run=missing&symbol=nope");
    gateway = gatewayOf({ list, series: vi.fn(async () => [SPY, QQQ]) });
    await mount(<StrategyBuilderWorkspace gateway={gateway} />);
    expect(gateway.get).toHaveBeenCalledWith("stored");
    await unmountAll();

    window.history.replaceState(null, "", "/?symbol=QQQ");
    gateway = gatewayOf({ series: vi.fn(async () => [SPY, ES, QQQ]) });
    await mount(<StrategyBuilderWorkspace gateway={gateway} />);
    expect(field("Symbol and timeframe").value).toBe("QQQ:1d");
    expect(field("From").value).toBe("1970-01-11");
  });

  it("follows a linked run that has not finished yet", async () => {
    const fresh = runOf({ createdAt: new Date(9), id: "fresh" });
    window.history.replaceState(null, "", "/?run=fresh");
    const gateway = gatewayOf({
      get: vi.fn(async () => ({ ...finished, id: "fresh" })),
      list: vi.fn(async () => [stored, fresh]),
    });
    await mount(<StrategyBuilderWorkspace gateway={gateway} />);
    expect(gateway.get).toHaveBeenCalledWith("fresh");
    expect(window.location.search).toBe("?run=fresh");
    expect(
      document.querySelector('[aria-label="Backtest result"]')?.textContent
    ).toContain("The backtest finished.");
  });

  it("reads a linked run that is older than the listed runs", async () => {
    const ancient = runOf({
      createdAt: new Date(0),
      id: "ancient",
      spec: { ...older.spec, from: "1970-01-12" },
      status: "succeeded",
    });
    window.history.replaceState(null, "", "/?run=ancient");
    const gateway = gatewayOf({
      get: vi.fn(async () => ancient),
      list: vi.fn(async () => [stored]),
    });
    await mount(<StrategyBuilderWorkspace gateway={gateway} />);
    expect(gateway.get).toHaveBeenCalledWith("ancient");
    expect(field("Symbol and timeframe").value).toBe("QQQ:1d");
    expect(field("From").value).toBe("1970-01-12");
    expect(window.location.search).toBe("?run=ancient&symbol=QQQ");
  });

  it("falls back to the newest run only when the linked run is missing", async () => {
    window.history.replaceState(null, "", "/?run=gone");
    const gateway = gatewayOf({
      get: vi
        .fn<StrategyBuilderGateway["get"]>()
        .mockRejectedValueOnce(
          Object.assign(new Error("missing"), { code: "NOT_FOUND" })
        )
        .mockResolvedValue({ ...finished, id: "stored" }),
      list: vi.fn(async () => [stored]),
    });
    await mount(<StrategyBuilderWorkspace gateway={gateway} />);
    expect(gateway.get).toHaveBeenLastCalledWith("stored");
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(window.location.search).toBe("");
    await unmountAll();

    window.history.replaceState(null, "", "/?run=broken");
    const failing = gatewayOf({
      get: vi.fn(async () => {
        throw new Error("down");
      }),
      list: vi.fn(async () => [stored]),
    });
    await mount(<StrategyBuilderWorkspace gateway={failing} />);
    expect(failing.get).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[role="alert"]')).not.toBeNull();
    expect(document.querySelector('[role="status"]')).not.toBeNull();
    expect(definitionText()).toEqual(definition);
  });

  it("ignores a linked run read after unmount or a user edit", async () => {
    window.history.replaceState(null, "", "/?run=ancient");
    const late = deferred<BacktestRun>();
    const gateway = gatewayOf({
      get: vi.fn(() => late.promise),
      list: vi.fn(async () => [stored]),
    });
    await mount(<StrategyBuilderWorkspace gateway={gateway} />);
    await unmountAll();
    late.resolve(stored);
    await flush();
    expect(gateway.get).toHaveBeenCalledTimes(1);

    window.history.replaceState(null, "", "/?run=ancient");
    const editing = deferred<BacktestRun>();
    const edited = gatewayOf({
      get: vi.fn(() => editing.promise),
      list: vi.fn(async () => [stored]),
    });
    await mount(<StrategyBuilderWorkspace gateway={edited} />);
    await setNative(field("Strategy name"), "Mine");
    await settle(() => editing.resolve(stored));
    expect(definitionText().name).toBe("Mine");
    expect(edited.get).toHaveBeenCalledTimes(1);
    expect(window.location.search).toBe("?run=ancient");
  });

  it("selects the series of a linked run for another symbol", async () => {
    window.history.replaceState(null, "", "/?run=older&symbol=SPY");
    const gateway = gatewayOf({
      list: vi.fn(async () => [older, stored]),
      series: vi.fn(async () => [SPY, QQQ]),
    });
    await mount(<StrategyBuilderWorkspace gateway={gateway} />);
    expect(field("Symbol and timeframe").value).toBe("QQQ:1d");
    expect(window.location.search).toBe("?run=older&symbol=QQQ");
  });

  it("keeps the URL clean when the link names the default run", async () => {
    window.history.replaceState(null, "", "/?run=stored&symbol=SPY");
    const gateway = gatewayOf({
      list: vi.fn(async () => [older, stored]),
      series: vi.fn(async () => [SPY, QQQ]),
    });
    await mount(<StrategyBuilderWorkspace gateway={gateway} />);
    expect(gateway.get).toHaveBeenCalledWith("stored");
    expect(window.location.search).toBe("");
  });

  it("keeps user edits made while the stored runs load", async () => {
    const editing = deferred<BacktestRun[]>();
    const gateway = gatewayOf({ list: vi.fn(() => editing.promise) });
    await mount(<StrategyBuilderWorkspace gateway={gateway} />);
    await setNative(field("Strategy name"), "Mine");
    await settle(() => editing.resolve([stored]));
    expect(definitionText().name).toBe("Mine");
    expect(gateway.get).not.toHaveBeenCalled();
    expect(document.querySelector('[role="status"]')).toBeNull();
    await unmountAll();

    const submitting = deferred<BacktestRun[]>();
    const submitted = gatewayOf({ list: vi.fn(() => submitting.promise) });
    await mount(<StrategyBuilderWorkspace gateway={submitted} />);
    await settle(() => button("Run backtest").click());
    await settle(() => submitting.resolve([stored]));
    expect(submitted.get).toHaveBeenCalledTimes(1);
    expect(submitted.get).toHaveBeenCalledWith("run-1");
    expect(field("Symbol and timeframe").value).toBe("SPY:1d");
  });

  it("writes the symbol and the submitted run to the URL", async () => {
    const gateway = gatewayOf({ series: vi.fn(async () => [SPY, ES, QQQ]) });
    await mount(<StrategyBuilderWorkspace gateway={gateway} />);
    window.history.replaceState(null, "", "/?run=old");
    await setNative(field("Symbol and timeframe"), "QQQ:1d");
    expect(window.location.search).toBe("?symbol=QQQ");
    await setNative(field("Symbol and timeframe"), "ES=F:1d");
    expect(window.location.search).toBe("");
    await setNative(field("Symbol and timeframe"), "QQQ:1d");
    await settle(() => button("Run backtest").click());
    expect(gateway.submit).toHaveBeenCalledTimes(1);
    expect(new URLSearchParams(window.location.search).get("run")).toBe(
      "run-1"
    );
  });

  it("reports a failed run lookup and keeps the template", async () => {
    await mount(
      <StrategyBuilderWorkspace
        gateway={gatewayOf({
          list: vi.fn(async () => {
            throw new Error("down");
          }),
        })}
      />
    );
    expect(document.querySelector('[role="alert"]')).not.toBeNull();
    expect(document.querySelector('[role="status"]')).not.toBeNull();
    expect(definitionText()).toEqual(definition);
  });

  it("ignores the run lookup after unmount", async () => {
    const listDone = deferred<BacktestRun[]>();
    const pending = gatewayOf({ list: vi.fn(() => listDone.promise) });
    await mount(<StrategyBuilderWorkspace gateway={pending} />);
    await unmountAll();
    listDone.resolve([stored]);
    await flush();
    expect(pending.get).not.toHaveBeenCalled();

    const getDone = deferred<BacktestRun>();
    await mount(
      <StrategyBuilderWorkspace
        gateway={gatewayOf({
          get: vi.fn(() => getDone.promise),
          list: vi.fn(async () => [stored]),
        })}
      />
    );
    await unmountAll();
    getDone.resolve(finished);

    const listFailed = deferred<BacktestRun[]>();
    await mount(
      <StrategyBuilderWorkspace
        gateway={gatewayOf({ list: vi.fn(() => listFailed.promise) })}
      />
    );
    await unmountAll();
    listFailed.reject(new Error("late"));
    await flush();
    expect(document.body.textContent).toBe("");
  });

  it("parses every template it offers", () => {
    for (const id of [
      "smaCross",
      "rsiReversion",
      "donchianBreakout",
      "atrExpansion",
    ] as const) {
      expect(
        StrategyDefinitionSchema.safeParse(templateDefinition(id)).success
      ).toBe(true);
    }
  });
});

// Definitions with the newer expression types, series refs, filters and options and portfolio
// blocks: the builder shows what it does not edit read-only and keeps it unchanged.
const CHANGE_FUTURE = {
  length: 252,
  of: { series: "$future", type: "series" },
  type: "change",
} as const;
const OPTIONS_DEFINITION = {
  entry: {
    all: [{ left: CHANGE_FUTURE, op: ">", right: { type: "const", value: 0 } }],
  },
  exit: {
    any: [
      {
        left: {
          left: { field: "close", type: "price" },
          op: "div",
          right: { series: "SPY:TR", type: "series" },
          type: "math",
        },
        op: "<",
        right: { type: "const", value: 1 },
      },
    ],
  },
  filters: [
    {
      condition: {
        left: { field: "close", type: "price" },
        op: ">",
        right: { length: 20, name: "sma", source: "close", type: "indicator" },
      },
      series: "$iv",
      type: "series",
    },
    { length: 252, max: 50, type: "ivRank" },
  ],
  name: "Futures momentum spreads",
  options: {
    dte: { min: 45, target: 60 },
    exitDte: 21,
    longDelta: 0.5,
    maxLossPct: 2,
    structure: "callDebitVertical",
    widthSigma: 1,
  },
  portfolio: {
    frame: "monthly",
    legs: [
      {
        entry: {
          all: [
            {
              left: { field: "close", type: "price" },
              op: ">",
              right: { type: "const", value: 0 },
            },
          ],
        },
        options: {
          dte: { min: 30, target: 45 },
          maxLossPct: 1,
          shortDelta: 0.25,
          structure: "putCreditVertical",
          widthSigma: 1,
        },
      },
    ],
    policy: "roll",
    select: {
      score: {
        length: 12,
        of: { series: "$tr", type: "series" },
        type: "returnStdev",
      },
      top: 3,
    },
    symbols: ["SPY", "QQQ", "GLD"],
  },
  sizing: { mode: "allIn" },
  stopLoss: { kind: "none" },
  takeProfit: { kind: "none" },
  version: 1,
};

describe("strategy builder model: read-only expressions", () => {
  it("tells editable leaves from the other expression types", () => {
    expect(isEditableExpr(defaultExpr("price"))).toBe(true);
    expect(isEditableExpr(defaultExpr("const"))).toBe(true);
    expect(isEditableExpr(defaultExpr("indicator"))).toBe(true);
    expect(isEditableExpr({ series: "VIX", type: "series" })).toBe(false);
  });

  it("describes every expression type compactly", () => {
    const close = { field: "close", type: "price" } as const;
    const vix = { series: "VIX", type: "series" } as const;
    expect(describeExpr(close)).toBe("close");
    expect(describeExpr({ ...close, offset: 0 })).toBe("close");
    expect(describeExpr({ field: "high", offset: 2, type: "price" })).toBe(
      "high[2]"
    );
    expect(describeExpr({ type: "const", value: -1.5 })).toBe("-1.5");
    expect(describeExpr({ name: "vwap", type: "indicator" })).toBe("vwap");
    expect(
      describeExpr({
        from: "prevClose",
        name: "sessionReturn",
        to: "10:00",
        type: "indicator",
      })
    ).toBe("sessionReturn(prevClose, 10:00)");
    expect(
      describeExpr({
        band: "upper",
        length: 14,
        name: "noiseBand",
        type: "indicator",
      })
    ).toBe("noiseBand(upper, 14)");
    expect(
      describeExpr({
        band: "lower",
        length: 10,
        multiple: 1.2,
        name: "noiseBand",
        type: "indicator",
      })
    ).toBe("noiseBand(lower, 10, 1.2)");
    expect(
      describeExpr({
        length: 20,
        name: "sma",
        offset: 1,
        source: "close",
        type: "indicator",
      })
    ).toBe("sma(close, 20)[1]");
    expect(
      describeExpr({
        length: 14,
        name: "atr",
        source: "close",
        type: "indicator",
      })
    ).toBe("atr(14)");
    expect(describeExpr(CHANGE_FUTURE)).toBe("change(series $future, 252)");
    expect(describeExpr({ ...CHANGE_FUTURE, offset: 21 })).toBe(
      "change(series $future, 252)[21]"
    );
    expect(describeExpr({ ...vix, offset: 3 })).toBe("series VIX[3]");
    expect(
      ["add", "sub", "mul", "div"].map((op) =>
        describeExpr({
          left: close,
          op: op as "add",
          right: vix,
          type: "math",
        })
      )
    ).toEqual([
      "(close + series VIX)",
      "(close - series VIX)",
      "(close * series VIX)",
      "(close / series VIX)",
    ]);
    expect(describeExpr({ length: 21, of: vix, type: "returnStdev" })).toBe(
      "returnStdev(series VIX, 21)"
    );
    expect(
      describeExpr({ lag: 1, length: 60, type: "regression", x: vix, y: close })
    ).toBe("regression(close on series VIX, 60, lag 1)");
    expect(
      describeExpr({ minCount: 5, monthsAhead: 1, of: close, type: "seasonal" })
    ).toBe("seasonal(close, 1 months ahead, min 5)");
    expect(
      describeCondition({
        left: close,
        op: "crossesAbove",
        right: { type: "const", value: 0 },
      })
    ).toBe("close crossesAbove 0");
  });

  it("describes filters, series refs and the options and portfolio blocks", () => {
    const parsed = StrategyDefinitionSchema.parse(OPTIONS_DEFINITION);
    const [series, ivRank] = parsed.filters ?? [];
    expect(describeFilter(series as NonNullable<typeof series>)).toBe(
      "series $iv: close > sma(close, 20)"
    );
    expect(describeFilter(ivRank as NonNullable<typeof ivRank>)).toBe(
      'ivRank {"length":252,"max":50}'
    );
    expect(
      ["$tr", "$iv", "$future", "SPY:TR", "VIX"].map((ref) =>
        seriesRefLabel(ref as "VIX")
      )
    ).toEqual([
      "$tr (total return of the traded symbol)",
      "$iv (IV index of the traded symbol)",
      "$future (futures twin of the traded symbol)",
      "SPY:TR (SPY total return)",
      "VIX",
    ]);
    expect(
      describeOptions(parsed.options as NonNullable<typeof parsed.options>)
    ).toBe(
      "callDebitVertical, DTE 45 to 60, max loss 2% of equity, width 1 sigma, exitDte 21, longDelta 0.5"
    );
    expect(
      describePortfolio(
        parsed.portfolio as NonNullable<typeof parsed.portfolio>
      )
    ).toEqual([
      "Policy roll, frame monthly",
      "Symbols SPY, QQQ, GLD",
      "Each month-end, the top 3 by returnStdev(series $tr, 12)",
      "Leg 2: enter when close > 0; putCreditVertical, DTE 30 to 45, max loss 1% of equity, width 1 sigma, shortDelta 0.25",
    ]);
    expect(
      describePortfolio({
        policy: "roll",
        select: {
          score: { series: "$tr", type: "series" },
          tieBreak: { type: "const", value: 1 },
          top: 1,
        },
        symbols: ["SPY"],
      })[2]
    ).toBe("Each month-end, the top 1 by series $tr, then 1");
    expect(
      describePortfolio({ cadence: "daily", policy: "flat", symbols: ["USO"] })
    ).toEqual(["Policy flat, cadence daily", "Symbols USO"]);
  });
});

describe("StrategyBuilderWorkspace: newer definitions", () => {
  it("shows new expressions, filters and blocks read-only and keeps them on visual edits", async () => {
    const gateway = gatewayOf();
    await mount(<StrategyBuilderWorkspace gateway={gateway} />);
    expect(document.querySelector("[data-filter-list]")?.textContent).toContain(
      "No filters."
    );
    expect(document.querySelector("[data-options-summary]")).toBeNull();
    await setNative(
      field("Definition text"),
      JSON.stringify(OPTIONS_DEFINITION, null, 2)
    );
    expect(document.body.textContent).toContain("The definition is valid.");
    const stored = definitionText();

    // Read-only expressions: a text summary, and the input select names the expression.
    const entry = document.querySelector('[data-expr-readonly="change"]');
    expect(entry?.querySelector("code")?.textContent).toBe(
      "change(series $future, 252)"
    );
    expect(field("Entry 1 left input").value).toBe("change");
    const disabled =
      field("Entry 1 left input").querySelector("option:disabled");
    expect(disabled?.textContent).toBe("Expression (edit as JSON)");
    expect(
      document.querySelector('[data-expr-readonly="math"] code')?.textContent
    ).toBe("(close / series SPY:TR)");
    expect(has("Entry 1 right value")).toBe(true);

    // Filters: the series select offers ids, total-return ids and the relative refs.
    const options = Array.from(
      field("Filter 1 series").querySelectorAll("option"),
      (option) => option.value
    );
    expect(options).toEqual(
      expect.arrayContaining([
        "SPY",
        "VIX",
        "SPY:TR",
        "USO:TR",
        "$tr",
        "$iv",
        "$future",
      ])
    );
    expect(field("Filter 1 series").value).toBe("$iv");
    expect(
      document.querySelector('[data-filter-summary="series"]')?.textContent
    ).toBe("close > sma(close, 20)");
    expect(
      document.querySelector('[data-filter-summary="ivRank"]')?.textContent
    ).toBe('ivRank {"length":252,"max":50}');
    expect(has("Filter 2 series")).toBe(false);

    // Options and portfolio blocks.
    const summary = document.querySelector("[data-options-summary]");
    expect(summary?.textContent).toContain(
      "Option vertical: callDebitVertical, DTE 45 to 60"
    );
    expect(
      document.querySelectorAll("[data-portfolio-summary] li")
    ).toHaveLength(4);

    // Visual edits keep every expression and block the builder does not edit.
    await setNative(field("Strategy name"), "Renamed");
    await setNative(field("Filter 1 series"), "$future");
    let text = definitionText();
    expect(text.name).toBe("Renamed");
    expect(text.filters[0].series).toBe("$future");
    expect(text.entry).toEqual(stored.entry);
    expect(text.exit).toEqual(stored.exit);
    expect(text.filters[1]).toEqual(stored.filters[1]);
    expect(text.options).toEqual(stored.options);
    expect(text.portfolio).toEqual(stored.portfolio);

    await settle(() => button("Run backtest").click());
    expect(gateway.submit).toHaveBeenCalledWith(
      expect.objectContaining({
        rule: {
          definition: StrategyDefinitionSchema.parse(text),
          kind: "dsl",
        },
      })
    );

    // Choosing an editable input replaces the read-only expression.
    await setNative(field("Entry 1 left input"), "price");
    text = definitionText();
    expect(text.entry.all[0].left).toEqual({ field: "close", type: "price" });
    expect(document.querySelector('[data-expr-readonly="change"]')).toBeNull();
  });

  it("shows an options block without a portfolio", async () => {
    await mount(<StrategyBuilderWorkspace gateway={gatewayOf()} />);
    const {
      filters: _filters,
      portfolio: _portfolio,
      ...rest
    } = OPTIONS_DEFINITION;
    await setNative(field("Definition text"), JSON.stringify(rest));
    expect(document.body.textContent).toContain("The definition is valid.");
    expect(document.querySelector("[data-options-summary]")).not.toBeNull();
    expect(document.querySelector("[data-portfolio-summary]")).toBeNull();
    expect(document.querySelector("[data-filter-list]")?.textContent).toContain(
      "No filters."
    );
  });

  it("shows session indicators and volTarget sizing as JSON-only fields", async () => {
    await mount(<StrategyBuilderWorkspace gateway={gatewayOf()} />);
    const ghlz = {
      entry: {
        all: [
          {
            left: {
              from: "prevClose",
              name: "sessionReturn",
              to: "10:00",
              type: "indicator",
            },
            op: ">",
            right: { type: "const", value: 0 },
          },
        ],
      },
      intraday: {
        close: "16:00",
        entryFrom: "15:30",
        entryTo: "15:30",
        open: "09:30",
        timezone: "America/New_York",
      },
      name: "GHLZ intraday momentum long",
      sizing: { length: 14, maxLeverage: 4, mode: "volTarget", targetPct: 2 },
      stopLoss: { kind: "none" },
      version: 1,
    };
    await setNative(field("Definition text"), JSON.stringify(ghlz));
    expect(document.body.textContent).toContain("The definition is valid.");
    expect(document.body.textContent).toContain(
      "sessionReturn. Edit it in the JSON text."
    );
    expect(document.body.textContent).toContain(
      "Volatility target (edit in the JSON text)"
    );
  });
});
