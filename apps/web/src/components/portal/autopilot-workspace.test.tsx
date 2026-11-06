// @vitest-environment jsdom
import type {
  AutopilotCampaignDetailOutput,
  AutopilotCampaignOutput,
  AutopilotCandidateDetailOutput,
  AutopilotCandidateSummaryOutput,
  AutopilotGateOutput,
  EngineComparisonRun,
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
  budgetSummary,
  CAMPAIGN_PARAM,
  campaignFromSearch,
  checksSummary,
  curveGeometry,
  DEFAULT_AUTOPILOT_FORM,
  defaultCampaignId,
  formatCpu,
  formatNumber,
  formatPercent,
  fullBacktestInput,
  seriesLabel,
  toCampaignInput,
} from "./autopilot-model.ts";
import {
  type AutopilotGateway,
  AutopilotWorkspace,
  createAutopilotGateway,
  createBrowserAutopilotGateway,
} from "./autopilot-workspace.tsx";
import type { EngineComparisonGateway } from "./engine-comparison.tsx";

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
  window.history.replaceState(null, "", "/autopilot");
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
const button = (label: string) =>
  [...document.querySelectorAll("button")].find(
    (node) => node.textContent === label
  ) as HTMLButtonElement;
const click = (target: HTMLElement) => settle(() => target.click());
const text = () => document.body.textContent ?? "";

const at = new Date("2026-10-30T12:00:00.000Z");
const SPY: InstantBacktestSeries = {
  barCount: 2516,
  firstT: 0,
  importedAt: "2026-10-30T00:00:00.000Z",
  lastT: 1,
  source: "Test daily source",
  sourceSha256: "e".repeat(64),
  symbol: "SPY",
  timeframe: "1d",
};

const campaign = (
  overrides: Partial<AutopilotCampaignOutput> = {}
): AutopilotCampaignOutput => ({
  bestCandidateId: "a",
  bestFitness: 1.5,
  candidateCount: 120,
  config: {
    budget: {
      gatePerGeneration: 3,
      maxCandidates: 2000,
      maxCpuMinutes: 60,
      populationSize: 40,
      tickSeconds: 20,
    },
    costBps: 5,
    gateVersion: "autopilot-gate-v1",
    seed: 7,
  },
  cpuMs: 90_000,
  createdAt: at,
  createdBy: "user-a",
  finishedAt: null,
  gatedCount: 6,
  generation: 3,
  id: "c1",
  name: "SPY daily",
  note: null,
  startedAt: at,
  status: "running",
  symbol: "SPY",
  tickedAt: at,
  timeframe: "1d",
  updatedAt: at,
  verifiedCount: 1,
  ...overrides,
});

const gate: AutopilotGateOutput = {
  checks: [
    {
      detail: "Annualized Sharpe 0.9.",
      id: "oosSharpe",
      label: "Out-of-sample Sharpe",
      passed: true,
      threshold: ">= 0.5",
      value: 0.9,
    },
    {
      detail: "In-sample Sharpe deflated for 120 trials.",
      id: "deflatedSharpe",
      label: "Deflated Sharpe ratio",
      passed: false,
      threshold: ">= 0.95",
      value: 0.4,
    },
  ],
  costStress: { costBps: 10, oosSharpe: 0.7 },
  deflatedSharpe: {
    expectedMaxSharpe: 0.1,
    probability: 0.4,
    sharpe: 0.05,
    trials: 120,
  },
  fdr: { discoveries: 0, qValue: 0.3, tested: 120 },
  folds: [],
  monteCarlo: {
    drawdownP5: -0.2,
    finalP5: 0.1,
    finalP50: 0.4,
    probabilityOfProfit: 0.9,
  },
  neighbours: [],
  oos: {
    cagr: 0.1,
    maxDrawdown: -0.1,
    sharpe: 0.9,
    totalReturn: 0.3,
    trades: 12,
  },
  passed: false,
  splitT: "2021-01-04T00:00:00.000Z",
  tradesTotal: 40,
  version: "autopilot-gate-v1",
};

