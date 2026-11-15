import { timestampToEpochNanoseconds } from "@darkfactory/shared/vertex";
import { type SQL, sql } from "drizzle-orm";
import type { Database, Transaction } from "./client.ts";
import { required as requirePresent } from "./required.ts";
import type {
  VertexAction,
  VertexArtifactMetadata,
  VertexAuthorization,
  VertexBoundary,
  VertexBoundaryContractName,
  VertexClock,
  VertexCommandPolicyGuard,
  VertexContractName,
  VertexPrincipal,
  VertexRecord,
  VertexResearchChatInputName,
  VertexRightsRecord,
  VertexScope,
} from "./vertex-ports.ts";
import { VertexStoreError } from "./vertex-ports.ts";
import { forgetPredecessorWalkReads } from "./vertex-research-chat-predecessor-walk.ts";
import {
  cachedTransactionRows,
  invalidateTransactionRows,
  withTransactionReadScope,
} from "./vertex-transaction-read-cache.ts";

export type VertexStoreOptions = Readonly<{
  boundary: VertexBoundary;
  clock: VertexClock;
  authorization: VertexAuthorization;
  maxProjectionAgeMs: number;
  commandPolicy?: VertexCommandPolicyGuard;
}>;
export type Row = Record<string, unknown>;
export const fail: (code: VertexStoreError["code"]) => never = (code) => {
  throw new VertexStoreError(code);
};
export const identifier = (value: unknown): string => {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(value)
  )
    return fail("invalid");
  return value;
};
export const digestString = (value: unknown): string => {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value))
    return fail("invalid");
  return value;
};
export const string = (value: unknown): string =>
  typeof value === "string" ? value : fail("integrity");
export const object = (value: unknown): VertexRecord => {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return fail("invalid");
  return value as VertexRecord;
};
export const array = (value: unknown, maximum = 512): readonly unknown[] => {
  if (!Array.isArray(value) || value.length > maximum) return fail("invalid");
  return value;
};
export const time = (value: unknown): bigint => {
  try {
    return timestampToEpochNanoseconds(string(value));
  } catch {
    return fail("invalid");
  }
};
export const sequence = (value: unknown): bigint => {
  if (typeof value !== "string" || !/^(0|[1-9]\d{0,29})$/.test(value))
    return fail("invalid");
  return BigInt(value);
};
export const collectionKey = (value: string | null): string =>
  value === null ? "" : identifier(value);
export const collectionId = (value: unknown): string | null =>
  value === "" ? null : identifier(value);
export const scopeWhere = (scope: VertexScope): SQL =>
  sql`account_alias = ${scope.accountAlias} and environment = ${scope.environment}`;
export const json = (value: unknown): SQL =>
  sql`${JSON.stringify(value)}::jsonb`;
export const rows = async (tx: Transaction, query: SQL): Promise<Row[]> => {
  const result = await tx.execute(query);
  return result.rows as Row[];
};
export const one = async (
  tx: Transaction,
  table: string,
  scope: VertexScope,
  where: SQL,
  suffix: SQL = sql``
): Promise<Row | null> => {
  const found = await rows(
    tx,
    sql`select * from ${sql.identifier(table)} where ${scopeWhere(scope)} and (${where}) ${suffix} limit 1`
  );
  return found[0] ?? null;
};
// Account-scoped catalog row by artifact id, reused within this transaction
// only (see vertex-transaction-read-cache). Catalog rows are never updated.
export const accountCatalogArtifact = async (
  tx: Transaction,
  scope: VertexScope,
  artifactId: unknown
): Promise<Row | null> =>
  (
    await cachedTransactionRows(
      tx,
      "vertex_artifacts",
      JSON.stringify([scope.accountAlias, scope.environment, "", artifactId]),
      () =>
        rows(
          tx,
          sql`select * from ${sql.identifier("vertex_artifacts")} where ${scopeWhere(scope)} and (collection_key = '' and artifact_id = ${artifactId}) limit 1`
        )
    )
  )[0] ?? null;
export const insert = async (
  tx: Transaction,
  table: string,
  scope: VertexScope,
  values: Row
): Promise<void> => {
  const row = {
    account_alias: scope.accountAlias,
    environment: scope.environment,
    ...values,
  };
  const entries = Object.entries(row);
  invalidateTransactionRows(tx, table);
  forgetPredecessorWalkReads(tx);
  await tx.execute(
    sql`insert into ${sql.identifier(table)} (${sql.join(
      entries.map(([key]) => sql.identifier(key)),
      sql`, `
    )}) values (${sql.join(
      entries.map(([, value]) =>
        value !== null && typeof value === "object"
          ? json(value)
          : sql`${value}`
      ),
      sql`, `
    )})`
  );
};

