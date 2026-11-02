import { z } from "zod";
import {
  canonicalArtifactJson,
  deepFreezeArtifact,
  hashArtifact,
  decimalUnits,
  timestampToEpochNanoseconds as epoch,
} from "@darkfactory/shared/vertex";
import type {
  VertexWorkerBindingSelection,
  VertexWorkerCommand,
} from "./vertex-dispatch/index.ts";
import {
  AgentRunSchema,
  EventEnvelopeSchema,
  IdentifierSchema,
  ResearchEvidenceSchema,
  TimestampSchema,
} from "../contracts/vertex.ts";
import { PaperSimulationAdmissionSchema } from "../contracts/vertex-control.ts";
import {
  parseRuntimePolicySelection,
  type RuntimePolicySelection,
  type PolicyArtifactPin,
} from "../contracts/vertex-policy.ts";
import {
  WorkerBootstrapCommandSchema,
  WorkerScopeSchema,
} from "../contracts/vertex-worker.ts";
import {
  DatasetRecipeSchema,
  IbkrHistoryRecipeSchema,
  GammaResearchRecipeSchema,
  HistoricalRecipeSchema,
  HostBacktestRecipeSchema,
  KnowledgeRecipeSchema,
  ResearchRecipeSchema,
  RecipeScopeSchema,
  QuantExperimentRecipeSchema,
  QUANT_EXPERIMENT_MAX_BYTES,
  SleeveResearchRecipeSchema,
  PaperLabRecipeSchema,
  PaperLabImplementationSchema,
} from "./vertex-runtime-recipe-profiles.ts";
import { WorkerExperimentHandoffSchema } from "../contracts/vertex-worker-experiment.ts";
import { VertexBacktestExpectationSchema } from "../contracts/vertex-experience.ts";
import { present } from "./present.ts";

export class VertexRuntimeRecipeError extends Error {
  readonly code: "unavailable" | "invalid" | "denied" | "integrity";
  constructor(code: VertexRuntimeRecipeError["code"]) {
    super(`Vertex runtime recipe ${code}`);
    this.name = "VertexRuntimeRecipeError";
    this.code = code;
  }
}
export const recipeFail = (code: VertexRuntimeRecipeError["code"]): never => {
  throw new VertexRuntimeRecipeError(code);
};
export const RecipeRouteSchema = z
  .object({
    taskContract: IdentifierSchema,
    kind: z.enum([
      "research-run",
      "dataset-ingest",
      "knowledge-import",
      "backtest",
    ]),
    bindingId: IdentifierSchema,
    ttlMilliseconds: z.number().int().positive().max(86_400_000),
  })
  .strict();
export type VertexRuntimeRecipeRoute = z.infer<typeof RecipeRouteSchema>;
export const RecipeProposalSchema = z
  .object({
    question: z.string().min(1).max(2000),
    evidenceIds: z.array(IdentifierSchema).max(64),
    role: z.enum([
      "research",
      "paper-to-strategy",
      "backtest-review",
      "knowledge-import",
    ]),
    proposalOnly: z.literal(true),
    executionAuthorized: z.literal(false),
    backtestExpectation: VertexBacktestExpectationSchema.optional(),
  })
  .strict();
export type VertexRuntimeRecipeInputs = Readonly<{
  command: VertexWorkerCommand;
  scope: z.infer<typeof WorkerScopeSchema>;
  eventId: string;
  collectionId: string | null;
  selection: unknown;
  now: string;
  route?: VertexRuntimeRecipeRoute;
  configuration?: unknown;
  proposal?: unknown;
  evidence?: readonly unknown[];
  experimentHandoff?: Uint8Array;
  paperLabImplementation?: Uint8Array;
  paper?: Readonly<{
    intentArtifactId: string;
    intentSha256: string;
    strategyArtifact: Readonly<{ artifactId: string; artifactSha256: string }>;
  }>;
}>;
export type VertexRuntimePreparedRecipe = Readonly<{
  binding: VertexWorkerBindingSelection;
  payload: Readonly<Record<string, unknown>>;
  rightsPolicyId: string;
  rightsVersion: string;
}>;
const record = (value: unknown): Record<string, unknown> =>
  z.record(z.string(), z.unknown()).parse(value);
