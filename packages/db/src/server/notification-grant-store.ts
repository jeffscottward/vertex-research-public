import type { NotificationFetch } from "@darkfactory/notifications/server";
import type {
  NotificationAccountScope,
  NotificationAuthorityMutation,
  NotificationAuthorityRevocation,
  NotificationConfigurationResolverOptions,
  NotificationConsent,
  NotificationDeliveryReadSource,
  NotificationDeliveryStatus,
  NotificationDispatch,
  NotificationGrantRepository,
  NotificationRecipientBinding,
  NotificationRecipientGrant,
} from "@darkfactory/notifications/server/dispatch";
import {
  createNotificationConfigurationResolver,
  createNotificationDispatch,
  NotificationAuthorityError,
  notificationAccount,
  notificationBinding,
  notificationEventKey,
  notificationFail,
  notificationFields,
  notificationKey,
  notificationMilliseconds,
  notificationVersion,
  notificationVertexIdentifier,
  snapshotNotificationConsent,
  snapshotNotificationRecipientGrant,
} from "@darkfactory/notifications/server/dispatch";
import {
  canonicalArtifactJson,
  hashArtifact,
} from "@darkfactory/shared/vertex";
import { type SQL, sql } from "drizzle-orm";
import type { Database, Transaction } from "./client.ts";
import {
  createNotificationStore,
  type NotificationStoreOptions,
} from "./notification-store.ts";
import { required as requirePresent } from "./required.ts";

export type NotificationAuthenticatedPrincipal = Readonly<{
  actorId: string;
  tenantKey: string;
}>;
export type NotificationAuthorityOperation =
  | "list"
  | "resolve"
  | "delivery-read";
export type NotificationAuthorityAuthorization = Readonly<{
  principal: NotificationAuthenticatedPrincipal;
  scope: NotificationAccountScope;
  operation: NotificationAuthorityOperation;
  purpose: NotificationRecipientBinding["purpose"];
  binding: NotificationRecipientBinding | null;
}>;
export type NotificationAuthorityPrivilege = Readonly<{
  principal: NotificationAuthenticatedPrincipal;
  action: "issue-consent" | "revoke-consent" | "issue-grant" | "revoke-grant";
  value: NotificationConsent | NotificationRecipientGrant;
  expectedVersion: string | null;
}>;
export type NotificationGrantStoreOptions<Context> = Readonly<{
  clock: Readonly<{ now: () => number }>;
  // Must resolve a server session/current service credential. Header fields or
  // caller-authored authenticated:true are not acceptable implementations.
  authenticate: (
    context: Context
  ) => Promise<NotificationAuthenticatedPrincipal | null>;
  authorize: (
    context: Context,
    request: NotificationAuthorityAuthorization
  ) => Promise<boolean>;
  // Separate administrative/recipient-consent authority. Missing means deny.
  // issue-consent must verify the recipient's explicit destination/purpose
  // consent independently of the service's send or grant-management rights.
  privilegedAuthorization?:
    | Readonly<{
        authorize: (
          context: Context,
          request: NotificationAuthorityPrivilege
        ) => Promise<boolean>;
      }>
    | undefined;
}>;
type Executor = Pick<Database, "execute">;
type Kind = "grant" | "consent";
type Value = NotificationConsent | NotificationRecipientGrant;
type RecordVersion = Readonly<{
  value: Value;
  status: "granted" | "revoked";
  requestHash: string;
  recordedAt: number;
}>;
const rows = async (
  executor: Executor,
  query: SQL
): Promise<Record<string, unknown>[]> =>
  (await executor.execute(query)).rows as Record<string, unknown>[];
const instant = (value: unknown): number =>
  notificationMilliseconds(
    typeof value === "string" && /^(0|[1-9][0-9]{0,14})$/.test(value)
      ? Number(value)
      : value
  );
const idOf = (kind: Kind, value: Value): string =>
  kind === "consent"
    ? (value as NotificationConsent).consentId
    : (value as NotificationRecipientGrant).grantId;
const capture = (kind: Kind, raw: unknown): Value =>
  kind === "consent"
    ? snapshotNotificationConsent(raw)
    : snapshotNotificationRecipientGrant(raw);
const same = (a: unknown, b: unknown): boolean =>
  canonicalArtifactJson(a) === canonicalArtifactJson(b);
