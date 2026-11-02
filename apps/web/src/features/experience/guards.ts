import {
  AcceptedReviewSchema,
  AgentRunSchema,
  BacktestRunSchema,
  BrokerRecoveryStatusSchema,
  DatasetManifestSchema,
  DigestSchema,
  IdentifierSchema,
  PaperSimulationAdmissionSchema,
  ResearchEvidenceSchema,
  StrategySpecSchema,
  TradeIntentSchema,
  VertexContinuityGetInputSchema,
  VertexGatewayBindingSchema,
  VertexContinuityReadSchema,
  VertexPortfolioGetInputSchema,
  VertexPortfolioReadSchema,
  parseExecutionProjection,
  parseNativeFactProjection,
} from "@darkfactory/api/vertex";
import {
  canonicalArtifactJson,
  verifyArtifactHash,
} from "@darkfactory/shared/vertex";
import { VertexReadError } from "../../components/research/vertex-client.ts";
import type {
  ExperienceScope,
  ExperienceServices,
  ImmutableArtifact,
} from "./ports.ts";
import { guardResearchChatPort } from "./research-chat-client.ts";

const malformed = (): never => {
  throw new VertexReadError("malformed");
};
const parse = <T>(
  schema: { parse: (value: unknown) => T },
  value: unknown
): T => {
  try {
    // Reject accessors, noncanonical numbers, and hidden non-JSON values before parsing.
    canonicalArtifactJson(value);
    return schema.parse(value);
  } catch {
    return malformed();
  }
};
const bounded = <T>(values: readonly T[], maximum = 512): readonly T[] => {
  if (!Array.isArray(values) || values.length > maximum) return malformed();
  return values;
};
const sameScope = (value: ExperienceScope, input: ExperienceScope): boolean =>
  value.accountAlias === input.accountAlias &&
  value.environment === input.environment;
const scope = (input: ExperienceScope): ExperienceScope => {
  try {
    return VertexPortfolioGetInputSchema.parse({
      accountAlias: input.accountAlias,
      environment: input.environment,
    });
  } catch {
    throw new VertexReadError("invalid");
  }
};
const artifact = async <T>(
  schema: { parse: (value: unknown) => T },
  input: ImmutableArtifact<T>
): Promise<ImmutableArtifact<T>> => {
  if (
    typeof input !== "object" ||
    input === null ||
    Object.keys(input).sort().join(",") !== "artifactId,sha256,value"
  )
    return malformed();
  const artifactId = parse(IdentifierSchema, input.artifactId);
  const sha256 = parse(DigestSchema, input.sha256);
  const value = parse(schema, input.value);
  if (!(await verifyArtifactHash(value, sha256))) return malformed();
  return Object.freeze({ artifactId, sha256, value });
};
const unique = <T>(
  values: readonly T[],
  identity: (value: T) => string
): readonly T[] => {
  if (new Set(values.map(identity)).size !== values.length) return malformed();
  return values;
};

