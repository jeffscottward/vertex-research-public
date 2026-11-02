import { describe, expect, it } from "vitest";
import { hashArtifact } from "./vertex-runtime-epoch-bytes.ts";
import { rebuildEpochExecutionProjection } from "./vertex-runtime-epoch-execution.ts";

// Synthetic source-only cases; no test invocation during this buildout.
const fixture = async () => {
  const at = "2026-01-01T00:00:00.000000000Z";
  const event = {
    eventId: "fixture-event",
    ownerEpoch: "1",
    occurredNs: "1767225600000000000",
  };
  const admission = {
    policyVersion: "1.0.0",
    strategyVersion: "fixture-strategy",
    reviewedArtifactSha256: "a".repeat(64),
    admissionId: "fixture-admission",
    idempotencyKey: "fixture-submission",
  };
  const state = {
    accountAlias: "fixture-account",
    environment: "paper",
    ownerEpoch: "1",
    orders: {
      "fixture-submission": {
        admission,
        intent: { intentId: "fixture-intent", quantity: "2" },
        legs: { "fixture-instrument": { filled: "0", maximumQuantity: "2" } },
        status: "not-submitted",
        orderRef: null,
      },
    },
  };
  const projection: Record<string, any> = {
    schemaVersion: "1.0.0",
    projectionId: "projection-1-2",
    accountAlias: "fixture-account",
    environment: "paper",
    streamId: "fixture-stream",
    ownerEpoch: "1",
    sequence: "2",
    previousEventHash: "b".repeat(64),
    occurredAt: at,
    receivedAt: at,
    actorId: "fixture-emitter",
    ...admission,
    expiresAt: "2026-01-01T00:01:00.000000000Z",
    sourceKind: "paper-simulation",
    receipt: {
      schemaVersion: "1.0.0",
      intentId: "fixture-intent",
      submissionKey: "fixture-submission",
      brokerOrderRef: null,
      environment: "paper",
      observationOnly: true,
      status: "not-submitted",
      totalQuantity: "2",
      filledQuantity: "0",
      remainingQuantity: "2",
      lastReconciledAt: at,
      errorClass: null,
      auditEventIds: ["fixture-event"],
    },
    authoritative: false,
    reservationAuthority: "native-owner-only",
  };
  projection["eventHash"] = await hashArtifact(projection);
  return { state, event, projection };
};

describe("original execution projection economic reconstruction", () => {
  it("rebuilds the exact original receipt from native post-event order state", async () => {
    const f = await fixture();
    return await expect(
      rebuildEpochExecutionProjection(f.state, f.event, f.projection)
    ).resolves.toBeUndefined();
  });
  it("rejects rehashed caller receipt economics instead of trusting a valid public hash", async () => {
    const f = await fixture();
    f.projection["receipt"].totalQuantity = "3";
    f.projection["receipt"].remainingQuantity = "3";
    delete f.projection["eventHash"];
    f.projection["eventHash"] = await hashArtifact(f.projection);
    return await expect(
      rebuildEpochExecutionProjection(f.state, f.event, f.projection)
    ).rejects.toThrow();
  });
  return it("rejects a different source event or rewritten event timestamp", async () => {
    const f = await fixture();
    await expect(
      rebuildEpochExecutionProjection(
        f.state,
        { ...f.event, eventId: "different-event" },
        f.projection
      )
    ).rejects.toThrow();
    return await expect(
      rebuildEpochExecutionProjection(
        f.state,
        { ...f.event, occurredNs: "1767225600000000001" },
        f.projection
      )
    ).rejects.toThrow();
  });
});
