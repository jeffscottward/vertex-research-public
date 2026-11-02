// @vitest-environment jsdom
import type {
  AgentModelRunEventOutput,
  AgentModelRunEventsOutput,
  AgentModelRunOutput,
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

import { AgentModelRunDetail } from "./agent-model-run-detail.tsx";
import type { AgentModelRunsGateway } from "./agent-model-runs-client.ts";

const defaultGateway = vi.hoisted(() => ({
  breakdown: async () => ({ groupBy: "model", rows: [] }),
  events: async () => {
    throw new Error("unused");
  },
  exportCsv: async () => ({
    csv: "",
    filename: "x.csv",
    rowCount: 0,
    truncated: false,
  }),
  get: async () => {
    throw Object.assign(new Error("denied"), { code: "FORBIDDEN" });
  },
  list: async () => {
    throw new Error("unused");
  },
  search: async () => ({ results: [] }),
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
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.useRealTimers();
});

const flush = async () => {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
};

const at = new Date("2026-10-01T12:00:00.000Z");
const modelRun = (
  overrides: Partial<AgentModelRunOutput> = {}
): AgentModelRunOutput => ({
  analysts: ["market", "news"],
  batch: "grid-1",
  costUsd: 0.25,
  createdAt: at,
  dataSource: "yfinance",
  decisionDate: "2026-09-01",
  durationMs: 1000,
  entryPrice: 190,
  error: "parse failed: no rating line",
  finishedAt: at,
  flags: ["parse_failed"],
  framework: "tradingagents",
  frameworkVersion: "0.2.0",
  horizon: "2-4 weeks",
  horizonBucket: "weeks",
  id: "run-1",
  inputTokens: 1000,
  llmCalls: 4,
  memory: true,
  model: "gpt-4o-mini",
  modelsServed: [],
  outputTokens: 500,
  provider: "openai",
  purpose: "benchmark",
  rating: null,
  ratingSource: "missing",
  runKey: "key-1",
  startedAt: at,
  status: "failed",
  stopPrice: null,
  targetPrice: null,
  taskId: null,
  ticker: "AAPL",
  toolCalls: 3,
  updatedAt: at,
  variant: "no-memory",
  ...overrides,
});

const event = (
  seq: number,
  overrides: Partial<AgentModelRunEventOutput> = {}
): AgentModelRunEventOutput => ({
  agent: "Market Analyst",
  at,
  body: null,
  costUsd: null,
  durationMs: null,
  id: `e-${seq}`,
  inputTokens: null,
  kind: "reasoning",
  model: null,
  outputTokens: null,
  runId: "run-1",
  seq,
  title: `event ${seq}`,
  toolName: null,
  ...overrides,
});

const page = (
  events: AgentModelRunEventOutput[],
  done: boolean,
  run: AgentModelRunOutput = modelRun({
    status: done ? "succeeded" : "running",
  })
): AgentModelRunEventsOutput => ({
  done,
  events,
  nextSeq: events.at(-1)?.seq ?? -1,
  run,
});

const gatewayWith = (
  overrides: Partial<AgentModelRunsGateway>
): AgentModelRunsGateway => ({
  breakdown: vi.fn(),
  events: vi.fn(),
  exportCsv: vi.fn(),
  get: vi.fn(),
  list: vi.fn(),
  search: vi.fn(),
  ...overrides,
});

const mount = async (gateway?: AgentModelRunsGateway) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(
      <AgentModelRunDetail
        runId="run-1"
        {...(gateway === undefined ? {} : { gateway })}
      />
    );
  });
  await act(flush);
  return { container, root };
};

const button = (container: HTMLElement, name: string) => {
  const found = [...container.querySelectorAll("button")].find(
    (element) =>
      element.textContent?.includes(name) ||
      element.getAttribute("aria-label") === name
  );
  if (found === undefined) throw new Error(`No button ${name}`);
  return found;
};

const click = async (element: HTMLElement) => {
  await act(async () => element.click());
  await act(flush);
};

const advance = async (ms: number) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
  await act(flush);
};

const currentSeq = (container: HTMLElement) =>
  container.querySelector('[aria-current="step"]')?.getAttribute("data-seq");

