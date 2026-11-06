// @vitest-environment jsdom
import type {
  ApiClient,
  EngineComparisonListOutput,
  EngineComparisonRun,
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
  COMPARISON_POLL_MAX,
  comparisonSummary,
  createBrowserEngineComparisonGateway,
  createEngineComparisonGateway,
  DifferencesBadge,
  type EngineComparisonGateway,
  formatMs,
  GateNautilusStatus,
  NautilusCard,
  NautilusRunStatus,
  nautilusRunText,
  runsByKey,
  SweepComparisonSummary,
  TypeScriptEngineLine,
  useComparisonRuns,
} from "./engine-comparison.tsx";

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
  vi.useRealTimers();
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

const stats = {
  bars: 10,
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
};

const comparisonRun = (
  overrides: Partial<EngineComparisonRun> = {}
): EngineComparisonRun => ({
  comparison: {
    feature: "instant",
    groupId: "g-1",
    label: "SPY 1d smaCross",
    typescript: {
      host: "web server",
      stats,
      tradeCount: 0,
      trades: [],
      wallMs: 3,
    },
  },
  createdAt: new Date(0),
  differences: null,
  engineRun: null,
  engineVersion: "nautilus-trader-1.227.0",
  error: null,
  finishedAt: null,
  from: "1970-01-01",
  id: "run-1",
  queueWaitMs: null,
  startedAt: null,
  status: "queued",
  symbol: "SPY",
  timeframe: "1d",
  to: "1970-12-31",
  ...overrides,
});

const engineRun = {
  cpuMs: 120,
  gpu: "not used (Nautilus engine is CPU-only)",
  host: "rig-1",
  processCases: 1,
  processes: 1,
  processWallMs: 900,
  wallMs: 1500,
};

const done = comparisonRun({
  differences: { items: [], ok: true },
  engineRun,
  queueWaitMs: 4200,
  status: "succeeded",
});

const differing = comparisonRun({
  differences: {
    items: [
      {
        detail: "The engines made a different number of trades",
        field: "tradeCount",
        nautilus: 3,
        typescript: 2,
      },
      {
        detail: "x",
        field: "sharpe",
        nautilus: null,
        typescript: 1.2,
      },
    ],
    ok: false,
  },
  engineRun,
  id: "run-2",
  queueWaitMs: 100,
  status: "succeeded",
});

const answers = (...lists: EngineComparisonRun[][]) => {
  const queue = [...lists];
  const comparisons = vi.fn(
    async (): Promise<EngineComparisonListOutput> => ({
      runs: queue.length > 1 ? (queue.shift() ?? []) : (queue[0] ?? []),
    })
  );
  return { comparisons } satisfies EngineComparisonGateway;
};

describe("engine comparison helpers", () => {
  it("formats times, run states and summaries", () => {
    expect(formatMs(null)).toBe("n/a");
    expect(formatMs(12.4)).toBe("12 ms");
    expect(formatMs(1500)).toBe("1.5 s");
    expect(nautilusRunText(comparisonRun())).toBe("queued");
    expect(
      nautilusRunText(comparisonRun({ queueWaitMs: 2000, status: "running" }))
    ).toBe("running (queue 2.0 s)");
    expect(nautilusRunText(done)).toBe("1.5 s (queue 4.2 s)");
    expect(nautilusRunText(comparisonRun({ status: "succeeded" }))).toBe(
      "n/a (queue n/a)"
    );
    expect(
      nautilusRunText(comparisonRun({ error: "boom", status: "failed" }))
    ).toBe("failed: boom");
    expect(nautilusRunText(comparisonRun({ status: "failed" }))).toBe(
      "failed: no reason"
    );
    expect(
      comparisonSummary([
        done,
        differing,
        comparisonRun({ status: "failed" }),
        comparisonRun(),
      ])
    ).toEqual({ differing: 1, done: 3, failed: 1, matched: 1 });
    const keyed = runsByKey([
      comparisonRun({ comparison: { ...done.comparison, key: "a" } }),
      comparisonRun({ comparison: { ...done.comparison, key: "a" }, id: "x" }),
      done,
    ]);
    expect(keyed.get("a")).toHaveLength(2);
    expect(keyed.get("")).toHaveLength(1);
    expect(runsByKey(null).size).toBe(0);
  });

  it("builds the gateway on the comparisons list of a group", async () => {
    const list = vi.fn(async () => ({ runs: [] }));
    const client = {
      backtestRuns: { comparisons: { list } },
    } as unknown as ApiClient;
    await createEngineComparisonGateway(client).comparisons("g-9");
    expect(list).toHaveBeenCalledWith({ groupId: "g-9", limit: 500 });
    const fetchMock = vi.fn(async () => Response.json({ json: { runs: [] } }));
    vi.stubGlobal("fetch", fetchMock);
    await createBrowserEngineComparisonGateway().comparisons("g-9");
    expect(fetchMock).toHaveBeenCalled();
  });
});

