import type {
  NotificationAcceptance,
  NotificationAdmission,
  NotificationAdmissionInput,
  NotificationOutcomeInput,
  NotificationScope,
  NotificationStore,
} from "@darkfactory/notifications/server";
import { type SQL, sql } from "drizzle-orm";
import type { Database, Transaction } from "./client.ts";
import { required as requirePresent } from "./required.ts";

export type NotificationStoreOperation = "admit" | "observe" | "record-outcome";
export type NotificationStoreOptions = Readonly<{
  clock: Readonly<{ now: () => number }>;
  // Bind this to authenticated server context/current grants, never request JSON.
  authorize: (
    scope: NotificationScope,
    operation: NotificationStoreOperation
  ) => Promise<boolean>;
}>;
export class NotificationStoreError extends Error {
  readonly code:
    | "invalid"
    | "denied"
    | "unavailable"
    | "integrity"
    | "conflict";
  constructor(code: NotificationStoreError["code"]) {
    super(`Notification persistence ${code}`);
    this.name = "NotificationStoreError";
    this.code = code;
  }
}

const MAX_EPOCH_MS = 253_402_300_799_999;
const MAX_LIFETIME_MS = 86_400_000;
const MAX_COOLDOWN_MS = 604_800_000;
const fail: (code: NotificationStoreError["code"]) => never = (code) => {
  throw new NotificationStoreError(code);
};
const opaque = (value: unknown): string => {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)
  )
    return fail("invalid");
  return value;
};
const instant = (value: unknown): number => {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    Object.is(value, -0) ||
    value < 0 ||
    value > MAX_EPOCH_MS
  )
    return fail("invalid");
  return value;
};
const fields = (
  value: unknown,
  keys: readonly string[]
): Record<string, unknown> => {
  if (
    value === null ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return fail("invalid");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(descriptors, key)) ||
    Object.values(descriptors).some(
      (descriptor) =>
        !(descriptor.enumerable && Object.hasOwn(descriptor, "value"))
    )
  )
    return fail("invalid");
  return Object.fromEntries(
    keys.map((key) => [
      key,
      requirePresent(descriptors[key], "descriptors[key]").value,
    ])
  );
};
const scopeSnapshot = (value: unknown): NotificationScope => {
  const scope = fields(value, [
    "tenantKey",
    "recipientKey",
    "channel",
    "purpose",
  ]);
  if (scope["channel"] !== "phone" && scope["channel"] !== "email")
    return fail("invalid");
  if (
    scope["purpose"] !== "market-alert" &&
    scope["purpose"] !== "research-update" &&
    scope["purpose"] !== "operational-alert"
  )
    return fail("invalid");
  return Object.freeze({
    tenantKey: opaque(scope["tenantKey"]),
    recipientKey: opaque(scope["recipientKey"]),
    channel: scope["channel"],
    purpose: scope["purpose"],
  });
};
const admissionSnapshot = (
  value: NotificationAdmissionInput
): NotificationAdmissionInput => {
  const input = fields(value, [
    "scope",
    "idempotencyKey",
    "fingerprint",
    "attemptId",
    "now",
    "expiresAt",
    "cooldownMs",
    "mode",
  ]);
  if (
    typeof input["fingerprint"] !== "string" ||
    !/^[0-9a-f]{64}$/.test(input["fingerprint"])
  )
    return fail("invalid");
  if (input["mode"] !== "observe" && input["mode"] !== "commit")
    return fail("invalid");
  const now = instant(input["now"]);
  const expiresAt = instant(input["expiresAt"]);
  if (
    expiresAt - now > MAX_LIFETIME_MS ||
    typeof input["cooldownMs"] !== "number" ||
    !Number.isSafeInteger(input["cooldownMs"]) ||
    input["cooldownMs"] < 1000 ||
    input["cooldownMs"] > MAX_COOLDOWN_MS
  )
    return fail("invalid");
  return Object.freeze({
    scope: scopeSnapshot(input["scope"]),
    idempotencyKey: opaque(input["idempotencyKey"]),
    fingerprint: input["fingerprint"],
    attemptId: opaque(input["attemptId"]),
    now,
    expiresAt,
    cooldownMs: input["cooldownMs"],
    mode: input["mode"],
  });
};
const outcomeSnapshot = (
  value: NotificationOutcomeInput
): NotificationOutcomeInput => {
  const input = fields(value, [
    "scope",
    "idempotencyKey",
    "attemptId",
    "acceptance",
    "now",
  ]);
  if (
    input["acceptance"] !== "accepted" &&
    input["acceptance"] !== "rejected" &&
    input["acceptance"] !== "unknown" &&
    input["acceptance"] !== "not-sent"
  )
    return fail("invalid");
  return Object.freeze({
    scope: scopeSnapshot(input["scope"]),
    idempotencyKey: opaque(input["idempotencyKey"]),
    attemptId: opaque(input["attemptId"]),
    acceptance: input["acceptance"],
    now: instant(input["now"]),
  });
};
const recipientWhere = (scope: NotificationScope): SQL =>
  sql`tenant_key = ${scope.tenantKey} and recipient_key = ${scope.recipientKey} and channel = ${scope.channel}`;
