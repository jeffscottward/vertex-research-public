// @vitest-environment jsdom
import type {
  AssistantArtifact,
  AssistantMessageOutput,
  AssistantSendEvent,
  AssistantSendOutput,
  AssistantToolTraceOutput,
} from "@darkfactory/api";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as ChartBus from "../../features/charts/chart-bus.ts";

// The real bus (storage + window event), wrapped so a test can count the commands it sent.
vi.mock("../../features/charts/chart-bus.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof ChartBus>();
  return { ...actual, sendChartCommand: vi.fn(actual.sendChartCommand) };
});

import {
  PENDING_SCRIPT_KEY,
  publishChartContext,
  readPendingScript,
  sendChartCommand,
} from "../../features/charts/chart-bus.ts";
import {
  artifactKey,
  autoApplyChartArtifact,
  chartHref,
  isChartsPath,
  NO_CHART_TARGET,
  toolArtifacts,
} from "./assistant-artifacts.tsx";
import type { AssistantGateway } from "./assistant-client.ts";
import { AssistantWorkspace } from "./assistant-workspace.tsx";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const sent = vi.mocked(sendChartCommand);
const roots: Root[] = [];
const at = new Date("2026-01-02T03:04:05.000Z");
const JAN_2 = Date.UTC(2026, 0, 2);
const CHARTS_PAGE = { path: "/charts", title: "Charts" } as const;
const ES_CHART = {
  bars: 250,
  firstTimestamp: JAN_2,
  lastClose: 5012.5,
  lastTimestamp: JAN_2 + 86_400_000,
  symbol: "ES",
};

// What the chart workstation publishes while it shows a symbol.
const showChart = (symbol: string | null) =>
  publishChartContext(
    symbol === null
      ? null
      : {
          bars: 250,
          firstTimestamp: JAN_2,
          label: symbol,
          lastClose: 5012.5,
          lastTimestamp: JAN_2 + 86_400_000,
          symbol,
        }
  );

beforeEach(() => {
  sent.mockClear();
  localStorage.clear();
  showChart("ES");
});

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.replaceChildren();
  showChart(null);
});

const flush = async () => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
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
  return container;
};

const click = async (element: Element | null | undefined) => {
  if (!(element instanceof HTMLElement)) throw new Error("Missing element");
  await act(async () => {
    element.click();
    await flush();
  });
};

const button = (label: string, scope: ParentNode = document) =>
  [...scope.querySelectorAll("button")].find(
    (node) =>
      node.getAttribute("aria-label") === label ||
      node.textContent?.trim() === label
  );

const link = (label: string, scope: ParentNode = document) => {
  const found = [...scope.querySelectorAll("a")].find(
    (node) => node.textContent?.trim() === label
  );
  // jsdom cannot navigate; the click handler (what the test checks) still runs.
  found?.addEventListener("click", (event) => event.preventDefault());
  return found;
};

const typeAndSend = async (container: HTMLElement, text: string) => {
  const textarea = container.querySelector("textarea");
  if (textarea === null) throw new Error("Missing composer");
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value"
    )?.set?.call(textarea, text);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    await flush();
  });
  await click(button("Send", container));
};

const drawings = {
  drawings: [
    {
      id: "quant-turn0001-1",
      points: [{ timestamp: JAN_2, value: 5000 }],
      text: "Support",
      tool: "level",
    },
  ],
  kind: "chart_drawings",
  replace: false,
  symbol: "ES",
} satisfies AssistantArtifact;
const script = {
  kind: "chart_script",
  overlay: true,
  source:
    '//@version=5\nindicator("EMA", overlay=true)\nplot(ta.ema(close, 20))',
  title: "EMA 20",
} satisfies AssistantArtifact;
const teach = {
  kind: "teach",
  steps: [
    { body: "A level is a price the market keeps reacting to.", title: "Idea" },
    {
      body: "Here price bounced twice.",
      drawings: [
        {
          id: "quant-turn0001-2",
          points: [{ timestamp: JAN_2, value: 4990 }],
          text: "Bounce",
          tool: "level",
        },
      ],
      title: "Example",
    },
    { body: "Levels can break.", title: "Caveat" },
  ],
  symbol: "ES",
  topic: "Support levels",
} satisfies AssistantArtifact;

