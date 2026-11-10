"use client";

import { DataTable } from "@darkfactory/ui/client/data-table";
import { useId } from "react";
import type { AgentRun } from "@darkfactory/api/vertex";
import { ResearchTableHeading } from "../../components/research/research-table-heading.tsx";
import type { ImmutableArtifact } from "./ports.ts";
import { experienceTableScroll } from "./experience-table.tsx";

export const AgentRunDetails = ({
  artifact,
}: {
  readonly artifact: ImmutableArtifact<AgentRun>;
}) => {
  const headingId = useId();
  const fields = [
    ["Immutable artifact", artifact.artifactId],
    ["Artifact SHA-256", artifact.sha256],
    ["Task contract", artifact.value.taskContract],
    [
      "Model version",
      artifact.value.modelVersion ?? "Unavailable — no model supplied",
    ],
    ["Allowed tools", artifact.value.allowedTools.join(", ") || "None"],
    ["Token budget", artifact.value.tokenBudget],
    ["Cost budget (USD)", artifact.value.costBudgetUsd],
    [
      "Input evidence",
      artifact.value.inputEvidenceIds.join(", ") ||
        "No evidence bound to this run",
    ],
    [
      "Output artifacts",
      artifact.value.outputArtifactIds.join(", ") || "No output artifacts yet",
    ],
    ["Execution authority", "None"],
  ] as const;
  return (
    <article className="vx-artifact" aria-label={`Run ${artifact.value.runId}`}>
      <div className="vx-artifact-heading">
        <p className="vx-eyebrow">Research job / {artifact.value.agentRole}</p>
        <ResearchTableHeading
          id={headingId}
          title={`Run ${artifact.value.runId}`}
        >
          <p>Queued and running statuses apply only to research work.</p>
          <p>
            Use output artifact identities in Strategies or Data. An ID alone
            never grants access; each destination authorizes the next read.
          </p>
        </ResearchTableHeading>
        <span className="vx-status">{artifact.value.status}</span>
      </div>
      <p className="text-muted-foreground text-sm leading-relaxed">
        This agent cannot grant trading authority. Completed status confirms
        recorded outputs. It does not confirm strategy acceptance or broker
        execution.
      </p>
      <DataTable
        aria-labelledby={headingId}
        caption="Run record — exact source fields"
        className="tabular-nums leading-relaxed [&>caption]:py-4 [&>caption]:text-left [&>caption]:font-semibold [&_:is(th,td)]:max-w-[25rem] [&_:is(th,td)]:[overflow-wrap:anywhere] [&_th]:min-w-36 [&_th]:py-3"
        columns={[
          {
            id: "field",
            header: "Field",
            value: ([label]) => label,
            rowHeader: true,
          },
          {
            id: "value",
            header: "Recorded value",
            value: ([, value]) => value,
            clamp: true,
          },
        ]}
        containerClassName={experienceTableScroll}
        containerProps={{
          role: "region",
          "aria-label": `Run ${artifact.value.runId} fields; scroll horizontally for all fields`,
          // axe scrollable-region-focusable: keyboard users must be able to focus and scroll this overflow region.
          tabIndex: 0,
        }}
        rowKey={([label]) => label}
        rows={fields}
      />
      {artifact.value.errors.length > 0 ? (
        <section role="status">
          <h3>Unresolved run conditions</h3>
          <ul className="vx-requirements">
            {artifact.value.errors.map((error, index) => (
              <li key={index}>
                {error.code}
                {" · "}
                {error.retryable
                  ? "Server marks this retryable; no automatic retry is performed."
                  : "Not retryable."}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {artifact.value.approvalRequests.length > 0 ? (
        <section>
          <h3>Review requests</h3>
          <ul className="vx-requirements">
            {artifact.value.approvalRequests.map((request) => (
              <li key={request.requestId}>
                <strong>{request.kind}</strong>
                <span>{request.requestId}</span>
              </li>
            ))}
          </ul>
          <a className="vx-text-link" href="/strategies">
            Open exact-version strategy review
          </a>
        </section>
      ) : null}
    </article>
  );
};
