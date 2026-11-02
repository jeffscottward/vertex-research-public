import type {
  NotificationConsent,
  NotificationRecipientGrant,
} from "@darkfactory/notifications/server/dispatch";
import {
  notificationBinding,
  notificationEventKey,
} from "@darkfactory/notifications/server/dispatch";
import { hashArtifact } from "@darkfactory/shared/vertex";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import type { Database } from "./client.ts";
import type {
  NotificationAuthenticatedPrincipal,
  NotificationAuthorityAuthorization,
  NotificationAuthorityPrivilege,
} from "./notification-grant-store.ts";
import {
  createNotificationControlComposition,
  createNotificationDeliveryReadSource,
  createNotificationGrantRepository,
} from "./notification-grant-store.ts";

// Source-authored regressions, deliberately unexecuted. SQL capture only: no DB,
// actual recipient grant/consent, provider configuration or provider transport.
const NOW = 1_700_000_000_000;
const context = { session: "trusted-session" };
const actor = { actorId: "actor-1", tenantKey: "tenant-1" };
const binding = {
  tenantKey: "tenant-1",
  accountAlias: "account-1",
  environment: "research" as const,
  recipientKey: "recipient-1",
  recipientRef: "recipient-ref-1",
  channel: "phone" as const,
  purpose: "research-update" as const,
  destinationRef: "destination-1",
};
const consent: NotificationConsent = {
  ...binding,
  consentId: "consent-1",
  version: "1",
  validFrom: NOW - 1000,
  expiresAt: NOW + 600_000,
};
const grant: NotificationRecipientGrant = {
  ...binding,
  grantId: "grant-1",
  version: "1",
  consentId: consent.consentId,
  consentVersion: consent.version,
  configurationRef: "provider-1",
  templateVersion: "vertex-notification-v1",
  validFrom: NOW,
  expiresAt: NOW + 300_000,
  cooldownMs: 1000,
};
const selection = {
  accountAlias: grant.accountAlias,
  environment: grant.environment,
  grantId: grant.grantId,
  version: grant.version,
};
type Query = Readonly<{ sql: string; params: unknown[] }>;
const record = async (
  kind: "grant" | "consent",
  value: NotificationConsent | NotificationRecipientGrant,
  status: "granted" | "revoked" = "granted",
  requestHash = "a".repeat(64)
) => ({
  tenant_key: value.tenantKey,
  account_alias: value.accountAlias,
  environment: value.environment,
  record_kind: kind,
  authority_id:
    kind === "grant"
      ? (value as NotificationRecipientGrant).grantId
      : (value as NotificationConsent).consentId,
  version: value.version,
  status,
  recipient_key: value.recipientKey,
  channel: value.channel,
  purpose: value.purpose,
  binding_hash: await hashArtifact(notificationBinding(value)),
  payload_hash: await hashArtifact({
    kind,
    status,
    value,
    recordedBy: actor.actorId,
    recordedAt: NOW,
  }),
  request_hash: requestHash,
  payload: value,
  recorded_by: actor.actorId,
  recorded_at_ms: NOW,
  valid_from_ms: value.validFrom,
  expires_at_ms: value.expiresAt,
});
const fixture = (
  respond: (query: Query) => Record<string, unknown>[] = () => []
) => {
  const queries: Query[] = [];
  const dialect = new PgDialect();
  const execute = vi.fn(async (query: SQL) => {
    const compiled = dialect.sqlToQuery(query);
    queries.push(compiled);
    return { rows: respond(compiled) };
  });
  const transaction = vi.fn(
    async (
      work: (tx: { execute: typeof execute }) => Promise<unknown>,
      _mode?: unknown
    ) => work({ execute })
  );
  const db = { execute, transaction } as unknown as Database;
  const authenticate = vi.fn(
    async (): Promise<NotificationAuthenticatedPrincipal | null> => actor
  );
  const authorize = vi.fn(
    async (
      _context: typeof context,
      _request: NotificationAuthorityAuthorization
    ) => true
  );
  const privileged = vi.fn(
    async (
      _context: typeof context,
      _request: NotificationAuthorityPrivilege
    ) => true
  );
  const now = vi.fn(() => NOW);
  const options = {
    authenticate,
    authorize,
    privilegedAuthorization: { authorize: privileged },
    clock: { now },
  };
  return {
    queries,
    execute,
    transaction,
    db,
    authenticate,
    authorize,
    privileged,
    now,
    options,
    repository: createNotificationGrantRepository(db, options),
    deliveries: createNotificationDeliveryReadSource(db, options),
  };
};
const signal = () => new AbortController().signal;
const pair =
  (grantRow: Record<string, unknown>, consentRow: Record<string, unknown>) =>
  (query: Query) => {
    if (query.sql.includes("notification_authority_current c")) {
      return query.params.includes("consent") ? [consentRow] : [grantRow];
    }
    return [];
  };

