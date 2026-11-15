// @vitest-environment jsdom
import type {
  AssistantActionOutput,
  AssistantMessageOutput,
  AssistantSendEvent,
  AssistantSendOutput,
  AssistantStatusOutput,
  AssistantThreadOutput,
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
  ASSISTANT_STARTER_PROMPTS,
  actionResultPreview,
  createBrowserAssistantGateway,
  describeAssistantFailure,
  readAssistantTurn,
  threadTitleFrom,
  type AssistantGateway,
} from "./assistant-client.ts";
import {
  AssistantWorkspace,
  applyLiveEvent,
  EMPTY_LIVE_TURN,
  isNearTranscriptEnd,
  TRANSCRIPT_FOLLOW_SLACK_PX,
  type LiveTurn,
} from "./assistant-workspace.tsx";

const testGlobal = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
const previousAct = testGlobal.IS_REACT_ACT_ENVIRONMENT;
beforeAll(() => {
  testGlobal.IS_REACT_ACT_ENVIRONMENT = true;
  return;
});
afterAll(() => {
  if (previousAct === undefined) {
    delete testGlobal.IS_REACT_ACT_ENVIRONMENT;
  } else testGlobal.IS_REACT_ACT_ENVIRONMENT = previousAct;
  return;
});
const roots: Root[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.replaceChildren();
  return;
});

const flush = async () => ({
  ...(await (async () => {
    const results = {};
    for (let i = 0; i < 20; i += 1)
      Object.assign(results, await Promise.resolve());
    return results;
  })()),
});
const at = new Date("2026-01-02T03:04:05.000Z");

const mount = async (element: ReactElement) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(element);
    return await flush();
  });
  return container;
};

const button = (
  label: string,
  scope: ParentNode = document
): HTMLButtonElement => {
  const found = [...scope.querySelectorAll("button")].find((node) => {
    return (
      node.getAttribute("aria-label") === label ||
      node.textContent?.trim() === label
    );
  });
  if (found === undefined) throw new Error(`Missing button ${label}`);
  return found;
};

const click = async (element: HTMLElement) => {
  return await act(async () => {
    element.click();
    return await flush();
  });
};

const status = (
  overrides: Partial<AssistantStatusOutput> = {}
): AssistantStatusOutput => ({
  configured: true,
  model: "anthropic/claude-sonnet-4.5",
  maxSteps: 8,
  usage: {
    day: "2026-01-02",
    requests: 3,
    inputTokens: 1200,
    outputTokens: 300,
    requestLimit: 200,
    tokenLimit: 500_000,
  },
  ...overrides,
});

const thread = (
  id = "thread-1",
  title = "Summarize my latest backtests"
): AssistantThreadOutput => {
  return { id, title, createdAt: at, updatedAt: at };
};

const message = (
  overrides: Partial<AssistantMessageOutput>
): AssistantMessageOutput => ({
  id: "m-1",
  threadId: "thread-1",
  role: "user",
  mode: "plan",
  content: "hi",
  toolCalls: [],
  model: null,
  inputTokens: 0,
  outputTokens: 0,
  createdAt: at,
  ...overrides,
});

const sendOutput = (
  mode: "plan" | "act",
  content: string
): AssistantSendOutput => {
  const trace = [
    {
      tool: mode === "plan" ? "backtests_list" : "tasks_create",
      args: '{"limit":5}',
      ok: true,
      error: null,
      durationMs: 42,
    },
  ];
  return {
    thread: thread(),
    userMessage: message({
      id: "m-1",
      content: ASSISTANT_STARTER_PROMPTS[0]!,
      mode,
    }),
    reply: message({
      id: "m-2",
      role: "assistant",
      content: `${content}\nSecond line`,
      mode,
      toolCalls: trace,
      model: "anthropic/claude-sonnet-4.5",
      inputTokens: 2200,
      outputTokens: 110,
    }),
    trace,
    stopReason: "completed",
    steps: 1,
    actions: [],
    usage: {
      day: "2026-01-02",
      requests: 5,
      inputTokens: 3400,
      outputTokens: 410,
      requestLimit: 200,
      tokenLimit: 500_000,
    },
  };
};

const fakeGateway = (
  overrides: Partial<{
    [K in keyof AssistantGateway]: ReturnType<typeof vi.fn>;
  }> = {}
) => {
  return {
    list: vi.fn(async () => ({ threads: [], status: status() })),
    create: vi.fn(async (title?: string) =>
      thread("thread-1", title ?? "New thread")
    ),
    get: vi.fn(async () => ({ thread: thread(), messages: [], actions: [] })),
    send: vi.fn(async (input: { mode: "plan" | "act" }) =>
      sendOutput(input.mode, "Two backtests on ES.")
    ),
    decide: vi.fn(async () => {
      throw new Error("unexpected decide");
    }),
    ...overrides,
  } as unknown as AssistantGateway & {
    [K in keyof AssistantGateway]: ReturnType<typeof vi.fn>;
  };
};

