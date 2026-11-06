// @vitest-environment jsdom
import type {
  AgentOpsSummaryOutput,
  AgentTaskOutput,
  ResearchPaperOutput,
  SectorRotationSnapshot,
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
  type AgentOpsGateway,
  type PapersGateway,
  parseMetricsText,
} from "./agent-ops-client.tsx";
import { AgentRunsWorkspace } from "./agent-runs-workspace.tsx";
import { MissionControl } from "./mission-control.tsx";
import { PapersWorkspace } from "./papers-workspace.tsx";

const testGlobal = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
const previousAct = testGlobal.IS_REACT_ACT_ENVIRONMENT;
beforeAll(() => {
  testGlobal.IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  if (previousAct === undefined) {
    delete testGlobal.IS_REACT_ACT_ENVIRONMENT;
    return;
  }
  testGlobal.IS_REACT_ACT_ENVIRONMENT = previousAct;
});
const roots: Root[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  return document.body.replaceChildren();
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

const task = (
  id: string,
  overrides: Partial<AgentTaskOutput> = {}
): AgentTaskOutput => ({
  agent: "omp",
  createdAt: at,
  finishedAt: null,
  id,
  kind: "backtest",
  links: [],
  metrics: {},
  paperId: null,
  startedAt: null,
  status: "queued",
  summary: null,
  title: `Task ${id}`,
  updatedAt: at,
  ...overrides,
});

const paper = (
  id: string,
  overrides: Partial<ResearchPaperOutput> = {}
): ResearchPaperOutput => ({
  authors: null,
  blockers: null,
  createdAt: at,
  id,
  identifier: null,
  kind: "paper",
  notes: null,
  reportedMetrics: {},
  reproducedMetrics: {},
  sourceUrl: null,
  stage: "queued",
  title: `Paper ${id}`,
  updatedAt: at,
  verdict: "pending",
  year: null,
  ...overrides,
});

const summary = (
  overrides: Partial<AgentOpsSummaryOutput> = {}
): AgentOpsSummaryOutput => ({
  failedLast24h: 1,
  latestEvents: [],
  paperStageCounts: {
    backtested: 0,
    forward_tested: 0,
    implemented: 0,
    ingested: 0,
    queued: 3,
    spec_extracted: 1,
    verdict: 0,
  },
  statusCounts: {
    blocked: 0,
    cancelled: 0,
    failed: 1,
    needs_review: 1,
    queued: 0,
    running: 1,
    succeeded: 1,
  },
  ...overrides,
});

const agentGateway = (
  tasks: AgentTaskOutput[],
  overrides: Partial<AgentOpsGateway> = {}
): AgentOpsGateway => ({
  appendEvent: vi.fn(async (input) => ({
    at,
    id: "e2",
    level: input.level ?? "info",
    message: input.message,
    taskId: input.taskId,
  })),
  createTask: vi.fn(async (input) =>
    task("new", { agent: input.agent, kind: input.kind, title: input.title })
  ),
  getTask: vi.fn(async (id: string) => ({
    events: [
      {
        at,
        id: "e1",
        level: "info" as const,
        message: "fold 3 done",
        taskId: id,
      },
    ],
    task: tasks.find((row) => row.id === id)!,
  })),
  listTasks: vi.fn(async () => tasks),
  summary: vi.fn(async () => summary()),
  updateTask: vi.fn(async (input) => ({
    ...tasks.find((row) => row.id === input.id)!,
    status: input.status ?? "queued",
  })),
  ...overrides,
});

const setValue = async (
  element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  value: string
) => {
  const prototype =
    element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : element instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
  return await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(
      element,
      value
    );
    element.dispatchEvent(
      new Event(element instanceof HTMLSelectElement ? "change" : "input", {
        bubbles: true,
      })
    );
    return await flush();
  });
};

const clickButton = async (label: string) => {
  const button = [...document.querySelectorAll("button")].find((node) => {
    return (
      node.getAttribute("aria-label") === label ||
      node.textContent?.trim() === label
    );
  });
  if (button === undefined) throw new Error(`Missing button ${label}`);
  return await act(async () => {
    button.click();
    return await flush();
  });
};

const byLabel = <T extends Element>(label: string): T => {
  const found = document.querySelector<T>(`[aria-label="${label}"]`);
  if (found === null) throw new Error(`Missing ${label}`);
  return found;
};

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

