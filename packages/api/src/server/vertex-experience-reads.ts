import type { SafePrincipal } from "@darkfactory/auth/types";
import type {
  VertexArtifactMetadata,
  VertexPrincipal,
  VertexScope,
} from "@darkfactory/db/server/vertex";
import { canonicalArtifactJson } from "@darkfactory/shared/vertex";
import { z } from "zod";
import {
  AgentRunSchema,
  BacktestRunSchema,
  BrokerRecoveryStatusSchema,
  DatasetManifestSchema,
  IdentifierSchema,
  ModuleManifestSchema,
  ResearchEvidenceSchema,
  StrategySpecSchema,
  TradeIntentSchema,
  type DatasetManifest,
  type ResearchEvidence,
} from "../contracts/vertex.ts";
import {
  AcceptedReviewSchema,
  type ExecutionProjectionSchema,
  PaperSimulationAdmissionSchema,
  PortfolioSnapshotSchema,
  ProjectionContinuitySchema,
  VertexContinuityGetInputSchema,
  VertexContinuityReadSchema,
  VertexPortfolioGetInputSchema,
  VertexPortfolioReadSchema,
  parseExecutionProjection,
  type AcceptedReview,
  type VertexContinuityRead,
} from "../contracts/vertex-control.ts";
import {
  parseNativeFactProjection,
  type NativeFactProjection,
} from "../contracts/vertex-native-facts.ts";
import {
  VertexAgentArtifactSchema,
  VertexAgentsPageSchema,
  VertexAuditPageSchema,
  VertexCursorSchema,
  VertexDossierSchema,
  VertexGatewayGetInputSchema,
  VertexGatewaysInputSchema,
  VertexGatewaysOutputSchema,
  VertexInboxPageSchema,
  VertexPageInputSchema,
  VertexScopedArtifactInputSchema,
  VertexScopesInputSchema,
  VertexScopesOutputSchema,
  VertexStrategiesPageSchema,
} from "../contracts/vertex-experience.ts";
import {
  authorizeVertex,
  checkVertexCancellation,
  collectVertexPages,
  failVertex,
  loadVertexArtifact,
  requireVertexScope,
  sameVertexScope,
  vertexActor,
  vertexInput,
  vertexOperation,
  vertexPage,
  vertexPorts,
  vertexSource,
  VertexExperienceServiceError,
  type VertexExperienceDependencies,
} from "./vertex-experience-core.ts";
import { present } from "./present.ts";

type ImmutableName =
  | "StrategySpec"
  | "AgentRun"
  | "TradeIntent"
  | "BacktestRun"
  | "ResearchEvidence"
  | "DatasetManifest"
  | "ModuleManifest";
type Artifact<T> = Readonly<{ artifactId: string; sha256: string; value: T }>;
type Page<T> = Readonly<{ items: readonly T[]; nextCursor: string | null }>;
type PageInput = z.infer<typeof VertexPageInputSchema>;
export type VertexExperienceReads = Readonly<{
  scopes: (
    principal: SafePrincipal,
    input: z.infer<typeof VertexScopesInputSchema>
  ) => Promise<z.infer<typeof VertexScopesOutputSchema>>;
  gateways: (
    principal: SafePrincipal,
    input: z.infer<typeof VertexGatewaysInputSchema>
  ) => Promise<z.infer<typeof VertexGatewaysOutputSchema>>;
  portfolio: (
    principal: SafePrincipal,
    input: z.infer<typeof VertexPortfolioGetInputSchema>
  ) => Promise<z.infer<typeof VertexPortfolioReadSchema>>;
  continuity: (
    principal: SafePrincipal,
    input: z.infer<typeof VertexContinuityGetInputSchema>
  ) => Promise<VertexContinuityRead>;
  inbox: (
    principal: SafePrincipal,
    input: PageInput
  ) => Promise<z.infer<typeof VertexInboxPageSchema>>;
  strategies: (
    principal: SafePrincipal,
    input: PageInput
  ) => Promise<z.infer<typeof VertexStrategiesPageSchema>>;
  dossier: (
    principal: SafePrincipal,
    input: z.infer<typeof VertexScopedArtifactInputSchema>
  ) => Promise<z.infer<typeof VertexDossierSchema>>;
  agents: (
    principal: SafePrincipal,
    input: PageInput
  ) => Promise<z.infer<typeof VertexAgentsPageSchema>>;
  agent: (
    principal: SafePrincipal,
    input: z.infer<typeof VertexScopedArtifactInputSchema>
  ) => Promise<z.infer<typeof VertexAgentArtifactSchema>>;
  audit: (
    principal: SafePrincipal,
    input: PageInput
  ) => Promise<z.infer<typeof VertexAuditPageSchema>>;
  gateway: (
    principal: SafePrincipal,
    input: z.infer<typeof VertexGatewayGetInputSchema>
  ) => Promise<z.infer<typeof BrokerRecoveryStatusSchema>>;
}>;

