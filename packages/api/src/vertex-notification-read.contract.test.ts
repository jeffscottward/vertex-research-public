import { describe, expect, it } from "vitest";
import {
  vertexNotificationReadContract,
  VertexNotificationDeliveryInputSchema,
  VertexNotificationDeliveryOutputSchema,
} from "./contracts/vertex-notification-read.ts";

// Authored only; execution is deferred to the consolidated verification phase.
const input = {
  accountAlias: "account-1",
  environment: "research",
  grantId: "grant-1",
  version: "1",
  eventId: "event-1",
};
const accepted = {
  status: "accepted",
  admittedAt: 1000,
  expiresAt: 2000,
  outcomeAt: 1001,
  receipt: "unconfirmed",
  retryable: false,
};

describe("notification delivery public contract", () => {
  it("publishes only the frozen GET delivery route", () => {
    expect(
      vertexNotificationReadContract.delivery["~orpc"].route
    ).toMatchObject({
      method: "GET",
      path: "/vertex/notifications/delivery",
      operationId: "vertex.notifications.delivery",
    });
    return expect(Object.keys(vertexNotificationReadContract)).toEqual([
      "delivery",
    ]);
  });

  it("requires exactly the non-live account and historical version selection", () => {
    expect(VertexNotificationDeliveryInputSchema.parse(input)).toEqual(input);
    expect(
      VertexNotificationDeliveryInputSchema.safeParse({
        ...input,
        environment: "paper",
      }).success
    ).toBe(true);
    for (const value of [
      { ...input, environment: "live" },
      { ...input, tenantKey: "tenant-1" },
      { ...input, recipientRef: "recipient-1" },
      { ...input, version: "01" },
      { ...input, version: 1 },
      { ...input, grantId: "https://example.test" },
      { ...input, accountAlias: "" },
      { ...input, eventId: "" },
    ]) {
      expect(
        VertexNotificationDeliveryInputSchema.safeParse(value).success
      ).toBe(false);
    }

    for (const key of Object.keys(input)) {
      const missing = { ...input } as Record<string, unknown>;
      delete missing[key];
      expect(
        VertexNotificationDeliveryInputSchema.safeParse(missing).success
      ).toBe(false);
    }
  });

  it("cannot claim device receipt, retryability or expose destination/provider material", () => {
    expect(VertexNotificationDeliveryOutputSchema.parse(accepted)).toEqual(
      accepted
    );
    expect(
      VertexNotificationDeliveryOutputSchema.parse({
        status: "not-found",
        receipt: "unconfirmed",
        retryable: false,
      })
    ).toEqual({
      status: "not-found",
      receipt: "unconfirmed",
      retryable: false,
    });
    for (const value of [
      { ...accepted, receipt: "confirmed" },
      { ...accepted, retryable: true },
      { ...accepted, address: "private" },
      { ...accepted, topic: "private" },
      { ...accepted, grant: {} },
      { ...accepted, error: "private" },
      { ...accepted, status: "delivered" },
      { ...accepted, outcomeAt: null },
      { ...accepted, status: "pending" },
      { ...accepted, admittedAt: -0 },
      { ...accepted, expiresAt: accepted.admittedAt },
      { ...accepted, expiresAt: accepted.admittedAt + 86_400_001 },
      { ...accepted, outcomeAt: accepted.admittedAt - 1 },
    ]) {
      expect(
        VertexNotificationDeliveryOutputSchema.safeParse(value).success
      ).toBe(false);
    }
    return expect(
      VertexNotificationDeliveryOutputSchema.safeParse({
        ...accepted,
        status: "pending",
        outcomeAt: null,
      }).success
    ).toBe(true);
  });
});
