// @vitest-environment jsdom
import type {
  AgentModelRunSearchOutput,
  AgentModelRunBreakdownOutput,
  AgentModelRunFacetsOutput,
  AgentModelRunListOutput,
  AgentModelRunOutput,
} from "@darkfactory/api";
import { act } from "react";
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

import type { AgentModelRunsGateway } from "./agent-model-runs-client.ts";
import { AgentModelRunsWorkspace } from "./agent-model-runs-workspace.tsx";

const defaultGateway = vi.hoisted(() => ({
  breakdown: async () => ({ groupBy: "model", rows: [] }),
  events: async () => {
    throw new Error("unused");
  },
  search: async () => ({ results: [] }),
  exportCsv: async () => ({
    csv: "",
    filename: "x.csv",
    rowCount: 0,
    truncated: false,
  }),
  get: async () => {
    throw new Error("unused");
  },
  list: async () => {
    throw Object.assign(new Error("denied"), { code: "FORBIDDEN" });
  },
}));

vi.mock("./agent-model-runs-client.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./agent-model-runs-client.ts")>()),
  createBrowserAgentModelRunsGateway: () => defaultGateway,
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
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.useRealTimers();
});

const flush = async () => {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
};

// Filter changes reach the server once typing or clicking pauses for 300 ms.
const settle = async () => {
  await act(async () => {
    vi.advanceTimersByTime(300);
  });
  await act(flush);
};

const at = new Date("2026-10-01T12:00:00.000Z");
const modelRun = (
  overrides: Partial<AgentModelRunOutput> = {}
): AgentModelRunOutput => ({
  analysts: ["market"],
  batch: null,
  costUsd: 0.25,
  createdAt: at,
  dataSource: null,
  decisionDate: "2026-09-01",
  durationMs: null,
  entryPrice: 190,
  error: null,
  finishedAt: null,
  flags: ["rerun"],
  framework: "tradingagents",
  frameworkVersion: "0.2.0+abc123",
  horizon: "2-4 weeks",
  horizonBucket: "weeks",
  id: "run-1",
  inputTokens: 1000,
  llmCalls: 4,
  memory: false,
  model: "gpt-4o-mini",
  modelsServed: [{ requested: "gpt-4o-mini", served: "gpt-4o-mini-2024" }],
  outputTokens: 500,
  provider: "openai",
  purpose: "live",
  rating: "buy",
  ratingSource: "stated",
  runKey: "key-1",
  startedAt: null,
  status: "succeeded",
  stopPrice: 180,
  targetPrice: 210,
  taskId: null,
  ticker: "AAPL",
  toolCalls: 3,
  updatedAt: at,
  variant: null,
  ...overrides,
});

const facets = (
  overrides: Partial<AgentModelRunFacetsOutput> = {}
): AgentModelRunFacetsOutput => ({
  batch: [],
  flags: [],
  framework: [{ count: 2, value: "tradingagents" }],
  horizonBucket: [],
  model: [],
  provider: [],
  purpose: [],
  rating: [
    { count: 1, value: "buy" },
    { count: 1, value: "unrated" },
  ],
  servedModel: [],
  status: [],
  ticker: [{ count: 2, value: "AAPL" }],
  variant: [],
  ...overrides,
});

const page = (
  runs: AgentModelRunOutput[],
  overrides: Partial<AgentModelRunListOutput> = {}
): AgentModelRunListOutput => ({
  facets: facets(),
  nextCursor: null,
  runs,
  ...overrides,
});

const breakdownOf = (
  overrides: Partial<AgentModelRunBreakdownOutput> = {}
): AgentModelRunBreakdownOutput => ({
  groupBy: "model",
  rows: [
    {
      avgCostUsd: 0.25,
      failed: 0,
      holdShare: 0.5,
      key: "gpt-4o-mini",
      rated: 2,
      runs: 2,
      totalCostUsd: 0.5,
    },
    {
      avgCostUsd: 0,
      failed: 1,
      holdShare: null,
      key: null,
      rated: 0,
      runs: 1,
      totalCostUsd: 0,
    },
  ],
  ...overrides,
});

