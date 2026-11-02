// @vitest-environment jsdom
import type {
  BacktestRunSummary,
  ForwardDriftAlert,
  ForwardDriftCheckOutput,
  ForwardDriftMonitor,
  ForwardDriftMonitorSummary,
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
  comparePaths,
  createBrowserForwardDriftGateway,
  createForwardDriftGateway,
  type ForwardDriftGateway,
  ForwardDriftWorkspace,
  formatCheckValue,
  parseRows,
} from "./forward-drift-workspace.tsx";

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
  for (let index = 0; index < 30; index += 1) await Promise.resolve();
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
const setValue = async (
  element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  value: string
) => {
  await settle(() => {
    const prototype = Object.getPrototypeOf(element) as object;
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(
      element,
      value
    );
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
};
const buttonNamed = (name: string) =>
  [...document.querySelectorAll("button")].find(
    (node) => node.textContent === name
  ) as HTMLButtonElement;
const click = (element: Element | null | undefined) =>
  settle(() => (element as HTMLElement).click());

const runOf = (
  id: string,
  overrides: Partial<BacktestRunSummary> = {}
): BacktestRunSummary => ({
  createdAt: new Date(0),
  engineVersion: "instant-2",
  error: null,
  finishedAt: new Date(0),
  id,
  spec: {
    costBps: 0,
    from: "2020-01-01",
    initialCapital: 10_000,
    rule: { fast: 5, kind: "smaCross", slow: 20 },
    stopLossPct: 0,
    symbol: "TEST",
    takeProfitPct: 0,
    timeframe: "1d",
    to: "2021-01-01",
  },
  startedAt: new Date(0),
  status: "succeeded",
  strategyId: null,
  strategyRevision: null,
  strategySnapshot: null,
  ...overrides,
});

const thresholds = {
  drawdown: { alert: 1.5, warn: 1 },
  losingStreak: { alert: 1.5, warn: 1.25 },
  profitFactor: { alert: 0.5, warn: 0.75 },
  sharpe: { alert: 0, warn: 0.5 },
  winRate: { alert: 0.6, warn: 0.8 },
};

const checkOf = (
  key: ForwardDriftCheckOutput["key"],
  overrides: Partial<ForwardDriftCheckOutput> = {}
): ForwardDriftCheckOutput => ({
  alertAt: thresholds[key].alert,
  baseline: 0.1,
  direction: "higher-is-worse",
  forward: 0.12,
  key,
  label: key,
  level: "ok",
  minSample: 2,
  ratio: 1.2,
  reason: "Ratio 1.20 is inside the warn threshold",
  sample: 3,
  warnAt: thresholds[key].warn,
  ...overrides,
});

const alertOf = (
  id: string,
  overrides: Partial<ForwardDriftAlert> = {}
): ForwardDriftAlert => ({
  acknowledgedAt: null,
  baselineValue: 0.1,
  check: "drawdown",
  createdAt: new Date("2026-10-23T10:00:00.000Z"),
  forwardValue: 0.16,
  id,
  level: "alert",
  message: "Max drawdown alert: forward 16.00% vs baseline 10.00%",
  monitorId: "m1",
  ratio: 1.6,
  ...overrides,
});

const summaryOf = (
  id: string,
  overrides: Partial<ForwardDriftMonitorSummary> = {}
): ForwardDriftMonitorSummary => ({
  baselineRunId: "r1",
  createdAt: new Date(0),
  id,
  label: `Monitor ${id}`,
  level: "alert",
  paper: { note: null, status: "off", tickedAt: null },
  pointCount: 3,
  strategyRevision: null,
  thresholds,
  tradeCount: 0,
  updatedAt: new Date(0),
  version: 1,
  ...overrides,
});

const monitorOf = (
  overrides: Partial<ForwardDriftMonitor> = {}
): ForwardDriftMonitor => ({
  ...summaryOf("m1"),
  alerts: [
    alertOf("a1"),
    alertOf("a0", {
      acknowledgedAt: new Date(1),
      level: "warn",
    }),
  ],
  baseline: {
    engineVersion: "instant-2",
    equity: [
      { equity: 10_000, t: 0 },
      { equity: 11_000, t: 1 },
    ],
    initialCapital: 10_000,
    label: "TEST 1d smaCross",
    seriesSha256: "b".repeat(64),
  },
  checks: [
    checkOf("drawdown", { level: "alert", ratio: 1.6 }),
    checkOf("losingStreak", { forward: 3, level: "warn" }),
    checkOf("profitFactor", {
      direction: "lower-is-worse",
      forward: null,
      level: "insufficient",
      ratio: null,
    }),
    checkOf("sharpe", { direction: "lower-is-worse", forward: 1.234 }),
    checkOf("winRate", { direction: "lower-is-worse", forward: 0.4 }),
  ],
  points: [
    { equity: 100, t: 0 },
    { equity: 90, t: 1 },
    { equity: 84, t: 2 },
  ],
  trades: [],
  ...overrides,
});

const gatewayOf = (
  overrides: Partial<ForwardDriftGateway> = {}
): ForwardDriftGateway => ({
  acknowledge: vi.fn(async (id: string) =>
    alertOf(id, { acknowledgedAt: new Date(2) })
  ),
  create: vi.fn(async () => monitorOf({ alerts: [], label: "New one" })),
  get: vi.fn(async () => monitorOf()),
  list: vi.fn(async () => ({
    monitors: [summaryOf("m1"), summaryOf("m2", { level: "ok" })],
    openAlerts: [alertOf("a1"), alertOf("a9", { monitorId: "gone" })],
  })),
  paperSet: vi.fn(async (_id: string, running: boolean) =>
    monitorOf({
      paper: {
        note: null,
        status: running ? "running" : "off",
        tickedAt: null,
      },
    })
  ),
  paperTick: vi.fn(async (id: string) => ({
    monitorId: id,
    newPoints: 4,
    newTrades: 1,
    note: null,
    raised: 0,
  })),
  record: vi.fn(async () => ({
    monitor: monitorOf({ pointCount: 4 }),
    raised: [alertOf("a5")],
  })),
  runs: vi.fn(async () => [
    runOf("r1"),
    runOf("r2", {
      strategyRevision: "c".repeat(64),
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
    runOf("r3", { status: "failed" }),
  ]),
  ...overrides,
});

describe("helpers", () => {
  it("builds the gateway on the drift procedures", async () => {
    const drift = {
      acknowledge: vi.fn(async () => alertOf("a")),
      create: vi.fn(async () => monitorOf()),
      get: vi.fn(async () => monitorOf()),
      list: vi.fn(async () => ({ monitors: [], openAlerts: [] })),
      paperSet: vi.fn(async () => monitorOf()),
      paperTick: vi
        .fn()
        .mockResolvedValueOnce({
          results: [
            {
              monitorId: "m",
              newPoints: 1,
              newTrades: 0,
              note: null,
              raised: 0,
            },
          ],
        })
        .mockResolvedValueOnce({ results: [] }),
      record: vi.fn(async () => ({ monitor: monitorOf(), raised: [] })),
    };
    const client = {
      backtestRuns: {
        drift,
        list: vi.fn(async () => ({ runs: [runOf("r1")] })),
      },
    };
    const gateway = createForwardDriftGateway(client as never);
    await gateway.acknowledge("a");
    await gateway.create({
      baselineRunId: "r",
      expectedRevision: null,
      label: "x",
    });
    await gateway.get("m");
    await gateway.list();
    await gateway.record({ id: "m", points: [], source: "paper" });
    await expect(gateway.runs()).resolves.toHaveLength(1);
    await gateway.paperSet("m", true);
    await expect(gateway.paperTick("m")).resolves.toMatchObject({
      newPoints: 1,
    });
    await expect(gateway.paperTick("m")).resolves.toBeNull();
    expect(drift.paperSet).toHaveBeenCalledWith({ id: "m", running: true });
    expect(drift.paperTick).toHaveBeenCalledWith({ id: "m" });
    expect(drift.acknowledge).toHaveBeenCalledWith({ id: "a" });
    expect(drift.get).toHaveBeenCalledWith({ id: "m" });
    expect(drift.list).toHaveBeenCalledWith({});
    expect(client.backtestRuns.list).toHaveBeenCalledWith({ limit: 100 });
  });

  it("formats values in the unit of each check", () => {
    expect(formatCheckValue("drawdown", null)).toBe("n/a");
    expect(formatCheckValue("drawdown", 0.1234)).toBe("12.34%");
    expect(formatCheckValue("winRate", 0.5)).toBe("50.00%");
    expect(formatCheckValue("losingStreak", 6)).toBe("6");
    expect(formatCheckValue("sharpe", 1.234)).toBe("1.23");
  });

  it("parses time/value lines in epoch, date and date-time forms", () => {
    expect(
      parseRows(
        "0, 100\n\n2026-10-01 101.5\n2026-10-01T12:00; 99\n2026-10-02T00:00:00+02:00,98",
        "equity"
      )
    ).toEqual({
      ok: true,
      rows: [
        { t: 0, value: 100 },
        { t: Date.UTC(2026, 9, 1), value: 101.5 },
        { t: Date.UTC(2026, 9, 1, 12), value: 99 },
        { t: Date.UTC(2026, 9, 1, 22), value: 98 },
      ],
    });
    expect(parseRows("", "pnl")).toEqual({ ok: true, rows: [] });
  });

  it("reads a time without a zone as UTC in any local time zone", () => {
    vi.stubEnv("TZ", "America/New_York");
    try {
      expect(parseRows("2026-10-01T12:00, 1\n2026-10-01, 2", "equity")).toEqual(
        {
          ok: true,
          rows: [
            { t: Date.UTC(2026, 9, 1, 12), value: 1 },
            { t: Date.UTC(2026, 9, 1), value: 2 },
          ],
        }
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("names the first bad line", () => {
    for (const text of [
      "0",
      "0, 1, 2",
      "yesterday, 1",
      "0, many",
      "10/01/2026, 1",
      "Oct-1-2026, 1",
      "2026-13-01, 1",
      "2026-02-30, 1",
      "-5, 1",
    ])
      expect(parseRows(`1, 1\n${text}`, "pnl")).toEqual({
        message: 'Line 2: expected "time, pnl"',
        ok: false,
      });
  });

  it("draws both series from a common start", () => {
    const paths = comparePaths(
      [{ equity: 100 }, { equity: 200 }],
      [{ equity: 50 }, { equity: 25 }],
      100,
      100
    );
    expect(paths.baseline).toBe("M0.0,66.7 L100.0,0.0");
    expect(paths.forward).toBe("M0.0,66.7 L100.0,100.0");
    expect(comparePaths([], [], 10, 10)).toEqual({ baseline: "", forward: "" });
  });
});

describe("ForwardDriftWorkspace", () => {
  it("lists open alerts and monitors and acknowledges an alert", async () => {
    const gateway = gatewayOf();
    await mount(<ForwardDriftWorkspace gateway={gateway} />);
    const inbox = document.querySelector('[aria-label="Open drift alerts"]');
    expect(inbox?.textContent).toContain("Open drift alerts (2)");
    expect(inbox?.textContent).toContain("Monitor m1");
    expect(inbox?.textContent).toContain("Monitor");
    expect(inbox?.textContent).toContain("2026-10-23 10:00");
    expect(inbox?.textContent).toContain("Alert");
    const monitors = document.querySelector('[aria-label="Monitors"]');
    expect(monitors?.textContent).toContain("3 points, 0 trades");
    expect(monitors?.textContent).toContain("OK");
    await click(inbox?.querySelector("button") as HTMLButtonElement | null);
    expect(gateway.acknowledge).toHaveBeenCalledWith("a1");
    expect(gateway.get).not.toHaveBeenCalled();
    expect(gateway.list).toHaveBeenCalledTimes(2);
  });

  it("starts, ticks and stops the paper runner of the open monitor", async () => {
    const tickedAt = new Date(Date.UTC(2026, 9, 23, 9, 30));
    const get = vi
      .fn()
      .mockResolvedValueOnce(monitorOf())
      .mockResolvedValue(
        monitorOf({
          paper: { note: "No new bars", status: "running", tickedAt },
          pointCount: 7,
        })
      );
    const gateway = gatewayOf({ get });
    await mount(<ForwardDriftWorkspace gateway={gateway} />);
    await click(buttonNamed("Monitor m1"));
    const runner = () =>
      document.querySelector('[aria-label="Paper forward runner"]');
    expect(runner()?.textContent).toContain("Stopped");
    expect(runner()?.textContent).toContain("Last tick: never");
    await click(buttonNamed("Start paper runner"));
    expect(gateway.paperSet).toHaveBeenCalledWith("m1", true);
    expect(runner()?.textContent).toContain("Running");
    await click(buttonNamed("Run one tick now"));
    expect(gateway.paperTick).toHaveBeenCalledWith("m1");
    expect(runner()?.textContent).toContain(
      "Tick: 4 points, 1 trades, 0 new alerts"
    );
    expect(runner()?.textContent).toContain("(No new bars)");
    vi.mocked(gateway.paperTick).mockResolvedValueOnce({
      monitorId: "m1",
      newPoints: 0,
      newTrades: 0,
      note: "No new bars",
      raised: 0,
    });
    await click(buttonNamed("Run one tick now"));
    expect(runner()?.textContent).toContain(
      "Tick: 0 points, 0 trades, 0 new alerts. No new bars"
    );
    await click(buttonNamed("Stop paper runner"));
    expect(gateway.paperSet).toHaveBeenLastCalledWith("m1", false);
  });

  it("shows paper runner failures, empty ticks and running monitors in the list", async () => {
    const gateway = gatewayOf({
      list: vi.fn(async () => ({
        monitors: [
          summaryOf("m1", {
            paper: { note: null, status: "running", tickedAt: null },
          }),
        ],
        openAlerts: [],
      })),
      paperSet: vi.fn(async () => {
        throw new Error("down");
      }),
      paperTick: vi.fn(async () => null),
    });
    await mount(<ForwardDriftWorkspace gateway={gateway} />);
    expect(document.body.textContent).toContain("paper runner on");
    await click(buttonNamed("Monitor m1"));
    await click(buttonNamed("Run one tick now"));
    expect(document.body.textContent).toContain("The tick found no monitor");
    await click(buttonNamed("Start paper runner"));
    const runner = document.querySelector(
      '[aria-label="Paper forward runner"]'
    );
    expect(runner?.querySelector('[role="alert"]')?.textContent).toBe("down");
  });

  it("opens a monitor, records paper results and refreshes after acknowledging", async () => {
    const gateway = gatewayOf();
    await mount(<ForwardDriftWorkspace gateway={gateway} />);
    await click(buttonNamed("Monitor m1"));
    expect(gateway.get).toHaveBeenCalledWith("m1");
    const panel = document.querySelector('[aria-label="Drift panel"]');
    expect(panel?.textContent).toContain("no strategy revision");
    expect(panel?.textContent).toContain("Warning");
    expect(panel?.textContent).toContain("Not enough data");
    expect(panel?.textContent).toContain("1.23");
    expect(panel?.textContent).toContain("40.00%");
    expect(panel?.textContent).toContain("(3/2 samples)");
    const monitorAlerts = document.querySelector(
      '[aria-label="Monitor alerts"]'
    );
    expect(monitorAlerts?.textContent).toContain("Open");
    expect(monitorAlerts?.textContent).toContain("Acknowledged");
    expect(monitorAlerts?.querySelector("button")).toBeNull();
    expect(buttonNamed("Monitor m1").getAttribute("aria-current")).toBe("true");

    const record = buttonNamed("Record and check drift");
    expect(record.disabled).toBe(true);
    const [points, trades] = [
      ...document.querySelectorAll<HTMLTextAreaElement>("textarea"),
    ];
    await setValue(points as HTMLTextAreaElement, "bad line");
    await click(record);
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      'Line 1: expected "time, equity"'
    );
    await setValue(points as HTMLTextAreaElement, "5, 80");
    await setValue(trades as HTMLTextAreaElement, "5");
    await click(record);
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      'Line 1: expected "time, pnl"'
    );
    await setValue(trades as HTMLTextAreaElement, "5, -2");
    await click(record);
    expect(gateway.record).toHaveBeenCalledWith({
      id: "m1",
      points: [{ equity: 80, t: 5 }],
      source: "paper",
      trades: [{ pnl: -2, t: 5 }],
    });
    expect(document.body.textContent).toContain(
      "New alerts from this recording: 1"
    );
    expect(document.body.textContent).toContain("Paper: 4 points");

    await click(
      document
        .querySelector('[aria-label="Open drift alerts"]')
        ?.querySelector("button") as HTMLButtonElement | null
    );
    expect(gateway.get).toHaveBeenCalledTimes(2);
  });

  it("keeps another monitor shown when an earlier recording finishes late", async () => {
    let finish: (value: {
      monitor: ForwardDriftMonitor;
      raised: ForwardDriftAlert[];
    }) => void = () => undefined;
    const record = vi.fn(
      () =>
        new Promise<{
          monitor: ForwardDriftMonitor;
          raised: ForwardDriftAlert[];
        }>((done) => {
          finish = done;
        })
    );
    let loadSecond: () => void = () => undefined;
    const get = vi.fn((id: string) => {
      const monitor = monitorOf({ id, label: `Panel ${id}` });
      if (id === "m1") return Promise.resolve(monitor);
      // The second monitor loads only after the first monitor's recording has finished.
      return new Promise<ForwardDriftMonitor>((done) => {
        loadSecond = () => done(monitor);
      });
    });
    const gateway = gatewayOf({ get, record });
    await mount(<ForwardDriftWorkspace gateway={gateway} />);
    await click(buttonNamed("Monitor m1"));
    const [points] = [
      ...document.querySelectorAll<HTMLTextAreaElement>("textarea"),
    ];
    await setValue(points as HTMLTextAreaElement, "5, 80");
    await click(buttonNamed("Record and check drift"));
    await click(buttonNamed("Monitor m2"));
    await settle(() =>
      finish({
        monitor: monitorOf({ label: "Panel m1" }),
        raised: [alertOf("x")],
      })
    );
    await settle(() => loadSecond());
    const panel = document.querySelector('[aria-label="Drift panel"]');
    expect(panel?.textContent).toContain("Panel m2");
    expect(panel?.textContent).not.toContain("New alerts from this recording");
    expect(gateway.list).toHaveBeenCalledTimes(4);
  });

  it("shows record failures from the server", async () => {
    const gateway = gatewayOf({
      get: vi.fn(async () =>
        monitorOf({ alerts: [], strategyRevision: "d".repeat(64) })
      ),
      record: vi.fn(async () =>
        Promise.reject({ code: "BAD_REQUEST", message: "too early" })
      ),
    });
    await mount(<ForwardDriftWorkspace gateway={gateway} />);
    await click(buttonNamed("Monitor m1"));
    expect(document.body.textContent).toContain(`revision ${"d".repeat(12)}`);
    const [, trades] = [
      ...document.querySelectorAll<HTMLTextAreaElement>("textarea"),
    ];
    await setValue(trades as HTMLTextAreaElement, "1, 1");
    await click(buttonNamed("Record and check drift"));
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      "too early"
    );
  });

  it("creates a monitor pinned to the chosen run's revision", async () => {
    const gateway = gatewayOf();
    await mount(<ForwardDriftWorkspace gateway={gateway} />);
    const options = [...document.querySelectorAll("option")].map(
      (option) => option.textContent
    );
    expect(options).toEqual([
      "TEST 1d SMA 5/20 2020-01-01..2021-01-01",
      "Alpha TEST 1d SMA 5/20 2020-01-01..2021-01-01",
    ]);
    const create = buttonNamed("Create monitor");
    expect(create.disabled).toBe(true);
    await setValue(document.querySelector("select") as HTMLSelectElement, "r2");
    await setValue(
      document.querySelector<HTMLInputElement>(
        'input[maxlength="120"]'
      ) as HTMLInputElement,
      "  Alpha paper  "
    );
    await click(create);
    expect(gateway.create).toHaveBeenCalledWith({
      baselineRunId: "r2",
      expectedRevision: "c".repeat(64),
      label: "Alpha paper",
    });
    expect(
      document.querySelector('[aria-label="Drift panel"]')?.textContent
    ).toContain("New one");
  });

  it("falls back to the first run when the chosen run disappears", async () => {
    const runs = vi
      .fn()
      .mockResolvedValueOnce([runOf("r1"), runOf("r2")])
      .mockResolvedValue([runOf("r1")]);
    await mount(<ForwardDriftWorkspace gateway={gatewayOf({ runs })} />);
    await setValue(document.querySelector("select") as HTMLSelectElement, "r2");
    await click(
      document
        .querySelector('[aria-label="Open drift alerts"]')
        ?.querySelector("button") as HTMLButtonElement | null
    );
    expect(document.querySelector("select")?.value).toBe("r1");
  });

  it("shows create failures", async () => {
    const gateway = gatewayOf({
      create: vi.fn(async () =>
        Promise.reject({ code: "BAD_REQUEST", message: "not pinned" })
      ),
    });
    await mount(<ForwardDriftWorkspace gateway={gateway} />);
    await setValue(
      document.querySelector<HTMLInputElement>(
        'input[maxlength="120"]'
      ) as HTMLInputElement,
      "x"
    );
    await click(buttonNamed("Create monitor"));
    expect(gateway.create).toHaveBeenCalledWith({
      baselineRunId: "r1",
      expectedRevision: null,
      label: "x",
    });
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      "not pinned"
    );
  });

  it("shows empty, loading, forbidden and error states", async () => {
    const { root } = await mount(
      <ForwardDriftWorkspace
        gateway={gatewayOf({ runs: () => new Promise(() => undefined) })}
      />
    );
    expect(document.body.textContent).toContain("Loading drift monitors");
    await act(async () => root.unmount());
    roots.splice(roots.indexOf(root), 1);
    document.body.replaceChildren();

    await mount(
      <ForwardDriftWorkspace
        gateway={gatewayOf({
          list: async () => ({ monitors: [], openAlerts: [] }),
          runs: async () => [],
        })}
      />
    );
    expect(document.body.textContent).toContain("No open drift alerts.");
    expect(document.body.textContent).toContain("No drift monitors yet.");
    expect(document.body.textContent).toContain("No finished backtest runs.");
    document.body.replaceChildren();

    await mount(
      <ForwardDriftWorkspace
        gateway={gatewayOf({
          list: async () => Promise.reject({ code: "FORBIDDEN" }),
        })}
      />
    );
    expect(document.body.textContent).not.toContain("Monitors");
    document.body.replaceChildren();

    await mount(
      <ForwardDriftWorkspace
        gateway={gatewayOf({
          list: async () => Promise.reject({ code: "ERROR", message: "down" }),
        })}
      />
    );
    expect(document.querySelector('[role="alert"]')?.textContent).toBe("down");
  });

  it("uses the browser client when no gateway is given", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 500 }));
    await mount(<ForwardDriftWorkspace />);
    expect(fetchSpy).toHaveBeenCalled();
    fetchSpy.mockClear();
    const browser = createBrowserForwardDriftGateway();
    for (const call of [
      () => browser.acknowledge("a"),
      () =>
        browser.create({
          baselineRunId: "r",
          expectedRevision: null,
          label: "x",
        }),
      () => browser.get("m"),
      () => browser.list(),
      () =>
        browser.record({
          id: "m",
          points: [{ equity: 1, t: 0 }],
          source: "paper",
        }),
      () => browser.runs(),
      () => browser.paperSet("m", true),
      () => browser.paperTick("m"),
    ])
      await expect(call()).rejects.toBeDefined();
    expect(fetchSpy).toHaveBeenCalledTimes(8);
    fetchSpy.mockRestore();
  });
});
