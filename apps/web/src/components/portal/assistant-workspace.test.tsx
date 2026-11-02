// @vitest-environment jsdom
import type {
  AssistantActionOutput,
  AssistantMessageOutput,
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
  threadTitleFrom,
  type AssistantGateway,
} from "./assistant-client.ts";
import { AssistantWorkspace } from "./assistant-workspace.tsx";

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
// jsdom has no layout, so scrollIntoView is missing; record the calls instead.
const scrolled = vi.fn();
HTMLElement.prototype.scrollIntoView = scrolled;

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
      expect.any(AbortSignal)
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
      expect.any(AbortSignal)
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

describe("AssistantWorkspace auto-scroll", () => {
  it("keeps the newest message in view without smooth scrolling", async () => {
    scrolled.mockClear();
    const gateway = fakeGateway();
    await mount(<AssistantWorkspace gateway={gateway} />);
    expect(scrolled).not.toHaveBeenCalled();
    await click(button("Summarize my latest backtests"));
    expect(scrolled).toHaveBeenCalledWith({ block: "end" });
    const [target] = scrolled.mock.contexts;
    return expect(
      (target as HTMLElement).hasAttribute("data-transcript-end")
    ).toBe(true);
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
    expect(container.textContent).toContain("Stopped waiting.");
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
    expect(describeAssistantFailure({ code: "UNAUTHORIZED" })).toBe(
      "Session expired. Sign in again."
    );
    return expect(describeAssistantFailure(new Error("boom"))).toBe(
      "Request failed. Try again."
    );
  }));
