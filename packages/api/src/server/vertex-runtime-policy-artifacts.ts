import { sql, type SQL } from "drizzle-orm";
import type { Database, Transaction } from "@darkfactory/db/server";
import {
  cachedTransactionRows,
  createVertexAuthorization,
  invalidateTransactionRows,
  type VertexClock,
  type VertexPrincipal,
} from "@darkfactory/db/server/vertex";
import {
  PolicyRegistryError,
  type ArtifactPin,
  type PolicyScope,
} from "@darkfactory/config/vertex";
import {
  canonicalArtifactJson,
  hashArtifact,
  timestampToEpochNanoseconds,
} from "@darkfactory/shared/vertex";
import {
  vertexQualifiedObjectKey,
  type VertexObjectCapabilities,
} from "@darkfactory/storage";
import { PolicyArtifactPinSchema } from "../contracts/vertex-policy.ts";

// Borrow the caller's transaction. This adapter neither creates a pool nor opens
// nested transactions; current ACL reads see the same uncommitted job admission.
export const vertexPolicyTransactionDatabase = (tx: Transaction): Database =>
  ({
    execute: tx.execute.bind(tx),
    transaction: async <T>(
      operation: (transaction: Transaction) => Promise<T>
    ): Promise<T> => operation(tx),
  }) as Database;
// Function declaration (not an arrow) so bare `runtimePolicyFail()` calls narrow.
export function runtimePolicyFail(): never {
  throw new PolicyRegistryError("unavailable");
}
export type RuntimePolicyRow = Record<string, unknown>;
const runtimePolicyObject = (value: unknown): RuntimePolicyRow => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return runtimePolicyFail();
  return value as RuntimePolicyRow;
};
export const runtimePolicyText = (value: unknown): string => {
  if (typeof value !== "string" || value.length === 0)
    return runtimePolicyFail();
  return value;
};
export const runtimePolicyRows = async (
  tx: Transaction,
  query: SQL
): Promise<RuntimePolicyRow[]> =>
  (await tx.execute(query)).rows as RuntimePolicyRow[];
export const runtimePolicyScopeWhere = (scope: PolicyScope): SQL =>
  sql`account_alias = ${scope.accountAlias} and environment = ${scope.environment}`;
const ns = timestampToEpochNanoseconds;

