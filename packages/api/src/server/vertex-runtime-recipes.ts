import type { z } from "zod";
import {
  canonicalArtifactJson,
  hashArtifact,
  timestampToEpochNanoseconds as epoch,
} from "@darkfactory/shared/vertex";
import type { Database, Transaction } from "@darkfactory/db/server";
import type {
  VertexArtifactMetadata,
  VertexPrincipal,
  VertexScope,
  VertexStore,
} from "@darkfactory/db/server/vertex";
import type { VertexWorkerStore } from "@darkfactory/db/server/vertex-worker";
import type { ResearchChatWorkerOperations } from "@darkfactory/db/server/vertex-research-chat-runtime";
import type {
  ArtifactPin,
  PolicyRegistry,
  PolicyScope,
} from "@darkfactory/config/vertex";
import type { VertexObjectCapabilities } from "@darkfactory/storage";
import type {
  VertexWorkerBindingResolver,
  VertexWorkerBindingSelection,
} from "./vertex-dispatch/index.ts";
import {
  AgentRunSchema,
  BacktestRunSchema,
  ResearchEvidenceSchema,
  StrategySpecSchema,
  TradeIntentSchema,
} from "../contracts/vertex.ts";
import { PaperSimulationAdmissionSchema } from "../contracts/vertex-control.ts";
import {
  parseRuntimePolicySelection,
  type RuntimePolicySelection,
} from "../contracts/vertex-policy.ts";
import {
  WorkerBootstrapCommandSchema,
  WorkerScopeSchema,
} from "../contracts/vertex-worker.ts";
import {
  buildVertexRuntimeRecipe,
  verifyBacktestExpectation,
  quantExperimentHandoffPin,
  paperLabImplementationPin,
  recipeFail,
  recipeSelectedPin,
  RecipeProposalSchema,
  RecipeRouteSchema,
  type VertexRuntimeRecipeInputs,
  type VertexRuntimeRecipeRoute,
} from "./vertex-runtime-recipe-build.ts";
import {
  QuantExperimentRecipeSchema,
  QUANT_EXPERIMENT_MAX_BYTES,
  PaperLabRecipeSchema,
  HostBacktestRecipeSchema,
} from "./vertex-runtime-recipe-profiles.ts";
import { AcceptedReviewSchema } from "../contracts/vertex-control.ts";
import type {
  VertexExperienceDependencies,
  VertexExperiencePolicyIdentity,
} from "./vertex-experience-core.ts";
import { present } from "./present.ts";

export type VertexRuntimeRecipesOptions = Readonly<{
  db: Database;
  store: Pick<
    VertexStore,
    | "findArtifact"
    | "findRecordArtifact"
    | "findEvidence"
    | "getRights"
    | "listReviews"
  >;
  workerStore: Pick<
    VertexWorkerStore,
    "prepareOutboxPayload" | "readResearchProposal"
  >;
  policyRegistry: Pick<PolicyRegistry, "readHead" | "materialize">;
  // Concrete sibling RuntimePolicy reader: checks selected catalog/stage pin,
  // exact actor/scope rights, bounded object bytes and canonical digest in tx.
  readSelectedArtifact: (
    tx: Transaction,
    principal: VertexPrincipal,
    scope: PolicyScope,
    pin: ArtifactPin
  ) => Promise<Uint8Array>;
  objectCapabilities: (scope: VertexScope) => VertexObjectCapabilities;
  clock: Readonly<{ now: () => string }>;
  consumerServiceId: string;
  routes: readonly VertexRuntimeRecipeRoute[];
  chatWorker?: ResearchChatWorkerOperations;
}>;
type DispatchInput = Parameters<VertexWorkerBindingResolver>[0];
export type VertexRuntimeRecipes = Readonly<{
  resolveBinding: VertexWorkerBindingResolver;
  prepareJob: (
    input: DispatchInput,
    selection: RuntimePolicySelection
  ) => Promise<VertexWorkerBindingSelection | null>;
  validateBacktestRequest: NonNullable<
    VertexExperienceDependencies["validateBacktestRequest"]
  >;
}>;