const PageEnvelopeSchema = z
  .object({
    items: z.array(z.unknown()).max(100),
    nextCursor: VertexCursorSchema,
  })
  .strict();
const CursorSectionSchema = z
  .object({ cursor: VertexCursorSchema, exhausted: z.boolean() })
  .strict()
  .refine((value) => !value.exhausted || value.cursor === null);
const InboxCursorSchema = z
  .object({
    version: z.literal(1),
    actorId: IdentifierSchema,
    scope: VertexPortfolioGetInputSchema,
    limit: z.number().int().min(1).max(100),
    strategies: CursorSectionSchema,
    agents: CursorSectionSchema,
    reviews: CursorSectionSchema,
  })
  .strict();
type InboxCursor = z.infer<typeof InboxCursorSchema>;
const immutableSchemas: Readonly<
  Record<ImmutableName, z.ZodType<Readonly<Record<string, unknown>>>>
> = {
  StrategySpec: StrategySpecSchema,
  AgentRun: AgentRunSchema,
  TradeIntent: TradeIntentSchema,
  BacktestRun: BacktestRunSchema,
  ResearchEvidence: ResearchEvidenceSchema,
  DatasetManifest: DatasetManifestSchema,
  ModuleManifest: ModuleManifestSchema,
};

const scopeOf = (input: VertexScope): VertexScope => ({
  accountAlias: input.accountAlias,
  environment: input.environment,
});
const requireSourceScope = (scope: VertexScope, value: VertexScope): void => {
  if (!sameVertexScope(scope, value)) failVertex("INVALID_SOURCE");
};
const unique = <T>(
  items: readonly T[],
  identity: (item: T) => string
): readonly T[] => {
  const ids = new Set<string>();
  for (const item of items) {
    const id = vertexSource(IdentifierSchema, identity(item));
    if (ids.has(id)) return failVertex("INVALID_SOURCE");
    ids.add(id);
  }
  return items;
};
const checkedPage = <T>(
  source: unknown,
  limit: number,
  cursor: string | null
): Page<T> => {
  const page = vertexPage(vertexSource(PageEnvelopeSchema, source), limit);
  if (page.nextCursor !== null && page.nextCursor === cursor)
    return failVertex("INVALID_SOURCE");
  return structuredClone(page) as Page<T>;
};
const encodeCursor = (state: InboxCursor): string =>
  btoa(canonicalArtifactJson(state))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/[=]+$/g, "");
const decodeCursor = (
  input: PageInput,
  actor: VertexPrincipal
): InboxCursor => {
  if (input.cursor === null) {
    return {
      version: 1,
      actorId: actor.actorId,
      scope: scopeOf(input),
      limit: input.limit,
      strategies: { cursor: null, exhausted: false },
      agents: { cursor: null, exhausted: false },
      reviews: { cursor: null, exhausted: false },
    };
  }
  try {
    const text = atob(input.cursor.replace(/-/g, "+").replace(/_/g, "/"));
    const state = vertexInput(InboxCursorSchema, JSON.parse(text));
    if (
      encodeCursor(state) !== input.cursor ||
      state.actorId !== actor.actorId ||
      !sameVertexScope(state.scope, input) ||
      state.limit !== input.limit ||
      (state.strategies.exhausted &&
        state.agents.exhausted &&
        state.reviews.exhausted)
    )
      return failVertex("BAD_REQUEST");
    return state;
  } catch {
    return failVertex("BAD_REQUEST");
  }
};

