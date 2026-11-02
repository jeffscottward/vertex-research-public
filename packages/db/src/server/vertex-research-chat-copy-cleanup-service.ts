import type { Database } from "./client.ts";
import { createVertexAuthorization } from "./vertex-authorization.ts";
import type {
  VertexCleanupAuthority,
  VertexCleanupDiscoveryCursor,
  VertexCleanupDiscoveryPage,
} from "./vertex-authorization-ports.ts";
import {
  createPersistenceContext,
  fail,
  time,
  type VertexStoreOptions,
} from "./vertex-persistence-core.ts";
import type { VertexScope } from "./vertex-ports.ts";
import type { VertexResearchChatCopyCleanupMetadata } from "./vertex-research-chat-copy-ports.ts";
import { createResearchChatCopyMetadata } from "./vertex-research-chat-copy-store.ts";
import {
  createVertexWorkerCredentials,
  type VertexWorkerCredentialOptions,
  type WorkerServiceIdentity,
} from "./vertex-worker-credentials.ts";

export type VertexResearchChatCopyCleanupOptions = Pick<
  VertexStoreOptions,
  "boundary" | "clock"
> &
  VertexWorkerCredentialOptions;
export type {
  VertexCleanupAuthority,
  VertexCleanupDiscoveryCursor,
  VertexCleanupDiscoveryPage,
} from "./vertex-authorization-ports.ts";
export type { VertexResearchChatCopyCleanupMetadata } from "./vertex-research-chat-copy-ports.ts";

const permission = "chat-copy-cleanup-discovery";

// No caller principal, storage/policy/processing dependency, issuance surface or
// nested transaction. Construction only composes the actual private owners.
export const createVertexResearchChatCopyCleanupStore = (
  db: Database,
  options: VertexResearchChatCopyCleanupOptions
) => {
  if (typeof options?.clock?.now !== "function") return fail("unavailable");
  // Retain every owner's valid sample, including the credential recheck's
  // private completion time. A rollback must not resurrect resource authority.
  let latestObservedAt: bigint | null = null;
  const clock = {
    now: (): string => {
      const value = options.clock.now();
      try {
        const observedAt = time(value);
        if (latestObservedAt === null || observedAt > latestObservedAt)
          latestObservedAt = observedAt;
      } catch {
        // Existing owners still reject malformed samples with their own errors.
        return value;
      }
      return value;
    },
  };
  const authorization = createVertexAuthorization(db, { clock });
  const ctx = createPersistenceContext(db, {
    boundary: options.boundary,
    clock,
    authorization,
    maxProjectionAgeMs: 0,
  });
  const credentials = createVertexWorkerCredentials(db, ctx, options);
  const metadata = createResearchChatCopyMetadata(ctx);
  const authenticate = async (
    credentialDigest: string,
    scope: VertexScope
  ): Promise<WorkerServiceIdentity> => {
    if (scope.environment !== "research") return fail("denied");
    return await credentials.authenticate(credentialDigest, scope, permission);
  };
  const finish = <T>(
    identity: WorkerServiceIdentity,
    authority: VertexCleanupAuthority<T>,
    startedAt: string
  ): VertexCleanupAuthority<T> => {
    // Used after the last under-lock await AND after the transaction commit
    // await; neither expiry nor the shared observation watermark is reset.
    const completedAt = ctx.now();
    const expiresAt =
      time(identity.expiresAt) < time(authority.expiresAt)
        ? identity.expiresAt
        : authority.expiresAt;
    if (
      (latestObservedAt !== null && time(completedAt) < latestObservedAt) ||
      time(completedAt) < time(startedAt) ||
      time(completedAt) < time(authority.checkedAt) ||
      time(completedAt) >= time(expiresAt)
    )
      return fail("denied");
    return Object.freeze({
      value: authority.value,
      checkedAt: completedAt,
      expiresAt,
    });
  };
  const discover = async (
    identity: WorkerServiceIdentity,
    raw: Readonly<{
      cursor: VertexCleanupDiscoveryCursor | null;
      limit: number;
    }>
  ): Promise<VertexCleanupAuthority<VertexCleanupDiscoveryPage>> => {
    const input = ctx.capture(raw);
    if (!input || Object.keys(input).sort().join(",") !== "cursor,limit")
      return fail("invalid");
    const result = await credentials.transaction(
      identity.scope,
      async (tx, at) => {
        await credentials.grant(tx, identity, permission, at);
        if (identity.scope.environment !== "research") return fail("denied");
        const page = await authorization.discoverCleanupFamilies(tx, {
          ...input,
          principal: { actorId: identity.servicePrincipalId },
          scope: identity.scope,
          now: at,
        });
        await credentials.grant(tx, identity, permission, at);
        return finish(identity, page, at);
      }
    );
    return finish(identity, result, result.checkedAt);
  };
  const read = async (
    identity: WorkerServiceIdentity,
    responseRequestId: string
  ): Promise<
    VertexCleanupAuthority<VertexResearchChatCopyCleanupMetadata | null>
  > => {
    if (
      typeof responseRequestId !== "string" ||
      /^response-[0-9a-f]{64}$/.exec(responseRequestId)?.[0] !==
        responseRequestId
    )
      return fail("invalid");
    const result = await credentials.transaction(
      identity.scope,
      async (tx, at) => {
        await credentials.grant(tx, identity, permission, at);
        if (identity.scope.environment !== "research") return fail("denied");
        const request = {
          principal: { actorId: identity.servicePrincipalId },
          scope: identity.scope,
          responseRequestId,
          now: at,
        };
        await authorization.authorizeCleanupFamily(tx, request);
        const value = await metadata.readCleanupMetadata(
          tx,
          {
            accountAlias: identity.scope.accountAlias,
            environment: "research",
          },
          responseRequestId
        );
        const authority = await authorization.authorizeCleanupFamily(
          tx,
          request
        );
        await credentials.grant(tx, identity, permission, at);
        return finish(identity, { ...authority, value }, at);
      }
    );
    return finish(identity, result, result.checkedAt);
  };
  return Object.freeze({ authenticate, discover, read });
};

export type VertexResearchChatCopyCleanupStore = ReturnType<
  typeof createVertexResearchChatCopyCleanupStore
>;
