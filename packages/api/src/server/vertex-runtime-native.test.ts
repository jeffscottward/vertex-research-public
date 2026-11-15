import { describe, expect, it, vi } from "vitest";
import type { Database, Transaction } from "@darkfactory/db/server";
import {
  createVertexRuntimeNativeProjectionPrincipal,
  vertexRuntimeReplayHeadCandidate,
} from "./vertex-runtime-native.ts";
import {
  canonicalArtifactJson,
  hashArtifact,
} from "@darkfactory/shared/vertex";
import {
  PortfolioSnapshotSchema,
  computePortfolioGenesisHash,
} from "../contracts/vertex-control.ts";
import { NativeOutboxReplayGrantSchema } from "../contracts/vertex-worker-epoch.ts";
import { createVertexRuntimeGateway } from "./vertex-runtime-gateway.ts";
import {
  createVertexRuntimeBootstrapAuthorization,
  vertexNativeBootstrapPermissionResource,
} from "./vertex-runtime-bootstrap.ts";
import type { VertexRuntimePolicy } from "./vertex-runtime-policy.ts";

const now = "2026-01-01T00:00:00Z";
const clock = { now: () => now };
const scope = { accountAlias: "account", environment: "paper" as const };
const hash = "a".repeat(64);
const lease = {
  schemaVersion: "1.0.0",
  jobId: "job",
  eventId: "event",
  kind: "native-bootstrap",
  researchPrincipalId: "research-user",
  ...scope,
  payloadArtifactId: "payload",
  payloadSha256: hash,
  policySelectionId: "selection",
  policySelectionSha256: hash,
  deadlineAt: "2026-01-01T00:10:00Z",
  leaseId: "worker",
  leaseEpoch: "1",
  leaseExpiresAt: "2026-01-01T00:05:00Z",
  attempt: 1,
};
const identity = {
  grantId: "grant",
  servicePrincipalId: "native-service",
  scope,
  expiresAt: "2026-01-01T00:10:00Z",
};
const snapshot = { ...scope, streamId: "stream", ownerEpoch: "1" };
describe("Vertex independent native runtime authority", () => {
  it("does not infer an emitter from a research principal or worker bearer", async () => {
    const execute = vi.fn();
    const policySelection = vi.fn();
    const resolve = createVertexRuntimeNativeProjectionPrincipal({
      clock,
      emitterBindings: [],
      policySelection,
    });
    await expect(
      resolve(
        { execute } as unknown as Transaction,
        identity,
        lease,
        "publishGenesis",
        snapshot
      )
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(execute).not.toHaveBeenCalled();
    return expect(policySelection).not.toHaveBeenCalled();
  });
  it("never handles order submission or generic worker methods", async () => {
    const execute = vi.fn();
    const resolve = createVertexRuntimeNativeProjectionPrincipal({
      clock,
      emitterBindings: [],
      policySelection: vi.fn(),
    });
    for (const operation of ["claim", "submitOrder", "rearm", "issueGrant"]) {
      await expect(
        resolve(
          { execute } as unknown as Transaction,
          identity,
          lease,
          operation,
          snapshot
        )
      ).rejects.toMatchObject({ code: "denied" });
    }
    return expect(execute).not.toHaveBeenCalled();
  });
  it("refuses aborted native projection before persistence", async () => {
    const abort = new AbortController();
    abort.abort();
    const execute = vi.fn();
    const resolve = createVertexRuntimeNativeProjectionPrincipal({
      clock,
      signal: abort.signal,
      emitterBindings: [],
      policySelection: vi.fn(),
    });
    await expect(
      resolve(
        { execute } as unknown as Transaction,
        identity,
        lease,
        "publishGenesis",
        snapshot
      )
    ).rejects.toMatchObject({ code: "unavailable" });
    return expect(execute).not.toHaveBeenCalled();
  });
  it("requires server-session bootstrap identity and keeps permission keys bounded", async () => {
    const execute = vi.fn();
    const materialize = vi.fn();
    const serverPrincipal = vi.fn(async () => null);
    const permissions = createVertexRuntimeBootstrapAuthorization({
      clock,
      consumerServiceId: "control",
      serverPrincipal,
      materialize,
    });
    expect(
      await permissions.authorizeBootstrapEnqueue(
        {},
        { execute } as unknown as Transaction,
        scope,
        {}
      )
    ).toBe(false);
    expect(execute).not.toHaveBeenCalled();
    expect(materialize).not.toHaveBeenCalled();
    const resource = await vertexNativeBootstrapPermissionResource(
      "j".repeat(160)
    );
    expect(resource).toMatch(/^native-bootstrap:[0-9a-f]{64}$/);
    return expect(
      await vertexNativeBootstrapPermissionResource("other")
    ).not.toBe(resource);
  });
  it("requires the exact grant operation before resolving policy selection", async () => {
    const binding = {
      format: "vertex-native-emitter-binding-v1",
      ...scope,
      referenceId: "reference",
      servicePrincipalId: identity.servicePrincipalId,
      actorId: "native-actor",
      streamId: snapshot.streamId,
      ownerEpoch: snapshot.ownerEpoch,
      validFrom: "2025-12-31T00:00:00Z",
      expiresAt: "2026-01-02T00:00:00Z",
    } as const;
    const resolveWith = async (operations: string[]) => {
      const grant = {
        grantId: identity.grantId,
        servicePrincipalId: identity.servicePrincipalId,
        ...scope,
        operations,
        issuedAt: "2025-12-31T00:00:00Z",
        expiresAt: "2026-01-02T00:00:00Z",
        revokedAt: null,
      };
      const results = [
        [
          {
            payload: lease,
            state: "running",
            grant_id: identity.grantId,
            worker_instance_id: lease.leaseId,
            lease_id: lease.leaseId,
            lease_epoch: lease.leaseEpoch,
          },
        ],
        [
          {
            payload: grant,
            record_hash: await hashArtifact(grant),
            revoked_at: null,
          },
        ],
      ];
      const execute = vi.fn(async () => ({ rows: results.shift() ?? [] }));
      const policySelection = vi.fn(async () => {
        throw new Error("synthetic selection outage");
      });
      const resolve = createVertexRuntimeNativeProjectionPrincipal({
        clock,
        emitterBindings: [binding],
        policySelection,
      });
      const outcome = resolve(
        { execute } as unknown as Transaction,
        identity,
        lease,
        "publishGenesis",
        snapshot
      );
      return { outcome, execute, policySelection };
    };
    const missing = await resolveWith(["publishPortfolioSnapshot"]);
    await expect(missing.outcome).rejects.toMatchObject({ code: "denied" });
    expect(missing.execute).toHaveBeenCalledTimes(2);
    expect(missing.policySelection).not.toHaveBeenCalled();
    const granted = await resolveWith(["publishGenesis"]);
    await expect(granted.outcome).rejects.toMatchObject({
      code: "unavailable",
    });
    return expect(granted.policySelection).toHaveBeenCalledTimes(1);
  });
  return it("requires explicit unambiguous gateway scope without probing a broker", async () => {
    const execute = vi.fn();
    const transaction = vi.fn();
    const observedClock = vi.fn(() => now);
    const policy = {} as VertexRuntimePolicy;
    const bindings = ["one", "two"].map((accountAlias) => ({
      accountAlias,
      environment: "paper" as const,
      gatewayId: "same-gateway",
      observationBindingId: "receipt",
      producerActorId: "native-service",
      maximumAgeMilliseconds: 1000,
    }));
    const gateway = createVertexRuntimeGateway({
      db: { execute, transaction } as unknown as Database,
      policy,
      clock: { now: observedClock },
      consumerServiceId: "control",
      bindings,
    });
    expect(await gateway.resolveScope("same-gateway", "paper")).toBeNull();
    expect(await gateway.resolveScope("same-gateway", "live")).toBeNull();
    expect(await gateway.listBindings()).toEqual([]);
    const single = createVertexRuntimeGateway({
      db: { execute, transaction } as unknown as Database,
      policy,
      clock: { now: observedClock },
      consumerServiceId: "control",
      bindings: [
        {
          accountAlias: "one",
          environment: "paper",
          gatewayId: "own-gateway",
          observationBindingId: "receipt",
          producerActorId: "native-service",
          maximumAgeMilliseconds: 1000,
        },
        ...bindings,
      ],
    });
    expect(await single.listBindings()).toEqual([
      { gatewayId: "own-gateway", environment: "paper", accountAlias: "one" },
    ]);
    expect(observedClock).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    return expect(transaction).not.toHaveBeenCalled();
  });
});

// These are structural-only fixtures, not signed authority or enrollment.
// All regression execution remains deferred.
const retainedHeadFixture = async () => {
  const projectionScope = { ...scope, streamId: "stream", ownerEpoch: "2" };
  const seed = PortfolioSnapshotSchema.parse({
    schemaVersion: "1.0.0",
    snapshotId: "retained-genesis",
    ...projectionScope,
    sequence: "1",
    sourceEventHash: hash,
    sourceKind: "paper-simulation",
    asOfAt: now,
    receivedAt: now,
    currency: "USD",
    cash: "10",
    netAssetValue: null,
    positions: [],
    lots: [],
    reservations: [],
    sleeveAllocations: [],
    continuity: {
      ...projectionScope,
      highWaterSequence: "1",
      highWaterEventHash: hash,
      lastOccurredAt: now,
      lastReceivedAt: now,
      evaluatedAt: now,
      freshness: {
        status: "fresh",
        observedAt: now,
        evaluatedAt: now,
        maxAgeMs: 60_000,
      },
      state: "continuous",
      expectedNextSequence: "2",
      receivedSequence: null,
      newRiskInhibited: true,
      authoritative: false,
    },
    observationOnly: true,
    executionAuthorized: false,
    researchNotionalIncluded: false,
  });
  const genesisHash = await computePortfolioGenesisHash(seed);
  const snapshot = {
    ...seed,
    sourceEventHash: genesisHash,
    continuity: { ...seed.continuity, highWaterEventHash: genesisHash },
  };
  const transition = {
    schemaVersion: "1.0.0",
    transitionId: "retained-transition",
    snapshot,
    priorOwnerEpoch: "1",
    priorProjectionSequence: "7",
    priorProjectionHash: "b".repeat(64),
    journalIdentity: "journal",
    journalSequence: "9",
    journalHeadSha256: hash,
    nativeOutboxEvidenceSha256: hash,
    nativeOwnerFenceSha256: hash,
    approvalBase64: btoa("{}"),
  };
  const transitionText = canonicalArtifactJson(transition);
  const snapshotText = canonicalArtifactJson(snapshot);
  const replay = NativeOutboxReplayGrantSchema.parse({
    schemaVersion: "1.0.0",
    grantId: "fresh-replay",
    ...scope,
    streamId: "stream",
    priorOwnerEpoch: "2",
    currentOwnerEpoch: "3",
    serviceActorId: "native-emitter",
    startingSequence: "0",
    startingEventHash: null,
    journalIdentity: "journal",
    journalSequence: "12",
    journalHeadSha256: hash,
    nativeJournalEvidenceSha256: hash,
    nativeOwnerFenceSha256: hash,
    retainedEpochTransitionSha256: await hashArtifact(
      new TextEncoder().encode(transitionText)
    ),
    issuedAt: now,
    expiresAt: "2026-01-01T00:05:00Z",
    approvalBase64: btoa("{}"),
    rows: [
      {
        kind: "portfolio-genesis",
        projectionId: snapshot.snapshotId,
        sequence: "1",
        eventHash: genesisHash,
        projectionRawSha256: await hashArtifact(
          new TextEncoder().encode(snapshotText)
        ),
        proofSha256: null,
      },
    ],
  });
  const command = {
    grant: replay,
    retainedEpochTransitionBase64: btoa(transitionText),
    rows: [
      {
        kind: "portfolio-genesis",
        projectionBase64: btoa(snapshotText),
        proofBase64: null,
      },
    ],
  };
  const head = {
    owner_epoch: "1",
    high_water_sequence: "7",
    high_water_event_hash: transition.priorProjectionHash,
  };
  return { replay, command, head, transition, snapshot };
};

describe("retained-transition emitter precheck without signature authority", () => {
  it("admits only the exact original cloud predecessor while retaining actual owner3", async () => {
    const value = await retainedHeadFixture();
    expect(
      await vertexRuntimeReplayHeadCandidate(
        value.head,
        value.replay,
        value.command
      )
    ).toBe(true);
    expect(value.replay.currentOwnerEpoch).toBe("3");
    return expect(value.head.owner_epoch).toBe("1");
  });
  it.each([
    { owner_epoch: "3" },
    { owner_epoch: "0" },
    { high_water_sequence: "6" },
    { high_water_event_hash: "c".repeat(64) },
  ])("rejects a different predecessor or newer head %j", async (change) => {
    const value = await retainedHeadFixture();
    return expect(
      await vertexRuntimeReplayHeadCandidate(
        { ...value.head, ...change },
        value.replay,
        value.command
      )
    ).toBe(false);
  });
  it("never treats retained transition bytes as seed admission", async () => {
    const value = await retainedHeadFixture();
    return expect(
      await vertexRuntimeReplayHeadCandidate(
        undefined,
        value.replay,
        value.command
      )
    ).toBe(false);
  });
  it("leaves already-applied old-epoch exact replay verification to State", async () => {
    const value = await retainedHeadFixture();
    return expect(
      await vertexRuntimeReplayHeadCandidate(
        {
          owner_epoch: "2",
          high_water_sequence: "1",
          high_water_event_hash: value.snapshot.sourceEventHash,
        },
        value.replay,
        value.command
      )
    ).toBe(true);
  });
  it("rejects missing sidecars, changed raw bytes, unmatched grants and changed first genesis", async () => {
    const value = await retainedHeadFixture();
    for (const change of [
      { retainedEpochTransitionBase64: null },
      { retainedEpochTransitionBase64: btoa("{}") },
      { grant: { ...value.replay, grantId: "different-replay" } },
      { rows: [] },
      { rows: [{ ...value.command.rows[0]!, projectionBase64: btoa("{}") }] },
    ]) {
      expect(
        await vertexRuntimeReplayHeadCandidate(value.head, value.replay, {
          ...value.command,
          ...change,
        })
      ).toBe(false);
    }
  });
  it("rejects noncanonical original wrapper bytes even with a matching raw SHA", async () => {
    const value = await retainedHeadFixture();
    const text = ` ${canonicalArtifactJson(value.transition)}`;
    const replay = {
      ...value.replay,
      retainedEpochTransitionSha256: await hashArtifact(
        new TextEncoder().encode(text)
      ),
    };
    return expect(
      await vertexRuntimeReplayHeadCandidate(value.head, replay, {
        ...value.command,
        grant: replay,
        retainedEpochTransitionBase64: btoa(text),
      })
    ).toBe(false);
  });
  return it("retains normal replay head rules when no sidecar was independently bound", async () => {
    const value = await retainedHeadFixture();
    const replay = { ...value.replay, retainedEpochTransitionSha256: null };
    const command = {
      ...value.command,
      grant: replay,
      retainedEpochTransitionBase64: null,
    };
    expect(
      await vertexRuntimeReplayHeadCandidate(value.head, replay, command)
    ).toBe(false);
    expect(
      await vertexRuntimeReplayHeadCandidate(undefined, replay, command)
    ).toBe(true);
    expect(
      await vertexRuntimeReplayHeadCandidate(
        { owner_epoch: "2" },
        replay,
        command
      )
    ).toBe(true);
    return expect(
      await vertexRuntimeReplayHeadCandidate(
        { owner_epoch: "3" },
        replay,
        command
      )
    ).toBe(false);
  });
});
