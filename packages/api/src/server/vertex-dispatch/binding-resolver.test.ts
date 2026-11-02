import { describe, expect, it } from "vitest";
import { createVertexWorkerDispatchBoundary } from "../vertex-worker-service.ts";
import {
  createVertexWorkerPinnedBindingResolver,
  hashVertexWorkerCommand,
} from "./binding-resolver.ts";
import type { VertexWorkerCommand } from "./dispatcher.ts";
import type { WorkerServiceIdentity } from "@darkfactory/db/server/vertex-worker";
import type { VertexOutboxLease } from "@darkfactory/db/server/vertex";

const scope = { accountAlias: "account-1", environment: "research" as const };
const deadline = "2026-09-22T13:00:00.000Z";
const identity: WorkerServiceIdentity = {
  grantId: "grant-1",
  servicePrincipalId: "service-1",
  scope,
  expiresAt: deadline,
};
const event = {
  eventId: `event-${"a".repeat(64)}`,
  eventType: "agent.recorded",
  actorId: "actor-1",
  environment: "research",
  occurredAt: "2026-09-22T12:00:00.000Z",
  receivedAt: "2026-09-22T12:00:00.000Z",
  payload: { runId: "run-1", status: "queued" },
};
const command: VertexWorkerCommand = { kind: "queued-agent", event };
const lease: VertexOutboxLease = {
  eventId: event.eventId,
  scope,
  collectionId: "collection-1",
  eventType: event.eventType,
  payload: event,
  leaseOwner: "worker-1",
  leaseFence: "1",
  leaseExpiresAt: deadline,
};
const binding = {
  kind: "research-run" as const,
  researchPrincipalId: "actor-1",
  payloadArtifactId: "sealed-bundle-1",
  payloadSha256: "b".repeat(64),
  policySelectionId: "selection-1",
  policySelectionSha256: "c".repeat(64),
  deadlineAt: deadline,
};
const signal = new AbortController().signal;

describe("immutable configured worker selection", () => {
  it("requires exact scope/event/canonical command pins and snapshots configuration", async () => {
    const boundary = createVertexWorkerDispatchBoundary();
    const pin = {
      scope: { ...scope },
      eventId: event.eventId,
      commandSha256: await hashVertexWorkerCommand(boundary, command),
      binding: { ...binding },
    };
    const resolve = createVertexWorkerPinnedBindingResolver({
      boundary,
      pins: [pin],
    });
    pin.binding.policySelectionId = "changed-after-construction";
    pin.scope.accountAlias = "changed-after-construction";
    expect(await resolve({ identity, lease, command, signal })).toEqual(
      binding
    );
    expect(
      await resolve({
        identity,
        lease: { ...lease, eventId: "different-event" },
        command,
        signal,
      })
    ).toBeNull();
    return await expect(
      resolve({
        identity,
        lease,
        command: {
          ...command,
          event: {
            ...event,
            payload: { ...event.payload, runId: "other-run" },
          },
        },
        signal,
      })
    ).rejects.toMatchObject({ code: "invalid" });
  });
  it("never substitutes an active policy head for absent selection", async () => {
    const resolve = createVertexWorkerPinnedBindingResolver({
      boundary: createVertexWorkerDispatchBoundary(),
      pins: [],
    });
    return expect(
      await resolve({ identity, lease, command, signal })
    ).toBeNull();
  });
  it("excludes consumer receivedAt only and preserves producer fields in command hash", async () => {
    const boundary = createVertexWorkerDispatchBoundary();
    const hash = await hashVertexWorkerCommand(boundary, command);
    expect(
      await hashVertexWorkerCommand(boundary, {
        kind: "queued-agent",
        event: { ...event, receivedAt: deadline },
      })
    ).toBe(hash);
    return expect(
      await hashVertexWorkerCommand(boundary, {
        kind: "queued-agent",
        event: { ...event, actorId: "other-actor" },
      })
    ).not.toBe(hash);
  });
  return it("rejects conflicting duplicate pin keys and denies cross-scope lookup", async () => {
    const boundary = createVertexWorkerDispatchBoundary();
    const pin = {
      scope,
      eventId: event.eventId,
      commandSha256: await hashVertexWorkerCommand(boundary, command),
      binding,
    };
    expect(() =>
      createVertexWorkerPinnedBindingResolver({
        boundary,
        pins: [
          pin,
          {
            ...pin,
            binding: { ...binding, policySelectionId: "other-policy" },
          },
        ],
      })
    ).toThrow("Worker dispatch invalid");
    const resolve = createVertexWorkerPinnedBindingResolver({
      boundary,
      pins: [pin],
    });
    return await expect(
      resolve({
        identity: {
          ...identity,
          scope: { ...scope, accountAlias: "other-account" },
        },
        lease,
        command,
        signal,
      })
    ).rejects.toMatchObject({ code: "denied" });
  });
});
