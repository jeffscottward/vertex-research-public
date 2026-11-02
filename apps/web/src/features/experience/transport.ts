import type { ApiClient } from "@darkfactory/api/client";
import {
  VertexContinuityReadSchema,
  VertexPortfolioGetInputSchema,
} from "@darkfactory/api/vertex";
import { canonicalArtifactJson } from "@darkfactory/shared/vertex";
import {
  classifyVertexFailure,
  VertexReadError,
} from "../../components/research/vertex-client.ts";
import { guardExperienceServices } from "./guards.ts";
import type {
  DecisionInbox,
  ExperienceScope,
  ExperienceServices,
} from "./ports.ts";
import { createResearchChatPort } from "./research-chat-client.ts";

const PAGE_SIZE = 100;
const COLLECTION_BOUND = 512;
const AUDIT_BOUND = 500;
const malformed = (): never => {
  throw new VertexReadError("malformed");
};
const checkAbort = (signal: AbortSignal): void => {
  if (signal.aborted) throw new VertexReadError("suspended");
};
const canonical = (value: unknown): string => {
  try {
    return canonicalArtifactJson(value);
  } catch {
    return malformed();
  }
};
const keys = (value: unknown, expected: string): void => {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== expected
  )
    throw new VertexReadError("malformed");
};

// The outer boundary includes async digest guards, not only the network request.
// Error text/cause/data from the server is never retained in a UI-facing error.
const request = async <T>(
  signal: AbortSignal,
  operation: () => Promise<T>
): Promise<T> => {
  checkAbort(signal);
  try {
    const result = await operation();
    checkAbort(signal);
    return result;
  } catch (error) {
    checkAbort(signal);
    throw new VertexReadError(classifyVertexFailure(error).kind);
  }
};

const scopeInput = (input: ExperienceScope): ExperienceScope => ({
  accountAlias: input.accountAlias,
  environment: input.environment,
});
const nextCursor = (value: unknown, seen: Set<string>): string | null => {
  if (value === null) return null;
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 4096 ||
    !/^[A-Za-z0-9_-]+$/.test(value) ||
    seen.has(value)
  )
    return malformed();
  seen.add(value);
  return value;
};
const append = <T>(
  target: T[],
  incoming: readonly T[],
  seen: Set<string>,
  identity: (item: T) => string,
  maximum = COLLECTION_BOUND
): void => {
  if (
    !Array.isArray(incoming) ||
    incoming.length > PAGE_SIZE ||
    target.length + incoming.length > maximum
  )
    throw new VertexReadError("malformed");
  for (const item of incoming) {
    if (typeof item !== "object" || item === null)
      throw new VertexReadError("malformed");
    const id = identity(item);
    if (typeof id !== "string" || id.length === 0 || seen.has(id))
      throw new VertexReadError("malformed");
    seen.add(id);
    target.push(item);
  }
};

type Page<T> = Readonly<{ items: readonly T[]; nextCursor: string | null }>;
const pages = async <T>(
  signal: AbortSignal,
  load: (cursor: string | null) => Promise<Page<T>>,
  identity: (item: T) => string,
  maximum = COLLECTION_BOUND
): Promise<readonly T[]> => {
  const items: T[] = [];
  const ids = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | null = null;
  while (true) {
    const page = await request(signal, () => load(cursor));
    canonical(page);
    keys(page, "items,nextCursor");
    append(items, page.items, ids, identity, maximum);
    cursor = nextCursor(page.nextCursor, cursors);
    if (cursor === null) return Object.freeze(items);
    // Never turn an incomplete/over-bound response into a successful partial list.
    if (page.items.length === 0 || items.length >= maximum) return malformed();
  }
};

