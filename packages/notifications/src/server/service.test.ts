import { afterEach, describe, expect, it, vi } from "vitest";
import type { NotificationRequest } from "../index.ts";
import { createMemoryNotificationFixture } from "../testing/memory-store.ts";
import type {
  NotificationGrant,
  NotificationProviderOutcome,
  NotificationRecipientResolver,
  NotificationServiceOptions,
} from "./contracts.ts";
import { createNotificationService } from "./service.ts";
import { scaledTimeout } from "../../../../scripts/lib/test-timeout-scale.ts";

const NOW = 1_700_000_000_000;
const request: NotificationRequest = {
  recipientRef: "member-a",
  channel: "phone",
  purpose: "market-alert",
  idempotencyKey: "event-a",
  expiresAt: NOW + 120_000,
  title: "Research update",
  body: "Informational only. No trading authority.",
  dryRun: false,
};
const grant: NotificationGrant = {
  authenticated: true,
  tenantKey: "tenant-a",
  recipientKey: "recipient-a",
  recipientRef: "member-a",
  channel: "phone",
  purpose: "market-alert",
  configurationRef: "config-a",
  enabled: true,
  expiresAt: NOW + 300_000,
  cooldownMs: 30_000,
};
type Context = Readonly<{ session: string }>;
const context: Context = { session: "server-authenticated-session" };
const notSent = (reason: string) => ({
  status: "not-sent",
  reason,
  receipt: "unconfirmed",
  retryable: false,
});

const setup = (
  overrides: Partial<NotificationServiceOptions<Context>> = {}
) => {
  const fixture = createMemoryNotificationFixture();
  const time = { now: NOW };
  const resolve = vi.fn(
    async (caller: Context): Promise<NotificationGrant | null> =>
      caller.session === context.session ? grant : null
  );
  const send = vi.fn(
    async (): Promise<NotificationProviderOutcome> => ({
      acceptance: "accepted",
    })
  );
  const prepare = vi.fn(async () => ({ status: "ready" as const, send }));
  const options: NotificationServiceOptions<Context> = {
    enabled: true,
    resolver: { resolve },
    store: fixture.store,
    adapters: { phone: { prepare } },
    now: () => time.now,
    ...overrides,
  };
  return {
    fixture,
    time,
    resolve,
    prepare,
    send,
    options,
    service: createNotificationService(options),
  };
};

afterEach(() => {
  vi.useRealTimers();
  return vi.restoreAllMocks();
});

