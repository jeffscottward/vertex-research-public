import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AgentRun } from "@darkfactory/api/vertex";
import type { ImmutableArtifact } from "./ports.ts";

import { AgentRunDetails } from "./agents.tsx";

const hash = "b".repeat(64);
const artifact: ImmutableArtifact<AgentRun> = {
  artifactId: "synthetic-immutable-run",
  sha256: hash,
  value: {
    schemaVersion: "1.0.0",
    runId: "synthetic-run",
    agentRole: "research",
    taskContract: "synthetic-task",
    allowedTools: [],
    modelVersion: null,
    inputEvidenceIds: [],
    outputArtifactIds: [],
    tokenBudget: 0,
    costBudgetUsd: "0.000000001",
    status: "blocked",
    errors: [
      { code: "permission-denied", retryable: false },
      { code: "provider-unavailable", retryable: true },
    ],
    approvalRequests: [
      { requestId: "synthetic-review", kind: "research-review" },
    ],
    executionAuthorized: false,
  },
};
const fieldRow = (label: string, value: string): RegExp =>
  new RegExp(
    `<th[^>]*scope="row"[^>]*>${label}</th><td[^>]*><span class="line-clamp-2">${value}</span></td>`
  );
const withoutHelp = (html: string): string =>
  html.replace(/<aside\b[^>]*popover="auto"[^>]*>[\s\S]*?<\/aside>/g, "");
describe("Agents data-first research records", () => {
  it("renders exact run fields in a named table with supporting help and no fabricated model readiness", () => {
    const html = renderToStaticMarkup(<AgentRunDetails artifact={artifact} />);
    const help =
      html.match(/<aside\b[^>]*popover="auto"[^>]*>[\s\S]*?<\/aside>/)?.[0] ??
      "";
    const headingId = html.match(
      /<h2 id="([^"]+)">Run synthetic-run<\/h2>/
    )?.[1];
    expect(headingId).toBeTruthy();
    expect(html).toContain('aria-label="About Run synthetic-run"');
    expect(html.match(/popovertarget="([^"]+)"/i)?.[1]).toBe(
      `${headingId}-help`
    );
    expect(help).toContain(`aria-labelledby="${headingId}"`);
    expect(help).toContain(
      "Use output artifact identities in Strategies or Data"
    );
    const visible = withoutHelp(html);
    expect(visible).toMatch(
      new RegExp(
        `<table class="[^"]*tabular-nums[^"]*" data-slot="data-table" aria-labelledby="${headingId}">`
      )
    );
    expect(visible).toContain('aria-sort="none" scope="col"');
    expect(visible).toContain(
      'aria-label="Run synthetic-run fields; scroll horizontally for all fields" tabindex="0"'
    );
    for (const text of [
      artifact.artifactId,
      hash,
      "synthetic-task",
      "Unavailable — no model supplied",
      "No evidence bound to this run",
      "No output artifacts yet",
      "0.000000001",
    ]) {
      expect(visible).toContain(text);
    }
    expect(visible).toMatch(fieldRow("Execution authority", "None"));
    expect(visible).toMatch(fieldRow("Token budget", "0"));
    expect(visible).not.toContain("Use output artifact identities");
    return expect(visible).not.toContain("Ready");
  });

  it("keeps blocked status, errors, approval requests and destination actions outside help", () => {
    const visible = withoutHelp(
      renderToStaticMarkup(<AgentRunDetails artifact={artifact} />)
    );
    for (const text of [
      ">blocked</span>",
      "cannot grant trading authority",
      "does not confirm strategy acceptance or broker execution",
      "permission-denied",
      "Not retryable",
      "provider-unavailable",
      "no automatic retry is performed",
      "Unresolved run conditions",
      "Review requests",
      "research-review",
      "synthetic-review",
      'href="/strategies"',
    ]) {
      expect(visible).toContain(text);
    }
  });

  return it("keeps completed outputs as recorded identities without granting execution authority", () => {
    const visible = withoutHelp(
      renderToStaticMarkup(
        <AgentRunDetails
          artifact={{
            ...artifact,
            value: {
              ...artifact.value,
              status: "completed",
              modelVersion: "synthetic-model-v1",
              outputArtifactIds: ["synthetic-output"],
              inputEvidenceIds: ["synthetic-evidence"],
              allowedTools: ["read-evidence"],
              errors: [],
              approvalRequests: [],
            },
          }}
        />
      )
    );
    for (const text of [
      ">completed</span>",
      "synthetic-output",
      "synthetic-evidence",
      "synthetic-model-v1",
      "read-evidence",
      "does not confirm strategy acceptance or broker execution",
    ]) {
      expect(visible).toContain(text);
    }
    expect(visible).toMatch(fieldRow("Execution authority", "None"));
    expect(visible).not.toContain("Unresolved run conditions");
    return expect(visible).not.toContain("Review requests");
  });
});