// Continuity is evaluated on every page and can change freshness while paging.
// Validate each observation against the selected scope and retain the latest one.
const inboxPages = async (
  input: ExperienceScope,
  signal: AbortSignal,
  load: (
    cursor: string | null
  ) => Promise<DecisionInbox & Readonly<{ nextCursor: string | null }>>
): Promise<DecisionInbox> => {
  const strategies: DecisionInbox["strategies"][number][] = [];
  const agents: DecisionInbox["agents"][number][] = [];
  const reviews: DecisionInbox["reviews"][number][] = [];
  const strategyIds = new Set<string>();
  const agentIds = new Set<string>();
  const reviewIds = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | null = null;
  while (true) {
    const page = await request(signal, () => load(cursor));
    canonical(page);
    keys(page, "agents,continuity,nextCursor,reviews,strategies");
    const parsed = VertexContinuityReadSchema.safeParse(page.continuity);
    if (!parsed.success) return malformed();
    const continuity = parsed.data;
    if (
      continuity.status === "available" &&
      (continuity.continuity.accountAlias !== input.accountAlias ||
        continuity.continuity.environment !== input.environment)
    )
      return malformed();
    append(strategies, page.strategies, strategyIds, (item) => item.artifactId);
    append(agents, page.agents, agentIds, (item) => item.artifactId);
    append(reviews, page.reviews, reviewIds, (item) => item.reviewId);
    cursor = nextCursor(page.nextCursor, cursors);
    if (cursor === null) {
      return Object.freeze({
        strategies: Object.freeze(strategies),
        agents: Object.freeze(agents),
        reviews: Object.freeze(reviews),
        continuity,
      });
    }
    if (page.strategies.length + page.agents.length + page.reviews.length === 0)
      return malformed();
    if (
      strategies.length >= COLLECTION_BOUND &&
      agents.length >= COLLECTION_BOUND &&
      reviews.length >= COLLECTION_BOUND
    )
      return malformed();
  }
};

export const createExperienceScopeLoader = (
  client: ApiClient
): ((signal: AbortSignal) => Promise<readonly ExperienceScope[]>) => {
  return (signal) =>
    request(signal, async () => {
      const result = await request(signal, () =>
        client.vertex.experience.scopes({}, { signal })
      );
      canonical(result);
      if (!Array.isArray(result) || result.length > COLLECTION_BOUND)
        return malformed();
      const seen = new Set<string>();
      return Object.freeze(
        result.map((value) => {
          keys(value, "accountAlias,environment");
          const parsed = VertexPortfolioGetInputSchema.safeParse(value);
          if (!parsed.success) return malformed();
          const identity = `${parsed.data.accountAlias}/${parsed.data.environment}`;
          if (seen.has(identity)) return malformed();
          seen.add(identity);
          return Object.freeze(parsed.data);
        })
      );
    });
};