describe("AssistantWorkspace", () => {
  it("defaults to Plan mode and shows starter prompts and the budget meter", async () => {
    const gateway = fakeGateway();
    const container = await mount(<AssistantWorkspace gateway={gateway} />);
    expect(button("Plan").getAttribute("aria-checked")).toBe("true");
    expect(button("Act").getAttribute("aria-checked")).toBe("false");
    expect(container.querySelector("[data-mode-help]")?.textContent).toMatch(
      /read-only/
    );
    for (const prompt of [
      "Summarize my latest backtests",
      "Which strategies have no backtests?",
      "Show ES daily bars stats for the last year",
    ]) {
      expect(button(prompt).disabled).toBe(false);
    }
    const meter = container.querySelector("[data-budget-meter]")!;
    expect(meter.textContent).toContain("Requests 3 / 200");
    return expect(meter.textContent).toContain("Tokens 1.5k / 500k");
  });

  it("creates a thread from a starter prompt, sends in Plan mode and renders the reply with tool cards", async () => {
    const gateway = fakeGateway();
    const container = await mount(<AssistantWorkspace gateway={gateway} />);
    await click(button("Summarize my latest backtests"));
    expect(gateway.create).toHaveBeenCalledWith(
      "Summarize my latest backtests"
    );
    expect(gateway.send).toHaveBeenCalledWith(
      {
        threadId: "thread-1",
        message: "Summarize my latest backtests",
        mode: "plan",
      },
      expect.any(AbortSignal),
      expect.any(Function)
    );
    const reply = container.querySelector('[data-message-role="assistant"]')!;
    expect(reply.querySelector("[data-message-content]")?.textContent).toBe(
      "Two backtests on ES.\nSecond line"
    );
    const card = reply.querySelector<HTMLDetailsElement>(
      'details[data-tool-call="backtests_list"]'
    )!;
    expect(card.open).toBe(false);
    expect(card.querySelector("summary")?.textContent).toContain("ok");
    expect(card.textContent).toContain('{"limit":5}');
    expect(
      container.querySelector("[data-budget-meter]")?.textContent
    ).toContain("Requests 5 / 200");
    return expect(
      container.querySelector('[data-thread-id="thread-1"]')
    ).not.toBeNull();
  });

  it("sends in Act mode after switching the toggle", async () => {
    const gateway = fakeGateway();
    const container = await mount(<AssistantWorkspace gateway={gateway} />);
    await click(button("Act"));
    expect(button("Act").getAttribute("aria-checked")).toBe("true");
    expect(container.querySelector("[data-mode-help]")?.textContent).toMatch(
      /Never deployments or orders/
    );
    await click(button("Which strategies have no backtests?"));
    return expect(gateway.send).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "act" }),
      expect.any(AbortSignal),
      expect.any(Function)
    );
  });

  it("opens an existing thread and shows its transcript", async () => {
    const gateway = fakeGateway({
      list: vi.fn(async () => ({
        threads: [thread("thread-9", "Earlier")],
        status: status(),
      })),
      get: vi.fn(async () => ({
        thread: thread("thread-9", "Earlier"),
        messages: [
          message({ threadId: "thread-9", content: "Earlier question" }),
          message({
            id: "m-2",
            threadId: "thread-9",
            role: "assistant",
            content: "Earlier answer",
          }),
        ],
        actions: [],
      })),
    });
    const container = await mount(<AssistantWorkspace gateway={gateway} />);
    await click(
      container.querySelector<HTMLButtonElement>('[data-thread-id="thread-9"]')!
    );
    expect(gateway.get).toHaveBeenCalledWith("thread-9");
    return expect(
      [...container.querySelectorAll("[data-message-content]")].map(
        (node) => node.textContent
      )
    ).toEqual(["Earlier question", "Earlier answer"]);
  });

  it("shows a send failure and reloads what the server kept", async () => {
    const gateway = fakeGateway({
      send: vi.fn(async () => {
        throw Object.assign(new Error("x"), {
          code: "BUDGET_EXCEEDED",
          message: "Daily assistant budget used up",
        });
      }),
    });
    const container = await mount(<AssistantWorkspace gateway={gateway} />);
    await click(button("Summarize my latest backtests"));
    expect(container.querySelector("[data-send-error]")?.textContent).toBe(
      "Daily assistant budget used up"
    );
    expect(gateway.get).toHaveBeenCalledWith("thread-1");
    return expect(gateway.list).toHaveBeenCalledTimes(2);
  });

  it("explains a missing model key and disables sending", async () => {
    const gateway = fakeGateway({
      list: vi.fn(async () => ({
        threads: [],
        status: status({ configured: false }),
      })),
    });
    const container = await mount(<AssistantWorkspace gateway={gateway} />);
    expect(
      container.querySelector("[data-assistant-unconfigured]")?.textContent
    ).toMatch(/OPENROUTER_API_KEY/);
    expect(button("Summarize my latest backtests").disabled).toBe(true);
    return expect(
      container.querySelector<HTMLTextAreaElement>("#assistant-message")!
        .disabled
    ).toBe(true);
  });

  it("shows operator access required on FORBIDDEN", async () => {
    const gateway = fakeGateway({
      list: vi.fn(async () => {
        throw Object.assign(new Error("x"), { code: "FORBIDDEN" });
      }),
    });
    const container = await mount(<AssistantWorkspace gateway={gateway} />);
    return expect(
      container.querySelector('[data-operator-access="required"]')
    ).not.toBeNull();
  });
});

