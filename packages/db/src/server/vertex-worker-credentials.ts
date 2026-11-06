import { deepFreezeArtifact } from "@darkfactory/shared/vertex";
import { sql } from "drizzle-orm";
import type { Database, Transaction } from "./client.ts";
import { databaseErrorDetails } from "./repository-errors.ts";
import {
  array,
  digestString,
  fail,
  identifier,
  insert,
  object,
  one,
  type PersistenceContext,
  type Row,
  rows,
  scopeWhere,
  string,
  time,
} from "./vertex-persistence-core.ts";
import {
  type VertexRecord,
  type VertexScope,
  VertexStoreError,
} from "./vertex-ports.ts";
import { withTransactionReadScope } from "./vertex-transaction-read-cache.ts";

export type WorkerServiceIdentity = Readonly<{
  grantId: string;
  servicePrincipalId: string;
  scope: VertexScope;
  expiresAt: string;
}>;
export type VertexWorkerCredentialOptions = Readonly<{
  validateWorker: (
    name: string,
    value: unknown
  ) => VertexRecord | Promise<VertexRecord>;
  authorizeGrantAdministration: (
    context: unknown,
    action: "issue" | "revoke",
    scope: VertexScope,
    grantId: string,
    details: Readonly<{
      grant: VertexRecord;
      credentialDigest: string;
      recordSha256: string;
      previousRecordSha256: string | null;
      authorizationSha256: string;
      tx: Transaction;
    }>
  ) => Promise<boolean>;
}>;
type CredentialContext = Pick<PersistenceContext, "capture" | "hash" | "now">;

