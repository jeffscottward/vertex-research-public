// @vitest-environment jsdom
import {
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
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  createBrowserPortfolioCombosGateway,
  createPortfolioCombosGateway,
  describeRun,
  equityPath,
  type PortfolioCombosGateway,
  PortfolioCombosWorkspace,
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

const gatewayOf = (
  overrides: Partial<PortfolioCombosGateway> = {}
): PortfolioCombosGateway => ({
  combine: vi.fn(async () => comboOf()),
  list: vi.fn(async () => [
    runOf("a", {
      strategyRevision: "a".repeat(64),
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
    runOf("b"),
    runOf("c", { status: "failed" }),
  ]),
  ...overrides,
});

const boxes = () => [
  ...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
];
const button = () =>
  [...document.querySelectorAll("button")].find(
    (node) => node.textContent === "Combine"
  ) as HTMLButtonElement;

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
});

describe("PortfolioCombosWorkspace", () => {
  it("combines selected runs pinned to their revision and shows the report", async () => {
    const gateway = gatewayOf();
    await mount(<PortfolioCombosWorkspace gateway={gateway} />);
    expect(boxes()).toHaveLength(2);
    expect(document.body.textContent).toContain("Alpha TEST 1d SMA 5/20");
    expect(button().disabled).toBe(true);
    await click(boxes()[0]);
    await click(boxes()[1]);
    const weights = [
      ...document.querySelectorAll<HTMLInputElement>(
        'input[aria-label^="Weight"]'
      ),
    ];
    await setNative(weights[0] as HTMLInputElement, "0.8");
    expect(document.body.textContent).toContain("above 100%");
    expect(button().disabled).toBe(true);
    await setNative(weights[0] as HTMLInputElement, "0.6");
    await setNative(
      document.querySelector<HTMLInputElement>(
        'input[type="number"][min="1"]'
      ) as HTMLInputElement,
      "50000"
    );
    await click(button());
    expect(gateway.combine).toHaveBeenCalledWith({
      deposit: 50_000,
      slots: [
        { expectedRevision: "a".repeat(64), runId: "a", weight: 0.6 },
        { expectedRevision: null, runId: "b", weight: 0.25 },
      ],
    });
    const report = document.querySelector('[aria-label="Combined portfolio"]');
    expect(report?.textContent).toContain("110,000.00");
    expect(report?.textContent).toContain("diversified");
    expect(report?.textContent).toContain("robust");
    expect(report?.textContent).toContain(`Revision ${"a".repeat(12)}`);
    expect(report?.textContent).toContain("none (no linked strategy)");
    expect(report?.textContent).toContain("ok");
    expect(report?.textContent).toContain("n/a");
    await click(boxes()[1]);
    expect(
      document.querySelectorAll('input[aria-label^="Weight"]')
    ).toHaveLength(1);
  });

  it("shows a not-diversified result and combine failures", async () => {
    const combine = vi
      .fn()
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
      .mockRejectedValueOnce({ code: "BAD_REQUEST", message: "pin mismatch" });
    await mount(<PortfolioCombosWorkspace gateway={gatewayOf({ combine })} />);
    await click(boxes()[0]);
    await click(button());
    expect(document.body.textContent).toContain("not diversified");
    await click(button());
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      "pin mismatch"
    );
    expect(
      document.querySelector('[aria-label="Combined portfolio"]')
    ).toBeNull();
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

    await mount(
      <PortfolioCombosWorkspace gateway={gatewayOf({ list: async () => [] })} />
    );
    expect(document.body.textContent).toContain("No finished backtest runs");
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

  it("uses the browser client when no gateway is given", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 500 }));
    await mount(<PortfolioCombosWorkspace />);
    expect(fetchSpy).toHaveBeenCalled();
    await expect(
      createBrowserPortfolioCombosGateway().combine({ deposit: 1, slots: [] })
    ).rejects.toBeDefined();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    fetchSpy.mockRestore();
  });
});