export const createPersistenceContext = (
  db: Database,
  options: VertexStoreOptions
) => {
  if (
    !db ||
    typeof db.transaction !== "function" ||
    !options ||
    typeof options.boundary?.validate !== "function" ||
    typeof options.boundary?.encode !== "function" ||
    typeof options.boundary?.digest !== "function" ||
    typeof options.clock?.now !== "function" ||
    typeof options.authorization?.authorize !== "function"
  )
    fail("unavailable");
  if (
    !Number.isSafeInteger(options.maxProjectionAgeMs) ||
    options.maxProjectionAgeMs < 0 ||
    Object.is(options.maxProjectionAgeMs, -0)
  )
    fail("invalid");
  const commandPolicy = options.commandPolicy;
  if (commandPolicy !== undefined && typeof commandPolicy !== "function")
    fail("unavailable");
  const now = (): string => {
    let value: string;
    try {
      value = options.clock.now();
    } catch {
      return fail("unavailable");
    }
    time(value);
    return value;
  };
  const capture = <T>(value: T): T => {
    try {
      // The canonical encoder rejects accessors, symbols, sparse arrays and
      // non-JSON prototypes before structuredClone can invoke user code.
      const bytes = options.boundary.encode(value);
      if (!(bytes instanceof Uint8Array) || bytes.byteLength > 16_777_216)
        return fail("invalid");
      return structuredClone(value);
    } catch {
      return fail("invalid");
    }
  };
  const encode = (value: unknown): Uint8Array => {
    try {
      const bytes = options.boundary.encode(value);
      if (!(bytes instanceof Uint8Array) || bytes.byteLength > 16_777_216)
        return fail("invalid");
      return new Uint8Array(bytes);
    } catch {
      return fail("invalid");
    }
  };
  const digest = async (input: Uint8Array): Promise<string> => {
    try {
      if (
        !(input instanceof Uint8Array) ||
        Object.getPrototypeOf(input) !== Uint8Array.prototype ||
        !(input.buffer instanceof ArrayBuffer) ||
        Object.hasOwn(input, "buffer") ||
        Object.hasOwn(input, "byteLength") ||
        input.byteLength > 16_777_216
      )
        return fail("invalid");
      return digestString(await options.boundary.digest(new Uint8Array(input)));
    } catch {
      return fail("invalid");
    }
  };
  const hash = async (value: unknown): Promise<string> => {
    try {
      const bytes = options.boundary.encode(value);
      if (!(bytes instanceof Uint8Array) || bytes.byteLength > 16_777_216)
        return fail("invalid");
      return digestString(await options.boundary.digest(bytes));
    } catch (error) {
      if (error instanceof VertexStoreError) throw error;
      return fail("invalid");
    }
  };
  const validateResearchChatInput = async (
    name: VertexResearchChatInputName,
    value: unknown
  ): Promise<VertexRecord> => {
    const validator = options.boundary.validateResearchChatInput;
    if (typeof validator !== "function") return fail("unavailable");
    try {
      const input = capture(value);
      const originalHash = await hash(input);
      const record = capture(object(await validator(name, input)));
      // Never let parsing normalize/strip/replace bytes after idempotency input
      // capture. Callers provide explicit page defaults at the API boundary.
      if ((await hash(record)) !== originalHash) return fail("invalid");
      return record;
    } catch (error) {
      if (error instanceof VertexStoreError) throw error;
      return fail("invalid");
    }
  };
  const validate = async (
    name: VertexBoundaryContractName,
    value: unknown
  ): Promise<VertexRecord> => {
    try {
      const input = capture(value);
      const record = object(
        await options.boundary.validate(name, input, "1.0.0")
      );
      // Replay is a strict batch envelope whose version belongs to its signed
      // grant. Every other authoritative record retains its top-level version.
      const schemaVersion =
        name === "NativeOutboxReplay"
          ? object(record["grant"])["schemaVersion"]
          : record["schemaVersion"];
      if (schemaVersion !== "1.0.0") return fail("invalid");
      await hash(record);
      return capture(record);
    } catch (error) {
      if (error instanceof VertexStoreError) throw error;
      return fail("invalid");
    }
  };
  const authorize = async (
    principal: VertexPrincipal,
    scope: VertexScope,
    collection: string | null,
    resourceId: string,
    action: VertexAction,
    at: string
  ): Promise<void> => {
    identifier(principal?.actorId);
    identifier(scope?.accountAlias);
    if (
      Object.keys(principal).length !== 1 ||
      Object.keys(principal)[0] !== "actorId" ||
      Object.keys(scope).length !== 2 ||
      !Object.hasOwn(scope, "accountAlias") ||
      !Object.hasOwn(scope, "environment")
    )
      fail("invalid");
    if (!["research", "paper", "live"].includes(scope.environment))
      fail("invalid");
    collectionKey(collection);
    identifier(resourceId);
    let permitted = false;
    try {
      permitted =
        (await options.authorization.authorize({
          principal,
          scope,
          collectionId: collection,
          resourceId,
          action,
          now: at,
        })) === true;
    } catch {
      permitted = false;
    }
    if (!permitted) fail("denied");
  };
  const scoped = (record: VertexRecord, scope: VertexScope): void => {
    if (
      (record["accountAlias"] !== undefined &&
        record["accountAlias"] !== scope.accountAlias) ||
      (record["environment"] !== undefined &&
        record["environment"] !== scope.environment)
    )
      fail("denied");
  };
  const run = async <T>(
    principal: VertexPrincipal,
    scope: VertexScope,
    collection: string | null,
    resource: string,
    action: VertexAction,
    operation: (tx: Transaction, at: string) => Promise<T>,
    command = false
  ): Promise<T> => {
    const at = now();
    await authorize(principal, scope, collection, resource, action, at);
    try {
      return await db.transaction(
        withTransactionReadScope(async (tx) => {
          // Command commits serialize with grant revocation and policy activation.
          // Keep the shared order: authorization global -> policy -> artifact scope.
          if (command) {
            await tx.execute(
              sql`select pg_advisory_xact_lock(hashtextextended(${"vertex-authorization:global"}, 0))`
            );
            if (commandPolicy) {
              await tx.execute(
                sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify(["vertex-policy", scope.accountAlias, scope.environment])}, 0))`
              );
            }
          }
          await tx.execute(
            sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify(["vertex", scope.accountAlias, scope.environment])}, 0))`
          );
          const lockedAt = now();
          await authorize(
            principal,
            scope,
            collection,
            resource,
            action,
            lockedAt
          );
          return operation(tx, lockedAt);
        })
      );
    } catch (error) {
      if (error instanceof VertexStoreError) throw error;
      const pg = error as { code?: string; cause?: { code?: string } };
      const code = pg?.code ?? pg?.cause?.code;
      if (["23505", "40001", "40P01"].includes(code ?? ""))
        return fail("conflict");
      if (["23503", "23514", "22003"].includes(code ?? ""))
        return fail("integrity");
      return fail("unavailable");
    }
  };
  const ensureAccount = async (
    tx: Transaction,
    scope: VertexScope,
    at: string
  ): Promise<void> => {
    await tx.execute(
      sql`insert into vertex_accounts (account_id, created_at) values (${scope.accountAlias}, ${at}) on conflict (account_id) do nothing`
    );
    await tx.execute(
      sql`insert into vertex_account_aliases (account_alias,environment,account_id,created_at) values (${scope.accountAlias},${scope.environment},${scope.accountAlias},${at}) on conflict (account_alias,environment) do nothing`
    );
  };
  const rightsShape = (candidate: VertexRightsRecord, at: string): void => {
    identifier(candidate.policyId);
    if (
      !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(candidate.version) ||
      candidate.version.length > 64 ||
      !["granted", "denied", "expired", "unknown"].includes(candidate.status)
    )
      fail("invalid");
    const uses = array(candidate.allowedUses, 4);
    if (
      new Set(uses).size !== uses.length ||
      uses.some(
        (use) => !["store", "read", "derive", "export"].includes(string(use))
      )
    )
      fail("invalid");
    if (time(candidate.checkedAt) > time(at)) fail("invalid");
    for (const end of [candidate.expiresAt, candidate.retentionUntil]) {
      if (end !== null) time(end);
    }
    if (
      candidate.status === "granted" &&
      (candidate.expiresAt === null ||
        time(candidate.expiresAt) <= time(candidate.checkedAt))
    )
      fail("invalid");
    if (
      candidate.status === "expired" &&
      (candidate.expiresAt === null ||
        time(candidate.expiresAt) > time(candidate.checkedAt))
    )
      fail("invalid");
  };
  const latestRights = async (
    tx: Transaction,
    scope: VertexScope,
    collection: string | null,
    policy: string
  ): Promise<Row | null> => {
    // Reused within this transaction only; see vertex-transaction-read-cache.
    const found = await cachedTransactionRows(
      tx,
      "vertex_rights_versions",
      JSON.stringify([
        scope.accountAlias,
        scope.environment,
        collectionKey(collection),
        policy,
      ]),
      () =>
        rows(
          tx,
          sql`select * from ${sql.identifier("vertex_rights_versions")} where ${scopeWhere(scope)} and (collection_key = ${collectionKey(collection)} and policy_id = ${policy}) order by revision desc limit 1`
        )
    );
    return found[0] ?? null;
  };
  const rights = async (
    tx: Transaction,
    scope: VertexScope,
    collection: string | null,
    pinned: VertexRightsRecord,
    use: "store" | "read" | "derive" | "export",
    at: string
  ): Promise<void> => {
    rightsShape(pinned, at);
    const current = await latestRights(tx, scope, collection, pinned.policyId);
    if (!current) fail("denied");
    if (
      (await hash(requirePresent(current, "current")["payload"])) !==
      requirePresent(current, "current")["record_hash"]
    )
      fail("integrity");
    const policy = object(
      requirePresent(current, "current")["payload"]
    ) as unknown as VertexRightsRecord;
    rightsShape(policy, at);
    for (const value of [pinned, policy]) {
      if (
        value.status !== "granted" ||
        !value.allowedUses.includes(use) ||
        value.expiresAt === null ||
        time(value.expiresAt) <= time(at) ||
        (value.retentionUntil !== null &&
          time(value.retentionUntil) <= time(at)) ||
        time(value.checkedAt) > time(at)
      )
        fail("denied");
    }
  };
  const artifact = async (
    tx: Transaction,
    principal: VertexPrincipal,
    scope: VertexScope,
    collection: string | null,
    id: string,
    use: "store" | "read" | "derive",
    at: string
  ): Promise<VertexArtifactMetadata | null> => {
    await authorize(
      principal,
      scope,
      collection,
      id,
      use === "read" ? "read" : "publish",
      at
    );
    const found = await one(
      tx,
      "vertex_artifacts",
      scope,
      sql`artifact_id = ${id} and collection_key = ${collectionKey(collection)}`
    );
    if (!found) return null;
    const metadata = object(
      found["payload"]
    ) as unknown as VertexArtifactMetadata;
    if (
      (await hash(metadata)) !== found["metadata_hash"] ||
      metadata.scope.accountAlias !== scope.accountAlias ||
      metadata.scope.environment !== scope.environment ||
      metadata.collectionId !== collection ||
      metadata.artifactId !== id
    )
      fail("integrity");
    await rights(tx, scope, collection, metadata.rights, use, at);
    return structuredClone(metadata);
  };
  const sealed = async (
    tx: Transaction,
    principal: VertexPrincipal,
    scope: VertexScope,
    collection: string | null,
    reference: Readonly<{ artifactId: string; artifactSha256: string }>,
    name: VertexContractName,
    record: VertexRecord,
    at: string
  ): Promise<VertexArtifactMetadata> => {
    identifier(reference.artifactId);
    digestString(reference.artifactSha256);
    const metadata = await artifact(
      tx,
      principal,
      scope,
      collection,
      reference.artifactId,
      "store",
      at
    );
    if (
      !metadata ||
      metadata.contractName !== name ||
      metadata.artifactSha256 !== reference.artifactSha256 ||
      (await hash(record)) !== metadata.artifactSha256 ||
      options.boundary.encode(record).byteLength !== metadata.byteLength
    )
      return fail("integrity");
    const sourceHash =
      typeof record["contentHash"] === "string" ? record["contentHash"] : null;
    if (metadata.sourceContentSha256 !== sourceHash) fail("integrity");
    const policyId = record["rightsPolicyId"] ?? record["entitlementPolicyId"];
    if (policyId !== undefined && policyId !== metadata.rights.policyId)
      fail("denied");
    return metadata;
  };
  return {
    now,
    capture,
    encode,
    digest,
    hash,
    validate,
    validateResearchChatInput,
    authorize,
    scoped,
    run,
    ensureAccount,
    rightsShape,
    latestRights,
    rights,
    artifact,
    sealed,
    maxProjectionAgeMs: options.maxProjectionAgeMs,
    commandPolicy,
  };
};

export type PersistenceContext = ReturnType<typeof createPersistenceContext>;
