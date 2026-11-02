import type {
  VertexResearchChatDebatePrepareOutput,
  VertexResearchChatDebateStepInput,
  VertexResearchChatReadDebateRunOutput,
} from "@darkfactory/api/vertex";
import {
  canonicalArtifactJson,
  decimalUnits,
  timestampToEpochNanoseconds,
} from "@darkfactory/shared/vertex";
import { VertexReadError } from "../../components/research/vertex-client.ts";

export type ResearchDebatePreview = Extract<
  VertexResearchChatDebatePrepareOutput,
  { status: "prepared" }
>["preview"];
export type ResearchDebateRun = Extract<
  VertexResearchChatReadDebateRunOutput,
  { status: "available" }
>;
export type ResearchResponseMode =
  | "one-expert"
  | "stepwise-debate"
  | "first-mate-read-reviewed-evidence-v1";
export type ResearchDebateControls = Readonly<{
  mode: ResearchResponseMode;
  frozen: boolean;
  runKey: string | null;
  metadata: ResearchDebateRun | null;
  canPrepare: boolean;
  onModeChange: (mode: ResearchResponseMode) => void;
  onReadRun: () => void;
}>;
const same = (left: unknown, right: unknown): boolean =>
  canonicalArtifactJson(left) === canonicalArtifactJson(right);
export const researchDebateSpeaker = (
  run: Pick<ResearchDebateRun, "participantIds" | "synthesizerId">,
  ordinal: number
): string =>
  ordinal === 5
    ? run.synthesizerId
    : (run.participantIds[(ordinal - 1) % 2] ?? "");

// Structural correlation only. A valid read/preview NEVER issues independent
// derived-use/privacy reviews, proves publication, or requests computation.
export const assertResearchDebatePreview = (
  preview: ResearchDebatePreview,
  request: VertexResearchChatDebateStepInput
): void => {
  const plan = preview.debate,
    step = request.debate;
  if (
    !same(preview.request, request) ||
    plan.runKey !== step.runKey ||
    plan.ordinal !== step.ordinal ||
    !same(plan.predecessors, step.predecessors) ||
    researchDebateSpeaker(plan, step.ordinal) !== request.participantId
  )
    throw new VertexReadError("malformed");
};

export const assertResearchDebateRun = (run: ResearchDebateRun): void => {
  const steps = run.steps;
  if (
    !run.participantIds.includes(run.synthesizerId) ||
    timestampToEpochNanoseconds(run.checkedAt) >=
      timestampToEpochNanoseconds(run.notAfter)
  )
    throw new VertexReadError("malformed");
  if (
    BigInt(run.aggregateTokens) < 5n * BigInt(run.turnTokens) ||
    decimalUnits(run.aggregateCostUsd) < 5n * decimalUnits(run.turnCostUsd)
  )
    throw new VertexReadError("malformed");
  if (
    !steps.every(
      (step, index) =>
        step.ordinal === index + 1 &&
        step.kind === (step.ordinal === 5 ? "synthesis" : "statement") &&
        step.participantId === researchDebateSpeaker(run, step.ordinal)
    )
  )
    throw new VertexReadError("malformed");
  for (const field of [
    "responseRequestId",
    "idempotencyKey",
    "planId",
  ] as const) {
    if (new Set(steps.map((step) => step[field])).size !== steps.length)
      throw new VertexReadError("malformed");
  }
  // The source protocol reserves/charges the full configured ceiling per turn,
  // including uncertain outcomes. No optimistic refund or Number USD coercion.
  if (
    BigInt(run.chargedTokens) !==
      BigInt(steps.length) * BigInt(run.turnTokens) ||
    BigInt(run.chargedUsdUnits) !==
      BigInt(steps.length) * decimalUnits(run.turnCostUsd)
  )
    throw new VertexReadError("malformed");
  if (
    run.complete &&
    (steps.length !== 5 ||
      steps.some((step) => step.state !== "spent") ||
      run.nextStep !== null)
  )
    throw new VertexReadError("malformed");
  if (run.nextStep !== null) {
    const next = run.nextStep;
    if (
      run.complete ||
      next.runKey !== run.selector.runKey ||
      next.ordinal !== steps.length + 1 ||
      next.predecessors.length !== steps.length ||
      steps.some((step) => step.state !== "spent")
    )
      throw new VertexReadError("malformed");
    if (
      !next.predecessors.every((pin, index) => {
        const step = steps[index];
        return (
          step !== undefined &&
          pin.ordinal === step.ordinal &&
          pin.participantId === step.participantId &&
          pin.responseRequestId === step.responseRequestId &&
          pin.planId === step.planId &&
          pin.planSha256 === step.planSha256
        );
      })
    )
      throw new VertexReadError("malformed");
  }
};

export const assertResearchDebateAnchor = (
  value: ResearchDebateRun | ResearchDebatePreview,
  anchor: ResearchDebatePreview
): void => {
  const plan = "debate" in value ? value.debate : value;
  const original = anchor.debate;
  for (const field of [
    "debateRunId",
    "participantIds",
    "synthesizerId",
    "configuration",
    "humanWindowSha256",
    "turnTokens",
    "turnCostUsd",
    "aggregateTokens",
    "aggregateCostUsd",
  ] as const) {
    if (!same(plan[field], original[field]))
      throw new VertexReadError("malformed");
  }
  if ("debate" in value) {
    if (!same(value.corpus, anchor.corpus))
      throw new VertexReadError("malformed");
  } else if (
    value.selector.runKey !== original.runKey ||
    value.collectionId !== anchor.corpus.collectionId ||
    value.snapshotId !== anchor.corpus.snapshotId
  )
    throw new VertexReadError("malformed");
};