const action = (
  overrides: Partial<AssistantActionOutput> = {}
): AssistantActionOutput => ({
  id: "action-1",
  threadId: "thread-1",
  messageId: "m-2",
  tool: "backtest_runs_submit",
  summary:
    'Run a backtest of definition "Fictional SMA" on TEST 1d, 2020-01-01 to 2024-12-31',
  args: { symbol: "TEST" },
  status: "pending",
  result: null,
  error: null,
  createdAt: at,
  decidedAt: null,
  finishedAt: null,
  ...overrides,
});

const withCards = (actions: AssistantActionOutput[]) =>
  fakeGateway({
    send: vi.fn(async () => ({
      ...sendOutput("act", "One card waits for approval."),
      actions,
    })),
  });

const card = (container: ParentNode, tool = "backtest_runs_submit") =>
  container.querySelector<HTMLElement>(`[data-confirm-card="${tool}"]`)!;

// jsdom has no layout: give the message list fixed metrics and a scroll position the test moves.
const layOut = (
  element: HTMLElement,
  scrollHeight: number,
  clientHeight: number
) => {
  let top = 0;
  Object.defineProperty(element, "scrollHeight", {
    configurable: true,
    get: () => scrollHeight,
  });
  Object.defineProperty(element, "clientHeight", {
    configurable: true,
    get: () => clientHeight,
  });
  Object.defineProperty(element, "scrollTop", {
    configurable: true,
    get: () => top,
    set: (value: number) => {
      top = value;
    },
  });
  return {
    top: () => top,
    scrollTo: async (value: number) => {
      top = value;
      return await act(async () => {
        element.dispatchEvent(new Event("scroll"));
        return await flush();
      });
    },
  };
};

describe("isNearTranscriptEnd", () => {
  it("follows at the end and within the slack, not after scrolling up", () => {
    const metrics = { clientHeight: 300, scrollHeight: 1000 };
    expect(isNearTranscriptEnd({ ...metrics, scrollTop: 700 })).toBe(true);
    expect(
      isNearTranscriptEnd({
        ...metrics,
        scrollTop: 700 - TRANSCRIPT_FOLLOW_SLACK_PX,
      })
    ).toBe(true);
    expect(
      isNearTranscriptEnd({
        ...metrics,
        scrollTop: 699 - TRANSCRIPT_FOLLOW_SLACK_PX,
      })
    ).toBe(false);
    // Content shorter than the list is always at its end.
    expect(
      isNearTranscriptEnd({
        clientHeight: 500,
        scrollHeight: 200,
        scrollTop: 0,
      })
    ).toBe(true);
    return expect(
      isNearTranscriptEnd({ ...metrics, scrollTop: 600 }, 100)
    ).toBe(true);
  });
});

describe("AssistantWorkspace auto-scroll", () => {
  it("scrolls only the message list, and follows live text only near its end", async () => {
    let emit: (event: AssistantSendEvent) => void = () => undefined;
    const send = vi.fn(
      (
        _input: unknown,
        _signal?: AbortSignal,
        onEvent?: (event: AssistantSendEvent) => void
      ) =>
        new Promise<AssistantSendOutput>(() => {
          emit = (event) => onEvent?.(event);
        })
    );
    const container = await mount(
      <AssistantWorkspace gateway={fakeGateway({ send })} />
    );
    const list = container.querySelector<HTMLElement>(
      "[data-transcript-scroll]"
    );
    if (list === null) throw new Error("Missing message list");
    expect(list.getAttribute("role")).toBe("region");
    expect(list.tabIndex).toBe(0);
    const metrics = layOut(list, 1000, 300);
    // Nothing to show yet: no scroll.
    expect(metrics.top()).toBe(0);
    await click(button("Summarize my latest backtests"));
    expect(metrics.top()).toBe(1000);
    // The composer and Stop sit outside the scroll area.
    const stop = button("Stop");
    expect(list.contains(stop)).toBe(false);
    expect(
      container.querySelector("[data-assistant-composer]")?.contains(stop)
    ).toBe(true);
    expect(list.querySelector('[aria-label="Transcript"]')).not.toBeNull();

    const text = async (delta: string) =>
      await act(async () => {
        emit({ delta, modelCall: 1, type: "text" });
        return await flush();
      });
    // At the end: new text keeps the list at its end.
    await metrics.scrollTo(700);
    await text("First words");
    expect(metrics.top()).toBe(1000);
    // Scrolled up to read: new text leaves the position alone.
    await metrics.scrollTo(100);
    await text(" and more");
    expect(metrics.top()).toBe(100);
    // Back within the slack of the end: following again.
    await metrics.scrollTo(650);
    await text(" and the rest");
    return expect(metrics.top()).toBe(1000);
  });

  it("starts a new thread with an empty transcript and the starter prompts", async () => {
    const container = await mount(
      <AssistantWorkspace gateway={fakeGateway()} />
    );
    await click(button("Summarize my latest backtests"));
    expect(container.textContent).toContain("Two backtests on ES.");
    await click(button("New thread"));
    expect(container.textContent).not.toContain("Two backtests on ES.");
    return expect(
      container.querySelector('[aria-label="Starter prompts"]')
    ).not.toBeNull();
  });
});