const summary = (
  overrides: Partial<AutopilotCandidateSummaryOutput> = {}
): AutopilotCandidateSummaryOutput => ({
  campaignId: "c1",
  createdAt: at,
  deploymentRequestId: null,
  fitness: 1.5,
  gate: null,
  gatedAt: null,
  generation: 1,
  id: "a",
  inSample: {
    fitness: 1.5,
    maxDrawdown: -0.1,
    sharpe: 1.5,
    totalReturn: 0.5,
    trades: 30,
  },
  label: "trendSma(200) / exitBelowSma(20)",
  oosSharpe: null,
  origin: "crossover",
  parentIds: [],
  status: "evaluated",
  strategyId: null,
  ...overrides,
});

const verified = summary({
  gate: { ...gate, passed: true },
  gatedAt: at,
  id: "v",
  label: "Verified one",
  oosSharpe: 0.9,
  status: "verified",
});
const child = summary({ id: "kid", label: "Child one", origin: "neighbour" });
const rejected = summary({
  gate,
  id: "r",
  label: "Rejected one",
  status: "rejected",
});

const detailOf = (
  overrides: Partial<AutopilotCampaignDetailOutput> = {}
): AutopilotCampaignDetailOutput => ({
  campaign: campaign(),
  gated: [verified, rejected],
  leaderboard: [verified, child],
  seriesTrials: 300,
  ...overrides,
});

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

const definition = {
  entry: {
    all: [
      {
        left: { field: "close" as const, type: "price" as const },
        op: ">" as const,
        right: { type: "const" as const, value: 1 },
      },
    ],
  },
  exit: { any: [] },
  name: "AP test",
  sizing: { mode: "allIn" as const },
  stopLoss: { kind: "none" as const },
  takeProfit: { kind: "none" as const },
  version: 1 as const,
};

const verifiedDetail: AutopilotCandidateDetailOutput = {
  candidate: verified,
  children: [child],
  curve: [
    { equity: 1, t: "2015-01-02T00:00:00.000Z" },
    { equity: 1.1, t: "2019-01-02T00:00:00.000Z" },
    { equity: 1.3, t: "2022-01-03T00:00:00.000Z" },
  ],
  definition,
  liveReadiness: {
    allowed: false,
    checks: [
      {
        detail: "Every gate check passed.",
        id: "gate",
        label: "Verification gate",
        status: "pass",
      },
      {
        detail: "Options only.",
        id: "optionsOnly",
        label: "Master rule: options only",
        status: "conflict",
      },
    ],
  },
  nautilus: {
    armed: false,
    autopilot: {
      campaignId: "c1",
      candidateId: "v",
      gateVersion: "autopilot-gate-v1",
    },
    engine: "nautilus_trader",
    format: "vertex-nautilus-dsl-strategy-v1",
    instrument: { symbol: "SPY", timeframe: "1d" },
    mode: "paper",
    note: "Paper hand-off input only.",
    strategy: {
      adapter: "vertex-dsl-v1",
      definition,
      definitionSha256: "a".repeat(64),
    },
  },
  parents: [],
};
const childDetail: AutopilotCandidateDetailOutput = {
  ...verifiedDetail,
  candidate: child,
  children: [],
  curve: [],
  liveReadiness: { allowed: false, checks: [] },
  nautilus: null,
  parents: [verified],
};

const gatewayOf = (
  overrides: Partial<AutopilotGateway> = {}
): AutopilotGateway => ({
  candidate: vi.fn(async (id: string) =>
    id === "v" ? verifiedDetail : childDetail
  ),
  create: vi.fn(async () => campaign({ id: "c3", name: "New" })),
  get: vi.fn(async () => detailOf()),
  list: vi.fn(async () => [
    campaign(),
    campaign({ id: "c2", name: "Old", status: "stopped" }),
  ]),
  sendToPaper: vi.fn(async () => ({ id: "request-1", status: "requested" })),
  series: vi.fn(async () => [SPY]),
  setStatus: vi.fn(async () => campaign()),
  submitBacktest: vi.fn(async () => ({ id: "run-9" }) as never),
  tick: vi.fn(async () => undefined),
  ...overrides,
});

