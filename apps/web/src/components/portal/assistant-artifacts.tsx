// What: Cards for the assistant's chart artifacts (chart tool calls): Quant drawings, a clear of those
// drawings, a Vertex script for the editor and a Teach walkthrough stepper. Display only: they reach
// the chart workstation through the chart command bus and never place orders or change settings.
// Used by: apps/web/src/components/portal/assistant-workspace.tsx.
// See: apps/web/src/features/charts/chart-bus.ts; packages/api/src/server/assistant-chart-tools.ts.
"use client";

import {
  type AssistantArtifact,
  AssistantArtifactSchema,
  type AssistantToolTraceOutput,
} from "@darkfactory/api";
import { Button } from "@darkfactory/ui";
import {
  ChevronLeft,
  ChevronRight,
  Code,
  Eraser,
  GraduationCap,
  LineChart,
} from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import {
  currentChartContext,
  sendChartCommand,
} from "../../features/charts/chart-bus.ts";

/** Where the panel is: on /charts (artifacts apply at once) and the symbol the chart shows. */
export type AssistantChartTarget = Readonly<{
  onCharts: boolean;
  symbol: string | null;
}>;

export const NO_CHART_TARGET: AssistantChartTarget = Object.freeze({
  onCharts: false,
  symbol: null,
});

export const isChartsPath = (path: string | undefined): boolean =>
  path === "/charts" || path?.startsWith("/charts/") === true;

export const chartHref = (symbol: string | null): string =>
  symbol === null ? "/charts" : `/charts?symbol=${encodeURIComponent(symbol)}`;

/**
 * The artifacts of a list of tool calls, in call order. Each is checked against the contract
 * again: an unknown kind or a malformed one (an older or newer server) is skipped, never shown.
 */
export const toolArtifacts = (
  calls: readonly AssistantToolTraceOutput[]
): AssistantArtifact[] =>
  calls.flatMap((call) => {
    if (call.artifact === undefined) return [];
    const parsed = AssistantArtifactSchema.safeParse(call.artifact);
    return parsed.success ? [parsed.data] : [];
  });

// A polynomial hash of the artifact's JSON: the same artifact (streamed, then in the stored
// reply) gets the same key, wherever it sits in the trace.
export const artifactKey = (artifact: AssistantArtifact): string => {
  const text = JSON.stringify(artifact);
  let hash = 7;
  for (let index = 0; index < text.length; index += 1)
    hash = (hash * 31 + text.charCodeAt(index)) % 2_147_483_647;
  return `${artifact.kind}:${text.length}:${hash.toString(36)}`;
};

type TeachArtifact = Extract<AssistantArtifact, { kind: "teach" }>;

/** True when the open chart shows the symbol the walkthrough's drawings belong to. */
const teachChartOpen = (artifact: TeachArtifact, onCharts: boolean) => {
  const chart = currentChartContext();
  return (
    onCharts &&
    artifact.symbol !== undefined &&
    chart !== null &&
    chart.symbol.trim().toUpperCase() === artifact.symbol
  );
};

// Shows one step's drawings in the walkthrough's own group: they replace the previous step's
// (a step without drawings clears them) and never touch chart_draw drawings. Only on the
// walkthrough's own chart, and only for a walkthrough that draws at all.
const applyTeachStep = (
  artifact: TeachArtifact,
  index: number,
  onCharts: boolean
): boolean => {
  const drawn = artifact.steps.some(
    (step) => step.drawings !== undefined && step.drawings.length > 0
  );
  if (!(drawn && teachChartOpen(artifact, onCharts))) return false;
  return sendChartCommand({
    drawings: artifact.steps[index]?.drawings ?? [],
    group: "teach",
    replace: true,
    symbol: artifact.symbol ?? "",
    type: "drawings",
  });
};

/**
 * What arriving on /charts does with an artifact: drawings and clears apply, a walkthrough shows
 * its first step's drawings. A script waits for "Open in script editor". Returns false when nothing
 * was sent.
 */