describe("AssistantWorkspace Stop", () => {
  it("replaces Send with Stop while a turn runs and aborts the request", async () => {
    let seen: AbortSignal | undefined;
    const send = vi.fn(
      (_input: unknown, signal?: AbortSignal) =>
        new Promise((_resolve, reject) => {
          seen = signal;
          signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError"))
          );
        })
    );
    const gateway = fakeGateway({ send });
    const container = await mount(<AssistantWorkspace gateway={gateway} />);
    await click(button("Summarize my latest backtests"));
    expect(container.textContent).not.toContain("Send");
    gateway.get.mockClear();
    await click(button("Stop"));
    expect(seen?.aborted).toBe(true);
    expect(container.textContent).toContain(
      "Stopped. The server ends this turn and keeps the reply written so far"
    );
    expect(container.querySelector("[data-send-error]")).toBeNull();
    expect(gateway.get).toHaveBeenCalledWith("thread-1");
    return expect(button("Send")).toBeDefined();
  });

  it("shows the server note when a turn ends because of Stop", async () => {
    const gateway = fakeGateway({
      send: vi.fn(async (input: { mode: "plan" | "act" }) => ({
        ...sendOutput(
          input.mode,
          "Stopped by the operator after 0 tool steps."
        ),
        stopReason: "stopped",
      })),
    });
    const container = await mount(<AssistantWorkspace gateway={gateway} />);
    await click(button("Summarize my latest backtests"));
    return expect(container.textContent).toContain("Stopped by you.");
  });
});

describe("AssistantWorkspace confirm cards", () => {
  it("shows a pending card under its reply with Approve and Reject", async () => {
    const gateway = withCards([action()]);
    const container = await mount(<AssistantWorkspace gateway={gateway} />);
    await click(button("Act"));
    await click(button("Summarize my latest backtests"));
    const reply = container.querySelector('[data-message-role="assistant"]')!;
    const pending = card(reply);
    expect(pending.getAttribute("aria-label")).toBe(
      "Confirm action: Run backtest"
    );
    expect(pending.getAttribute("data-action-status")).toBe("pending");
    expect(pending.textContent).toContain("Waiting for your approval");
    expect(pending.textContent).toContain('definition "Fictional SMA"');
    expect(pending.textContent).toContain("Nothing runs until you approve");
    expect(button("Approve and run", pending).disabled).toBe(false);
    expect(button("Reject", pending).disabled).toBe(false);
    return expect(gateway.decide).not.toHaveBeenCalled();
  });

  it("runs a card only after Approve and shows the result", async () => {
    const gateway = withCards([action()]);
    gateway.decide.mockImplementation(async () =>
      action({
        status: "executed",
        result: '{"id":"run-1","status":"queued"}',
        decidedAt: at,
        finishedAt: at,
      })
    );
    const container = await mount(<AssistantWorkspace gateway={gateway} />);
    await click(button("Summarize my latest backtests"));
    await click(button("Approve and run", card(container)));
    expect(gateway.decide).toHaveBeenCalledWith("action-1", "approve");
    const done = card(container);
    expect(done.getAttribute("data-action-status")).toBe("executed");
    expect(done.textContent).toContain("Approved and run");
    expect(done.querySelector("[data-action-result]")?.textContent).toContain(
      '"run-1"'
    );
    return expect(done.querySelectorAll("button")).toHaveLength(0);
  });

  it("rejects a card and shows decision failures on the card", async () => {
    const gateway = withCards([
      action(),
      action({ id: "action-2", tool: "strategy_definition_save" }),
    ]);
    gateway.decide.mockImplementation(async (id: string) => {
      if (id === "action-2")
        throw Object.assign(new Error("x"), {
          code: "CONFLICT",
          message: "Action not found or already decided",
        });
      return action({ status: "rejected", decidedAt: at, finishedAt: at });
    });
    const container = await mount(<AssistantWorkspace gateway={gateway} />);
    await click(button("Summarize my latest backtests"));
    await click(button("Reject", card(container)));
    expect(gateway.decide).toHaveBeenCalledWith("action-1", "reject");
    expect(card(container).textContent).toContain("Rejected; nothing ran");
    const save = card(container, "strategy_definition_save");
    await click(button("Approve and run", save));
    expect(
      card(container, "strategy_definition_save").querySelector(
        '[role="alert"]'
      )?.textContent
    ).toBe("Action not found or already decided");
    return expect(describeAssistantFailure({ code: "CONFLICT" })).toBe(
      "Already decided. Reload the page."
    );
  });

  it("disables decisions while one runs and shows failed cards from a reopened thread", async () => {
    let finish: (value: AssistantActionOutput) => void = () => undefined;
    const gateway = fakeGateway({
      list: vi.fn(async () => ({
        threads: [thread("thread-1", "Earlier")],
        status: status(),
      })),
      get: vi.fn(async () => ({
        thread: thread(),
        messages: [message({ id: "m-2", role: "assistant", content: "Cards" })],
        actions: [
          action(),
          action({
            id: "action-3",
            tool: "backtest_runs_sweep",
            status: "failed",
            error: "NOT_FOUND (404): No stored bars",
          }),
          action({ id: "action-4", tool: "unknown_tool", status: "running" }),
          action({ id: "action-5", tool: "strategy_definition_save" }),
        ],
      })),
      decide: vi.fn(
        () =>
          new Promise<AssistantActionOutput>((resolve) => {
            finish = resolve;
          })
      ),
    });
    const container = await mount(<AssistantWorkspace gateway={gateway} />);
    await click(
      container.querySelector<HTMLButtonElement>('[data-thread-id="thread-1"]')!
    );
    const sweep = card(container, "backtest_runs_sweep");
    expect(sweep.textContent).toContain("Approved; the run failed");
    expect(sweep.querySelector('[role="note"]')?.textContent).toBe(
      "NOT_FOUND (404): No stored bars"
    );
    expect(card(container, "unknown_tool").textContent).toContain("Running");
    await click(button("Approve and run", card(container)));
    expect(button("Reject", card(container)).disabled).toBe(true);
    expect(card(container).textContent).toContain("Running…");
    const other = card(container, "strategy_definition_save");
    expect(button("Approve and run", other).disabled).toBe(true);
    expect(other.textContent).not.toContain("Running…");
    expect(other.textContent).toContain("Nothing runs until you approve");
    await act(async () => {
      finish(action({ status: "executed", result: "ok" }));
      return await flush();
    });
    expect(card(container).getAttribute("data-action-status")).toBe("executed");
    await click(button("Reject", card(container, "strategy_definition_save")));
    expect(card(container, "strategy_definition_save").textContent).toContain(
      "Rejecting…"
    );
    await act(async () => {
      finish(
        action({
          id: "action-5",
          tool: "strategy_definition_save",
          status: "rejected",
        })
      );
      return await flush();
    });
    return expect(
      card(container, "strategy_definition_save").getAttribute(
        "data-action-status"
      )
    ).toBe("rejected");
  });

  return it("previews long results", () => {
    expect(actionResultPreview("short")).toBe("short");
    expect(actionResultPreview("x".repeat(2500))).toHaveLength(2001);
  });
});

