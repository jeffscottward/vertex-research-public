import { describe, expect, it, vi } from "vitest";
import { EventEnvelopeSchema, computeEventId } from "../../contracts/vertex.ts";
import { createVertexWorkerDispatchBoundary } from "../vertex-worker-service.ts";
import type { WorkerLease, WorkerResult } from "./contracts.ts";
import type {
  VertexOutboxLease,
  VertexStore,
} from "@darkfactory/db/server/vertex";
import type {
  VertexWorkerStore,
  WorkerServiceIdentity,
} from "@darkfactory/db/server/vertex-worker";
import {
  createVertexWorkerDispatcher,
  type VertexWorkerBindingSelection,
} from "./dispatcher.ts";

// Source-only regression cases; execute only during the final integrated gate.
const at = "2026-09-22T12:00:00.000Z";
const expires = "2026-09-22T12:05:00.000Z";
const deadline = "2026-09-22T13:00:00.000Z";
const scope = {
  accountAlias: "research-account",
  environment: "research" as const,
};
const identity: WorkerServiceIdentity = {
  grantId: "grant-1",
  servicePrincipalId: "service-1",
  scope,
  expiresAt: deadline,
};
const selected: VertexWorkerBindingSelection = {
  kind: "research-run",
  researchPrincipalId: "researcher-1",
  payloadArtifactId: "payload-1",
  payloadSha256: "a".repeat(64),
  policySelectionId: "selection-1",
  policySelectionSha256: "b".repeat(64),
  deadlineAt: deadline,
};
const options = {
  workerInstanceId: "worker-1",
  kinds: ["research-run" as const],
};
const fixture = async (status: "queued" | "completed" = "queued") => {
  const preliminary = EventEnvelopeSchema.parse({
    schemaVersion: "1.0.0",
    eventId: `event-${"0".repeat(64)}`,
    eventType: "agent.recorded",
    occurredAt: at,
    receivedAt: at,
    effectiveAt: at,
    correlationId: "correlation-1",
    causationId: null,
    actorId: "researcher-1",
    moduleId: "research-module",
    moduleVersion: "1.0.0",
    environment: "research",
    idempotencyKey: "command-1",
    payload: {
      schemaVersion: "1.0.0",
      runId: "run-1",
      agentRole: "research",
      taskContract: "research-task",
      allowedTools: [],
      modelVersion: null,
      inputEvidenceIds: [],
      outputArtifactIds: status === "completed" ? ["output-1"] : [],
      tokenBudget: 100,
      costBudgetUsd: "1",
      status,
      errors: [],
      approvalRequests: [],
      executionAuthorized: false,
    },
  });
  const event = EventEnvelopeSchema.parse({
    ...preliminary,
    eventId: await computeEventId(preliminary),
  });
  const row: VertexOutboxLease = {
    eventId: event.eventId,
    scope,
    collectionId: "collection-1",
    eventType: "agent.recorded",
    payload: event,
    leaseOwner: "worker-1",
    leaseFence: "1",
    leaseExpiresAt: expires,
  };
  const lease: WorkerLease = {
    schemaVersion: "1.0.0",
    jobId: "job-1",
    eventId: event.eventId,
    ...scope,
    ...selected,
    leaseId: "worker-1",
    leaseEpoch: "1",
    leaseExpiresAt: expires,
    attempt: 1,
  };
  const response: WorkerResult = {
    status: "accepted",
    jobId: "job-1",
    state: "leased",
    lease,
    outputArtifactIds: [],
    reason: null,
  };
  const bindOutbox = vi.fn<VertexWorkerStore["bindOutbox"]>(
    async () => response
  );
  const claimOutbox = vi.fn<VertexStore["claimOutbox"]>(async () => [row]);
  const settleOutbox = vi.fn<VertexStore["settleOutbox"]>(async () => true);
  const resolveBinding = vi.fn(async () => selected);
  const dependencies = {
    boundary: createVertexWorkerDispatchBoundary(),
    outboxStore: { claimOutbox, settleOutbox },
    workerStore: { bindOutbox },
    resolveBinding,
    clock: { now: () => at },
  };
  return {
    row,
    lease,
    response,
    bindOutbox,
    claimOutbox,
    settleOutbox,
    resolveBinding,
    dependencies,
  };
};