describe("autopilot model", () => {
  it("builds the create request", () => {
    expect(toCampaignInput(DEFAULT_AUTOPILOT_FORM, [SPY])).toEqual({
      message: "Choose a stored bar series.",
      ok: false,
    });
    const form = { ...DEFAULT_AUTOPILOT_FORM, seriesKey: "SPY:1d" };
    expect(toCampaignInput({ ...form, seed: "x1" }, [SPY])).toEqual({
      message: "The seed must be a whole number.",
      ok: false,
    });
    const built = toCampaignInput(form, [SPY]);
    expect(built.ok && built.input.name).toBe("SPY 1d campaign");
    expect(built.ok && "seed" in built.input).toBe(false);
    const named = toCampaignInput({ ...form, name: " Mine ", seed: "42" }, [
      SPY,
    ]);
    expect(named.ok && named.input).toMatchObject({
      name: "Mine",
      seed: 42,
      symbol: "SPY",
    });
    expect(seriesLabel(SPY)).toBe("SPY 1d (2,516 bars)");
    expect(
      toCampaignInput({ ...form, filterQuadrants: [], filterSector: "XLK" }, [
        SPY,
      ])
    ).toEqual({
      message: "Choose at least one quadrant for the sector filter.",
      ok: false,
    });
    const filtered = toCampaignInput(
      {
        ...form,
        filterQuadrants: ["improving", "leading"],
        filterSector: "XLK",
      },
      [SPY]
    );
    expect(filtered.ok && filtered.input.filters).toEqual([
      {
        quadrants: ["leading", "improving"],
        sector: "XLK",
        timeframe: "weekly",
        type: "sectorQuadrant",
      },
    ]);
  });

  it("formats values, budgets and checks", () => {
    expect(formatNumber(null)).toBe("n/a");
    expect(formatNumber(1.234)).toBe("1.23");
    expect(formatPercent(null)).toBe("n/a");
    expect(formatPercent(0.1234)).toBe("12.3%");
    expect(formatCpu(12_000)).toBe("12 s");
    expect(formatCpu(90_000)).toBe("1.5 min");
    expect(budgetSummary(campaign())).toBe(
      "120 of 2,000 candidates, 1.5 min of 60 min CPU"
    );
    expect(checksSummary(null)).toBe("Not gated");
    expect(checksSummary(gate)).toBe("1 of 2 checks passed");
  });

  it("draws the curve and marks the split", () => {
    expect(curveGeometry([], null, 100, 50)).toEqual({
      path: "",
      splitX: null,
    });
    const flat = curveGeometry(
      [
        { equity: 1, t: "a" },
        { equity: 1, t: "b" },
      ],
      null,
      100,
      50
    );
    expect(flat).toEqual({ path: "M0.0,50.0 L100.0,50.0", splitX: null });
    expect(
      curveGeometry(verifiedDetail.curve, "2019-01-01", 100, 50).splitX
    ).toBe(50);
    expect(
      curveGeometry(verifiedDetail.curve, "2030-01-01", 100, 50).splitX
    ).toBeNull();
  });

  it("builds a full backtest request over the curve's dates", () => {
    expect(fullBacktestInput(campaign(), childDetail)).toBeNull();
    expect(fullBacktestInput(campaign(), verifiedDetail)).toEqual({
      costBps: 5,
      from: "2015-01-02",
      rule: { definition, kind: "dsl" },
      symbol: "SPY",
      timeframe: "1d",
      to: "2022-01-03",
    });
    expect(
      fullBacktestInput(campaign({ timeframe: "1m" }), verifiedDetail)
        ?.timeframe
    ).toBe("1m");
  });

  it("opens the latest completed campaign, else the latest of any status", () => {
    const later = new Date("2026-10-31T12:00:00.000Z");
    expect(defaultCampaignId([])).toBeNull();
    // No completed campaign: the latest created one; a tie keeps the list order.
    expect(
      defaultCampaignId([
        campaign({ id: "a" }),
        campaign({ createdAt: later, id: "b", status: "stopped" }),
        campaign({ id: "c", status: "failed" }),
      ])
    ).toBe("b");
    // A completed campaign wins over a newer running one, by finish time.
    expect(
      defaultCampaignId([
        campaign({ createdAt: later, id: "new" }),
        campaign({ finishedAt: at, id: "done-early", status: "completed" }),
        campaign({ finishedAt: later, id: "done-late", status: "completed" }),
      ])
    ).toBe("done-late");
    // A completed row without a finish time falls back to its creation time.
    expect(
      defaultCampaignId([
        campaign({ finishedAt: at, id: "done", status: "completed" }),
        campaign({ createdAt: later, id: "undated", status: "completed" }),
      ])
    ).toBe("undated");
  });

  it("reads the campaign from the URL and falls back to the default", () => {
    const rows = [campaign(), campaign({ id: "c2", status: "stopped" })];
    expect(CAMPAIGN_PARAM).toBe("campaign");
    expect(campaignFromSearch("?campaign=c2", rows)).toBe("c2");
    expect(campaignFromSearch("?campaign=missing", rows)).toBe("c1");
    expect(campaignFromSearch("?campaign=", rows)).toBe("c1");
    expect(campaignFromSearch("", rows)).toBe("c1");
    expect(campaignFromSearch("?campaign=c2", [])).toBeNull();
  });
});

