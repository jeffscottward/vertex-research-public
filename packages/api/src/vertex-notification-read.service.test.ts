import type { SafePrincipal } from "@darkfactory/auth/types";
import {
  NotificationAuthorityError,
  type NotificationDeliveryStatus,
} from "@darkfactory/notifications/server/dispatch";
import { describe, expect, it, vi } from "vitest";
import {
  createVertexNotificationReadService,
  type VertexNotificationReadService,
} from "./server/vertex-notification-read-service.ts";
import { VertexReadServiceError } from "./server/vertex-service.ts";
import type { VertexNotificationDeliveryInput } from "./contracts/vertex-notification-read.ts";

// Source-authored regression cases; no providers, real permissions or DB effects.
const principal: SafePrincipal = {
  userId: "member-1",
  role: "member",
  status: "active",
};
const input: VertexNotificationDeliveryInput = {
  accountAlias: "account-1",
  environment: "paper",
  grantId: "grant-1",
  version: "1",
  eventId: "event-1",
};
const accepted: NotificationDeliveryStatus = {
  status: "accepted",
  admittedAt: 1000,
  expiresAt: 2000,
  outcomeAt: 1001,
  receipt: "unconfirmed",
  retryable: false,
};
const fixture = () => {
  const context = { trustedSession: "session-1" };
  const controller = new AbortController();
  const serverContext = vi.fn(
    async (_principal: SafePrincipal): Promise<typeof context | null> => context
  );
  const read = vi.fn(
    async (
      _context: typeof context,
      _input: VertexNotificationDeliveryInput,
      _signal: AbortSignal
    ): Promise<NotificationDeliveryStatus> => accepted
  );
  const service: VertexNotificationReadService =
    createVertexNotificationReadService({
      serverContext,
      deliveries: { read },
      signal: controller.signal,
    });
  return { context, controller, serverContext, read, service };
};
const failure = async (work: Promise<unknown>, code: string): Promise<void> => {
  await expect(work).rejects.toBeInstanceOf(VertexReadServiceError);
  await expect(work).rejects.toMatchObject({ code });
  await expect(work).rejects.not.toThrow("private provider detail");
};

describe("notification delivery API service", () => {
  it("binds the authenticated principal to server context and exposes a frozen allowlisted result", async () => {
    const h = fixture();
    const result = await h.service.delivery(principal, input);
    expect(h.serverContext).toHaveBeenCalledWith(principal);
    expect(h.read).toHaveBeenCalledWith(h.context, input, h.controller.signal);
    expect(result).toEqual(accepted);
    expect(result).not.toBe(accepted);
    expect(Object.isFrozen(result)).toBe(true);
    return expect(Object.isFrozen(h.read.mock.calls[0]?.[1])).toBe(true);
  });

  it("rejects surplus fields and accessors without executing them or resolving context", async () => {
    const h = fixture();
    const getter = vi.fn(() => "account-1");
    const accessor = { ...input };
    Object.defineProperty(accessor, "accountAlias", {
      enumerable: true,
      get: getter,
    });
    for (const raw of [
      accessor,
      { ...input, context: h.context },
      { ...input, environment: "live" },
      { ...input, version: "0" },
    ]) {
      await failure(
        h.service.delivery(principal, raw as VertexNotificationDeliveryInput),
        "BAD_REQUEST"
      );
    }
    expect(getter).not.toHaveBeenCalled();
    expect(h.serverContext).not.toHaveBeenCalled();
    return expect(h.read).not.toHaveBeenCalled();
  });

  it("denies unresolved server context and hides arbitrary resolver errors", async () => {
    const h = fixture();
    h.serverContext.mockResolvedValueOnce(null);
    await failure(h.service.delivery(principal, input), "FORBIDDEN");
    h.serverContext.mockRejectedValueOnce(new Error("private provider detail"));
    await failure(h.service.delivery(principal, input), "SERVICE_UNAVAILABLE");
    return expect(h.read).not.toHaveBeenCalled();
  });

  it("maps only known authority failures to neutral public error codes", async () => {
    const h = fixture();
    for (const [source, target] of [
      ["denied", "FORBIDDEN"],
      ["invalid", "BAD_REQUEST"],
      ["integrity", "INVALID_SOURCE"],
      ["conflict", "SERVICE_UNAVAILABLE"],
      ["unavailable", "SERVICE_UNAVAILABLE"],
    ] as const) {
      h.read.mockRejectedValueOnce(new NotificationAuthorityError(source));
      await failure(h.service.delivery(principal, input), target);
    }
    h.read.mockRejectedValueOnce(new Error("private provider detail"));
    await failure(h.service.delivery(principal, input), "SERVICE_UNAVAILABLE");
    h.read.mockRejectedValueOnce({
      code: "denied",
      message: "private provider detail",
    });
    return await failure(
      h.service.delivery(principal, input),
      "SERVICE_UNAVAILABLE"
    );
  });

  it("rejects rather than serializes extra source fields and accessor outputs", async () => {
    const h = fixture();
    h.read.mockResolvedValueOnce({
      ...accepted,
      topic: "private provider detail",
    } as NotificationDeliveryStatus);
    await failure(h.service.delivery(principal, input), "INVALID_SOURCE");
    const getter = vi.fn(() => "accepted");
    const source = { ...accepted };
    Object.defineProperty(source, "status", { enumerable: true, get: getter });
    h.read.mockResolvedValueOnce(source);
    await failure(h.service.delivery(principal, input), "INVALID_SOURCE");
    return expect(getter).not.toHaveBeenCalled();
  });

  it("discards results on cancellation before context, after context and after ledger read", async () => {
    const first = fixture();
    first.controller.abort();
    await failure(
      first.service.delivery(principal, input),
      "SERVICE_UNAVAILABLE"
    );
    expect(first.serverContext).not.toHaveBeenCalled();
    const second = fixture();
    second.serverContext.mockImplementationOnce(async () => {
      second.controller.abort();
      return second.context;
    });
    await failure(
      second.service.delivery(principal, input),
      "SERVICE_UNAVAILABLE"
    );
    expect(second.read).not.toHaveBeenCalled();
    const third = fixture();
    third.read.mockImplementationOnce(async () => {
      third.controller.abort();
      return accepted;
    });
    return await failure(
      third.service.delivery(principal, input),
      "SERVICE_UNAVAILABLE"
    );
  });
});
