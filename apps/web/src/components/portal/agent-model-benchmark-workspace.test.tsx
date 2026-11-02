// @vitest-environment jsdom
import type {
  AgentModelBenchmarkArmOutput,
  AgentModelBenchmarkInput,
  AgentModelBenchmarkOutput,
  AgentModelRunFacetsOutput,
} from "@darkfactory/api";
import { act } from "react";
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

import type { AgentModelBenchmarkGateway } from "./agent-model-benchmark-client.ts";
import { AgentModelBenchmarkWorkspace } from "./agent-model-benchmark-workspace.tsx";

const defaultGateway = vi.hoisted(() => ({
  benchmark: async () => {
    throw Object.assign(new Error("denied"), { code: "FORBIDDEN" });
  },
  facets: async () => {
    throw Object.assign(new Error("denied"), { code: "FORBIDDEN" });
  },
}));

vi.mock("./agent-model-benchmark-client.ts", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("./agent-model-benchmark-client.ts")
  >()),
  createBrowserAgentModelBenchmarkGateway: () => defaultGateway,
}));

const testGlobal: typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean } =
  globalThis;
const roots: Root[] = [];
beforeAll(() => {
  testGlobal.IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.replaceChildren();
});
afterAll(() => {
  testGlobal.IS_REACT_ACT_ENVIRONMENT = false;
});

const facets = (
  overrides: Partial<AgentModelRunFacetsOutput> = {}
): AgentModelRunFacetsOutput => ({
  batch: [{ count: 4, value: "grid-1" }],
  flags: [],
  framework: [],
  horizonBucket: [],
  model: [
    { count: 2, value: "A" },
    { count: 2, value: "B" },
  ],
  provider: [],
  purpose: [],
  rating: [],
  servedModel: [],
  status: [],
  ticker: [{ count: 4, value: "AAPL" }],
  variant: [],
  ...overrides,
});

const arm = (
  overrides: Partial<AgentModelBenchmarkArmOutput> = {}
): AgentModelBenchmarkArmOutput => ({
  avgCostUsd: 0.25,
  baseline: null,
  cells: 2,
  extremityShare: 0.5,
  failed: 0,
  finished: 2,
  inputTokens: 1200,
  key: "A",
  llmCalls: 4,
  local: false,
  medianDurationMs: 90_000,
  outputTokens: 300,
  rated: 2,
  ratedCells: 2,
  ratingMix: { buy: 1, hold: 1, overweight: 0, sell: 0, underweight: 0 },
  rerun: { allAgreeShare: null, cells: 0, meanModalShare: null },
  runs: 2,
  servedModels: ["A-2026"],
  toolCalls: 6,
  totalCostUsd: 0.5,
  unrated: 0,
  ...overrides,
});

const result = (
  overrides: Partial<AgentModelBenchmarkOutput> = {}
): AgentModelBenchmarkOutput => ({
  armBy: "model",
  arms: [
    arm(),
    arm({
      baseline: { matchRate: 0.5, meanClosestDistance: 0.5, sharedCells: 2 },
      key: "B",
      local: true,
      rated: 0,
      ratingMix: { buy: 0, hold: 0, overweight: 0, sell: 0, underweight: 0 },
      servedModels: [],
    }),
  ],
  armsTruncated: false,
  baselineArm: null,
  cells: 2,
  matrix: {
    arms: ["A", "B"],
    rows: [
      [
        { agreeShare: 1, sharedCells: 2 },
        { agreeShare: 0.5, sharedCells: 2 },
      ],
      [
        { agreeShare: 0.5, sharedCells: 2 },
        { agreeShare: null, sharedCells: 0 },
      ],
    ],
  },
  pair: null,
  runCount: 4,
  truncated: false,
  ...overrides,
});

const pair = (
  overrides: Partial<NonNullable<AgentModelBenchmarkOutput["pair"]>> = {}
): NonNullable<AgentModelBenchmarkOutput["pair"]> => ({
  changedRating: 1,
  compared: 2,
  control: "A",
  controlArm: {
    hits: 1,
    medianDurationMs: 20_000,
    runs: 2,
    totalCostUsd: 0.5,
    totalTokens: 1500,
  },
  excludedNoBars: 0,
  excludedNoCall: 0,
  forwardDays: 5,
  losses: 0,
  sharedCells: 2,
  signTestP: 1,
  tickersOverCap: [],
  tickersWithoutBars: [],
  ties: 1,
  treatment: "B",
  treatmentArm: {
    hits: 2,
    medianDurationMs: null,
    runs: 2,
    totalCostUsd: 0,
    totalTokens: 0,
  },
  wins: 1,
  ...overrides,
});