const traceOf = (artifacts: readonly AssistantArtifact[]) =>
  artifacts.map(
    (artifact): AssistantToolTraceOutput => ({
      args: "{}",
      artifact,
      durationMs: 3,
      error: null,
      ok: true,
      tool:
        artifact.kind === "chart_drawings"
          ? "chart_draw"
          : artifact.kind === "chart_script"
            ? "chart_script"
            : artifact.kind === "teach"
              ? "teach_steps"
              : "chart_clear_drawings",
    })
  );

const messageOf = (
  overrides: Partial<AssistantMessageOutput>
): AssistantMessageOutput => ({
  content: "hi",
  createdAt: at,
  id: "m-1",
  inputTokens: 0,
  mode: "plan",
  model: null,
  outputTokens: 0,
  role: "user",
  threadId: "thread-1",
  toolCalls: [],
  ...overrides,
});

const outputWith = (
  artifacts: readonly AssistantArtifact[]
): AssistantSendOutput => {
  const trace = traceOf(artifacts);
  return {
    actions: [],
    reply: messageOf({
      content: "Done.",
      id: "m-2",
      role: "assistant",
      toolCalls: trace,
    }),
    steps: 1,
    stopReason: "completed",
    thread: { createdAt: at, id: "thread-1", title: "t", updatedAt: at },
    trace,
    usage: {
      day: "2026-01-02",
      inputTokens: 0,
      outputTokens: 0,
      requestLimit: 200,
      requests: 1,
      tokenLimit: 500_000,
    },
    userMessage: messageOf({ content: "Draw" }),
  };
};

type SendFn = (
  input: Record<string, unknown>,
  signal?: AbortSignal,
  onEvent?: (event: AssistantSendEvent) => void
) => Promise<AssistantSendOutput>;

const gatewayWith = (send: SendFn) => {
  const thread = { createdAt: at, id: "thread-1", title: "t", updatedAt: at };
  return {
    create: vi.fn(async () => thread),
    decide: vi.fn(),
    get: vi.fn(async () => ({ actions: [], messages: [], thread })),
    list: vi.fn(async () => ({
      status: {
        configured: true,
        maxSteps: 8,
        model: "m",
        usage: {
          day: "2026-01-02",
          inputTokens: 0,
          outputTokens: 0,
          requestLimit: 200,
          requests: 0,
          tokenLimit: 500_000,
        },
      },
      threads: [],
    })),
    send: vi.fn(send),
  } as unknown as AssistantGateway & { send: ReturnType<typeof vi.fn> };
};

// Streams each artifact as a "tool" event, then resolves with the stored reply repeating them.
const streaming =
  (artifacts: readonly AssistantArtifact[], streamed = artifacts.length) =>
  async (
    _input: Record<string, unknown>,
    _signal?: AbortSignal,
    onEvent?: (event: AssistantSendEvent) => void
  ) => {
    for (const call of traceOf(artifacts).slice(0, streamed))
      onEvent?.({ call, step: 1, type: "tool" });
    return outputWith(artifacts);
  };

