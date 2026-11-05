// @vitest-environment jsdom
import type {
  InstantBacktestSeries,
  SetupReplayOccurrence,
  SetupReplayPreset,
  SetupReplayRunOutput,
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

import type { SetupReplayGateway } from "./setup-replay-client.ts";

const browser = vi.hoisted(() => ({
  gateway: null as SetupReplayGateway | null,
}));

vi.mock("./setup-replay-client.ts", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./setup-replay-client.ts")>();
  return {
    ...actual,
    createBrowserSetupReplayGateway: () => browser.gateway,
  };
});

import {
  defaultSetupReplayChoices,
  formatR,
  formatReturnPct,
  formatShare,
  parseSetupReplayQuery,
  SetupReplayWorkspace,
} from "./setup-replay-workspace.tsx";

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
  window.history.replaceState(null, "", "/setup-replay");
});

/** Waits past the replay debounce. */
const settle = async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 350));
    await flush();
  });
};

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
const series = (
  symbol: string,
  timeframe: InstantBacktestSeries["timeframe"]
): InstantBacktestSeries => ({
  barCount: 5000,
  firstT: 0,
  importedAt: "2026-10-18T12:00:00.000Z",
  lastT: 4999 * DAY_MS,
  source: "Test bars",
  sourceSha256: "d".repeat(64),
  symbol,
  timeframe,
});

const PRESETS: SetupReplayPreset[] = [
  {
    description: "Opens above the prior high and holds.",
    id: "gapUpHold",
    label: "Gap up and hold",
  },
  {
    description: "Closes above the 20-day high.",
    id: "breakout20",
    label: "20-day breakout",
  },
];

const occurrence = (
  day: number,
  outcome: SetupReplayOccurrence["outcome"],
  rMultiple: number
): SetupReplayOccurrence => ({
  barsHeld: 3,
  entryDate: `2026-01-${String(day).padStart(2, "0")}`,
  entryPrice: 100,
  exitDate: `2026-01-${String(day + 2).padStart(2, "0")}`,
  exitPrice: 100 + rMultiple * 2,
  outcome,
  returnPct: rMultiple * 2,
  rMultiple,
});

const output = (
  overrides: Partial<SetupReplayRunOutput> = {}
): SetupReplayRunOutput => ({
  monteCarlo: {
    paths: 1000,
    pProfit: 0.73,
    seed: 4242,
    totalR: { p5: -2, p25: 0.5, p50: 1.5, p75: 3, p95: 5 },
    totalReturnPct: { p5: -4, p25: 1, p50: 3.1, p75: 6, p95: 10 },
    tradesPerPath: 4,
  },
  occurrences: [
    occurrence(10, "target", 2),
    occurrence(7, "stop", -1),
    occurrence(4, "time", 0.25),
  ],
  series: {
    bars: 5000,
    from: "2006-01-03",
    id: "QQQ:1d",
    symbol: "QQQ",
    to: "2026-01-15",
  },
  summary: {
    avgR: 0.4375,
    breakEvenShare: 1 / 3,
    count: 4,
    expectancyR: 0.5,
    stopFirst: 1,
    targetFirst: 2,
    targetShare: 2 / 3,
    timeExit: 1,
    winRate: 0.75,
  },
  ...overrides,
});

const gatewayWith = (
  overrides: Partial<SetupReplayGateway> = {}
): SetupReplayGateway => ({
  presets: vi.fn(async () => ({ presets: PRESETS })),
  run: vi.fn(async () => output()),
  series: vi.fn(async () => ({
    series: [series("SPY", "1d"), series("ES", "1m"), series("QQQ", "1d")],
  })),
  ...overrides,
});

const choose = async (
  container: HTMLElement,
  label: string,
  index: number
): Promise<void> => {
  const field = [...container.querySelectorAll("label")].find(
    (element) => element.textContent === label
  );
  const select = container.querySelector<HTMLSelectElement>(
    `#${CSS.escape(field?.htmlFor ?? "")}`
  );
  if (select === null) throw new Error(`No select labelled ${label}`);
  await act(async () => {
    select.value = String(index);
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();
  });
};

const submit = async (container: HTMLElement): Promise<void> => {
  await act(async () => {
    container
      .querySelector("form")
      ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await flush();
  });
};

const stat = (container: HTMLElement, label: string) =>
  container.querySelector(`[data-stat="${label}"]`)?.textContent ?? "";