export const createVertexExperienceReads = (
  dependencies: VertexExperienceDependencies = {}
): VertexExperienceReads => {
  const call = <T>(operation: () => Promise<T>): Promise<T> =>
    vertexOperation(dependencies, operation);
  const find = async (
    actor: VertexPrincipal,
    scope: VertexScope,
    input: Readonly<{
      contractName?: ImmutableName;
      artifactId?: string;
      recordId?: string;
    }>,
    missing: "NOT_FOUND" | "SERVICE_UNAVAILABLE" = "SERVICE_UNAVAILABLE"
  ): Promise<VertexArtifactMetadata> => {
    await authorizeVertex(dependencies, actor, scope, "records");
    const metadata = await call(() =>
      vertexPorts(dependencies).store.findRecordArtifact(actor, scope, input)
    );
    if (metadata === null) return failVertex(missing);
    // Parsing the catalog identity before dereferencing catches malformed ports.
    const identity = vertexSource(
      z
        .object({
          artifactId: IdentifierSchema,
          contractName: z.string(),
          scope: VertexPortfolioGetInputSchema,
        })
        .passthrough(),
      metadata
    );
    requireSourceScope(scope, identity.scope);
    if (
      (input.artifactId !== undefined &&
        identity.artifactId !== input.artifactId) ||
      (input.contractName !== undefined &&
        identity.contractName !== input.contractName)
    )
      return failVertex("INVALID_SOURCE");
    return structuredClone(metadata);
  };
  const load = async <T>(
    actor: VertexPrincipal,
    scope: VertexScope,
    metadata: VertexArtifactMetadata,
    schema: z.ZodType<T>,
    name: ImmutableName
  ): Promise<Artifact<T>> => {
    const artifact = await loadVertexArtifact(
      dependencies,
      actor,
      scope,
      metadata,
      schema,
      name
    );
    const value = artifact.value as Readonly<Record<string, unknown>>;
    if (name === "TradeIntent") {
      requireSourceScope(scope, value as VertexScope);
    }
    if (
      name === "ResearchEvidence" &&
      (value["collectionId"] !== metadata.collectionId ||
        value["contentHash"] !== metadata.sourceContentSha256 ||
        value["rightsPolicyId"] !== metadata.rights.policyId)
    )
      return failVertex("INVALID_SOURCE");
    if (
      name === "DatasetManifest" &&
      value["contentHash"] !== metadata.sourceContentSha256
    )
      return failVertex("INVALID_SOURCE");
    checkVertexCancellation(dependencies);
    return artifact;
  };
  const artifacts = async <T>(
    actor: VertexPrincipal,
    scope: VertexScope,
    options: Readonly<{
      limit: number;
      cursor: string | null;
      strategyVersion?: string;
    }>,
    schema: z.ZodType<T>,
    name: ImmutableName,
    catalog?: Map<string, VertexArtifactMetadata>
  ): Promise<Page<Artifact<T>>> => {
    if (!dependencies.storage) return failVertex("SERVICE_UNAVAILABLE");
    await authorizeVertex(dependencies, actor, scope, "artifacts");
    const raw = await call(() =>
      vertexPorts(dependencies).store.listArtifacts(actor, scope, {
        ...options,
        contractName: name,
      })
    );
    const page = checkedPage<VertexArtifactMetadata>(
      raw,
      options.limit,
      options.cursor
    );
    const items: Artifact<T>[] = [];
    for (const metadata of page.items) {
      const item = await load(actor, scope, metadata, schema, name);
      items.push(item);
      catalog?.set(item.artifactId, metadata);
    }
    unique(items, (item) => item.artifactId);
    return { items, nextCursor: page.nextCursor };
  };
  const loadAny = async (
    actor: VertexPrincipal,
    scope: VertexScope,
    metadata: VertexArtifactMetadata
  ) => {
    if (!Object.hasOwn(immutableSchemas, metadata.contractName))
      return failVertex("INVALID_SOURCE");
    const name = metadata.contractName as ImmutableName;
    return await load(actor, scope, metadata, immutableSchemas[name], name);
  };
  const review = async (
    actor: VertexPrincipal,
    scope: VertexScope,
    raw: unknown,
    strategyVersion?: string
  ): Promise<AcceptedReview> => {
    const value = vertexSource(AcceptedReviewSchema, raw);
    requireSourceScope(scope, value);
    if (
      strategyVersion !== undefined &&
      value.strategyVersion !== strategyVersion
    )
      return failVertex("INVALID_SOURCE");
    await authorizeVertex(
      dependencies,
      actor,
      scope,
      value.reviewId,
      "read",
      value.collectionId
    );
    const metadata = await find(actor, scope, { artifactId: value.artifactId });
    if (
      metadata.artifactSha256 !== value.artifactSha256 ||
      metadata.collectionId !== value.collectionId
    )
      return failVertex("INVALID_SOURCE");
    const linked = await loadAny(actor, scope, metadata);
    if (
      (metadata.contractName === "StrategySpec" &&
        linked.artifactId !== value.strategyVersion) ||
      (linked.value["strategyVersion"] !== undefined &&
        linked.value["strategyVersion"] !== value.strategyVersion) ||
      (value.purpose === "paper-simulation" &&
        metadata.contractName !== "TradeIntent")
    )
      return failVertex("INVALID_SOURCE");
    const strategy = await find(actor, scope, {
      artifactId: value.strategyVersion,
      contractName: "StrategySpec",
    });
    await load(actor, scope, strategy, StrategySpecSchema, "StrategySpec");
    return value;
  };
  const reviews = async (
    actor: VertexPrincipal,
    scope: VertexScope,
    options: Readonly<{
      limit: number;
      cursor: string | null;
      strategyVersion?: string;
    }>
  ): Promise<Page<AcceptedReview>> => {
    await authorizeVertex(dependencies, actor, scope, "reviews");
    const page = checkedPage<unknown>(
      await call(() =>
        vertexPorts(dependencies).store.listScopeReviews(actor, scope, options)
      ),
      options.limit,
      options.cursor
    );
    const items: AcceptedReview[] = [];
    for (const raw of page.items)
      items.push(await review(actor, scope, raw, options.strategyVersion));
    unique(items, (item) => item.reviewId);
    return { items, nextCursor: page.nextCursor };
  };
  const readPortfolio = async (actor: VertexPrincipal, scope: VertexScope) => {
    await authorizeVertex(dependencies, actor, scope, "portfolio");
    const raw = await call(() =>
      vertexPorts(dependencies).store.getPortfolioSnapshot(actor, scope)
    );
    if (raw === null)
      return vertexSource(VertexPortfolioReadSchema, {
        status: "unavailable",
        reason: "not-found",
        executionAuthorized: false,
      });
    const snapshot = vertexSource(PortfolioSnapshotSchema, raw);
    requireSourceScope(scope, snapshot);
    return vertexSource(VertexPortfolioReadSchema, {
      status: "available",
      snapshot,
    });
  };
  const readContinuity = async (
    actor: VertexPrincipal,
    scope: VertexScope,
    streamId: string
  ): Promise<VertexContinuityRead> => {
    await authorizeVertex(dependencies, actor, scope, streamId);
    const raw = await call(() =>
      vertexPorts(dependencies).store.getContinuity(actor, scope, streamId)
    );
    if (raw === null)
      return vertexSource(VertexContinuityReadSchema, {
        status: "unavailable",
        reason: "not-found",
        executionAuthorized: false,
      });
    const continuity = vertexSource(ProjectionContinuitySchema, raw);
    requireSourceScope(scope, continuity);
    if (continuity.streamId !== streamId) return failVertex("INVALID_SOURCE");
    return vertexSource(VertexContinuityReadSchema, {
      status: "available",
      continuity,
    });
  };

  return Object.freeze({
    scopes: (principal, input) =>
      call(async () => {
        vertexInput(VertexScopesInputSchema, input);
        const actor = vertexActor(principal);
        const scopes = vertexSource(
          VertexScopesOutputSchema,
          await call(() =>
            vertexPorts(dependencies).authorization.listAuthorizedScopes(actor)
          )
        );
        const identities = new Set<string>();
        for (const scope of scopes) {
          const key = canonicalArtifactJson(scope);
          if (identities.has(key)) return failVertex("INVALID_SOURCE");
          identities.add(key);
          await authorizeVertex(dependencies, actor, scope, "account-scope");
        }
        return scopes;
      }),
    // Lists configured gateways whose account scope and gateway the caller may
    // read, so Connections shows them without a typed gateway ID. A missing
    // grant hides the gateway; any other failure fails the whole list.
    gateways: (principal, input) =>
      call(async () => {
        vertexInput(VertexGatewaysInputSchema, input);
        const actor = vertexActor(principal);
        vertexPorts(dependencies);
        if (!dependencies.gateway) return failVertex("SERVICE_UNAVAILABLE");
        const bindings = vertexSource(
          VertexGatewaysOutputSchema,
          await call(() => present(dependencies.gateway).listBindings())
        );
        const identities = new Set<string>();
        const visible: (typeof bindings)[number][] = [];
        for (const binding of bindings) {
          const key = canonicalArtifactJson([
            binding.gatewayId,
            binding.environment,
          ]);
          if (identities.has(key)) return failVertex("INVALID_SOURCE");
          identities.add(key);
          const scope = {
            accountAlias: binding.accountAlias,
            environment: binding.environment,
          };
          try {
            await authorizeVertex(dependencies, actor, scope, "account-scope");
            await authorizeVertex(
              dependencies,
              actor,
              scope,
              binding.gatewayId
            );
          } catch (error) {
            if (
              error instanceof VertexExperienceServiceError &&
              error.code === "FORBIDDEN"
            )
              continue;
            throw error;
          }
          visible.push(binding);
        }
        return visible;
      }),
    portfolio: (principal, input) =>
      call(async () => {
        const scope = vertexInput(VertexPortfolioGetInputSchema, input);
        const actor = await requireVertexScope(dependencies, principal, scope);
        return readPortfolio(actor, scope);
      }),
    continuity: (principal, input) =>
      call(async () => {
        const value = vertexInput(VertexContinuityGetInputSchema, input);
        const scope = scopeOf(value);
        const actor = await requireVertexScope(dependencies, principal, scope);
        return readContinuity(actor, scope, value.streamId);
      }),
    strategies: (principal, input) =>
      call(async () => {
        const value = vertexInput(VertexPageInputSchema, input);
        const scope = scopeOf(value);
        const actor = await requireVertexScope(dependencies, principal, scope);
        return vertexSource(
          VertexStrategiesPageSchema,
          await artifacts(
            actor,
            scope,
            { limit: value.limit, cursor: value.cursor },
            StrategySpecSchema,
            "StrategySpec"
          )
        );
      }),
    agents: (principal, input) =>
      call(async () => {
        const value = vertexInput(VertexPageInputSchema, input);
        const scope = scopeOf(value);
        const actor = await requireVertexScope(dependencies, principal, scope);
        return vertexSource(
          VertexAgentsPageSchema,
          await artifacts(
            actor,
            scope,
            { limit: value.limit, cursor: value.cursor },
            AgentRunSchema,
            "AgentRun"
          )
        );
      }),
    agent: (principal, input) =>
      call(async () => {
        const value = vertexInput(VertexScopedArtifactInputSchema, input);
        const scope = scopeOf(value);
        const actor = await requireVertexScope(dependencies, principal, scope);
        const metadata = await find(
          actor,
          scope,
          { artifactId: value.artifactId, contractName: "AgentRun" },
          "NOT_FOUND"
        );
        return vertexSource(
          VertexAgentArtifactSchema,
          await load(actor, scope, metadata, AgentRunSchema, "AgentRun")
        );
      }),
    inbox: (principal, input) =>
      call(async () => {
        const value = vertexInput(VertexPageInputSchema, input);
        const scope = scopeOf(value);
        const actor = await requireVertexScope(dependencies, principal, scope);
        // This cursor is pagination state, never an authorization decision. Every
        // nonexhausted section is still read with the current actor and grants.
        const state = decodeCursor(value, actor);
        const strategyPage = state.strategies.exhausted
          ? { items: [], nextCursor: null }
          : await artifacts(
              actor,
              scope,
              { limit: value.limit, cursor: state.strategies.cursor },
              StrategySpecSchema,
              "StrategySpec"
            );
        const agentPage = state.agents.exhausted
          ? { items: [], nextCursor: null }
          : await artifacts(
              actor,
              scope,
              { limit: value.limit, cursor: state.agents.cursor },
              AgentRunSchema,
              "AgentRun"
            );
        const reviewPage = state.reviews.exhausted
          ? { items: [], nextCursor: null }
          : await reviews(actor, scope, {
              limit: value.limit,
              cursor: state.reviews.cursor,
            });
        const portfolio = await readPortfolio(actor, scope);
        const continuity =
          portfolio.status === "available"
            ? await readContinuity(actor, scope, portfolio.snapshot.streamId)
            : vertexSource(VertexContinuityReadSchema, portfolio);
        const next = {
          ...state,
          strategies: {
            cursor: strategyPage.nextCursor,
            exhausted: strategyPage.nextCursor === null,
          },
          agents: {
            cursor: agentPage.nextCursor,
            exhausted: agentPage.nextCursor === null,
          },
          reviews: {
            cursor: reviewPage.nextCursor,
            exhausted: reviewPage.nextCursor === null,
          },
        };
        const nextCursor =
          next.strategies.exhausted &&
          next.agents.exhausted &&
          next.reviews.exhausted
            ? null
            : encodeCursor(next);
        if (nextCursor !== null && nextCursor.length > 4096)
          return failVertex("SERVICE_UNAVAILABLE");
        if (nextCursor !== null && nextCursor === value.cursor)
          return failVertex("INVALID_SOURCE");
        return vertexSource(VertexInboxPageSchema, {
          strategies: strategyPage.items,
          agents: agentPage.items,
          reviews: reviewPage.items,
          continuity,
          nextCursor,
        });
      }),
    dossier: (principal, input) =>
      call(async () => {
        const value = vertexInput(VertexScopedArtifactInputSchema, input);
        const scope = scopeOf(value);
        const actor = await requireVertexScope(dependencies, principal, scope);
        const metadata = await find(
          actor,
          scope,
          { artifactId: value.artifactId, contractName: "StrategySpec" },
          "NOT_FOUND"
        );
        const strategy = await load(
          actor,
          scope,
          metadata,
          StrategySpecSchema,
          "StrategySpec"
        );
        // strategyVersion always means the immutable artifactId, never its label.
        const strategyVersion = strategy.artifactId;
        const catalog = new Map<string, VertexArtifactMetadata>();
        const drafts = unique(
          await collectVertexPages((cursor) =>
            artifacts(
              actor,
              scope,
              { limit: 100, cursor, strategyVersion },
              TradeIntentSchema,
              "TradeIntent",
              catalog
            )
          ),
          (item) => item.artifactId
        );
        const backtests = unique(
          await collectVertexPages((cursor) =>
            artifacts(
              actor,
              scope,
              { limit: 100, cursor, strategyVersion },
              BacktestRunSchema,
              "BacktestRun",
              catalog
            )
          ),
          (item) => item.artifactId
        );
        for (const draft of drafts) {
          requireSourceScope(scope, draft.value);
          if (draft.value.strategyVersion !== strategyVersion)
            return failVertex("INVALID_SOURCE");
        }
        for (const backtest of backtests) {
          if (backtest.value.strategyVersion !== strategyVersion)
            return failVertex("INVALID_SOURCE");
        }
        const evidenceRefs = new Map<string, string | null>();
        const datasetRefs = new Map<string, Set<string | null>>();
        const reference = (
          refs: Map<string, string | null>,
          id: string,
          collectionId: string | null
        ): void => {
          if (refs.has(id) && refs.get(id) !== collectionId)
            failVertex("INVALID_SOURCE");
          refs.set(id, collectionId);
          if (refs.size > 512) failVertex("SERVICE_UNAVAILABLE");
        };
        for (const draft of drafts) {
          for (const id of draft.value.reasonEvidenceIds)
            reference(
              evidenceRefs,
              id,
              present(catalog.get(draft.artifactId)).collectionId
            );
        }
        for (const backtest of backtests) {
          const collectionId = present(
            catalog.get(backtest.artifactId)
          ).collectionId;
          for (const id of backtest.value.datasetManifestIds) {
            const collections = datasetRefs.get(id) ?? new Set<string | null>();
            collections.add(collectionId);
            datasetRefs.set(id, collections);
            if (datasetRefs.size > 512)
              return failVertex("SERVICE_UNAVAILABLE");
          }
          for (const check of backtest.value.leakageChecks) {
            if (check.evidenceId !== null)
              reference(evidenceRefs, check.evidenceId, collectionId);
          }
        }
        const evidence: ResearchEvidence[] = [];
        for (const [recordId, collectionId] of evidenceRefs) {
          const source = await find(actor, scope, {
            contractName: "ResearchEvidence",
            recordId,
          });
          const item = await load(
            actor,
            scope,
            source,
            ResearchEvidenceSchema,
            "ResearchEvidence"
          );
          if (
            item.value.evidenceId !== recordId ||
            item.value.collectionId !== collectionId ||
            source.collectionId !== collectionId ||
            item.value.contentHash !== source.sourceContentSha256 ||
            item.value.rightsPolicyId !== source.rights.policyId
          )
            return failVertex("INVALID_SOURCE");
          evidence.push(item.value);
        }
        const datasets: DatasetManifest[] = [];
        for (const [recordId, collections] of datasetRefs) {
          const source = await find(actor, scope, {
            contractName: "DatasetManifest",
            recordId,
          });
          const item = await load(
            actor,
            scope,
            source,
            DatasetManifestSchema,
            "DatasetManifest"
          );
          if (
            item.value.datasetId !== recordId ||
            item.value.contentHash !== source.sourceContentSha256 ||
            (source.collectionId !== null &&
              (collections.size !== 1 || !collections.has(source.collectionId)))
          )
            return failVertex("INVALID_SOURCE");
          datasets.push(item.value);
        }
        const acceptedReviews = unique(
          await collectVertexPages((cursor) =>
            reviews(actor, scope, { limit: 100, cursor, strategyVersion })
          ),
          (item) => item.reviewId
        );
        const admissions = unique(
          await collectVertexPages(async (cursor) => {
            await authorizeVertex(
              dependencies,
              actor,
              scope,
              "paper-admissions"
            );
            const page = checkedPage<unknown>(
              await call(() =>
                vertexPorts(dependencies).store.listPaperAdmissions(
                  actor,
                  scope,
                  { limit: 100, cursor, strategyVersion }
                )
              ),
              100,
              cursor
            );
            const items = page.items.map((raw) =>
              vertexSource(PaperSimulationAdmissionSchema, raw)
            );
            for (const item of items) {
              requireSourceScope(scope, item);
              if (item.strategyVersion !== strategyVersion)
                return failVertex("INVALID_SOURCE");
              const reviewed = acceptedReviews.find(
                (entry) => entry.reviewId === item.reviewId
              );
              const draft = drafts.find(
                (entry) =>
                  entry.value.intentId === item.intentId &&
                  entry.sha256 === item.intentSha256
              );
              if (!(reviewed && draft))
                return failVertex("SERVICE_UNAVAILABLE");
              if (
                reviewed.artifactId !== draft.artifactId ||
                reviewed.artifactSha256 !== item.reviewedArtifactSha256 ||
                reviewed.reviewVersion !== item.reviewVersion ||
                reviewed.actorId !== item.actorId ||
                reviewed.policyVersion !== item.policyVersion ||
                reviewed.decision !== "accepted" ||
                reviewed.purpose !== "paper-simulation"
              )
                return failVertex("INVALID_SOURCE");
              await authorizeVertex(
                dependencies,
                actor,
                scope,
                item.admissionId,
                "read",
                reviewed.collectionId
              );
            }
            return { items, nextCursor: page.nextCursor };
          }),
          (item) => item.admissionId
        );
        return vertexSource(VertexDossierSchema, {
          strategy,
          drafts,
          evidence,
          datasets,
          backtests,
          reviews: acceptedReviews,
          admissions,
        });
      }),
    audit: (principal, input) =>
      call(async () => {
        const value = vertexInput(VertexPageInputSchema, input);
        const scope = scopeOf(value);
        const actor = await requireVertexScope(dependencies, principal, scope);
        await authorizeVertex(dependencies, actor, scope, "execution-audit");
        const page = checkedPage<unknown>(
          await call(() =>
            vertexPorts(dependencies).store.listExecutionProjections(
              actor,
              scope,
              { limit: value.limit, cursor: value.cursor }
            )
          ),
          value.limit,
          value.cursor
        );
        const items: (
          | z.infer<typeof ExecutionProjectionSchema>
          | NativeFactProjection
        )[] = [];
        for (const raw of page.items) {
          let projection:
            | z.infer<typeof ExecutionProjectionSchema>
            | NativeFactProjection;
          try {
            canonicalArtifactJson(raw);
            if (raw === null || typeof raw !== "object")
              return failVertex("INVALID_SOURCE");
            projection = Object.hasOwn(raw, "fact")
              ? await parseNativeFactProjection(raw)
              : await parseExecutionProjection(raw);
          } catch {
            return failVertex("INVALID_SOURCE");
          }
          checkVertexCancellation(dependencies);
          requireSourceScope(scope, projection);
          await authorizeVertex(
            dependencies,
            actor,
            scope,
            projection.streamId
          );
          items.push(projection);
        }
        unique(items, (item) => item.projectionId);
        return vertexSource(VertexAuditPageSchema, {
          items,
          nextCursor: page.nextCursor,
        });
      }),
    gateway: (principal, input) =>
      call(async () => {
        const value = vertexInput(VertexGatewayGetInputSchema, input);
        const actor = vertexActor(principal);
        vertexPorts(dependencies);
        if (!dependencies.gateway) return failVertex("SERVICE_UNAVAILABLE");
        const resolved = await call(() =>
          present(dependencies.gateway).resolveScope(
            value.gatewayId,
            value.environment
          )
        );
        if (resolved === null) return failVertex("SERVICE_UNAVAILABLE");
        const scope = vertexSource(VertexPortfolioGetInputSchema, resolved);
        if (scope.environment !== value.environment)
          return failVertex("INVALID_SOURCE");
        await authorizeVertex(dependencies, actor, scope, "account-scope");
        await authorizeVertex(dependencies, actor, scope, value.gatewayId);
        const status = vertexSource(
          BrokerRecoveryStatusSchema,
          await call(() =>
            present(dependencies.gateway).readStatus(
              actor,
              value.gatewayId,
              value.environment,
              dependencies.signal
            )
          )
        );
        if (
          status.gatewayId !== value.gatewayId ||
          status.environment !== value.environment
        )
          return failVertex("INVALID_SOURCE");
        return status;
      }),
  });
};
