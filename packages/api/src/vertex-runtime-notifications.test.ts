import type { SafePrincipal } from "@darkfactory/auth/types";
import type { Database } from "@darkfactory/db/server";
import type { NotificationAuthorityAuthorization } from "@darkfactory/db/server/vertex";
import {
  notificationBinding,
  type NotificationRecipientGrant,
} from "@darkfactory/notifications/server/dispatch";
import { hashArtifact } from "@darkfactory/shared/vertex";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import { createVertexRuntimeNotifications } from "./server/vertex-runtime-notifications.ts";

// Authored, deliberately unexecuted. Uses the concrete composition and real SQL
// delivery-read implementation, but a captured in-memory SQL executor. No live
// DB, authority mutation, provider request or notification configuration occurs.
const NOW = 1_700_000_000_000;
const principal: SafePrincipal = {
  userId: "member-1",
  role: "member",
  status: "active",
};
const actor = { actorId: "member-1", tenantKey: "tenant-1" };
const context = { trustedSession: "session-1" };
const grant: NotificationRecipientGrant = {
  tenantKey: actor.tenantKey,
  accountAlias: "account-1",
  environment: "research",
  recipientKey: "recipient-1",
  recipientRef: "recipient-ref-1",
  channel: "phone",
  purpose: "research-update",
  destinationRef: "destination-1",
  grantId: "grant-1",
  version: "1",
  consentId: "consent-1",
  consentVersion: "1",
  configurationRef: "provider-1",
  templateVersion: "vertex-notification-v1",
  validFrom: NOW - 2000,
  expiresAt: NOW - 1000,
  cooldownMs: 1000,
};
const input = {
  accountAlias: grant.accountAlias,
  environment: grant.environment,
  grantId: grant.grantId,
  version: grant.version,
  eventId: "event-1",
};
const admission = {
  acceptance: "accepted",
  admitted_at_ms: NOW - 1500,
  expires_at_ms: NOW - 1000,
  outcome_at_ms: NOW - 1499,
};
const grantRow = async () => ({
  tenant_key: grant.tenantKey,
  account_alias: grant.accountAlias,
  environment: grant.environment,
  record_kind: "grant",
  authority_id: grant.grantId,
  version: grant.version,
  status: "revoked",
  recipient_key: grant.recipientKey,
  channel: grant.channel,
  purpose: grant.purpose,
  binding_hash: await hashArtifact(notificationBinding(grant)),
  payload_hash: await hashArtifact({
    kind: "grant",
    status: "revoked",
    value: grant,
    recordedBy: actor.actorId,
    recordedAt: NOW - 1000,
  }),
  request_hash: "a".repeat(64),
  payload: grant,
  recorded_by: actor.actorId,
  recorded_at_ms: NOW - 1000,
  valid_from_ms: grant.validFrom,
  expires_at_ms: grant.expiresAt,
});
type Query = Readonly<{ sql: string; params: unknown[] }>;
const fixture = async (hasAdmission = true) => {
  const historical = await grantRow();
  const order: string[] = [];
  const queries: Query[] = [];
  const dialect = new PgDialect();
  const execute = vi.fn(async (sql: SQL) => {
    const query = dialect.sqlToQuery(sql);
    queries.push(query);
    if (query.sql.includes("from notification_authority_versions")) {
      order.push("historical-grant");
      return { rows: [historical] };
    }
    if (query.sql.includes("from notification_admissions")) {
      order.push("original-ledger");
      return { rows: hasAdmission ? [admission] : [] };
    }
    throw new Error("Unexpected SQL in notification read fixture");
  });
  const transaction = vi.fn(
    async (
      work: (tx: { execute: typeof execute }) => Promise<unknown>,
      _mode?: unknown
    ) => work({ execute })
  );
  const db = { execute, transaction } as unknown as Database;
  const authenticate = vi.fn(async (_context: typeof context) => actor);
  const authorize = vi.fn(
    async (
      _context: typeof context,
      request: NotificationAuthorityAuthorization
    ) => {
      order.push(request.operation);
      return request.operation === "delivery-read";
    }
  );
  const admissionAuthorization = vi.fn(async () => false);
  const serverContext = vi.fn(
    async (_principal: SafePrincipal): Promise<typeof context | null> => context
  );
  const fetcher = vi.fn(async () => {
    throw new Error("No provider request permitted");
  });
  const options = {
    db,
    clock: { now: () => NOW },
    authority: { authenticate, authorize },
    admissionAuthorization,
    configuration: null,
    serverContext,
    enabled: true,
    fetcher,
  };
  const runtime = createVertexRuntimeNotifications(options);
  return {
    historical,
    order,
    queries,
    execute,
    transaction,
    authenticate,
    authorize,
    admissionAuthorization,
    serverContext,
    fetcher,
    options,
    runtime,
  };
};