describe("createBrowserAssistantGateway", () => {
  it("sends each call to the same-origin oRPC endpoint", async () => {
    const urls: string[] = [];
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input: RequestInfo | URL) => {
        urls.push(input instanceof Request ? input.url : String(input));
        return Response.json(
          { json: { defined: true, code: "FORBIDDEN", status: 403 } },
          { status: 403 }
        );
      });
    const gateway = createBrowserAssistantGateway();
    const calls = [
      () => gateway.list(),
      () => gateway.create(),
      () => gateway.create("Title"),
      () => gateway.get("thread-1"),
      () => gateway.send({ threadId: "thread-1", message: "hi", mode: "act" }),
      () =>
        gateway.send(
          { threadId: "thread-1", message: "hi", mode: "act" },
          new AbortController().signal
        ),
      () => gateway.decide("action-1", "approve"),
    ];
    for (const run of calls) await expect(run()).rejects.toBeDefined();
    expect(urls.map((url) => new URL(url).pathname)).toEqual([
      "/api/orpc/assistant/threads/list",
      "/api/orpc/assistant/threads/create",
      "/api/orpc/assistant/threads/create",
      "/api/orpc/assistant/threads/get",
      "/api/orpc/assistant/send",
      "/api/orpc/assistant/send",
      "/api/orpc/assistant/actions/decide",
    ]);
    fetchSpy.mockRestore();
  });
});

describe("assistant client helpers", () =>
  it("derives one-line titles and readable failures", () => {
    expect(threadTitleFrom("  Summarize\n my backtests ")).toBe(
      "Summarize my backtests"
    );
    expect(threadTitleFrom("x".repeat(100))).toHaveLength(80);
    expect(
      describeAssistantFailure({
        code: "UPSTREAM_ERROR",
        message: "Model provider rate limited the request (429); retry shortly",
      })
    ).toMatch(/429/);
    expect(
      describeAssistantFailure({
        code: "FORBIDDEN",
        message: "Agent viewer may chat in Plan mode only",
      })
    ).toBe("Agent viewer may chat in Plan mode only");
    expect(describeAssistantFailure({ code: "FORBIDDEN" })).toBe(
      "Operator access required."
    );
    expect(describeAssistantFailure({ code: "UNAUTHORIZED" })).toBe(
      "Session expired. Sign in again."
    );
    return expect(describeAssistantFailure(new Error("boom"))).toBe(
      "Request failed. Try again."
    );
  }));

