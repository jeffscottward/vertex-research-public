import {
  canonicalArtifactJson,
  hashArtifact,
} from "@darkfactory/shared/vertex";
import { type SQL, sql } from "drizzle-orm";
import type { Database, Transaction } from "./client.ts";
import { required as requirePresent } from "./required.ts";
import type {
  VertexAuthorizationOptions,
  VertexAuthorizationRepository,
  VertexGrantBinding,
  VertexGrantPrivilegeRequest,
  VertexGrantVersion,
  VertexIssueGrantInput,
  VertexRevokeGrantInput,
} from "./vertex-authorization-ports.ts";
import {
  collectionKey,
  digestString,
  fail,
  identifier,
  sequence,
  time,
} from "./vertex-persistence-core.ts";
import type { VertexAction, VertexScope } from "./vertex-ports.ts";
import { VertexStoreError } from "./vertex-ports.ts";

export type {
  VertexAuthorizationOptions,
  VertexAuthorizationRepository,
} from "./vertex-authorization-ports.ts";

type Executor = Pick<Database, "execute">;
type Row = Record<string, unknown>;
const ACTIONS: readonly VertexAction[] = [
  "read",
  "publish",
  "review",
  "admit-paper-simulation",
  "project",
  "manage-rights",
  "dispatch-outbox",
  "cleanup-chat-copies",
];
const capture = <T>(value: T): T => {
  try {
    if (
      new TextEncoder().encode(canonicalArtifactJson(value)).byteLength > 65_536
    )
      fail("invalid");
    return structuredClone(value);
  } catch {
    return fail("invalid");
  }
};
const version = (value: unknown): string => {
  if (
    typeof value !== "string" ||
    value.length > 64 ||
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)
  )
    return fail("invalid");
  return value;
};
const advances = (next: string, previous: string): boolean => {
  const left = next.split(".").map(BigInt);
  const right = previous.split(".").map(BigInt);
  for (let index = 0; index < 3; index++) {
    if (
      requirePresent(left[index], "left[index]") !==
      requirePresent(right[index], "right[index]")
    )
      return (
        requirePresent(left[index], "left[index]") >
        requirePresent(right[index], "right[index]")
      );
  }
  return false;
};
const exactScope = (input: VertexScope): VertexScope => {
  identifier(input.accountAlias);
  if (!["research", "paper", "live"].includes(input.environment))
    fail("invalid");
  return { accountAlias: input.accountAlias, environment: input.environment };
};
const binding = (input: VertexGrantBinding): VertexGrantBinding => {
  const actions = input.actions;
  if (
    !Array.isArray(actions) ||
    actions.length === 0 ||
    actions.length > ACTIONS.length ||
    new Set(actions).size !== actions.length ||
    actions.some((action) => !ACTIONS.includes(action))
  )
    fail("invalid");
  return {
    grantId: identifier(input.grantId),
    granteeActorId: identifier(input.granteeActorId),
    scope: exactScope(input.scope),
    collectionId:
      input.collectionId === null ? null : identifier(input.collectionId),
    resourceId: identifier(input.resourceId),
    actions: [...actions].sort(),
  };
};
const requestScope = (
  scope: VertexScope,
  collection: string | null,
  grantId: string
): void => {
  exactScope(scope);
  collectionKey(collection);
  identifier(grantId);
};
const rows = async (executor: Executor, query: SQL): Promise<Row[]> =>
  (await executor.execute(query)).rows as Row[];
const scoped = (scope: VertexScope): SQL =>
  sql`b.account_alias = ${scope.accountAlias} and b.environment = ${scope.environment}`;