describe("engine comparison components", () => {
  it("shows the TypeScript line with the engine time or why there is none", async () => {
    const { container } = await mount(
      <>
        <TypeScriptEngineLine
          clientMs={42}
          timing={{ groupId: "g", host: "QuantVPS web", wallMs: 3 }}
        />
        <TypeScriptEngineLine
          clientMs={null}
          timing={{
            groupId: "g",
            host: "QuantVPS web",
            wallMs: null,
            wallNote: "timer frozen in Worker runtime",
          }}
        />
        <TypeScriptEngineLine
          clientMs={5}
          timing={{ groupId: "g", host: "h", wallMs: null }}
        />
      </>
    );
    const lines = [...container.querySelectorAll("[data-engine]")].map(
      (node) => node.textContent
    );
    expect(lines).toEqual([
      "TypeScript · QuantVPS web · 42 ms (round trip) · engine 3 ms",
      "TypeScript · QuantVPS web · shown from this visit's cache · engine time n/a (timer frozen in Worker runtime)",
      "TypeScript · h · 5 ms (round trip) · engine time n/a (not measured)",
    ]);
  });

  it("shows match, a list of differences, or nothing before the result", async () => {
    const { container } = await mount(
      <>
        <DifferencesBadge differences={null} />
        <DifferencesBadge differences={{ items: [], ok: true }} />
        <DifferencesBadge differences={differing.differences} />
        <DifferencesBadge
          differences={{
            items: [
              {
                detail: "d",
                field: "trades",
                nautilus: "1->2 end",
                typescript: null,
              },
            ],
            ok: false,
          }}
        />
      </>
    );
    const badges = [...container.querySelectorAll("[data-differences]")];
    expect(badges.map((node) => node.getAttribute("data-differences"))).toEqual(
      ["0", "2", "1"]
    );
    expect(badges[1]?.textContent).toContain("2 differences");
    expect(badges[1]?.textContent).toContain(
      "tradeCount: TypeScript 2, Nautilus 3. The engines made a different number of trades"
    );
    expect(badges[1]?.textContent).toContain(
      "sharpe: TypeScript 1.2, Nautilus n/a."
    );
    expect(badges[2]?.textContent).toContain("1 difference");
    expect(badges[2]?.textContent).toContain(
      "trades: TypeScript n/a, Nautilus 1->2 end."
    );
  });

  it("polls a group until every run is done and shows the Nautilus card", async () => {
    vi.useFakeTimers();
    const gateway = answers(
      [comparisonRun()],
      [comparisonRun({ status: "running" })],
      [done]
    );
    const { container } = await mount(
      <NautilusCard
        gateway={gateway}
        pollMs={10}
        timing={{ groupId: "g-1", host: "web server", wallMs: 1 }}
      />
    );
    const card = () => container.querySelector("[data-nautilus-card]");
    expect(card()?.textContent).toBe("Nautilus · rig · queued");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(card()?.getAttribute("data-nautilus-card")).toBe("running");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(card()?.textContent).toContain(
      "Nautilus · rig-1 · 1.5 s (queue 4.2 s)"
    );
    expect(card()?.textContent).toContain("match");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(gateway.comparisons).toHaveBeenCalledTimes(3);
  });

  it("shows a read error, retries, and stops at the poll limit", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const gateway: EngineComparisonGateway = {
      comparisons: vi.fn(async () => {
        calls += 1;
        if (calls === 1) throw new Error("down");
        return { runs: [comparisonRun()] };
      }),
    };
    const { container } = await mount(
      <NautilusCard
        gateway={gateway}
        pollMax={3}
        pollMs={10}
        timing={{ groupId: "g-1", host: "web server", wallMs: 1 }}
      />
    );
    expect(container.textContent).toContain(
      "The Nautilus status could not be read."
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(gateway.comparisons).toHaveBeenCalledTimes(3);
    expect(container.textContent).not.toContain("could not be read");
    // A failing read at the poll limit stops too.
    const failing: EngineComparisonGateway = {
      comparisons: vi.fn(async () => Promise.reject(new Error("down"))),
    };
    await mount(
      <NautilusCard
        gateway={failing}
        pollMax={2}
        pollMs={10}
        timing={{ groupId: "g-2", host: "h", wallMs: 1 }}
      />
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(failing.comparisons).toHaveBeenCalledTimes(2);
    expect(COMPARISON_POLL_MAX).toBe(600);
  });

  it("shows a queue error instead of the Nautilus status, and reads nothing without a group", async () => {
    const gateway = answers([]);
    const { container } = await mount(
      <NautilusCard
        gateway={gateway}
        timing={{
          error: "Nautilus comparison could not be queued",
          groupId: null,
          host: "h",
          wallMs: 1,
        }}
      />
    );
    expect(container.textContent).toBe(
      "Nautilus · Nautilus comparison could not be queued"
    );
    expect(gateway.comparisons).not.toHaveBeenCalled();
  });

  it("drops a late answer after unmount", async () => {
    let resolve: (value: EngineComparisonListOutput) => void = () => undefined;
    const gateway: EngineComparisonGateway = {
      comparisons: vi.fn(
        () =>
          new Promise<EngineComparisonListOutput>((done_) => {
            resolve = done_;
          })
      ),
    };
    let rejectLate: (error: unknown) => void = () => undefined;
    const rejecting: EngineComparisonGateway = {
      comparisons: vi.fn(
        () =>
          new Promise<EngineComparisonListOutput>((_, reject) => {
            rejectLate = reject;
          })
      ),
    };
    const first = await mount(
      <NautilusCard
        gateway={gateway}
        timing={{ groupId: "g", host: "h", wallMs: 1 }}
      />
    );
    const second = await mount(
      <NautilusCard
        gateway={rejecting}
        timing={{ groupId: "g", host: "h", wallMs: 1 }}
      />
    );
    await act(async () => first.root.unmount());
    await act(async () => second.root.unmount());
    roots.splice(0);
    await act(async () => {
      resolve({ runs: [done] });
      rejectLate(new Error("late"));
      await flush();
    });
    expect(gateway.comparisons).toHaveBeenCalledTimes(1);
  });

  it("summarizes a sweep, lists cell and gate states", async () => {
    const state = {
      message: "The Nautilus status could not be read.",
      runs: [done, differing],
    };
    const { container } = await mount(
      <>
        <SweepComparisonSummary
          clientMs={1200}
          state={state}
          timing={{
            dropped: 21,
            groupId: "g",
            host: "h",
            queued: 100,
            wallMs: 50,
          }}
        />
        <SweepComparisonSummary
          clientMs={null}
          state={{ message: null, runs: null }}
          timing={{
            dropped: 0,
            error: "Nautilus comparison could not be queued",
            groupId: null,
            host: "h",
            queued: 0,
            wallMs: 50,
          }}
        />
        <SweepComparisonSummary
          clientMs={10}
          state={{ message: null, runs: null }}
          timing={{ dropped: 0, groupId: "g", host: "h", queued: 3, wallMs: 5 }}
        />
        <NautilusRunStatus run={undefined} />
        <NautilusRunStatus run={done} />
        <GateNautilusStatus runs={undefined} />
        <GateNautilusStatus
          runs={[
            comparisonRun({
              comparison: { ...done.comparison, label: "AP TEST x: in-sample" },
              id: "a",
            }),
            comparisonRun({
              comparison: { ...done.comparison, label: "full run" },
              id: "b",
            }),
          ]}
        />
      </>
    );
    const summaries = container.querySelectorAll("[data-sweep-comparison]");
    expect(summaries[0]?.textContent).toContain(
      "Nautilus · rig-1 · 2 of 100 cells done, 1 match, 1 differ, 0 failed."
    );
    expect(summaries[0]?.textContent).toContain("21 cells were not repeated");
    expect(summaries[0]?.textContent).toContain("could not be read");
    expect(summaries[1]?.getAttribute("data-sweep-comparison")).toBe("none");
    expect(summaries[1]?.textContent).toContain(
      "Nautilus · Nautilus comparison could not be queued"
    );
    expect(summaries[1]?.textContent).not.toContain("were not repeated");
    expect(summaries[2]?.textContent).toContain(
      "Nautilus · rig · 0 of 3 cells done"
    );
    expect(
      [...container.querySelectorAll("[data-nautilus]")].map((node) =>
        node.getAttribute("data-nautilus")
      )
    ).toEqual(["none", "succeeded", "none", "queued", "queued"]);
    expect(container.textContent).toContain("in-sample: queued");
    expect(container.textContent).toContain("full run: queued");
  });

  it("reads again when the revision changes", async () => {
    const gateway = answers([done]);
    const Probe = ({ revision }: { revision: number }) => {
      const state = useComparisonRuns(gateway, "g", 10, 5, revision);
      return <p>{state.runs?.length ?? "none"}</p>;
    };
    const { root } = await mount(<Probe revision={1} />);
    await act(async () => {
      root.render(<Probe revision={2} />);
      await flush();
    });
    expect(gateway.comparisons).toHaveBeenCalledTimes(2);
  });
});