// These guards narrow data, not authority. Server authorization and atomic command
// validation remain mandatory, even for a perfectly valid UI record.
export const guardExperienceServices = (
  services: ExperienceServices
): ExperienceServices => ({
  researchChat:
    services.researchChat === null || services.researchChat === undefined
      ? null
      : guardResearchChatPort(services.researchChat),
  reads: {
    scopes: async (input, signal) =>
      unique(
        bounded(await services.reads.scopes(input, signal)).map((value) =>
          parse(VertexPortfolioGetInputSchema, value)
        ),
        (value) => `${value.accountAlias}/${value.environment}`
      ),
    portfolio: async (input, signal) => {
      const selection = scope(input);
      const result = parse(
        VertexPortfolioReadSchema,
        await services.reads.portfolio(selection, signal)
      );
      if (
        result.status === "available" &&
        !sameScope(result.snapshot, selection)
      )
        return malformed();
      return result;
    },
    continuity: async (input, signal) => {
      const selection = VertexContinuityGetInputSchema.parse(input);
      const result = parse(
        VertexContinuityReadSchema,
        await services.reads.continuity(selection, signal)
      );
      if (
        result.status === "available" &&
        (!sameScope(result.continuity, selection) ||
          result.continuity.streamId !== selection.streamId)
      )
        return malformed();
      return result;
    },
    strategies: async (input, signal) => {
      const result = await services.reads.strategies(scope(input), signal);
      return unique(
        await Promise.all(
          bounded(result).map((value) => artifact(StrategySpecSchema, value))
        ),
        (value) => value.artifactId
      );
    },
    dossier: async (input, signal) => {
      const selection = {
        ...scope(input),
        artifactId: IdentifierSchema.parse(input.artifactId),
      };
      const result = await services.reads.dossier(selection, signal);
      const strategy = await artifact(StrategySpecSchema, result.strategy);
      if (strategy.artifactId !== selection.artifactId) return malformed();
      const [drafts, backtests] = await Promise.all([
        Promise.all(
          bounded(result.drafts).map((value) =>
            artifact(TradeIntentSchema, value)
          )
        ),
        Promise.all(
          bounded(result.backtests).map((value) =>
            artifact(BacktestRunSchema, value)
          )
        ),
      ]);
      const evidence = bounded(result.evidence).map((value) =>
        parse(ResearchEvidenceSchema, value)
      );
      const datasets = bounded(result.datasets).map((value) =>
        parse(DatasetManifestSchema, value)
      );
      const reviews = bounded(result.reviews).map((value) =>
        parse(AcceptedReviewSchema, value)
      );
      const admissions = bounded(result.admissions).map((value) =>
        parse(PaperSimulationAdmissionSchema, value)
      );
      if (
        drafts.some(
          (value) =>
            !sameScope(value.value, selection) ||
            value.value.strategyVersion !== strategy.artifactId
        )
      )
        return malformed();
      if (
        backtests.some(
          (value) => value.value.strategyVersion !== strategy.artifactId
        )
      )
        return malformed();
      if (
        reviews.some(
          (value) =>
            !sameScope(value, selection) ||
            value.strategyVersion !== strategy.artifactId
        )
      )
        return malformed();
      if (
        admissions.some(
          (value) =>
            !sameScope(value, selection) ||
            value.strategyVersion !== strategy.artifactId
        )
      )
        return malformed();
      unique(drafts, (value) => value.artifactId);
      unique(backtests, (value) => value.artifactId);
      unique(evidence, (value) => `${value.collectionId}/${value.evidenceId}`);
      unique(datasets, (value) => value.datasetId);
      unique(reviews, (value) => value.reviewId);
      unique(admissions, (value) => value.admissionId);
      return Object.freeze({
        strategy,
        drafts,
        evidence,
        datasets,
        backtests,
        reviews,
        admissions,
      });
    },
    inbox: async (input, signal) => {
      const selection = scope(input);
      const result = await services.reads.inbox(selection, signal);
      const [strategies, agents] = await Promise.all([
        Promise.all(
          bounded(result.strategies).map((value) =>
            artifact(StrategySpecSchema, value)
          )
        ),
        Promise.all(
          bounded(result.agents).map((value) => artifact(AgentRunSchema, value))
        ),
      ]);
      const reviews = bounded(result.reviews).map((value) =>
        parse(AcceptedReviewSchema, value)
      );
      const continuity = parse(VertexContinuityReadSchema, result.continuity);
      if (reviews.some((value) => !sameScope(value, selection)))
        return malformed();
      if (
        continuity.status === "available" &&
        !sameScope(continuity.continuity, selection)
      )
        return malformed();
      unique(strategies, (value) => value.artifactId);
      unique(agents, (value) => value.artifactId);
      unique(reviews, (value) => value.reviewId);
      return Object.freeze({ strategies, agents, reviews, continuity });
    },
    agents: async (input, signal) => {
      const result = await services.reads.agents(scope(input), signal);
      return unique(
        await Promise.all(
          bounded(result).map((value) => artifact(AgentRunSchema, value))
        ),
        (value) => value.artifactId
      );
    },
    agent: async (input, signal) => {
      const selection = {
        ...scope(input),
        artifactId: IdentifierSchema.parse(input.artifactId),
      };
      const result = await artifact(
        AgentRunSchema,
        await services.reads.agent(selection, signal)
      );
      if (result.artifactId !== selection.artifactId) return malformed();
      return result;
    },
    audit: async (input, signal) => {
      const selection = scope(input);
      const result = await services.reads.audit(selection, signal);
      const events = await Promise.all(
        bounded(result, 500).map(async (value) => {
          try {
            canonicalArtifactJson(value);
            return await ("fact" in value
              ? parseNativeFactProjection(value)
              : parseExecutionProjection(value));
          } catch {
            return malformed();
          }
        })
      );
      if (events.some((value) => !sameScope(value, selection)))
        return malformed();
      return unique(events, (value) => value.projectionId);
    },
    gateways: async (input, signal) =>
      unique(
        bounded(await services.reads.gateways(input, signal), 128).map(
          (value) => parse(VertexGatewayBindingSchema, value)
        ),
        (value) => `${value.gatewayId}/${value.environment}`
      ),
    gateway: async (input, signal) => {
      IdentifierSchema.parse(input.gatewayId);
      if (input.environment !== "paper" && input.environment !== "live")
        throw new VertexReadError("invalid");
      const result = parse(
        BrokerRecoveryStatusSchema,
        await services.reads.gateway(input, signal)
      );
      if (
        result.gatewayId !== input.gatewayId ||
        result.environment !== input.environment
      )
        return malformed();
      return result;
    },
  },
  reviews:
    services.reviews === null
      ? null
      : {
          decide: async (input, signal) => {
            scope(input);
            IdentifierSchema.parse(input.artifactId);
            DigestSchema.parse(input.artifactSha256);
            IdentifierSchema.parse(input.strategyVersion);
            IdentifierSchema.parse(input.idempotencyKey);
            if (input.environment === "live")
              throw new VertexReadError("denied");
            const result = parse(
              AcceptedReviewSchema,
              await (services.reviews?.decide(input, signal) ??
                Promise.reject(new VertexReadError("unavailable")))
            );
            if (
              !sameScope(result, input) ||
              result.artifactId !== input.artifactId ||
              result.artifactSha256 !== input.artifactSha256 ||
              result.strategyVersion !== input.strategyVersion ||
              result.decision !== input.decision ||
              result.purpose !== input.purpose ||
              result.supersedesReviewId !== input.expectedReviewId
            )
              return malformed();
            return result;
          },
        },
  jobs:
    services.jobs === null
      ? null
      : {
          proposeResearch: async (input, signal) => {
            scope(input);
            if (
              input.environment === "live" ||
              input.proposalOnly !== true ||
              input.executionAuthorized !== false
            )
              throw new VertexReadError("denied");
            if (
              input.question.length < 10 ||
              input.question.length > 2000 ||
              /[\u0000-\u001f\u007f]/u.test(input.question)
            )
              throw new VertexReadError("invalid");
            IdentifierSchema.parse(input.collectionId);
            IdentifierSchema.parse(input.idempotencyKey);
            for (const value of bounded(input.evidenceIds, 32))
              IdentifierSchema.parse(value);
            const result = await artifact(
              AgentRunSchema,
              await (services.jobs?.proposeResearch(input, signal) ??
                Promise.reject(new VertexReadError("unavailable")))
            );
            if (
              result.value.agentRole !== input.role ||
              result.value.status !== "queued" ||
              input.evidenceIds.some(
                (id) => !result.value.inputEvidenceIds.includes(id)
              )
            )
              return malformed();
            return result;
          },
          proposeSimulation: async (input, signal) => {
            if (
              input.environment !== "paper" ||
              input.simulationOnly !== true ||
              input.brokerSubmissionAllowed !== false ||
              input.liveAuthorization !== false
            )
              throw new VertexReadError("denied");
            for (const value of [
              input.accountAlias,
              input.admissionId,
              input.reviewId,
              input.intentId,
              input.strategyVersion,
              input.idempotencyKey,
            ])
              IdentifierSchema.parse(value);
            DigestSchema.parse(input.intentSha256);
            const result = await (services.jobs?.proposeSimulation(
              input,
              signal
            ) ?? Promise.reject(new VertexReadError("unavailable")));
            canonicalArtifactJson(result);
            if (
              Object.keys(result).sort().join(",") !==
                "admissionId,brokerSubmissionAllowed,jobId,liveAuthorization,simulationOnly,status" ||
              result.status !== "queued" ||
              result.admissionId !== input.admissionId ||
              result.simulationOnly !== true ||
              result.brokerSubmissionAllowed !== false ||
              result.liveAuthorization !== false
            )
              return malformed();
            IdentifierSchema.parse(result.jobId);
            return Object.freeze({ ...result });
          },
        },
});
