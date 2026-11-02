import { describe, expect, it, vi } from "vitest";
import {
  snapshotNotificationRequest,
  snapshotNotificationResult,
} from "./index.ts";

const input = {
  recipientRef: "recipient-ref",
  channel: "phone",
  purpose: "market-alert",
  idempotencyKey: "event-a",
  expiresAt: 1_700_000_030_000,
  title: "Informational alert",
  body: "Advisory content only.\nNo trading permission.",
  dryRun: false,
};

describe("bounded notification contract", () => {
  it("snapshots valid plain input instead of retaining caller mutation", () => {
    const source = { ...input };
    const result = snapshotNotificationRequest(source);
    source.body = "changed";
    expect(result?.body).toBe(input.body);
    return expect(Object.isFrozen(result)).toBe(true);
  });

  it("rejects oversized utf8, control characters and nonfinite timestamps", () => {
    for (const change of [
      { title: "x".repeat(161) },
      { title: "界".repeat(54) },
      { body: "x".repeat(4097) },
      { body: "界".repeat(1366) },
      { title: "Header\r\ninjection" },
      { body: "nul\u0000byte" },
      { expiresAt: Number.NaN },
      { expiresAt: Number.POSITIVE_INFINITY },
      { expiresAt: -1 },
      { expiresAt: 1.1 },
      { title: "   " },
      { body: "\n\n" },
    ])
      expect(
        snapshotNotificationRequest({ ...input, ...change })
      ).toBeUndefined();
  });

  it("rejects arbitrary channels, purposes, destinations and malformed IDs", () => {
    for (const change of [
      { channel: "sms" },
      { channel: "imessage" },
      { channel: "voice" },
      { purpose: "trade-approved" },
      { recipientRef: "person@example.test" },
      { recipientRef: "https://ntfy.test/secret" },
      { idempotencyKey: "" },
      { idempotencyKey: "x".repeat(129) },
      { dryRun: "false" },
    ])
      expect(
        snapshotNotificationRequest({ ...input, ...change })
      ).toBeUndefined();
  });

  it("does not invoke accessors or accept prototypes and symbols", () => {
    const getter = vi.fn(() => "forged");
    const accessor = Object.defineProperty({ ...input }, "body", {
      enumerable: true,
      get: getter,
    });
    expect(snapshotNotificationRequest(accessor)).toBeUndefined();
    expect(getter).not.toHaveBeenCalled();
    expect(
      snapshotNotificationRequest(Object.assign(Object.create({}), input))
    ).toBeUndefined();
    expect(
      snapshotNotificationRequest({ ...input, [Symbol("secret")]: true })
    ).toBeUndefined();
    expect(
      snapshotNotificationRequest(
        new Proxy(
          {},
          {
            ownKeys: () => {
              throw new Error("secret");
            },
          }
        )
      )
    ).toBeUndefined();
    expect(snapshotNotificationRequest(null)).toBeUndefined();
    return expect(snapshotNotificationRequest([])).toBeUndefined();
  });

  return it("only admits bounded neutral results, never receipt claims or secret extras", () => {
    const accepted = {
      status: "accepted",
      persistence: "recorded",
      receipt: "unconfirmed",
      retryable: false,
    };
    expect(snapshotNotificationResult(accepted)).toEqual(accepted);
    expect(
      snapshotNotificationResult({ ...accepted, receipt: "delivered" })
    ).toBeUndefined();
    expect(
      snapshotNotificationResult({ ...accepted, retryable: true })
    ).toBeUndefined();
    expect(
      snapshotNotificationResult({ ...accepted, topic: "private" })
    ).toBeUndefined();
    expect(
      snapshotNotificationResult({
        ...accepted,
        messageId: "provider-identifier",
      })
    ).toBeUndefined();
    expect(
      snapshotNotificationResult({
        status: "not-sent",
        reason: "unknown-custom-error",
        receipt: "unconfirmed",
        retryable: false,
      })
    ).toBeUndefined();
    return expect(
      snapshotNotificationResult({
        status: "dry-run",
        receipt: "unconfirmed",
        retryable: false,
      })?.status
    ).toBe("dry-run");
  });
});
