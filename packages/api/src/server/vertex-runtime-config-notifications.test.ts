import type { SafePrincipal } from "@darkfactory/auth/types";
import type { Database } from "@darkfactory/db/server";
import type { WorkerServiceIdentity } from "@darkfactory/db/server/vertex-worker";
import {
  hashArtifact,
  timestampToEpochNanoseconds,
} from "@darkfactory/shared/vertex";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import {
  buildVertexRuntimeConfiguredNotifications,
  type VertexRuntimeServerContext,
  type VertexRuntimeWorkerBindings,
} from "./vertex-runtime-config-notifications.ts";
import { VertexRuntimeNotificationsConfigurationSchema } from "./vertex-runtime-config-notifications-schema.ts";
import type { VertexRuntimeNotificationsConfiguration } from "./vertex-runtime-config-notifications-schema.ts";

// Authored only. All identities/bindings/rows below are synthetic local fixtures;
// these cases perform no actual DB, consent, grant mutation or notification send.
const NOW = "2026-09-22T12:00:00.000Z";
const clock = { now: () => NOW };
const principal: SafePrincipal = {
  userId: "member-1",
  role: "member",
  status: "active",
};
const actor = { actorId: principal.userId, tenantKey: "tenant-1" };
const session = { kind: "session" as const, ...actor };
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
const base = (): VertexRuntimeNotificationsConfiguration => ({
  enabled: false,
  timeoutMs: 1000,
  sessions: [actor],
  workers: [],
  permissions: [{ principal: session, binding, operations: ["delivery-read"] }],
  sendGrants: [],
  administration: [],
  admissions: [],
  configuration: null,
  dispatcher: null,
});
const fixture = (
  configuration = base(),
  bindings: VertexRuntimeWorkerBindings = {}
) => {
  const execute = vi.fn(
    async (_query: SQL): Promise<{ rows: Record<string, unknown>[] }> => ({
      rows: [],
    })
  );
  const transaction = vi.fn(async () => {
    throw new Error("Unexpected transaction");
  });
  const db = { execute, transaction } as unknown as Database;
  const serverPrincipal = vi.fn(
    async (): Promise<SafePrincipal | null> => principal
  );
  const controller = new AbortController();
  const fetcher = vi.fn(async (): Promise<Response> => {
    throw new Error("No provider request permitted");
  });
  const build = () =>
    buildVertexRuntimeConfiguredNotifications({
      configuration,
      bindings,
      db,
      serverPrincipal,
      clock,
      signal: controller.signal,
      fetcher,
    });
  return { execute, transaction, serverPrincipal, controller, fetcher, build };
};
const request = {
  principal: actor,
  scope: {
    accountAlias: binding.accountAlias,
    environment: binding.environment,
  },
  operation: "delivery-read" as const,
  purpose: binding.purpose,
  binding,
};
const phone = (): VertexRuntimeNotificationsConfiguration => ({
  ...base(),
  enabled: true,
  permissions: [{ principal: session, binding, operations: ["resolve"] }],
  sendGrants: [
    {
      principal: session,
      binding,
      grantId: "grant-1",
      version: "1",
      consentId: "consent-1",
      consentVersion: "1",
      configurationRef: "config-1",
    },
  ],
  configuration: {
    enabled: true,
    allowedNtfyOrigins: ["https://notify.example.test"],
    registrations: [
      {
        provider: "ntfy",
        binding,
        configurationRef: "config-1",
        enabled: true,
        expiresAt: Date.parse(NOW) + 60_000,
        origin: "https://notify.example.test",
        destinationBinding: "VERTEX_NOTIFICATION_PHONE_DESTINATION",
        credentialBinding: "VERTEX_NOTIFICATION_PHONE_TOKEN",
      },
    ],
  },
});