describe("autopilot gateway", () => {
  it("maps every call to the API client", async () => {
    const client = {
      autopilot: {
        campaigns: {
          create: vi.fn(async () => "created"),
          get: vi.fn(async () => "detail"),
          list: vi.fn(async () => ({ campaigns: ["one"] })),
          setStatus: vi.fn(async () => "status"),
          tick: vi.fn(async () => ({ results: [] })),
        },
        candidates: {
          get: vi.fn(async () => "candidate"),
          sendToPaper: vi.fn(async () => ({ request: "request" })),
        },
      },
      backtestRuns: { submit: vi.fn(async () => "run") },
      instantBacktest: { series: vi.fn(async () => ({ series: [SPY] })) },
    };
    const gateway = createAutopilotGateway(client as never);
    await expect(gateway.series()).resolves.toEqual([SPY]);
    await expect(gateway.list()).resolves.toEqual(["one"]);
    await expect(gateway.create({} as never)).resolves.toBe("created");
    await expect(gateway.get("c1")).resolves.toBe("detail");
    await expect(gateway.setStatus("c1", "stop")).resolves.toBe("status");
    await expect(gateway.tick("c1")).resolves.toBeUndefined();
    await expect(gateway.candidate("v")).resolves.toBe("candidate");
    await expect(gateway.sendToPaper("v", {} as never)).resolves.toBe(
      "request"
    );
    await expect(gateway.submitBacktest({} as never)).resolves.toBe("run");
    expect(client.autopilot.campaigns.setStatus).toHaveBeenCalledWith({
      action: "stop",
      id: "c1",
    });
    expect(client.autopilot.campaigns.tick).toHaveBeenCalledWith({ id: "c1" });
  });

  it("uses the browser API client by default", async () => {
    const fetch = vi.fn(async () => Promise.reject(new TypeError("offline")));
    vi.stubGlobal("fetch", fetch);
    await mount(<AutopilotWorkspace />);
    expect(document.querySelector('[role="alert"]')).not.toBeNull();
    const gateway = createBrowserAutopilotGateway();
    await expect(gateway.create({} as never)).rejects.toBeDefined();
    await expect(gateway.get("c1")).rejects.toBeDefined();
    await expect(gateway.setStatus("c1", "start")).rejects.toBeDefined();
    await expect(gateway.tick("c1")).rejects.toBeDefined();
    await expect(gateway.candidate("v")).rejects.toBeDefined();
    await expect(gateway.sendToPaper("v", {} as never)).rejects.toBeDefined();
    await expect(gateway.submitBacktest({} as never)).rejects.toBeDefined();
    vi.unstubAllGlobals();
  });
});