const protect = async <T>(work: () => Promise<T>): Promise<T> => {
  try {
    return await work();
  } catch (error) {
    if (error instanceof NotificationAuthorityError)
      throw new NotificationAuthorityError(error.code);
    const pg = error as { code?: string; cause?: { code?: string } } | null;
    return notificationFail(
      ["23505", "40001", "40P01"].includes(pg?.code ?? pg?.cause?.code ?? "")
        ? "conflict"
        : "unavailable"
    );
  }
};
const currentJoin = sql`notification_authority_current c join notification_authority_versions v on v.tenant_key = c.tenant_key and v.account_alias = c.account_alias and v.environment = c.environment and v.record_kind = c.record_kind and v.authority_id = c.authority_id and v.version = c.current_version`;
const whereScope = (tenantKey: string, scope: NotificationAccountScope): SQL =>
  sql`v.tenant_key = ${tenantKey} and v.account_alias = ${scope.accountAlias} and v.environment = ${scope.environment}`;
const verify = async (row: Record<string, unknown>): Promise<RecordVersion> => {
  if (row["record_kind"] !== "grant" && row["record_kind"] !== "consent")
    return notificationFail("integrity");
  const value = capture(row["record_kind"], row["payload"]);
  if (
    value.tenantKey !== row["tenant_key"] ||
    value.accountAlias !== row["account_alias"] ||
    value.environment !== row["environment"] ||
    value.version !== row["version"] ||
    value.recipientKey !== row["recipient_key"] ||
    value.channel !== row["channel"] ||
    value.purpose !== row["purpose"] ||
    idOf(row["record_kind"], value) !== row["authority_id"] ||
    value.validFrom !== instant(row["valid_from_ms"]) ||
    value.expiresAt !== instant(row["expires_at_ms"])
  )
    return notificationFail("integrity");
  if (
    (await hashArtifact({
      kind: row["record_kind"],
      status: row["status"],
      value,
      recordedBy: row["recorded_by"],
      recordedAt: instant(row["recorded_at_ms"]),
    })) !== row["payload_hash"] ||
    (await hashArtifact(notificationBinding(value))) !== row["binding_hash"] ||
    typeof row["request_hash"] !== "string" ||
    !/^[0-9a-f]{64}$/.test(row["request_hash"]) ||
    (row["status"] !== "granted" && row["status"] !== "revoked")
  )
    return notificationFail("integrity");
  notificationVertexIdentifier(row["recorded_by"]);
  return Object.freeze({
    value,
    status: row["status"],
    requestHash: row["request_hash"],
    recordedAt: instant(row["recorded_at_ms"]),
  });
};
const current = async (
  executor: Executor,
  tenantKey: string,
  scope: NotificationAccountScope,
  kind: Kind,
  id: string
): Promise<RecordVersion | null> => {
  const found = (
    await rows(
      executor,
      sql`select v.* from ${currentJoin} where ${whereScope(tenantKey, scope)} and v.record_kind = ${kind} and v.authority_id = ${id} limit 1`
    )
  )[0];
  return found ? verify(found) : null;
};
const usable = (record: RecordVersion, now: number): boolean =>
  record.status === "granted" &&
  record.recordedAt <= now &&
  record.value.validFrom <= now &&
  now < record.value.expiresAt;
const consentFor = async (
  executor: Executor,
  value: NotificationRecipientGrant,
  now: number
): Promise<boolean> => {
  const consent = await current(
    executor,
    value.tenantKey,
    value,
    "consent",
    value.consentId
  );
  return (
    !!consent &&
    usable(consent, now) &&
    consent.value.version === value.consentVersion &&
    same(notificationBinding(consent.value), notificationBinding(value)) &&
    consent.value.validFrom <= value.validFrom &&
    consent.value.expiresAt >= value.expiresAt
  );
};

