// @vitest-environment jsdom
import {
  AgentApiKeysListOutputSchema,
  AgentFrameworksOutputSchema,
  AgentModelBenchmarkOutputSchema,
  AgentModelRunBreakdownOutputSchema,
  AgentModelRunGetOutputSchema,
  AgentModelRunListOutputSchema,
  AgentTaskGetOutputSchema,
  AgentTaskListOutputSchema,
  AssistantThreadGetOutputSchema,
  AssistantThreadListOutputSchema,
  DeploymentRequestSchema,
  DeploymentStatusOutputSchema,
  EnginesStatusOutputSchema,
  GoLiveQueueOutputSchema,
} from "@darkfactory/api";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  LAB_AGENT_API_KEYS,
  LAB_AGENT_FRAMEWORKS,
  LAB_AGENT_TASKS,
  LAB_ASSISTANT_THREAD_DETAIL,
  LAB_ASSISTANT_THREADS,
  LAB_DEPLOYMENT_REQUESTS,
  LAB_DEPLOYMENT_STATUS,
  LAB_ENGINES_STATUS,
  LAB_GOLIVE_QUEUE,
  LAB_MODEL_BENCHMARK,
  LAB_MODEL_RUN_BREAKDOWN,
  LAB_MODEL_RUN_FACETS,
  LAB_MODEL_RUNS,
  labAgentTaskEvents,
  labModelRunPage,
} from "../fixtures/automation.ts";
import { findLabEntry } from "../registry.ts";
import { mountLab, unmountLab } from "../test-support.tsx";
import {
  AUTOMATION_LAB_ENTRIES,
  createLabGoLiveDraftsGateway,
  labAgentOpsGateway,
  labDeploymentRequestsGateway,
  labDeploymentStrategies,
  labModelRunsGateway,
} from "./automation.tsx";

afterEach(async () => {
  await unmountLab();
  window.history.replaceState(null, "", "/");
});

const mount = async (id: string, query = "") => {
  const entry = findLabEntry(AUTOMATION_LAB_ENTRIES, id);
  if (entry === undefined) throw new Error(`missing ${id}`);
  window.history.replaceState(null, "", `/lab/${id}?${query}`);
  return mountLab(entry.render(new URLSearchParams(query)));
};