describe("AutopilotWorkspace", () => {
  it("shows campaigns, the live leaderboard and the gated candidates", async () => {
    const gateway = gatewayOf();
    await mount(<AutopilotWorkspace gateway={gateway} />);
    expect(gateway.get).toHaveBeenCalledWith("c1");
    expect(text()).toContain("Leaderboard (best in-sample fitness)");
    expect(text()).toContain("Trials on the series (all campaigns)300");
    expect(text()).toContain("Verified one");
    expect(text()).toContain("Rejected");
    await click(button("Old"));
    expect(gateway.get).toHaveBeenLastCalledWith("c2");
  });

  it("opens the latest completed campaign with no input and starts nothing", async () => {
    const done = campaign({
      finishedAt: at,
      id: "c2",
      name: "Done",
      status: "completed",
    });
    const get = vi.fn(async (id: string) =>
      detailOf({ campaign: id === "c2" ? done : campaign() })
    );
    const gateway = gatewayOf({
      get,
      list: vi.fn(async () => [campaign(), done]),
    });
    await mount(<AutopilotWorkspace gateway={gateway} />);
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith("c2");
    const detail = document.querySelector("section[aria-label='Campaign']");
    expect(detail?.querySelector("h2")?.textContent).toBe("Done");
    expect(detail?.textContent).toContain("Verified one");
    expect(detail?.textContent).toContain("Rejected one");
    // The default view keeps a clean URL.
    expect(window.location.search).toBe("");
    // Opening the page never creates, starts, ticks or submits anything.
    expect(gateway.create).not.toHaveBeenCalled();
    expect(gateway.setStatus).not.toHaveBeenCalled();
    expect(gateway.tick).not.toHaveBeenCalled();
    expect(gateway.submitBacktest).not.toHaveBeenCalled();
    expect(gateway.sendToPaper).not.toHaveBeenCalled();
  });

  it("opens the campaign in the URL and writes selection changes", async () => {
    window.history.replaceState(null, "", "/autopilot?campaign=c2&keep=1");
    const gateway = gatewayOf();
    await mount(<AutopilotWorkspace gateway={gateway} />);
    expect(gateway.get).toHaveBeenCalledTimes(1);
    expect(gateway.get).toHaveBeenCalledWith("c2");
    expect(window.location.search).toBe("?campaign=c2&keep=1");
    await click(button("SPY daily"));
    expect(gateway.get).toHaveBeenLastCalledWith("c1");
    // c1 is the default, so the parameter goes away.
    expect(window.location.search).toBe("?keep=1");
    await click(button("Old"));
    expect(window.location.search).toBe("?keep=1&campaign=c2");
    expect(gateway.create).not.toHaveBeenCalled();
  });

  it("falls back to the default campaign for an unknown id in the URL", async () => {
    window.history.replaceState(null, "", "/autopilot?campaign=gone");
    const gateway = gatewayOf();
    await mount(<AutopilotWorkspace gateway={gateway} />);
    expect(gateway.get).toHaveBeenCalledTimes(1);
    expect(gateway.get).toHaveBeenCalledWith("c1");
    expect(window.location.search).toBe("");
  });

  it("starts a campaign and reports create failures", async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce(campaign({ id: "c3", name: "New" }))
      .mockRejectedValueOnce(
        Object.assign(new Error("Too few bars"), { code: "VALIDATION_ERROR" })
      );
    const gateway = gatewayOf({ create });
    await mount(<AutopilotWorkspace gateway={gateway} />);
    await setNative(field("Name"), "Mine");
    await setNative(field("Bar series"), "SPY:1d");
    await setNative(field("Population per generation"), "20");
    await setNative(field("Maximum candidates"), "500");
    await setNative(field("CPU budget (minutes)"), "30");
    await setNative(field("Tick slice (seconds)"), "10");
    await setNative(field("Gated per generation"), "2");
    await setNative(field("Cost (bps per side)"), "2.5");
    await setNative(field("Seed (optional)"), "9");
    await click(button("Start campaign"));
    expect(create).toHaveBeenCalledWith({
      budget: {
        gatePerGeneration: 2,
        maxCandidates: 500,
        maxCpuMinutes: 30,
        populationSize: 20,
        tickSeconds: 10,
      },
      costBps: 2.5,
      name: "Mine",
      seed: 9,
      symbol: "SPY",
      timeframe: "1d",
    });
    expect(text()).toContain("Campaign started.");
    expect(gateway.get).toHaveBeenLastCalledWith("c3");
    await click(button("Start campaign"));
    expect(text()).toContain("Too few bars");
    await setNative(field("Seed (optional)"), "abc");
    await click(button("Start campaign"));
    expect(text()).toContain("The seed must be a whole number.");

    await setNative(field("Seed (optional)"), "");
    expect(document.querySelectorAll("input[type='checkbox']")).toHaveLength(0);
    // Sector filter: choose a sector, then change the checked quadrants.
    await setNative(field("Sector"), "XLE");
    const box = (label: string) =>
      [...document.querySelectorAll("label")]
        .find((node) => node.textContent === label)
        ?.querySelector("input") as HTMLInputElement;
    expect(box("Leading").checked).toBe(true);
    expect(box("Lagging").checked).toBe(false);
    await click(box("Leading"));
    await click(box("Improving"));
    await click(button("Start campaign"));
    expect(text()).toContain(
      "Choose at least one quadrant for the sector filter."
    );
    await click(box("Weakening"));
    await click(button("Start campaign"));
    expect(create).toHaveBeenLastCalledWith(
      expect.objectContaining({
        filters: [
          {
            quadrants: ["weakening"],
            sector: "XLE",
            timeframe: "weekly",
            type: "sectorQuadrant",
          },
        ],
      })
    );
  });

  it("preselects Core 7 futures and its first stored series, and follows a universe change", async () => {
    const create = vi.fn(async () => campaign({ id: "c3", name: "New" }));
    const series = [
      { ...SPY, symbol: "BTCUSDT" },
      { ...SPY, symbol: "ES=F" },
      SPY,
      { ...SPY, symbol: "TEST" },
    ];
    await mount(
      <AutopilotWorkspace
        gateway={gatewayOf({ create, series: vi.fn(async () => series) })}
      />
    );
    const options = () =>
      [...field("Bar series").options].map((option) => option.value);
    expect(field("Universe").value).toBe("core7-futures");
    expect(field("Bar series").value).toBe("ES=F:1d");
    expect(options()).toEqual(["ES=F:1d"]);
    await click(button("Start campaign"));
    expect(create).toHaveBeenLastCalledWith(
      expect.objectContaining({ name: "ES=F 1d campaign", symbol: "ES=F" })
    );
    await setNative(field("Universe"), "core7-etf-twins");
    expect(options()).toEqual(["SPY:1d"]);
    expect(field("Bar series").value).toBe("SPY:1d");
    await setNative(field("Universe"), "all");
    expect(options()).toHaveLength(4);
    expect(field("Bar series").value).toBe("BTCUSDT:1d");
  });

  it("shows every stored series when no Core 7 future is stored", async () => {
    await mount(
      <AutopilotWorkspace
        gateway={gatewayOf({
          series: vi.fn(async () => [SPY, { ...SPY, symbol: "TEST" }]),
        })}
      />
    );
    expect(field("Universe").value).toBe("core7-futures");
    expect(field("Bar series").value).toBe("SPY:1d");
    expect(field("Bar series").options).toHaveLength(2);
    expect(text()).toContain(
      "No stored bars for Core 7 futures yet. Showing all stored series."
    );
    await setNative(field("Universe"), "core7-etf-twins");
    expect(
      [...field("Bar series").options].map((option) => option.value)
    ).toEqual(["SPY:1d"]);
  });

  it("stops, ticks and restarts a campaign", async () => {
    const setStatus = vi
      .fn()
      .mockResolvedValueOnce(campaign({ status: "stopped" }))
      .mockRejectedValueOnce(new Error("Conflict"));
    const get = vi
      .fn()
      .mockResolvedValueOnce(detailOf())
      .mockResolvedValueOnce(detailOf())
      .mockResolvedValue(
        detailOf({
          campaign: campaign({
            note: "Stopped by an operator.",
            status: "stopped",
          }),
        })
      );
    const gateway = gatewayOf({ get, setStatus });
    await mount(<AutopilotWorkspace gateway={gateway} />);
    await click(button("Run one tick now"));
    expect(gateway.tick).toHaveBeenCalledWith("c1");
    await click(button("Stop campaign"));
    expect(setStatus).toHaveBeenCalledWith("c1", "stop");
    expect(text()).toContain("Stopped by an operator.");
    const restart = [
      ...document.querySelectorAll("section[aria-label='Campaign'] button"),
    ].find(
      (node) => node.textContent === "Start campaign"
    ) as HTMLButtonElement;
    await click(restart);
    expect(setStatus).toHaveBeenLastCalledWith("c1", "start");
    expect(text()).toContain("Conflict");
  });

  it("shows a verified tearsheet, runs a full backtest and sends it to paper", async () => {
    const submitBacktest = vi
      .fn()
      .mockResolvedValueOnce({ id: "run-9" })
      .mockRejectedValueOnce(new Error("Queue full"));
    const sendToPaper = vi
      .fn()
      .mockRejectedValueOnce(new Error("Library unavailable"))
      .mockResolvedValueOnce({ id: "request-1", status: "requested" });
    const gateway = gatewayOf({ sendToPaper, submitBacktest });
    await mount(<AutopilotWorkspace gateway={gateway} />);
    await click(button("Verified one"));
    expect(text()).toContain("Gate checklist");
    expect(text()).toContain("Deflated Sharpe ratio: fail");
    expect(text()).toContain("Out-of-sample Sharpe: pass");
    expect(text()).toContain(
      "Nautilus paper config (vertex-nautilus-dsl-strategy-v1)"
    );
    expect(document.querySelector("svg[role='img'] line")).not.toBeNull();
    await click(button("Run full backtest"));
    expect(
      document.querySelector("a[href='/backtest-runs?run=run-9']")
    ).not.toBeNull();
    await click(button("Run full backtest"));
    expect(text()).toContain("Queue full");
    await setNative(field("Max order size"), "5");
    await setNative(field("Max position"), "5");
    await setNative(field("Max orders per minute"), "1");
    await setNative(field("Daily loss limit (USD)"), "100");
    await click(button("Send to paper"));
    expect(text()).toContain("Library unavailable");
    await click(button("Send to paper"));
    expect(sendToPaper).toHaveBeenLastCalledWith("v", {
      dailyLossLimit: 100,
      maxOrderSize: 5,
      maxOrdersPerMinute: 1,
      maxPosition: 5,
    });
    expect(text()).toContain(
      "Paper deployment request request-1 is requested."
    );
    await click(button("Request live"));
    expect(text()).toContain("Live readiness: not allowed.");
    expect(text()).toContain("Master rule: options only: conflict.");
    expect(text()).toContain("Verification gate: pass.");
    await click(button("Child one (Neighbour)"));
    expect(text()).toContain("Not gated.");
    expect(text()).toContain("Only a verified candidate can go to paper.");
    expect(button("Send to paper").disabled).toBe(true);
    const parent = [
      ...document.querySelectorAll("section[aria-label='Lineage'] button"),
    ][0] as HTMLButtonElement;
    await click(parent);
    expect(gateway.candidate).toHaveBeenLastCalledWith("v");
  });

  it("shows an existing paper request and lists a rejected candidate", async () => {
    const candidate = vi.fn(async (id: string) =>
      id === "v"
        ? {
            ...verifiedDetail,
            candidate: { ...verified, deploymentRequestId: "request-7" },
          }
        : {
            ...childDetail,
            candidate: { ...rejected, gate: { ...gate, splitT: "2030-01-01" } },
            curve: verifiedDetail.curve,
          }
    );
    await mount(<AutopilotWorkspace gateway={gatewayOf({ candidate })} />);
    await click(button("Verified one"));
    expect(document.querySelector("a[href='/deployments']")?.textContent).toBe(
      "request-7"
    );
    expect(button("Send to paper").disabled).toBe(true);
    await click(button("Rejected one"));
    expect(text()).toContain("1 of 2 checks passed");
    // The split line is drawn only where the curve reaches the split date.
    expect(document.querySelector("svg[role='img'] path")).not.toBeNull();
    expect(document.querySelector("svg[role='img'] line")).toBeNull();
  });

  it("reports candidate and detail failures", async () => {
    const get = vi.fn().mockRejectedValue(new Error("Detail down"));
    const candidate = vi.fn().mockRejectedValue(new Error("Candidate down"));
    await mount(<AutopilotWorkspace gateway={gatewayOf({ candidate, get })} />);
    expect(text()).toContain("Detail down");
    const loaded = vi.fn().mockResolvedValue(detailOf());
    document.body.replaceChildren();
    await mount(
      <AutopilotWorkspace gateway={gatewayOf({ candidate, get: loaded })} />
    );
    await click(button("Verified one"));
    expect(text()).toContain("Candidate down");
  });

  it("refreshes a running campaign every few seconds", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const gateway = gatewayOf();
    await mount(<AutopilotWorkspace gateway={gateway} />);
    const calls = vi.mocked(gateway.get).mock.calls.length;
    await act(async () => {
      vi.advanceTimersByTime(5000);
      await flush();
    });
    expect(vi.mocked(gateway.get).mock.calls.length).toBe(calls + 1);
  });

  it("shows empty, forbidden and error states", async () => {
    await mount(
      <AutopilotWorkspace
        gateway={gatewayOf({
          list: vi.fn(async () => []),
          series: vi.fn(async () => []),
        })}
      />
    );
    expect(text()).toContain("No campaigns yet.");
    await click(button("Start campaign"));
    expect(text()).toContain("Choose a stored bar series.");
    document.body.replaceChildren();
    await mount(
      <AutopilotWorkspace
        gateway={gatewayOf({
          list: vi
            .fn()
            .mockRejectedValue(
              Object.assign(new Error("no"), { code: "FORBIDDEN" })
            ),
        })}
      />
    );
    expect(
      document.querySelector("[data-operator-feature='autopilot']")
    ).not.toBeNull();
    document.body.replaceChildren();
    await mount(
      <AutopilotWorkspace
        gateway={gatewayOf({
          series: vi.fn().mockRejectedValue(new Error("Down")),
        })}
      />
    );
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "Down"
    );
  });
});