describe("trusted notification authority repository", () => {
  it("constructs the SQL-backed composition without enabling or performing effects", async () => {
    const h = fixture();
    const resolveDestination = vi.fn(async () => null);
    const composed = createNotificationControlComposition(h.db, {
      authority: h.options,
      admissionAuthorization: async () => true,
      configuration: {
        registrations: [],
        allowedNtfyOrigins: [],
        authorize: async () => false,
        resolveDestination,
      },
    });
    expect(
      await composed.dispatch.handle(
        context,
        {},
        { dryRun: false, signal: signal() }
      )
    ).toMatchObject({ reason: "disabled" });
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.authenticate).not.toHaveBeenCalled();
    return expect(resolveDestination).not.toHaveBeenCalled();
  });

  it("requires an authenticated tenant and independent privilege, not send rights", async () => {
    const h = fixture();
    h.authenticate.mockResolvedValue(null);
    await expect(
      h.repository.issueConsent(context, {
        value: consent,
        expectedVersion: null,
      })
    ).rejects.toMatchObject({ code: "denied" });
    expect(h.execute).not.toHaveBeenCalled();
    h.authenticate.mockResolvedValue(actor);
    const repository = createNotificationGrantRepository(h.db, {
      ...h.options,
      privilegedAuthorization: undefined,
    });
    await expect(
      repository.issueConsent(context, {
        value: consent,
        expectedVersion: null,
      })
    ).rejects.toMatchObject({ code: "denied" });
    expect(h.queries.every((query) => !query.sql.startsWith("insert"))).toBe(
      true
    );
    return expect(h.authorize).not.toHaveBeenCalled();
  });

  it("writes consent as a separate immutable kind with audited independent consent permission", async () => {
    const h = fixture();
    expect(
      await h.repository.issueConsent(context, {
        value: consent,
        expectedVersion: null,
      })
    ).toBe("recorded");
    expect(
      h.privileged.mock.calls.every(
        (call) => call[1].action === "issue-consent"
      )
    ).toBe(true);
    const insertion = h.queries.find((query) =>
      query.sql.startsWith("insert into notification_authority_versions")
    )!;
    expect(insertion.params.slice(0, 7)).toEqual([
      "tenant-1",
      "account-1",
      "research",
      "consent",
      "consent-1",
      "1",
      "granted",
    ]);
    expect(insertion.params).not.toContain("topic");
    return expect(
      h.queries.some((query) => query.sql.includes("notification_admissions"))
    ).toBe(false);
  });

  it("requires exact current consent before issuing a send grant", async () => {
    const h = fixture();
    await expect(
      h.repository.issueGrant(context, { value: grant, expectedVersion: null })
    ).rejects.toMatchObject({ code: "denied" });
    expect(h.queries.some((query) => query.sql.startsWith("insert"))).toBe(
      false
    );
    const consentRow = await record("consent", consent);
    const allowed = fixture((query) =>
      query.params.includes("consent") ? [consentRow] : []
    );
    return expect(
      await allowed.repository.issueGrant(context, {
        value: grant,
        expectedVersion: null,
      })
    ).toBe("recorded");
  });

  it("never falls back to an old consent when the current one is revoked or advanced", async () => {
    const grantRow = await record("grant", grant);
    for (const consentRow of [
      await record("consent", { ...consent, version: "2" }, "revoked"),
      await record("consent", { ...consent, version: "2" }),
      await record("consent", { ...consent, destinationRef: "different" }),
    ]) {
      const h = fixture(pair(grantRow, consentRow));
      expect(
        await h.repository.resolveCurrent(context, selection, signal())
      ).toBeNull();
      expect(
        h.queries.every(
          (query) =>
            !(query.sql.startsWith("insert") || query.sql.startsWith("update"))
        )
      ).toBe(true);
    }
  });

  it("resolves only exact tenant account channel purpose and immutable version", async () => {
    const h = fixture(
      pair(await record("grant", grant), await record("consent", consent))
    );
    expect(
      await h.repository.resolveCurrent(context, selection, signal())
    ).toEqual(grant);
    expect(h.queries[0]?.params).toEqual([
      "tenant-1",
      "account-1",
      "research",
      "grant",
      "grant-1",
    ]);
    expect(h.authorize.mock.calls[0]?.[1]).toMatchObject({
      operation: "resolve",
      principal: actor,
      binding,
    });
    return expect(
      await h.repository.resolveCurrent(
        context,
        { ...selection, version: "2" },
        signal()
      )
    ).toBeNull();
  });

  it("detects status tampering, expiring grants and denied read authorization", async () => {
    const grantRow = await record("grant", grant, "revoked");
    const corrupt = fixture(
      pair({ ...grantRow, status: "granted" }, await record("consent", consent))
    );
    await expect(
      corrupt.repository.resolveCurrent(context, selection, signal())
    ).rejects.toMatchObject({ code: "integrity" });
    const h = fixture(
      pair(await record("grant", grant), await record("consent", consent))
    );
    h.now.mockReturnValue(grant.expiresAt);
    expect(
      await h.repository.resolveCurrent(context, selection, signal())
    ).toBeNull();
    h.now.mockReturnValue(NOW);
    h.authorize.mockResolvedValue(false);
    return await expect(
      h.repository.resolveCurrent(context, selection, signal())
    ).rejects.toMatchObject({ code: "denied" });
  });

  it("appends revocation and CASes the current pointer without deleting history", async () => {
    const previous = await record("grant", grant);
    const h = fixture((query) => {
      if (query.sql.includes("notification_authority_current c"))
        return [previous];
      if (query.sql.startsWith("update notification_authority_current"))
        return [{ current_version: "2" }];
      return [];
    });
    expect(
      await h.repository.revokeGrant(context, {
        tenantKey: grant.tenantKey,
        accountAlias: grant.accountAlias,
        environment: grant.environment,
        id: grant.grantId,
        version: "2",
        expectedVersion: "1",
      })
    ).toBe("recorded");
    expect(
      h.privileged.mock.calls.every((call) => call[1].action === "revoke-grant")
    ).toBe(true);
    expect(
      h.queries.find((query) =>
        query.sql.startsWith("insert into notification_authority_versions")
      )?.params[6]
    ).toBe("revoked");
    expect(
      h.queries.find((query) =>
        query.sql.startsWith("update notification_authority_current")
      )?.params
    ).toEqual([
      "2",
      "tenant-1",
      "account-1",
      "research",
      "grant",
      "grant-1",
      "1",
    ]);
    return expect(
      h.queries.every(
        (query) =>
          !(
            query.sql.startsWith("delete") ||
            query.sql.startsWith("update notification_authority_versions")
          )
      )
    ).toBe(true);
  });

  it("rejects stale expected versions and cross-tenant mutation without writes", async () => {
    const h = fixture(
      pair(await record("grant", grant), await record("consent", consent))
    );
    await expect(
      h.repository.issueGrant(context, {
        value: { ...grant, version: "3" },
        expectedVersion: "2",
      })
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      h.repository.issueConsent(context, {
        value: { ...consent, tenantKey: "other" },
        expectedVersion: null,
      })
    ).rejects.toMatchObject({ code: "denied" });
    return expect(
      h.queries.some((query) => query.sql.startsWith("insert"))
    ).toBe(false);
  });

  return it("captures input before awaiting authentication and never invokes getters", async () => {
    const h = fixture();
    const mutable = { value: { ...consent }, expectedVersion: null };
    h.authenticate.mockImplementation(async () => {
      mutable.value.destinationRef = "mutated-destination";
      return actor;
    });
    await h.repository.issueConsent(context, mutable);
    expect(h.privileged.mock.calls[0]?.[1].value.destinationRef).toBe(
      "destination-1"
    );
    const getter = vi.fn(() => consent);
    const hostile = Object.defineProperty({ expectedVersion: null }, "value", {
      enumerable: true,
      get: getter,
    });
    await expect(
      h.repository.issueConsent(context, hostile as typeof mutable)
    ).rejects.toMatchObject({ code: "invalid" });
    return expect(getter).not.toHaveBeenCalled();
  });
});