describe("AssistantWorkspace streaming", () => {
  it("folds stream events into the live turn", () => {
    const call = {
      args: "{}",
      durationMs: 5,
      error: null,
      ok: true,
      tool: "backtests_list",
    };
    const steps: AssistantSendEvent[] = [
      { delta: "Look", modelCall: 1, type: "text" },
      { delta: "ing.", modelCall: 1, type: "text" },
      { step: 1, tools: ["backtests_list", "summary"], type: "step" },
      { call, step: 1, type: "tool" },
      { delta: "Done", modelCall: 2, type: "text" },
      {
        thread: thread(),
        type: "started",
        userMessage: message({ id: "m-1" }),
      },
    ];
    const seen: LiveTurn[] = [];
    for (const event of steps)
      seen.push(applyLiveEvent(seen.at(-1) ?? EMPTY_LIVE_TURN, event));
    expect(seen[1]).toMatchObject({ modelCall: 1, text: "Looking." });
    expect(seen[2]?.running).toEqual(["backtests_list", "summary"]);
    expect(seen[3]).toMatchObject({ running: ["summary"], tools: [call] });
    expect(seen[4]).toMatchObject({ modelCall: 2, text: "Done" });
    return expect(seen[5]).toBe(seen[4]);
  });

  it("shows reply text, running tools and tool cards while the turn streams", async () => {
    let emit: (event: AssistantSendEvent) => void = () => undefined;
    let finishTurn: () => void = () => undefined;
    const send = vi.fn(
      (
        input: { mode: "plan" | "act" },
        _signal?: AbortSignal,
        onEvent?: (event: AssistantSendEvent) => void
      ) =>
        new Promise<AssistantSendOutput>((resolve) => {
          emit = (event) => onEvent?.(event);
          finishTurn = () =>
            resolve(sendOutput(input.mode, "Two backtests on ES."));
        })
    );
    const gateway = fakeGateway({ send });
    const container = await mount(<AssistantWorkspace gateway={gateway} />);
    await click(button("Summarize my latest backtests"));
    const streaming = () =>
      container.querySelector('[data-message-role="streaming"]');
    expect(streaming()?.textContent).toContain("Working…");
    expect(
      container
        .querySelector('[aria-label="Transcript"]')
        ?.getAttribute("aria-busy")
    ).toBe("true");
    await act(async () => {
      emit({ step: 1, tools: ["backtests_list"], type: "step" });
      return await flush();
    });
    expect(container.querySelector("[data-running-tool]")?.textContent).toBe(
      "Calling backtests_list…"
    );
    expect(streaming()?.textContent).not.toContain("Working…");
    await act(async () => {
      emit({
        call: {
          args: "{}",
          durationMs: 9,
          error: null,
          ok: true,
          tool: "backtests_list",
        },
        step: 1,
        type: "tool",
      });
      emit({ delta: "Two back", modelCall: 2, type: "text" });
      emit({ delta: "tests so far", modelCall: 2, type: "text" });
      return await flush();
    });
    expect(container.querySelector("[data-running-tool]")).toBeNull();
    expect(
      streaming()?.querySelector('[data-tool-call="backtests_list"]')
    ).not.toBeNull();
    expect(
      container.querySelector("[data-streaming-text]")?.textContent
    ).toContain("Two backtests so far");
    await act(async () => {
      finishTurn();
      return await flush();
    });
    expect(streaming()).toBeNull();
    return expect(container.textContent).toContain("Two backtests on ES.");
  });
});

describe("readAssistantTurn", () => {
  const events = async function* (
    list: readonly AssistantSendEvent[]
  ): AsyncGenerator<AssistantSendEvent> {
    for (const event of list) yield event;
  };

  it("passes events on and returns the stored reply", async () => {
    const output = sendOutput("plan", "Done.");
    const seen: string[] = [];
    const result = await readAssistantTurn(
      events([
        { delta: "Done.", modelCall: 1, type: "text" },
        { result: output, type: "done" },
      ]),
      (event) => seen.push(event.type)
    );
    expect(seen).toEqual(["text", "done"]);
    expect(result).toBe(output);
    return expect(
      await readAssistantTurn(events([{ result: output, type: "done" }]))
    ).toBe(output);
  });

  it("fails with a readable message when the stream ends without a reply", async () => {
    const failure = await readAssistantTurn(
      events([{ delta: "Hal", modelCall: 1, type: "text" }])
    ).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "STREAM_ENDED" });
    return expect(describeAssistantFailure(failure)).toBe(
      "The reply stopped arriving. The thread shows what the server kept."
    );
  });

  it("reads the oRPC event stream in the browser gateway", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(
        async () =>
          new Response(
            'event: message\ndata: {"json":{"type":"text","modelCall":1,"delta":"Hi"}}\n\nevent: done\ndata: {"json":null}\n\n',
            { headers: { "content-type": "text/event-stream" } }
          )
      );
    const seen: AssistantSendEvent[] = [];
    const failure = await createBrowserAssistantGateway()
      .send(
        { message: "hi", mode: "plan", threadId: "thread-1" },
        undefined,
        (event) => seen.push(event)
      )
      .catch((error: unknown) => error);
    fetchSpy.mockRestore();
    expect(seen).toEqual([{ delta: "Hi", modelCall: 1, type: "text" }]);
    return expect(failure).toMatchObject({ code: "STREAM_ENDED" });
  });
});