describe("mission control", () => {
  it("shows counters and splits tasks into needs-you, running and recent results", async () => {
    const gateway = agentGateway([
      task("a", { status: "needs_review" }),
      task("b", { startedAt: at, status: "running" }),
      task("c", { metrics: { sharpe: 0.7 }, status: "succeeded" }),
      task("d", { status: "failed" }),
    ]);
    const container = await mount(<MissionControl gateway={gateway} />);
    expect(
      container.querySelector('[data-counter="Failed 24 h"]')?.textContent
    ).toBe("1");
    expect(container.querySelector('[data-stage="queued"]')?.textContent).toBe(
      "3"
    );
    // Stage counts wrap as a grid; task tables scroll in focusable regions, not the page.
    expect(
      container.querySelector('[data-stage="queued"]')?.closest("dl")
    ).not.toBeNull();
    const scrollers = [...container.querySelectorAll("[data-table-scroll]")];
    expect(scrollers).toHaveLength(3);
    expect(
      scrollers.every((node) => node.getAttribute("tabindex") === "0")
    ).toBe(true);
    const section = (id: string) =>
      [
        ...container.querySelectorAll(
          `section[aria-labelledby="${id}"] tbody tr`
        ),
      ].map((row) => row.getAttribute("data-task-id"));
    expect(section("mc-attention")).toEqual(["a", "d"]);
    expect(section("mc-running")).toEqual(["b"]);
    expect(section("mc-recent")).toEqual(["c"]);
    expect(container.textContent).toContain("sharpe=0.7");
    return expect(container.textContent).toContain("No events recorded.");
  });

  it("shows one-line empty states when there is no activity", async () => {
    const container = await mount(
      <MissionControl gateway={agentGateway([])} />
    );
    expect(container.textContent).toContain("Nothing needs you.");
    expect(container.textContent).toContain("No task is running.");
    return expect(container.textContent).toContain("No finished tasks yet.");
  });

  it("loads the sector rotation card from the supplied loader", async () => {
    const snapshot: SectorRotationSnapshot = {
      asOf: "2026-10-30",
      benchmark: "SPY",
      changes: [],
      previousDate: "2026-10-29",
      recentTransitions: [],
      schemaVersion: 1,
      sectors: [],
      timeframe: "daily",
    };
    const load = vi.fn(async () => snapshot);
    const container = await mount(
      <MissionControl gateway={agentGateway([])} sectorRotation={load} />
    );
    expect(load).toHaveBeenCalledTimes(1);
    return expect(container.textContent).toContain(
      "No quadrant changes since 2026-10-29."
    );
  });

  return it("reports storage failures with a retry", async () => {
    const gateway = agentGateway([], {
      summary: vi.fn(async () => {
        throw Object.assign(new Error("x"), { code: "STORAGE_ERROR" });
      }),
    });
    const container = await mount(<MissionControl gateway={gateway} />);
    return expect(
      container.querySelector('[role="alert"]')?.textContent
    ).toContain("Apply migrations 0015 and 0017 if the tables are missing.");
  });
});

describe("agent runs workspace", () => {
  it("creates a task, filters, expands events and changes status with an audit event", async () => {
    const tasks = [task("a", { metrics: { folds: 5 } })];
    const gateway = agentGateway(tasks);
    const container = await mount(
      <AgentRunsWorkspace gateway={gateway} initialTaskId={null} />
    );
    expect(container.querySelectorAll("tbody tr[data-task-id]")).toHaveLength(
      1
    );

    await setValue(
      byLabel<HTMLInputElement>("New task title"),
      "Fit jump model"
    );
    await clickButton("Create task");
    expect(gateway.createTask).toHaveBeenCalledWith({
      agent: "operator",
      kind: "research",
      title: "Fit jump model",
    });
    expect(container.textContent).toContain("Created Fit jump model");

    await setValue(byLabel<HTMLSelectElement>("Filter by status"), "running");
    expect(gateway.listTasks).toHaveBeenLastCalledWith({
      limit: 200,
      status: "running",
    });

    await clickButton("Expand Task a");
    expect(gateway.getTask).toHaveBeenCalledWith("a");
    expect(container.textContent).toContain("fold 3 done");
    expect(container.textContent).toContain("folds");

    await setValue(byLabel<HTMLSelectElement>("Task a status"), "needs_review");
    expect(gateway.updateTask).toHaveBeenCalledWith({
      id: "a",
      status: "needs_review",
    });
    return expect(gateway.appendEvent).toHaveBeenCalledWith({
      level: "info",
      message: "Operator set status queued -> needs_review",
      taskId: "a",
    });
  });

  it("keeps the tasks table inside a positioned scroll box", async () => {
    const container = await mount(
      <AgentRunsWorkspace
        gateway={agentGateway([task("a")])}
        initialTaskId={null}
      />
    );
    const scroll = container.querySelector("[data-agent-tasks-scroll]");
    // The sr-only "Expand" header label is absolutely positioned; the box must contain it.
    expect(scroll?.querySelector("table th .sr-only")?.textContent).toBe(
      "Expand"
    );
    return expect(scroll?.className.split(" ")).toEqual(
      expect.arrayContaining(["relative", "overflow-x-auto"])
    );
  });

  return it("opens the task named by initialTaskId", async () => {
    const gateway = agentGateway([task("a")]);
    await mount(<AgentRunsWorkspace gateway={gateway} initialTaskId="a" />);
    return expect(gateway.getTask).toHaveBeenCalledWith("a");
  });
});