const gatewayWith = (
  overrides: Partial<AgentModelRunsGateway> = {}
): AgentModelRunsGateway & {
  list: ReturnType<typeof vi.fn>;
  breakdown: ReturnType<typeof vi.fn>;
  exportCsv: ReturnType<typeof vi.fn>;
  search: ReturnType<typeof vi.fn>;
} =>
  ({
    breakdown: vi.fn(async () => breakdownOf()),
    exportCsv: vi.fn(async () => ({
      csv: "id\r\n",
      filename: "runs.csv",
      rowCount: 1,
      truncated: false,
    })),
    events: vi.fn(),
    get: vi.fn(),
    list: vi.fn(async () => page([modelRun()])),
    search: vi.fn(
      async (): Promise<AgentModelRunSearchOutput> => ({
        results: [
          {
            rank: 0.5,
            run: modelRun(),
            snippets: [
              {
                agent: "News Analyst",
                kind: "reasoning",
                segments: [
                  { match: false, text: "price held " },
                  { match: true, text: "support" },
                  { match: false, text: " today" },
                ],
                seq: 3,
              },
            ],
          },
        ],
      })
    ),
    ...overrides,
  }) as never;

const mount = async (
  gateway: AgentModelRunsGateway | undefined,
  onDownload = vi.fn()
) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(
      <AgentModelRunsWorkspace
        onDownload={onDownload}
        {...(gateway === undefined ? {} : { gateway })}
      />
    );
  });
  await act(flush);
  return container;
};

const buttonNamed = (container: HTMLElement, name: string) => {
  const button = [...container.querySelectorAll("button")].find((element) =>
    element.textContent?.includes(name)
  );
  if (button === undefined) throw new Error(`No button ${name}`);
  return button;
};

const click = async (element: HTMLElement) => {
  await act(async () => {
    element.click();
  });
  await act(flush);
  await settle();
};

const checkbox = (container: HTMLElement, facet: string, label: string) => {
  const field = container.querySelector(`[data-facet="${facet}"]`);
  const input = [...(field?.querySelectorAll("label") ?? [])]
    .find((element) => element.textContent?.includes(label))
    ?.querySelector("input");
  if (input === undefined || input === null)
    throw new Error(`No ${facet} checkbox ${label}`);
  return input;
};

const typeInput = async (input: HTMLInputElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value"
  )?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(flush);
};

const setInput = async (input: HTMLInputElement, value: string) => {
  await typeInput(input, value);
  await settle();
};

// The web lib target predates Promise.withResolvers, so the executor form stays.
const deferred = <T,>() => {
  const handles: {
    resolve: (value: T) => void;
    reject: (error: unknown) => void;
  } = { reject: () => undefined, resolve: () => undefined };
  const promise = new Promise<T>((resolve, reject) => {
    handles.resolve = resolve;
    handles.reject = reject;
  });
  return { promise, ...handles };
};

