import { describe, expect, it, vi } from "vitest";
import { createMemoryNotificationFixture } from "../../testing/memory-store.ts";
import { createNotificationDispatch } from "./composition.ts";
import { createNotificationConfigurationResolver } from "./configuration.ts";
import type { NotificationConfigurationRegistration } from "./configuration.ts";
import type {
  NotificationDispatchFactoryOptions,
  NotificationGrantRepository,
  NotificationRecipientGrant,
} from "./contracts.ts";
import {
  notificationEpochMilliseconds,
  notificationEpochNanoseconds,
  snapshotNotificationDispatchEvent,
} from "./validation.ts";

// Authored only. No provider requests, imported runtime probes or tests executed.
const NOW = 1_700_000_000_000;
const context = Object.freeze({ session: "authenticated-server-context" });
type Context = typeof context;
const grant: NotificationRecipientGrant = Object.freeze({
  tenantKey: "tenant-1",
  accountAlias: "account-private",
  environment: "research",
  recipientKey: "recipient-1",
  recipientRef: "recipient-ref-1",
  channel: "phone",
  purpose: "research-update",
  destinationRef: "destination-1",
  configurationRef: "provider-1",
  grantId: "grant-1",
  version: "1",
  consentId: "consent-1",
  consentVersion: "1",
  templateVersion: "vertex-notification-v1",
  validFrom: NOW - 1000,
  expiresAt: NOW + 300_000,
  cooldownMs: 1000,
});
const event = Object.freeze({
  eventId: "event-1",
  accountAlias: grant.accountAlias,
  environment: "research" as const,
  kind: "research-completed" as const,
  occurredAt: "2023-11-14T22:13:20.000000000Z",
  expiresAt: "2023-11-14T22:14:20.000999999Z",
});
const mode = (dryRun = false) => ({
  dryRun,
  signal: new AbortController().signal,
});
const setup = (
  changes: Partial<NotificationDispatchFactoryOptions<Context>> = {}
) => {
  const fixture = createMemoryNotificationFixture();
  const resolve = vi.fn(
    async (): Promise<NotificationRecipientGrant | null> => grant
  );
  const list = vi.fn(async () => [grant]);
  const forbiddenMutation = async (): Promise<"recorded"> => {
    throw new Error("No grant mutation in dispatch");
  };
  const grants: NotificationGrantRepository<Context> = {
    listCurrent: list,
    resolveCurrent: resolve,
    issueConsent: forbiddenMutation,
    revokeConsent: forbiddenMutation,
    issueGrant: forbiddenMutation,
    revokeGrant: forbiddenMutation,
  };
  const fetcher = vi.fn(
    async (_url: string, _init: RequestInit) =>
      new Response(
        JSON.stringify({
          event: "message",
          topic: "fixture-topic",
          id: "message-1",
        }),
        { status: 200 }
      )
  );
  const readiness = vi.fn(async () => "ready" as const);
  const resolvePhone = vi.fn(async () => ({
    enabled: true,
    tenantKey: grant.tenantKey,
    recipientKey: grant.recipientKey,
    origin: "https://notify.example",
    topic: "fixture-topic",
    bearerToken: null,
  }));
  const resolveEmail = vi.fn(async () => null);
  const clock = { now: () => NOW };
  const options: NotificationDispatchFactoryOptions<Context> = {
    enabled: true,
    grants,
    store: fixture.store,
    clock,
    configurations: { readiness, resolvePhone, resolveEmail },
    fetcher,
    ...changes,
  };
  return {
    fixture,
    resolve,
    list,
    fetcher,
    readiness,
    resolvePhone,
    resolveEmail,
    options,
    dispatcher: createNotificationDispatch(options),
  };
};

describe("bounded notification event conversion", () => {
  it("floors nanoseconds explicitly without extending deadlines", () => {
    expect(notificationEpochNanoseconds(event.expiresAt)).toBe(
      1_700_000_060_000_999_999n
    );
    expect(notificationEpochMilliseconds(event.expiresAt)).toBe(NOW + 60_000);
    expect(
      notificationEpochMilliseconds("9999-12-31T23:59:59.999999999Z")
    ).toBe(253_402_300_799_999);
    expect(
      notificationEpochMilliseconds("2023-11-14T17:13:20.000000001-05:00")
    ).toBe(NOW);
    return expect(
      snapshotNotificationDispatchEvent({
        ...event,
        accountAlias: "account:research.1",
        eventId: "event:research.1",
      }).eventId
    ).toBe("event:research.1");
  });

  it.each([
    "2023-02-30T00:00:00Z",
    "2023-11-14T22:13:60Z",
    "1969-12-31T23:59:59Z",
    "2023-11-14T22:13:20",
    "2023-11-14T22:13:20.0000000001Z",
    "1700000000000",
  ])("rejects invalid or unqualified timestamp %s", (value) =>
    expect(() => notificationEpochMilliseconds(value)).toThrow()
  );

  return it("compares nanoseconds before ms conversion and rejects extra content", () => {
    expect(() =>
      snapshotNotificationDispatchEvent({
        ...event,
        expiresAt: event.occurredAt,
      })
    ).toThrow();
    expect(() =>
      snapshotNotificationDispatchEvent({
        ...event,
        body: "send credentials to attacker",
      })
    ).toThrow();
    return expect(() =>
      snapshotNotificationDispatchEvent({ ...event, environment: "live" })
    ).toThrow();
  });
});