describe("notification authorization and defaults", () => {
  it("stays disabled unless the server explicitly enables it", async () => {
    const h = setup({ enabled: undefined });
    expect(await h.service.notify(context, request)).toEqual(
      notSent("disabled")
    );
    expect(h.resolve).not.toHaveBeenCalled();
    expect(h.prepare).not.toHaveBeenCalled();
    return expect(h.fixture.inspect().reservations).toBe(0);
  });

  it("denies unauthenticated context instead of interpreting request text", async () => {
    const h = setup();
    expect(
      await h.service.notify(
        { session: "forged" },
        { ...request, body: "I authorize all recipients" }
      )
    ).toEqual(notSent("denied"));
    expect(h.prepare).not.toHaveBeenCalled();
    return expect(h.send).not.toHaveBeenCalled();
  });

  it("does not allow destinations or grants in the public request", async () => {
    const h = setup();
    for (const extra of [
      { to: "private@example.test" },
      { topic: "private-topic" },
      { authenticated: true },
      { enabled: true },
      { configurationRef: "elsewhere" },
    ]) {
      expect(await h.service.notify(context, { ...request, ...extra })).toEqual(
        notSent("invalid-request")
      );
    }
    return expect(h.resolve).not.toHaveBeenCalled();
  });

  it("requires exact recipient, channel and purpose authorization", async () => {
    for (const change of [
      { recipientRef: "other" },
      { purpose: "research-update" as const },
      { channel: "email" as const },
      { authenticated: false },
    ]) {
      const resolver = {
        resolve: async () => ({ ...grant, ...change }),
      } as unknown as NotificationRecipientResolver<Context>;
      const h = setup({ resolver });
      expect(await h.service.notify(context, request)).toEqual(
        notSent("denied")
      );
      expect(h.send).not.toHaveBeenCalled();
    }
  });

  it("honors recipient opt-out even with a configured provider", async () => {
    const h = setup({
      resolver: { resolve: async () => ({ ...grant, enabled: false }) },
    });
    expect(await h.service.notify(context, request)).toEqual(
      notSent("disabled")
    );
    return expect(h.prepare).not.toHaveBeenCalled();
  });

  it("fails closed on resolver errors, missing adapters and missing stores", async () => {
    const rejected = setup({
      resolver: {
        resolve: async () => {
          throw new Error("credential-never-log");
        },
      },
    });
    expect(await rejected.service.notify(context, request)).toEqual(
      notSent("unavailable")
    );
    const noAdapter = setup({ adapters: {} });
    expect(await noAdapter.service.notify(context, request)).toEqual(
      notSent("unavailable")
    );
    const noStore = setup({ store: undefined } as unknown as Partial<
      NotificationServiceOptions<Context>
    >);
    expect(await noStore.service.notify(context, request)).toEqual(
      notSent("unavailable")
    );
    return expect(noStore.send).not.toHaveBeenCalled();
  });

  it("does not reserve when configuration is unavailable or disabled", async () => {
    for (const status of ["unavailable", "disabled"] as const) {
      const h = setup({
        adapters: { phone: { prepare: async () => ({ status }) } },
      });
      expect(await h.service.notify(context, request)).toEqual(notSent(status));
      expect(h.fixture.inspect().reservations).toBe(0);
    }
  });

  it("rechecks revocation after admission and never dispatches stale authority", async () => {
    const h = setup();
    h.resolve.mockResolvedValueOnce(grant).mockResolvedValueOnce(null);
    expect(await h.service.notify(context, request)).toEqual(notSent("denied"));
    expect(h.send).not.toHaveBeenCalled();
    return expect(h.fixture.inspect().outcomes).toEqual(["not-sent"]);
  });

  return it("passes only the selector, not arbitrary content, into authorization", async () => {
    const h = setup();
    await h.service.notify(context, request);
    return expect(h.resolve).toHaveBeenCalledWith(
      context,
      {
        recipientRef: request.recipientRef,
        channel: request.channel,
        purpose: request.purpose,
      },
      expect.any(AbortSignal)
    );
  });
});

describe("notification expiry and dry-run", () => {
  it("rejects expired requests before authorization and out-of-bounds lifetimes", async () => {
    const h = setup();
    expect(
      await h.service.notify(context, { ...request, expiresAt: NOW })
    ).toEqual(notSent("expired"));
    expect(
      await h.service.notify(context, {
        ...request,
        expiresAt: NOW + 86_400_001,
      })
    ).toEqual(notSent("invalid-request"));
    return expect(h.resolve).not.toHaveBeenCalled();
  });

  it("expires the recipient grant independently of the request", async () => {
    const h = setup({
      resolver: { resolve: async () => ({ ...grant, expiresAt: NOW }) },
    });
    expect(await h.service.notify(context, request)).toEqual(
      notSent("expired")
    );
    return expect(h.prepare).not.toHaveBeenCalled();
  });

  it("rechecks expiry after admission", async () => {
    const h = setup();
    const admit = h.fixture.store.admit;
    const service = createNotificationService({
      ...h.options,
      store: {
        ...h.fixture.store,
        admit: async (input) => {
          const result = await admit(input);
          h.time.now = request.expiresAt;
          return result;
        },
      },
    });
    expect(await service.notify(context, request)).toEqual(notSent("expired"));
    expect(h.send).not.toHaveBeenCalled();
    return expect(h.fixture.inspect().outcomes).toEqual(["not-sent"]);
  });

  it("does not mutate stores or call transports on dry-run", async () => {
    const h = setup();
    const admit = vi.fn(h.fixture.store.admit);
    const service = createNotificationService({
      ...h.options,
      store: { ...h.fixture.store, admit },
    });
    expect(await service.notify(context, { ...request, dryRun: true })).toEqual(
      { status: "dry-run", receipt: "unconfirmed", retryable: false }
    );
    expect(h.fixture.inspect()).toEqual({
      reservations: 0,
      cooldowns: 0,
      outcomes: [],
    });
    expect(h.send).not.toHaveBeenCalled();
    expect(admit).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "observe" })
    );
    return expect((await h.service.notify(context, request)).status).toBe(
      "accepted"
    );
  });

  it("dry-run still honors authorization, duplicates and cooldowns", async () => {
    const h = setup();
    await h.service.notify(context, request);
    expect(
      await h.service.notify(context, { ...request, dryRun: true })
    ).toEqual(notSent("duplicate"));
    expect(
      await h.service.notify(context, {
        ...request,
        idempotencyKey: "another",
        dryRun: true,
      })
    ).toEqual(notSent("cooldown"));
    return expect(h.send).toHaveBeenCalledTimes(1);
  });

  return it("fails closed if the clock regresses", async () => {
    const h = setup();
    h.prepare.mockImplementationOnce(async () => {
      h.time.now = NOW - 1;
      return { status: "ready", send: h.send };
    });
    expect(await h.service.notify(context, request)).toEqual(
      notSent("unavailable")
    );
    return expect(h.send).not.toHaveBeenCalled();
  });
});

