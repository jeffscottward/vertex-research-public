import {
  type CurrentModelUseContext,
  evaluateCurrentModelUse,
  type ModelUseBoundary,
  type ModelUseGrantMutation,
  type ModelUseGrantRecord,
  type ModelUsePrivilegeRequest,
  type ModelUseRepository,
  type ModelUseRequestRecord,
  modelUseHash,
  modelUseIdentity,
  type PolicyAuthorization,
  type PolicyPrincipal,
  PolicyRegistryError,
  type PolicyScope,
} from "@darkfactory/config/vertex";
import { type SQL, sql } from "drizzle-orm";
import type { Transaction } from "./client.ts";
import { required as requirePresent } from "./required.ts";
import {
  proposedModelBudgetReservation,
  reserveModelUseBudget,
} from "./vertex-model-use-budget.ts";
import type { VertexPolicyTransactionRunner } from "./vertex-policy-store.ts";

export type VertexModelUseStoreOptions = Readonly<{
  boundary: ModelUseBoundary;
  clock: Readonly<{ now: () => string }>;
  authorization: PolicyAuthorization;
  privilegedAuthorization: Readonly<{
    authorize: (request: ModelUsePrivilegeRequest) => Promise<boolean>;
  }>;
  currentUseContext: (
    tx: Transaction,
    principal: PolicyPrincipal,
    request: ModelUseRequestRecord
  ) => Promise<CurrentModelUseContext | null>;
}>;
type Row = Record<string, unknown>;
const fail: (code: PolicyRegistryError["code"]) => never = (code) => {
  throw new PolicyRegistryError(code);
};
const id = (value: unknown): string => {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(value)
  )
    return fail("invalid");
  return value;
};
const rev = (value: unknown): bigint => {
  if (typeof value !== "string" || !/^[1-9]\d{0,29}$/.test(value))
    return fail("invalid");
  return BigInt(value);
};
const where = (scope: PolicyScope): SQL =>
  sql`account_alias = ${scope.accountAlias} and environment = ${scope.environment}`;
const json = (value: unknown): SQL => sql`${JSON.stringify(value)}::jsonb`;
const rows = async (tx: Transaction, query: SQL): Promise<Row[]> =>
  (await tx.execute(query)).rows as Row[];
const versionAdvances = (next: string, previous: string): boolean => {
  const left = next.split(".").map(BigInt);
  const right = previous.split(".").map(BigInt);
  for (let index = 0; index < 3; index++) {
    if (left[index] !== right[index])
      return (
        requirePresent(left[index], "left[index]") >
        requirePresent(right[index], "right[index]")
      );
  }
  return false;
};

