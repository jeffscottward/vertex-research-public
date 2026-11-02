import {
  type OwnershipPin,
  type PolicyBoundary,
  type PolicyHead,
  type PolicyHistory,
  PolicyRegistryError,
  type PolicyRevocation,
  type PolicyScope,
  type PolicySelection,
  type PolicyStore,
  type PolicyTransaction,
} from "@darkfactory/config/vertex";
import { type SQL, sql } from "drizzle-orm";
import type { Transaction } from "./client.ts";

// Internal persistence only. Public entry points are the authorized registry;
// no native database credentials or raw SQL transport is exported.
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
const digest = (value: unknown): string => {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value))
    return fail("integrity");
  return value;
};
const revision = (value: unknown): bigint => {
  if (typeof value !== "string" || !/^(0|[1-9]\d{0,29})$/.test(value))
    return fail("integrity");
  return BigInt(value);
};
const sameScope = (left: PolicyScope, right: PolicyScope): boolean =>
  left.accountAlias === right.accountAlias &&
  left.environment === right.environment;
const where = (scope: PolicyScope): SQL =>
  sql`account_alias = ${scope.accountAlias} and environment = ${scope.environment}`;
const json = (value: unknown): SQL => sql`${JSON.stringify(value)}::jsonb`;
const rows = async (tx: Transaction, query: SQL): Promise<Row[]> =>
  (await tx.execute(query)).rows as Row[];

