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
} from "@darkfactory/api";
import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";

import {
  LAB_AGENT_API_KEYS,
  LAB_AGENT_FRAMEWORKS,
  LAB_AGENT_TASKS,
  LAB_ASSISTANT_THREAD_DETAIL,
  LAB_ASSISTANT_THREADS,
  LAB_DEPLOYMENT_REQUESTS,
  LAB_DEPLOYMENT_STATUS,
  LAB_ENGINES_STATUS,
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
    ["engines", "", "Engines", "demo-signals"],
    ["assistant", "", "Assistant", "Demo momentum v1 review"],
    ["knowledge", "", "Knowledge chat", "VERTEX_KB_CHAT_URL"],
  ])("%s?%s renders %s with fake data", async (id, query, title, fake) => {
    const host = await mount(id, query);
    expect(host.querySelector("h1")?.textContent).toBe(title);
    expect(host.textContent).toContain(fake);
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
    AssistantThreadListOutputSchema.parse(LAB_ASSISTANT_THREADS);
    AssistantThreadGetOutputSchema.parse(LAB_ASSISTANT_THREAD_DETAIL);
  });
});