const grantColumns = sql`b.account_alias, b.environment, b.grant_id, b.grantee_actor_id, b.collection_key, b.resource_id, b.binding_hash, b.payload as binding_payload, v.payload as version_payload, v.record_hash, v.request_hash, v.status as version_status, v.valid_from_ns, v.expires_at_ns, v.recorded_at_ns, v.version as version_name, v.revision as version_revision, p.current_version, p.revision as current_revision`;
const cleanupGrantColumns = sql`${grantColumns}, v.valid_from, v.expires_at, v.recorded_at, v.recorded_by_actor_id, v.expected_version`;
const grantJoins = sql`vertex_grant_bindings b join vertex_grant_current p on p.account_alias = b.account_alias and p.environment = b.environment and p.grant_id = b.grant_id join vertex_grant_versions v on v.account_alias = p.account_alias and v.environment = p.environment and v.grant_id = p.grant_id and v.version = p.current_version`;
const verify = async (row: Row): Promise<VertexGrantVersion> => {
  const bound = binding(capture(row["binding_payload"]) as VertexGrantBinding);
  if (
    (await hashArtifact(bound)) !== row["binding_hash"] ||
    bound.scope.accountAlias !== row["account_alias"] ||
    bound.scope.environment !== row["environment"] ||
    bound.collectionId !==
      (row["collection_key"] === "" ? null : row["collection_key"]) ||
    bound.granteeActorId !== row["grantee_actor_id"] ||
    bound.resourceId !== row["resource_id"] ||
    bound.grantId !== row["grant_id"]
  )
    fail("integrity");
  const value = capture(row["version_payload"]) as VertexGrantVersion;
  if (
    (await hashArtifact(value)) !== row["record_hash"] ||
    (await hashArtifact(binding(value))) !== row["binding_hash"]
  )
    fail("integrity");
  if (
    version(value.version) !== row["current_version"] ||
    value.version !== row["version_name"] ||
    sequence(value.revision) === 0n ||
    value.revision !== row["current_revision"] ||
    value.revision !== row["version_revision"] ||
    value.status !== row["version_status"] ||
    !["granted", "revoked"].includes(value.status)
  )
    fail("integrity");
  identifier(value.recordedByActorId);
  if (
    time(value.validFrom).toString() !== row["valid_from_ns"] ||
    time(value.expiresAt).toString() !== row["expires_at_ns"] ||
    time(value.recordedAt).toString() !== row["recorded_at_ns"] ||
    time(value.validFrom) >= time(value.expiresAt)
  )
    fail("integrity");
  return value;
};
const safeError = (error: unknown): never => {
  if (error instanceof VertexStoreError) throw error;
  const pg = error as { code?: string; cause?: { code?: string } } | null;
  const code = pg?.code ?? pg?.cause?.code;
  return fail(
    ["23505", "40001", "40P01"].includes(code ?? "")
      ? "conflict"
      : ["23503", "23514", "22003"].includes(code ?? "")
        ? "integrity"
        : "unavailable"
  );
};