export type VertexPolicyStoreOptions = Readonly<{ boundary: PolicyBoundary }>;
export type VertexPolicyTransactionRunner = Readonly<{
  transaction: <T>(operation: (tx: Transaction) => Promise<T>) => Promise<T>;
}>;
export const createVertexPolicyStore = (
  db: VertexPolicyTransactionRunner,
  options: VertexPolicyStoreOptions
): PolicyStore => {
  const boundary = options?.boundary;
  const required: readonly unknown[] = [
    db?.transaction,
    boundary?.validate,
    boundary?.encode,
    boundary?.digest,
    boundary?.epochNanoseconds,
  ];
  if (!required.every((candidate) => typeof candidate === "function"))
    return fail("unavailable");
  const capture = <T>(value: T): T => {
    const bytes = boundary.encode(value);
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > 1_048_576)
      return fail("invalid");
    return structuredClone(value);
  };
  const hash = async (value: unknown): Promise<string> =>
    digest(await boundary.digest(boundary.encode(capture(value))));
  const transaction: PolicyStore["transaction"] = async (
    rawScope,
    operation
  ) => {
    const scope = capture(rawScope);
    id(scope.accountAlias);
    if (!["research", "paper"].includes(scope.environment))
      return fail("invalid");
    try {
      return await db.transaction(async (dbtx) => {
        // Same global grant lock as createVertexAuthorization. Grant revocation
        // cannot linearize between current checks and this policy commit.
        await dbtx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${"vertex-authorization:global"}, 0))`
        );
        await dbtx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify(["vertex-policy", scope.accountAlias, scope.environment])}, 0))`
        );
        const one = async (table: string, extra: SQL): Promise<Row | null> =>
          (
            await rows(
              dbtx,
              sql`select * from ${sql.identifier(table)} where ${where(scope)} and (${extra}) limit 1`
            )
          )[0] ?? null;
        const getSelection = async (
          selectionId: string
        ): Promise<PolicySelection | null> => {
          const row = await one(
            "vertex_policy_selections",
            sql`selection_id = ${id(selectionId)}`
          );
          if (!row) return null;
          const value = await boundary.validate(
            "RuntimePolicySelection",
            capture(row["payload"])
          );
          if (
            !sameScope(value, scope) ||
            value.selectionId !== row["selection_id"] ||
            value.selectionSha256 !== row["selection_sha256"] ||
            value.revision !== row["revision"] ||
            boundary.epochNanoseconds(value.issuedAt).toString() !==
              row["issued_at_ns"] ||
            boundary.epochNanoseconds(value.expiresAt).toString() !==
              row["expires_at_ns"]
          )
            return fail("integrity");
          return value;
        };
        const getHead = async (): Promise<PolicyHead | null> => {
          const row = await one("vertex_policy_heads", sql`true`);
          if (!row) return null;
          const value = await boundary.validate(
            "RuntimePolicyHead",
            capture(row["payload"])
          );
          if (
            !sameScope(value, scope) ||
            (await hash(value)) !== row["record_hash"] ||
            value.revision !== row["revision"] ||
            value.selectionId !== row["selection_id"] ||
            value.selectionSha256 !== row["selection_sha256"] ||
            value.state !== row["state"] ||
            value.updatedAt !== row["updated_at"]
          )
            return fail("integrity");
          if (value.selectionId !== null) {
            const selected = await getSelection(value.selectionId);
            if (!selected || selected.selectionSha256 !== value.selectionSha256)
              return fail("integrity");
          }
          return value;
        };
        const verifyPin = async (row: Row): Promise<OwnershipPin> => {
          const value = await boundary.validate(
            "RuntimeOwnershipPin",
            capture(row["payload"])
          );
          if (
            !sameScope(value, scope) ||
            (await hash(value)) !== row["record_hash"] ||
            value.holderId !== row["holder_id"] ||
            value.holderKind !== row["holder_kind"] ||
            value.selectionId !== row["selection_id"] ||
            value.selectionSha256 !== row["selection_sha256"] ||
            value.module.moduleId !== row["module_id"] ||
            value.module.version !== row["module_version"] ||
            value.module.codeSha256 !== row["code_sha256"] ||
            value.ownerServiceId !== row["owner_service_id"] ||
            value.ownerEpoch !== row["owner_epoch"] ||
            boundary.epochNanoseconds(value.pinnedAt).toString() !==
              row["pinned_at_ns"] ||
            (value.releasedAt === null
              ? null
              : boundary.epochNanoseconds(value.releasedAt).toString()) !==
              row["released_at_ns"]
          )
            return fail("integrity");
          const selected = await getSelection(value.selectionId);
          const module = selected?.modules.find(
            (candidate) => candidate.moduleId === value.module.moduleId
          );
          if (
            !selected ||
            selected.selectionSha256 !== value.selectionSha256 ||
            !module ||
            (await hash(module)) !== (await hash(value.module))
          )
            return fail("integrity");
          return value;
        };
        const getPin = async (
          holderId: string
        ): Promise<OwnershipPin | null> => {
          const row = await one(
            "vertex_policy_ownership_pins",
            sql`holder_id = ${id(holderId)}`
          );
          return row ? verifyPin(row) : null;
        };
        const getHistory = async (
          commandId: string
        ): Promise<PolicyHistory | null> => {
          const row = await one(
            "vertex_policy_history",
            sql`command_id = ${id(commandId)}`
          );
          if (!row) return null;
          const value = capture(row["payload"]) as PolicyHistory;
          if (
            !value ||
            (await hash(value)) !== row["record_hash"] ||
            !sameScope(value.scope, scope) ||
            value.commandId !== row["command_id"] ||
            value.requestSha256 !== row["request_sha256"] ||
            value.operation !== row["operation"] ||
            value.actorId !== row["actor_id"] ||
            value.selectionId !== row["selection_id"] ||
            value.selectionSha256 !== row["selection_sha256"] ||
            value.head.revision !== row["revision"] ||
            boundary.epochNanoseconds(value.recordedAt).toString() !==
              row["recorded_at_ns"]
          )
            return fail("integrity");
          const previous = await boundary.validate(
            "RuntimePolicyHead",
            value.previousHead
          );
          const next = await boundary.validate("RuntimePolicyHead", value.head);
          if (
            !(sameScope(previous, scope) && sameScope(next, scope)) ||
            revision(next.revision) !== revision(previous.revision) + 1n ||
            next.updatedAt !== value.recordedAt
          )
            return fail("integrity");
          return Object.freeze(value);
        };
        const tx: PolicyTransaction = {
          getHead,
          getSelection,
          getHistory,
          getPin,
          insertSelection: async (input) => {
            const value = await boundary.validate(
              "RuntimePolicySelection",
              capture(input)
            );
            if (!sameScope(value, scope)) return fail("integrity");
            const existing = await getSelection(value.selectionId);
            if (existing) {
              if (existing.selectionSha256 !== value.selectionSha256)
                return fail("conflict");
              return "duplicate";
            }
            const maximum = (
              await rows(
                dbtx,
                sql`select max(revision)::text as maximum from vertex_policy_selections where ${where(scope)}`
              )
            )[0]?.["maximum"];
            if (
              maximum !== null &&
              maximum !== undefined &&
              revision(value.revision) <= revision(maximum)
            )
              return fail("conflict");
            await dbtx.execute(
              sql`insert into vertex_policy_selections (account_alias, environment, selection_id, selection_sha256, revision, issued_at_ns, expires_at_ns, payload) values (${scope.accountAlias}, ${scope.environment}, ${value.selectionId}, ${value.selectionSha256}, ${value.revision}, ${boundary.epochNanoseconds(value.issuedAt).toString()}, ${boundary.epochNanoseconds(value.expiresAt).toString()}, ${json(value)})`
            );
            return "recorded";
          },
          putHead: async (input) => {
            const value = await boundary.validate(
              "RuntimePolicyHead",
              capture(input)
            );
            const previous = await getHead();
            if (
              !sameScope(value, scope) ||
              revision(value.revision) !==
                revision(previous?.revision ?? "0") + 1n
            )
              return fail("conflict");
            if (
              value.selectionId !== null &&
              (await getSelection(value.selectionId))?.selectionSha256 !==
                value.selectionSha256
            )
              return fail("integrity");
            const changed = await rows(
              dbtx,
              sql`insert into vertex_policy_heads (account_alias, environment, revision, selection_id, selection_sha256, state, updated_at, record_hash, payload) values (${scope.accountAlias}, ${scope.environment}, ${value.revision}, ${value.selectionId}, ${value.selectionSha256}, ${value.state}, ${value.updatedAt}, ${await hash(value)}, ${json(value)}) on conflict (account_alias, environment) do update set revision = excluded.revision, selection_id = excluded.selection_id, selection_sha256 = excluded.selection_sha256, state = excluded.state, updated_at = excluded.updated_at, record_hash = excluded.record_hash, payload = excluded.payload where vertex_policy_heads.revision = ${previous?.revision ?? "0"} returning revision`
            );
            if (changed.length !== 1) return fail("conflict");
            return;
          },
          appendHistory: async (input) => {
            const value = capture(input);
            const current = await getHead();
            if (
              !(sameScope(value.scope, scope) && current) ||
              (await hash(current)) !== (await hash(value.head)) ||
              revision(value.head.revision) !==
                revision(value.previousHead.revision) + 1n
            )
              return fail("integrity");
            await dbtx.execute(
              sql`insert into vertex_policy_history (account_alias, environment, command_id, revision, operation, selection_id, selection_sha256, actor_id, request_sha256, record_hash, recorded_at_ns, payload) values (${scope.accountAlias}, ${scope.environment}, ${id(value.commandId)}, ${value.head.revision}, ${value.operation}, ${id(value.selectionId)}, ${digest(value.selectionSha256)}, ${id(value.actorId)}, ${digest(value.requestSha256)}, ${await hash(value)}, ${boundary.epochNanoseconds(value.recordedAt).toString()}, ${json(value)})`
            );
          },
          wasActivated: async (selectionId, selectionSha256) => {
            const found = await rows(
              dbtx,
              sql`select command_id from vertex_policy_history where ${where(scope)} and selection_id = ${id(selectionId)} and selection_sha256 = ${digest(selectionSha256)} and operation in ('activate','rollback') order by revision asc limit 1`
            );
            if (!found[0]) return false;
            const receipt = await getHistory(id(found[0]["command_id"]));
            return (
              receipt?.head.selectionId === selectionId &&
              receipt.head.selectionSha256 === selectionSha256 &&
              receipt.head.state === "active-read-only"
            );
          },
          getRevocation: async (selectionId) => {
            const row = await one(
              "vertex_policy_revocations",
              sql`selection_id = ${id(selectionId)}`
            );
            if (!row) return null;
            const value = capture(row["payload"]) as PolicyRevocation;
            if (
              !value ||
              (await hash(value)) !== row["record_hash"] ||
              value.selectionId !== row["selection_id"] ||
              value.selectionSha256 !== row["selection_sha256"] ||
              value.actorId !== row["actor_id"] ||
              value.commandId !== row["command_id"] ||
              boundary.epochNanoseconds(value.recordedAt).toString() !==
                row["recorded_at_ns"]
            )
              return fail("integrity");
            if (
              (await getSelection(value.selectionId))?.selectionSha256 !==
              value.selectionSha256
            )
              return fail("integrity");
            return Object.freeze(value);
          },
          revokeSelection: async (input) => {
            const value = capture(input);
            if (
              (await getSelection(value.selectionId))?.selectionSha256 !==
              value.selectionSha256
            )
              return fail("integrity");
            await dbtx.execute(
              sql`insert into vertex_policy_revocations (account_alias, environment, selection_id, selection_sha256, command_id, actor_id, recorded_at_ns, record_hash, payload) values (${scope.accountAlias}, ${scope.environment}, ${id(value.selectionId)}, ${digest(value.selectionSha256)}, ${id(value.commandId)}, ${id(value.actorId)}, ${boundary.epochNanoseconds(value.recordedAt).toString()}, ${await hash(value)}, ${json(value)})`
            );
          },
          putPin: async (input) => {
            const value = await boundary.validate(
              "RuntimeOwnershipPin",
              capture(input)
            );
            if (!sameScope(value, scope)) return fail("integrity");
            const selected = await getSelection(value.selectionId);
            const module = selected?.modules.find(
              (candidate) => candidate.moduleId === value.module.moduleId
            );
            if (
              !selected ||
              selected.selectionSha256 !== value.selectionSha256 ||
              !module ||
              (await hash(module)) !== (await hash(value.module))
            )
              return fail("integrity");
            const existing = await getPin(value.holderId);
            if (existing) {
              const { releasedAt: _old, ...oldIdentity } = existing;
              const { releasedAt: _new, ...newIdentity } = value;
              if (
                (await hash(oldIdentity)) !== (await hash(newIdentity)) ||
                (existing.releasedAt !== null &&
                  existing.releasedAt !== value.releasedAt)
              )
                return fail("conflict");
              await dbtx.execute(
                sql`update vertex_policy_ownership_pins set released_at_ns = ${value.releasedAt === null ? null : boundary.epochNanoseconds(value.releasedAt).toString()}, record_hash = ${await hash(value)}, payload = ${json(value)} where ${where(scope)} and holder_id = ${value.holderId}`
              );
              return;
            }
            if (value.releasedAt !== null) return fail("conflict");
            await dbtx.execute(
              sql`insert into vertex_policy_ownership_pins (account_alias, environment, holder_id, holder_kind, selection_id, selection_sha256, module_id, module_version, code_sha256, owner_service_id, owner_epoch, pinned_at_ns, released_at_ns, record_hash, payload) values (${scope.accountAlias}, ${scope.environment}, ${value.holderId}, ${value.holderKind}, ${value.selectionId}, ${value.selectionSha256}, ${value.module.moduleId}, ${value.module.version}, ${value.module.codeSha256}, ${value.ownerServiceId}, ${value.ownerEpoch}, ${boundary.epochNanoseconds(value.pinnedAt).toString()}, null, ${await hash(value)}, ${json(value)})`
            );
          },
          listPins: async (selectionId) => {
            const found = await rows(
              dbtx,
              sql`select * from vertex_policy_ownership_pins where ${where(scope)} and selection_id = ${id(selectionId)} order by holder_id limit 1025`
            );
            if (found.length > 1024) return fail("unavailable");
            return Promise.all(found.map(verifyPin));
          },
        };
        return operation(Object.freeze(tx));
      });
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
  return Object.freeze({ transaction });
};

// The enclosing worker transaction owns commit/rollback. No nested transaction,
// savepoint, extra pool or duplicate policy checks. Compose this with the SAME
// createRuntimePolicyRegistry and its current authenticated ports.
export const createVertexPolicyStoreForTransaction = (
  transaction: Transaction,
  options: VertexPolicyStoreOptions
): PolicyStore => {
  return createVertexPolicyStore(
    { transaction: async (operation) => operation(transaction) },
    options
  );
};