describe("papers workspace", () => {
  it("adds a paper with title and URL, then edits stage, verdict, blockers and metrics inline", async () => {
    let rows = [paper("p1", { blockers: "gamma unknown", kind: "article" })];
    const gateway: PapersGateway = {
      add: vi.fn(async (input) => {
        const created = paper("p2", {
          sourceUrl: input.sourceUrl ?? null,
          title: input.title,
        });
        rows = [...rows, created];
        return created;
      }),
      addFromArxiv: vi.fn(),
      list: vi.fn(async () => rows),
      update: vi.fn(async (input) => {
        const next = {
          ...rows.find((row) => row.id === input.id)!,
          blockers: input.blockers ?? null,
          reproducedMetrics: input.reproducedMetrics ?? {},
          stage: input.stage!,
          verdict: input.verdict!,
        };
        rows = rows.map((row) => (row.id === next.id ? next : row));
        return next;
      }),
    };
    const container = await mount(<PapersWorkspace gateway={gateway} />);
    expect(container.textContent).toContain("gamma unknown");
    expect(container.textContent).toContain("Article");

    await clickButton("Add paper");
    await setValue(byLabel<HTMLInputElement>("Paper title"), "SSRN paper");
    await setValue(
      [...document.querySelectorAll("label")]
        .find((label) => /^Source URL/u.test(label.textContent ?? ""))
        ?.querySelector("input") as HTMLInputElement,
      "https://domain.test/ssrn"
    );
    await clickButton("Save paper");
    expect(gateway.add).toHaveBeenCalledWith({
      sourceUrl: "https://domain.test/ssrn",
      title: "SSRN paper",
    });
    expect(container.querySelectorAll("tbody tr[data-paper-id]")).toHaveLength(
      2
    );

    await clickButton("Edit Paper p1");
    await setValue(byLabel<HTMLSelectElement>("Paper p1 stage"), "implemented");
    await setValue(byLabel<HTMLSelectElement>("Paper p1 verdict"), "promising");
    await setValue(byLabel<HTMLTextAreaElement>("Paper p1 blockers"), "");
    await setValue(
      byLabel<HTMLTextAreaElement>("Paper p1 reproduced metrics"),
      "sharpe=0.5\nsample=2004-2025"
    );
    await clickButton("Save");
    expect(gateway.update).toHaveBeenCalledWith({
      blockers: null,
      id: "p1",
      notes: null,
      reportedMetrics: {},
      reproducedMetrics: { sample: "2004-2025", sharpe: 0.5 },
      stage: "implemented",
      verdict: "promising",
    });
    return expect(
      container.querySelector('[data-paper-id="p1"] [data-stage]')?.textContent
    ).toBe("Implemented");
  });

  return it("rejects a blank title without calling the API", async () => {
    const gateway: PapersGateway = {
      add: vi.fn(),
      addFromArxiv: vi.fn(),
      list: vi.fn(async () => []),
      update: vi.fn(),
    };
    const container = await mount(<PapersWorkspace gateway={gateway} />);
    await clickButton("Add paper");
    await clickButton("Save paper");
    expect(gateway.add).not.toHaveBeenCalled();
    return expect(container.textContent).toContain("Title is required.");
  });
});

describe("metrics text parsing", () =>
  it("parses key=value lines into numbers and strings and reports bad lines", () => {
    expect(parseMetricsText("a=1\nb = x; c=-2.5")).toEqual({
      a: 1,
      b: "x",
      c: -2.5,
    });
    return expect(parseMetricsText("novalue")).toBe("Bad metric line: novalue");
  }));