const admissionWhere = (
  scope: NotificationScope,
  idempotencyKey: string
): SQL =>
  sql`${recipientWhere(scope)} and purpose = ${scope.purpose} and idempotency_key = ${idempotencyKey}`;
const rows = async (
  tx: Transaction,
  query: SQL
): Promise<Record<string, unknown>[]> =>
  (await tx.execute(query)).rows as Record<string, unknown>[];
const databaseInstant = (value: unknown): number => {
  if (typeof value === "string" && /^(0|[1-9]\d{0,14})$/.test(value))
    return instant(Number(value));
  return instant(value);
};
const acceptance = (value: unknown): NotificationAcceptance => {
  if (
    value !== "pending" &&
    value !== "accepted" &&
    value !== "rejected" &&
    value !== "unknown" &&
    value !== "not-sent"
  )
    return fail("integrity");
  return value;
};

// The sole durable NotificationStore. No sender/provider dependency, notification
// body, automatic retry/reaper, cooldown release, or second outbox is present.
export const createNotificationStore = (
  db: Database,
  options: NotificationStoreOptions
): NotificationStore => {
  if (
    !db ||
    typeof db.transaction !== "function" ||
    !options ||
    typeof options.clock?.now !== "function" ||
    typeof options.authorize !== "function"
  )
    fail("unavailable");
  const now = (minimum: number): number =>
    Math.max(minimum, instant(options.clock.now()));
  const authorize = async (
    scope: NotificationScope,
    operation: NotificationStoreOperation
  ): Promise<void> => {
    let allowed = false;
    try {
      allowed = (await options.authorize(scope, operation)) === true;
    } catch {
      allowed = false;
    }
    if (!allowed) fail("denied");
  };
  const protect = async <T>(operation: () => Promise<T>): Promise<T> => {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof NotificationStoreError)
        throw new NotificationStoreError(error.code);
      const pg = error as { code?: string; cause?: { code?: string } };
      if (
        ["23505", "40001", "40P01"].includes(pg?.code ?? pg?.cause?.code ?? "")
      )
        return fail("conflict");
      return fail("unavailable");
    }
  };
  const lockRecipient = async (
    tx: Transaction,
    scope: NotificationScope
  ): Promise<void> => {
    // Hash collisions only serialize extra work; the actual SQL keys below stay
    // exact-scoped. Purpose is excluded to serialize cross-purpose cooldown.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify(["notification-admission", scope.tenantKey, scope.recipientKey, scope.channel])}, 0))`
    );
  };
  const check = async (
    tx: Transaction,
    input: NotificationAdmissionInput,
    at: number
  ): Promise<NotificationAdmission> => {
    const previous = (
      await rows(
        tx,
        sql`select fingerprint, acceptance from notification_admissions where ${admissionWhere(input.scope, input.idempotencyKey)} limit 1`
      )
    )[0];
    // Permanent tombstones precede cooldown: neither expiry nor another attempt
    // ID can recycle an admitted key after an unknown provider outcome.
    if (previous) {
      if (previous["fingerprint"] !== input.fingerprint)
        return { status: "conflict" };
      return {
        status: "duplicate",
        acceptance: acceptance(previous["acceptance"]),
      };
    }
    if (input.expiresAt <= at) return { status: "expired" };
    const cooldown = (
      await rows(
        tx,
        sql`select cooldown_until_ms from notification_cooldowns where ${recipientWhere(input.scope)} limit 1`
      )
    )[0];
    if (cooldown && databaseInstant(cooldown["cooldown_until_ms"]) > at)
      return { status: "cooldown" };
    return { status: "eligible" };
  };
  return Object.freeze<NotificationStore>({
    admit: (value) =>
      protect(async () => {
        const input = admissionSnapshot(value);
        const operation = input.mode === "observe" ? "observe" : "admit";
        await authorize(input.scope, operation);
        if (input.mode === "observe") {
          // READ ONLY + repeatable-read snapshot. No writes, advisory lock, row
          // lock, lease/reservation, outcome or preview persistence is performed.
          return db.transaction(
            async (tx) => {
              await authorize(input.scope, "observe");
              const result = await check(tx, input, now(input.now));
              await authorize(input.scope, "observe");
              if (
                result.status === "eligible" &&
                input.expiresAt <= now(input.now)
              )
                return { status: "expired" as const };
              return result;
            },
            { isolationLevel: "repeatable read", accessMode: "read only" }
          );
        }
        return db.transaction(async (tx) => {
          await lockRecipient(tx, input.scope);
          await authorize(input.scope, "admit");
          const at = now(input.now);
          const result = await check(tx, input, at);
          if (result.status !== "eligible") return result;
          // Re-evaluate the trusted clock after queued I/O, not only on entry.
          const admittedAt = now(at);
          if (input.expiresAt <= admittedAt)
            return { status: "expired" as const };
          const cooldownUntil = instant(admittedAt + input.cooldownMs);
          await tx.execute(
            sql`insert into notification_admissions (tenant_key, recipient_key, channel, purpose, idempotency_key, fingerprint, attempt_id, acceptance, admitted_at_ms, expires_at_ms, outcome_at_ms) values (${input.scope.tenantKey}, ${input.scope.recipientKey}, ${input.scope.channel}, ${input.scope.purpose}, ${input.idempotencyKey}, ${input.fingerprint}, ${input.attemptId}, 'pending', ${admittedAt}, ${input.expiresAt}, null)`
          );
          await tx.execute(
            sql`insert into notification_cooldowns (tenant_key, recipient_key, channel, last_attempt_at_ms, cooldown_until_ms) values (${input.scope.tenantKey}, ${input.scope.recipientKey}, ${input.scope.channel}, ${admittedAt}, ${cooldownUntil}) on conflict (tenant_key, recipient_key, channel) do update set last_attempt_at_ms = excluded.last_attempt_at_ms, cooldown_until_ms = excluded.cooldown_until_ms`
          );
          await authorize(input.scope, "admit");
          if (input.expiresAt <= now(admittedAt))
            throw new NotificationStoreError("conflict");
          return { status: "admitted" as const, attemptId: input.attemptId };
        });
      }),
    recordOutcome: (value) =>
      protect(async () => {
        const input = outcomeSnapshot(value);
        await authorize(input.scope, "record-outcome");
        return db.transaction(async (tx) => {
          await lockRecipient(tx, input.scope);
          await authorize(input.scope, "record-outcome");
          const previous = (
            await rows(
              tx,
              sql`select attempt_id, acceptance, admitted_at_ms, outcome_at_ms from notification_admissions where ${admissionWhere(input.scope, input.idempotencyKey)} limit 1`
            )
          )[0];
          if (
            !previous ||
            previous["attempt_id"] !== input.attemptId ||
            input.now < databaseInstant(previous["admitted_at_ms"])
          )
            return { status: "stale" as const };
          const oldAcceptance = acceptance(previous["acceptance"]);
          if (oldAcceptance !== "pending") {
            return {
              status:
                oldAcceptance === input.acceptance
                  ? ("recorded" as const)
                  : ("stale" as const),
            };
          }
          const outcomeAt = now(input.now);
          const updated = await rows(
            tx,
            sql`update notification_admissions set acceptance = ${input.acceptance}, outcome_at_ms = ${outcomeAt} where ${admissionWhere(input.scope, input.idempotencyKey)} and attempt_id = ${input.attemptId} and acceptance = 'pending' returning attempt_id`
          );
          // Cooldown is intentionally untouched, including rejected/not-sent.
          return {
            status:
              updated.length === 1 ? ("recorded" as const) : ("stale" as const),
          };
        });
      }),
  });
};