describe("concrete runtime notification composition", () => {
  it("performs no construction I/O and remains honestly disabled with null configuration even if enabled", async () => {
    const h = await fixture();
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.authenticate).not.toHaveBeenCalled();
    expect(h.serverContext).not.toHaveBeenCalled();
    expect(h.fetcher).not.toHaveBeenCalled();
    expect(Object.isFrozen(h.runtime)).toBe(true);
    const result = await h.runtime.dispatch.handle(
      context,
      {},
      { dryRun: false, signal: new AbortController().signal }
    );
    expect(result).toMatchObject({
      reason: "disabled",
      retryable: false,
      results: [],
    });
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.authenticate).not.toHaveBeenCalled();
    expect(h.admissionAuthorization).not.toHaveBeenCalled();
    expect(h.fetcher).not.toHaveBeenCalled();
    expect(typeof h.runtime.grants.issueConsent).toBe("function");
    expect(typeof h.runtime.grants.issueGrant).toBe("function");
    return expect(typeof h.runtime.grants.revokeGrant).toBe("function");
  });

  it("reads the original SQL ledger after send grant revocation/expiry with independent current permission", async () => {
    const h = await fixture();
    const result = await h.runtime.vertexNotificationRead.delivery(
      principal,
      input
    );
    expect(result).toEqual({
      status: "accepted",
      admittedAt: admission.admitted_at_ms,
      expiresAt: admission.expires_at_ms,
      outcomeAt: admission.outcome_at_ms,
      receipt: "unconfirmed",
      retryable: false,
    });
    expect(h.order).toEqual([
      "historical-grant",
      "delivery-read",
      "original-ledger",
      "delivery-read",
    ]);
    expect(h.serverContext).toHaveBeenCalledWith(principal);
    expect(h.authenticate).toHaveBeenCalledWith(context);
    expect(h.transaction.mock.calls[0]?.[1]).toEqual({
      isolationLevel: "repeatable read",
      accessMode: "read only",
    });
    expect(h.queries[0]?.params).toEqual([
      actor.tenantKey,
      grant.accountAlias,
      grant.environment,
      grant.grantId,
      grant.version,
    ]);
    expect(h.queries[1]?.params.slice(0, 4)).toEqual([
      actor.tenantKey,
      grant.recipientKey,
      grant.channel,
      grant.purpose,
    ]);
    expect(h.queries.every((query) => query.sql.startsWith("select"))).toBe(
      true
    );
    expect(
      h.queries.every(
        (query) => !query.sql.includes("notification_authority_current")
      )
    ).toBe(true);
    expect(h.admissionAuthorization).not.toHaveBeenCalled();
    return expect(h.fetcher).not.toHaveBeenCalled();
  });

  it("requires delivery-read permission before selecting admission even when a historical grant exists", async () => {
    const h = await fixture();
    h.authorize.mockResolvedValueOnce(false);
    await expect(
      h.runtime.vertexNotificationRead.delivery(principal, input)
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(
      h.queries.some((query) => query.sql.includes("notification_admissions"))
    ).toBe(false);
    return expect(h.fetcher).not.toHaveBeenCalled();
  });

  it("discards selected ledger status if current permission is revoked before return", async () => {
    const h = await fixture();
    h.authorize.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await expect(
      h.runtime.vertexNotificationRead.delivery(principal, input)
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(
      h.queries.filter((query) => query.sql.includes("notification_admissions"))
    ).toHaveLength(1);
    expect(h.authorize).toHaveBeenCalledTimes(2);
    return expect(h.fetcher).not.toHaveBeenCalled();
  });

  it("returns neutral historical absence only after both current permission checks", async () => {
    const h = await fixture(false);
    expect(
      await h.runtime.vertexNotificationRead.delivery(principal, input)
    ).toEqual({
      status: "not-found",
      receipt: "unconfirmed",
      retryable: false,
    });
    return expect(h.order).toEqual([
      "historical-grant",
      "delivery-read",
      "original-ledger",
      "delivery-read",
    ]);
  });

  it("does not invent context or administrative authority when configuration is missing", async () => {
    const h = await fixture();
    h.serverContext.mockResolvedValueOnce(null);
    await expect(
      h.runtime.vertexNotificationRead.delivery(principal, input)
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(h.execute).not.toHaveBeenCalled();
    const consent = {
      ...notificationBinding(grant),
      consentId: "consent-1",
      version: "1",
      validFrom: NOW,
      expiresAt: NOW + 1000,
    };
    // The grant store serializes on its scope lock and reads current authority
    // before its privilege check (notification-grant-store.test.ts). Without a
    // configured privileged authorizer it must deny and write nothing.
    const dialect = new PgDialect();
    h.execute.mockImplementation(async (statement: SQL) => {
      const query = dialect.sqlToQuery(statement);
      h.queries.push(query);
      if (
        query.sql.startsWith("select pg_advisory_xact_lock") ||
        query.sql.includes("from notification_authority_current")
      )
        return { rows: [] };
      throw new Error("Unexpected SQL in notification authority fixture");
    });
    await expect(
      h.runtime.grants.issueConsent(context, {
        value: consent,
        expectedVersion: null,
      })
    ).rejects.toMatchObject({ code: "denied" });
    expect(
      h.queries.every((query) => !query.sql.trimStart().startsWith("insert"))
    ).toBe(true);
    return expect(h.fetcher).not.toHaveBeenCalled();
  });

  it("normalizes SQL failures and rejects corrupted historical authority before ledger access", async () => {
    const h = await fixture();
    h.historical.payload_hash = "b".repeat(64);
    await expect(
      h.runtime.vertexNotificationRead.delivery(principal, input)
    ).rejects.toMatchObject({ code: "INVALID_SOURCE" });
    expect(
      h.queries.some((query) => query.sql.includes("notification_admissions"))
    ).toBe(false);
    h.execute.mockRejectedValueOnce(new Error("private SQL detail"));
    const work = h.runtime.vertexNotificationRead.delivery(principal, input);
    await expect(work).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
    return await expect(work).rejects.not.toThrow("private SQL detail");
  });
});