describe("authorized neutral delivery read model", () => {
  it("reads the original admission ledger using account-scoped event key and no private content", async () => {
    const grantRow = await record("grant", grant);
    const h = fixture((query) => {
      if (query.sql.includes("from notification_authority_versions v"))
        return [grantRow];
      if (query.sql.includes("from notification_admissions"))
        return [
          {
            acceptance: "unknown",
            admitted_at_ms: NOW,
            expires_at_ms: NOW + 60_000,
            outcome_at_ms: NOW + 5,
          },
        ];
      return [];
    });
    const result = await h.deliveries.read(
      context,
      { ...selection, eventId: "event-1" },
      signal()
    );
    expect(result).toEqual({
      status: "unknown",
      admittedAt: NOW,
      expiresAt: NOW + 60_000,
      outcomeAt: NOW + 5,
      receipt: "unconfirmed",
      retryable: false,
    });
    expect(
      h.queries.find((query) =>
        query.sql.includes("from notification_admissions")
      )?.params
    ).toEqual([
      grant.tenantKey,
      grant.recipientKey,
      grant.channel,
      grant.purpose,
      await notificationEventKey(grant, "event-1"),
    ]);
    expect(
      h.authorize.mock.calls.every(
        (call) => call[1].operation === "delivery-read"
      )
    ).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(
      /destination|configuration|provider|recipient|account/
    );
    return expect(h.transaction.mock.calls[0]?.[1]).toEqual({
      isolationLevel: "repeatable read",
      accessMode: "read only",
    });
  });

  it("denies reads without independent current permission even for a known grant", async () => {
    const grantRow = await record("grant", grant);
    const h = fixture(() => [grantRow]);
    h.authorize.mockResolvedValue(false);
    await expect(
      h.deliveries.read(context, { ...selection, eventId: "event-1" }, signal())
    ).rejects.toMatchObject({ code: "denied" });
    return expect(
      h.queries.some((query) => query.sql.includes("notification_admissions"))
    ).toBe(false);
  });

  return it("does not interpret server acceptance as device delivery", async () => {
    const grantRow = await record("grant", grant);
    const h = fixture((query) =>
      query.sql.includes("from notification_admissions")
        ? [
            {
              acceptance: "accepted",
              admitted_at_ms: NOW,
              expires_at_ms: NOW + 60_000,
              outcome_at_ms: NOW + 1,
            },
          ]
        : [grantRow]
    );
    return expect(
      await h.deliveries.read(
        context,
        { ...selection, eventId: "event-1" },
        signal()
      )
    ).toMatchObject({
      status: "accepted",
      receipt: "unconfirmed",
      retryable: false,
    });
  });
});