// Construction is inert. Validation only reads selected reviewed sources;
// staging requires the existing dispatcher's already claimed outbox command.
export const createVertexRuntimeRecipes = (
  options: VertexRuntimeRecipesOptions
): VertexRuntimeRecipes => {
  const routes = new Map<string, VertexRuntimeRecipeRoute>();
  if (!Array.isArray(options.routes) || options.routes.length > 128)
    return recipeFail("invalid");
  for (const raw of options.routes) {
    canonicalArtifactJson(raw);
    const route = Object.freeze(RecipeRouteSchema.parse(raw));
    if (routes.has(route.taskContract)) return recipeFail("invalid");
    routes.set(route.taskContract, route);
  }
  const rightsCurrent = async (
    principal: VertexPrincipal,
    metadata: VertexArtifactMetadata
  ): Promise<void> => {
    const rights = await options.store.getRights(
      principal,
      metadata.scope,
      metadata.collectionId,
      metadata.rights.policyId
    );
    const now = epoch(options.clock.now());
    if (
      !rights ||
      rights.policyId !== metadata.rights.policyId ||
      rights.version !== metadata.rights.version ||
      rights.status !== "granted" ||
      !rights.allowedUses.includes("read") ||
      epoch(rights.checkedAt) > now ||
      (rights.expiresAt !== null && epoch(rights.expiresAt) <= now) ||
      (rights.retentionUntil !== null && epoch(rights.retentionUntil) <= now)
    )
      recipeFail("denied");
  };
  const readRecord = async <T>(
    principal: VertexPrincipal,
    scope: VertexScope,
    metadata: VertexArtifactMetadata,
    schema: z.ZodType<T>,
    contract: string
  ): Promise<T> => {
    if (
      metadata.scope.accountAlias !== scope.accountAlias ||
      metadata.scope.environment !== scope.environment ||
      metadata.contractName !== contract ||
      metadata.byteLength < 1 ||
      metadata.byteLength > 1_048_576
    )
      return recipeFail("integrity");
    await rightsCurrent(principal, metadata);
    const get = options.objectCapabilities(scope).getBounded;
    if (!get) return recipeFail("unavailable");
    const result = await get(metadata.objectKey, 1_048_576);
    if (result.status !== "ok") return recipeFail("unavailable");
    const bytes = result.value.body;
    if (
      !(bytes instanceof Uint8Array) ||
      bytes.byteLength !== metadata.byteLength ||
      result.value.metadata.key !== metadata.objectKey ||
      result.value.metadata.size !== bytes.byteLength ||
      (await hashArtifact(bytes)) !== metadata.artifactSha256
    )
      return recipeFail("integrity");
    const raw: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    );
    if ((await hashArtifact(raw)) !== metadata.artifactSha256)
      return recipeFail("integrity");
    const value = schema.parse(raw);
    const current = await options.store.findArtifact(
      principal,
      scope,
      metadata.collectionId,
      metadata.artifactId
    );
    if (
      !current ||
      current.artifactSha256 !== metadata.artifactSha256 ||
      current.rights.version !== metadata.rights.version ||
      current.objectKey !== metadata.objectKey
    )
      return recipeFail("integrity");
    await rightsCurrent(principal, current);
    return value;
  };
  const readSelectedBacktest = async (
    principal: VertexPrincipal,
    scope: VertexScope,
    taskContract: string,
    policy: Pick<
      VertexExperiencePolicyIdentity,
      "selectionId" | "selectionSha256" | "selectionRevision"
    >
  ) => {
    const route = routes.get(taskContract);
    if (route?.kind !== "backtest" || scope.environment !== "research")
      return recipeFail("unavailable");
    const selectedScope = WorkerScopeSchema.parse(scope);
    const selection = await parseRuntimePolicySelection(
      await options.policyRegistry.materialize(
        principal,
        {
          ...selectedScope,
          selectionId: policy.selectionId,
          selectionSha256: policy.selectionSha256,
        },
        options.consumerServiceId
      )
    );
    if (
      selection.selectionId !== policy.selectionId ||
      selection.selectionSha256 !== policy.selectionSha256 ||
      selection.revision !== policy.selectionRevision
    )
      return recipeFail("denied");
    const observedAt = epoch(options.clock.now());
    if (
      selection.accountAlias !== scope.accountAlias ||
      selection.environment !== scope.environment ||
      epoch(selection.issuedAt) > observedAt ||
      epoch(selection.expiresAt) <= observedAt
    )
      return recipeFail("denied");
    const pin = recipeSelectedPin(selection, route);
    const bytes = await options.db.transaction((tx) =>
      options.readSelectedArtifact(tx, principal, selectedScope, pin)
    );
    if (
      !(bytes instanceof Uint8Array) ||
      bytes.byteLength === 0 ||
      bytes.byteLength > 1_048_576 ||
      (await hashArtifact(bytes)) !== pin.artifactSha256
    )
      return recipeFail("integrity");
    const original: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    );
    if ((await hashArtifact(original)) !== pin.artifactSha256)
      return recipeFail("integrity");
    return { selectedScope, selection, route, pin, original };
  };
  const validateBacktestRequest: VertexRuntimeRecipes["validateBacktestRequest"] =
    async (principal, scope, collectionId, expectation) => {
      const { selectedScope, selection, route, original } =
        await readSelectedBacktest(
          principal,
          scope,
          expectation.taskContract,
          expectation.policy
        );
      verifyBacktestExpectation(
        expectation,
        selection,
        route,
        original,
        principal.actorId,
        collectionId
      );
      const recipe = HostBacktestRecipeSchema.parse(original);
      const strategy = await options.store.findRecordArtifact(
        principal,
        scope,
        { artifactId: recipe.strategy.artifactId, contractName: "StrategySpec" }
      );
      const planned = await options.store.findRecordArtifact(principal, scope, {
        artifactId: recipe.run.artifactId,
        contractName: "BacktestRun",
      });
      if (
        !(strategy && planned) ||
        strategy.artifactId !== recipe.strategy.artifactId ||
        planned.artifactId !== recipe.run.artifactId ||
        strategy.collectionId !== collectionId ||
        planned.collectionId !== collectionId ||
        strategy.artifactSha256 !== recipe.strategy.sha256 ||
        planned.artifactSha256 !== recipe.run.sha256
      )
        return recipeFail("integrity");
      await readRecord(
        principal,
        scope,
        strategy,
        StrategySpecSchema,
        "StrategySpec"
      );
      const run = await readRecord(
        principal,
        scope,
        planned,
        BacktestRunSchema,
        "BacktestRun"
      );
      if (run.strategyVersion !== strategy.artifactId)
        return recipeFail("integrity");
      // Human admission checks current research reviews available to this owner.
      // Native model/planner/isolation and dataset execution checks stay at Host.
      for (const ref of [recipe.strategy, ...recipe.evidence]) {
        const metadata = await options.store.findRecordArtifact(
          principal,
          scope,
          { artifactId: ref.artifactId }
        );
        if (
          !metadata ||
          metadata.artifactId !== ref.artifactId ||
          metadata.collectionId !== collectionId ||
          metadata.artifactSha256 !== ref.sha256
        )
          return recipeFail("integrity");
        await rightsCurrent(principal, metadata);
        const reviews = (
          await options.store.listReviews(principal, scope, ref.artifactId)
        ).map((value) => AcceptedReviewSchema.parse(value));
        const current = reviews.filter(
          (value) =>
            value.purpose === "research" &&
            !reviews.some(
              (other) => other.supersedesReviewId === value.reviewId
            )
        );
        if (current.length !== 1) return recipeFail("denied");
        const review = present(current[0]),
          now = epoch(options.clock.now());
        if (
          review.decision !== "accepted" ||
          review.accountAlias !== scope.accountAlias ||
          review.environment !== scope.environment ||
          review.collectionId !== collectionId ||
          review.artifactId !== ref.artifactId ||
          review.artifactSha256 !== ref.sha256 ||
          review.strategyVersion !== strategy.artifactId ||
          epoch(review.reviewedAt) > now ||
          epoch(review.expiresAt) <= now
        )
          return recipeFail("denied");
        if (
          recipe.format === "vertex-host-backtest-recipe-v3" &&
          ref.artifactId !== recipe.strategy.artifactId
        ) {
          const reviewPin = recipe.reviewPins.find(
            (value) => value.artifactId === ref.artifactId
          );
          if (
            !reviewPin ||
            reviewPin.reviewId !== review.reviewId ||
            reviewPin.reviewVersion !== review.reviewVersion ||
            reviewPin.rightsPolicyId !== metadata.rights.policyId ||
            reviewPin.rightsVersion !== metadata.rights.version
          )
            return recipeFail("denied");
        }
      }
      const current = await options.policyRegistry.materialize(
        principal,
        {
          ...selectedScope,
          selectionId: selection.selectionId,
          selectionSha256: selection.selectionSha256,
        },
        options.consumerServiceId
      );
      if (
        current.selectionId !== selection.selectionId ||
        current.selectionSha256 !== selection.selectionSha256 ||
        epoch(selection.expiresAt) <= epoch(options.clock.now())
      )
        return recipeFail("denied");
      return;
    };
  const prepareJob: VertexRuntimeRecipes["prepareJob"] = async (
    input,
    rawSelection
  ) => {
    if (input.signal.aborted) return null;
    const scope = WorkerScopeSchema.parse(input.lease.scope);
    if (
      scope.accountAlias !== input.identity.scope.accountAlias ||
      scope.environment !== input.identity.scope.environment
    )
      return recipeFail("denied");
    const selection = await parseRuntimePolicySelection(rawSelection);
    let extra: Partial<VertexRuntimeRecipeInputs> = {};
    if (input.command.kind === "queued-agent") {
      const event = input.command.event;
      const run = AgentRunSchema.parse(event.payload);
      const route = routes.get(run.taskContract);
      if (!route) return null;
      const principal = { actorId: event.actorId };
      const pin = recipeSelectedPin(selection, route);
      const bytes = await options.db.transaction((tx) =>
        options.readSelectedArtifact(tx, principal, scope, pin)
      );
      if (input.signal.aborted) return null;
      if (
        !(bytes instanceof Uint8Array) ||
        bytes.byteLength === 0 ||
        bytes.byteLength > 1_048_576 ||
        (await hashArtifact(bytes)) !== pin.artifactSha256
      )
        return recipeFail("integrity");
      const configuration: unknown = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes)
      );
      if ((await hashArtifact(configuration)) !== pin.artifactSha256)
        return recipeFail("integrity");
      extra = { route, configuration };
      if (
        route.kind === "research-run" &&
        typeof configuration === "object" &&
        configuration !== null &&
        !Array.isArray(configuration) &&
        (configuration as Record<string, unknown>)["profile"] ===
          "vertex-quant-experiment-recipe-v1"
      ) {
        const recipe = QuantExperimentRecipeSchema.parse(configuration);
        const handoffPin = quantExperimentHandoffPin(selection, recipe);
        const original = await options.db.transaction((tx) =>
          options.readSelectedArtifact(tx, principal, scope, handoffPin)
        );
        if (
          !(original instanceof Uint8Array) ||
          original.byteLength === 0 ||
          original.byteLength > QUANT_EXPERIMENT_MAX_BYTES ||
          (await hashArtifact(original)) !== recipe.handoff.sha256
        )
          return recipeFail("integrity");
        // The pure builder validates the full private profile and byte equality;
        // no decode/re-encode here replaces the selected original source bytes.
        extra = { ...extra, experimentHandoff: new Uint8Array(original) };
      }
      if (
        route.kind === "research-run" &&
        typeof configuration === "object" &&
        configuration !== null &&
        !Array.isArray(configuration) &&
        (configuration as Record<string, unknown>)["profile"] ===
          "vertex-paper-lab-recipe-v1"
      ) {
        const recipe = PaperLabRecipeSchema.parse(configuration);
        const implementationPin = paperLabImplementationPin(selection, recipe);
        const original = await options.db.transaction((tx) =>
          options.readSelectedArtifact(tx, principal, scope, implementationPin)
        );
        if (
          !(original instanceof Uint8Array) ||
          original.byteLength === 0 ||
          original.byteLength > 65_536 ||
          (await hashArtifact(original)) !== recipe.implementation.sha256
        )
          return recipeFail("integrity");
        extra = { ...extra, paperLabImplementation: new Uint8Array(original) };
      }
      if (
        route.kind === "research-run" ||
        run.runId.startsWith("backtest-request-")
      ) {
        const metadata = await options.store.findRecordArtifact(
          principal,
          scope,
          { contractName: "AgentRun", recordId: run.runId }
        );
        if (
          !metadata ||
          metadata.collectionId !== input.lease.collectionId ||
          metadata.artifactSha256 !== (await hashArtifact(run))
        )
          return recipeFail("integrity");
        await readRecord(
          principal,
          scope,
          metadata,
          AgentRunSchema,
          "AgentRun"
        );
        const proposal = RecipeProposalSchema.parse(
          await options.workerStore.readResearchProposal(
            principal,
            scope,
            metadata.artifactId
          )
        );
        const evidence: unknown[] = [];
        for (const evidenceId of run.inputEvidenceIds) {
          if (input.signal.aborted) return null;
          if (input.lease.collectionId === null) return recipeFail("invalid");
          const reference = await options.store.findEvidence(
            principal,
            scope,
            input.lease.collectionId,
            evidenceId
          );
          if (!reference) return recipeFail("unavailable");
          evidence.push(
            await readRecord(
              principal,
              scope,
              reference,
              ResearchEvidenceSchema,
              "ResearchEvidence"
            )
          );
        }
        extra = { ...extra, proposal, evidence };
        if (run.runId.startsWith("backtest-request-")) {
          const requestHash = run.runId.slice("backtest-request-".length);
          if (
            metadata.artifactId !== `agent-${requestHash}` ||
            event["correlationId"] !== `research-${requestHash}` ||
            event["idempotencyKey"] !== `research-${requestHash}`
          )
            return recipeFail("integrity");
          if (!proposal.backtestExpectation) return recipeFail("integrity");
          await validateBacktestRequest(
            principal,
            scope,
            present(input.lease.collectionId),
            proposal.backtestExpectation
          );
        }
      }
    } else if (input.command.kind === "paper-admission") {
      const admission = PaperSimulationAdmissionSchema.parse(
        input.command.admission
      );
      const principal = { actorId: admission.actorId };
      const intent = await options.store.findRecordArtifact(principal, scope, {
        contractName: "TradeIntent",
        recordId: admission.intentId,
      });
      const strategy = await options.store.findRecordArtifact(
        principal,
        scope,
        { contractName: "StrategySpec", artifactId: admission.strategyVersion }
      );
      if (
        !(intent && strategy) ||
        intent.artifactSha256 !== admission.intentSha256
      )
        return recipeFail("unavailable");
      const intentValue = await readRecord(
        principal,
        scope,
        intent,
        TradeIntentSchema,
        "TradeIntent"
      );
      await readRecord(
        principal,
        scope,
        strategy,
        StrategySpecSchema,
        "StrategySpec"
      );
      if (
        intentValue.intentId !== admission.intentId ||
        intentValue.strategyVersion !== admission.strategyVersion ||
        strategy.artifactId !== admission.strategyVersion
      )
        return recipeFail("integrity");
      extra = {
        paper: {
          intentArtifactId: intent.artifactId,
          intentSha256: intent.artifactSha256,
          strategyArtifact: {
            artifactId: strategy.artifactId,
            artifactSha256: strategy.artifactSha256,
          },
        },
      };
    }
    if (input.signal.aborted) return null;
    const prepared = await buildVertexRuntimeRecipe({
      ...extra,
      command: input.command,
      scope,
      eventId: input.lease.eventId,
      collectionId: input.lease.collectionId,
      selection,
      now: options.clock.now(),
    });
    // Recheck current selection after object/proposal IO. No read-only history
    // lookup can replace current materialization at this boundary.
    const current = await options.policyRegistry.materialize(
      { actorId: prepared.binding.researchPrincipalId },
      {
        ...scope,
        selectionId: selection.selectionId,
        selectionSha256: selection.selectionSha256,
      },
      options.consumerServiceId
    );
    if (
      current.selectionId !== selection.selectionId ||
      current.selectionSha256 !== selection.selectionSha256
    )
      return recipeFail("integrity");
    if (
      input.signal.aborted ||
      epoch(prepared.binding.deadlineAt) <= epoch(options.clock.now())
    )
      return null;
    // Preserve the original WeakSet-issued WorkerServiceIdentity. The store
    // validates the live claim fence + current publication grant/rights version.
    const staged = await options.workerStore.prepareOutboxPayload(
      input.identity,
      input.lease,
      {
        researchPrincipalId: prepared.binding.researchPrincipalId,
        artifactId: prepared.binding.payloadArtifactId,
        sha256: prepared.binding.payloadSha256,
        bytes: new TextEncoder().encode(
          canonicalArtifactJson(prepared.payload)
        ),
        rightsPolicyId: prepared.rightsPolicyId,
        rightsVersion: prepared.rightsVersion,
      }
    );
    if (
      staged.artifactId !== prepared.binding.payloadArtifactId ||
      staged.artifactSha256 !== prepared.binding.payloadSha256
    )
      return recipeFail("integrity");
    return input.signal.aborted ? null : prepared.binding;
  };
  const resolveBinding: VertexWorkerBindingResolver = async (input) => {
    if (input.signal.aborted) return null;
    const scope = WorkerScopeSchema.parse(input.lease.scope);
    if (
      input.command.kind === "queued-agent" &&
      typeof input.command.event.payload["runId"] === "string" &&
      input.command.event.payload["runId"].startsWith("chat-run-")
    ) {
      if (!options.chatWorker) return recipeFail("unavailable");
      const principal = { actorId: input.command.event.actorId };
      const original = await options.chatWorker.readForDispatch(
        principal,
        scope,
        input.lease.eventId
      );
      if (
        !original ||
        original.closed ||
        original.origin["eventId"] !== input.command.event.eventId ||
        (await hashArtifact(input.command.event)) !==
          original.origin["eventSha256"]
      )
        return recipeFail("denied");
      const recipe = original.recipe,
        execution = recipe["execution"] as Record<string, unknown>;
      const route = routes.get(String(execution["taskContract"]));
      if (route?.kind !== "research-run") return recipeFail("unavailable");
      const selection = await parseRuntimePolicySelection(
        await options.policyRegistry.materialize(
          principal,
          {
            ...scope,
            selectionId: String(execution["selectionId"]),
            selectionSha256: String(execution["selectionSha256"]),
          },
          options.consumerServiceId
        )
      );
      const selectedConfiguration = selection.artifacts.find(
        (entry) =>
          entry.bindingId === route.bindingId && entry.role === "tool-config"
      );
      if (
        !selectedConfiguration ||
        (await hashArtifact(selectedConfiguration.artifact)) !==
          (await hashArtifact(execution["participantConfiguration"]))
      )
        return recipeFail("denied");
      const policyId = selection.research?.rightsPolicyId;
      if (!policyId) return recipeFail("denied");
      const rights = await options.store.getRights(
        principal,
        scope,
        String(execution["collectionId"]),
        policyId
      );
      if (rights?.status !== "granted" || !rights.allowedUses.includes("store"))
        return recipeFail("denied");
      const binding = {
        kind: "research-run" as const,
        researchPrincipalId: principal.actorId,
        payloadArtifactId: String(original.origin["recipeArtifactId"]),
        payloadSha256: String(original.origin["recipeSha256"]),
        policySelectionId: selection.selectionId,
        policySelectionSha256: selection.selectionSha256,
        deadlineAt: String(execution["deadlineAt"]),
      };
      await options.workerStore.prepareOutboxPayload(
        input.identity,
        input.lease,
        {
          researchPrincipalId: principal.actorId,
          artifactId: binding.payloadArtifactId,
          sha256: binding.payloadSha256,
          bytes: new TextEncoder().encode(canonicalArtifactJson(recipe)),
          rightsPolicyId: policyId,
          rightsVersion: rights.version,
        }
      );
      const after = await options.chatWorker.readForDispatch(
        principal,
        scope,
        input.lease.eventId
      );
      if (
        !after ||
        after.closed ||
        after.origin["recipeSha256"] !== binding.payloadSha256 ||
        input.signal.aborted ||
        epoch(binding.deadlineAt) <= epoch(options.clock.now())
      )
        return recipeFail("denied");
      return binding;
    }
    const actorId =
      input.command.kind === "queued-agent"
        ? input.command.event.actorId
        : input.command.kind === "paper-admission"
          ? input.command.admission.actorId
          : input.command.bootstrap.researchPrincipalId;
    let selectionId: string;
    let selectionSha256: string;
    if (input.command.kind === "native-bootstrap") {
      const bootstrap = WorkerBootstrapCommandSchema.parse(
        input.command.bootstrap
      );
      selectionId = bootstrap.policySelectionId;
      selectionSha256 = bootstrap.policySelectionSha256;
    } else {
      const head = await options.policyRegistry.readHead({ actorId }, scope);
      if (
        head.state !== "active-read-only" ||
        head.selectionId === null ||
        head.selectionSha256 === null
      )
        return null;
      selectionId = head.selectionId;
      selectionSha256 = head.selectionSha256;
    }
    const selection = await options.policyRegistry.materialize(
      { actorId },
      { ...scope, selectionId, selectionSha256 },
      options.consumerServiceId
    );
    return prepareJob(input, await parseRuntimePolicySelection(selection));
  };
  return Object.freeze({
    prepareJob,
    resolveBinding,
    validateBacktestRequest,
  });
};