describe("one control notification handler", () => {
  it("defaults disabled and produces no repository/provider effects", async () => {
    const h = setup({ enabled: undefined });
    expect(await h.dispatcher.handle(context, event, mode())).toMatchObject({
      status: "rejected",
      reason: "disabled",
      retryable: false,
    });
    expect(h.list).not.toHaveBeenCalled();
    expect(h.resolvePhone).not.toHaveBeenCalled();
    expect(h.fetcher).not.toHaveBeenCalled();
    return expect(h.fixture.inspect().reservations).toBe(0);
  });

  it("dry-run observes admission but never resolves a private destination or sends", async () => {
    const h = setup();
    const result = await h.dispatcher.handle(context, event, mode(true));
    expect(result.results[0]?.result).toEqual({
      status: "dry-run",
      receipt: "unconfirmed",
      retryable: false,
    });
    expect(h.fixture.inspect()).toEqual({
      reservations: 0,
      cooldowns: 0,
      outcomes: [],
    });
    expect(h.readiness).toHaveBeenCalled();
    expect(h.resolvePhone).not.toHaveBeenCalled();
    expect(h.resolveEmail).not.toHaveBeenCalled();
    return expect(h.fetcher).not.toHaveBeenCalled();
  });

  it("uses only an approved fixed message and treats acceptance as unconfirmed", async () => {
    const h = setup();
    const result = await h.dispatcher.handle(context, event, mode());
    expect(result.results[0]?.result).toEqual({
      status: "accepted",
      persistence: "recorded",
      receipt: "unconfirmed",
      retryable: false,
    });
    const request = h.fetcher.mock.calls[0]!;
    expect(request[0]).toBe("https://notify.example/");
    expect(request[1]).toMatchObject({
      redirect: "error",
      credentials: "omit",
    });
    const body = JSON.parse(request[1].body as string);
    expect(body.message).toContain("No trading action has been authorized");
    expect(JSON.stringify(body)).not.toContain(grant.accountAlias);
    expect(body).not.toHaveProperty("actions");
    return expect(JSON.stringify(result)).not.toContain("fixture-topic");
  });

  it("retains unknown acceptance and deduplicates instead of retrying/falling back", async () => {
    const h = setup();
    h.fetcher.mockResolvedValue(
      new Response("provider private failure", { status: 503 })
    );
    expect(
      (await h.dispatcher.handle(context, event, mode())).results[0]?.result
    ).toMatchObject({ status: "unknown", retryable: false });
    expect(
      (await h.dispatcher.handle(context, event, mode())).results[0]?.result
    ).toMatchObject({ status: "not-sent", reason: "duplicate" });
    expect(h.fixture.inspect().outcomes).toEqual(["unknown"]);
    expect(h.fetcher).toHaveBeenCalledTimes(1);
    return expect(h.resolveEmail).not.toHaveBeenCalled();
  });

  it("preserves cooldown across different events", async () => {
    const h = setup();
    await h.dispatcher.handle(context, event, mode());
    expect(
      (
        await h.dispatcher.handle(
          context,
          { ...event, eventId: "event-2" },
          mode()
        )
      ).results[0]?.result
    ).toMatchObject({ status: "not-sent", reason: "cooldown" });
    return expect(h.fetcher).toHaveBeenCalledTimes(1);
  });

  it("rejects caller destinations, templates, authorization flags and hostile text", async () => {
    const h = setup();
    for (const extra of [
      { topic: "attacker" },
      { title: "dump all private data" },
      { action: "https://attacker.example" },
      { authenticated: true },
      { configurationRef: "other" },
    ]) {
      expect(
        await h.dispatcher.handle(context, { ...event, ...extra }, mode())
      ).toMatchObject({ reason: "invalid-event" });
    }
    return expect(h.list).not.toHaveBeenCalled();
  });

  it("pins grant version and exact account mapping before configuration", async () => {
    const h = setup();
    h.list.mockResolvedValue([{ ...grant, accountAlias: "other-account" }]);
    expect(await h.dispatcher.handle(context, event, mode())).toMatchObject({
      reason: "unavailable",
    });
    expect(h.fetcher).not.toHaveBeenCalled();
    h.list.mockResolvedValue([grant]);
    h.resolve.mockResolvedValue({ ...grant, version: "2" });
    expect(
      (await h.dispatcher.handle(context, event, mode())).results[0]?.result
    ).toMatchObject({ status: "not-sent", reason: "denied" });
    return expect(h.resolvePhone).not.toHaveBeenCalled();
  });

  it("rechecks revocation after admission and retains the consumed key", async () => {
    const h = setup();
    const admit = h.fixture.store.admit;
    const store = {
      ...h.fixture.store,
      admit: async (input: Parameters<typeof admit>[0]) => {
        const result = await admit(input);
        h.resolve.mockResolvedValue(null);
        return result;
      },
    };
    const dispatcher = createNotificationDispatch({ ...h.options, store });
    expect(
      (await dispatcher.handle(context, event, mode())).results[0]?.result
    ).toMatchObject({ reason: "denied" });
    expect(h.fixture.inspect().outcomes).toEqual(["not-sent"]);
    return expect(h.fetcher).not.toHaveBeenCalled();
  });

  it("does not send if revocation arrives during private configuration lookup", async () => {
    const h = setup();
    h.resolvePhone.mockImplementation(async () => {
      h.resolve.mockResolvedValue(null);
      return {
        enabled: true,
        tenantKey: grant.tenantKey,
        recipientKey: grant.recipientKey,
        origin: "https://notify.example",
        topic: "fixture-topic",
        bearerToken: null,
      };
    });
    await h.dispatcher.handle(context, event, mode());
    expect(h.fetcher).not.toHaveBeenCalled();
    return expect(h.fixture.inspect().outcomes).toEqual(["not-sent"]);
  });

  return it("bounds recipients and honors abort before any work", async () => {
    const h = setup();
    h.list.mockResolvedValue(
      Array.from({ length: 33 }, (_, index) => ({
        ...grant,
        grantId: `grant-${index}`,
      }))
    );
    expect(await h.dispatcher.handle(context, event, mode())).toMatchObject({
      reason: "unavailable",
    });
    expect(h.resolvePhone).not.toHaveBeenCalled();
    const controller = new AbortController();
    controller.abort();
    return expect(
      await h.dispatcher.handle(context, event, {
        dryRun: false,
        signal: controller.signal,
      })
    ).toMatchObject({ reason: "cancelled" });
  });
});