export const createVertexAuthorization = (
  db: Database,
  options: VertexAuthorizationOptions
): VertexAuthorizationRepository => {
  if (
    !db ||
    typeof db.transaction !== "function" ||
    typeof db.execute !== "function" ||
    typeof options?.clock?.now !== "function"
  )
    fail("unavailable");
  const now = (): string => {
    try {
      const value = options.clock.now();
      time(value);
      return value;
    } catch {
      return fail("unavailable");
    }
  };
  const privilege = async (
    request: VertexGrantPrivilegeRequest
  ): Promise<void> => {
    if (typeof options.privilegedAuthorization?.authorize !== "function")
      fail("denied");
    let allowed = false;
    try {
      allowed =
        (await requirePresent(
          options.privilegedAuthorization,
          "options.privilegedAuthorization"
        ).authorize(capture(request))) === true;
    } catch {
      allowed = false;
    }
    if (!allowed) fail("denied");
  };
  const lock = async (
    tx: Transaction,
    scope: VertexScope,
    grantId: string
  ): Promise<void> => {
    // Stable global -> scope -> grant order; global uniqueness of grantId cannot
    // race between otherwise different account scopes. No lock is a permission.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${"vertex-authorization:global"}, 0))`
    );
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${canonicalArtifactJson(["vertex-authorization", scope.accountAlias, scope.environment])}, 0))`
    );
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${canonicalArtifactJson(["vertex-grant", grantId])}, 0))`
    );
  };
  const current = async (
    executor: Executor,
    scope: VertexScope,
    collection: string | null,
    grantId: string
  ): Promise<Readonly<{ row: Row; value: VertexGrantVersion }> | null> => {
    const found = await rows(
      executor,
      sql`select ${grantColumns} from ${grantJoins} where ${scoped(scope)} and b.collection_key = ${collectionKey(collection)} and b.grant_id = ${grantId} limit 1`
    );
    if (!found[0]) return null;
    return { row: found[0], value: await verify(found[0]) };
  };
  const usable = (
    value: VertexGrantVersion,
    requestedAt: string,
    actualAt: string
  ): boolean => {
    const requested = time(requestedAt);
    const actual = time(actualAt);
    return (
      value.status === "granted" &&
      requested <= actual &&
      time(value.recordedAt) <= requested &&
      time(value.recordedAt) <= actual &&
      time(value.validFrom) <= requested &&
      time(value.validFrom) <= actual &&
      requested < time(value.expiresAt) &&
      actual < time(value.expiresAt)
    );
  };
  const authorize: VertexAuthorizationRepository["authorize"] = async (
    input
  ) => {
    try {
      const value = capture(input);
      identifier(value.principal.actorId);
      exactScope(value.scope);
      collectionKey(value.collectionId);
      identifier(value.resourceId);
      if (!ACTIONS.includes(value.action)) return false;
      const actual = now();
      if (time(value.now) > time(actual)) return false;
      const found = await rows(
        db,
        sql`select ${grantColumns} from ${grantJoins} join vertex_grant_actions a on a.account_alias = v.account_alias and a.environment = v.environment and a.grant_id = v.grant_id and a.version = v.version where ${scoped(value.scope)} and b.grantee_actor_id = ${value.principal.actorId} and b.collection_key = ${collectionKey(value.collectionId)} and b.resource_id = ${value.resourceId} and a.action = ${value.action} and v.status = 'granted' and v.valid_from_ns <= ${time(value.now).toString()} and v.expires_at_ns > ${time(actual).toString()} and v.recorded_at_ns <= ${time(value.now).toString()} limit 129`
      );
      if (found.length > 128) return false;
      for (const row of found) {
        const grant = await verify(row);
        if (
          grant.granteeActorId !== value.principal.actorId ||
          grant.scope.accountAlias !== value.scope.accountAlias ||
          grant.scope.environment !== value.scope.environment ||
          grant.collectionId !== value.collectionId ||
          grant.resourceId !== value.resourceId ||
          !grant.actions.includes(value.action)
        )
          continue;
        if (usable(grant, value.now, now())) return true;
      }
      return false;
    } catch {
      // Authorization is fail-closed even when the database or codec is down.
      return false;
    }
  };
  const listAuthorizedScopes: VertexAuthorizationRepository["listAuthorizedScopes"] =
    async (input) => {
      try {
        const principal = capture(input);
        identifier(principal.actorId);
        const at = now();
        const found = await rows(
          db,
          sql`select ${grantColumns} from ${grantJoins} join vertex_grant_actions a on a.account_alias = v.account_alias and a.environment = v.environment and a.grant_id = v.grant_id and a.version = v.version where b.grantee_actor_id = ${principal.actorId} and b.collection_key = '' and b.resource_id = 'account-scope' and a.action = 'read' and v.status = 'granted' and v.valid_from_ns <= ${time(at).toString()} and v.expires_at_ns > ${time(at).toString()} and v.recorded_at_ns <= ${time(at).toString()} order by b.account_alias,b.environment,b.grant_id limit 257`
        );
        if (found.length > 256) return [];
        const scopes = new Map<
          string,
          Readonly<{ scope: VertexScope; expiresAt: bigint }>
        >();
        for (const row of found) {
          const grant = await verify(row);
          if (
            grant.granteeActorId !== principal.actorId ||
            grant.collectionId !== null ||
            grant.resourceId !== "account-scope" ||
            !grant.actions.includes("read") ||
            !usable(grant, at, now())
          )
            continue;
          const key = canonicalArtifactJson(grant.scope);
          const expiresAt = time(grant.expiresAt);
          const prior = scopes.get(key);
          if (!prior || prior.expiresAt < expiresAt)
            scopes.set(key, { scope: grant.scope, expiresAt });
        }
        // A final clock check prevents a slow scan from returning a grant that
        // expired while another candidate's integrity was being verified.
        const completedAt = now();
        if (time(completedAt) < time(at)) return [];
        const result: VertexScope[] = [];
        for (const candidate of scopes.values()) {
          if (candidate.expiresAt > time(completedAt))
            result.push(capture(candidate.scope));
        }
        return result;
      } catch {
        return [];
      }
    };
  const cleanupInput = (
    value: Readonly<{
      principal: { actorId: string };
      scope: VertexScope;
      now: string;
    }>
  ): void => {
    identifier(value.principal.actorId);
    exactScope(value.scope);
    if (value.scope.environment !== "research" || time(value.now) > time(now()))
      fail("denied");
  };
  const cleanupGrant = async (
    row: Row,
    input: Readonly<{
      principal: { actorId: string };
      scope: VertexScope;
      now: string;
    }>
  ): Promise<VertexGrantVersion> => {
    const value = await verify(row);
    if (
      value.granteeActorId !== input.principal.actorId ||
      value.scope.accountAlias !== input.scope.accountAlias ||
      value.scope.environment !== "research" ||
      value.collectionId !== null ||
      /^research-chat-copies:response-[0-9a-f]{64}$/.exec(
        value.resourceId
      )?.[0] !== value.resourceId ||
      !value.actions.includes("cleanup-chat-copies")
    )
      return fail("integrity");
    if (
      (await hashArtifact(row["binding_payload"])) !== row["binding_hash"] ||
      Object.keys(value).sort().join(",") !==
        "actions,collectionId,expiresAt,grantId,granteeActorId,recordedAt,recordedByActorId,resourceId,revision,scope,status,validFrom,version" ||
      value.validFrom !== row["valid_from"] ||
      value.expiresAt !== row["expires_at"] ||
      value.recordedAt !== row["recorded_at"] ||
      value.recordedByActorId !== row["recorded_by_actor_id"]
    )
      return fail("integrity");
    const expectedVersion =
      row["expected_version"] === null
        ? null
        : version(String(row["expected_version"]));
    if (
      expectedVersion === null
        ? value.revision !== "1"
        : value.revision === "1" || !advances(value.version, expectedVersion)
    )
      return fail("integrity");
    // request_hash commits the original administration input (whose action
    // ordering need not survive canonical binding normalization). It is not an
    // authority proof; the actual stored version and binding hashes above are.
    digestString(row["request_hash"]);
    if (!usable(value, input.now, now())) return fail("denied");
    return value;
  };
  const discoverCleanupFamilies: VertexAuthorizationRepository["discoverCleanupFamilies"] =
    async (tx, input) => {
      const value = capture(input);
      cleanupInput(value);
      if (
        !Number.isSafeInteger(value.limit) ||
        value.limit < 1 ||
        value.limit > 64
      )
        return fail("invalid");
      const cursor = value.cursor;
      if (
        cursor !== null &&
        (Object.keys(cursor).sort().join(",") !==
          "accountAlias,afterGrantId,environment" ||
          cursor.accountAlias !== value.scope.accountAlias ||
          cursor.environment !== "research")
      )
        return fail("invalid");
      const after = cursor === null ? null : identifier(cursor.afterGrantId);
      // Scan at most the requested 64 current candidates, NOT 64 returned families.
      // C collation gives the same stable ASCII key order as the checked cursor.
      const found = await rows(
        tx,
        sql`select ${cleanupGrantColumns} from ${grantJoins} join vertex_grant_actions a on a.account_alias = v.account_alias and a.environment = v.environment and a.grant_id = v.grant_id and a.version = v.version where ${scoped(value.scope)} and b.grantee_actor_id = ${value.principal.actorId} and b.collection_key = '' and b.resource_id ~ '^research-chat-copies:response-[0-9a-f]{64}$' and a.action = 'cleanup-chat-copies' and v.status = 'granted' and v.valid_from_ns <= ${time(value.now).toString()} and v.expires_at_ns > ${time(value.now).toString()} and v.recorded_at_ns <= ${time(value.now).toString()} ${after === null ? sql`` : sql`and b.grant_id collate "C" > ${after} collate "C"`} order by b.grant_id collate "C" limit ${value.limit}`
      );
      if (found.length > value.limit) return fail("integrity");
      const grants: VertexGrantVersion[] = [];
      let previous = after;
      for (const row of found) {
        const grant = await cleanupGrant(row, value);
        if (previous !== null && grant.grantId <= previous)
          return fail("integrity");
        previous = grant.grantId;
        grants.push(grant);
      }
      const completedAt = now();
      if (
        time(completedAt) < time(value.now) ||
        grants.some((grant) => !usable(grant, value.now, completedAt))
      )
        return fail("denied");
      // Empty pages still carry a finite return window; credential authority will
      // bound it further. No empty page asserts the absence of future grants.
      const expiresAt = grants.reduce(
        (end, grant) =>
          time(grant.expiresAt) < time(end) ? grant.expiresAt : end,
        grants[0]?.expiresAt ?? "9999-12-31T23:59:59Z"
      );
      const page = {
        responseRequestIds: [
          ...new Set(
            grants.map((grant) =>
              grant.resourceId.slice("research-chat-copies:".length)
            )
          ),
        ],
        nextCursor:
          found.length === value.limit && previous !== null
            ? {
                accountAlias: value.scope.accountAlias,
                environment: "research" as const,
                afterGrantId: previous,
              }
            : null,
      };
      return { value: page, checkedAt: completedAt, expiresAt };
    };
  const authorizeCleanupFamily: VertexAuthorizationRepository["authorizeCleanupFamily"] =
    async (tx, input) => {
      const value = capture(input);
      cleanupInput(value);
      if (
        typeof value.responseRequestId !== "string" ||
        /^response-[0-9a-f]{64}$/.exec(value.responseRequestId)?.[0] !==
          value.responseRequestId
      )
        return fail("invalid");
      const resourceId = `research-chat-copies:${value.responseRequestId}`;
      const found = await rows(
        tx,
        sql`select ${cleanupGrantColumns} from ${grantJoins} join vertex_grant_actions a on a.account_alias = v.account_alias and a.environment = v.environment and a.grant_id = v.grant_id and a.version = v.version where ${scoped(value.scope)} and b.grantee_actor_id = ${value.principal.actorId} and b.collection_key = '' and b.resource_id = ${resourceId} and a.action = 'cleanup-chat-copies' and v.status = 'granted' and v.valid_from_ns <= ${time(value.now).toString()} and v.expires_at_ns > ${time(value.now).toString()} and v.recorded_at_ns <= ${time(value.now).toString()} order by b.grant_id collate "C" limit 64`
      );
      if (!found.length || found.length > 64) return fail("denied");
      let expiresAt: string | null = null;
      for (const row of found) {
        const grant = await cleanupGrant(row, value);
        if (grant.resourceId !== resourceId) return fail("integrity");
        if (expiresAt === null || time(grant.expiresAt) > time(expiresAt))
          expiresAt = grant.expiresAt;
      }
      const completedAt = now();
      if (
        expiresAt === null ||
        time(completedAt) < time(value.now) ||
        time(expiresAt) <= time(completedAt)
      )
        return fail("denied");
      return { value: null, checkedAt: completedAt, expiresAt };
    };
  const persist = async (
    tx: Transaction,
    request: VertexGrantPrivilegeRequest,
    previous: Readonly<{ row: Row; value: VertexGrantVersion }> | null,
    requestHash: string,
    status: "granted" | "revoked"
  ): Promise<"recorded" | "duplicate"> => {
    const {
      binding: bound,
      version: nextVersion,
      expectedVersion,
      principal,
    } = request;
    const scope = bound.scope;
    const existing = await rows(
      tx,
      sql`select request_hash from vertex_grant_versions where account_alias = ${scope.accountAlias} and environment = ${scope.environment} and grant_id = ${bound.grantId} and version = ${nextVersion} limit 1`
    );
    if (existing[0]) {
      if (
        existing[0]["request_hash"] !== requestHash ||
        previous?.value.version !== nextVersion ||
        previous.value.status !== status
      )
        fail("conflict");
      return "duplicate";
    }
    if ((previous?.value.version ?? null) !== expectedVersion) fail("conflict");
    if (
      previous &&
      (!advances(nextVersion, previous.value.version) ||
        (await hashArtifact(binding(previous.value))) !==
          (await hashArtifact(bound)))
    )
      fail("conflict");
    const revision = previous
      ? (sequence(previous.value.revision) + 1n).toString()
      : "1";
    sequence(revision);
    const at = now();
    if (
      time(at) < time(request.now) ||
      (previous && time(at) < time(previous.value.recordedAt))
    )
      fail("stale");
    if (status === "granted" && time(request.expiresAt) <= time(at))
      fail("invalid");
    await privilege({ ...request, now: at });
    const value: VertexGrantVersion = {
      ...bound,
      version: nextVersion,
      revision,
      status,
      validFrom: request.validFrom,
      expiresAt: request.expiresAt,
      recordedAt: at,
      recordedByActorId: principal.actorId,
    };
    if (!previous) {
      await tx.execute(
        sql`insert into vertex_grant_bindings (grant_id,account_alias,environment,grantee_actor_id,collection_key,resource_id,binding_hash,payload) values (${bound.grantId},${scope.accountAlias},${scope.environment},${bound.granteeActorId},${collectionKey(bound.collectionId)},${bound.resourceId},${await hashArtifact(bound)},${canonicalArtifactJson(bound)}::jsonb)`
      );
    }
    await tx.execute(
      sql`insert into vertex_grant_versions (account_alias,environment,grant_id,version,revision,status,valid_from,valid_from_ns,expires_at,expires_at_ns,recorded_at,recorded_at_ns,recorded_by_actor_id,expected_version,request_hash,record_hash,payload) values (${scope.accountAlias},${scope.environment},${bound.grantId},${nextVersion},${revision},${status},${request.validFrom},${time(request.validFrom).toString()},${request.expiresAt},${time(request.expiresAt).toString()},${at},${time(at).toString()},${principal.actorId},${expectedVersion},${requestHash},${await hashArtifact(value)},${canonicalArtifactJson(value)}::jsonb)`
    );
    for (const action of bound.actions) {
      await tx.execute(
        sql`insert into vertex_grant_actions (account_alias,environment,grant_id,version,action) values (${scope.accountAlias},${scope.environment},${bound.grantId},${nextVersion},${action})`
      );
    }
    if (previous) {
      const changed = await rows(
        tx,
        sql`update vertex_grant_current set current_version = ${nextVersion}, revision = ${revision} where account_alias = ${scope.accountAlias} and environment = ${scope.environment} and grant_id = ${bound.grantId} and current_version = ${expectedVersion} and revision = ${previous.value.revision} returning grant_id`
      );
      if (changed.length !== 1) fail("conflict");
    } else {
      await tx.execute(
        sql`insert into vertex_grant_current (account_alias,environment,grant_id,current_version,revision) values (${scope.accountAlias},${scope.environment},${bound.grantId},${nextVersion},${revision})`
      );
    }
    return "recorded";
  };
  const issueGrant = async (
    input: VertexIssueGrantInput
  ): Promise<"recorded" | "duplicate"> => {
    try {
      const value = capture(input);
      identifier(value.principal.actorId);
      const bound = binding(value);
      version(value.version);
      if (value.expectedVersion !== null) version(value.expectedVersion);
      if (time(value.validFrom) >= time(value.expiresAt)) fail("invalid");
      const request: VertexGrantPrivilegeRequest = {
        principal: value.principal,
        action: "issue-grant",
        binding: bound,
        version: value.version,
        expectedVersion: value.expectedVersion,
        validFrom: value.validFrom,
        expiresAt: value.expiresAt,
        now: now(),
      };
      await privilege(request);
      const requestHash = await hashArtifact({
        action: "issue-grant",
        input: value,
      });
      return await db.transaction(async (tx) => {
        await lock(tx, bound.scope, bound.grantId);
        await privilege({ ...request, now: now() });
        const previous = await current(
          tx,
          bound.scope,
          bound.collectionId,
          bound.grantId
        );
        return persist(tx, request, previous, requestHash, "granted");
      });
    } catch (error) {
      return safeError(error);
    }
  };
  const revokeGrant = async (
    input: VertexRevokeGrantInput
  ): Promise<"recorded" | "duplicate"> => {
    try {
      const value = capture(input);
      identifier(value.principal.actorId);
      requestScope(value.scope, value.collectionId, value.grantId);
      version(value.version);
      version(value.expectedVersion);
      if (typeof options.privilegedAuthorization?.authorize !== "function")
        fail("denied");
      const before = await current(
        db,
        value.scope,
        value.collectionId,
        value.grantId
      );
      if (!before) fail("denied");
      const bound = binding(requirePresent(before, "before").value);
      const request: VertexGrantPrivilegeRequest = {
        principal: value.principal,
        action: "revoke-grant",
        binding: bound,
        version: value.version,
        expectedVersion: value.expectedVersion,
        validFrom: requirePresent(before, "before").value.validFrom,
        expiresAt: requirePresent(before, "before").value.expiresAt,
        now: now(),
      };
      await privilege(request);
      const requestHash = await hashArtifact({
        action: "revoke-grant",
        input: value,
      });
      return await db.transaction(async (tx) => {
        await lock(tx, value.scope, value.grantId);
        const previous = await current(
          tx,
          value.scope,
          value.collectionId,
          value.grantId
        );
        if (
          !previous ||
          (await hashArtifact(binding(previous.value))) !==
            (await hashArtifact(bound))
        )
          fail("conflict");
        const lockedRequest = {
          ...request,
          validFrom: requirePresent(previous, "previous").value.validFrom,
          expiresAt: requirePresent(previous, "previous").value.expiresAt,
          now: now(),
        };
        await privilege(lockedRequest);
        return persist(tx, lockedRequest, previous, requestHash, "revoked");
      });
    } catch (error) {
      return safeError(error);
    }
  };
  return Object.freeze({
    authorize,
    listAuthorizedScopes,
    discoverCleanupFamilies,
    authorizeCleanupFamily,
    issueGrant,
    revokeGrant,
  });
};
