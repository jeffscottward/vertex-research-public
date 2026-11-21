import type { AuthEmailDeliveryFailure } from "@darkfactory/auth/server";
import type { SemanticEvent } from "@darkfactory/observability";
import { describe, expect, it, vi } from "vitest";

import {
  AUTH_EMAIL_DELIVERY_FAILED_EVENT,
  createAuthEmailDiagnosticSink,
} from "./auth-email-diagnostics.ts";

const collect = () => {
  const events: SemanticEvent[] = [];
  const sink = {
    emit: vi.fn((event: SemanticEvent) => {
      events.push(event);
    }),
  };
  const scheduled: Promise<unknown>[] = [];
  const scheduleBackgroundTask = vi.fn((task: Promise<unknown>) => {
    scheduled.push(task);
  });
  const diagnosticSink = createAuthEmailDiagnosticSink({
    requestId: "request-safe",
    scheduleBackgroundTask,
    sink,
  });
  return { diagnosticSink, events, scheduleBackgroundTask, scheduled, sink };
};

describe("createAuthEmailDiagnosticSink", () => {
  it.each([
    [
      {
        code: "EMAIL_PREVIEW_WRITE_FAILED",
        operation: "password-reset",
        provider: "preview",
        reason: "delivery-failed",
        retryable: true,
      },
      "EMAIL_PREVIEW_WRITE_FAILED",
      {
        operation: "password-reset",
        provider: "preview",
        reason: "delivery-failed",
        retryable: true,
      },
    ],
    [
      {
        errorName: "TypeError",
        operation: "email-verification",
        reason: "recipient-limit-failed",
      },
      "AUTH_EMAIL_RECIPIENT_LIMIT_FAILED",
      {
        errorName: "TypeError",
        operation: "email-verification",
        reason: "recipient-limit-failed",
      },
    ],
    [
      {
        errorName: "ProviderTimeoutError",
        operation: "password-reset",
        reason: "delivery-threw",
      },
      "AUTH_EMAIL_PORT_THREW",
      {
        errorName: "ProviderTimeoutError",
        operation: "password-reset",
        reason: "delivery-threw",
      },
    ],
  ] as const)(
    "schedules one event with only the typed fields for %o",
    async (failure, errorCategory, attributes) => {
      const collected = collect();

      collected.diagnosticSink(failure);
      await Promise.all(collected.scheduled);

      expect(collected.scheduleBackgroundTask).toHaveBeenCalledOnce();
      expect(collected.sink.emit).toHaveBeenCalledOnce();
      expect(collected.events).toEqual([
        {
          attributes,
          correlation: { requestId: "request-safe" },
          errorCategory,
          eventId: expect.any(String),
          name: AUTH_EMAIL_DELIVERY_FAILED_EVENT,
          occurredAt: expect.any(String),
          outcome: "failure",
          source: "worker",
        },
      ]);
      return expect(
        Number.isNaN(Date.parse(collected.events[0]!.occurredAt))
      ).toBe(false);
    }
  );

  it("drops an unknown reason from an untyped caller without scheduling or emitting", () => {
    const collected = collect();

    collected.diagnosticSink({
      operation: "password-reset",
      reason: "forged",
    } as unknown as AuthEmailDeliveryFailure);

    expect(collected.scheduleBackgroundTask).not.toHaveBeenCalled();
    return expect(collected.sink.emit).not.toHaveBeenCalled();
  });

  it("contains emission failure in the scheduled background task", async () => {
    const emissionFailure = new Error("private provider failure");
    const scheduled: Promise<unknown>[] = [];
    const diagnosticSink = createAuthEmailDiagnosticSink({
      requestId: "request-safe",
      scheduleBackgroundTask: (task) => {
        scheduled.push(task);
      },
      sink: {
        emit: vi.fn(() => {
          throw emissionFailure;
        }),
      },
    });

    expect(() =>
      diagnosticSink({
        errorName: "Error",
        operation: "password-reset",
        reason: "delivery-threw",
      })
    ).not.toThrow();
    return expect(await Promise.allSettled(scheduled)).toEqual([
      { reason: emissionFailure, status: "rejected" },
    ]);
  });

  return it("contains emission rejection when background scheduling throws", async () => {
    const emit = vi.fn(async () => {
      throw new Error("private provider failure");
    });
    const diagnosticSink = createAuthEmailDiagnosticSink({
      requestId: "request-safe",
      scheduleBackgroundTask: () => {
        throw new Error("background scheduling unavailable");
      },
      sink: { emit },
    });

    expect(() =>
      diagnosticSink({
        errorName: "Error",
        operation: "email-verification",
        reason: "delivery-threw",
      })
    ).not.toThrow();
    return await vi.waitFor(() => {
      return expect(emit).toHaveBeenCalledOnce();
    });
  });
});