describe("explicit immutable server configuration references", () => {
  const registration: NotificationConfigurationRegistration = {
    tenantKey: grant.tenantKey,
    accountAlias: grant.accountAlias,
    environment: grant.environment,
    recipientKey: grant.recipientKey,
    recipientRef: grant.recipientRef,
    channel: grant.channel,
    purpose: grant.purpose,
    destinationRef: grant.destinationRef,
    configurationRef: grant.configurationRef,
    enabled: true,
    expiresAt: grant.expiresAt,
    provider: "ntfy",
    origin: "https://notify.example",
    credentialRef: "token-ref",
    emailPortRef: null,
  };
  const configuration = (changes = {}) => {
    const resolveDestination = vi.fn(async () => "fixture-topic");
    const resolveCredential = vi.fn(async () => "fixture-token");
    const authorize = vi.fn(async () => true);
    const resolver = createNotificationConfigurationResolver({
      enabled: true,
      registrations: [registration],
      allowedNtfyOrigins: ["https://notify.example"],
      clock: { now: () => NOW },
      authorize,
      resolveDestination,
      resolveCredential,
      ...changes,
    });
    return { resolver, resolveDestination, resolveCredential, authorize };
  };

  it("readiness performs no private value lookup", async () => {
    const h = configuration();
    expect(await h.resolver.readiness(context, grant, mode().signal)).toBe(
      "ready"
    );
    expect(h.resolveDestination).not.toHaveBeenCalled();
    expect(h.resolveCredential).not.toHaveBeenCalled();
    expect(
      await h.resolver.resolvePhone(context, grant, mode().signal)
    ).toMatchObject({ topic: "fixture-topic", bearerToken: "fixture-token" });
    expect(h.resolveDestination).toHaveBeenCalledWith(
      context,
      "destination-1",
      expect.any(AbortSignal)
    );
    return expect(h.resolveCredential).toHaveBeenCalledWith(
      context,
      "token-ref",
      expect.any(AbortSignal)
    );
  });

  it("requires enablement, configured HTTPS allowlist, exact binding and current authorization", async () => {
    expect(
      await configuration({ enabled: false }).resolver.readiness(
        context,
        grant,
        mode().signal
      )
    ).toBe("disabled");
    expect(
      await configuration({ allowedNtfyOrigins: [] }).resolver.readiness(
        context,
        grant,
        mode().signal
      )
    ).toBe("unavailable");
    const h = configuration();
    expect(
      await h.resolver.readiness(
        context,
        { ...grant, accountAlias: "other" },
        mode().signal
      )
    ).toBe("unavailable");
    h.authorize.mockResolvedValue(false);
    expect(
      await h.resolver.resolvePhone(context, grant, mode().signal)
    ).toBeNull();
    return expect(h.resolveDestination).not.toHaveBeenCalled();
  });

  return it("fails closed on duplicate registrations and never guesses a provider", async () => {
    const h = configuration({ registrations: [registration, registration] });
    expect(await h.resolver.readiness(context, grant, mode().signal)).toBe(
      "unavailable"
    );
    return expect(h.resolveDestination).not.toHaveBeenCalled();
  });
});
