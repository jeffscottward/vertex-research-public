import type { SafePrincipal } from "@darkfactory/auth/types";
import type {
  VertexArtifactMetadata,
  VertexPrincipal,
  VertexRecord,
  VertexScope,
} from "@darkfactory/db/server/vertex";
import {
  compareDecimals as compareExactDecimals,
  hashArtifact,
  timestampToEpochNanoseconds,
} from "@darkfactory/shared/vertex";
import { z } from "zod";
import {
  AgentRunSchema,
  BacktestRunSchema,
  IdentifierSchema,
  PositiveDecimalSchema,
  ResearchEvidenceSchema,
  StrategySpecSchema,
  TradeIntentSchema,
  VersionSchema,
} from "../contracts/vertex.ts";
import {
  AcceptedReviewSchema,
  PaperSimulationAdmissionSchema,
  PortfolioSnapshotSchema,
  type AcceptedReview,
} from "../contracts/vertex-control.ts";
import {
  VertexAgentArtifactSchema,
  VertexReviewDecisionInputSchema,
  VertexResearchProposalInputSchema,
  VertexSimulationProposalInputSchema,
  VertexSimulationQueueReceiptSchema,
  type VertexReviewDecisionInput,
  type VertexResearchProposalInput,
  type VertexSimulationProposalInput,
} from "../contracts/vertex-experience.ts";
import {
  authorizeVertex,
  checkVertexCancellation,
  failVertex,
  loadVertexArtifact,
  requireVertexScope,
  resolveVertexExperiencePolicy,
  sameVertexScope,
  vertexArtifactMetadata,
  vertexInput,
  vertexNow,
  vertexOperation,
  vertexPorts,
  vertexSource,
  type VertexExperienceDependencies,
  type VertexExperiencePolicyIdentity,
} from "./vertex-experience-core.ts";

const ReviewReceiptSchema = z
  .object({
    review: AcceptedReviewSchema,
    acceptedEvidenceArtifactId: z.null(),
  })
  .strict();
const ttl = (milliseconds: number): number => {
  if (
    !Number.isSafeInteger(milliseconds) ||
    milliseconds < 1 ||
    milliseconds > 86_400_000
  )
    return failVertex("SERVICE_UNAVAILABLE");
  return milliseconds;
};
const expiry = (at: string, milliseconds: number): string => {
  // Do not truncate a source nanosecond instant before comparisons. Server
  // policy produces a later millisecond boundary, bounded to one day.
  const ns =
    timestampToEpochNanoseconds(at) + BigInt(ttl(milliseconds)) * 1_000_000n;
  return new Date(Number((ns + 999_999n) / 1_000_000n)).toISOString();
};
const earlier = (left: string, right: string): string =>
  timestampToEpochNanoseconds(left) < timestampToEpochNanoseconds(right)
    ? left
    : right;
const minimum = (...values: readonly string[]): string => {
  const parsed = values.map((value) =>
    vertexSource(PositiveDecimalSchema, value)
  );
  return parsed.reduce((left, right) =>
    compareExactDecimals(left, right) < 0 ? left : right
  );
};
const commandKey = async (
  actor: VertexPrincipal,
  kind: "review" | "research" | "simulation",
  command: VertexRecord,
  policyIdentity?: VertexExperiencePolicyIdentity
) => ({
  kind,
  command,
  idempotencyKey: vertexInput(IdentifierSchema, command["idempotencyKey"]),
  requestHash: await hashArtifact({
    actorId: actor.actorId,
    kind,
    input: command,
  }),
  // Server-only selection guard; never supplied by or hashed into client input.
  ...(policyIdentity === undefined ? {} : { commandPolicy: policyIdentity }),
});
const findArtifact = async (
  dependencies: VertexExperienceDependencies,
  actor: VertexPrincipal,
  scope: VertexScope,
  artifactId: string,
  contractName?: "StrategySpec"
) => {
  const source = await vertexOperation(dependencies, () =>
    vertexPorts(dependencies).store.findRecordArtifact(actor, scope, {
      artifactId,
      ...(contractName === undefined ? {} : { contractName }),
    })
  );
  if (source === null) return failVertex("NOT_FOUND");
  const metadata = vertexArtifactMetadata(source);
  if (
    metadata.artifactId !== artifactId ||
    !sameVertexScope(metadata.scope, scope) ||
    (contractName !== undefined && metadata.contractName !== contractName)
  )
    return failVertex("INVALID_SOURCE");
  return metadata;
};
const reviewedSource = async (
  dependencies: VertexExperienceDependencies,
  actor: VertexPrincipal,
  scope: VertexScope,
  metadata: VertexArtifactMetadata
) => {
  switch (metadata.contractName) {
    case "ResearchEvidence": {
      return await loadVertexArtifact(
        dependencies,
        actor,
        scope,
        metadata,
        ResearchEvidenceSchema,
        "ResearchEvidence"
      );
    }
    case "StrategySpec": {
      return await loadVertexArtifact(
        dependencies,
        actor,
        scope,
        metadata,
        StrategySpecSchema,
        "StrategySpec"
      );
    }
    case "TradeIntent": {
      return await loadVertexArtifact(
        dependencies,
        actor,
        scope,
        metadata,
        TradeIntentSchema,
        "TradeIntent"
      );
    }
    case "BacktestRun": {
      return await loadVertexArtifact(
        dependencies,
        actor,
        scope,
        metadata,
        BacktestRunSchema,
        "BacktestRun"
      );
    }
    default: {
      return failVertex("BAD_REQUEST");
    }
  }
};
const verifyReview = (
  value: unknown,
  input: VertexReviewDecisionInput,
  actor: VertexPrincipal
): AcceptedReview => {
  const review = vertexSource(AcceptedReviewSchema, value);
  if (
    !sameVertexScope(review, input) ||
    review.actorId !== actor.actorId ||
    review.artifactId !== input.artifactId ||
    review.artifactSha256 !== input.artifactSha256 ||
    review.strategyVersion !== input.strategyVersion ||
    review.decision !== input.decision ||
    review.purpose !== input.purpose ||
    review.supersedesReviewId !== input.expectedReviewId
  )
    return failVertex("INVALID_SOURCE");
  return review;
};