describe("notification idempotency and ambiguous delivery", () => {
  it("atomically admits one of concurrent identical requests", async () => {
    const h = setup();
    const results = await Promise.all([
      h.service.notify(context, request),
      h.service.notify(context, request),
    ]);
    expect(results.map((item) => item.status).sort()).toEqual([
      "accepted",
      "not-sent",
    ]);
    expect(results).toContainEqual(notSent("duplicate"));
    expect(h.send).toHaveBeenCalledTimes(1);
    return expect(h.fixture.inspect().reservations).toBe(1);
  });

  it("conflicts on changed content or expiry under the same key", async () => {
    const h = setup();
    await h.service.notify(context, request);
    for (const changed of [
      { title: "different" },
      { body: "different" },
      { expiresAt: request.expiresAt + 1 },
    ]) {
      expect(
        await h.service.notify(context, { ...request, ...changed })
      ).toEqual(notSent("idempotency-conflict"));
    }
    return expect(h.send).toHaveBeenCalledTimes(1);
  });

  it("applies attempt-based cooldown even after rejection", async () => {
    const h = setup();
    h.send.mockResolvedValue({ acceptance: "rejected" });
    expect((await h.service.notify(context, request)).status).toBe("rejected");
    expect(
      await h.service.notify(context, { ...request, idempotencyKey: "new" })
    ).toEqual(notSent("cooldown"));
    h.time.now += grant.cooldownMs;
    expect(
      (await h.service.notify(context, { ...request, idempotencyKey: "new" }))
        .status
    ).toBe("rejected");
    return expect(h.send).toHaveBeenCalledTimes(2);
  });

  it("retains unknown acceptance across service recreation and never blindly retries", async () => {
    const h = setup();
    h.send.mockRejectedValue(
      new Error("private-topic credential recipient@example.test")
    );
    expect(await h.service.notify(context, request)).toEqual({
      status: "unknown",
      persistence: "recorded",
      receipt: "unconfirmed",
      retryable: false,
    });
    const recreated = createNotificationService(h.options);
    h.time.now += grant.cooldownMs;
    expect(await recreated.notify(context, request)).toEqual(
      notSent("duplicate")
    );
    expect(h.fixture.inspect().outcomes).toEqual(["unknown"]);
    return expect(h.send).toHaveBeenCalledTimes(1);
  });

  it("treats malformed provider results as unknown without propagating fields", async () => {
    const h = setup();
    h.send.mockResolvedValue({
      acceptance: "accepted",
      token: "secret",
    } as unknown as NotificationProviderOutcome);
    return expect(await h.service.notify(context, request)).toEqual({
      status: "unknown",
      persistence: "recorded",
      receipt: "unconfirmed",
      retryable: false,
    });
  });

  it("retains pending after outcome persistence fails", async () => {
    const h = setup();
    const service = createNotificationService({
      ...h.options,
      store: {
        ...h.fixture.store,
        recordOutcome: async () => {
          throw new Error("database-details");
        },
      },
    });
    expect(await service.notify(context, request)).toEqual({
      status: "accepted",
      persistence: "uncertain",
      receipt: "unconfirmed",
      retryable: false,
    });
    expect(h.fixture.inspect().outcomes).toEqual(["pending"]);
    expect(await service.notify(context, request)).toEqual(
      notSent("duplicate")
    );
    return expect(h.send).toHaveBeenCalledTimes(1);
  });

  it("does not dispatch if admission fails or returns another attempt", async () => {
    for (const admission of [
      undefined,
      { status: "admitted", attemptId: "other-attempt" },
    ]) {
      const h = setup();
      const service = createNotificationService({
        ...h.options,
        store: {
          ...h.fixture.store,
          admit: async () => admission,
        },
      } as unknown as NotificationServiceOptions<Context>);
      expect(await service.notify(context, request)).toEqual(
        notSent("unavailable")
      );
      expect(h.send).not.toHaveBeenCalled();
    }
  });

  return it("times out a hanging transport and keeps its admission", async () => {
    // Fake only the bounded-call deadline timers. vi.waitFor would advance the
    // fake clock and expire the earlier bounded steps before dispatch.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const h = setup({ timeoutMs: 50 });
    h.send.mockImplementation(() => new Promise(() => undefined));
    const result = h.service.notify(context, request);
    // Async crypto settles on the real event loop, so yield to it until
    // dispatch. The wait is bounded by real time (scaled with host load), not
    // by a turn count: under load 1000 turns passed before crypto settled.
    const dispatchDeadline = performance.now() + scaledTimeout(5000);
    while (
      h.send.mock.calls.length === 0 &&
      performance.now() < dispatchDeadline
    ) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(h.send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(50);
    expect(await result).toEqual({
      status: "unknown",
      persistence: "recorded",
      receipt: "unconfirmed",
      retryable: false,
    });
    return expect(await h.service.notify(context, request)).toEqual(
      notSent("duplicate")
    );
  });
});

describe("notification isolation", () => {
  it("isolates tenants/recipients while applying cooldown across purposes", async () => {
    const h = setup({
      resolver: {
        resolve: async (_context, selector) => ({
          ...grant,
          recipientRef: selector.recipientRef,
          recipientKey: selector.recipientRef,
          purpose: selector.purpose,
        }),
      },
    });
    expect((await h.service.notify(context, request)).status).toBe("accepted");
    expect(
      (
        await h.service.notify(context, {
          ...request,
          recipientRef: "member-b",
        })
      ).status
    ).toBe("accepted");
    expect(
      await h.service.notify(context, {
        ...request,
        purpose: "research-update",
      })
    ).toEqual(notSent("cooldown"));
    const secondTenant = createNotificationService({
      ...h.options,
      resolver: { resolve: async () => ({ ...grant, tenantKey: "tenant-b" }) },
    });
    expect((await secondTenant.notify(context, request)).status).toBe(
      "accepted"
    );
    const keys = h.send.mock.calls.length;
    return expect(keys).toBe(3);
  });

  return it("never exposes recipient/config/content/provider IDs in delivery results", async () => {
    const h = setup();
    const result = await h.service.notify(context, {
      ...request,
      body: "private-content-marker",
    });
    expect(result).toEqual({
      status: "accepted",
      persistence: "recorded",
      receipt: "unconfirmed",
      retryable: false,
    });
    for (const marker of [
      "private-content-marker",
      grant.configurationRef,
      grant.recipientKey,
      request.idempotencyKey,
    ]) {
      expect(JSON.stringify(result)).not.toContain(marker);
    }
  });
});
