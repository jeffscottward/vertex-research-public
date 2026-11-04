// @vitest-environment jsdom
import type {
  AgentModelRunEventOutput,
  AgentModelRunEventsOutput,
  AgentModelRunOutput,
} from "@darkfactory/api";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, it as base, beforeAll, describe, expect, vi } from "vitest";

import { AgentModelRunDetail } from "./agent-model-run-detail.tsx";
import type { AgentModelRunsGateway } from "./agent-model-runs-client.ts";

// A small page keeps the catch-up test cheap: every render then has tens of events, not 500.
const PAGE_MAX = vi.hoisted(() => 20);
vi.mock("@darkfactory/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@darkfactory/api")>()),
  AGENT_MODEL_RUN_EVENTS_PAGE_MAX: PAGE_MAX,
}));

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

const flush = async () => {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
};

// Each test gets its own harness. Every UI step goes through `step`, so the teardown can wait for
// the step in flight and stop the rest. A test that times out keeps running in the background;
// without this, its later act() calls and timer advances overlap the next test.
const createHarness = (signal: AbortSignal) => {
  const roots: Root[] = [];
  let closed = false;
  let inFlight: Promise<unknown> = Promise.resolve();
  const step = <T,>(run: () => PromiseLike<T>): Promise<T> => {
    if (closed || signal.aborted)
      return Promise.reject(new Error("The test already ended."));
    // act() returns a thenable without catch(); Promise.resolve adopts it.
    const result = Promise.resolve(run());
    inFlight = result.catch(() => undefined);
    return result;
  };
  const settle = () => step(() => act(flush));
  const harness = {
    act: (run: () => void | Promise<void>) =>
      step(() =>
        act(async () => {
          await run();
        })
      ),
    advance: async (ms: number) => {
      await step(() =>
        act(async () => {
          await vi.advanceTimersByTimeAsync(ms);
        })
      );
      await settle();
    },
    click: async (element: HTMLElement) => {
      await step(() => act(async () => element.click()));
      await settle();
    },
    close: async () => {
      closed = true;
      await inFlight;
      for (const root of roots.splice(0)) await act(async () => root.unmount());
      document.body.replaceChildren();
      if (vi.isFakeTimers()) vi.clearAllTimers();
      vi.useRealTimers();
    },
    mount: async (gateway?: AgentModelRunsGateway) => {
      // The step creates the container, so a stopped test adds nothing to the page.
      const mounted = await step(async () => {
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
        return { container, root };
      });
      await settle();
      return mounted;
    },
    settle,
    unmount: async (root: Root) => {
      // Forget the root only after it unmounted; else close() still unmounts it.
      await step(() => act(async () => root.unmount()));
      const index = roots.indexOf(root);
      if (index !== -1) roots.splice(index, 1);
    },
  };
  return harness;
};

type Harness = ReturnType<typeof createHarness>;

const it = base.extend<{ ui: Harness }>({
  ui: async ({ signal }, use) => {
    const harness = createHarness(signal);
    await use(harness);
    await harness.close();
  },
});

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

const button = (container: HTMLElement, name: string) => {
  const found = [...container.querySelectorAll("button")].find(
    (element) =>
      element.textContent?.includes(name) ||
      element.getAttribute("aria-label") === name
  );
  if (found === undefined) throw new Error(`No button ${name}`);
  return found;
};

const currentSeq = (container: HTMLElement) =>
  container.querySelector('[aria-current="step"]')?.getAttribute("data-seq");