describe("AssistantWorkspace panel variant", () => {
  const page = { path: "/engines", title: "Engines" } as const;
  const keydown = async (key: string) =>
    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key })
      );
      return await flush();
    });

  it("shows the greeting, page-aware chips and a compact composer", async () => {
    const gateway = fakeGateway();
    const container = await mount(
      <AssistantWorkspace
        gateway={gateway}
        pageContext={page}
        variant="panel"
      />
    );
    expect(
      container.querySelector('[data-variant="panel"]')?.textContent
    ).toContain("Ask about this page or your research");
    const chips = [
      ...container.querySelectorAll('[aria-label="Starter prompts"] button'),
    ].map((node) => node.textContent);
    expect(chips).toEqual(["Explain this page", ...ASSISTANT_STARTER_PROMPTS]);
    const textarea = container.querySelector<HTMLTextAreaElement>(
      "#assistant-panel-message"
    );
    expect(textarea?.rows).toBe(2);
    expect(container.querySelector("#assistant-message")).toBeNull();
    expect(container.querySelector("[data-budget-meter]")).toBeNull();
    expect(
      container
        .querySelector('[role="radiogroup"]')
        ?.getAttribute("aria-describedby")
    ).toBe("assistant-panel-mode-help");
    expect(button("Plan").getAttribute("aria-checked")).toBe("true");
    expect(button("New chat")).toBeDefined();
    return expect(
      container.querySelector("[data-assistant-composer]")?.textContent
    ).toContain("Send");
  });

  it("leaves out the page chip without a page context", async () => {
    const container = await mount(
      <AssistantWorkspace gateway={fakeGateway()} variant="panel" />
    );
    return expect(container.textContent).not.toContain("Explain this page");
  });

  it("sends the page context with every message", async () => {
    const gateway = fakeGateway();
    const container = await mount(
      <AssistantWorkspace
        gateway={gateway}
        pageContext={page}
        variant="panel"
      />
    );
    await click(button("Explain this page"));
    expect(gateway.send).toHaveBeenCalledWith(
      {
        message: "Explain this page",
        mode: "plan",
        page,
        threadId: "thread-1",
      },
      expect.any(AbortSignal),
      expect.any(Function)
    );
    expect(
      container.querySelector('[data-message-role="assistant"]')
    ).not.toBeNull();
    expect(container.textContent).not.toContain(
      "Ask about this page or your research"
    );
    await click(button("New chat"));
    return expect(container.textContent).toContain(
      "Ask about this page or your research"
    );
  });

  it("shows Stop while a reply streams and aborts it", async () => {
    let seen: AbortSignal | undefined;
    const send = vi.fn(
      (_input: unknown, signal?: AbortSignal) =>
        new Promise((_resolve, reject) => {
          seen = signal;
          signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError"))
          );
        })
    );
    const container = await mount(
      <AssistantWorkspace
        gateway={fakeGateway({ send })}
        pageContext={page}
        variant="panel"
      />
    );
    const textarea = container.querySelector<HTMLTextAreaElement>(
      "#assistant-panel-message"
    )!;
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value"
      )?.set;
      setValue?.call(textarea, "What is on this page?");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      return await flush();
    });
    await click(button("Send"));
    const composer = container.querySelector("[data-assistant-composer]")!;
    expect(composer.textContent).not.toContain("Send");
    expect(button("Thread history").disabled).toBe(true);
    expect(button("New chat").disabled).toBe(true);
    await click(button("Stop", composer));
    expect(seen?.aborted).toBe(true);
    return expect(container.textContent).toContain("Stopped. The server");
  });

  it("Stop never turns into Send, so the click that stops a reply does not resend it", async () => {
    // In a real browser the abort settles in the microtasks of the click, before the button's
    // default action. If React reused the Stop <button> as the Send submit button, that same click
    // submitted the form and resent the draft (seen live on 2026-11-04: two user messages, two turns).
    // Executor form: the web app's TypeScript lib has no Promise.withResolvers.
    const send = vi.fn(
      (_input: unknown, signal?: AbortSignal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError"))
          );
        })
    );
    const container = await mount(
      <AssistantWorkspace
        gateway={fakeGateway({ send })}
        pageContext={page}
        variant="panel"
      />
    );
    const textarea = container.querySelector<HTMLTextAreaElement>(
      "#assistant-panel-message"
    )!;
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value"
      )?.set;
      setValue?.call(textarea, "What is on this page?");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      return await flush();
    });
    await click(button("Send"));
    const composer = container.querySelector("[data-assistant-composer]")!;
    const stop = button("Stop", composer);
    await click(stop);
    expect(button("Send", composer)).not.toBe(stop);
    expect(stop.isConnected).toBe(false);
    // A late default action on the clicked element must not submit the form.
    await click(stop);
    return expect(send).toHaveBeenCalledTimes(1);
  });

  it("lists recent threads under History; choosing one opens it", async () => {
    const gateway = fakeGateway({
      list: vi.fn(async () => ({
        threads: [thread("thread-9", "Earlier"), thread("thread-8", "Older")],
        status: status(),
      })),
      get: vi.fn(async () => ({
        thread: thread("thread-9", "Earlier"),
        messages: [message({ threadId: "thread-9", content: "Earlier q" })],
        actions: [],
      })),
    });
    const container = await mount(
      <AssistantWorkspace gateway={gateway} variant="panel" />
    );
    const history = button("Thread history");
    expect(history.getAttribute("aria-expanded")).toBe("false");
    expect(history.getAttribute("aria-controls")).toBe(
      "assistant-panel-history"
    );
    await click(history);
    expect(history.getAttribute("aria-expanded")).toBe("true");
    const list = container.querySelector("#assistant-panel-history")!;
    expect(list.getAttribute("aria-label")).toBe("Recent threads");
    expect(document.activeElement?.getAttribute("data-thread-id")).toBe(
      "thread-9"
    );
    await click(
      list.querySelector<HTMLButtonElement>('[data-thread-id="thread-9"]')!
    );
    expect(gateway.get).toHaveBeenCalledWith("thread-9");
    expect(container.querySelector("#assistant-panel-history")).toBeNull();
    expect(document.activeElement).toBe(history);
    await click(history);
    expect(
      container
        .querySelector('#assistant-panel-history [data-thread-id="thread-9"]')
        ?.getAttribute("aria-current")
    ).toBe("true");
    await keydown("Tab");
    expect(container.querySelector("#assistant-panel-history")).not.toBeNull();
    await keydown("Escape");
    expect(container.querySelector("#assistant-panel-history")).toBeNull();
    await click(history);
    await click(history);
    expect(container.querySelector("#assistant-panel-history")).toBeNull();
    await click(history);
    await click(button("New chat"));
    expect(container.querySelector("#assistant-panel-history")).toBeNull();
    return expect(container.textContent).toContain(
      "Ask about this page or your research"
    );
  });

  it("shows the history list loading, empty and failed", async () => {
    const never = await mount(
      <AssistantWorkspace
        gateway={fakeGateway({
          list: vi.fn(() => new Promise(() => undefined)),
        })}
        variant="panel"
      />
    );
    await click(button("Thread history", never));
    expect(never.querySelector("#assistant-panel-history")?.textContent).toBe(
      "Loading threads…"
    );
    await act(async () => roots.splice(0)[0]?.unmount());
    document.body.replaceChildren();

    const empty = await mount(
      <AssistantWorkspace gateway={fakeGateway()} variant="panel" />
    );
    await click(button("Thread history", empty));
    expect(empty.querySelector("#assistant-panel-history")?.textContent).toBe(
      "No threads yet."
    );
    await act(async () => roots.splice(0)[0]?.unmount());
    document.body.replaceChildren();

    const failed = await mount(
      <AssistantWorkspace
        gateway={fakeGateway({
          list: vi.fn(async () => {
            throw Object.assign(new Error("x"), { code: "STORAGE_ERROR" });
          }),
        })}
        variant="panel"
      />
    );
    await click(button("Thread history", failed));
    return expect(
      failed.querySelector('#assistant-panel-history [role="alert"]')
        ?.textContent
    ).toBe("x");
  });
});