describe("assistant artifact helpers", () => {
  it("knows the charts path, links to a symbol and collects artifacts", () => {
    expect(isChartsPath("/charts")).toBe(true);
    expect(isChartsPath("/charts/x")).toBe(true);
    expect(isChartsPath("/chartsx")).toBe(false);
    expect(isChartsPath(undefined)).toBe(false);
    expect(chartHref("BRK.B")).toBe("/charts?symbol=BRK.B");
    expect(chartHref(null)).toBe("/charts");
    expect(toolArtifacts(traceOf([drawings, script]))).toEqual([
      drawings,
      script,
    ]);
    return expect(
      toolArtifacts([
        { args: "{}", durationMs: 1, error: null, ok: true, tool: "x" },
      ])
    ).toEqual([]);
  });

  it("applies only off-script artifacts, and only on /charts", () => {
    const onCharts = { onCharts: true, symbol: "ES" };
    expect(autoApplyChartArtifact(drawings, NO_CHART_TARGET)).toBe(false);
    expect(autoApplyChartArtifact(script, onCharts)).toBe(false);
    expect(sent).not.toHaveBeenCalled();
    autoApplyChartArtifact({ kind: "chart_clear", symbol: "NQ" }, onCharts);
    expect(sent).toHaveBeenLastCalledWith({
      symbol: "NQ",
      type: "clear_quant",
    });
    // A drawn walkthrough on its own chart: step 1 (no drawings) clears earlier teach drawings.
    expect(autoApplyChartArtifact(teach, onCharts)).toBe(true);
    expect(sent).toHaveBeenLastCalledWith({
      drawings: [],
      group: "teach",
      replace: true,
      symbol: "ES",
      type: "drawings",
    });
    // Never on another chart, off /charts, without a symbol, or for a walkthrough that never draws.
    showChart("AAPL");
    expect(autoApplyChartArtifact(teach, onCharts)).toBe(false);
    showChart("ES");
    expect(autoApplyChartArtifact(teach, NO_CHART_TARGET)).toBe(false);
    const { symbol: _symbol, ...unsymbolled } = teach;
    expect(autoApplyChartArtifact(unsymbolled, onCharts)).toBe(false);
    expect(
      autoApplyChartArtifact(
        { kind: "teach", steps: [teach.steps[0]!], symbol: "ES", topic: "t" },
        onCharts
      )
    ).toBe(false);
    return expect(sent).toHaveBeenCalledTimes(2);
  });
});