describe("AgentModelRunsWorkspace", () => {
  it("shows loading, then runs with facets, breakdown and the research note", async () => {
    const pending = deferred<AgentModelRunListOutput>();
    const gateway = gatewayWith({ list: vi.fn(() => pending.promise) });
    const container = await mount(gateway);
    expect(
      container.querySelector('[aria-busy="true"]')?.textContent
    ).toContain("Loading model runs");
    await act(async () => {
      pending.resolve(
        page([
          modelRun(),
          modelRun({
            frameworkVersion: null,
            id: "run-2",
            modelsServed: [],
            rating: "hold",
            ratingSource: "mapped",
          }),
          modelRun({
            flags: [],
            horizon: null,
            id: "run-3",
            rating: null,
            status: "failed",
          }),
        ])
      );
    });
    await act(flush);
    expect(container.textContent).toContain(
      "Research only. Agent ratings never place orders."
    );
    expect(
      container.querySelector('a[href="/agents/runs/run-1"]')
    ).not.toBeNull();
    expect(container.textContent).toContain("adjusted");
    expect(container.textContent).toContain("served: gpt-4o-mini-2024");
    expect(container.textContent).toContain("hold (mapped)");
    expect(container.querySelector('[data-rating="unrated"]')).not.toBeNull();
    expect(container.textContent).toContain("1.5K");
    expect(container.textContent).toContain("$0.25");
    expect(container.textContent).toContain("190 / 180 / 210");
    expect(container.textContent).toContain("Unrated");
    expect(container.textContent).toContain("(not set)");
    expect(container.textContent).toContain("50%");
    expect(gateway.breakdown).toHaveBeenCalledWith({}, "model");
  });

  it("applies facet filters, keeps an unmatched selection and clears filters", async () => {
    const gateway = gatewayWith();
    const container = await mount(gateway);
    gateway.list.mockResolvedValueOnce(
      page([modelRun()], {
        facets: facets({ rating: [{ count: 1, value: "buy" }] }),
      })
    );
    await click(checkbox(container, "rating", "Unrated"));
    expect(gateway.list).toHaveBeenLastCalledWith({ rating: ["unrated"] });
    expect(gateway.breakdown).toHaveBeenLastCalledWith(
      { rating: ["unrated"] },
      "model"
    );
    // "unrated" no longer has runs but stays checked so it can be cleared.
    const unrated = checkbox(container, "rating", "Unrated");
    expect(unrated.checked).toBe(true);
    expect(unrated.closest("label")?.textContent).toContain("0");
    await click(checkbox(container, "ticker", "AAPL"));
    expect(gateway.list).toHaveBeenLastCalledWith({
      rating: ["unrated"],
      ticker: ["AAPL"],
    });
    await click(buttonNamed(container, "Clear 2 filters"));
    expect(gateway.list).toHaveBeenLastCalledWith({});
  });

  it("groups the breakdown by another field and reports breakdown failures", async () => {
    const gateway = gatewayWith();
    const container = await mount(gateway);
    gateway.breakdown.mockRejectedValueOnce(
      Object.assign(new Error("x"), { code: "STORAGE_ERROR" })
    );
    const select = container.querySelector("select") as HTMLSelectElement;
    await act(async () => {
      select.value = "ticker";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(flush);
    expect(gateway.breakdown).toHaveBeenLastCalledWith({}, "ticker");
    expect(container.textContent).toContain("Model run storage unavailable");
    gateway.breakdown.mockResolvedValueOnce(breakdownOf({ rows: [] }));
    await act(async () => {
      select.value = "framework";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(flush);
    expect(container.textContent).toContain("No runs to group.");
  });

  it("explains how agents record runs when there are none", async () => {
    const container = await mount(
      gatewayWith({
        list: vi.fn(async () =>
          page([], {
            facets: facets({ framework: [], rating: [], ticker: [] }),
          })
        ),
      })
    );
    expect(container.textContent).toContain("No model runs yet");
    expect(container.textContent).toContain("model_runs_record");
  });

  it("shows a filtered empty state with a reset", async () => {
    const gateway = gatewayWith();
    const container = await mount(gateway);
    gateway.list.mockResolvedValueOnce(page([]));
    await click(checkbox(container, "framework", "tradingagents"));
    expect(container.textContent).toContain("No runs match these filters.");
    await click(buttonNamed(container, "Clear filters"));
    expect(gateway.list).toHaveBeenLastCalledWith({});
    expect(container.textContent).not.toContain("No runs match");
  });

  it("reports a load failure and retries", async () => {
    const gateway = gatewayWith({
      list: vi
        .fn()
        .mockRejectedValueOnce(
          Object.assign(new Error("x"), { code: "STORAGE_ERROR" })
        )
        .mockResolvedValueOnce(page([modelRun()])),
    });
    const container = await mount(gateway);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Model run storage unavailable"
    );
    await click(buttonNamed(container, "Retry"));
    expect(
      container.querySelector('a[href="/agents/runs/run-1"]')
    ).not.toBeNull();
  });

  it("shows the operator notice when access is denied", async () => {
    const container = await mount(undefined);
    expect(
      container.querySelector('[data-operator-access="required"]')
    ).not.toBeNull();
  });

  it("does not query while the date range is reversed", async () => {
    const gateway = gatewayWith();
    const container = await mount(gateway);
    const [from, to] = [
      ...container.querySelectorAll('input[type="date"]'),
    ] as HTMLInputElement[];
    await setInput(from as HTMLInputElement, "2026-09-10");
    expect(gateway.list).toHaveBeenLastCalledWith({
      decisionFrom: "2026-09-10",
    });
    const calls = gateway.list.mock.calls.length;
    await setInput(to as HTMLInputElement, "2026-09-01");
    expect(container.textContent).toContain(
      "The from date is after the to date."
    );
    expect(gateway.list.mock.calls.length).toBe(calls);
    await setInput(to as HTMLInputElement, "2026-09-30");
    expect(gateway.list).toHaveBeenLastCalledWith({
      decisionFrom: "2026-09-10",
      decisionTo: "2026-09-30",
    });
    expect(buttonNamed(container, "Clear 2 filters")).toBeDefined();
  });

  it("waits for typing to pause before it queries a date range", async () => {
    const gateway = gatewayWith();
    const container = await mount(gateway);
    const [from] = [
      ...container.querySelectorAll('input[type="date"]'),
    ] as HTMLInputElement[];
    const lists = gateway.list.mock.calls.length;
    const breakdowns = gateway.breakdown.mock.calls.length;
    // A date input reports a valid date each time the typed year completes.
    for (const value of [
      "0002-06-05",
      "0020-06-05",
      "0202-06-05",
      "2026-06-05",
    ])
      await typeInput(from as HTMLInputElement, value);
    expect(gateway.list.mock.calls.length).toBe(lists);
    expect(gateway.breakdown.mock.calls.length).toBe(breakdowns);
    expect(container.textContent).toContain("Updating…");
    await settle();
    expect(gateway.list.mock.calls.length).toBe(lists + 1);
    expect(gateway.list).toHaveBeenLastCalledWith({
      decisionFrom: "2026-06-05",
    });
    expect(gateway.breakdown.mock.calls.length).toBe(breakdowns + 1);
    expect(container.textContent).not.toContain("Updating…");
  });

  it("drops the old list when a load for newer filters fails", async () => {
    const gateway = gatewayWith();
    const container = await mount(gateway);
    gateway.list.mockRejectedValueOnce(
      Object.assign(new Error("busy"), { code: "DATABASE_CAPACITY" })
    );
    await click(checkbox(container, "ticker", "AAPL"));
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    // The rows were loaded for the old filters; they must not stand under the new ones.
    expect(container.querySelector('a[href="/agents/runs/run-1"]')).toBeNull();
    expect(
      container.querySelector('[aria-label="Model runs table"]')
    ).toBeNull();
    await click(buttonNamed(container, "Retry"));
    expect(gateway.list).toHaveBeenLastCalledWith({ ticker: ["AAPL"] });
    expect(
      container.querySelector('a[href="/agents/runs/run-1"]')
    ).not.toBeNull();
  });

  it("keeps the runs table and its sr-only labels inside a padded, positioned scroll box", async () => {
    const container = await mount(gatewayWith());
    const scroll = container.querySelector('[aria-label="Model runs table"]');
    expect(scroll?.className.split(" ")).toEqual(
      expect.arrayContaining(["relative", "overflow-x-auto"])
    );
    const cells = [...(scroll?.querySelectorAll("th, td") ?? [])];
    expect(cells.length).toBeGreaterThan(0);
    for (const cell of cells)
      expect(cell.className.split(" "), cell.textContent ?? "").toContain(
        "px-2"
      );
  });

  it("loads more runs and reports a failed page", async () => {
    const gateway = gatewayWith({
      list: vi.fn(async () => page([modelRun()], { nextCursor: "c1" })),
    });
    const container = await mount(gateway);
    gateway.list.mockResolvedValueOnce(
      page([modelRun({ id: "run-2" })], { nextCursor: "c2" })
    );
    await click(buttonNamed(container, "Load more"));
    expect(gateway.list).toHaveBeenLastCalledWith({}, "c1");
    expect(
      container.querySelector('a[href="/agents/runs/run-2"]')
    ).not.toBeNull();
    gateway.list.mockRejectedValueOnce(new Error("offline"));
    await click(buttonNamed(container, "Load more"));
    expect(container.textContent).toContain("Request failed. Retry.");
  });

  it("ignores responses that arrive after newer filters", async () => {
    const slowList = deferred<AgentModelRunListOutput>();
    const slowMore = deferred<AgentModelRunListOutput>();
    const slowBreakdown = deferred<AgentModelRunBreakdownOutput>();
    const gateway = gatewayWith({
      list: vi.fn(async () => page([modelRun()], { nextCursor: "c1" })),
    });
    const container = await mount(gateway);
    gateway.list.mockReturnValueOnce(slowMore.promise);
    await click(buttonNamed(container, "Load more"));
    gateway.list.mockReturnValueOnce(slowList.promise);
    gateway.breakdown.mockReturnValueOnce(slowBreakdown.promise);
    await click(checkbox(container, "ticker", "AAPL"));
    gateway.list.mockResolvedValueOnce(page([modelRun({ id: "run-9" })]));
    await click(checkbox(container, "framework", "tradingagents"));
    await act(async () => {
      slowMore.resolve(page([modelRun({ id: "stale-more" })]));
      slowList.resolve(page([modelRun({ id: "stale-list" })]));
      slowBreakdown.resolve(breakdownOf({ rows: [] }));
    });
    await act(flush);
    expect(
      container.querySelector('a[href="/agents/runs/run-9"]')
    ).not.toBeNull();
    expect(container.textContent).not.toContain("stale");
    expect(container.textContent).not.toContain("No runs to group.");
  });

  it("ignores a stale load failure and a stale breakdown failure", async () => {
    const slowList = deferred<AgentModelRunListOutput>();
    const slowBreakdown = deferred<AgentModelRunBreakdownOutput>();
    const gateway = gatewayWith();
    const container = await mount(gateway);
    gateway.list.mockReturnValueOnce(slowList.promise);
    gateway.breakdown.mockReturnValueOnce(slowBreakdown.promise);
    await click(checkbox(container, "ticker", "AAPL"));
    await click(checkbox(container, "ticker", "AAPL"));
    await act(async () => {
      slowList.reject(new Error("late"));
      slowBreakdown.reject(new Error("late"));
    });
    await act(flush);
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("exports the filtered runs as CSV and notes a cut export", async () => {
    const onDownload = vi.fn();
    const gateway = gatewayWith();
    const container = await mount(gateway, onDownload);
    await click(buttonNamed(container, "Export CSV"));
    expect(onDownload).toHaveBeenCalledWith(
      expect.objectContaining({ filename: "runs.csv" })
    );
    expect(container.textContent).toContain("Exported 1 run.");
    gateway.exportCsv.mockResolvedValueOnce({
      csv: "",
      filename: "runs.csv",
      rowCount: 2,
      truncated: false,
    });
    await click(buttonNamed(container, "Export CSV"));
    expect(container.textContent).toContain("Exported 2 runs.");
    gateway.exportCsv.mockResolvedValueOnce({
      csv: "",
      filename: "runs.csv",
      rowCount: 5000,
      truncated: true,
    });
    await click(buttonNamed(container, "Export CSV"));
    expect(container.textContent).toContain(
      "Exported the first 5000 runs. Narrow the filters"
    );
    gateway.exportCsv.mockRejectedValueOnce(
      Object.assign(new Error("x"), { code: "UNAUTHORIZED" })
    );
    await click(buttonNamed(container, "Export CSV"));
    expect(container.textContent).toContain("Session expired");
  });

  it("searches event text over the filters and shows highlighted snippets", async () => {
    const gateway = gatewayWith();
    const container = await mount(gateway);
    const input = container.querySelector(
      'input[type="search"]'
    ) as HTMLInputElement;
    await setInput(input, "  support ");
    const form = container.querySelector(
      'form[role="search"]'
    ) as HTMLFormElement;
    const pending = deferred<AgentModelRunSearchOutput>();
    gateway.search.mockReturnValueOnce(pending.promise);
    await act(async () => {
      form.requestSubmit();
    });
    await act(flush);
    expect(container.textContent).toContain("Searching event text…");
    await act(async () => pending.resolve({ results: [] }));
    await act(flush);
    expect(container.textContent).toContain('No run events mention "support".');
    await click(checkbox(container, "ticker", "AAPL"));
    expect(gateway.search).toHaveBeenLastCalledWith("support", {
      ticker: ["AAPL"],
    });
    expect(container.querySelector("mark")?.textContent).toBe("support");
    expect(container.textContent).toContain('1 run mentions "support"');
    expect(
      container
        .querySelector('[aria-label="Search results"] a')
        ?.getAttribute("href")
    ).toBe("/agents/runs/run-1");
    gateway.search.mockResolvedValueOnce({
      results: [
        { rank: 1, run: modelRun({ id: "a" }), snippets: [] },
        { rank: 1, run: modelRun({ id: "b" }), snippets: [] },
      ],
    });
    await click(checkbox(container, "ticker", "AAPL"));
    expect(container.textContent).toContain('2 runs mention "support"');
    gateway.search.mockRejectedValueOnce(
      Object.assign(new Error("x"), { code: "STORAGE_ERROR" })
    );
    await click(checkbox(container, "framework", "tradingagents"));
    expect(container.querySelector('[aria-label="Search results"]')).toBeNull();
    expect(container.textContent).toContain("Model run storage unavailable");
    await click(buttonNamed(container, "Clear search"));
    expect(input.value).toBe("");
    expect(container.textContent).not.toContain(
      "Model run storage unavailable"
    );
  });

  it("drops stale search answers and pauses search on a reversed date range", async () => {
    const gateway = gatewayWith();
    const container = await mount(gateway);
    const input = container.querySelector(
      'input[type="search"]'
    ) as HTMLInputElement;
    await setInput(input, "support");
    const slowOk = deferred<AgentModelRunSearchOutput>();
    const slowFail = deferred<AgentModelRunSearchOutput>();
    gateway.search
      .mockReturnValueOnce(slowOk.promise)
      .mockReturnValueOnce(slowFail.promise);
    const form = container.querySelector(
      'form[role="search"]'
    ) as HTMLFormElement;
    await act(async () => form.requestSubmit());
    await act(flush);
    await click(checkbox(container, "ticker", "AAPL"));
    await click(checkbox(container, "ticker", "AAPL"));
    await act(async () => {
      slowOk.resolve({ results: [] });
      slowFail.reject(new Error("late"));
    });
    await act(flush);
    expect(container.textContent).not.toContain("No run events mention");
    expect(container.textContent).toContain('1 run mentions "support"');
    const [from, to] = [
      ...container.querySelectorAll('input[type="date"]'),
    ] as HTMLInputElement[];
    await setInput(from as HTMLInputElement, "2026-09-10");
    await setInput(to as HTMLInputElement, "2026-09-01");
    expect(container.textContent).not.toContain("run mentions");
  });
});