type GatewayDouble = AgentModelBenchmarkGateway & {
  benchmark: ReturnType<typeof vi.fn>;
  facets: ReturnType<typeof vi.fn>;
};

const gatewayWith = (
  overrides: Partial<AgentModelBenchmarkGateway> = {}
): GatewayDouble =>
  ({
    benchmark: vi.fn(async (input: AgentModelBenchmarkInput) =>
      result({
        baselineArm: input.baselineArm ?? null,
        pair: input.pair === undefined ? null : pair(),
      })
    ),
    facets: vi.fn(async () => facets()),
    ...overrides,
  }) as never;

const mount = async (gateway?: AgentModelBenchmarkGateway) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(
      <AgentModelBenchmarkWorkspace
        {...(gateway === undefined ? {} : { gateway })}
      >
        <p data-extra="true">Frameworks</p>
      </AgentModelBenchmarkWorkspace>
    );
  });
  return container;
};

const select = async (container: HTMLElement, label: string, value: string) => {
  const element = Array.from(container.querySelectorAll("label")).find(
    (candidate) => candidate.textContent?.startsWith(label)
  );
  const control = element?.querySelector("select, input") as
    | HTMLSelectElement
    | HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(control),
    "value"
  )?.set;
  await act(async () => {
    setter?.call(control, value);
    control.dispatchEvent(new Event("change", { bubbles: true }));
    control.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

const lastInput = (gateway: GatewayDouble): AgentModelBenchmarkInput =>
  gateway.benchmark.mock.calls.at(-1)?.[0] as AgentModelBenchmarkInput;

describe("AgentModelBenchmarkWorkspace", () => {
  it("asks for operator access when the read is forbidden", async () => {
    const container = await mount();
    expect(
      container.querySelector('[data-operator-access="required"]')
    ).not.toBeNull();
  });

  it("shows arms, rating mix, matrix and the frameworks section", async () => {
    const gateway = gatewayWith();
    const container = await mount(gateway);
    expect(gateway.facets).toHaveBeenCalledWith({});
    expect(lastInput(gateway)).toEqual({ armBy: "model" });
    const text = container.textContent ?? "";
    expect(text).toContain("4 runs on 2 cells in 2 arms.");
    expect(text).toContain("Research only");
    expect(text).toContain("buy 1, overweight 0, hold 1");
    expect(text).toContain("no rated runs");
    expect(text).toContain("local");
    expect(text).toContain("1.5 min");
    expect(container.querySelector('a[href="/backtests"]')?.textContent).toBe(
      "Backtests"
    );
    expect(container.querySelectorAll('[data-segment="buy"]')).toHaveLength(1);
    const matrix = container.querySelector('[data-matrix="true"]');
    expect(matrix?.querySelectorAll('th[scope="col"]')).toHaveLength(2);
    expect(matrix?.textContent).toContain("50% (n=2)");
    expect(matrix?.textContent).toContain("— (n=0)");
    expect(container.querySelector('[data-baseline-table="true"]')).toBeNull();
    expect(container.querySelector('[data-pair="true"]')).toBeNull();
    expect(container.querySelector('[data-extra="true"]')).not.toBeNull();
    // Facets without values are left out of the filter list.
    expect(container.querySelector('[data-facet="model"]')).not.toBeNull();
    expect(container.querySelector('[data-facet="framework"]')).toBeNull();
  });

  it("sends the batch, facets, grouping, baseline and pair", async () => {
    const gateway = gatewayWith();
    const container = await mount(gateway);
    await select(container, "Batch", "grid-1");
    expect(lastInput(gateway)).toEqual({ armBy: "model", batch: "grid-1" });
    expect(gateway.facets).toHaveBeenLastCalledWith({ batch: "grid-1" });
    await act(async () =>
      container
        .querySelector<HTMLInputElement>('[data-facet="ticker"] input')
        ?.click()
    );
    expect(lastInput(gateway)).toMatchObject({ ticker: ["AAPL"] });
    await select(container, "Baseline arm", "A");
    expect(lastInput(gateway)).toMatchObject({ baselineArm: "A" });
    const table = container.querySelector('[data-baseline-table="true"]');
    expect(table?.textContent).toContain("Against baseline A");
    expect(table?.querySelectorAll("tbody tr")).toHaveLength(1);
    expect(table?.textContent).toContain("0.50");
    await select(container, "Paired: control", "A");
    expect(lastInput(gateway)).not.toHaveProperty("pair");
    await select(container, "Paired: treatment", "B");
    expect(lastInput(gateway)).toMatchObject({
      pair: { control: "A", treatment: "B" },
    });
    const panel = container.querySelector('[data-pair="true"]');
    expect(container.textContent).toContain("Paired comparison: A vs B");
    expect(panel?.textContent).toContain("1 of 2 shared cells changed rating.");
    expect(panel?.textContent).toContain("p = 1.0000");
    expect(panel?.textContent).toContain("Control: A");
    expect(panel?.textContent).toContain("2 of 2");
    expect(panel?.textContent).toContain("window.");
    await select(container, "Arms by", "framework");
    expect(lastInput(gateway)).toEqual({
      armBy: "framework",
      batch: "grid-1",
      ticker: ["AAPL"],
    });
    await select(container, "Decision from", "2026-09-01");
    expect(lastInput(gateway)).toMatchObject({ decisionFrom: "2026-09-01" });
    await select(container, "Decision to", "2026-09-30");
    expect(lastInput(gateway)).toMatchObject({ decisionTo: "2026-09-30" });
    const resetButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Reset")
    );
    await act(async () => resetButton?.click());
    expect(lastInput(gateway)).toEqual({ armBy: "model" });
  });

  it("refuses dates out of order without a new read", async () => {
    const gateway = gatewayWith();
    const container = await mount(gateway);
    await select(container, "Decision to", "2026-09-01");
    const calls = gateway.benchmark.mock.calls.length;
    await select(container, "Decision from", "2026-09-30");
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "The from date is after the to date."
    );
    expect(gateway.benchmark.mock.calls.length).toBe(calls);
  });

  it("says when nothing matched, and when runs, arms or bars are cut", async () => {
    const empty = await mount(
      gatewayWith({
        benchmark: vi.fn(async () =>
          result({ arms: [], matrix: { arms: [], rows: [] }, runCount: 0 })
        ),
      })
    );
    expect(empty.textContent).toContain("No runs match these filters.");
    expect(empty.textContent).toContain("agents.framework_bench");

    const cut = await mount(
      gatewayWith({
        benchmark: vi.fn(async () =>
          result({
            armsTruncated: true,
            pair: pair({
              excludedNoBars: 4,
              tickersOverCap: ["T050", "T051"],
              tickersWithoutBars: ["META"],
            }),
            truncated: true,
          })
        ),
      })
    );
    expect(cut.textContent).toContain("Only the newest 5000 runs");
    expect(cut.textContent).toContain("Only the 100 largest arms");
    expect(cut.textContent).toContain(
      "(no bars: META); bars not loaded, over the 50-ticker cap: T050, T051."
    );
  });

  it("shows an error with a retry, and keeps results while updating", async () => {
    let fail = true;
    let release: (() => void) | undefined;
    const gateway = gatewayWith({
      benchmark: vi.fn(async () => {
        if (fail)
          throw Object.assign(new Error("x"), { code: "STORAGE_ERROR" });
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return result();
      }),
    });
    const container = await mount(gateway);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Model run storage unavailable"
    );
    fail = false;
    const retry = container.querySelector<HTMLButtonElement>(
      '[role="alert"] button'
    );
    await act(async () => retry?.click());
    expect(container.textContent).toContain("Loading the benchmark");
    await act(async () => release?.());
    expect(container.textContent).toContain("4 runs on 2 cells");
    await select(container, "Batch", "grid-1");
    expect(container.textContent).toContain("Updating…");
    await act(async () => release?.());
    expect(container.textContent).not.toContain("Updating…");
  });

  it("drops a stale answer when a newer request started", async () => {
    const pending: Array<{
      resolve: (value: AgentModelBenchmarkOutput) => void;
      reject: (error: unknown) => void;
    }> = [];
    const gateway = gatewayWith({
      // Promise.withResolvers is outside the ES2023 lib of this package.
      benchmark: vi.fn(
        () =>
          new Promise<AgentModelBenchmarkOutput>((resolve, reject) => {
            pending.push({ reject, resolve });
          })
      ),
    });
    const container = await mount(gateway);
    await act(async () => pending[0]?.resolve(result()));
    // Two newer requests: the first fails late, the second succeeds late; then the stale ones land.
    await select(container, "Batch", "grid-1");
    await select(container, "Batch", "");
    await act(async () => pending[2]?.resolve(result({ runCount: 9 })));
    await act(async () => pending[1]?.reject(new Error("late")));
    expect(container.textContent).toContain("9 runs on 2 cells");
    expect(container.querySelector('[role="alert"]')).toBeNull();
    await select(container, "Batch", "grid-1");
    await select(container, "Batch", "");
    await act(async () => pending[4]?.resolve(result({ runCount: 7 })));
    await act(async () => pending[3]?.resolve(result({ runCount: 3 })));
    expect(container.textContent).toContain("7 runs on 2 cells");
  });
});