export type VertexRuntimePolicyArtifactOptions = Readonly<{
  clock: VertexClock;
  objectCapabilities: (scope: PolicyScope) => VertexObjectCapabilities;
  signal?: AbortSignal;
}>;
export const createVertexRuntimePolicyArtifacts = (
  options: VertexRuntimePolicyArtifactOptions
) => {
  const authorize = async (
    tx: Transaction,
    principal: VertexPrincipal,
    scope: PolicyScope,
    resourceId: string,
    at: string
  ): Promise<void> => {
    const authorization = createVertexAuthorization(
      vertexPolicyTransactionDatabase(tx),
      { clock: options.clock }
    );
    if (
      !(await authorization.authorize({
        principal,
        scope,
        collectionId: null,
        resourceId,
        action: "read",
        now: at,
      }))
    )
      runtimePolicyFail();
  };
  const currentRights = async (
    tx: Transaction,
    scope: PolicyScope,
    policyId: string,
    version: string,
    at: string
  ): Promise<RuntimePolicyRow> => {
    // The latest revision is reused within this transaction only; every use
    // below still re-checks hash, status and time bounds at `at`. A rights
    // change committed elsewhere applies from the next transaction (step).
    const row = (
      await cachedTransactionRows(
        tx,
        "vertex_rights_versions",
        JSON.stringify([scope.accountAlias, scope.environment, "", policyId]),
        () =>
          runtimePolicyRows(
            tx,
            sql`select * from vertex_rights_versions where ${runtimePolicyScopeWhere(scope)} and collection_key = '' and policy_id = ${policyId} order by revision desc limit 1`
          )
      )
    )[0];
    if (!row) return runtimePolicyFail();
    const value = runtimePolicyObject(row["payload"]);
    if (
      (await hashArtifact(value)) !== row["record_hash"] ||
      value["policyId"] !== policyId ||
      value["version"] !== version ||
      value["policyId"] !== row["policy_id"] ||
      value["version"] !== row["version"] ||
      value["status"] !== row["status"] ||
      value["status"] !== "granted" ||
      !Array.isArray(value["allowedUses"]) ||
      !value["allowedUses"].includes("read")
    )
      runtimePolicyFail();
    const checkedAt = runtimePolicyText(value["checkedAt"]);
    const expiresAt = runtimePolicyText(value["expiresAt"]);
    if (
      ns(checkedAt).toString() !== row["checked_at_ns"] ||
      ns(expiresAt).toString() !== row["expires_at_ns"] ||
      ns(checkedAt) > ns(at) ||
      ns(at) >= ns(expiresAt)
    )
      runtimePolicyFail();
    if (value["retentionUntil"] !== null) {
      const retention = runtimePolicyText(value["retentionUntil"]);
      if (
        ns(retention).toString() !== row["retention_until_ns"] ||
        ns(at) >= ns(retention)
      )
        runtimePolicyFail();
    } else if (row["retention_until_ns"] !== null) runtimePolicyFail();
    return value;
  };
  const inspect = async (
    tx: Transaction,
    scope: PolicyScope,
    pin: ArtifactPin,
    at: string
  ): Promise<
    Readonly<{
      key: string;
      byteLength: number;
      rightsPolicyId: string;
      rightsVersion: string;
    }>
  > => {
    // Account-scoped policy artifacts cannot resolve through collection search,
    // an arbitrary object URL, a request-supplied key or an installation alias.
    // Catalog rows are immutable; reused within this transaction only.
    const catalog = (
      await cachedTransactionRows(
        tx,
        "vertex_artifacts",
        JSON.stringify([
          scope.accountAlias,
          scope.environment,
          "",
          pin.artifactId,
        ]),
        () =>
          runtimePolicyRows(
            tx,
            sql`select * from vertex_artifacts where ${runtimePolicyScopeWhere(scope)} and collection_key = '' and artifact_id = ${pin.artifactId} limit 1`
          )
      )
    )[0];
    let key: string;
    let byteLength: number;
    let rightsPolicyId: string;
    let rightsVersion: string;
    if (catalog) {
      const value = runtimePolicyObject(catalog["payload"]);
      const savedScope = runtimePolicyObject(value["scope"]);
      const rights = runtimePolicyObject(value["rights"]);
      if (
        (await hashArtifact(value)) !== catalog["metadata_hash"] ||
        savedScope["accountAlias"] !== scope.accountAlias ||
        savedScope["environment"] !== scope.environment ||
        value["collectionId"] !== null ||
        value["artifactId"] !== pin.artifactId ||
        value["artifactSha256"] !== pin.artifactSha256 ||
        catalog["artifact_sha256"] !== pin.artifactSha256 ||
        value["contractName"] !== pin.contractName ||
        value["schemaVersion"] !== pin.schemaVersion ||
        value["objectKey"] !== catalog["object_key"] ||
        value["byteLength"] !== Number(catalog["byte_length"])
      )
        runtimePolicyFail();
      key = runtimePolicyText(value["objectKey"]);
      byteLength = Number(value["byteLength"]);
      rightsPolicyId = runtimePolicyText(rights["policyId"]);
      rightsVersion = runtimePolicyText(rights["version"]);
      if (
        catalog["rights_policy_id"] !== rightsPolicyId ||
        catalog["rights_version"] !== rightsVersion
      )
        runtimePolicyFail();
    } else {
      const stage = (
        await runtimePolicyRows(
          tx,
          sql`select * from vertex_worker_stages where ${runtimePolicyScopeWhere(scope)} and collection_key = '' and artifact_id = ${pin.artifactId} limit 1`
        )
      )[0];
      if (!stage) return runtimePolicyFail();
      const value = runtimePolicyObject(stage["payload"]);
      if (
        (await hashArtifact(value)) !== stage["request_hash"] ||
        value["accountAlias"] !== scope.accountAlias ||
        value["environment"] !== scope.environment ||
        value["collectionId"] !== null ||
        value["artifactId"] !== pin.artifactId ||
        value["jobId"] !== stage["job_id"] ||
        value["contentSha256"] !== pin.artifactSha256 ||
        value["canonicalSha256"] !== pin.artifactSha256 ||
        stage["content_sha256"] !== pin.artifactSha256 ||
        stage["canonical_sha256"] !== pin.artifactSha256 ||
        value["contentType"] !== "application/json"
      )
        runtimePolicyFail();
      key = runtimePolicyText(stage["object_key"]);
      byteLength = Number(stage["byte_length"]);
      rightsPolicyId = runtimePolicyText(value["rightsPolicyId"]);
      rightsVersion = runtimePolicyText(value["rightsVersion"]);
    }
    if (
      key !==
        vertexQualifiedObjectKey(scope, null, "manifest", pin.artifactSha256) ||
      !Number.isSafeInteger(byteLength) ||
      byteLength < 1 ||
      byteLength > 1_048_576
    )
      runtimePolicyFail();
    await currentRights(tx, scope, rightsPolicyId, rightsVersion, at);
    return Object.freeze({ key, byteLength, rightsPolicyId, rightsVersion });
  };
  const readVerifiedObject = async (
    scope: PolicyScope,
    pin: ArtifactPin,
    expectedLength?: number
  ): Promise<Uint8Array> => {
    const key = vertexQualifiedObjectKey(
      scope,
      null,
      "manifest",
      pin.artifactSha256
    );
    const capabilities = options.objectCapabilities(scope);
    if (!(capabilities.head && capabilities.getBounded))
      return runtimePolicyFail();
    const head = await capabilities.head(key);
    if (
      head.status !== "ok" ||
      head.value.key !== key ||
      !Number.isSafeInteger(head.value.size) ||
      head.value.size < 1 ||
      head.value.size > 1_048_576 ||
      (expectedLength !== undefined && head.value.size !== expectedLength) ||
      (head.value.checksum !== undefined &&
        head.value.checksum !== pin.artifactSha256)
    )
      return runtimePolicyFail();
    const result = await capabilities.getBounded(key, head.value.size);
    if (result.status !== "ok") return runtimePolicyFail();
    const bytes = result.value.body;
    if (
      !(bytes instanceof Uint8Array) ||
      bytes.byteLength !== head.value.size ||
      result.value.metadata.key !== key ||
      result.value.metadata.size !== head.value.size ||
      (await hashArtifact(bytes)) !== pin.artifactSha256
    )
      runtimePolicyFail();
    const parsed: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    );
    if (
      (await hashArtifact(parsed)) !== pin.artifactSha256 ||
      canonicalArtifactJson(parsed) !== new TextDecoder().decode(bytes)
    )
      runtimePolicyFail();
    return new Uint8Array(bytes);
  };
  const readSelectedArtifact = async (
    tx: Transaction,
    principal: VertexPrincipal,
    scope: PolicyScope,
    pin: ArtifactPin
  ): Promise<Uint8Array> => {
    if (options.signal?.aborted) return runtimePolicyFail();
    PolicyArtifactPinSchema.parse(pin);
    const at = options.clock.now();
    await authorize(tx, principal, scope, "account-scope", at);
    await authorize(tx, principal, scope, pin.artifactId, at);
    const descriptor = await inspect(tx, scope, pin, at);
    const bytes = await readVerifiedObject(scope, pin, descriptor.byteLength);
    // Private contract names are dispatched by the API caller's authoritative
    // parser; there is no permissive public-contract fallback here.
    await authorize(tx, principal, scope, pin.artifactId, options.clock.now());
    // Object I/O ran since the last check: read the current rights head again.
    // Keep this table-wide: callers such as the runtime gateway rely on every
    // later rights read in this transaction being fresh.
    invalidateTransactionRows(tx, "vertex_rights_versions");
    await currentRights(
      tx,
      scope,
      descriptor.rightsPolicyId,
      descriptor.rightsVersion,
      options.clock.now()
    );
    if (options.signal?.aborted) return runtimePolicyFail();
    return bytes;
  };
  const readHostReceipt = async (
    tx: Transaction,
    principal: VertexPrincipal,
    scope: PolicyScope,
    pin: ArtifactPin,
    rightsPolicyId: string,
    rightsVersion: string
  ): Promise<Uint8Array> => {
    if (options.signal?.aborted) return runtimePolicyFail();
    PolicyArtifactPinSchema.parse(pin);
    // Explicit trusted bootstrap profile: immutable hash-selected object, not a
    // worker stage. Its actor and licensing grants exist independently of any
    // activated selection or admitted worker job, avoiding circular readiness.
    await authorize(tx, principal, scope, "account-scope", options.clock.now());
    await authorize(tx, principal, scope, pin.artifactId, options.clock.now());
    await currentRights(
      tx,
      scope,
      rightsPolicyId,
      rightsVersion,
      options.clock.now()
    );
    const bytes = await readVerifiedObject(scope, pin);
    await authorize(tx, principal, scope, pin.artifactId, options.clock.now());
    invalidateTransactionRows(tx, "vertex_rights_versions");
    await currentRights(
      tx,
      scope,
      rightsPolicyId,
      rightsVersion,
      options.clock.now()
    );
    if (options.signal?.aborted) return runtimePolicyFail();
    return bytes;
  };
  const guardedRead = async (
    tx: Transaction,
    principal: VertexPrincipal,
    scope: PolicyScope,
    pin: ArtifactPin
  ): Promise<Uint8Array> => {
    try {
      return await readSelectedArtifact(tx, principal, scope, pin);
    } catch {
      return runtimePolicyFail();
    }
  };
  return Object.freeze({
    authorize,
    currentRights,
    inspect,
    readSelectedArtifact: guardedRead,
    readHostReceipt,
  });
};