describe("autopilot gate engine comparison", () => {
  it("shows each gated candidate's Nautilus checks once the campaign has some", async () => {
    const run = (label: string, id: string) =>
      nautilusRun({
        comparison: {
          ...nautilusRun().comparison,
          feature: "autopilotGate",
          groupId: "autopilot:c1",
          key: verified.id,
          label: `AP test: ${label}`,
        },
        id,
      });
    const comparisons = comparisonsOf([
      run("in-sample", "n-1"),
      run("full run (out-of-sample from 2019-01-02)", "n-2"),
    ]);
    await mount(
      <AutopilotWorkspace
        comparisonGateway={comparisons}
        gateway={gatewayOf()}
      />
    );
    expect(comparisons.comparisons).toHaveBeenCalledWith("autopilot:c1");
    expect(text()).toContain("Nautilus check");
    expect(text()).toContain("in-sample: 400 ms (queue 2.0 s)Status:match");
    expect(text()).toContain(
      "full run (out-of-sample from 2019-01-02): 400 ms"
    );
    expect(text()).toContain("not repeated");
  });

  it("shows no Nautilus column for a campaign without comparison runs", async () => {
    const gateway = gatewayOf({
      get: vi.fn(async () =>
        detailOf({ campaign: campaign({ tickedAt: null }) })
      ),
    });
    await mount(
      <AutopilotWorkspace
        comparisonGateway={comparisonsOf([])}
        gateway={gateway}
      />
    );
    expect(text()).not.toContain("Nautilus check");
  });
});