const at = (ns: bigint): string => {
  if (ns < 0n) return recipeFail("invalid");
  const milliseconds = ns / 1_000_000n;
  return new Date(Number(milliseconds))
    .toISOString()
    .replace(
      /\.[0-9]{3}Z$/,
      `.${(ns % 1_000_000_000n).toString().padStart(9, "0")}Z`
    );
};
const deadline = (
  started: string,
  milliseconds: number,
  expires: string
): string => {
  const target = epoch(started) + BigInt(milliseconds) * 1_000_000n;
  return target < epoch(expires) ? at(target) : expires;
};
export const recipeSelectedPin = (
  selection: RuntimePolicySelection,
  route: VertexRuntimeRecipeRoute
): PolicyArtifactPin => {
  const matches = selection.artifacts.filter(
    (value) => value.bindingId === route.bindingId
  );
  // provider-config is reserved for the single native AdapterConfiguration.
  // Job templates are additional explicitly selected tool-config artifacts.
  const expectedRole =
    route.kind === "backtest" ? "simulation-engine" : "tool-config";
  if (matches.length !== 1 || present(matches[0]).role !== expectedRole)
    return recipeFail("unavailable");
  if (
    route.kind === "backtest" &&
    present(matches[0]).artifact.contractName !== "HostBacktestRecipe"
  )
    return recipeFail("invalid");
  return present(matches[0]).artifact;
};
export const quantExperimentHandoffPin = (
  selection: RuntimePolicySelection,
  recipe: z.infer<typeof QuantExperimentRecipeSchema>
): PolicyArtifactPin => {
  const matches = selection.artifacts.filter(
    (row) => row.artifact.artifactId === recipe.handoff.artifactId
  );
  if (
    matches.length !== 1 ||
    present(matches[0]).role !== "tool-config" ||
    present(matches[0]).artifact.contractName !== "WorkerExperimentHandoff" ||
    present(matches[0]).artifact.schemaVersion !== "1.0.0" ||
    present(matches[0]).artifact.artifactSha256 !== recipe.handoff.sha256
  )
    return recipeFail("unavailable");
  return present(matches[0]).artifact;
};
export const paperLabImplementationPin = (
  selection: RuntimePolicySelection,
  recipe: z.infer<typeof PaperLabRecipeSchema>
): PolicyArtifactPin => {
  const matches = selection.artifacts.filter(
    (row) => row.artifact.artifactId === recipe.implementation.artifactId
  );
  if (
    matches.length !== 1 ||
    present(matches[0]).role !== "tool-config" ||
    present(matches[0]).artifact.contractName !==
      "WorkerPaperLabImplementation" ||
    present(matches[0]).artifact.schemaVersion !== "1.0.0" ||
    present(matches[0]).artifact.artifactSha256 !== recipe.implementation.sha256
  )
    return recipeFail("unavailable");
  return present(matches[0]).artifact;
};
export const verifyBacktestExpectation = (
  raw: unknown,
  selection: RuntimePolicySelection,
  route: VertexRuntimeRecipeRoute,
  configuration: unknown,
  actorId: string,
  collectionId: string | null
): void => {
  const expected = VertexBacktestExpectationSchema.parse(raw);
  const recipe = HostBacktestRecipeSchema.parse(configuration);
  const pin = recipeSelectedPin(selection, route);
  const rights = selection.policies.find(
    (value) => value.role === "licensing-rights"
  );
  if (
    selection.environment !== "research" ||
    route.kind !== "backtest" ||
    expected.taskContract !== route.taskContract ||
    expected.bindingId !== route.bindingId ||
    expected.policy.selectionId !== selection.selectionId ||
    expected.policy.selectionSha256 !== selection.selectionSha256 ||
    expected.policy.selectionRevision !== selection.revision ||
    expected.recipe.artifactId !== pin.artifactId ||
    expected.recipe.sha256 !== pin.artifactSha256 ||
    expected.strategy.artifactId !== recipe.strategy.artifactId ||
    expected.strategy.sha256 !== recipe.strategy.sha256 ||
    expected.plannedRun.artifactId !== recipe.run.artifactId ||
    expected.plannedRun.sha256 !== recipe.run.sha256 ||
    recipe.publication.actorId !== actorId ||
    recipe.publication.collectionId !== collectionId ||
    recipe.publication.rightsPolicyId !== rights?.policyId ||
    recipe.publication.rightsVersion !== rights?.version
  )
    recipeFail("denied");
};
const capability = (
  selection: RuntimePolicySelection,
  provider: string,
  operation: string,
  model: string | null,
  now: string
): void => {
  const candidates = selection.providerCapabilities.filter(
    (fact) =>
      fact.providerId === provider &&
      fact.operation === operation &&
      fact.modelVersion === model
  );
  if (
    candidates.length !== 1 ||
    present(candidates[0]).state !== "ready" ||
    epoch(present(candidates[0]).observedAt) > epoch(now) ||
    epoch(present(candidates[0]).expiresAt) <= epoch(now)
  )
    recipeFail("unavailable");
};