const security = <Context>(options: NotificationGrantStoreOptions<Context>) => {
  if (
    !options ||
    typeof options.clock?.now !== "function" ||
    typeof options.authenticate !== "function" ||
    typeof options.authorize !== "function"
  )
    notificationFail("unavailable");
  const now = (): number => notificationMilliseconds(options.clock.now());
  const principal = async (
    context: Context
  ): Promise<NotificationAuthenticatedPrincipal> => {
    const resolved = await options.authenticate(context);
    if (!resolved) return notificationFail("denied");
    const value = notificationFields(resolved, ["actorId", "tenantKey"]);
    return Object.freeze({
      actorId: notificationVertexIdentifier(value["actorId"]),
      tenantKey: notificationKey(value["tenantKey"]),
    });
  };
  const unchanged = async (
    context: Context,
    before: NotificationAuthenticatedPrincipal
  ): Promise<void> => {
    if (!same(before, await principal(context))) notificationFail("denied");
  };
  const authorize = async (
    context: Context,
    actor: NotificationAuthenticatedPrincipal,
    scope: NotificationAccountScope,
    operation: NotificationAuthorityOperation,
    purpose: NotificationRecipientBinding["purpose"],
    binding: NotificationRecipientBinding | null
  ): Promise<void> => {
    if (binding && binding.tenantKey !== actor.tenantKey)
      notificationFail("denied");
    if (
      (await options.authorize(
        context,
        Object.freeze({
          principal: actor,
          scope: notificationAccount(scope.accountAlias, scope.environment),
          operation,
          purpose,
          binding,
        })
      )) !== true
    )
      notificationFail("denied");
    await unchanged(context, actor);
  };
  const privilege = async (
    context: Context,
    actor: NotificationAuthenticatedPrincipal,
    action: NotificationAuthorityPrivilege["action"],
    value: Value,
    expectedVersion: string | null
  ): Promise<void> => {
    if (
      actor.tenantKey !== value.tenantKey ||
      typeof options.privilegedAuthorization?.authorize !== "function"
    )
      notificationFail("denied");
    if (
      (await requirePresent(
        options.privilegedAuthorization,
        "options.privilegedAuthorization"
      ).authorize(
        context,
        Object.freeze({ principal: actor, action, value, expectedVersion })
      )) !== true
    )
      notificationFail("denied");
    await unchanged(context, actor);
  };
  return { now, principal, unchanged, authorize, privilege };
};

