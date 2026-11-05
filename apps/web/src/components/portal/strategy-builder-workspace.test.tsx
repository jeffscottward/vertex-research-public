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
  INDICATOR_LABELS,
  lengthUnit,
  numberOf,
  replaceAt,
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
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.replaceChildren();
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
    expect([lengthUnit("rvol"), lengthUnit("adx")]).toEqual([
      "sessions",
      "bars",
    ]);
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
    for (const root of roots.splice(0)) await act(async () => root.unmount());

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
    for (const root of roots.splice(0)) await act(async () => root.unmount());

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
    for (const root of roots.splice(0)) await act(async () => root.unmount());

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
    for (const root of roots.splice(0)) await act(async () => root.unmount());

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
    for (const root of roots.splice(0)) await act(async () => root.unmount());
    finishGet(finished);
    await flush();

    await mount(<StrategyBuilderWorkspace gateway={gateway} />);
    await settle(() => button("Run backtest").click());
    for (const root of roots.splice(0)) await act(async () => root.unmount());
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
    for (const root of roots.splice(0)) await act(async () => root.unmount());
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
    for (const root of roots.splice(0)) await act(async () => root.unmount());
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
    for (const root of roots.splice(0)) await act(async () => root.unmount());

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
    for (const root of roots.splice(0)) await act(async () => root.unmount());

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
    for (const root of roots.splice(0)) await act(async () => root.unmount());

    await mount(<StrategyBuilderWorkspace />);
    expect(browserGateway.series).toHaveBeenCalled();
    expect(document.body.textContent).toContain("No stored bar series.");
    expect(button("Run backtest").disabled).toBe(true);
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