describe("automation lab entries", () => {
  it.each([
    ["agents", "", "Agent runs", "Demo momentum v1 backtest"],
    ["agents", "", "Agent runs", "Demo research agent"],
    ["agents", "", "Agent runs", "demo-model-large"],
    ["agents-benchmark", "", "Model benchmark", "demo-model-small"],
    ["agents-benchmark", "", "Model benchmark", "Demo Agents"],
    ["agent-run", "", "NVDA · 2026-10-29 · demo_agents", "Demo market analyst"],
    ["agent-run", "id=lab-run-2", "SPY · 2026-10-29 · demo_agents", "SPY"],
    ["deployments", "", "Deployments", "Demo momentum v1"],
    ["deployments", "tab=services", "Deployments", "demo-collector"],
    ["deployments", "view=requests", "Deployments", "Demo momentum v1"],
    ["drafts", "", "Order drafts", "Demo go-live allocation"],
    ["engines", "", "Engines", "demo-signals"],
    ["assistant", "", "Assistant", "Demo momentum v1 review"],
    ["knowledge", "", "Knowledge chat", "VERTEX_KB_CHAT_URL"],
  ])("%s?%s renders %s with fake data", async (id, query, title, fake) => {
    const host = await mount(id, query);
    expect(host.querySelector("h1")?.textContent).toBe(title);
    expect(host.textContent).toContain(fake);
  });

  it("shows the order drafts page from a fake queue without calling the network", async () => {
    const network = vi.fn(() =>
      Promise.reject(new Error("no network in the lab"))
    );
    vi.stubGlobal("fetch", network);
    try {
      const host = await mount("drafts");
      const text = host.textContent ?? "";
      expect(text).toContain("This page sends no orders.");
      expect(text).toContain(
        "Plan approved by delegation (the owner delegated the allocation choice)"
      );
      expect(text).toContain("Account value: $250,000 as of 2026-10-30");
      expect(text).toContain("Node running, disarmed");
      expect(text).toContain("Yahoo, 15 min delayed, indicative");
      expect(
        [...host.querySelectorAll("[data-golive-plan] a")].map((link) =>
          link.getAttribute("href")
        )
      ).toEqual([
        "https://discord.com/channels/0/0/0",
        "https://example.com/demo-golive-evidence",
      ]);
      // The one draft is a late entry the model holds: listed, never approvable.
      const row = host.querySelector(
        "[data-golive-group='golive-group-model-holds'] [data-golive-draft]"
      );
      const approve = row?.querySelector<HTMLButtonElement>(
        "[data-golive-action='approve']"
      );
      expect(approve?.disabled).toBe(true);
      expect(
        row?.querySelector("[data-golive-action='reject']")
      ).not.toBeNull();
      expect(network).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("records a rejection in the lab page's own memory and shows it, with no network-failure sentence", async () => {
    const network = vi.fn(() =>
      Promise.reject(new Error("no network in the lab"))
    );
    vi.stubGlobal("fetch", network);
    try {
      const host = await mount("drafts");
      const press = async (name: string): Promise<void> => {
        const found = [...document.querySelectorAll("button")].find(
          (item) =>
            (item.getAttribute("aria-label") ?? item.textContent) === name
        );
        if (found === undefined) throw new Error(`No button named ${name}`);
        await act(async () => found.click());
      };
      await press("Reject SPY 2026-12-18");
      const note = document.querySelector("textarea");
      if (note === null) throw new Error("the reject dialog has a note");
      await act(async () => {
        Object.getOwnPropertyDescriptor(
          HTMLTextAreaElement.prototype,
          "value"
        )?.set?.call(note, "Dummy rejection.");
        note.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await press("Record rejection");
      for (let turn = 0; turn < 5; turn += 1)
        await act(async () => Promise.resolve());
      expect(document.querySelector("[role='dialog']")).toBeNull();
      const row = host.querySelector("[data-golive-draft='lab-draft-1']");
      expect(row?.getAttribute("data-golive-draft-state")).toBe("rejected");
      expect(row?.textContent).toContain("Rejected by the owner (recorded)");
      expect(row?.textContent).toContain("Decision noteDummy rejection.");
      expect(row?.querySelector("button")).toBeNull();
      expect(host.textContent).not.toContain("No answer came back");
      expect(host.querySelector("[data-golive-decision-notice]")).toBeNull();
      expect(network).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
    // The decision lived in that page only: the next visit starts from the fixture again.
    const again = await mount("drafts");
    expect(
      again
        .querySelector("[data-golive-draft='lab-draft-1']")
        ?.getAttribute("data-golive-draft-state")
    ).toBe("proposed");
  });

  it("answers order draft decisions in memory and never changes the fixture", async () => {
    const { signal } = new AbortController();
    const gateway = createLabGoLiveDraftsGateway();
    await expect(gateway.queue({ signal })).resolves.toEqual(LAB_GOLIVE_QUEUE);
    const [draft] = LAB_GOLIVE_QUEUE.drafts;
    const order = draft?.order ?? null;
    if (draft === undefined || order === null)
      throw new Error("the fake draft has an order");

    // The model-held draft cannot be approved, as on the real server: the refusal names why.
    await expect(
      gateway.approve({
        confirm: true,
        id: draft.id,
        order,
        revision: draft.revision,
      })
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message:
        "Draft cannot be approved: LATE_ENTRY_NOT_TESTED, NO_LIVE_IBKR_QUOTE",
    });
    await expect(
      gateway.reject({ id: "nope", note: "No." })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    const rejected = await gateway.reject({ id: draft.id, note: "No." });
    expect(rejected).toMatchObject({
      decidedBy: "demo-owner",
      decisionNote: "No.",
      id: draft.id,
      state: "rejected",
    });
    expect(rejected.notApprovable).toContain("DRAFT_NOT_PROPOSED");
    expect(rejected.approvedRoom).toBeNull();
    expect(rejected.revision).toBe(draft.revision + 1);
    GoLiveQueueOutputSchema.parse(await gateway.queue({ signal }));
    expect((await gateway.queue({ signal })).drafts[0]?.state).toBe("rejected");
    // A second decision on the same draft is refused like the server refuses it.
    await expect(
      gateway.reject({ id: draft.id, note: "Again." })
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: "The draft is no longer proposed",
    });

    // Only this gateway's copy changed.
    expect(draft.state).toBe("proposed");
    expect(
      (await createLabGoLiveDraftsGateway().queue({ signal })).drafts[0]?.state
    ).toBe("proposed");
  });

  it("stores the order with an approval of a dummy draft that can be approved", async () => {
    const { signal } = new AbortController();
    const [draft] = LAB_GOLIVE_QUEUE.drafts;
    const order = draft?.order ?? null;
    if (draft === undefined || order === null)
      throw new Error("the fake draft has an order");
    const gateway = createLabGoLiveDraftsGateway({
      ...LAB_GOLIVE_QUEUE,
      drafts: [{ ...draft, entryBasis: "signal_today", notApprovable: [] }],
    });
    // Another revision than the one the caller saw is refused, like on the server.
    await expect(
      gateway.approve({
        confirm: true,
        id: draft.id,
        order,
        revision: draft.revision + 1,
      })
    ).rejects.toMatchObject({ code: "CONFLICT" });
    const approved = await gateway.approve({
      confirm: true,
      id: draft.id,
      order,
      revision: draft.revision,
    });
    expect(approved).toMatchObject({
      approvedOrder: order,
      // The room held is the max loss of the approved order.
      approvedRoom: {
        maxLoss: draft.sizing.maxLoss,
        maxLossPctNlv: draft.sizing.maxLossPctNlv,
      },
      nodeBadgeAtDecision: "running-disarmed",
      // Every write to a draft adds 1 to its revision.
      revision: draft.revision + 1,
      state: "approved",
    });
    GoLiveQueueOutputSchema.parse(await gateway.queue({ signal }));
  });

  it("opens the fake assistant thread", async () => {
    const host = await mount("assistant");
    const button = [...host.querySelectorAll("button")].find((item) =>
      item.textContent?.includes("Demo momentum v1 review")
    );
    await act(async () => button?.click());
    await act(async () => Promise.resolve());
    expect(host.textContent).toContain("12.4% on SPY");
  });

  it("serves fake gateway reads and refuses unknown ids", async () => {
    const task = await labAgentOpsGateway.getTask("lab-task-1");
    expect(task.events).toHaveLength(1);
    await expect(labAgentOpsGateway.getTask("nope")).rejects.toThrow("UI lab");
    const request = await labDeploymentRequestsGateway.get("lab-request-1");
    expect(request.strategyName).toBe("Demo momentum v1");
    await expect(labDeploymentRequestsGateway.get("nope")).rejects.toThrow(
      "UI lab"
    );
    expect((await labModelRunsGateway.events("lab-run-3", 0)).run.ticker).toBe(
      "AAPL"
    );
    expect((await labModelRunsGateway.search("x", {})).results).toEqual([]);
    expect(
      (await labModelRunsGateway.breakdown({}, "model")).rows
    ).toHaveLength(2);
    expect(await labDeploymentStrategies.list()).toEqual([]);
    expect(labModelRunPage("unknown").run.id).toBe("lab-run-1");
  });

  it("fixtures match the API output schemas", () => {
    AgentTaskListOutputSchema.parse({ tasks: [...LAB_AGENT_TASKS] });
    AgentTaskGetOutputSchema.parse({
      events: labAgentTaskEvents("lab-task-1"),
      task: LAB_AGENT_TASKS[0],
    });
    AgentModelRunListOutputSchema.parse({
      facets: LAB_MODEL_RUN_FACETS,
      nextCursor: null,
      runs: [...LAB_MODEL_RUNS],
    });
    AgentModelRunBreakdownOutputSchema.parse(LAB_MODEL_RUN_BREAKDOWN);
    AgentModelRunGetOutputSchema.parse(labModelRunPage("lab-run-1"));
    AgentModelBenchmarkOutputSchema.parse(LAB_MODEL_BENCHMARK);
    AgentFrameworksOutputSchema.parse({
      frameworks: [...LAB_AGENT_FRAMEWORKS],
    });
    AgentApiKeysListOutputSchema.parse({ keys: [...LAB_AGENT_API_KEYS] });
    DeploymentStatusOutputSchema.parse(LAB_DEPLOYMENT_STATUS);
    for (const request of LAB_DEPLOYMENT_REQUESTS)
      DeploymentRequestSchema.parse(request);
    EnginesStatusOutputSchema.parse(LAB_ENGINES_STATUS);
    // The queue is what the API would answer: dummy plan, one model-held draft, delayed quote.
    const queue = GoLiveQueueOutputSchema.parse(LAB_GOLIVE_QUEUE);
    expect(queue.canDecide).toBe(true);
    expect(queue.sendsOrders).toBe(false);
    expect(queue.node.badge).toBe("running-disarmed");
    expect(queue.plan?.approvalBasis).toBe("owner_delegation");
    expect(
      queue.drafts.map((draft) => [draft.entryBasis, draft.quote?.source])
    ).toEqual([["model_holds_account_does_not", "yahoo_delayed_snapshot"]]);
    AssistantThreadListOutputSchema.parse(LAB_ASSISTANT_THREADS);
    AssistantThreadGetOutputSchema.parse(LAB_ASSISTANT_THREAD_DETAIL);
  });
});