// Sole grant/consent repository. Consents never imply send authority; a send grant
// pins one exact CURRENT consent version. Revocation is append-only and immediate
// at all future resolution points; old accepted versions are never fallback.
export const createNotificationGrantRepository = <Context>(
  db: Database,
  options: NotificationGrantStoreOptions<Context>
): NotificationGrantRepository<Context> => {
  const auth = security(options);
  if (
    !db ||
    typeof db.transaction !== "function" ||
    typeof db.execute !== "function"
  )
    notificationFail("unavailable");
  const lock = async (
    tx: Transaction,
    tenantKey: string,
    scope: NotificationAccountScope
  ): Promise<void> => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${canonicalArtifactJson(["notification-authority", tenantKey, scope.accountAlias, scope.environment])}, 0))`
    );
  };
  const append = async (
    tx: Transaction,
    actor: NotificationAuthenticatedPrincipal,
    kind: Kind,
    value: Value,
    status: "granted" | "revoked",
    expectedVersion: string | null,
    requestHash: string
  ): Promise<void> => {
    const bindingHash = await hashArtifact(notificationBinding(value));
    const at = auth.now();
    // Seal status and audit time too: changing a revoked row to granted cannot
    // preserve the envelope digest.
    const payloadHash = await hashArtifact({
      kind,
      status,
      value,
      recordedBy: actor.actorId,
      recordedAt: at,
    });
    await tx.execute(
      sql`insert into notification_authority_versions (tenant_key, account_alias, environment, record_kind, authority_id, version, status, recipient_key, channel, purpose, binding_hash, payload_hash, request_hash, payload, recorded_by, recorded_at_ms, valid_from_ms, expires_at_ms) values (${value.tenantKey}, ${value.accountAlias}, ${value.environment}, ${kind}, ${idOf(kind, value)}, ${value.version}, ${status}, ${value.recipientKey}, ${value.channel}, ${value.purpose}, ${bindingHash}, ${payloadHash}, ${requestHash}, ${JSON.stringify(value)}::jsonb, ${actor.actorId}, ${at}, ${value.validFrom}, ${value.expiresAt})`
    );
    if (expectedVersion === null) {
      await tx.execute(
        sql`insert into notification_authority_current (tenant_key, account_alias, environment, record_kind, authority_id, current_version) values (${value.tenantKey}, ${value.accountAlias}, ${value.environment}, ${kind}, ${idOf(kind, value)}, ${value.version})`
      );
    } else {
      const updated = await rows(
        tx,
        sql`update notification_authority_current set current_version = ${value.version} where tenant_key = ${value.tenantKey} and account_alias = ${value.accountAlias} and environment = ${value.environment} and record_kind = ${kind} and authority_id = ${idOf(kind, value)} and current_version = ${expectedVersion} returning current_version`
      );
      if (updated.length !== 1) notificationFail("conflict");
    }
  };
  const mutate = (
    context: Context,
    kind: Kind,
    action: "issue" | "revoke",
    raw: unknown
  ): Promise<"recorded" | "duplicate"> =>
    protect(async () => {
      let desired: Value | undefined;
      let scope: NotificationAccountScope;
      let id: string;
      let version: string;
      let expected: string | null;
      let tenantKey: string;
      if (action === "issue") {
        const input = notificationFields(raw, ["value", "expectedVersion"]);
        desired = capture(kind, input["value"]);
        tenantKey = desired.tenantKey;
        scope = notificationAccount(desired.accountAlias, desired.environment);
        id = idOf(kind, desired);
        version = desired.version;
        expected =
          input["expectedVersion"] === null
            ? null
            : notificationVersion(input["expectedVersion"]);
      } else {
        const input = notificationFields(raw, [
          "tenantKey",
          "accountAlias",
          "environment",
          "id",
          "version",
          "expectedVersion",
        ]);
        tenantKey = notificationKey(input["tenantKey"]);
        scope = notificationAccount(
          input["accountAlias"],
          input["environment"]
        );
        id = notificationKey(input["id"]);
        version = notificationVersion(input["version"]);
        expected = notificationVersion(input["expectedVersion"]);
      }
      if (BigInt(version) !== (expected === null ? 1n : BigInt(expected) + 1n))
        return notificationFail("invalid");
      const actor = await auth.principal(context);
      if (tenantKey !== actor.tenantKey) return notificationFail("denied");
      return db.transaction(async (tx) => {
        await lock(tx, actor.tenantKey, scope);
        const previous = await current(tx, actor.tenantKey, scope, kind, id);
        if (action === "revoke") {
          if (!previous) return notificationFail("denied");
          desired = capture(kind, { ...previous.value, version });
        }
        const value = requirePresent(desired, "desired");
        const permission: NotificationAuthorityPrivilege["action"] =
          kind === "consent"
            ? action === "issue"
              ? "issue-consent"
              : "revoke-consent"
            : action === "issue"
              ? "issue-grant"
              : "revoke-grant";
        await auth.privilege(context, actor, permission, value, expected);
        const status = action === "issue" ? "granted" : "revoked";
        const requestHash = await hashArtifact({
          action: permission,
          value,
          expectedVersion: expected,
          actorId: actor.actorId,
        });
        if (previous?.value.version === version) {
          if (
            previous.requestHash !== requestHash ||
            previous.status !== status
          )
            return notificationFail("conflict");
          return "duplicate" as const;
        }
        if ((previous?.value.version ?? null) !== expected)
          return notificationFail("conflict");
        if (
          previous &&
          !same(notificationBinding(previous.value), notificationBinding(value))
        )
          return notificationFail("conflict");
        if (previous && previous.recordedAt > auth.now())
          return notificationFail("integrity");
        if (action === "issue") {
          if (value.expiresAt <= auth.now()) return notificationFail("invalid");
          if (
            kind === "grant" &&
            !(await consentFor(
              tx,
              value as NotificationRecipientGrant,
              auth.now()
            ))
          )
            return notificationFail("denied");
        }
        await append(tx, actor, kind, value, status, expected, requestHash);
        await auth.privilege(context, actor, permission, value, expected);
        if (
          action === "issue" &&
          (value.expiresAt <= auth.now() ||
            (kind === "grant" &&
              !(await consentFor(
                tx,
                value as NotificationRecipientGrant,
                auth.now()
              ))))
        )
          return notificationFail("denied");
        return "recorded" as const;
      });
    });
  return Object.freeze<NotificationGrantRepository<Context>>({
    issueConsent: (
      context,
      input: NotificationAuthorityMutation<NotificationConsent>
    ) => mutate(context, "consent", "issue", input),
    revokeConsent: (context, input: NotificationAuthorityRevocation) =>
      mutate(context, "consent", "revoke", input),
    issueGrant: (
      context,
      input: NotificationAuthorityMutation<NotificationRecipientGrant>
    ) => mutate(context, "grant", "issue", input),
    revokeGrant: (context, input: NotificationAuthorityRevocation) =>
      mutate(context, "grant", "revoke", input),
    listCurrent: (context, raw, signal) =>
      protect(async () => {
        const input = notificationFields(raw, [
          "accountAlias",
          "environment",
          "purpose",
        ]);
        const scope = notificationAccount(
          input["accountAlias"],
          input["environment"]
        );
        if (
          input["purpose"] !== "market-alert" &&
          input["purpose"] !== "research-update" &&
          input["purpose"] !== "operational-alert"
        )
          return notificationFail("invalid");
        const purpose = input["purpose"];
        const actor = await auth.principal(context);
        await auth.authorize(context, actor, scope, "list", purpose, null);
        if (signal.aborted) return notificationFail("unavailable");
        return db.transaction(
          async (tx) => {
            const at = auth.now();
            const found = await rows(
              tx,
              sql`select v.* from ${currentJoin} where ${whereScope(actor.tenantKey, scope)} and v.record_kind = 'grant' and v.status = 'granted' and v.purpose = ${purpose} and v.valid_from_ms <= ${at} and v.expires_at_ms > ${at} order by v.authority_id limit 33`
            );
            if (found.length > 32) return notificationFail("unavailable");
            const result: NotificationRecipientGrant[] = [];
            for (const row of found) {
              const record = await verify(row);
              const value = record.value as NotificationRecipientGrant;
              if (
                usable(record, auth.now()) &&
                (await consentFor(tx, value, auth.now()))
              ) {
                await auth.authorize(
                  context,
                  actor,
                  scope,
                  "resolve",
                  purpose,
                  notificationBinding(value)
                );
                result.push(value);
              }
            }
            await auth.authorize(context, actor, scope, "list", purpose, null);
            if (signal.aborted) return notificationFail("unavailable");
            return Object.freeze(result);
          },
          { isolationLevel: "repeatable read", accessMode: "read only" }
        );
      }),
    resolveCurrent: (context, raw, signal) =>
      protect(async () => {
        const input = notificationFields(raw, [
          "accountAlias",
          "environment",
          "grantId",
          "version",
        ]);
        const scope = notificationAccount(
          input["accountAlias"],
          input["environment"]
        );
        const id = notificationKey(input["grantId"]);
        const version = notificationVersion(input["version"]);
        const actor = await auth.principal(context);
        if (signal.aborted) return null;
        return db.transaction(
          async (tx) => {
            const record = await current(
              tx,
              actor.tenantKey,
              scope,
              "grant",
              id
            );
            if (
              !record ||
              record.value.version !== version ||
              !usable(record, auth.now())
            )
              return null;
            const value = record.value as NotificationRecipientGrant;
            await auth.authorize(
              context,
              actor,
              scope,
              "resolve",
              value.purpose,
              notificationBinding(value)
            );
            if (!(await consentFor(tx, value, auth.now()))) return null;
            await auth.authorize(
              context,
              actor,
              scope,
              "resolve",
              value.purpose,
              notificationBinding(value)
            );
            return !signal.aborted && usable(record, auth.now()) ? value : null;
          },
          { isolationLevel: "repeatable read", accessMode: "read only" }
        );
      }),
  });
};

// Read the existing admission ledger, not a parallel delivery log. Independent
// current read permission allows investigation after send/consent revocation;
// it never revives send permission. No destination/config/content is returned.
export const createNotificationDeliveryReadSource = <Context>(
  db: Database,
  options: NotificationGrantStoreOptions<Context>
): NotificationDeliveryReadSource<Context> => {
  const auth = security(options);
  return Object.freeze<NotificationDeliveryReadSource<Context>>({
    read: (context, raw, signal) =>
      protect(async (): Promise<NotificationDeliveryStatus> => {
        const input = notificationFields(raw, [
          "accountAlias",
          "environment",
          "grantId",
          "version",
          "eventId",
        ]);
        const scope = notificationAccount(
          input["accountAlias"],
          input["environment"]
        );
        const id = notificationKey(input["grantId"]);
        const version = notificationVersion(input["version"]);
        const eventKey = await notificationEventKey(
          scope,
          notificationVertexIdentifier(input["eventId"])
        );
        const actor = await auth.principal(context);
        if (signal.aborted) return notificationFail("unavailable");
        return db.transaction(
          async (tx): Promise<NotificationDeliveryStatus> => {
            const row = (
              await rows(
                tx,
                sql`select v.* from notification_authority_versions v where ${whereScope(actor.tenantKey, scope)} and v.record_kind = 'grant' and v.authority_id = ${id} and v.version = ${version} limit 1`
              )
            )[0];
            if (!row) return notificationFail("denied");
            const grant = (await verify(row))
              .value as NotificationRecipientGrant;
            await auth.authorize(
              context,
              actor,
              scope,
              "delivery-read",
              grant.purpose,
              notificationBinding(grant)
            );
            const admission = (
              await rows(
                tx,
                sql`select acceptance, admitted_at_ms, expires_at_ms, outcome_at_ms from notification_admissions where tenant_key = ${actor.tenantKey} and recipient_key = ${grant.recipientKey} and channel = ${grant.channel} and purpose = ${grant.purpose} and idempotency_key = ${eventKey} limit 1`
              )
            )[0];
            await auth.authorize(
              context,
              actor,
              scope,
              "delivery-read",
              grant.purpose,
              notificationBinding(grant)
            );
            if (signal.aborted) return notificationFail("unavailable");
            if (!admission)
              return Object.freeze({
                status: "not-found",
                receipt: "unconfirmed",
                retryable: false,
              });
            const status = admission["acceptance"];
            if (
              status !== "pending" &&
              status !== "accepted" &&
              status !== "rejected" &&
              status !== "unknown" &&
              status !== "not-sent"
            )
              return notificationFail("integrity");
            const admittedAt = instant(admission["admitted_at_ms"]);
            const expiresAt = instant(admission["expires_at_ms"]);
            const outcomeAt =
              admission["outcome_at_ms"] === null
                ? null
                : instant(admission["outcome_at_ms"]);
            if (
              expiresAt <= admittedAt ||
              expiresAt - admittedAt > 86_400_000 ||
              (status === "pending") !== (outcomeAt === null) ||
              (outcomeAt !== null && outcomeAt < admittedAt)
            )
              return notificationFail("integrity");
            return Object.freeze({
              status,
              admittedAt,
              expiresAt,
              outcomeAt,
              receipt: "unconfirmed",
              retryable: false,
            });
          },
          { isolationLevel: "repeatable read", accessMode: "read only" }
        );
      }),
  });
};

export type NotificationControlCompositionOptions<Context> = Readonly<{
  enabled?: boolean | undefined;
  authority: NotificationGrantStoreOptions<Context>;
  // Bind durable admission/outcome access to the server's current service scope.
  // record-outcome must permit retaining admitted ambiguity after recipient
  // revocation; it must never grant permission to re-admit or resend.
  admissionAuthorization: NotificationStoreOptions["authorize"];
  configuration: Omit<
    NotificationConfigurationResolverOptions<Context>,
    "clock"
  >;
  fetcher?: NotificationFetch | undefined;
  timeoutMs?: number | undefined;
}>;
export type NotificationControlComposition<Context> = Readonly<{
  dispatch: NotificationDispatch<Context>;
  grants: NotificationGrantRepository<Context>;
  deliveries: NotificationDeliveryReadSource<Context>;
}>;

// Actual SQL-backed composition for the existing control dispatcher. Construction
// performs no DB/provider I/O and does not enable either configuration or sends.
// Main registers dispatch.handle on the existing notification outbox branch.
export const createNotificationControlComposition = <Context>(
  db: Database,
  options: NotificationControlCompositionOptions<Context>
): NotificationControlComposition<Context> => {
  const grants = createNotificationGrantRepository(db, options.authority);
  const deliveries = createNotificationDeliveryReadSource(
    db,
    options.authority
  );
  const store = createNotificationStore(db, {
    clock: options.authority.clock,
    authorize: options.admissionAuthorization,
  });
  const configurations = createNotificationConfigurationResolver({
    ...options.configuration,
    clock: options.authority.clock,
  });
  const dispatch = createNotificationDispatch({
    enabled: options.enabled,
    clock: options.authority.clock,
    timeoutMs: options.timeoutMs,
    grants,
    store,
    configurations,
    fetcher: options.fetcher,
  });
  return Object.freeze({ dispatch, grants, deliveries });
};
