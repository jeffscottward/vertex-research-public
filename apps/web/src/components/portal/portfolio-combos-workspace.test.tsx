// @vitest-environment jsdom
import {
  BACKTEST_COMBO_SLOTS_MAX,
  type BacktestCombo,
  type BacktestRunSummary,
  STRATEGY_TEMPLATES,
  StrategyDefinitionSchema,
} from "@darkfactory/api";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  COMBO_DEBOUNCE_MS,
  canCombine,
  comboRequest,
  createBrowserPortfolioCombosGateway,
  createPortfolioCombosGateway,
  defaultComboRunIds,
  describeRun,
  equalWeights,
  equityPath,
  type PortfolioCombosGateway,
  PortfolioCombosWorkspace,
  parseComboRuns,
  slotLimitMessage,
  symbolRank,
  weightTotal,
} from "./portfolio-combos-workspace.tsx";

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
  return { container, root };
};
const setNative = async (element: HTMLInputElement, value: string) => {
  await settle(() => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value"
    )?.set?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
const click = (element: Element | null | undefined) =>
  settle(() => (element as HTMLElement).click());

const runOf = (
  id: string,
  overrides: Partial<BacktestRunSummary> = {}
): BacktestRunSummary => ({
  createdAt: new Date(0),
  engineVersion: "instant-1",
  error: null,
  finishedAt: new Date(0),
  id,
  spec: {
    costBps: 0,
    from: "1970-01-01",
    initialCapital: 10_000,
    rule: { fast: 5, kind: "smaCross", slow: 20 },
    stopLossPct: 0,
    symbol: "TEST",
    takeProfitPct: 0,
    timeframe: "1d",
    to: "1971-01-01",
  },
  startedAt: new Date(0),
  status: "succeeded",
  strategyId: null,
  strategyRevision: null,
  strategySnapshot: null,
  ...overrides,
});

const stats = {
  cagr: 0.1,
  maxDrawdownPct: 0.05,
  sharpe: 1.2,
  totalReturn: 0.1,
};
const comboOf = (overrides: Partial<BacktestCombo> = {}): BacktestCombo => ({
  cash: 0,
  correlation: [
    [1, null],
    [null, 1],
  ],
  deposit: 100_000,
  diversification: {
    combinedDrawdownPct: 0.04,
    diversified: true,
    ratio: 1.3,
    weightedSlotDrawdownPct: 0.05,
  },
  drawdownOverlap: [
    [0.5, 0.1],
    [0.1, 0.4],
  ],
  finalEquity: 110_000,
  jointDrawdownShare: 0.1,
  netProfit: 10_000,
  points: [
    { drawdownPct: 0, equity: 100_000, t: 0 },
    { drawdownPct: 0, equity: 110_000, t: 1 },
  ],
  slots: ["a", "b"].map((runId) => ({
    allocation: 50_000,
    engineVersion: "instant-1",
    full: stats,
    label: `slot ${runId}`,
    pnl: 5000,
    recent: { ...stats, cagr: null, sharpe: null },
    runId,
    seriesSha256: "f".repeat(64),
    strategyRevision: runId === "a" ? "a".repeat(64) : null,
    verdict: "robust" as const,
    verdictReason: "ok",
    weight: 0.5,
  })),
  stats,
  ...overrides,
});

const runAt = (
  id: string,
  symbol: string,
  overrides: Partial<BacktestRunSummary> = {}
): BacktestRunSummary => {
  const run = runOf(id, overrides);
  return { ...run, spec: { ...run.spec, symbol } };
};

// Newest first. Default set: the four newest Core 7 futures runs (e, n, g, y).
const labRuns = (): BacktestRunSummary[] => [
  runAt("t", "TEST", {
    strategySnapshot: {
      id: "s",
      kind: "native",
      name: "Alpha",
      params: [],
      slug: "alpha",
      sourceRef: null,
      updatedAt: "x",
    },
  }),
  runAt("e", "ES=F", { strategyRevision: "a".repeat(64) }),
  runAt("s", "SPY"),
  runAt("n", "NQ=F"),
  runAt("g", "GC=F"),
  runAt("y", "YM=F"),
  runAt("f", "ES=F", { status: "failed" }),
];

const gatewayOf = (
  overrides: Partial<PortfolioCombosGateway> = {}
): PortfolioCombosGateway => ({
  combine: vi.fn(async () => comboOf()),
  list: vi.fn(async () => labRuns()),
  ...overrides,
});

const slotOf = (runId: string, weight: number) => ({
  expectedRevision: runId === "e" ? "a".repeat(64) : null,
  runId,
  weight,
});
const DEFAULT_SLOTS = ["e", "n", "g", "y"].map((id) => slotOf(id, 0.25));

const boxes = () => [
  ...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
];
const box = (label: string) =>
  boxes().find((node) =>
    node.parentElement?.textContent?.includes(label)
  ) as HTMLInputElement;
const checked = () =>
  boxes()
    .filter((node) => node.checked)
    .map((node) => node.parentElement?.textContent?.split(" ")[0]);
const weightInputs = () => [
  ...document.querySelectorAll<HTMLInputElement>('input[aria-label^="Weight"]'),
];
const button = () =>
  [...document.querySelectorAll("button")].find(
    (node) => node.textContent === "Combine"
  ) as HTMLButtonElement;
const report = () =>
  document.querySelector('[aria-label="Combined portfolio"]');
const runsParam = () => new URLSearchParams(window.location.search).get("runs");
const visit = (search: string) =>
  window.history.replaceState(null, "", `/portfolio-combos${search}`);
const wait = (ms = COMBO_DEBOUNCE_MS) =>
  settle(() => {
    vi.advanceTimersByTime(ms);
  });

describe("helpers", () => {
  it("builds the gateway, labels and the equity path", async () => {
    const client = {
      backtestRuns: {
        combine: vi.fn(async () => comboOf()),
        list: vi.fn(async () => ({ runs: [runOf("a")] })),
      },
    };
    const gateway = createPortfolioCombosGateway(client as never);
    await expect(gateway.list()).resolves.toHaveLength(1);
    await gateway.combine({ deposit: 1, slots: [] });
    expect(client.backtestRuns.list).toHaveBeenCalledWith({ limit: 100 });
    expect(describeRun(runOf("a"))).toBe(
      "TEST 1d SMA 5/20 1970-01-01..1971-01-01"
    );
    expect(
      describeRun(
        runOf("b", {
          spec: {
            ...runOf("b").spec,
            rule: {
              entryLookback: 20,
              exitLookback: 10,
              kind: "breakout",
              trendSma: 0,
            },
          },
        })
      )
    ).toBe("TEST 1d Breakout 20/10 1970-01-01..1971-01-01");
    expect(
      describeRun(
        runOf("c", {
          spec: {
            ...runOf("c").spec,
            rule: {
              definition: StrategyDefinitionSchema.parse(
                STRATEGY_TEMPLATES.rsiReversion
              ),
              kind: "dsl",
            },
          },
        })
      )
    ).toBe("TEST 1d Definition RSI reversion 1970-01-01..1971-01-01");
    expect(equityPath([], 10, 10)).toBe("");
    expect(
      equityPath(
        [
          { drawdownPct: 0, equity: 1, t: 0 },
          { drawdownPct: 0, equity: 1, t: 0 },
        ],
        10,
        10
      )
    ).toBe("M0.0,10.0 L0.0,10.0");
  });

  it("ranks Core 7 symbols and picks the default runs", () => {
    expect([symbolRank("ES=F"), symbolRank("SPY"), symbolRank("TEST")]).toEqual(
      [0, 1, 2]
    );
    const runs = [
      runAt("t", "TEST"),
      runAt("s", "SPY"),
      runAt("e1", "ES=F"),
      runAt("e2", "ES=F"),
      runAt("n", "NQ=F"),
      runAt("g", "GC=F"),
    ];
    // Futures first (one per symbol), then the ETF twin, then any symbol, then repeats.
    expect(defaultComboRunIds(runs)).toEqual(["e1", "n", "g", "s"]);
    expect(defaultComboRunIds(runs, 6)).toEqual([
      "e1",
      "n",
      "g",
      "s",
      "t",
      "e2",
    ]);
    expect(defaultComboRunIds([runAt("t", "TEST")])).toEqual(["t"]);
    expect(defaultComboRunIds([])).toEqual([]);
  });

  it("reads ?runs=, dropping unknown ids", () => {
    const runs = labRuns();
    expect(parseComboRuns("?runs=n,zz,t", runs)).toEqual(["n", "t"]);
    expect(parseComboRuns("?runs=zz", runs)).toEqual(["e", "n", "g", "y"]);
    expect(parseComboRuns("", runs)).toEqual(["e", "n", "g", "y"]);
  });

  it("splits weights and checks a request", () => {
    expect(equalWeights([])).toEqual({});
    expect(equalWeights(["a"])).toEqual({ a: 1 });
    expect(equalWeights(["a", "b", "c"])).toEqual({ a: 0.3, b: 0.3, c: 0.3 });
    expect(equalWeights(["a", "b", "c", "d"])).toEqual({
      a: 0.25,
      b: 0.25,
      c: 0.25,
      d: 0.25,
    });
    const request = comboRequest(labRuns(), { e: 0.5, t: 0.25 }, 1000);
    expect(request).toEqual({
      deposit: 1000,
      slots: [
        { expectedRevision: null, runId: "t", weight: 0.25 },
        slotOf("e", 0.5),
      ],
    });
    expect(weightTotal(request)).toBe(0.75);
    expect(canCombine(request)).toBe(true);
    expect(canCombine({ ...request, slots: [] })).toBe(false);
    expect(canCombine({ ...request, deposit: 0 })).toBe(false);
    expect(canCombine({ ...request, deposit: 2_000_000_000 })).toBe(false);
    expect(canCombine(comboRequest(labRuns(), { e: 0.8, t: 0.25 }, 1000))).toBe(
      false
    );
    expect(slotLimitMessage(request)).toBeNull();
    const many = Array.from(
      { length: BACKTEST_COMBO_SLOTS_MAX + 1 },
      (_, index) => ({ runId: `r${index}`, weight: 0.05 })
    );
    expect(slotLimitMessage({ deposit: 1000, slots: many })).toBe(
      "Pick at most 10 runs."
    );
    expect(canCombine({ deposit: 1000, slots: many })).toBe(false);
    for (const weight of [-0.1, 1.5, Number.NaN]) {
      const bad = { deposit: 1000, slots: [{ runId: "e", weight }] };
      expect(slotLimitMessage(bad)).toBe(
        "Each weight must be between 0 and 1."
      );
      expect(canCombine(bad)).toBe(false);
    }
  });
});

describe("PortfolioCombosWorkspace", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    visit("");
  });
  afterEach(() => {
    vi.useRealTimers();
    visit("");
  });

  it("opens with the default Core 7 runs combined, with no input", async () => {
    const gateway = gatewayOf();
    await mount(<PortfolioCombosWorkspace gateway={gateway} />);
    expect(boxes()).toHaveLength(6);
    expect(document.body.textContent).toContain("Alpha TEST 1d SMA 5/20");
    expect(checked()).toEqual(["ES=F", "NQ=F", "GC=F", "YM=F"]);
    expect(weightInputs().map((input) => input.value)).toEqual([
      "0.25",
      "0.25",
      "0.25",
      "0.25",
    ]);
    expect(document.body.textContent).toContain("Weights total 100.00%");
    // Debounced: nothing is sent until the choice settles.
    expect(gateway.combine).not.toHaveBeenCalled();
    await wait();
    expect(gateway.list).toHaveBeenCalledTimes(1);
    expect(gateway.combine).toHaveBeenCalledTimes(1);
    expect(gateway.combine).toHaveBeenCalledWith({
      deposit: 100_000,
      slots: DEFAULT_SLOTS,
    });
    expect(report()?.textContent).toContain("110,000.00");
    expect(report()?.textContent).toContain("diversified");
    expect(report()?.textContent).toContain("robust");
    expect(report()?.textContent).toContain(`Revision ${"a".repeat(12)}`);
    expect(report()?.textContent).toContain("none (no linked strategy)");
    expect(report()?.textContent).toContain("ok");
    expect(report()?.textContent).toContain("n/a");
    // The default view keeps a clean URL.
    expect(window.location.search).toBe("");
  });

  it("applies a ?runs= deep link and drops unknown ids", async () => {
    visit("?runs=t,zz,s,f");
    const gateway = gatewayOf();
    await mount(<PortfolioCombosWorkspace gateway={gateway} />);
    expect(checked()).toEqual(["Alpha", "SPY"]);
    expect(runsParam()).toBe("t,s");
    await wait();
    expect(gateway.combine).toHaveBeenCalledWith({
      deposit: 100_000,
      slots: [
        { expectedRevision: null, runId: "t", weight: 0.5 },
        { expectedRevision: null, runId: "s", weight: 0.5 },
      ],
    });
  });

  it("falls back to the default runs when ?runs= names none", async () => {
    visit("?runs=zz&other=1");
    const gateway = gatewayOf();
    await mount(<PortfolioCombosWorkspace gateway={gateway} />);
    expect(checked()).toEqual(["ES=F", "NQ=F", "GC=F", "YM=F"]);
    expect(window.location.search).toBe("?other=1");
    await wait();
    expect(gateway.combine).toHaveBeenCalledWith({
      deposit: 100_000,
      slots: DEFAULT_SLOTS,
    });
  });

  it("writes changes to the URL and re-combines once, from the cache on return", async () => {
    const gateway = gatewayOf();
    await mount(<PortfolioCombosWorkspace gateway={gateway} />);
    await wait();
    expect(gateway.combine).toHaveBeenCalledTimes(1);

    await click(box("GC=F"));
    expect(runsParam()).toBe("e,n,y");
    expect(weightInputs()).toHaveLength(3);
    // A quick change back inside the pause sends nothing.
    await click(box("GC=F"));
    expect(window.location.search).toBe("");
    await wait();
    expect(gateway.combine).toHaveBeenCalledTimes(1);

    await click(box("GC=F"));
    await wait(COMBO_DEBOUNCE_MS - 1);
    expect(gateway.combine).toHaveBeenCalledTimes(1);
    await wait(1);
    expect(gateway.combine).toHaveBeenCalledTimes(2);
    expect(gateway.combine).toHaveBeenLastCalledWith({
      deposit: 100_000,
      slots: ["e", "n", "y"].map((id) => slotOf(id, 0.25)),
    });

    // Back to the default mix: served from the cache, no third request.
    await click(box("GC=F"));
    expect(window.location.search).toBe("");
    await wait();
    expect(gateway.combine).toHaveBeenCalledTimes(2);
    expect(report()).not.toBeNull();
  });

  it("never sends more than 10 runs or a weight outside 0..1", async () => {
    const many = Array.from(
      { length: BACKTEST_COMBO_SLOTS_MAX + 1 },
      (_, index) => runAt(`m${index}`, "TEST")
    );
    const gateway = gatewayOf({ list: async () => many });
    await mount(<PortfolioCombosWorkspace gateway={gateway} />);
    await wait();
    expect(gateway.combine).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).not.toContain("Pick at most");

    for (const node of boxes().filter((input) => !input.checked))
      await click(node);
    for (const input of weightInputs()) await setNative(input, "0");
    expect(document.body.textContent).toContain("Pick at most 10 runs.");
    expect(button().disabled).toBe(true);
    await wait();
    expect(gateway.combine).toHaveBeenCalledTimes(1);
    expect(report()).toBeNull();

    await click(boxes()[0]);
    expect(document.body.textContent).not.toContain("Pick at most");
    await setNative(weightInputs()[0] as HTMLInputElement, "-0.5");
    expect(document.body.textContent).toContain(
      "Each weight must be between 0 and 1."
    );
    expect(document.body.textContent).not.toContain("above 100%");
    expect(button().disabled).toBe(true);
    await wait();
    expect(gateway.combine).toHaveBeenCalledTimes(1);
  });

  it("blocks weights above 100% and combines on demand", async () => {
    const gateway = gatewayOf();
    await mount(<PortfolioCombosWorkspace gateway={gateway} />);
    await wait();
    await setNative(weightInputs()[0] as HTMLInputElement, "0.8");
    expect(document.body.textContent).toContain("above 100%");
    expect(button().disabled).toBe(true);
    await wait();
    expect(report()).toBeNull();
    expect(gateway.combine).toHaveBeenCalledTimes(1);

    await setNative(weightInputs()[0] as HTMLInputElement, "0.1");
    await setNative(
      document.querySelector<HTMLInputElement>(
        'input[type="number"][min="1"]'
      ) as HTMLInputElement,
      "50000"
    );
    expect(button().disabled).toBe(false);
    await click(button());
    const slots = [slotOf("e", 0.1), ...DEFAULT_SLOTS.slice(1)];
    expect(gateway.combine).toHaveBeenLastCalledWith({
      deposit: 50_000,
      slots,
    });
    expect(report()?.textContent).toContain("110,000.00");
    // The settled choice equals the one just combined, so the cache answers it.
    await wait();
    expect(gateway.combine).toHaveBeenCalledTimes(2);
  });

  it("shows combine failures and a retry result", async () => {
    const combine = vi
      .fn()
      .mockRejectedValueOnce({ code: "BAD_REQUEST", message: "pin mismatch" })
      .mockResolvedValueOnce(
        comboOf({
          diversification: {
            combinedDrawdownPct: 0.05,
            diversified: false,
            ratio: null,
            weightedSlotDrawdownPct: 0.05,
          },
          stats: { ...stats, cagr: null },
        })
      )
      .mockRejectedValueOnce({ code: "ERROR", message: "down" });
    await mount(<PortfolioCombosWorkspace gateway={gatewayOf({ combine })} />);
    await wait();
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      "pin mismatch"
    );
    expect(report()).toBeNull();
    await click(button());
    expect(document.body.textContent).toContain("not diversified");
    expect(document.querySelector('[role="alert"]')).toBeNull();
    await click(button());
    expect(document.querySelector('[role="alert"]')?.textContent).toBe("down");
    expect(report()).toBeNull();
  });

  it("shows progress and ignores a result for an older choice", async () => {
    const done: Array<(combo: BacktestCombo) => void> = [];
    const fail: Array<(error: unknown) => void> = [];
    // The web tsconfig lib predates Promise.withResolvers.
    const combine = vi.fn(
      () =>
        new Promise<BacktestCombo>((resolve, reject) => {
          done.push(resolve);
          fail.push(reject);
        })
    );
    const { root } = await mount(
      <PortfolioCombosWorkspace gateway={gatewayOf({ combine })} />
    );
    await wait();
    expect(document.body.textContent).toContain("Combining runs");
    expect(button().disabled).toBe(true);
    await click(box("GC=F"));
    await wait();
    expect(combine).toHaveBeenCalledTimes(2);
    // The first answer arrives late: it is cached but not shown.
    await settle(() => done[0]?.(comboOf({ finalEquity: 1 })));
    expect(report()).toBeNull();
    expect(document.body.textContent).toContain("Combining runs");
    await settle(() => done[1]?.(comboOf()));
    expect(report()?.textContent).toContain("110,000.00");
    expect(document.body.textContent).not.toContain("Combining runs");

    // Back to the first choice: its late answer comes from the cache.
    await click(box("GC=F"));
    await wait();
    expect(combine).toHaveBeenCalledTimes(2);
    expect(report()?.textContent).not.toContain("110,000.00");

    // A failure after the page closes is ignored.
    await click(box("YM=F"));
    await wait();
    expect(combine).toHaveBeenCalledTimes(3);
    await act(async () => root.unmount());
    roots.splice(roots.indexOf(root), 1);
    await settle(() => fail[2]?.(new Error("late")));
  });

  it("drops a slow manual combine once a newer automatic one starts", async () => {
    const done: Array<(combo: BacktestCombo) => void> = [];
    // The web tsconfig lib predates Promise.withResolvers.
    const combine = vi.fn(
      () =>
        new Promise<BacktestCombo>((resolve) => {
          done.push(resolve);
        })
    );
    await mount(<PortfolioCombosWorkspace gateway={gatewayOf({ combine })} />);
    await wait();
    await settle(() => done[0]?.(comboOf()));
    expect(report()?.textContent).toContain("110,000.00");

    // Manual combine right away, then the settled change starts an automatic one.
    await setNative(weightInputs()[0] as HTMLInputElement, "0.2");
    await click(button());
    expect(combine).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).toContain("Combining runs");
    await wait();
    expect(combine).toHaveBeenCalledTimes(3);

    await settle(() => done[2]?.(comboOf({ finalEquity: 333_333 })));
    expect(report()?.textContent).toContain("333,333.00");
    expect(document.body.textContent).not.toContain("Combining runs");
    // The manual answer arrives last: it neither replaces the newer result nor the idle state.
    await settle(() => done[1]?.(comboOf({ finalEquity: 222_222 })));
    expect(report()?.textContent).toContain("333,333.00");
    expect(report()?.textContent).not.toContain("222,222.00");
    expect(document.body.textContent).not.toContain("Combining runs");
  });

  it("shows loading, empty, forbidden and error states", async () => {
    let resolve: (runs: BacktestRunSummary[]) => void = () => undefined;
    // The web tsconfig lib predates Promise.withResolvers.
    const pending = new Promise<BacktestRunSummary[]>((done) => {
      resolve = done;
    });
    const { root } = await mount(
      <PortfolioCombosWorkspace gateway={gatewayOf({ list: () => pending })} />
    );
    expect(document.body.textContent).toContain("Loading finished runs");
    await act(async () => root.unmount());
    roots.splice(roots.indexOf(root), 1);
    await settle(() => resolve([]));

    const empty = gatewayOf({ list: async () => [] });
    await mount(<PortfolioCombosWorkspace gateway={empty} />);
    expect(document.body.textContent).toContain("No finished backtest runs");
    expect(button().disabled).toBe(true);
    await wait();
    expect(empty.combine).not.toHaveBeenCalled();
    expect(window.location.search).toBe("");
    document.body.replaceChildren();

    await mount(
      <PortfolioCombosWorkspace
        gateway={gatewayOf({
          list: async () => Promise.reject({ code: "FORBIDDEN" }),
        })}
      />
    );
    expect(document.body.textContent).not.toContain("Combine");
    document.body.replaceChildren();

    await mount(
      <PortfolioCombosWorkspace
        gateway={gatewayOf({
          list: async () => Promise.reject({ code: "ERROR", message: "down" }),
        })}
      />
    );
    expect(document.querySelector('[role="alert"]')?.textContent).toBe("down");

    let reject: (error: unknown) => void = () => undefined;
    const failing = new Promise<BacktestRunSummary[]>((_, fail) => {
      reject = fail;
    });
    const second = await mount(
      <PortfolioCombosWorkspace gateway={gatewayOf({ list: () => failing })} />
    );
    await act(async () => second.root.unmount());
    roots.splice(roots.indexOf(second.root), 1);
    await settle(() => reject(new Error("late")));
  });

  it("uses the browser client when no gateway is given and never submits", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 500 }));
    await mount(<PortfolioCombosWorkspace />);
    await wait();
    expect(fetchSpy).toHaveBeenCalled();
    await expect(
      createBrowserPortfolioCombosGateway().combine({ deposit: 1, slots: [] })
    ).rejects.toBeDefined();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const urls = fetchSpy.mock.calls.map(([input]) =>
      input instanceof Request ? input.url : String(input)
    );
    expect(urls.some((url) => url.includes("submit"))).toBe(false);
    fetchSpy.mockRestore();
  });
});