export const createVertexExperienceCommands = (
  dependencies: VertexExperienceDependencies = {}
) => ({
  decideReview: async (
    principal: SafePrincipal,
    raw: VertexReviewDecisionInput
  ) =>
    vertexOperation(dependencies, async () => {
      const input = vertexInput(VertexReviewDecisionInputSchema, raw);
      const scope: VertexScope = Object.freeze({
        accountAlias: input.accountAlias,
        environment: input.environment,
      });
      const actor = await requireVertexScope(dependencies, principal, scope);
      const selectedPolicy = await resolveVertexExperiencePolicy(
        dependencies,
        actor,
        scope
      );
      const ports = vertexPorts(dependencies);
      const policy = selectedPolicy.reviewPolicy;
      if (!policy) return failVertex("SERVICE_UNAVAILABLE");
      const policyVersion = vertexSource(VersionSchema, policy.version);
      const reviewVersion = vertexSource(VersionSchema, policy.reviewVersion);
      ttl(policy.ttlMilliseconds);
      const metadata = await findArtifact(
        dependencies,
        actor,
        scope,
        input.artifactId
      );
      if (metadata.artifactSha256 !== input.artifactSha256)
        return failVertex("CONFLICT");
      await authorizeVertex(
        dependencies,
        actor,
        scope,
        metadata.artifactId,
        "review",
        metadata.collectionId
      );
      const source = await reviewedSource(dependencies, actor, scope, metadata);
      const strategyMetadata = await findArtifact(
        dependencies,
        actor,
        scope,
        input.strategyVersion,
        "StrategySpec"
      );
      await loadVertexArtifact(
        dependencies,
        actor,
        scope,
        strategyMetadata,
        StrategySpecSchema,
        "StrategySpec"
      );
      if (
        metadata.contractName === "StrategySpec" &&
        metadata.artifactId !== input.strategyVersion
      )
        return failVertex("CONFLICT");
      if (
        "strategyVersion" in source.value &&
        source.value.strategyVersion !== input.strategyVersion
      )
        return failVertex("CONFLICT");
      if (
        input.purpose === "paper-simulation" &&
        metadata.contractName !== "TradeIntent"
      )
        return failVertex("BAD_REQUEST");
      const key = await commandKey(
        actor,
        "review",
        input,
        selectedPolicy.policyIdentity
      );
      // biome-ignore lint/suspicious/useAwait: async keeps synchronous validation throws as promise rejections for callers
      const verifyReceipt = async (rawReceipt: unknown) => {
        const receipt = vertexSource(ReviewReceiptSchema, rawReceipt);
        const result = verifyReview(receipt.review, input, actor);
        if (
          result.reviewId !== `review-${key.requestHash}` ||
          result.collectionId !== metadata.collectionId ||
          result.policyVersion !== policyVersion ||
          result.reviewVersion !== reviewVersion
        )
          return failVertex("INVALID_SOURCE");
        const checkedAt = timestampToEpochNanoseconds(vertexNow(dependencies));
        if (
          timestampToEpochNanoseconds(result.reviewedAt) > checkedAt ||
          timestampToEpochNanoseconds(result.expiresAt) <= checkedAt
        )
          return failVertex("CONFLICT");
        return result;
      };
      const previous = await ports.store.getCommandReceipt(actor, scope, key);
      if (previous !== null) return verifyReceipt(previous);
      const at = vertexNow(dependencies);
      const review = vertexSource(AcceptedReviewSchema, {
        schemaVersion: "1.0.0",
        reviewId: `review-${key.requestHash}`,
        accountAlias: input.accountAlias,
        environment: input.environment,
        collectionId: metadata.collectionId,
        artifactId: input.artifactId,
        artifactSha256: input.artifactSha256,
        reviewVersion,
        decision: input.decision,
        purpose: input.purpose,
        actorId: actor.actorId,
        reviewedAt: at,
        expiresAt: expiry(at, policy.ttlMilliseconds),
        policyVersion,
        strategyVersion: input.strategyVersion,
        supersedesReviewId: input.expectedReviewId,
        executionAuthorized: false,
      });
      // Acceptance is an immutable review overlay over the ORIGINAL exact bytes,
      // never a rewritten evidence label or a mutation of a sealed import.
      // The DB commits review+original-hash link+receipt+outbox atomically.
      checkVertexCancellation(dependencies);
      return verifyReceipt(
        await ports.store.recordReviewedEvidence({
          principal: actor,
          scope,
          review,
          acceptedEvidence: null,
          ...key,
        })
      );
    }),
  proposeResearch: async (
    principal: SafePrincipal,
    raw: VertexResearchProposalInput
  ) =>
    vertexOperation(dependencies, async () => {
      const input = vertexInput(VertexResearchProposalInputSchema, raw);
      const scope: VertexScope = Object.freeze({
        accountAlias: input.accountAlias,
        environment: input.environment,
      });
      const actor = await requireVertexScope(dependencies, principal, scope);
      const selectedPolicy = await resolveVertexExperiencePolicy(
        dependencies,
        actor,
        scope
      );
      const ports = vertexPorts(dependencies);
      const binding = selectedPolicy.research;
      if (!(binding && dependencies.prepareManifest))
        return failVertex("SERVICE_UNAVAILABLE");
      if ((await binding.available(scope, dependencies.signal)) !== true)
        return failVertex("SERVICE_UNAVAILABLE");
      await authorizeVertex(
        dependencies,
        actor,
        scope,
        input.collectionId,
        "publish",
        input.collectionId
      );
      const key = await commandKey(
        actor,
        "research",
        input,
        selectedPolicy.policyIdentity
      );
      const expectation = input.backtestExpectation;
      if (expectation) {
        const identity = selectedPolicy.policyIdentity;
        if (!(identity && dependencies.validateBacktestRequest))
          return failVertex("SERVICE_UNAVAILABLE");
        if (
          expectation.taskContract !== binding.taskContract ||
          expectation.policy.selectionId !== identity.selectionId ||
          expectation.policy.selectionSha256 !== identity.selectionSha256 ||
          expectation.policy.selectionRevision !== identity.selectionRevision
        )
          return failVertex("CONFLICT");
        await dependencies.validateBacktestRequest(
          actor,
          scope,
          input.collectionId,
          expectation
        );
      }
      const runId = `${expectation ? "backtest-request" : "run"}-${key.requestHash}`;
      const evidenceMetadata: VertexArtifactMetadata[] = [];
      for (const evidenceId of input.evidenceIds) {
        const metadata = await ports.store.findEvidence(
          actor,
          scope,
          input.collectionId,
          evidenceId
        );
        if (!metadata) return failVertex("NOT_FOUND");
        const evidence = await loadVertexArtifact(
          dependencies,
          actor,
          scope,
          metadata,
          ResearchEvidenceSchema,
          "ResearchEvidence"
        );
        if (
          evidence.value.evidenceId !== evidenceId ||
          evidence.value.collectionId !== input.collectionId
        )
          return failVertex("INVALID_SOURCE");
        // Unreviewed content can inform a bounded proposal, never acceptance or execution.
        evidenceMetadata.push(metadata);
      }
      const verifyReceipt = async (value: unknown) => {
        const receipt = vertexSource(VertexAgentArtifactSchema, value);
        if (
          receipt.artifactId !== `agent-${key.requestHash}` ||
          receipt.value.runId !== runId ||
          receipt.value.status !== "queued" ||
          receipt.value.agentRole !== input.role ||
          receipt.value.inputEvidenceIds.join(",") !==
            input.evidenceIds.join(",") ||
          receipt.value.outputArtifactIds.length !== 0 ||
          (await hashArtifact(receipt.value)) !== receipt.sha256
        )
          return failVertex("INVALID_SOURCE");
        const metadata = await findArtifact(
          dependencies,
          actor,
          scope,
          receipt.artifactId
        );
        const committed = await loadVertexArtifact(
          dependencies,
          actor,
          scope,
          metadata,
          AgentRunSchema,
          "AgentRun"
        );
        if (committed.sha256 !== receipt.sha256)
          return failVertex("INVALID_SOURCE");
        return receipt;
      };
      const previous = await ports.store.getCommandReceipt(actor, scope, key);
      if (previous !== null) return verifyReceipt(previous);
      const record = vertexSource(AgentRunSchema, {
        schemaVersion: "1.0.0",
        runId,
        agentRole: input.role,
        taskContract: binding.taskContract,
        allowedTools: [...binding.allowedTools],
        modelVersion: binding.modelVersion,
        inputEvidenceIds: [...input.evidenceIds],
        outputArtifactIds: [],
        tokenBudget: binding.tokenBudget,
        costBudgetUsd: binding.costBudgetUsd,
        status: "queued",
        errors: [],
        approvalRequests: [],
        executionAuthorized: false,
      });
      if (
        record.tokenBudget < 1 ||
        record.tokenBudget > 1_000_000 ||
        compareExactDecimals(record.costBudgetUsd, "100") > 0 ||
        new Set(record.allowedTools).size !== record.allowedTools.length
      )
        return failVertex("SERVICE_UNAVAILABLE");
      const metadata = await dependencies.prepareManifest({
        principal: actor,
        scope,
        collectionId: input.collectionId,
        artifactId: `agent-${key.requestHash}`,
        contractName: "AgentRun",
        manifest: record,
        artifactSha256: await hashArtifact(record),
        sourceContentSha256: null,
        rightsPolicyId: vertexSource(IdentifierSchema, binding.rightsPolicyId),
        lineageArtifactIds: evidenceMetadata.map((value) => value.artifactId),
        createdAt: vertexNow(dependencies),
      });
      checkVertexCancellation(dependencies);
      return verifyReceipt(
        await ports.store.enqueueResearchProposal({
          principal: actor,
          scope,
          collectionId: input.collectionId,
          record,
          metadata,
          proposal: {
            question: input.question,
            evidenceIds: input.evidenceIds,
            role: input.role,
            proposalOnly: true,
            executionAuthorized: false,
            ...(expectation ? { backtestExpectation: expectation } : {}),
          },
          ...key,
        })
      );
    }),
  proposeSimulation: async (
    principal: SafePrincipal,
    raw: VertexSimulationProposalInput
  ) =>
    vertexOperation(dependencies, async () => {
      const input = vertexInput(VertexSimulationProposalInputSchema, raw);
      const scope: VertexScope = Object.freeze({
        accountAlias: input.accountAlias,
        environment: input.environment,
      });
      const actor = await requireVertexScope(dependencies, principal, scope);
      const selectedPolicy = await resolveVertexExperiencePolicy(
        dependencies,
        actor,
        scope
      );
      const ports = vertexPorts(dependencies);
      const binding = selectedPolicy.simulation;
      const policy = selectedPolicy.reviewPolicy;
      if (!(binding && policy)) return failVertex("SERVICE_UNAVAILABLE");
      if (
        input.reviewVersion !==
        vertexSource(VersionSchema, policy.reviewVersion)
      )
        return failVertex("FORBIDDEN");
      if ((await binding.available(scope, dependencies.signal)) !== true)
        return failVertex("SERVICE_UNAVAILABLE");
      await authorizeVertex(
        dependencies,
        actor,
        scope,
        input.admissionId,
        "admit-paper-simulation"
      );
      const key = await commandKey(
        actor,
        "simulation",
        input,
        selectedPolicy.policyIdentity
      );
      const verifyReceipt = (value: unknown, expectedJobId?: string) => {
        const result = vertexSource(VertexSimulationQueueReceiptSchema, value);
        if (
          result.admissionId !== input.admissionId ||
          !/^simulation-[0-9a-f]{64}$/.test(result.jobId) ||
          (expectedJobId !== undefined && result.jobId !== expectedJobId)
        )
          return failVertex("INVALID_SOURCE");
        return result;
      };
      const metadata = await ports.store.findRecordArtifact(actor, scope, {
        contractName: "TradeIntent",
        recordId: input.intentId,
      });
      if (!metadata) return failVertex("NOT_FOUND");
      const intent = await loadVertexArtifact(
        dependencies,
        actor,
        scope,
        metadata,
        TradeIntentSchema,
        "TradeIntent"
      );
      if (
        intent.value.intentId !== input.intentId ||
        intent.sha256 !== input.intentSha256 ||
        intent.value.strategyVersion !== input.strategyVersion ||
        !sameVertexScope(intent.value, input)
      )
        return failVertex("CONFLICT");
      const reviews = await ports.store.listReviews(
        actor,
        scope,
        metadata.artifactId
      );
      if (reviews.length > 512) return failVertex("INVALID_SOURCE");
      const parsedReviews = reviews.map((value) =>
        vertexSource(AcceptedReviewSchema, value)
      );
      const review = parsedReviews.find(
        (value) => value.reviewId === input.reviewId
      );
      if (
        review?.decision !== "accepted" ||
        review.purpose !== "paper-simulation" ||
        review.actorId !== actor.actorId ||
        review.reviewVersion !== input.reviewVersion ||
        review.artifactId !== metadata.artifactId ||
        review.artifactSha256 !== input.intentSha256 ||
        review.strategyVersion !== input.strategyVersion ||
        !sameVertexScope(review, input) ||
        review.policyVersion !== policy.version
      )
        return failVertex("FORBIDDEN");
      const previous = await ports.store.getCommandReceipt(actor, scope, key);
      if (previous !== null) return verifyReceipt(previous);
      const strategyMetadata = await findArtifact(
        dependencies,
        actor,
        scope,
        input.strategyVersion,
        "StrategySpec"
      );
      const strategy = await loadVertexArtifact(
        dependencies,
        actor,
        scope,
        strategyMetadata,
        StrategySpecSchema,
        "StrategySpec"
      );
      await authorizeVertex(dependencies, actor, scope, "portfolio");
      const snapshot = await ports.store.getPortfolioSnapshot(actor, scope);
      if (!snapshot) return failVertex("SERVICE_UNAVAILABLE");
      const portfolio = vertexSource(PortfolioSnapshotSchema, snapshot);
      if (
        !sameVertexScope(portfolio, input) ||
        portfolio.sourceKind === "source-unavailable" ||
        portfolio.continuity.state !== "continuous" ||
        portfolio.continuity.freshness.status !== "fresh"
      )
        return failVertex("CONFLICT");
      const at = vertexNow(dependencies);
      const expiresAt = earlier(
        earlier(expiry(at, binding.ttlMilliseconds), review.expiresAt),
        intent.value.expiresAt
      );
      if (
        timestampToEpochNanoseconds(expiresAt) <=
        timestampToEpochNanoseconds(at)
      )
        return failVertex("CONFLICT");
      const admission = vertexSource(PaperSimulationAdmissionSchema, {
        schemaVersion: "1.0.0",
        admissionId: input.admissionId,
        admissionKind: "PAPER-SIMULATION",
        accountAlias: input.accountAlias,
        environment: "paper",
        simulatorId: binding.simulatorId,
        streamId: portfolio.streamId,
        ownerEpoch: portfolio.ownerEpoch,
        intentId: input.intentId,
        intentSha256: input.intentSha256,
        reviewedArtifactSha256: input.intentSha256,
        reviewId: input.reviewId,
        reviewVersion: input.reviewVersion,
        actorId: actor.actorId,
        policyVersion: review.policyVersion,
        strategyVersion: input.strategyVersion,
        portfolioSnapshotId: portfolio.snapshotId,
        portfolioSequence: portfolio.sequence,
        maximumLoss: minimum(
          binding.maximumLoss,
          intent.value.maxLossBudget,
          strategy.value.riskLimits.maximumLoss
        ),
        maximumNotional: minimum(
          binding.maximumNotional,
          strategy.value.riskLimits.maximumNotional
        ),
        admittedAt: at,
        expiresAt,
        idempotencyKey: input.idempotencyKey,
        simulationOnly: true,
        brokerSubmissionAllowed: false,
        liveAuthorization: false,
        executionAuthorized: false,
      });
      checkVertexCancellation(dependencies);
      return verifyReceipt(
        await ports.store.queuePaperSimulation({
          principal: actor,
          scope,
          admission,
          ...key,
        }),
        `simulation-${await hashArtifact(admission)}`
      );
    }),
});