describe("single worker control dispatcher", () => {
  it("claims only existing rows and ACKs admission with exact owner/fence, never completion", async () => {
    const f = await fixture();
    const dispatcher = createVertexWorkerDispatcher(f.dependencies);
    const result = await dispatcher.claim(identity, {
      ...scope,
      workerInstanceId: "worker-1",
      kinds: ["research-run"],
      limit: 1,
      leaseDurationMs: 300_000,
    });
    expect(result).toEqual({ status: "accepted", leases: [f.lease] });
    expect(f.claimOutbox).toHaveBeenCalledTimes(1);
    expect(f.claimOutbox).toHaveBeenCalledWith(
      { actorId: "service-1" },
      scope,
      { leaseOwner: "worker-1", limit: 1, leaseExpiresAt: expires }
    );
    expect(f.bindOutbox).toHaveBeenCalledWith(identity, f.row, {
      ...selected,
      workerInstanceId: "worker-1",
    });
    expect(f.bindOutbox.mock.calls[0]?.[0]).toBe(identity);
    return expect(f.settleOutbox).toHaveBeenCalledWith(
      { actorId: "service-1" },
      scope,
      {
        eventId: f.row.eventId,
        leaseOwner: "worker-1",
        leaseFence: "1",
        result: "published",
        availableAt: at,
      }
    );
  });
  it("same-lease duplicate admission returns a lease, not a completed run", async () => {
    const f = await fixture();
    f.bindOutbox.mockResolvedValue({ ...f.response, status: "duplicate" });
    const result = await createVertexWorkerDispatcher(
      f.dependencies
    ).dispatchClaimed(identity, f.row, options);
    return expect(result).toEqual({
      eventId: f.row.eventId,
      status: "already-admitted",
      settled: true,
      lease: f.lease,
    });
  });
  it.each(["running", "unknown", "succeeded", "cancelled"] as const)(
    "never reissues native work for %s receipt",
    async (state) => {
      const f = await fixture();
      f.bindOutbox.mockResolvedValue({
        ...f.response,
        status:
          state === "succeeded" || state === "cancelled"
            ? "completed"
            : "unknown",
        state,
        lease: null,
      });
      const result = await createVertexWorkerDispatcher(
        f.dependencies
      ).dispatchClaimed(identity, f.row, options);
      expect(result.lease).toBeNull();
      expect(result.settled).toBe(true);
      expect(f.bindOutbox).toHaveBeenCalledTimes(1);
      return expect(f.settleOutbox.mock.calls[0]?.[2].result).toBe("published");
    }
  );
  it("rejects stale duplicate fences without issuing or ACKing a runnable lease", async () => {
    const f = await fixture();
    f.bindOutbox.mockResolvedValue({ ...f.response, status: "duplicate" });
    const result = await createVertexWorkerDispatcher(
      f.dependencies
    ).dispatchClaimed(identity, { ...f.row, leaseFence: "2" }, options);
    expect(result).toMatchObject({
      status: "unknown",
      settled: false,
      lease: null,
    });
    return expect(f.settleOutbox).not.toHaveBeenCalled();
  });
  it("requires exact current owner/scope and denies expired service identities before claiming", async () => {
    const f = await fixture();
    const dispatcher = createVertexWorkerDispatcher(f.dependencies);
    await expect(
      dispatcher.dispatchClaimed(
        identity,
        { ...f.row, leaseOwner: "other-worker" },
        options
      )
    ).rejects.toMatchObject({ code: "denied" });
    await expect(
      dispatcher.claim(
        { ...identity, expiresAt: at },
        {
          ...scope,
          workerInstanceId: "worker-1",
          kinds: ["research-run"],
          limit: 1,
          leaseDurationMs: 1000,
        }
      )
    ).rejects.toMatchObject({ code: "denied" });
    expect(f.claimOutbox).not.toHaveBeenCalled();
    return expect(f.bindOutbox).not.toHaveBeenCalled();
  });
  it("does not invent missing selection or accept conflicting research actor", async () => {
    const f = await fixture();
    const missing = createVertexWorkerDispatcher({
      ...f.dependencies,
      resolveBinding: async () => null,
    });
    expect(
      await missing.dispatchClaimed(identity, f.row, options)
    ).toMatchObject({ status: "unavailable", lease: null });
    const conflict = createVertexWorkerDispatcher({
      ...f.dependencies,
      resolveBinding: async () => ({
        ...selected,
        researchPrincipalId: "other-actor",
      }),
    });
    expect(
      await conflict.dispatchClaimed(identity, f.row, options)
    ).toMatchObject({ status: "rejected", lease: null });
    return expect(f.bindOutbox).not.toHaveBeenCalled();
  });
  it("does not bind after cancellation or deadline and does not return lease on failed ACK", async () => {
    const f = await fixture();
    const controller = new AbortController();
    controller.abort();
    expect(
      await createVertexWorkerDispatcher(f.dependencies).dispatchClaimed(
        identity,
        f.row,
        { ...options, signal: controller.signal }
      )
    ).toMatchObject({ status: "unavailable", lease: null });
    expect(
      await createVertexWorkerDispatcher({
        ...f.dependencies,
        resolveBinding: async () => ({ ...selected, deadlineAt: at }),
      }).dispatchClaimed(identity, f.row, options)
    ).toMatchObject({ status: "rejected", lease: null });
    expect(f.bindOutbox).not.toHaveBeenCalled();
    f.settleOutbox.mockResolvedValue(false);
    return expect(
      await createVertexWorkerDispatcher(f.dependencies).dispatchClaimed(
        identity,
        f.row,
        options
      )
    ).toMatchObject({ status: "unknown", settled: false, lease: null });
  });
  it("handles notification inline without native binding; completed means handled only", async () => {
    const f = await fixture("completed");
    const handle = vi.fn(async () => ({
      status: "completed" as const,
      reason: "processed" as const,
      retryable: false as const,
      results: [],
    }));
    const dispatcher = createVertexWorkerDispatcher({
      ...f.dependencies,
      notifications: {
        dispatch: { handle },
        contextFor: () => ({ trusted: true }),
        select: async () => ({
          kind: "research-completed",
          expiresAt: deadline,
        }),
        dryRun: false,
      },
    });
    expect(
      await dispatcher.dispatchClaimed(identity, f.row, options)
    ).toMatchObject({
      status: "notification-handled",
      settled: true,
      lease: null,
    });
    expect(f.bindOutbox).not.toHaveBeenCalled();
    expect(f.resolveBinding).not.toHaveBeenCalled();
    return expect(handle).toHaveBeenCalledWith(
      { trusted: true },
      {
        eventId: f.row.eventId,
        ...scope,
        kind: "research-completed",
        occurredAt: at,
        expiresAt: deadline,
      },
      { dryRun: false, signal: expect.any(AbortSignal) }
    );
  });
  it("retains unknown notification treatment without retry or native lease", async () => {
    const f = await fixture("completed");
    const handle = vi.fn(async () => {
      throw new Error("provider private detail");
    });
    const dispatcher = createVertexWorkerDispatcher({
      ...f.dependencies,
      notifications: {
        dispatch: { handle },
        contextFor: () => null,
        select: async () => ({
          kind: "research-completed",
          expiresAt: deadline,
        }),
        dryRun: false,
      },
    });
    expect(
      await dispatcher.dispatchClaimed(identity, f.row, options)
    ).toMatchObject({
      status: "notification-unknown",
      settled: true,
      lease: null,
    });
    expect(handle).toHaveBeenCalledTimes(1);
    expect(f.bindOutbox).not.toHaveBeenCalled();
    return expect(f.settleOutbox.mock.calls[0]?.[2].result).toBe("published");
  });
  it("dry-run notification never acknowledges real delivery", async () => {
    const f = await fixture("completed");
    const handle = vi.fn(async () => ({
      status: "completed" as const,
      reason: "processed" as const,
      retryable: false as const,
      results: [],
    }));
    const dispatcher = createVertexWorkerDispatcher({
      ...f.dependencies,
      notifications: {
        dispatch: { handle },
        contextFor: () => null,
        select: async () => ({
          kind: "research-completed",
          expiresAt: deadline,
        }),
        dryRun: true,
      },
    });
    expect(
      await dispatcher.dispatchClaimed(identity, f.row, options)
    ).toMatchObject({
      status: "notification-handled",
      settled: false,
      lease: null,
    });
    return expect(f.settleOutbox).not.toHaveBeenCalled();
  });
  return it("admits explicit paper native bootstrap only with exact command and payload pins", async () => {
    const f = await fixture();
    const boundary = f.dependencies.boundary;
    const paperScope = { ...scope, environment: "paper" as const };
    const paperIdentity = { ...identity, scope: paperScope };
    const payload = {
      format: "vertex-native-bootstrap-job-v1",
      journalIdentity: "journal-1",
      simulatorId: "simulator-1",
      streamId: "stream-1",
      selectionId: selected.policySelectionId,
      selectionSha256: selected.policySelectionSha256,
      mode: "initialize",
    };
    const bootstrapBinding = {
      ...selected,
      kind: "native-bootstrap" as const,
      payloadSha256: await boundary.hash(payload),
    };
    const command = {
      schemaVersion: "1.0.0",
      ...paperScope,
      researchPrincipalId: selected.researchPrincipalId,
      payloadArtifactId: selected.payloadArtifactId,
      payloadSha256: bootstrapBinding.payloadSha256,
      policySelectionId: selected.policySelectionId,
      policySelectionSha256: selected.policySelectionSha256,
      rightsPolicyId: "rights-1",
      rightsVersion: "1",
      issuedAt: at,
      deadlineAt: deadline,
      idempotencyKey: "bootstrap-1",
      payload,
    };
    const eventId = `bootstrap-${await boundary.hash(command)}`;
    const row = {
      ...f.row,
      scope: paperScope,
      eventId,
      eventType: "vertex.native-bootstrap.requested",
      payload: command,
    };
    const lease = { ...f.lease, ...paperScope, ...bootstrapBinding, eventId };
    f.bindOutbox.mockResolvedValue({ ...f.response, lease });
    const dispatcher = createVertexWorkerDispatcher({
      ...f.dependencies,
      resolveBinding: async () => bootstrapBinding,
    });
    expect(
      await dispatcher.dispatchClaimed(paperIdentity, row, {
        workerInstanceId: "worker-1",
        kinds: ["native-bootstrap"],
      })
    ).toMatchObject({ status: "admitted", lease });
    expect(f.bindOutbox.mock.calls[0]?.[0]).toBe(paperIdentity);
    const conflicting = createVertexWorkerDispatcher({
      ...f.dependencies,
      resolveBinding: async () => ({
        ...bootstrapBinding,
        policySelectionId: "other-policy",
      }),
    });
    expect(
      await conflicting.dispatchClaimed(paperIdentity, row, {
        workerInstanceId: "worker-1",
        kinds: ["native-bootstrap"],
      })
    ).toMatchObject({ status: "rejected", lease: null });
    const masquerading = createVertexWorkerDispatcher({
      ...f.dependencies,
      resolveBinding: async () => ({
        ...bootstrapBinding,
        kind: "research-run" as const,
      }),
    });
    return expect(
      await masquerading.dispatchClaimed(paperIdentity, row, {
        workerInstanceId: "worker-1",
        kinds: ["research-run"],
      })
    ).toMatchObject({ status: "rejected", lease: null });
  });
});