describe("AssistantWorkspace panel keyboard and failures", () => {
  const typeInto = async (textarea: HTMLTextAreaElement, value: string) =>
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value"
      )?.set?.call(textarea, value);
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      return await flush();
    });
  const press = async (
    textarea: HTMLTextAreaElement,
    init: KeyboardEventInit
  ) =>
    await act(async () => {
      textarea.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          ...init,
        })
      );
      return await flush();
    });

  it("sends on Enter, not on Shift+Enter or an empty draft, and moves the sent thread first", async () => {
    const gateway = fakeGateway({
      list: vi.fn(async () => ({
        threads: [thread("thread-9", "Earlier")],
        status: status(),
      })),
    });
    const container = await mount(
      <AssistantWorkspace gateway={gateway} variant="panel" />
    );
    const textarea = container.querySelector<HTMLTextAreaElement>(
      "#assistant-panel-message"
    )!;
    await press(textarea, { key: "Enter" });
    await typeInto(textarea, "Hello");
    await press(textarea, { key: "Enter", shiftKey: true });
    await press(textarea, { key: "a" });
    expect(gateway.send).not.toHaveBeenCalled();
    await press(textarea, { key: "Enter" });
    expect(gateway.send).toHaveBeenCalledOnce();
    await click(button("Thread history"));
    return expect(
      [
        ...container.querySelectorAll(
          "#assistant-panel-history [data-thread-id]"
        ),
      ].map((node) => node.getAttribute("data-thread-id"))
    ).toEqual(["thread-1", "thread-9"]);
  });

  it("shows a thread that fails to load", async () => {
    const gateway = fakeGateway({
      list: vi.fn(async () => ({
        threads: [thread("thread-9", "Earlier")],
        status: status(),
      })),
      get: vi.fn(async () => {
        throw Object.assign(new Error("x"), { code: "NOT_FOUND" });
      }),
    });
    const container = await mount(
      <AssistantWorkspace gateway={gateway} variant="panel" />
    );
    await click(button("Thread history"));
    await click(
      container.querySelector<HTMLButtonElement>('[data-thread-id="thread-9"]')!
    );
    return expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "Thread not found. Reload the page."
    );
  });
});

describe("createBrowserAssistantGateway page context", () =>
  it("forwards the page in the send body", async () => {
    const bodies: string[] = [];
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(
        async (input: RequestInfo | URL, init?: RequestInit) => {
          bodies.push(
            input instanceof Request
              ? await input.clone().text()
              : String(init?.body)
          );
          return Response.json(
            { json: { defined: true, code: "FORBIDDEN", status: 403 } },
            { status: 403 }
          );
        }
      );
    await createBrowserAssistantGateway()
      .send({
        message: "hi",
        mode: "plan",
        page: { path: "/engines", title: "Engines" },
        threadId: "thread-1",
      })
      .catch(() => undefined);
    fetchSpy.mockRestore();
    return expect(bodies[0]).toContain(
      '"page":{"path":"/engines","title":"Engines"}'
    );
  }));