export const createExperienceServices = (
  client: ApiClient
): ExperienceServices => {
  const api = client.vertex.experience;
  const loadScopes = createExperienceScopeLoader(client);
  const guarded = guardExperienceServices({
    researchChat:
      // Older clients may lack the capability entirely (undefined) or disable it (null).
      (client.vertex.researchChat ?? null) === null
        ? null
        : createResearchChatPort(client),
    reads: {
      scopes: (_input, signal) => loadScopes(signal),
      portfolio: (input, signal) =>
        request(signal, () => api.portfolio(scopeInput(input), { signal })),
      continuity: (input, signal) =>
        request(signal, () =>
          api.continuity(
            { ...scopeInput(input), streamId: input.streamId },
            { signal }
          )
        ),
      inbox: (input, signal) =>
        inboxPages(input, signal, (cursor) =>
          api.inbox(
            { ...scopeInput(input), limit: PAGE_SIZE, cursor },
            { signal }
          )
        ),
      strategies: (input, signal) =>
        pages(
          signal,
          (cursor) =>
            api.strategies(
              { ...scopeInput(input), limit: PAGE_SIZE, cursor },
              { signal }
            ),
          (item) => item.artifactId
        ),
      dossier: (input, signal) =>
        request(signal, () =>
          api.dossier(
            { ...scopeInput(input), artifactId: input.artifactId },
            { signal }
          )
        ),
      agents: (input, signal) =>
        pages(
          signal,
          (cursor) =>
            api.agents(
              { ...scopeInput(input), limit: PAGE_SIZE, cursor },
              { signal }
            ),
          (item) => item.artifactId
        ),
      agent: (input, signal) =>
        request(signal, () =>
          api.agent(
            { ...scopeInput(input), artifactId: input.artifactId },
            { signal }
          )
        ),
      audit: (input, signal) =>
        pages(
          signal,
          (cursor) =>
            api.audit(
              { ...scopeInput(input), limit: PAGE_SIZE, cursor },
              { signal }
            ),
          (item) => item.projectionId,
          AUDIT_BOUND
        ),
      gateways: (_input, signal) =>
        request(signal, () => api.gateways({}, { signal })),
      gateway: (input, signal) =>
        request(signal, () =>
          api.gateway(
            { gatewayId: input.gatewayId, environment: input.environment },
            { signal }
          )
        ),
    },
    reviews: {
      decide: (input, signal) =>
        request(signal, () =>
          api.decideReview(
            {
              ...scopeInput(input),
              artifactId: input.artifactId,
              artifactSha256: input.artifactSha256,
              strategyVersion: input.strategyVersion,
              decision: input.decision,
              purpose: input.purpose,
              expectedReviewId: input.expectedReviewId,
              idempotencyKey: input.idempotencyKey,
            },
            { signal }
          )
        ),
    },
    jobs: {
      proposeResearch: (input, signal) =>
        request(signal, () =>
          api.proposeResearch(
            {
              ...scopeInput(input),
              question: input.question,
              collectionId: input.collectionId,
              evidenceIds: [...input.evidenceIds],
              role: input.role,
              idempotencyKey: input.idempotencyKey,
              proposalOnly: input.proposalOnly,
              executionAuthorized: input.executionAuthorized,
            },
            { signal }
          )
        ),
      proposeSimulation: (input, signal) =>
        request(signal, () =>
          api.proposeSimulation(
            {
              accountAlias: input.accountAlias,
              environment: input.environment,
              admissionId: input.admissionId,
              reviewId: input.reviewId,
              reviewVersion: input.reviewVersion,
              intentId: input.intentId,
              intentSha256: input.intentSha256,
              strategyVersion: input.strategyVersion,
              idempotencyKey: input.idempotencyKey,
              simulationOnly: input.simulationOnly,
              brokerSubmissionAllowed: input.brokerSubmissionAllowed,
              liveAuthorization: input.liveAuthorization,
            },
            { signal }
          )
        ),
    },
  });
  return Object.freeze<ExperienceServices>({
    researchChat: guarded.researchChat ?? null,
    reads: Object.freeze<ExperienceServices["reads"]>({
      scopes: (input, signal) =>
        request(signal, () => guarded.reads.scopes(input, signal)),
      portfolio: (input, signal) =>
        request(signal, () => guarded.reads.portfolio(input, signal)),
      continuity: (input, signal) =>
        request(signal, () => guarded.reads.continuity(input, signal)),
      inbox: (input, signal) =>
        request(signal, () => guarded.reads.inbox(input, signal)),
      strategies: (input, signal) =>
        request(signal, () => guarded.reads.strategies(input, signal)),
      dossier: (input, signal) =>
        request(signal, () => guarded.reads.dossier(input, signal)),
      agents: (input, signal) =>
        request(signal, () => guarded.reads.agents(input, signal)),
      agent: (input, signal) =>
        request(signal, () => guarded.reads.agent(input, signal)),
      audit: (input, signal) =>
        request(signal, () => guarded.reads.audit(input, signal)),
      gateways: (input, signal) =>
        request(signal, () => guarded.reads.gateways(input, signal)),
      gateway: (input, signal) =>
        request(signal, () => guarded.reads.gateway(input, signal)),
    }),
    reviews: Object.freeze<NonNullable<ExperienceServices["reviews"]>>({
      decide: (input, signal) =>
        request(
          signal,
          () =>
            guarded.reviews?.decide(input, signal) ??
            Promise.reject(new VertexReadError("unavailable"))
        ),
    }),
    jobs: Object.freeze<NonNullable<ExperienceServices["jobs"]>>({
      proposeResearch: (input, signal) =>
        request(
          signal,
          () =>
            guarded.jobs?.proposeResearch(input, signal) ??
            Promise.reject(new VertexReadError("unavailable"))
        ),
      proposeSimulation: (input, signal) =>
        request(
          signal,
          () =>
            guarded.jobs?.proposeSimulation(input, signal) ??
            Promise.reject(new VertexReadError("unavailable"))
        ),
    }),
  });
};