describe("runtime notification config bridge", () => {
  it("is inert and keeps missing provider configuration null with independent historical read permissions", async () => {
    const h = fixture();
    const configured = h.build();
    expect(configured.configuration).toBeNull();
    expect(configured.enabled).toBe(false);
    expect(configured.dispatcher).toBeUndefined();
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.serverPrincipal).not.toHaveBeenCalled();
    expect(configured.fetcher).toBe(h.fetcher);
    expect(h.fetcher).not.toHaveBeenCalled();
    const context = await configured.serverContext(principal);
    expect(context).not.toBeNull();
    expect(context).toEqual({ kind: "session" });
    expect(await configured.authority.authenticate(context!)).toEqual(actor);
    expect(await configured.authority.authorize(context!, request)).toBe(true);
    expect(
      await configured.authority.authorize(context!, {
        ...request,
        operation: "resolve",
      })
    ).toBe(false);
    expect(
      await configured.authority.authorize(context!, {
        ...request,
        binding: { ...binding, recipientKey: "other" },
      })
    ).toBe(false);
    return expect(h.execute).not.toHaveBeenCalled();
  });

  it("rejects forged context shapes even if they name a configured actor or grant", async () => {
    const h = fixture();
    const configured = h.build();
    for (const value of [
      { kind: "session" },
      { kind: "worker" },
      { ...actor, kind: "session" },
      { kind: "worker", grantId: "grant-1" },
    ]) {
      expect(
        await configured.authority.authenticate(
          value as VertexRuntimeServerContext
        )
      ).toBeNull();
      expect(
        await configured.authority.authorize(
          value as VertexRuntimeServerContext,
          request
        )
      ).toBe(false);
    }
    expect(h.serverPrincipal).not.toHaveBeenCalled();
    return expect(h.execute).not.toHaveBeenCalled();
  });

  it("reauthenticates the actual request session on every use and observes revocation or identity change", async () => {
    const h = fixture();
    const configured = h.build();
    expect(
      await configured.serverContext({ ...principal, userId: "other" })
    ).toBeNull();
    const context = await configured.serverContext(principal);
    h.serverPrincipal.mockResolvedValueOnce(null);
    expect(await configured.authority.authenticate(context!)).toBeNull();
    h.serverPrincipal.mockResolvedValueOnce({ ...principal, userId: "other" });
    expect(await configured.authority.authorize(context!, request)).toBe(false);
    h.serverPrincipal.mockRejectedValueOnce(
      new Error("private session detail")
    );
    expect(await configured.authority.authenticate(context!)).toBeNull();
    h.controller.abort();
    return expect(await configured.authority.authenticate(context!)).toBeNull();
  });

  it("requires exact independent consent/admin value hash, version and expected-version CAS", async () => {
    const value = {
      ...binding,
      consentId: "consent-1",
      version: "2",
      validFrom: Date.parse(NOW),
      expiresAt: Date.parse(NOW) + 30_000,
    };
    const config = base();
    config.administration.push({
      ...actor,
      action: "issue-consent",
      binding,
      authorityId: "consent-1",
      version: "2",
      expectedVersion: "1",
      valueSha256: await hashArtifact(value),
      expiresAt: Date.parse(NOW) + 60_000,
    });
    const h = fixture(config);
    const configured = h.build();
    const context = await configured.serverContext(principal);
    const authorize = configured.authority.privilegedAuthorization!.authorize;
    const proposal = {
      principal: actor,
      action: "issue-consent" as const,
      value,
      expectedVersion: "1",
    };
    expect(await authorize(context!, proposal)).toBe(true);
    expect(
      await authorize(context!, { ...proposal, expectedVersion: null })
    ).toBe(false);
    expect(
      await authorize(context!, {
        ...proposal,
        value: { ...value, version: "3" },
      })
    ).toBe(false);
    expect(
      await authorize(context!, {
        ...proposal,
        value: { ...value, destinationRef: "other" },
      })
    ).toBe(false);
    expect(await authorize({ kind: "session" }, proposal)).toBe(false);
    expect(h.execute).not.toHaveBeenCalled();
    return expect(h.transaction).not.toHaveBeenCalled();
  });

  it("keeps admission/observation/outcome permissions independent and requires a minted current context", async () => {
    const config = base();
    config.admissions.push({
      principal: session,
      binding,
      operations: ["observe"],
    });
    const h = fixture(config);
    const configured = h.build();
    const scope = {
      tenantKey: binding.tenantKey,
      recipientKey: binding.recipientKey,
      channel: binding.channel,
      purpose: binding.purpose,
    };
    expect(await configured.admissionAuthorization(scope, "observe")).toBe(
      false
    );
    await configured.serverContext(principal);
    expect(await configured.admissionAuthorization(scope, "observe")).toBe(
      true
    );
    expect(await configured.admissionAuthorization(scope, "admit")).toBe(false);
    expect(
      await configured.admissionAuthorization(scope, "record-outcome")
    ).toBe(false);
    h.serverPrincipal.mockResolvedValue(null);
    return expect(
      await configured.admissionAuthorization(scope, "observe")
    ).toBe(false);
  });

  it("rejects raw destinations, unknown binding names and duplicate route pairs while permitting terminal route pairs", () => {
    const config = phone();
    expect(
      VertexRuntimeNotificationsConfigurationSchema.safeParse(config).success
    ).toBe(true);
    expect(
      VertexRuntimeNotificationsConfigurationSchema.safeParse({
        ...config,
        topic: "synthetic-topic",
      }).success
    ).toBe(false);
    const changed = structuredClone(config);
    Object.assign(changed.configuration!.registrations[0]!, {
      destinationBinding: "ARBITRARY_PRIVATE_ENV",
    });
    expect(
      VertexRuntimeNotificationsConfigurationSchema.safeParse(changed).success
    ).toBe(false);
    const completed = {
      eventType: "agent.recorded",
      kind: "research-completed" as const,
      ttlMilliseconds: 1000,
    };
    const failed = { ...completed, kind: "research-failed" as const };
    expect(
      VertexRuntimeNotificationsConfigurationSchema.safeParse({
        ...base(),
        dispatcher: { dryRun: true, routes: [completed, failed] },
      }).success
    ).toBe(true);
    return expect(
      VertexRuntimeNotificationsConfigurationSchema.safeParse({
        ...base(),
        dispatcher: { dryRun: true, routes: [completed, completed] },
      }).success
    ).toBe(false);
  });

  it("rejects cross-account reuse of the durable admission four-part scope", () => {
    const config = base();
    config.admissions.push({
      principal: session,
      binding: { ...binding, accountAlias: "different-account" },
      operations: ["admit"],
    });
    expect(
      VertexRuntimeNotificationsConfigurationSchema.safeParse(config).success
    ).toBe(false);
    config.admissions = [
      {
        principal: session,
        binding: { ...binding, environment: "paper" },
        operations: ["observe"],
      },
    ];
    return expect(
      VertexRuntimeNotificationsConfigurationSchema.safeParse(config).success
    ).toBe(false);
  });

  it("uses only explicit referenced Worker values and does not execute binding accessors or disclose errors", async () => {
    const getter = vi.fn(() => "synthetic-topic");
    const bindings = { VERTEX_NOTIFICATION_PHONE_TOKEN: "synthetic-token" };
    Object.defineProperty(bindings, "VERTEX_NOTIFICATION_PHONE_DESTINATION", {
      enumerable: true,
      get: getter,
    });
    expect(() => fixture(phone(), bindings).build()).toThrow(
      "Invalid Vertex notification configuration"
    );
    expect(getter).not.toHaveBeenCalled();
    expect(() =>
      fixture(phone(), {
        VERTEX_NOTIFICATION_PHONE_DESTINATION: "invalid/private/value",
        VERTEX_NOTIFICATION_PHONE_TOKEN: "synthetic-token",
      }).build()
    ).not.toThrow("invalid/private/value");
    const h = fixture(phone(), {
      VERTEX_NOTIFICATION_PHONE_DESTINATION: "synthetic-topic",
      VERTEX_NOTIFICATION_PHONE_TOKEN: "synthetic-token",
    });
    const configured = h.build();
    const context = await configured.serverContext(principal);
    const signal = new AbortController().signal;
    expect(
      await configured.configuration!.resolveDestination(
        { kind: "session" },
        "destination-1",
        signal
      )
    ).toBeNull();
    expect(
      await configured.configuration!.resolveDestination(
        context!,
        "unknown-ref",
        signal
      )
    ).toBeNull();
    expect(
      await configured.configuration!.resolveDestination(
        context!,
        "destination-1",
        signal
      )
    ).toBe("synthetic-topic");
    expect(
      await configured.configuration!.resolveCredential!(
        context!,
        "config-1",
        signal
      )
    ).toBe("synthetic-token");
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.transaction).not.toHaveBeenCalled();
    return expect(h.fetcher).not.toHaveBeenCalled();
  });

  it("preserves the actual typed in-process email sender without invoking it", async () => {
    const emailBinding = { ...binding, channel: "email" as const };
    const config = base();
    config.enabled = true;
    config.permissions = [
      { principal: session, binding: emailBinding, operations: ["resolve"] },
    ];
    config.sendGrants = [
      {
        principal: session,
        binding: emailBinding,
        grantId: "grant-1",
        version: "1",
        consentId: "consent-1",
        consentVersion: "1",
        configurationRef: "config-1",
      },
    ];
    config.configuration = {
      enabled: true,
      allowedNtfyOrigins: [],
      registrations: [
        {
          provider: "email",
          binding: emailBinding,
          configurationRef: "config-1",
          enabled: true,
          expiresAt: Date.parse(NOW) + 60_000,
          destinationBinding: "VERTEX_NOTIFICATION_EMAIL_DESTINATION",
          emailPortBinding: "VERTEX_NOTIFICATION_EMAIL_PORT",
        },
      ],
    };
    const send = vi.fn(async () => ({ acceptance: "not-sent" as const }));
    const supplied = Object.freeze({ availability: "ready" as const, send });
    const h = fixture(config, {
      VERTEX_NOTIFICATION_EMAIL_DESTINATION: "fixture@example.test",
      VERTEX_NOTIFICATION_EMAIL_PORT: supplied,
    });
    const configured = h.build();
    const context = await configured.serverContext(principal);
    const resolved = await configured.configuration!.resolveEmailPort!(
      context!,
      "config-1",
      new AbortController().signal
    );
    expect(resolved?.send).toBe(supplied.send);
    expect(resolved?.availability).toBe("ready");
    expect(send).not.toHaveBeenCalled();
    return expect(h.fetcher).not.toHaveBeenCalled();
  });

  it("retains original server-only worker identity and rechecks exact current DB grant before each use", async () => {
    const grant = {
      grantId: "worker-grant-1",
      servicePrincipalId: "worker-1",
      accountAlias: binding.accountAlias,
      environment: binding.environment,
      operations: ["claim"],
      issuedAt: "2026-09-22T11:59:00.000Z",
      expiresAt: "2026-09-22T12:01:00.000Z",
      revokedAt: null,
    };
    const hash = await hashArtifact(grant);
    const worker = {
      kind: "worker" as const,
      actorId: grant.servicePrincipalId,
      tenantKey: binding.tenantKey,
      grantId: grant.grantId,
      accountAlias: binding.accountAlias,
      environment: binding.environment,
    };
    const config = base();
    config.workers.push({
      actorId: worker.actorId,
      tenantKey: worker.tenantKey,
      grantId: worker.grantId,
      accountAlias: worker.accountAlias,
      environment: worker.environment,
      grantSha256: hash,
    });
    config.permissions.push({
      principal: worker,
      binding,
      operations: ["delivery-read"],
    });
    config.dispatcher = { dryRun: true, routes: [] };
    const h = fixture(config);
    const configured = h.build();
    const row: Record<string, unknown> = {
      grant_id: grant.grantId,
      service_principal_id: grant.servicePrincipalId,
      account_alias: grant.accountAlias,
      environment: grant.environment,
      issued_at_ns: timestampToEpochNanoseconds(grant.issuedAt).toString(),
      expires_at_ns: timestampToEpochNanoseconds(grant.expiresAt).toString(),
      revoked_at: null,
      record_hash: hash,
      payload: grant,
    };
    h.execute.mockResolvedValue({ rows: [row] });
    const identity: WorkerServiceIdentity = Object.freeze({
      grantId: grant.grantId,
      servicePrincipalId: grant.servicePrincipalId,
      scope: {
        accountAlias: grant.accountAlias,
        environment: grant.environment,
      },
      expiresAt: grant.expiresAt,
    });
    // Simulate only the trusted server dispatcher port; this is not an RPC or
    // proof that a fabricated identity authenticates at the worker-store gate.
    const context = configured.dispatcher!.contextFor(identity, {
      scope: identity.scope,
      leaseExpiresAt: "2026-09-22T12:00:30.000Z",
    } as Parameters<
      NonNullable<typeof configured.dispatcher>["contextFor"]
    >[1]);
    expect(h.execute).not.toHaveBeenCalled();
    expect(await configured.authority.authenticate(context)).toEqual({
      actorId: worker.actorId,
      tenantKey: worker.tenantKey,
    });
    expect(h.execute).toHaveBeenCalledTimes(1);
    const dialect = new PgDialect();
    const query = dialect.sqlToQuery(h.execute.mock.calls[0]![0]);
    expect(query.params).toEqual([
      binding.accountAlias,
      binding.environment,
      grant.grantId,
    ]);
    expect(query.sql).not.toContain("credential_digest");
    row["revoked_at"] = NOW;
    expect(await configured.authority.authenticate(context)).toBeNull();
    row["revoked_at"] = null;
    row["record_hash"] = "b".repeat(64);
    expect(await configured.authority.authenticate(context)).toBeNull();
    return expect(h.serverPrincipal).not.toHaveBeenCalled();
  });

  return it("captures immutable configuration so caller mutation cannot widen an already built authority", async () => {
    const config = base();
    const h = fixture(config);
    const configured = h.build();
    const context = await configured.serverContext(principal);
    config.permissions[0]!.operations.push("resolve");
    return expect(
      await configured.authority.authorize(context!, {
        ...request,
        operation: "resolve",
      })
    ).toBe(false);
  });
});