// Pure construction: no DB, storage, provider, grants, enqueue or authority mutation.
// Templates are selected immutable policy artifacts, never per-event resolver code.
export const buildVertexRuntimeRecipe = async (
  input: VertexRuntimeRecipeInputs
): Promise<VertexRuntimePreparedRecipe> => {
  canonicalArtifactJson(input.selection);
  const selection = await parseRuntimePolicySelection(input.selection);
  const scope = WorkerScopeSchema.parse(input.scope);
  IdentifierSchema.parse(input.eventId);
  TimestampSchema.parse(input.now);
  if (
    selection.accountAlias !== scope.accountAlias ||
    selection.environment !== scope.environment
  )
    return recipeFail("denied");
  if (
    epoch(selection.issuedAt) > epoch(input.now) ||
    epoch(selection.expiresAt) <= epoch(input.now)
  )
    return recipeFail("unavailable");
  const rights = selection.policies.find(
    (value) => value.role === "licensing-rights"
  );
  if (!rights) return recipeFail("unavailable");
  let payload: Record<string, unknown>;
  let researchPrincipalId: string;
  let deadlineAt: string;
  let kind: VertexWorkerBindingSelection["kind"];
  let bootstrapArtifactId: string | undefined;
  if (input.command.kind === "native-bootstrap") {
    const command = WorkerBootstrapCommandSchema.parse(input.command.bootstrap);
    if (
      scope.environment !== "paper" ||
      command.accountAlias !== scope.accountAlias ||
      command.policySelectionId !== selection.selectionId ||
      command.policySelectionSha256 !== selection.selectionSha256 ||
      command.rightsPolicyId !== rights.policyId ||
      command.rightsVersion !== rights.version ||
      !selection.simulation ||
      command.payload.simulatorId !== selection.simulation.simulatorId
    )
      return recipeFail("denied");
    if (
      input.eventId !== `bootstrap-${await hashArtifact(command)}` ||
      (await hashArtifact(command.payload)) !== command.payloadSha256
    )
      return recipeFail("integrity");
    if (
      epoch(command.issuedAt) > epoch(input.now) ||
      epoch(command.deadlineAt) > epoch(selection.expiresAt)
    )
      return recipeFail("invalid");
    payload = command.payload;
    researchPrincipalId = command.researchPrincipalId;
    deadlineAt = command.deadlineAt;
    bootstrapArtifactId = command.payloadArtifactId;
    kind = "native-bootstrap";
  } else if (input.command.kind === "paper-admission") {
    const command = PaperSimulationAdmissionSchema.parse(
      input.command.admission
    );
    const paper = input.paper;
    if (
      !(paper && selection.simulation) ||
      scope.environment !== "paper" ||
      command.accountAlias !== scope.accountAlias ||
      command.simulatorId !== selection.simulation.simulatorId ||
      command.intentSha256 !== paper.intentSha256
    )
      return recipeFail("unavailable");
    if (
      input.eventId !== `simulation-${await hashArtifact(command)}` ||
      !selection.artifacts.some(
        (row) =>
          row.artifact.artifactId === paper.strategyArtifact.artifactId &&
          row.artifact.artifactSha256 ===
            paper.strategyArtifact.artifactSha256 &&
          row.artifact.contractName === "StrategySpec"
      )
    )
      return recipeFail("integrity");
    if (epoch(command.admittedAt) > epoch(input.now))
      return recipeFail("invalid");
    payload = {
      format: "vertex-paper-job-v1",
      batchIdempotencyKey: command.idempotencyKey,
      legs: [
        {
          intentArtifactId: IdentifierSchema.parse(paper.intentArtifactId),
          intentSha256: command.intentSha256,
          admissionId: command.admissionId,
        },
      ],
      strategyArtifact: paper.strategyArtifact,
    };
    researchPrincipalId = command.actorId;
    deadlineAt =
      epoch(command.expiresAt) < epoch(selection.expiresAt)
        ? command.expiresAt
        : selection.expiresAt;
    kind = "paper-simulation";
  } else {
    const event = EventEnvelopeSchema.parse(input.command.event);
    const run = AgentRunSchema.parse(event.payload);
    const {
      eventId: omittedEventId,
      receivedAt: omittedReceived,
      ...identity
    } = event;
    if (
      event.eventId !== input.eventId ||
      event.eventId !== `event-${await hashArtifact(identity)}` ||
      event.environment !== scope.environment ||
      event.eventType !== "agent.recorded" ||
      run.status !== "queued"
    )
      return recipeFail("invalid");
    if (!input.route || input.configuration === undefined)
      return recipeFail("unavailable");
    const route = RecipeRouteSchema.parse(input.route);
    if (route.taskContract !== run.taskContract) return recipeFail("invalid");
    const pin = recipeSelectedPin(selection, route);
    if ((await hashArtifact(input.configuration)) !== pin.artifactSha256)
      return recipeFail("integrity");
    deadlineAt = deadline(
      event.occurredAt,
      route.ttlMilliseconds,
      selection.expiresAt
    );
    researchPrincipalId = event.actorId;
    kind = route.kind;
    const explicit = run.runId.startsWith("backtest-request-");
    if (
      explicit ||
      (input.proposal !== undefined &&
        Object.hasOwn(record(input.proposal), "backtestExpectation"))
    ) {
      const proposal = RecipeProposalSchema.parse(input.proposal);
      if (
        !(explicit && proposal.backtestExpectation) ||
        proposal.role !== run.agentRole ||
        canonicalArtifactJson(proposal.evidenceIds) !==
          canonicalArtifactJson(run.inputEvidenceIds)
      )
        return recipeFail("integrity");
      verifyBacktestExpectation(
        proposal.backtestExpectation,
        selection,
        route,
        input.configuration,
        event.actorId,
        input.collectionId
      );
    }
    if (
      kind === "research-run" &&
      record(input.configuration)["profile"] === "vertex-paper-lab-recipe-v1"
    ) {
      const recipe = PaperLabRecipeSchema.parse(input.configuration);
      const proposal = RecipeProposalSchema.parse(input.proposal);
      const evidence = (input.evidence ?? []).map((value) =>
        ResearchEvidenceSchema.parse(value)
      );
      if (
        scope.environment !== "research" ||
        pin.contractName !== "WorkerPaperLabRecipe" ||
        pin.schemaVersion !== "1.0.0" ||
        run.agentRole !== "research" ||
        proposal.role !== run.agentRole ||
        recipe.task_contract !== run.taskContract ||
        recipe.collection_id !== input.collectionId ||
        recipe.publication.rightsPolicyId !== rights.policyId ||
        !selection.modules.some(
          (module) => module.moduleId === recipe.module_id && module.enabled
        )
      )
        return recipeFail("denied");
      if (
        selection.artifacts.filter(
          (row) => row.artifact.artifactId === pin.artifactId
        ).length !== 1 ||
        canonicalArtifactJson(recipe) !==
          canonicalArtifactJson(input.configuration)
      )
        return recipeFail("integrity");
      if (
        !(
          run.allowedTools.includes("read-evidence") &&
          run.allowedTools.includes("write-research-artifact")
        ) ||
        canonicalArtifactJson(proposal.evidenceIds) !==
          canonicalArtifactJson(run.inputEvidenceIds)
      )
        return recipeFail("denied");
      const implementationPin = paperLabImplementationPin(selection, recipe);
      if (implementationPin.artifactId === pin.artifactId)
        return recipeFail("integrity");
      const implementationBytes = input.paperLabImplementation;
      if (
        !(implementationBytes instanceof Uint8Array) ||
        implementationBytes.byteLength === 0 ||
        implementationBytes.byteLength > 65_536 ||
        (await hashArtifact(implementationBytes)) !==
          implementationPin.artifactSha256
      )
        return recipeFail("integrity");
      const implementationText = new TextDecoder("utf-8", {
        fatal: true,
      }).decode(implementationBytes);
      const implementation = PaperLabImplementationSchema.parse(
        JSON.parse(implementationText)
      );
      if (canonicalArtifactJson(implementation) !== implementationText)
        return recipeFail("integrity");
      const sources = [recipe.request, ...recipe.inputs];
      if (
        evidence.length !== sources.length ||
        evidence.length !== run.inputEvidenceIds.length ||
        new Set(run.inputEvidenceIds).size !== evidence.length ||
        evidence.some(
          (value, index) => value.evidenceId !== run.inputEvidenceIds[index]
        )
      )
        return recipeFail("integrity");
      if (
        sources.some(
          (source) =>
            source.review.artifactId === pin.artifactId ||
            source.binding.artifactId === pin.artifactId ||
            source.review.artifactId === implementationPin.artifactId ||
            source.binding.artifactId === implementationPin.artifactId
        ) ||
        recipe.publication.evidenceId === pin.artifactId ||
        recipe.publication.evidenceId === implementationPin.artifactId
      )
        return recipeFail("integrity");
      for (const source of sources) {
        const original = evidence.find(
          (value) => value.evidenceId === source.review.evidenceId
        );
        if (
          !original ||
          original.collectionId !== recipe.collection_id ||
          original.snapshotId !== recipe.snapshot_id ||
          original.rightsPolicyId !== source.review.rightsPolicyId ||
          original.contentHash !== source.binding.sha256 ||
          original.sourceIdentity.contentHash !== source.binding.sha256 ||
          (await hashArtifact(original)) !== source.review.artifactSha256
        )
          return recipeFail("integrity");
        if (epoch(original.capturedAt) > epoch(input.now))
          return recipeFail("invalid");
      }
      // Current source acceptance is resolved by the worker, never the embedded
      // immutable status. No paper, model, run or gate is approved by this builder.
      payload = {
        profile: "vertex-paper-lab-job-v1",
        recipe,
        recipeArtifactId: pin.artifactId,
        recipeSha256: pin.artifactSha256,
        implementation,
        run_id: run.runId,
        trace_id: event.correlationId,
        actor_id: event.actorId,
        task_contract: run.taskContract,
        account_alias: scope.accountAlias,
        environment: scope.environment,
        input_evidence_ids: [...run.inputEvidenceIds],
      };
    } else if (
      kind === "research-run" &&
      record(input.configuration)["profile"] === "vertex-sleeve-recipe-v1"
    ) {
      const recipe = SleeveResearchRecipeSchema.parse(input.configuration);
      const proposal = RecipeProposalSchema.parse(input.proposal);
      const evidence = (input.evidence ?? []).map((value) =>
        ResearchEvidenceSchema.parse(value)
      );
      if (
        pin.contractName !== "WorkerSleeveRecipe" ||
        pin.schemaVersion !== "1.0.0" ||
        run.agentRole !== "research" ||
        proposal.role !== run.agentRole ||
        recipe.task_contract !== run.taskContract ||
        recipe.collection_id !== input.collectionId ||
        recipe.publication.rightsPolicyId !== rights.policyId ||
        !selection.modules.some(
          (module) => module.moduleId === recipe.module_id && module.enabled
        )
      )
        return recipeFail("denied");
      if (
        selection.artifacts.filter(
          (row) => row.artifact.artifactId === pin.artifactId
        ).length !== 1 ||
        canonicalArtifactJson(recipe) !==
          canonicalArtifactJson(input.configuration)
      )
        return recipeFail("integrity");
      if (
        !(
          run.allowedTools.includes("read-evidence") &&
          run.allowedTools.includes("write-research-artifact")
        ) ||
        canonicalArtifactJson(proposal.evidenceIds) !==
          canonicalArtifactJson(run.inputEvidenceIds)
      )
        return recipeFail("denied");
      if (
        epoch(recipe.as_of) > epoch(input.now) ||
        epoch(recipe.as_of) % 1000n !== 0n ||
        epoch(recipe.publication.capturedAt) < epoch(recipe.as_of) ||
        epoch(recipe.publication.capturedAt) > epoch(input.now)
      )
        return recipeFail("invalid");
      if (
        recipe.publication.publishedAt !== null &&
        (epoch(recipe.publication.publishedAt) < epoch(recipe.as_of) ||
          epoch(recipe.publication.publishedAt) >
            epoch(recipe.publication.capturedAt))
      )
        return recipeFail("invalid");
      const sources = [...recipe.inputs, ...recipe.dependencies];
      if (
        sources.some(
          (source) =>
            source.review.artifactId === pin.artifactId ||
            source.content.artifactId === pin.artifactId
        ) ||
        recipe.publication.evidenceId === pin.artifactId
      )
        return recipeFail("integrity");
      if (
        recipe.operation === "fundamental-build-dossier" ||
        recipe.operation === "fundamental-review-thesis" ||
        recipe.operation === "fundamental-revise-thesis"
      ) {
        const reference = recipe.parameters.head_profile;
        const heads = selection.artifacts.filter(
          (row) => row.artifact.contractName === "WorkerThesisHeadProfile"
        );
        // A job-selected research head is neither a global newest head nor a
        // review of the proposed candidate. Host reconstructs the complete chain
        // from original separately reviewed dependencies; no accepted head write.
        if (
          heads.length !== 1 ||
          present(heads[0]).role !== "tool-config" ||
          present(heads[0]).artifact.schemaVersion !== "1.0.0" ||
          present(heads[0]).artifact.artifactId !== reference.artifactId ||
          present(heads[0]).artifact.artifactSha256 !== reference.sha256 ||
          selection.artifacts.filter(
            (row) => row.artifact.artifactId === reference.artifactId
          ).length !== 1 ||
          reference.artifactId === pin.artifactId
        )
          return recipeFail("unavailable");
      }
      if (
        evidence.length !== sources.length ||
        evidence.length !== run.inputEvidenceIds.length ||
        new Set(run.inputEvidenceIds).size !== evidence.length ||
        evidence.some(
          (value, index) => value.evidenceId !== run.inputEvidenceIds[index]
        )
      )
        return recipeFail("integrity");
      for (const source of sources) {
        const original = evidence.find(
          (value) => value.evidenceId === source.review.evidenceId
        );
        if (
          !original ||
          original.collectionId !== recipe.collection_id ||
          original.snapshotId !== recipe.snapshot_id ||
          original.rightsPolicyId !== source.review.rightsPolicyId ||
          original.contentHash !== source.content.sha256 ||
          original.sourceIdentity.contentHash !== source.content.sha256 ||
          (await hashArtifact(original)) !== source.review.artifactSha256
        )
          return recipeFail("integrity");
        if (
          epoch(original.capturedAt) > epoch(recipe.as_of) ||
          (original.publishedAt !== null &&
            epoch(original.publishedAt) > epoch(original.capturedAt))
        )
          return recipeFail("invalid");
      }
      // Expected pins are data, never authority: the concrete Host re-resolves
      // every source before invocation and at immutable publication commit.
      payload = {
        profile: "vertex-sleeve-research-v1",
        recipe,
        recipeArtifactId: pin.artifactId,
        recipeSha256: pin.artifactSha256,
        run_id: run.runId,
        trace_id: event.correlationId,
        actor_id: event.actorId,
        task_contract: run.taskContract,
        account_alias: scope.accountAlias,
        environment: scope.environment,
        input_evidence_ids: [...run.inputEvidenceIds],
      };
    } else if (
      kind === "research-run" &&
      record(input.configuration)["profile"] ===
        "vertex-quant-experiment-recipe-v1"
    ) {
      const recipe = QuantExperimentRecipeSchema.parse(input.configuration);
      const proposal = RecipeProposalSchema.parse(input.proposal);
      if (
        pin.contractName !== "WorkerQuantExperimentRecipe" ||
        pin.schemaVersion !== "1.0.0" ||
        pin.artifactId === recipe.handoff.artifactId ||
        run.agentRole !== "research" ||
        proposal.role !== run.agentRole ||
        recipe.task_contract !== run.taskContract ||
        recipe.collection_id !== input.collectionId ||
        recipe.publication.account_alias !== scope.accountAlias ||
        recipe.publication.environment !== scope.environment ||
        recipe.publication.rights_policy_id !== rights.policyId ||
        recipe.publication.rights_version !== rights.version ||
        !selection.modules.some(
          (module) => module.moduleId === recipe.module_id && module.enabled
        )
      )
        return recipeFail("denied");
      if (
        selection.artifacts.filter(
          (row) => row.artifact.artifactId === pin.artifactId
        ).length !== 1
      )
        return recipeFail("integrity");
      if (
        !(
          run.allowedTools.includes("read-evidence") &&
          run.allowedTools.includes("write-research-artifact")
        ) ||
        canonicalArtifactJson(proposal.evidenceIds) !==
          canonicalArtifactJson(run.inputEvidenceIds)
      )
        return recipeFail("denied");
      quantExperimentHandoffPin(selection, recipe);
      const original = input.experimentHandoff;
      if (
        !(original instanceof Uint8Array) ||
        original.byteLength === 0 ||
        original.byteLength > QUANT_EXPERIMENT_MAX_BYTES ||
        (await hashArtifact(original)) !== recipe.handoff.sha256
      )
        return recipeFail("integrity");
      const originalText = new TextDecoder("utf-8", { fatal: true }).decode(
        original
      );
      const handoff = WorkerExperimentHandoffSchema.parse(
        JSON.parse(originalText)
      );
      if (
        canonicalArtifactJson(handoff) !== originalText ||
        handoff.experimentId !== recipe.experiment_id ||
        epoch(handoff.requestedAt) > epoch(input.now)
      )
        return recipeFail("integrity");
      const hashes = new Set([
        handoff.strategy.hash,
        ...handoff.datasets.map((dataset) => dataset.manifestHash),
        ...handoff.hypothesis.citations.map(
          (citation) => citation.artifactHash
        ),
      ]);
      if (
        hashes.size !== recipe.dependency_pins.length ||
        recipe.dependency_pins.some(
          (dependency) => !hashes.has(dependency.artifactSha256)
        ) ||
        !recipe.dependency_pins.some(
          (dependency) =>
            dependency.artifactId === handoff.strategy.id &&
            dependency.artifactSha256 === handoff.strategy.hash
        )
      )
        return recipeFail("integrity");
      const evidence = (input.evidence ?? []).map((value) =>
        ResearchEvidenceSchema.parse(value)
      );
      const citationHashes = new Set(
        handoff.hypothesis.citations.map((citation) => citation.artifactHash)
      );
      if (
        evidence.length !== citationHashes.size ||
        evidence.length !== run.inputEvidenceIds.length ||
        evidence.some(
          (value, index) =>
            value.evidenceId !== run.inputEvidenceIds[index] ||
            value.collectionId !== recipe.collection_id
        )
      )
        return recipeFail("integrity");
      for (const source of evidence) {
        const hash = await hashArtifact(source);
        if (
          !citationHashes.delete(hash) ||
          handoff.hypothesis.citations.some(
            (citation) =>
              citation.artifactHash === hash &&
              citation.sourceId !== source.sourceIdentity.sourceId
          )
        )
          return recipeFail("integrity");
      }
      if (citationHashes.size !== 0) return recipeFail("integrity");
      // Preserve original bytes verbatim. Expected review pins remain data;
      // publishExperiment must resolve current generic authority at commit.
      let binary = "";
      for (const byte of original) binary += String.fromCharCode(byte);
      payload = {
        profile: "vertex-quant-experiment-job-v1",
        recipe,
        recipeArtifactId: pin.artifactId,
        recipeSha256: pin.artifactSha256,
        handoffBase64: btoa(binary),
        run_id: run.runId,
        trace_id: event.correlationId,
        actor_id: event.actorId,
        task_contract: run.taskContract,
        account_alias: scope.accountAlias,
        environment: scope.environment,
        input_evidence_ids: [...run.inputEvidenceIds],
      };
    } else if (
      kind === "research-run" &&
      record(input.configuration)["profile"] === "vertex-gamma-recipe-v1"
    ) {
      const recipe = GammaResearchRecipeSchema.parse(input.configuration);
      const proposal = RecipeProposalSchema.parse(input.proposal);
      const evidence = (input.evidence ?? []).map((value) =>
        ResearchEvidenceSchema.parse(value)
      );
      if (
        run.agentRole !== "research" ||
        proposal.role !== run.agentRole ||
        canonicalArtifactJson(proposal.evidenceIds) !==
          canonicalArtifactJson(run.inputEvidenceIds) ||
        recipe.collection_id !== input.collectionId ||
        recipe.publication.rightsPolicyId !== rights.policyId ||
        !selection.modules.some(
          (module) => module.moduleId === recipe.module_id && module.enabled
        )
      )
        return recipeFail("denied");
      if (
        !(
          run.allowedTools.includes("read-evidence") &&
          run.allowedTools.includes("write-research-artifact")
        )
      )
        return recipeFail("denied");
      if (
        epoch(recipe.as_of) > epoch(input.now) ||
        epoch(recipe.publication.capturedAt) < epoch(recipe.as_of) ||
        epoch(recipe.publication.capturedAt) > epoch(input.now)
      )
        return recipeFail("invalid");
      if (
        evidence.length !== recipe.inputs.length ||
        evidence.length !== run.inputEvidenceIds.length ||
        evidence.some(
          (value, index) => value.evidenceId !== run.inputEvidenceIds[index]
        )
      )
        return recipeFail("integrity");
      for (const source of recipe.inputs) {
        const original = evidence.find(
          (value) => value.evidenceId === source.review.evidenceId
        );
        if (
          !original ||
          original.collectionId !== recipe.collection_id ||
          original.snapshotId !== recipe.snapshot_id ||
          original.rightsPolicyId !== source.review.rightsPolicyId ||
          original.contentHash !== source.binding.sha256 ||
          original.sourceIdentity.contentHash !== source.binding.sha256 ||
          (await hashArtifact(original)) !== source.review.artifactSha256
        )
          return recipeFail("integrity");
      }
      // No model capability, votes, budget consumption or execution authority is
      // synthesized from AgentRun. It is only the existing admitted job command.
      payload = {
        profile: "vertex-gamma-research-v1",
        recipe,
        recipeArtifactId: pin.artifactId,
        recipeSha256: pin.artifactSha256,
        run_id: run.runId,
        trace_id: event.correlationId,
        actor_id: event.actorId,
        task_contract: run.taskContract,
        account_alias: scope.accountAlias,
        environment: scope.environment,
        input_evidence_ids: [...run.inputEvidenceIds],
      };
    } else if (kind === "research-run") {
      const config = selection.research;
      const template = record(input.configuration);
      const request = record(template["request"]);
      const budget = record(request["budget"]);
      const proposal = RecipeProposalSchema.parse(input.proposal);
      if (
        !(
          config &&
          selection.modules.some(
            (module) => module.moduleId === config.moduleId && module.enabled
          )
        ) ||
        proposal.role !== run.agentRole ||
        canonicalArtifactJson(proposal.evidenceIds) !==
          canonicalArtifactJson(run.inputEvidenceIds) ||
        run.modelVersion !== config.modelVersion ||
        run.taskContract !== config.taskContract ||
        run.tokenBudget < 1 ||
        run.tokenBudget > config.tokenBudget ||
        decimalUnits(run.costBudgetUsd) > decimalUnits(config.costBudgetUsd) ||
        run.allowedTools.some((tool) => !config.allowedTools.includes(tool))
      )
        return recipeFail("denied");
      const evidence = (input.evidence ?? []).map((value) =>
        ResearchEvidenceSchema.parse(value)
      );
      if (
        evidence.length !== run.inputEvidenceIds.length ||
        evidence.some(
          (value, index) =>
            value.evidenceId !== run.inputEvidenceIds[index] ||
            value.collectionId !== input.collectionId
        )
      )
        return recipeFail("integrity");
      if (evidence.length === 0) return recipeFail("unavailable");
      const scopes = [
        ...new Map(
          evidence.map((value) => [
            canonicalArtifactJson([value.collectionId, value.snapshotId]),
            RecipeScopeSchema.parse({
              collection_id: value.collectionId,
              snapshot_id: value.snapshotId,
            }),
          ])
        ).values(),
      ];
      // Identity, question, evidence scopes and total budgets come from the
      // durable admitted command; a template cannot enlarge or replace them.
      payload = ResearchRecipeSchema.parse({
        ...template,
        request: {
          ...request,
          run_id: run.runId,
          trace_id: event.correlationId,
          actor_id: event.actorId,
          task_contract: run.taskContract,
          task: proposal.question,
          model_version: run.modelVersion,
          scopes,
          budget: {
            ...budget,
            tokens: run.tokenBudget,
            usd: run.costBudgetUsd,
          },
          reference_ns: epoch(event.occurredAt).toString(),
          deadline_ns: epoch(deadlineAt).toString(),
          account_alias: scope.accountAlias,
          environment: scope.environment,
          allowed_tools: [...run.allowedTools],
        },
      });
      const parsed = ResearchRecipeSchema.parse(payload).request;
      if (
        parsed.budget.attempt_tokens > run.tokenBudget ||
        decimalUnits(parsed.budget.attempt_usd) >
          decimalUnits(run.costBudgetUsd) ||
        BigInt(parsed.per_attempt_timeout_ns) <= 0n ||
        new Set(parsed.phases).size !== parsed.phases.length ||
        new Set(parsed.allowed_tools).size !== parsed.allowed_tools.length
      )
        return recipeFail("invalid");
      const fact = selection.providerCapabilities.find(
        (value) => value.capabilityId === config.modelCapabilityId
      );
      if (!fact) return recipeFail("unavailable");
      capability(
        selection,
        fact.providerId,
        fact.operation,
        config.modelVersion,
        input.now
      );
    } else if (kind === "dataset-ingest") {
      const template = record(input.configuration);
      if (template["profile"] === "vertex-historical-input-v1") {
        const value = HistoricalRecipeSchema.parse(template);
        if (value.input.rights_policy_id !== rights.policyId)
          return recipeFail("denied");
        capability(
          selection,
          "quantpad",
          "historical-authorized-input",
          null,
          input.now
        );
        payload = value;
      } else if (template["profile"] === "vertex-ibkr-history-ingest-v1") {
        const value = IbkrHistoryRecipeSchema.parse(template);
        if (value.publication.rights_policy_id !== rights.policyId)
          return recipeFail("denied");
        if (
          value.request.kind.end_unix_seconds !== null &&
          BigInt(value.request.kind.end_unix_seconds) * 1_000_000_000n >
            epoch(input.now)
        )
          return recipeFail("invalid");
        capability(selection, "ibkr", "historical-bars", null, input.now);
        payload = value;
      } else {
        const value = DatasetRecipeSchema.parse(template);
        if (
          value.provider === "quantdata" &&
          ["news", "dark-pool", "dealer-analytics"].includes(value.operation)
        )
          return recipeFail("unavailable");
        if (
          value.sourceContext.as_of_at !== value.publication.as_of_at ||
          epoch(value.publication.start_at) > epoch(value.publication.end_at)
        )
          return recipeFail("invalid");
        capability(selection, value.provider, value.operation, null, input.now);
        payload = value;
      }
    } else if (kind === "knowledge-import") {
      const value = KnowledgeRecipeSchema.parse(input.configuration);
      if (
        value.collection_id !== input.collectionId ||
        value.rights_policy_id !== rights.policyId ||
        run.agentRole !== "knowledge-import"
      )
        return recipeFail("denied");
      payload = value;
    } else {
      // Validate the exact reviewed v2 quote or v3 historical-Bar configuration
      // without rewriting model/original bytes or granting PIT/OOS authority.
      const value = HostBacktestRecipeSchema.parse(input.configuration);
      if (
        value.publication.actorId !== event.actorId ||
        value.publication.collectionId !== input.collectionId ||
        value.publication.rightsPolicyId !== rights.policyId ||
        value.publication.rightsVersion !== rights.version
      )
        return recipeFail("denied");
      payload = {
        format: "vertex-backtest-job-v1",
        recipeArtifactId: pin.artifactId,
        recipeSha256: pin.artifactSha256,
      };
    }
  }
  if (epoch(deadlineAt) <= epoch(input.now)) return recipeFail("unavailable");
  const bytes = new TextEncoder().encode(canonicalArtifactJson(payload));
  if (bytes.byteLength === 0 || bytes.byteLength > 1_048_576)
    return recipeFail("invalid");
  const payloadSha256 = await hashArtifact(bytes);
  // Per-command identity avoids cross-job stage collisions for equal payloads.
  const payloadArtifactId =
    bootstrapArtifactId ??
    `payload-${await hashArtifact({ scope, eventId: input.eventId, payloadSha256 })}`;
  return deepFreezeArtifact({
    payload,
    rightsPolicyId: rights.policyId,
    rightsVersion: rights.version,
    binding: {
      kind,
      researchPrincipalId,
      payloadArtifactId,
      payloadSha256,
      policySelectionId: selection.selectionId,
      policySelectionSha256: selection.selectionSha256,
      deadlineAt,
    },
  });
};