describe("AgentModelRunDetail", () => {
  it("shows every run field, the error text and a link back", async () => {
    const get = vi.fn(async () => page([], true, modelRun()));
    const { container } = await mount(gatewayWith({ get }));
    expect(get).toHaveBeenCalledWith("run-1");
    expect(container.querySelector("h1")?.textContent).toBe(
      "AAPL · 2026-09-01 · tradingagents"
    );
    expect(container.querySelector('a[href="/agents"]')).not.toBeNull();
    for (const text of [
      "Research only. Agent ratings never place orders.",
      "as requested",
      "Unrated",
      "190 / — / —",
      "market, news",
      "no-memory",
      "grid-1",
      "yfinance",
      "parse failed: no rating line",
      "parse_failed",
      "This run recorded no events.",
    ])
      expect(container.textContent).toContain(text);
    expect(container.textContent).toContain("Memoryon");
  });

  it("shows defaults for a sparse run", async () => {
    const { container } = await mount(
      gatewayWith({
        get: async () =>
          page(
            [],
            true,
            modelRun({
              analysts: [],
              batch: null,
              dataSource: null,
              error: null,
              flags: [],
              horizon: null,
              memory: false,
              modelsServed: [
                { requested: "gpt-4o-mini", served: "gpt-4o-mini-2024" },
              ],
              variant: null,
            })
          ),
      })
    );
    expect(container.textContent).toContain("gpt-4o-mini-2024");
    expect(container.textContent).toContain("Memoryoff");
    expect(container.querySelector("pre")).toBeNull();
    expect(container.querySelector('[aria-label="Flags"]')).toBeNull();
  });

  it("replays a finished run with play, steps, the slider and speed", async () => {
    vi.useFakeTimers();
    const events = [
      event(0, {
        kind: "tool_call",
        title: "get_stock_data",
        toolName: "get_stock_data",
      }),
      event(1, { kind: "tool_result", title: "bars" }),
      event(2, { body: "RSI is oversold near support.", kind: "reasoning" }),
      event(3, { agent: "Trader", body: "Overweight AAPL.", kind: "decision" }),
    ];
    const { container } = await mount(
      gatewayWith({ get: async () => page(events, true) })
    );
    expect(container.querySelector('[data-live="true"]')).toBeNull();
    expect(currentSeq(container)).toBe("3");
    expect(container.textContent).toContain("Event 4 of 4");
    expect(
      [...container.querySelectorAll("[data-phase]")].map((card) =>
        card.getAttribute("data-phase")
      )
    ).toEqual(["done", "done"]);
    await click(button(container, "Play"));
    expect(currentSeq(container)).toBe("0");
    expect(container.querySelector('[data-phase="reading"]')).not.toBeNull();
    await advance(1000);
    expect(currentSeq(container)).toBe("1");
    await click(button(container, "4x"));
    expect(button(container, "4x").getAttribute("aria-pressed")).toBe("true");
    await advance(250);
    expect(currentSeq(container)).toBe("2");
    expect(
      container.querySelector('[data-phase="thinking"]')?.textContent
    ).toContain("RSI is oversold near support.");
    await click(button(container, "Pause"));
    await advance(2000);
    expect(currentSeq(container)).toBe("2");
    await click(button(container, "Step back"));
    expect(currentSeq(container)).toBe("1");
    await click(button(container, "Step forward"));
    expect(currentSeq(container)).toBe("2");
    const slider = container.querySelector(
      'input[type="range"]'
    ) as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value"
    )?.set;
    await act(async () => {
      setter?.call(slider, "0");
      slider.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(flush);
    expect(currentSeq(container)).toBe("0");
    expect(container.textContent).toContain("Tool call:");
    await click(button(container, "Play"));
    await advance(5000);
    expect(currentSeq(container)).toBe("3");
    const show = button(container, "Show text");
    await click(show);
    expect(container.querySelector("li pre")?.textContent).toBe(
      "RSI is oversold near support."
    );
    expect(show.getAttribute("aria-expanded")).toBe("true");
    await click(button(container, "Hide text"));
    expect(container.querySelector("li pre")).toBeNull();
  });

  it("wraps long unbroken model text instead of widening the page", async () => {
    const long = "x".repeat(5000);
    const { container } = await mount(
      gatewayWith({
        get: async () =>
          page(
            [event(0, { body: long, kind: "tool_result", title: long })],
            true,
            modelRun({ error: long })
          ),
      })
    );
    await click(button(container, "Show text"));
    const classes = (selector: string) =>
      container.querySelector(selector)?.className.split(" ") ?? [];
    // overflow-wrap: anywhere lowers the min-content width; break-word does not.
    for (const selector of [
      "[data-phase] p.line-clamp-3",
      "li[data-seq] span.min-w-0",
      "li[data-seq] pre",
      "pre.border",
    ])
      expect(classes(selector), selector).toContain("[overflow-wrap:anywhere]");
    // Grid tracks below sm are one column; cards may shrink below their text.
    expect(classes('[aria-label="Agents"]')).toContain("grid-cols-1");
    expect(classes("[data-phase]")).toContain("min-w-0");
  });

  it("polls a live run every 2 seconds, follows new events and stops when done", async () => {
    vi.useFakeTimers();
    const events = vi
      .fn()
      .mockResolvedValueOnce(page([event(1), event(2)], false))
      .mockResolvedValueOnce(page([], false))
      .mockResolvedValueOnce(page([event(3)], true));
    const { container } = await mount(
      gatewayWith({ events, get: async () => page([event(0)], false) })
    );
    expect(container.querySelector('[data-live="true"]')).not.toBeNull();
    expect(button(container, "Pause")).toBeDefined();
    expect(events).not.toHaveBeenCalled();
    await advance(2000);
    expect(events).toHaveBeenLastCalledWith("run-1", 0);
    expect(currentSeq(container)).toBe("2");
    const timeline = container.querySelector("ol") as HTMLOListElement;
    Object.defineProperty(timeline, "scrollHeight", {
      configurable: true,
      value: 900,
    });
    Object.defineProperty(timeline, "clientHeight", {
      configurable: true,
      value: 300,
    });
    await advance(2000);
    expect(events).toHaveBeenLastCalledWith("run-1", 2);
    const scrollTo = async (top: number) => {
      await act(async () => {
        timeline.scrollTop = top;
        timeline.dispatchEvent(new Event("scroll"));
      });
      await act(flush);
    };
    // Near the bottom the view keeps following.
    await scrollTo(600);
    expect(button(container, "Pause")).toBeDefined();
    // The reader scrolls up: following stops, so new events no longer move the position.
    await scrollTo(0);
    expect(button(container, "Follow")).toBeDefined();
    await scrollTo(10);
    expect(button(container, "Follow")).toBeDefined();
    await advance(2000);
    expect(container.querySelector('[data-live="true"]')).toBeNull();
    expect(currentSeq(container)).toBe("2");
    expect(container.textContent).toContain("Event 3 of 4");
    await advance(10_000);
    expect(events).toHaveBeenCalledTimes(3);
  });

  it("catches up after a full page, retries failed polls 3 times and resumes", async () => {
    vi.useFakeTimers();
    const full = Array.from({ length: 500 }, (_, index) => event(index + 1));
    const failure = Object.assign(new Error("x"), { code: "STORAGE_ERROR" });
    const finished = modelRun({ status: "succeeded" });
    const events = vi
      .fn()
      .mockResolvedValueOnce(page(full, false, finished))
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(page([], false, finished))
      .mockRejectedValueOnce(failure)
      .mockRejectedValueOnce(failure)
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(page([], false, finished));
    const { container } = await mount(
      gatewayWith({
        events,
        get: async () => page([event(0)], false, finished),
      })
    );
    expect(container.textContent).toContain(
      "Finished; checking for late events…"
    );
    await advance(2000);
    expect(container.textContent).toContain("Event 501 of 501");
    // A full page is followed at once; a failed poll is tried again after 4 s.
    await advance(10);
    expect(events).toHaveBeenCalledTimes(2);
    await advance(4000);
    expect(events).toHaveBeenCalledTimes(3);
    // A finished run is polled every 10 s until the server says done.
    await advance(9000);
    expect(events).toHaveBeenCalledTimes(3);
    await advance(1000);
    expect(events).toHaveBeenCalledTimes(4);
    await advance(4000);
    await advance(8000);
    expect(events).toHaveBeenCalledTimes(6);
    expect(container.textContent).toContain("Live updates stopped");
    await advance(30_000);
    expect(events).toHaveBeenCalledTimes(6);
    await click(button(container, "Resume"));
    await advance(2000);
    expect(events).toHaveBeenCalledTimes(7);
    expect(container.textContent).not.toContain("Live updates stopped");
  });

  it("explains an empty live run and drops answers that arrive after unmount", async () => {
    vi.useFakeTimers();
    let release: (value: AgentModelRunEventsOutput) => void = () => undefined;
    let fail: (error: unknown) => void = () => undefined;
    const events = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<AgentModelRunEventsOutput>((resolve) => {
            release = resolve;
          })
      )
      .mockImplementationOnce(
        () =>
          new Promise<AgentModelRunEventsOutput>((_resolve, reject) => {
            fail = reject;
          })
      );
    const first = await mount(
      gatewayWith({ events, get: async () => page([], false) })
    );
    expect(first.container.textContent).toContain("No events yet.");
    await advance(2000);
    await act(async () => first.root.unmount());
    await act(async () => release(page([event(0)], false)));
    const second = await mount(
      gatewayWith({ events, get: async () => page([], false) })
    );
    await advance(2000);
    await act(async () => second.root.unmount());
    await act(async () => fail(new Error("late")));
    roots.splice(0);
    expect(events).toHaveBeenCalledTimes(2);
  });

  it("shows loading, then a failure with retry", async () => {
    const get = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error("x"), { code: "NOT_FOUND" })
      )
      .mockResolvedValueOnce(page([], true, modelRun()));
    const { container } = await mount(gatewayWith({ get }));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "does not exist"
    );
    await click(button(container, "Retry"));
    expect(container.querySelector("h1")?.textContent).toContain("AAPL");
  });

  it("explains operator access for a forbidden read", async () => {
    const { container } = await mount();
    expect(
      container.querySelector('[data-operator-access="required"]')
    ).not.toBeNull();
    expect(container.querySelector("h1")?.textContent).toBe("Model run");
  });

  it("renders a skeleton while loading", async () => {
    const { container } = await mount(
      gatewayWith({ get: () => new Promise(() => undefined) })
    );
    expect(container.textContent).toContain("Loading the model run");
  });
});
