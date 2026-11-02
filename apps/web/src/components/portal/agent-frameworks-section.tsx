"use client";

import type { AgentFrameworkOutput } from "@darkfactory/api";
import { Button, SectionHeader, Skeleton } from "@darkfactory/ui";
import { RotateCcw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import {
  type AgentFrameworksGateway,
  createBrowserAgentFrameworksGateway,
  FRAMEWORK_STATUS_LABELS,
  POINT_IN_TIME_LABELS,
} from "./agent-frameworks-client.ts";
import {
  describeModelRunFailure,
  isModelRunForbidden,
} from "./agent-model-runs-client.ts";

export interface AgentFrameworksSectionProps {
  readonly gateway?: AgentFrameworksGateway;
}

type LoadState = Readonly<
  | { phase: "loading" }
  | { phase: "forbidden" }
  | { phase: "error"; message: string }
  | { phase: "ready"; frameworks: readonly AgentFrameworkOutput[] }
>;

const listClass = "list-disc space-y-1 pl-5 text-sm";
const labelClass = "font-medium text-muted-foreground text-xs uppercase";

const ToolList = ({
  label,
  tools,
}: Readonly<{ label: string; tools: readonly string[] }>) =>
  tools.length === 0 ? null : (
    <div className="space-y-1">
      <h4 className={labelClass}>
        {label} ({tools.length})
      </h4>
      <p className="break-words font-mono text-xs">{tools.join(", ")}</p>
    </div>
  );

const FrameworkSheet = ({
  framework,
}: Readonly<{ framework: AgentFrameworkOutput }>) => {
  const headingId = `framework-${framework.id}`;
  return (
    <article
      aria-labelledby={headingId}
      className="min-w-0 space-y-3 rounded-md border border-border p-4 [overflow-wrap:anywhere]"
    >
      <header className="space-y-1">
        <h3 className="font-semibold text-base" id={headingId}>
          {framework.name}
        </h3>
        <p className="text-muted-foreground text-xs">
          {FRAMEWORK_STATUS_LABELS[framework.status]} · Version{" "}
          {framework.version}
          {framework.benchName === null
            ? " · Not in the bench command"
            : ` · Bench arm ${framework.benchName}:provider:model`}
        </p>
      </header>
      <p className="text-sm">{framework.summary}</p>
      <div className="space-y-1">
        <h4 className={labelClass}>Agents and stages</h4>
        <ol className="list-decimal space-y-1 pl-5 text-sm">
          {framework.stages.map((stage) => (
            <li key={stage.name}>
              <span className="font-mono text-xs">{stage.name}</span>:{" "}
              {stage.summary}
            </li>
          ))}
        </ol>
      </div>
      <div className="space-y-1">
        <h4 className={labelClass}>Data</h4>
        <ul className={listClass}>
          {framework.dataSources.map((source) => (
            <li key={source.name}>
              {source.name}.{" "}
              <strong>{POINT_IN_TIME_LABELS[source.pointInTime]}</strong>:{" "}
              {source.note}
            </li>
          ))}
        </ul>
      </div>
      <ToolList label="Tools allowed" tools={framework.toolsAllowed} />
      <ToolList label="Tools excluded" tools={framework.toolsExcluded} />
      <div className="space-y-1">
        <h4 className={labelClass}>Guards</h4>
        <ul className={listClass}>
          {framework.guards.map((guard) => (
            <li key={guard}>{guard}</li>
          ))}
        </ul>
      </div>
      <p className="text-muted-foreground text-xs">
        Code:{" "}
        <span className="break-all font-mono">{framework.code.join(", ")}</span>
        . Licence: {framework.license}
      </p>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
        {framework.links.map((link) => (
          <li key={link.href}>
            <a
              className="underline"
              href={link.href}
              rel="noopener noreferrer"
              target="_blank"
            >
              {link.label}
            </a>
          </li>
        ))}
      </ul>
    </article>
  );
};

export const AgentFrameworksSection = ({
  gateway: suppliedGateway,
}: AgentFrameworksSectionProps) => {
  const [gateway] = useState(
    () => suppliedGateway ?? createBrowserAgentFrameworksGateway()
  );
  const [state, setState] = useState<LoadState>({ phase: "loading" });

  // One request at a time: Retry shows only after a failed request.
  const load = useCallback(async () => {
    setState({ phase: "loading" });
    try {
      setState({ frameworks: await gateway.frameworks(), phase: "ready" });
    } catch (error) {
      setState(
        isModelRunForbidden(error)
          ? { phase: "forbidden" }
          : { message: describeModelRunFailure(error), phase: "error" }
      );
    }
  }, [gateway]);

  useEffect(() => {
    void load();
  }, [load]);

  // The benchmark above already shows the operator access notice.
  if (state.phase === "forbidden") return null;

  return (
    <section aria-label="Frameworks" className="space-y-3">
      <SectionHeader title="Frameworks" />
      <p className="text-muted-foreground text-sm">
        How each agent framework runs in Vertex: its agents, its data and
        whether that data is point in time, and the tools it may use. Ratings
        are research labels.
      </p>
      {state.phase === "loading" ? (
        <div aria-busy="true" role="status">
          <span className="sr-only">Loading the frameworks</span>
          <Skeleton className="h-40 w-full" />
        </div>
      ) : null}
      {state.phase === "error" ? (
        <div className="flex items-center gap-3" role="alert">
          <p className="text-sm">{state.message}</p>
          <Button onClick={() => void load()} variant="secondary">
            <RotateCcw aria-hidden="true" className="size-4" />
            Retry
          </Button>
        </div>
      ) : null}
      {state.phase === "ready" ? (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
          {state.frameworks.map((framework) => (
            <FrameworkSheet framework={framework} key={framework.id} />
          ))}
        </div>
      ) : null}
    </section>
  );
};