export const createVertexModelUseStore = (
  db: VertexPolicyTransactionRunner,
  options: VertexModelUseStoreOptions
): ModelUseRepository => {
  const boundary = options?.boundary;
  const required: readonly unknown[] = [
    db?.transaction,
    boundary?.validate,
    boundary?.encode,
    boundary?.digest,
    boundary?.epochNanoseconds,
    boundary?.decimalUnits,
    options.clock?.now,
    options.authorization?.authorize,
    options.privilegedAuthorization?.authorize,
    options.currentUseContext,
  ];
  if (!required.every((candidate) => typeof candidate === "function"))
    return fail("unavailable");
  const capture = <T>(value: T): T => {
    const bytes = boundary.encode(value);
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > 262_144)
      return fail("invalid");
    return structuredClone(value);
  };
  const now = (): string => {
    const value = options.clock.now();
    boundary.epochNanoseconds(value);
    return value;
  };
  const safe = async <T>(operation: () => Promise<T>): Promise<T> => {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof PolicyRegistryError) throw error;
      const pg = error as { code?: string; cause?: { code?: string } } | null;
      const code = pg?.code ?? pg?.cause?.code;
      return fail(
        ["23505", "40001", "40P01"].includes(code ?? "")
          ? "conflict"
          : ["23503", "23514", "22003"].includes(code ?? "")
            ? "integrity"
            : "unavailable"
      );
    }
  };
  const lock = async (tx: Transaction, scope: PolicyScope): Promise<void> => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${"vertex-authorization:global"}, 0))`
    );
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify(["vertex-model-use", scope.accountAlias, scope.environment])}, 0))`
    );
  };
  const readAllowed = async (
    principal: PolicyPrincipal,
    scope: PolicyScope,
    resourceId: string,
    at: string
  ): Promise<boolean> => {
    try {
      return (
        (await options.authorization.authorize({
          principal,
          scope,
          collectionId: null,
          resourceId: "account-scope",
          action: "read",
          now: at,
        })) === true &&
        (await options.authorization.authorize({
          principal,
          scope,
          collectionId: null,
          resourceId,
          action: "read",
          now: at,
        })) === true
      );
    } catch {
      return false;
    }
  };
  const verify = async (
    scope: PolicyScope,
    row: Row
  ): Promise<ModelUseGrantRecord> => {
    const value = await boundary.validate(
      "ModelUseGrant",
      capture(row["payload"])
    );
    if (
      value.accountAlias !== scope.accountAlias ||
      value.environment !== scope.environment ||
      value.grantId !== row["grant_id"] ||
      value.grantVersion !== row["grant_version"] ||
      value.revision !== row["revision"] ||
      value.selectionId !== row["selection_id"] ||
      value.selectionSha256 !== row["selection_sha256"] ||
      value.researchPrincipalId !== row["research_principal_id"] ||
      value.consumerServiceId !== row["consumer_service_id"] ||
      value.status !== row["status"] ||
      value.issuedByActorId !== row["issued_by_actor_id"] ||
      boundary.epochNanoseconds(value.validFrom).toString() !==
        row["valid_from_ns"] ||
      boundary.epochNanoseconds(value.expiresAt).toString() !==
        row["expires_at_ns"] ||
      boundary.epochNanoseconds(value.issuedAt).toString() !==
        row["issued_at_ns"] ||
      (await modelUseHash(boundary, value)) !== row["record_hash"]
    )
      return fail("integrity");
    return value;
  };
  const current = async (
    tx: Transaction,
    scope: PolicyScope,
    grantId: string
  ): Promise<ModelUseGrantRecord | null> => {
    const found = await rows(
      tx,
      sql`select v.*, c.revision as current_revision from vertex_model_use_grant_current c join vertex_model_use_grant_versions v on v.account_alias = c.account_alias and v.environment = c.environment and v.grant_id = c.grant_id and v.grant_version = c.grant_version where c.account_alias = ${scope.accountAlias} and c.environment = ${scope.environment} and c.grant_id = ${id(grantId)} limit 1`
    );
    const row = found[0];
    if (!row) return null;
    const value = await verify(scope, row);
    if (value.revision !== row["current_revision"]) return fail("integrity");
    return value;
  };
  const mutation = async (
    operation: ModelUsePrivilegeRequest["operation"],
    raw: ModelUseGrantMutation
  ): Promise<"recorded" | "duplicate"> =>
    safe(async () => {
      const input = capture(raw);
      id(input.principal.actorId);
      id(input.commandId);
      if (input.expectedRevision !== null) rev(input.expectedRevision);
      const grant = await boundary.validate("ModelUseGrant", input.grant);
      const scope: PolicyScope = {
        accountAlias: grant.accountAlias,
        environment: grant.environment,
      };
      if (
        grant.status !==
          (operation === "issue-model-use" ? "granted" : "revoked") ||
        grant.issuedByActorId !== input.principal.actorId
      )
        return fail("denied");
      const requestSha256 = await modelUseHash(boundary, {
        operation,
        ...input,
        grant,
      });
      return db.transaction(async (tx) => {
        await lock(tx, scope);
        const authorize = async (): Promise<void> => {
          const at = now();
          if (!(await readAllowed(input.principal, scope, grant.grantId, at)))
            return fail("denied");
          let allowed = false;
          try {
            allowed =
              (await options.privilegedAuthorization.authorize({
                principal: input.principal,
                operation,
                grant,
                expectedRevision: input.expectedRevision,
                commandId: input.commandId,
                requestSha256,
                now: at,
              })) === true;
          } catch {
            allowed = false;
          }
          if (!allowed) return fail("denied");
        };
        await authorize();
        const duplicate = (
          await rows(
            tx,
            sql`select * from vertex_model_use_grant_versions where ${where(scope)} and command_id = ${input.commandId} limit 1`
          )
        )[0];
        if (duplicate) {
          const stored = await verify(scope, duplicate);
          if (
            duplicate["request_sha256"] !== requestSha256 ||
            stored.grantId !== grant.grantId ||
            stored.grantVersion !== grant.grantVersion
          )
            return fail("conflict");
          return "duplicate";
        }
        const previous = await current(tx, scope, grant.grantId);
        if (
          (previous?.revision ?? null) !== input.expectedRevision ||
          rev(grant.revision) !== (previous ? rev(previous.revision) : 0n) + 1n
        )
          return fail("conflict");
        if (
          previous &&
          (!versionAdvances(grant.grantVersion, previous.grantVersion) ||
            (await modelUseHash(boundary, modelUseIdentity(previous))) !==
              (await modelUseHash(boundary, modelUseIdentity(grant))))
        )
          return fail("conflict");
        if (
          previous &&
          boundary.epochNanoseconds(grant.issuedAt) <
            boundary.epochNanoseconds(previous.issuedAt)
        )
          return fail("stale");
        if (operation === "revoke-model-use") {
          if (previous?.status !== "granted") return fail("conflict");
          const retained = (value: ModelUseGrantRecord) => ({
            ...value,
            grantVersion: "0.0.0",
            revision: "1",
            status: "revoked",
            issuedByActorId: "redacted",
            issuedAt: "redacted",
          });
          if (
            (await modelUseHash(boundary, retained(previous))) !==
            (await modelUseHash(boundary, retained(grant)))
          )
            return fail("conflict");
        }
        const at = now();
        if (
          boundary.epochNanoseconds(grant.issuedAt) >
            boundary.epochNanoseconds(at) ||
          (operation === "issue-model-use" &&
            boundary.epochNanoseconds(grant.expiresAt) <=
              boundary.epochNanoseconds(at))
        )
          return fail("stale");
        const selection = (
          await rows(
            tx,
            sql`select selection_sha256 from vertex_policy_selections where ${where(scope)} and selection_id = ${grant.selectionId} limit 1`
          )
        )[0];
        if (selection?.["selection_sha256"] !== grant.selectionSha256)
          return fail("integrity");
        await authorize();
        await tx.execute(
          sql`insert into vertex_model_use_grant_versions (account_alias, environment, grant_id, grant_version, revision, selection_id, selection_sha256, research_principal_id, consumer_service_id, status, valid_from_ns, expires_at_ns, issued_at_ns, issued_by_actor_id, command_id, request_sha256, record_hash, payload) values (${scope.accountAlias}, ${scope.environment}, ${grant.grantId}, ${grant.grantVersion}, ${grant.revision}, ${grant.selectionId}, ${grant.selectionSha256}, ${grant.researchPrincipalId}, ${grant.consumerServiceId}, ${grant.status}, ${boundary.epochNanoseconds(grant.validFrom).toString()}, ${boundary.epochNanoseconds(grant.expiresAt).toString()}, ${boundary.epochNanoseconds(grant.issuedAt).toString()}, ${grant.issuedByActorId}, ${input.commandId}, ${requestSha256}, ${await modelUseHash(boundary, grant)}, ${json(grant)})`
        );
        const changed = await rows(
          tx,
          sql`insert into vertex_model_use_grant_current (account_alias, environment, grant_id, grant_version, revision) values (${scope.accountAlias}, ${scope.environment}, ${grant.grantId}, ${grant.grantVersion}, ${grant.revision}) on conflict (account_alias, environment, grant_id) do update set grant_version = excluded.grant_version, revision = excluded.revision where vertex_model_use_grant_current.revision = ${input.expectedRevision ?? "0"} returning revision`
        );
        if (changed.length !== 1) return fail("conflict");
        return "recorded";
      });
    });
  const currentModelUse: ModelUseRepository["currentModelUse"] = async (
    principal,
    raw
  ) =>
    safe(async () => {
      id(principal.actorId);
      const request = await boundary.validate("ModelUseRequest", capture(raw));
      const scope: PolicyScope = {
        accountAlias: request.accountAlias,
        environment: request.environment,
      };
      return db.transaction(async (tx) => {
        await lock(tx, scope);
        await tx.execute(
          sql`insert into vertex_model_use_attempt_identities (account_alias, environment, request_id, request_sha256) values (${scope.accountAlias}, ${scope.environment}, ${request.requestId}, ${request.requestSha256}) on conflict (account_alias, environment, request_id) do nothing`
        );
        const attempt = (
          await rows(
            tx,
            sql`select request_sha256 from vertex_model_use_attempt_identities where ${where(scope)} and request_id = ${request.requestId} limit 1`
          )
        )[0];
        if (attempt?.["request_sha256"] !== request.requestSha256)
          return fail("conflict");
        const grant = await current(tx, scope, request.grantId);
        let context: CurrentModelUseContext | null = null;
        if (await readAllowed(principal, scope, request.grantId, now())) {
          try {
            context = await options.currentUseContext(tx, principal, request);
          } catch {
            context = null;
          }
        }
        // No cached allow: current grant/fence/review/rights/budget/privacy are
        // re-read for every before/after-tokenization/completion request.
        let at = now();
        if (!(await readAllowed(principal, scope, request.grantId, at)))
          context = null;
        // Preflight ALL current facts before charging. The proposed reservation
        // is internal and cannot escape as a proof or caller-authored permission.
        const proposed = context
          ? {
              ...context,
              budget: proposedModelBudgetReservation(
                request,
                context.budgetAdmission
              ),
            }
          : null;
        let proof = await evaluateCurrentModelUse(
          boundary,
          principal,
          request,
          grant,
          proposed,
          at
        );
        if (proof.decision === "allowed" && context && grant) {
          const reserved = await reserveModelUseBudget(
            tx,
            boundary,
            request,
            grant,
            context.budgetAdmission,
            at
          );
          at = now();
          const stillAllowed = await readAllowed(
            principal,
            scope,
            request.grantId,
            at
          );
          const final = await evaluateCurrentModelUse(
            boundary,
            principal,
            request,
            grant,
            stillAllowed ? { ...context, budget: reserved.reservation } : null,
            at
          );
          proof = await boundary.validate("ModelUseProof", {
            ...final,
            externalDispatchAllowed:
              final.decision === "allowed" && reserved.externalDispatchAllowed,
          });
        }
        const recordHash = await modelUseHash(boundary, proof);
        // Multiple truthful observations can share the same clock tick. Keep each
        // distinct proof; in particular never replay first-admission dispatch=true.
        await tx.execute(
          sql`insert into vertex_model_use_proof_audits (account_alias, environment, request_id, request_sha256, checked_at_ns, actor_id, grant_id, grant_version, grant_revision, decision, record_hash, payload) values (${scope.accountAlias}, ${scope.environment}, ${request.requestId}, ${request.requestSha256}, ${boundary.epochNanoseconds(at).toString()}, ${principal.actorId}, ${request.grantId}, ${request.grantVersion}, ${proof.grantRevision}, ${proof.decision}, ${recordHash}, ${json(proof)}) on conflict (account_alias, environment, request_id, checked_at_ns, record_hash) do nothing`
        );
        return proof;
      });
    });
  return Object.freeze({
    issueGrant: (input) => mutation("issue-model-use", input),
    revokeGrant: (input) => mutation("revoke-model-use", input),
    currentModelUse,
  });
};

export const createVertexModelUseStoreForTransaction = (
  transaction: Transaction,
  options: VertexModelUseStoreOptions
): ModelUseRepository => {
  return createVertexModelUseStore(
    { transaction: async (operation) => operation(transaction) },
    options
  );
};