// The worker and metadata service use this SAME credential authority implementation.
// Issued references are instance-local, immutable and bound to the original digest
// and record; a clone or a changed grant can never inherit that capability.
export const createVertexWorkerCredentials = (
  db: Database,
  ctx: CredentialContext,
  options: VertexWorkerCredentialOptions
) => {
  const identities = new WeakMap<
    object,
    Readonly<{ credentialDigest: string; recordSha256: string }>
  >();
  const parse = async (input: unknown): Promise<VertexRecord> => {
    try {
      return deepFreezeArtifact(
        ctx.capture(
          object(
            await options.validateWorker(
              "WorkerServiceGrant",
              ctx.capture(input)
            )
          )
        )
      );
    } catch {
      return fail("invalid");
    }
  };
  const transaction = async <T>(
    rawScope: VertexScope,
    operation: (tx: Transaction, at: string) => Promise<T>
  ): Promise<T> => {
    const scope = ctx.capture(rawScope);
    if (
      !scope ||
      Object.keys(scope).sort().join(",") !== "accountAlias,environment" ||
      !["research", "paper"].includes(scope.environment)
    )
      fail("denied");
    identifier(scope.accountAlias);
    try {
      return await db.transaction(
        withTransactionReadScope(async (tx) => {
          await tx.execute(
            sql`select pg_advisory_xact_lock(hashtextextended(${"vertex-authorization:global"}, 0))`
          );
          await tx.execute(
            sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify(["vertex", scope.accountAlias, scope.environment])}, 0))`
          );
          return operation(tx, ctx.now());
        })
      );
    } catch (error) {
      if (error instanceof VertexStoreError) throw error;
      const { code } = databaseErrorDetails(error);
      if (
        typeof code === "string" &&
        ["23505", "40001", "40P01"].includes(code)
      )
        return fail("conflict");
      return fail("unavailable");
    }
  };
  const verified = async (
    row: Row,
    scope: VertexScope
  ): Promise<VertexRecord> => {
    const value = await parse(row["payload"]);
    if (
      (await ctx.hash(value)) !== row["record_hash"] ||
      value["accountAlias"] !== scope.accountAlias ||
      value["environment"] !== scope.environment ||
      row["account_alias"] !== scope.accountAlias ||
      row["environment"] !== scope.environment ||
      value["grantId"] !== row["grant_id"] ||
      value["servicePrincipalId"] !== row["service_principal_id"] ||
      value["revokedAt"] !== null ||
      time(value["issuedAt"]).toString() !== row["issued_at_ns"] ||
      time(value["expiresAt"]).toString() !== row["expires_at_ns"] ||
      time(value["issuedAt"]) >= time(value["expiresAt"]) ||
      time(value["expiresAt"]) - time(value["issuedAt"]) > 86_400_000_000_000n
    )
      fail("integrity");
    digestString(row["credential_digest"]);
    return value;
  };
  const currentAt = (value: VertexRecord, at: string): void => {
    if (
      time(value["issuedAt"]) > time(at) ||
      time(value["expiresAt"]) <= time(at)
    )
      fail("denied");
  };
  const grant = async (
    tx: Transaction,
    identity: WorkerServiceIdentity,
    operation: string,
    at: string
  ): Promise<VertexRecord> => {
    const issued = identity && identities.get(identity);
    if (!issued) return fail("denied");
    const found = await one(
      tx,
      "vertex_worker_service_grants",
      identity.scope,
      sql`grant_id = ${identity.grantId}`
    );
    if (
      !found ||
      found["revoked_at"] !== null ||
      found["credential_digest"] !== issued.credentialDigest ||
      found["record_hash"] !== issued.recordSha256
    )
      return fail("denied");
    const value = await verified(found, identity.scope);
    if (
      value["grantId"] !== identity.grantId ||
      value["servicePrincipalId"] !== identity.servicePrincipalId ||
      value["expiresAt"] !== identity.expiresAt ||
      !array(value["operations"], 28).includes(operation)
    )
      fail("denied");
    currentAt(value, at);
    const completedAt = ctx.now();
    if (time(completedAt) < time(at)) fail("denied");
    currentAt(value, completedAt);
    return value;
  };
  const authenticate = async (
    credentialDigest: string,
    rawScope: VertexScope,
    operation: string
  ): Promise<WorkerServiceIdentity> => {
    digestString(credentialDigest);
    const scope = ctx.capture(rawScope);
    const startedAt = ctx.now();
    const identity = await transaction(scope, async (tx, at) => {
      const found = await one(
        tx,
        "vertex_worker_service_grants",
        scope,
        sql`credential_digest = ${credentialDigest}`
      );
      if (!found || found["credential_digest"] !== credentialDigest)
        return fail("denied");
      const value = await verified(found, scope);
      const created = Object.freeze({
        grantId: identifier(found["grant_id"]),
        servicePrincipalId: identifier(found["service_principal_id"]),
        scope: Object.freeze({ ...scope }),
        expiresAt: string(value["expiresAt"]),
      });
      identities.set(
        created,
        Object.freeze({
          credentialDigest,
          recordSha256: digestString(found["record_hash"]),
        })
      );
      await grant(tx, created, operation, at);
      return created;
    });
    const completedAt = ctx.now();
    if (
      time(completedAt) < time(startedAt) ||
      time(identity.expiresAt) <= time(completedAt)
    )
      return fail("denied");
    return identity;
  };
  const issueGrant = async (
    adminContext: unknown,
    input: unknown,
    credentialDigest: string
  ): Promise<"recorded" | "duplicate"> => {
    const value = await parse(input);
    const scope = Object.freeze({
      accountAlias: identifier(value["accountAlias"]),
      environment: string(value["environment"]) as VertexScope["environment"],
    });
    digestString(credentialDigest);
    return transaction(scope, async (tx, at) => {
      if (
        value["revokedAt"] !== null ||
        time(value["issuedAt"]) > time(at) ||
        time(value["expiresAt"]) <= time(at) ||
        time(value["expiresAt"]) - time(value["issuedAt"]) > 86_400_000_000_000n
      )
        fail("invalid");
      const hash = await ctx.hash(value);
      const prior = await one(
        tx,
        "vertex_worker_service_grants",
        scope,
        sql`grant_id = ${value["grantId"]}`
      );
      if (prior) await verified(prior, scope);
      if (
        (await options.authorizeGrantAdministration(
          adminContext,
          "issue",
          scope,
          identifier(value["grantId"]),
          {
            grant: value,
            credentialDigest,
            recordSha256: hash,
            previousRecordSha256: prior
              ? digestString(prior["record_hash"])
              : null,
            authorizationSha256: await ctx.hash({
              grant: value,
              credentialDigest,
            }),
            tx,
          }
        )) !== true
      )
        fail("denied");
      currentAt(value, ctx.now());
      if (prior) {
        if (
          prior["record_hash"] !== hash ||
          prior["credential_digest"] !== credentialDigest ||
          prior["revoked_at"] !== null
        )
          fail("conflict");
        return "duplicate";
      }
      await insert(tx, "vertex_worker_service_grants", scope, {
        grant_id: value["grantId"],
        service_principal_id: value["servicePrincipalId"],
        credential_digest: credentialDigest,
        issued_at_ns: time(value["issuedAt"]).toString(),
        expires_at_ns: time(value["expiresAt"]).toString(),
        revoked_at: null,
        record_hash: hash,
        payload: value,
      });
      return "recorded";
    });
  };
  const revokeGrant = async (
    adminContext: unknown,
    rawScope: VertexScope,
    grantId: string
  ): Promise<boolean> => {
    const scope = Object.freeze(ctx.capture(rawScope));
    identifier(grantId);
    return await transaction(scope, async (tx, at) => {
      const prior = await one(
        tx,
        "vertex_worker_service_grants",
        scope,
        sql`grant_id = ${grantId}`
      );
      if (!prior) return fail("denied");
      const value = await verified(prior, scope);
      const hash = await ctx.hash(value);
      if (value["grantId"] !== grantId) fail("integrity");
      // Original exact immutable grant + digest commitment and record CAS.
      const credentialDigest = digestString(prior["credential_digest"]);
      if (
        (await options.authorizeGrantAdministration(
          adminContext,
          "revoke",
          scope,
          grantId,
          {
            grant: value,
            credentialDigest,
            recordSha256: hash,
            previousRecordSha256: hash,
            authorizationSha256: await ctx.hash({
              grant: value,
              credentialDigest,
            }),
            tx,
          }
        )) !== true
      )
        fail("denied");
      const changed = await rows(
        tx,
        sql`update vertex_worker_service_grants set revoked_at = coalesce(revoked_at, ${at}) where ${scopeWhere(scope)} and grant_id = ${grantId} and record_hash = ${hash} returning grant_id`
      );
      return changed.length === 1;
    });
  };
  return Object.freeze({
    authenticate,
    grant,
    transaction,
    issueGrant,
    revokeGrant,
  });
};