describe("AssistantWorkspace chart artifacts and Teach", () => {
  it("the Teach toggle is a pressed button that adds teach: true to each message while on", async () => {
    const gateway = gatewayWith(async () => outputWith([]));
    const container = await mount(<AssistantWorkspace gateway={gateway} />);
    const toggle = button("Teach", container);
    expect(toggle?.getAttribute("aria-pressed")).toBe("false");
    await click(toggle);
    expect(toggle?.getAttribute("aria-pressed")).toBe("true");
    expect(container.querySelector("[data-teach-help]")?.textContent).toContain(
      "Teach is on"
    );
    await typeAndSend(container, "Explain RSI");
    expect(gateway.send).toHaveBeenLastCalledWith(
      expect.objectContaining({ message: "Explain RSI", teach: true }),
      expect.any(AbortSignal),
      expect.any(Function)
    );
    await click(toggle);
    expect(toggle?.getAttribute("aria-pressed")).toBe("false");
    await typeAndSend(container, "And MACD?");
    const [input] = gateway.send.mock.lastCall ?? [];
    expect(input).toMatchObject({ message: "And MACD?" });
    return expect(input).not.toHaveProperty("teach");
  });

  it("on /charts sends the chart read at send time with the page", async () => {
    const gateway = gatewayWith(async () => outputWith([]));
    const pageChart = vi.fn(() => ES_CHART);
    const container = await mount(
      <AssistantWorkspace
        gateway={gateway}
        pageChart={pageChart}
        pageContext={CHARTS_PAGE}
        variant="panel"
      />
    );
    pageChart.mockClear();
    await typeAndSend(container, "What is this chart?");
    expect(pageChart).toHaveBeenCalled();
    return expect(gateway.send).toHaveBeenLastCalledWith(
      expect.objectContaining({ page: { ...CHARTS_PAGE, chart: ES_CHART } }),
      expect.any(AbortSignal),
      expect.any(Function)
    );
  });

  it("applies streamed drawings on /charts once, not again from the stored reply", async () => {
    const gateway = gatewayWith(
      streaming([drawings, { kind: "chart_clear", symbol: "ES" }])
    );
    const container = await mount(
      <AssistantWorkspace
        gateway={gateway}
        pageChart={() => ES_CHART}
        pageContext={CHARTS_PAGE}
        variant="panel"
      />
    );
    await typeAndSend(container, "Draw support");
    expect(sent.mock.calls.map(([command]) => command)).toEqual([
      {
        drawings: drawings.drawings,
        replace: false,
        symbol: "ES",
        type: "drawings",
      },
      { symbol: "ES", type: "clear_quant" },
    ]);
    // The card always offers Show on chart: it applies again and links to the symbol.
    const show = link("Show on chart", container);
    expect(show?.getAttribute("href")).toBe("/charts?symbol=ES");
    await click(show);
    expect(sent).toHaveBeenCalledTimes(3);
    expect(
      container.querySelector('[data-artifact="chart_drawings"]')?.textContent
    ).toContain("1 drawing on ES");
    return expect(link("Clear on chart", container)?.getAttribute("href")).toBe(
      "/charts?symbol=ES"
    );
  });

  it("applies an artifact only the stored reply carried, and nothing off /charts", async () => {
    const onCharts = gatewayWith(streaming([drawings], 0));
    const charts = await mount(
      <AssistantWorkspace
        gateway={onCharts}
        pageChart={() => ES_CHART}
        pageContext={CHARTS_PAGE}
        variant="panel"
      />
    );
    await typeAndSend(charts, "Draw");
    expect(sent).toHaveBeenCalledTimes(1);
    sent.mockClear();
    const elsewhere = gatewayWith(streaming([drawings]));
    const dashboard = await mount(
      <AssistantWorkspace
        gateway={elsewhere}
        pageContext={{ path: "/dashboard", title: "Dashboard" }}
        variant="panel"
      />
    );
    await typeAndSend(dashboard, "Draw");
    expect(sent).not.toHaveBeenCalled();
    return expect(link("Show on chart", dashboard)).toBeDefined();
  });

  it("Open in script editor writes the pending script and opens the chart on the current symbol", async () => {
    const gateway = gatewayWith(streaming([script]));
    const container = await mount(
      <AssistantWorkspace
        gateway={gateway}
        pageChart={() => ES_CHART}
        pageContext={CHARTS_PAGE}
        variant="panel"
      />
    );
    await typeAndSend(container, "Write an EMA");
    // A script never applies by itself.
    expect(sent).not.toHaveBeenCalled();
    expect(localStorage.getItem(PENDING_SCRIPT_KEY)).toBeNull();
    const card = container.querySelector('[data-artifact="chart_script"]');
    expect(card?.querySelector("[data-script-preview] pre")?.textContent).toBe(
      script.source
    );
    const open = link("Open in script editor", container);
    expect(open?.getAttribute("href")).toBe("/charts?symbol=ES");
    await click(open);
    expect(readPendingScript()).toEqual({
      source: script.source,
      title: "EMA 20",
    });
    const page = await mount(
      <AssistantWorkspace gateway={gatewayWith(streaming([script]))} />
    );
    await typeAndSend(page, "Write an EMA");
    return expect(
      link("Open in script editor", page)?.getAttribute("href")
    ).toBe("/charts");
  });

  it("steps through a walkthrough and shows each step's drawings on /charts", async () => {
    const gateway = gatewayWith(streaming([teach]));
    const container = await mount(
      <AssistantWorkspace
        gateway={gateway}
        pageChart={() => ES_CHART}
        pageContext={CHARTS_PAGE}
        variant="panel"
      />
    );
    await typeAndSend(container, "Teach me support");
    const stepper = container.querySelector('[data-artifact="teach"]');
    if (stepper === null) throw new Error("Missing stepper");
    expect(stepper.getAttribute("aria-label")).toBe(
      "Walkthrough: Support levels"
    );
    const position = () =>
      stepper.querySelector("[data-teach-position]")?.textContent;
    expect(position()).toBe("Step 1 of 3");
    expect(stepper.textContent).toContain("Idea");
    expect(button("Back", stepper)?.disabled).toBe(true);
    // Arrival shows step 1: it has no drawings, so earlier teach drawings are cleared.
    expect(sent.mock.calls.map(([command]) => command)).toEqual([
      {
        drawings: [],
        group: "teach",
        replace: true,
        symbol: "ES",
        type: "drawings",
      },
    ]);
    await click(button("Next", stepper));
    expect(position()).toBe("Step 2 of 3");
    expect(stepper.textContent).toContain("Here price bounced twice.");
    expect(stepper.textContent).toContain("Shown on the chart.");
    expect(sent).toHaveBeenLastCalledWith({
      drawings: teach.steps[1]?.drawings,
      group: "teach",
      replace: true,
      symbol: "ES",
      type: "drawings",
    });
    await click(button("Next", stepper));
    expect(position()).toBe("Step 3 of 3");
    expect(button("Next", stepper)?.disabled).toBe(true);
    // Step 3 has no drawings: step 2's are cleared.
    expect(sent).toHaveBeenLastCalledWith(
      expect.objectContaining({ drawings: [], group: "teach" })
    );
    await click(button("Back", stepper));
    expect(position()).toBe("Step 2 of 3");
    expect(sent).toHaveBeenCalledTimes(4);
    // The operator switched the chart to another symbol: the ES drawings stay off it.
    showChart("AAPL");
    await click(button("Next", stepper));
    await click(button("Back", stepper));
    expect(sent).toHaveBeenCalledTimes(4);
    return expect(stepper.textContent).toContain(
      "Open the ES chart to see this step's drawings."
    );
  });

  it("off /charts the walkthrough steps without touching the chart", async () => {
    const container = await mount(
      <AssistantWorkspace gateway={gatewayWith(streaming([teach]))} />
    );
    await typeAndSend(container, "Teach me");
    const stepper = container.querySelector('[data-artifact="teach"]');
    await click(button("Next", stepper ?? document));
    expect(stepper?.textContent).toContain(
      "Open the ES chart to see this step's drawings."
    );
    return expect(sent).not.toHaveBeenCalled();
  });
  it("skips unknown or malformed artifacts without breaking the reply", async () => {
    const bad = [
      { kind: "order", symbol: "ES" },
      { kind: "teach", topic: "No steps" },
      { drawings: [], kind: "chart_drawings", replace: false, symbol: "ES" },
    ] as unknown as AssistantArtifact[];
    expect(toolArtifacts(traceOf([...bad, script]))).toEqual([script]);
    const gateway = gatewayWith(streaming([...bad, drawings]));
    const container = await mount(
      <AssistantWorkspace
        gateway={gateway}
        pageChart={() => ES_CHART}
        pageContext={CHARTS_PAGE}
        variant="panel"
      />
    );
    await typeAndSend(container, "Draw");
    expect(container.textContent).toContain("Done.");
    expect(container.querySelectorAll("[data-artifact]")).toHaveLength(1);
    return expect(sent).toHaveBeenCalledTimes(1);
  });

  it("applies once by content: a stored trace with other positions repeats nothing and adds the missing", async () => {
    const clear: AssistantArtifact = { kind: "chart_clear", symbol: "ES" };
    const gateway = gatewayWith(async (_input, _signal, onEvent) => {
      // Streamed: the drawings and one clear.
      for (const call of traceOf([drawings, clear]))
        onEvent?.({ call, step: 1, type: "tool" });
      // Stored: a plain call first (positions shift), the same two, then a second identical clear.
      const output = outputWith([drawings, clear, clear]);
      const plain = {
        args: "{}",
        durationMs: 1,
        error: null,
        ok: true,
        tool: "tasks_list",
      };
      return { ...output, trace: [plain, ...output.trace] };
    });
    const container = await mount(
      <AssistantWorkspace
        gateway={gateway}
        pageChart={() => ES_CHART}
        pageContext={CHARTS_PAGE}
        variant="panel"
      />
    );
    await typeAndSend(container, "Draw then clear twice");
    expect(sent.mock.calls.map(([command]) => command.type)).toEqual([
      "drawings",
      "clear_quant",
      "clear_quant",
    ]);
    // A later turn with the same artifacts applies them again (three more commands).
    await typeAndSend(container, "Again");
    expect(sent).toHaveBeenCalledTimes(6);
    expect(artifactKey(clear)).toBe(
      artifactKey({ kind: "chart_clear", symbol: "ES" })
    );
    return expect(artifactKey(clear)).not.toBe(
      artifactKey({ kind: "chart_clear", symbol: "NQ" })
    );
  });
});