describe("AgentModelRunDetail", () => {
  it("shows every run field, the error text and a link back", async ({
    ui,
  }) => {
    const get = vi.fn(async () => page([], true, modelRun()));
    const { container } = await ui.mount(gatewayWith({ get }));
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

  it("shows defaults for a sparse run", async ({ ui }) => {
    const { container } = await ui.mount(
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

  it("replays a finished run with play, steps, the slider and speed", async ({
    ui,
  }) => {
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
    const { container } = await ui.mount(
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
    await ui.click(button(container, "Play"));
    expect(currentSeq(container)).toBe("0");
    expect(container.querySelector('[data-phase="reading"]')).not.toBeNull();
    await ui.advance(1000);
    expect(currentSeq(container)).toBe("1");
    await ui.click(button(container, "4x"));
    expect(button(container, "4x").getAttribute("aria-pressed")).toBe("true");
    await ui.advance(250);
    expect(currentSeq(container)).toBe("2");
    expect(
      container.querySelector('[data-phase="thinking"]')?.textContent
    ).toContain("RSI is oversold near support.");
    await ui.click(button(container, "Pause"));
    await ui.advance(2000);
    expect(currentSeq(container)).toBe("2");
    await ui.click(button(container, "Step back"));
    expect(currentSeq(container)).toBe("1");
    await ui.click(button(container, "Step forward"));
    expect(currentSeq(container)).toBe("2");
    const slider = container.querySelector(
      'input[type="range"]'
    ) as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value"
    )?.set;
    await ui.act(() => {
      setter?.call(slider, "0");
      slider.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await ui.settle();
    expect(currentSeq(container)).toBe("0");
    expect(container.textContent).toContain("Tool call:");
    await ui.click(button(container, "Play"));
    await ui.advance(5000);
    expect(currentSeq(container)).toBe("3");
    const show = button(container, "Show text");
    await ui.click(show);
    expect(container.querySelector("li pre")?.textContent).toBe(
      "RSI is oversold near support."
    );
    expect(show.getAttribute("aria-expanded")).toBe("true");
    await ui.click(button(container, "Hide text"));
    expect(container.querySelector("li pre")).toBeNull();
  });

  it("wraps long unbroken model text instead of widening the page", async ({
    ui,
  }) => {
    const long = "x".repeat(5000);
    const { container } = await ui.mount(
      gatewayWith({
        get: async () =>
          page(
            [event(0, { body: long, kind: "tool_result", title: long })],
            true,
            modelRun({ error: long })
          ),
      })
    );
    await ui.click(button(container, "Show text"));
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

  it("polls a live run every 2 seconds, follows new events and stops when done", async ({
    ui,
  }) => {
    vi.useFakeTimers();
    const events = vi
      .fn()
      .mockResolvedValueOnce(page([event(1), event(2)], false))
      .mockResolvedValueOnce(page([], false))
      .mockResolvedValueOnce(page([event(3)], true));
    const { container } = await ui.mount(
      gatewayWith({ events, get: async () => page([event(0)], false) })
    );
    expect(container.querySelector('[data-live="true"]')).not.toBeNull();
    expect(button(container, "Pause")).toBeDefined();
    expect(events).not.toHaveBeenCalled();
    await ui.advance(2000);
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
    await ui.advance(2000);
    expect(events).toHaveBeenLastCalledWith("run-1", 2);
    const scrollTo = async (top: number) => {
      await ui.act(() => {
        timeline.scrollTop = top;
        timeline.dispatchEvent(new Event("scroll"));
      });
      await ui.settle();
    };
    // Near the bottom the view keeps following.
    await scrollTo(600);
    expect(button(container, "Pause")).toBeDefined();
    // The reader scrolls up: following stops, so new events no longer move the position.
    await scrollTo(0);
    expect(button(container, "Follow")).toBeDefined();
    await scrollTo(10);
    expect(button(container, "Follow")).toBeDefined();
    await ui.advance(2000);
    expect(container.querySelector('[data-live="true"]')).toBeNull();
    expect(currentSeq(container)).toBe("2");
    expect(container.textContent).toContain("Event 3 of 4");
    await ui.advance(10_000);
    expect(events).toHaveBeenCalledTimes(3);
  });

  it("catches up after a full page, retries failed polls 3 times and resumes", async ({
    ui,
  }) => {
    vi.useFakeTimers();
    const full = Array.from({ length: PAGE_MAX }, (_, index) =>
      event(index + 1)
    );
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
    const { container } = await ui.mount(
      gatewayWith({
        events,
        get: async () => page([event(0)], false, finished),
      })
    );
    expect(container.textContent).toContain(
      "Finished; checking for late events…"
    );
    await ui.advance(2000);
    expect(container.textContent).toContain(
      `Event ${PAGE_MAX + 1} of ${PAGE_MAX + 1}`
    );
    // A full page is followed at once; a failed poll is tried again after 4 s.
    await ui.advance(10);
    expect(events).toHaveBeenCalledTimes(2);
    await ui.advance(4000);
    expect(events).toHaveBeenCalledTimes(3);
    // A finished run is polled every 10 s until the server says done.
    await ui.advance(9000);
    expect(events).toHaveBeenCalledTimes(3);
    await ui.advance(1000);
    expect(events).toHaveBeenCalledTimes(4);
    await ui.advance(4000);
    await ui.advance(8000);
    expect(events).toHaveBeenCalledTimes(6);
    expect(container.textContent).toContain("Live updates stopped");
    await ui.advance(30_000);
    expect(events).toHaveBeenCalledTimes(6);
    await ui.click(button(container, "Resume"));
    await ui.advance(2000);
    expect(events).toHaveBeenCalledTimes(7);
    expect(container.textContent).not.toContain("Live updates stopped");
  });

  it("explains an empty live run and drops answers that arrive after unmount", async ({
    ui,
  }) => {
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
    const first = await ui.mount(
      gatewayWith({ events, get: async () => page([], false) })
    );
    expect(first.container.textContent).toContain("No events yet.");
    await ui.advance(2000);
    await ui.unmount(first.root);
    await ui.act(() => release(page([event(0)], false)));
    const second = await ui.mount(
      gatewayWith({ events, get: async () => page([], false) })
    );
    await ui.advance(2000);
    await ui.unmount(second.root);
    await ui.act(() => fail(new Error("late")));
    expect(events).toHaveBeenCalledTimes(2);
  });

  it("shows loading, then a failure with retry", async ({ ui }) => {
    const get = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error("x"), { code: "NOT_FOUND" })
      )
      .mockResolvedValueOnce(page([], true, modelRun()));
    const { container } = await ui.mount(gatewayWith({ get }));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "does not exist"
    );
    await ui.click(button(container, "Retry"));
    expect(container.querySelector("h1")?.textContent).toContain("AAPL");
  });

  it("explains operator access for a forbidden read", async ({ ui }) => {
    const { container } = await ui.mount();
    expect(
      container.querySelector('[data-operator-access="required"]')
    ).not.toBeNull();
    expect(container.querySelector("h1")?.textContent).toBe("Model run");
  });

  it("renders a skeleton while loading", async ({ ui }) => {
    const { container } = await ui.mount(
      gatewayWith({ get: () => new Promise(() => undefined) })
    );
    expect(container.textContent).toContain("Loading the model run");
  });
});