describe("setup replay formatting", () => {
  it("formats R, shares and returns with signs", () => {
    expect(formatR(null)).toBe("n/a");
    expect(formatR(1.5)).toBe("+1.50R");
    expect(formatR(-1)).toBe("-1.00R");
    expect(formatR(0)).toBe("0.00R");
    expect(formatShare(null)).toBe("n/a");
    expect(formatShare(0.125)).toBe("12.5%");
    expect(formatReturnPct(2)).toBe("+2.00%");
    expect(formatReturnPct(-0.5)).toBe("-0.50%");
  });
});

describe("SetupReplayWorkspace", () => {
  it("replays the default series and setup with no clicks, then replays each change", async () => {
    let finish: (value: SetupReplayRunOutput) => void = () => undefined;
    const run = vi.fn(
      () =>
        new Promise<SetupReplayRunOutput>((resolve) => {
          finish = resolve;
        })
    );
    const gateway = gatewayWith({ run });
    const { container } = await mount(
      <SetupReplayWorkspace gateway={gateway} />
    );
    expect(container.querySelector("input")).toBeNull();
    expect(container.textContent).toContain(
      "This is a simulation over past bars, not a prediction."
    );
    expect(container.textContent).toContain("Preparing the replay…");
    expect(window.location.search).toBe("");
    const seriesOptions = [
      ...(container.querySelector("select")?.options ?? []),
    ].map((option) => option.textContent);
    expect(seriesOptions).toEqual([
      "SPY daily (5,000 bars)",
      "QQQ daily (5,000 bars)",
    ]);
    expect(container.textContent).toContain(
      "Opens above the prior high and holds."
    );
    await settle();
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenLastCalledWith({
      maxHoldBars: 10,
      paths: 5000,
      seriesId: "SPY:1d",
      setup: "gapUpHold",
      stop: { kind: "atr", multiple: 1.5 },
      targetR: 2,
    });
    await act(async () => {
      finish(output());
      await flush();
    });
    expect(stat(container, "Occurrences")).toContain("4");

    await choose(container, "Daily series", 1);
    await choose(container, "Setup", 1);
    expect(container.textContent).toContain("Closes above the 20-day high.");
    await choose(container, "Stop distance", 3);
    await choose(container, "Target", 0);
    await choose(container, "Time exit after", 2);
    await choose(container, "Monte Carlo paths", 2);
    expect(window.location.search).toBe(
      "?symbol=QQQ&setup=breakout20&stop=3&target=1&hold=20&paths=10000"
    );
    expect(run).toHaveBeenCalledTimes(1);
    await settle();

    expect(run).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenLastCalledWith({
      maxHoldBars: 20,
      paths: 10_000,
      seriesId: "QQQ:1d",
      setup: "breakout20",
      stop: { kind: "atr", multiple: 3 },
      targetR: 1,
    });
    const button = container.querySelector("button");
    expect(button?.disabled).toBe(true);
    expect(button?.textContent).toBe("Running…");
    expect(container.textContent).toContain("Replaying…");
    expect(stat(container, "Occurrences")).toContain("4");

    await act(async () => {
      finish(output());
      await flush();
    });
    expect(button?.disabled).toBe(false);
    expect(container.textContent).toContain(
      "20-day breakout on QQQ daily, 2006-01-03 to 2026-01-15 (5,000 bars). Stop 3 ATR, target 1R, time exit after 20 bars."
    );
    expect(stat(container, "Occurrences")).toContain("4");
    expect(stat(container, "Win rate")).toContain("75.0%");
    expect(stat(container, "Average R")).toContain("+0.44R");
    expect(stat(container, "Planned expectancy (R)")).toContain("+0.50R");
    expect(button?.className).toContain("min-h-11");
    const targetShare = container.querySelectorAll(
      '[data-stat="Target share"] dd'
    );
    expect([...targetShare].map((entry) => entry.textContent)).toEqual([
      "66.7%",
      "Break-even 33.3%",
    ]);
    expect(
      container.querySelectorAll('[data-stat="Win rate"] dd')
    ).toHaveLength(1);
    expect(stat(container, "Paths in profit")).toContain("73.0%");
    expect(stat(container, "Total R, 5th to 95th")).toContain(
      "-2.00R to +5.00R"
    );
    expect(stat(container, "Median compounded return")).toContain("+3.10%");
    expect(
      container.querySelector('[role="img"]')?.getAttribute("aria-label")
    ).toBe(
      "Outcomes: Target first 2 (50.0%), Stop first 1 (25.0%), Time exit 1 (25.0%)"
    );
    expect(
      container.querySelector<HTMLElement>('[data-outcome="targetFirst"]')
        ?.style.width
    ).toBe("50%");
    expect(container.textContent).toContain("seed 4242");
    expect(container.textContent).toContain(
      "Showing the newest 3 of 4 occurrences."
    );
    const region = container.querySelector('[role="region"]');
    expect(region?.getAttribute("tabindex")).toBe("0");
    const rows = [...container.querySelectorAll("tbody tr")];
    expect(rows.map((row) => row.getAttribute("data-outcome"))).toEqual([
      "target",
      "stop",
      "time",
    ]);
    expect(rows[1]?.textContent).toBe(
      "2026-01-072026-01-09100.0098.00Stop3-2.00%-1.00R"
    );
  });

  it("opens on the first stored Core 7 futures series", async () => {
    const run = vi.fn(async () => output());
    const { container } = await mount(
      <SetupReplayWorkspace
        gateway={gatewayWith({
          run,
          series: vi.fn(async () => ({
            series: [
              series("SPY", "1d"),
              series("NQ=F", "1d"),
              series("ES=F", "1d"),
            ],
          })),
        })}
      />
    );
    expect(container.querySelector("select")?.value).toBe("2");
    await settle();
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({ seriesId: "ES=F:1d" })
    );
    expect(window.location.search).toBe("");
  });

  it("applies valid URL choices and falls back for unknown ones", async () => {
    window.history.replaceState(
      null,
      "",
      "/setup-replay?symbol=QQQ&setup=breakout20&stop=9&target=3&hold=nope&paths=1000"
    );
    const run = vi.fn(async () => output());
    await mount(<SetupReplayWorkspace gateway={gatewayWith({ run })} />);
    await settle();
    expect(run).toHaveBeenCalledWith({
      maxHoldBars: 10,
      paths: 1000,
      seriesId: "QQQ:1d",
      setup: "breakout20",
      stop: { kind: "atr", multiple: 1.5 },
      targetR: 3,
    });
    expect(window.location.search).toBe(
      "?symbol=QQQ&setup=breakout20&target=3&paths=1000"
    );
  });

  it("parses the query and builds defaults as pure functions", () => {
    const defaults = defaultSetupReplayChoices([], []);
    expect(defaults).toEqual({
      maxHoldBars: 10,
      paths: 5000,
      setup: "",
      stop: 1.5,
      symbol: "",
      targetR: 2,
    });
    expect(
      parseSetupReplayQuery(
        "?symbol=ZZZ&setup=x&stop=3",
        defaults,
        ["A"],
        ["s"]
      )
    ).toEqual({ ...defaults, stop: 3 });
  });

  it("reuses a cached result when a choice comes back, and Run again calls the server", async () => {
    const run = vi.fn(async () => output());
    const { container } = await mount(
      <SetupReplayWorkspace gateway={gatewayWith({ run })} />
    );
    await settle();
    expect(run).toHaveBeenCalledTimes(1);
    await choose(container, "Target", 0);
    await settle();
    expect(run).toHaveBeenCalledTimes(2);
    await choose(container, "Target", 2);
    await settle();
    expect(run).toHaveBeenCalledTimes(2);
    expect(stat(container, "Occurrences")).toContain("4");
    expect(window.location.search).toBe("");
    await submit(container);
    expect(run).toHaveBeenCalledTimes(3);
  });

  it("ignores an older replay that settles after a newer one", async () => {
    const finishers: ((value: SetupReplayRunOutput) => void)[] = [];
    const failers: ((error: unknown) => void)[] = [];
    const run = vi.fn(
      () =>
        new Promise<SetupReplayRunOutput>((resolve, reject) => {
          finishers.push(resolve);
          failers.push(reject);
        })
    );
    const { container } = await mount(
      <SetupReplayWorkspace gateway={gatewayWith({ run })} />
    );
    await settle();
    await choose(container, "Target", 0);
    await settle();
    await choose(container, "Target", 3);
    await settle();
    expect(run).toHaveBeenCalledTimes(3);
    await act(async () => {
      finishers[2]?.(output({ summary: { ...output().summary, count: 9 } }));
      await flush();
    });
    expect(stat(container, "Occurrences")).toContain("9");
    await act(async () => {
      finishers[0]?.(output());
      failers[1]?.(new Error("late"));
      await flush();
    });
    expect(stat(container, "Occurrences")).toContain("9");
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("uses the browser gateway when none is supplied", async () => {
    const gateway = gatewayWith();
    browser.gateway = gateway;
    const { container } = await mount(<SetupReplayWorkspace />);
    expect(gateway.series).toHaveBeenCalledTimes(1);
    expect(container.querySelector("form")).not.toBeNull();
  });

  it("shows n/a statistics when the setup never occurred", async () => {
    const empty = output({
      monteCarlo: null,
      occurrences: [],
      summary: {
        avgR: null,
        breakEvenShare: 0.5,
        count: 0,
        expectancyR: null,
        stopFirst: 0,
        targetFirst: 0,
        targetShare: null,
        timeExit: 0,
        winRate: null,
      },
    });
    const { container } = await mount(
      <SetupReplayWorkspace
        gateway={gatewayWith({ run: vi.fn(async () => empty) })}
      />
    );
    await settle();
    expect(stat(container, "Paths in profit")).toContain("n/a");
    expect(stat(container, "Total R, 5th to 95th")).toContain("n/a");
    expect(stat(container, "Median compounded return")).toContain("n/a");
    expect(container.textContent).toContain(
      "This setup did not occur in the stored bars."
    );
    expect(container.textContent).not.toContain("Monte Carlo:");
    expect(container.querySelector("table")).toBeNull();
  });

  it("lists every occurrence without a newest-of note when nothing was cut", async () => {
    const all = output({
      summary: { ...output().summary, count: 3, timeExit: 0 },
    });
    const { container } = await mount(
      <SetupReplayWorkspace
        gateway={gatewayWith({ run: vi.fn(async () => all) })}
      />
    );
    await settle();
    expect(container.querySelectorAll("tbody tr")).toHaveLength(3);
    expect(container.textContent).not.toContain("Showing the newest");
  });

  it("shows run failures as alerts", async () => {
    const { container } = await mount(
      <SetupReplayWorkspace
        gateway={gatewayWith({
          run: vi.fn(async () => {
            throw { code: "BAD_REQUEST", message: "Series too short" };
          }),
        })}
      />
    );
    await settle();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "Series too short"
    );
  });

  it("shows the operator notice or a generic failure when loading fails", async () => {
    const forbidden = await mount(
      <SetupReplayWorkspace
        gateway={gatewayWith({
          presets: vi.fn(async () => {
            throw { code: "FORBIDDEN", message: "Forbidden" };
          }),
        })}
      />
    );
    expect(
      forbidden.container.querySelector('[role="alert"]')?.textContent
    ).toBe("Operator access required.");
    const broken = await mount(
      <SetupReplayWorkspace
        gateway={gatewayWith({
          series: vi.fn(async () => {
            throw new Error(" ");
          }),
        })}
      />
    );
    expect(broken.container.querySelector('[role="alert"]')?.textContent).toBe(
      "Request failed."
    );
  });

  it("explains how to import bars when no daily series is stored", async () => {
    const { container } = await mount(
      <SetupReplayWorkspace
        gateway={gatewayWith({
          series: vi.fn(async () => ({ series: [series("ES", "1m")] })),
        })}
      />
    );
    expect(container.textContent).toContain("No stored daily bar series yet.");
    expect(container.querySelector("form")).toBeNull();
  });

  it("ignores a load that settles after unmount", async () => {
    let resolveSeries: () => void = () => undefined;
    let rejectSeries: () => void = () => undefined;
    const pending = (settle: "resolve" | "reject") =>
      gatewayWith({
        series: vi.fn(
          () =>
            new Promise<{ series: InstantBacktestSeries[] }>(
              (resolve, reject) => {
                if (settle === "resolve")
                  resolveSeries = () => resolve({ series: [] });
                else rejectSeries = () => reject(new Error("late"));
              }
            )
        ),
      });
    const first = await mount(
      <SetupReplayWorkspace gateway={pending("resolve")} />
    );
    const second = await mount(
      <SetupReplayWorkspace gateway={pending("reject")} />
    );
    expect(first.container.textContent).toBe("Loading stored series…");
    await act(async () => {
      first.root.unmount();
      second.root.unmount();
    });
    await act(async () => {
      resolveSeries();
      rejectSeries();
      await flush();
    });
    expect(first.container.textContent).toBe("");
    expect(second.container.textContent).toBe("");
  });
});
