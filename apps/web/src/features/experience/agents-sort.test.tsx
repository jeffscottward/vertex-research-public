// @vitest-environment jsdom
import type { AgentRun } from "@darkfactory/api/vertex";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";

import { AgentRunDetails } from "./agents.tsx";
import type { ImmutableArtifact } from "./ports.ts";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const artifact: ImmutableArtifact<AgentRun> = {
  artifactId: "synthetic-immutable-run",
  sha256: "c".repeat(64),
  value: {
    schemaVersion: "1.0.0",
    runId: "synthetic-run",
    agentRole: "research",
    taskContract: "synthetic-task",
    allowedTools: ["read-evidence"],
    modelVersion: "synthetic-model-v1",
    inputEvidenceIds: [],
    outputArtifactIds: [],
    tokenBudget: 0,
    costBudgetUsd: "0.5",
    status: "completed",
    errors: [],
    approvalRequests: [],
    executionAuthorized: false,
  },
};

describe("AgentRunDetails sortable run record", () => {
  return it("sorts fields and recorded values from keyboard-operable headers", () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    act(() => root.render(<AgentRunDetails artifact={artifact} />));
    const rowLabels = () =>
      [...container.querySelectorAll("tbody th")].map(
        (cell) => cell.textContent
      );
    const [field, value] = [...container.querySelectorAll("thead button")];

    act(() => (field as HTMLButtonElement).click());
    expect(rowLabels()[0]).toBe("Allowed tools");
    act(() => (value as HTMLButtonElement).click());
    // Numeric values sort numerically ahead of text: 0, then 0.5.
    expect(rowLabels().slice(0, 2)).toEqual([
      "Token budget",
      "Cost budget (USD)",
    ]);
    expect(
      container
        .querySelector("thead th:nth-child(2)")
        ?.getAttribute("aria-sort")
    ).toBe("ascending");
    act(() => root.unmount());
    return container.remove();
  });
});