export const autoApplyChartArtifact = (
  artifact: AssistantArtifact,
  target: AssistantChartTarget
): boolean => {
  if (!target.onCharts) return false;
  switch (artifact.kind) {
    case "chart_drawings": {
      return sendChartCommand({
        drawings: artifact.drawings,
        replace: artifact.replace,
        symbol: artifact.symbol,
        type: "drawings",
      });
    }
    case "chart_clear": {
      return sendChartCommand({ symbol: artifact.symbol, type: "clear_quant" });
    }
    case "teach": {
      return applyTeachStep(artifact, 0, target.onCharts);
    }
    default: {
      return false;
    }
  }
};

const CARD =
  "space-y-2 rounded-md border border-border bg-card px-3 py-3 text-sm";

const DrawingsCard = ({
  artifact,
}: Readonly<{
  artifact: Extract<AssistantArtifact, { kind: "chart_drawings" }>;
}>) => {
  const count = artifact.drawings.length;
  return (
    <section
      aria-label={`Chart drawings for ${artifact.symbol}`}
      className={CARD}
      data-artifact="chart_drawings"
    >
      <div className="flex flex-wrap items-center gap-2">
        <LineChart aria-hidden="true" className="size-4 text-primary" />
        <h3 className="font-medium">
          {count} {count === 1 ? "drawing" : "drawings"} on {artifact.symbol}
        </h3>
        {artifact.replace ? (
          <span className="text-muted-foreground text-xs">
            replaces earlier assistant drawings
          </span>
        ) : null}
      </div>
      <ul className="space-y-0.5 text-muted-foreground text-xs">
        {artifact.drawings.map((drawing) => (
          <li className="break-words" key={drawing.id}>
            <span className="font-mono">{drawing.tool}</span>
            {drawing.text.length > 0 ? ` · ${drawing.text}` : ""} ·{" "}
            {drawing.points.map((point) => point.value).join(" → ")}
          </li>
        ))}
      </ul>
      <Button asChild size="sm" variant="secondary">
        <Link
          data-click-label="Show on chart"
          href={chartHref(artifact.symbol)}
          onClick={() =>
            sendChartCommand({
              drawings: artifact.drawings,
              replace: artifact.replace,
              symbol: artifact.symbol,
              type: "drawings",
            })
          }
          prefetch={false}
        >
          <LineChart aria-hidden="true" className="size-4" />
          Show on chart
        </Link>
      </Button>
    </section>
  );
};

const ClearCard = ({
  artifact,
}: Readonly<{
  artifact: Extract<AssistantArtifact, { kind: "chart_clear" }>;
}>) => {
  return (
    <section
      aria-label={`Clear chart drawings for ${artifact.symbol}`}
      className={CARD}
      data-artifact="chart_clear"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Eraser aria-hidden="true" className="size-4 text-primary" />
        <h3 className="font-medium">
          Clear assistant drawings on {artifact.symbol}
        </h3>
      </div>
      <p className="text-muted-foreground text-xs">
        Your own drawings stay. Applies when the chart is open.
      </p>
      <Button asChild size="sm" variant="secondary">
        <Link
          data-click-label="Clear on chart"
          href={chartHref(artifact.symbol)}
          onClick={() =>
            sendChartCommand({ symbol: artifact.symbol, type: "clear_quant" })
          }
          prefetch={false}
        >
          <Eraser aria-hidden="true" className="size-4" />
          Clear on chart
        </Link>
      </Button>
    </section>
  );
};

const ScriptCard = ({
  artifact,
  target,
}: Readonly<{
  artifact: Extract<AssistantArtifact, { kind: "chart_script" }>;
  target: AssistantChartTarget;
}>) => {
  return (
    <section
      aria-label={`Chart script: ${artifact.title}`}
      className={CARD}
      data-artifact="chart_script"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Code aria-hidden="true" className="size-4 text-primary" />
        <h3 className="font-medium">{artifact.title}</h3>
        <span className="text-muted-foreground text-xs">
          {artifact.overlay ? "On the price chart" : "In its own pane"}
        </span>
      </div>
      <details className="text-xs" data-script-preview="">
        <summary className="flex min-h-9 cursor-pointer items-center text-muted-foreground">
          Script source
        </summary>
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all font-mono">
          {artifact.source}
        </pre>
      </details>
      <Button asChild size="sm" variant="secondary">
        <Link
          data-click-label="Open in script editor"
          href={chartHref(target.symbol)}
          onClick={() =>
            sendChartCommand({
              source: artifact.source,
              title: artifact.title,
              type: "script",
            })
          }
          prefetch={false}
        >
          <Code aria-hidden="true" className="size-4" />
          Open in script editor
        </Link>
      </Button>
    </section>
  );
};

const TeachStepper = ({
  artifact,
  target,
}: Readonly<{
  artifact: TeachArtifact;
  target: AssistantChartTarget;
}>) => {
  const [index, setIndex] = useState(0);
  const total = artifact.steps.length;
  const step = artifact.steps[index];
  // Moving to a step shows its drawings on the walkthrough's chart (replacing the previous step's).
  const go = (next: number) => {
    setIndex(next);
    applyTeachStep(artifact, next, target.onCharts);
  };
  if (step === undefined) return null;
  return (
    <section
      aria-label={`Walkthrough: ${artifact.topic}`}
      aria-roledescription="stepper"
      className={CARD}
      data-artifact="teach"
    >
      <div className="flex flex-wrap items-center gap-2">
        <GraduationCap aria-hidden="true" className="size-4 text-primary" />
        <h3 className="font-medium">{artifact.topic}</h3>
        <span
          aria-live="polite"
          className="ml-auto text-muted-foreground text-xs"
          data-teach-position=""
        >
          Step {index + 1} of {total}
        </span>
      </div>
      <div className="space-y-1" data-teach-step={index + 1}>
        <p className="font-medium">{step.title}</p>
        <p className="whitespace-pre-wrap break-words">{step.body}</p>
        {step.drawings !== undefined && step.drawings.length > 0 ? (
          <p className="text-muted-foreground text-xs">
            {teachChartOpen(artifact, target.onCharts)
              ? "Shown on the chart."
              : `Open the ${artifact.symbol ?? ""} chart to see this step's drawings.`}
          </p>
        ) : null}
      </div>
      <div className="flex items-center gap-2">
        <Button
          data-click-label="Back"
          disabled={index === 0}
          onClick={() => go(index - 1)}
          size="sm"
          type="button"
          variant="secondary"
        >
          <ChevronLeft aria-hidden="true" className="size-4" />
          Back
        </Button>
        <Button
          data-click-label="Next"
          disabled={index >= total - 1}
          onClick={() => go(index + 1)}
          size="sm"
          type="button"
          variant="secondary"
        >
          Next
          <ChevronRight aria-hidden="true" className="size-4" />
        </Button>
      </div>
    </section>
  );
};

const AssistantArtifactView = ({
  artifact,
  target,
}: Readonly<{ artifact: AssistantArtifact; target: AssistantChartTarget }>) => {
  switch (artifact.kind) {
    case "chart_drawings": {
      return <DrawingsCard artifact={artifact} />;
    }
    case "chart_clear": {
      return <ClearCard artifact={artifact} />;
    }
    case "chart_script": {
      return <ScriptCard artifact={artifact} target={target} />;
    }
    default: {
      return <TeachStepper artifact={artifact} target={target} />;
    }
  }
};

/** The artifacts of one message's (or the running turn's) tool calls, in call order. */
export const AssistantArtifacts = ({
  artifacts,
  target,
}: Readonly<{
  artifacts: readonly AssistantArtifact[];
  target: AssistantChartTarget;
}>) => {
  if (artifacts.length === 0) return null;
  return (
    <div
      aria-label={`${artifacts.length} chart ${artifacts.length === 1 ? "result" : "results"}`}
      className="space-y-2"
      role="group"
    >
      {artifacts.map((artifact, index) => (
        <AssistantArtifactView
          artifact={artifact}
          // Artifacts never reorder within a message, so the position is a stable key.
          key={`${artifact.kind}-${index}`}
          target={target}
        />
      ))}
    </div>
  );
};
