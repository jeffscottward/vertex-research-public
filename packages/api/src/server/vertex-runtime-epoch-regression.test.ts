import { describe, expect, it, vi } from "vitest";
import {
  canonical,
  canonicalRecord,
  decodeBase64,
  hashArtifact,
  rawSha,
} from "./vertex-runtime-epoch-bytes.ts";
import {
  applyNativeEpochEvent,
  initialNativeEpochState,
} from "./vertex-runtime-epoch-replay.ts";
import { reconstructVertexEpochEvidence } from "./vertex-runtime-epoch-evidence.ts";
import { verifyVertexEpochApproval } from "./vertex-runtime-epoch-approval.ts";
import { createVertexRuntimeEpochOperations } from "./vertex-runtime-epoch.ts";
import type { PersistenceContext } from "@darkfactory/db/server/vertex-epoch";

// Authored only: execution is deliberately deferred to the final validation
// phase. Everything below is synthetic; no configured key/account/grant exists.
const base64 = (bytes: Uint8Array): string =>
  btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""));
const stamp = "2026-01-01T00:00:00.000000000Z";
const now = 1_767_225_600_000_000_000n;
const fixture = async (strandedOwner = false) => {
  const accountAlias = "fixture-account";
  const simulatorId = "fixture-simulator";
  const streamId = "fixture-stream";
  const state = initialNativeEpochState(accountAlias, simulatorId, "USD");
  const initialState = structuredClone(state);
  const events: any[] = [];
  const checkpoints: any[] = [];
  let previous = "0".repeat(64);
  const append = async (kind: string, data: Record<string, unknown>) => {
    const sequence = (events.length + 1).toString();
    const eventId = `fixture-event-${sequence}`;
    const event = {
      sequence,
      previousHash: previous,
      ownerEpoch: state["ownerEpoch"],
      eventId,
      occurredNs: now.toString(),
      kind,
      data,
    };
    const bytes = canonical(event);
    const eventHash = await rawSha(bytes);
    events.push({
      sequence,
      eventId,
      previousHash: previous,
      eventHash,
      payloadBase64: base64(bytes),
    });
    applyNativeEpochEvent(state, event);
    checkpoints.push({
      sequence,
      eventHash,
      stateHash: await hashArtifact(state),
      payloadBase64: base64(canonical(state)),
    });
    previous = eventHash;
    return events.at(-1);
  };
  const observation = {
    observationId: "fixture-observation",
    sourceSequence: "1",
    observedNs: now.toString(),
    receivedNs: now.toString(),
    validUntilNs: (now + 60_000_000_000n).toString(),
    cash: "10",
    positions: {},
    evidenceSha256: "a".repeat(64),
  };
  await append("epoch-claimed", { epoch: "1" });
  await append("observation", observation);
  await append("reconciled", {});
  const scope = {
    accountAlias,
    environment: "paper",
    streamId,
    ownerEpoch: "1",
  };
  const snapshot: any = {
    schemaVersion: "1.0.0",
    snapshotId: "fixture-genesis",
    ...scope,
    sequence: "1",
    sourceKind: "paper-simulation",
    asOfAt: stamp,
    receivedAt: stamp,
    currency: "USD",
    cash: "10",
    netAssetValue: null,
    positions: [],
    lots: [],
    reservations: [],
    sleeveAllocations: [],
    continuity: {
      ...scope,
      highWaterSequence: "1",
      lastOccurredAt: stamp,
      lastReceivedAt: stamp,
      evaluatedAt: stamp,
      freshness: {
        status: "fresh",
        observedAt: stamp,
        evaluatedAt: stamp,
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
  };
  const sourceHash = await hashArtifact(snapshot);
  snapshot.sourceEventHash = sourceHash;
  snapshot.continuity.highWaterEventHash = sourceHash;
  await append("portfolio-genesis", {
    snapshotId: snapshot.snapshotId,
    sequence: "1",
    ownerEpoch: "1",
    sourceEventHash: sourceHash,
  });
  const priorStateSha256 = await hashArtifact(state);
  let claim = await append("epoch-claimed", { epoch: "2" });
  if (strandedOwner) claim = await append("epoch-claimed", { epoch: "3" });
  await append("observation", {
    ...observation,
    observationId: "fixture-restored-observation",
    sourceSequence: "2",
  });
  await append("reconciled", {});
  const outbox: any = {
    format: "vertex-native-outbox-evidence-v1",
    journalIdentity: "fixture-journal",
    accountAlias,
    environment: "paper",
    simulatorId,
    currency: "USD",
    streamId,
    priorOwnerEpoch: "1",
    priorProjectionSequence: "1",
    priorProjectionHash: sourceHash,
    ownerEpoch: "2",
    journalSequence: events.length.toString(),
    journalHeadSha256: previous,
    capturedAtNs: now.toString(),
    initialState,
    priorStateSha256,
    currentStateSha256: await hashArtifact(state),
    metadata: [
      { key: "epoch", value: "2" },
      {
        key: "scope",
        value: new TextDecoder().decode(canonical(initialState)),
      },
    ],
    events,
    checkpoints,
    projections: [
      {
        publicationSequence: "1",
        ownerEpoch: "1",
        sequence: "1",
        eventHash: sourceHash,
        kind: "portfolio-genesis",
        acknowledged: true,
        payloadBase64: base64(canonical(snapshot)),
      },
    ],
    nativeProofs: [],
    nativeFactIdentities: [],
  };
  outbox.ownerEpoch = state["ownerEpoch"];
  outbox.metadata[0].value = state["ownerEpoch"];
  const outboxBytes = canonical(outbox);
  const stat = {
    device: "1",
    inode: "1",
    mode: "0600",
    linkCount: "1",
    ownerUid: "1000",
  };
  const fence: any = {
    format: "vertex-native-owner-fence-v1",
    journalIdentity: outbox.journalIdentity,
    accountAlias,
    environment: "paper",
    simulatorId,
    streamId,
    priorOwnerEpoch: "1",
    ownerEpoch: "2",
    journalSequence: outbox.journalSequence,
    journalHeadSha256: previous,
    capturedAtNs: now.toString(),
    nativeOutboxEvidenceSha256: await rawSha(outboxBytes),
    claimSequence: claim.sequence,
    claimEventHash: claim.eventHash,
    claimPayloadBase64: claim.payloadBase64,
    processId: "123",
    ownerUid: "1000",
    lockFile: stat,
    journalFile: { ...stat, inode: "2" },
  };
  fence.ownerEpoch = state["ownerEpoch"];
  return { outbox, fence, outboxBytes, fenceBytes: canonical(fence) };
};

describe("concrete native epoch evidence", () => {
  it("reconstructs every original checkpoint and exact fully ACKed old head", async () => {
    const value = await fixture();
    const proof = await reconstructVertexEpochEvidence(
      value.outboxBytes,
      value.fenceBytes,
      now
    );
    expect(proof.state["ownerEpoch"]).toBe("2");
    expect(proof.priorState["ownerEpoch"]).toBe("1");
    expect(proof.state["cash"]).toBe(proof.priorState["cash"]);
    return expect(proof.projections[0]?.["acknowledged"]).toBe(true);
  });
  it("preserves a stranded empty claim and fences the final native owner", async () => {
    const value = await fixture(true);
    const proof = await reconstructVertexEpochEvidence(
      value.outboxBytes,
      value.fenceBytes,
      now
    );
    expect(proof.state["ownerEpoch"]).toBe("3");
    expect(proof.priorState["ownerEpoch"]).toBe("1");
    expect(proof.fence["claimSequence"]).toBe("6");
    return expect(
      proof.projections.every((row) => row["ownerEpoch"] === "1")
    ).toBe(true);
  });
  it.each(["outboxDrained", "callerVerified", "signatureValid"])(
    "rejects caller proof assertion %s",
    async (flag) => {
      const value = await fixture();
      value.outbox[flag] = true;
      return await expect(
        reconstructVertexEpochEvidence(
          canonical(value.outbox),
          value.fenceBytes,
          now
        )
      ).rejects.toThrow();
    }
  );
  it("rejects unacknowledged original rows even if outbox hashes are supplied", async () => {
    const value = await fixture();
    value.outbox.projections[0].acknowledged = false;
    return await expect(
      reconstructVertexEpochEvidence(
        canonical(value.outbox),
        value.fenceBytes,
        now
      )
    ).rejects.toThrow();
  });
  it("permits parsing pending history ONLY in explicit replay mode", async () => {
    const value = await fixture();
    value.outbox.projections[0].acknowledged = false;
    const bytes = canonical(value.outbox);
    value.fence.nativeOutboxEvidenceSha256 = await rawSha(bytes);
    const proof = await reconstructVertexEpochEvidence(
      bytes,
      canonical(value.fence),
      now,
      false
    );
    return expect(proof.projections[0]?.["acknowledged"]).toBe(false);
  });
  it("rejects altered original checkpoint and noncanonical row bytes", async () => {
    const value = await fixture();
    value.outbox.checkpoints[0].payloadBase64 = base64(
      canonical({ cash: "999" })
    );
    return await expect(
      reconstructVertexEpochEvidence(
        canonical(value.outbox),
        value.fenceBytes,
        now
      )
    ).rejects.toThrow();
  });
  it("rejects economic reseeding across native restart", () => {
    const state = initialNativeEpochState(
      "fixture-account",
      "fixture-simulator",
      "USD"
    );
    applyNativeEpochEvent(state, {
      kind: "observation",
      data: { sourceSequence: "1", cash: "10", positions: {} },
    });
    return expect(() =>
      applyNativeEpochEvent(state, {
        kind: "observation",
        data: { sourceSequence: "2", cash: "11", positions: {} },
      })
    ).toThrow();
  });
  it("rejects changed fence inode provenance and unsafe permissions", async () => {
    const value = await fixture();
    value.fence.lockFile.mode = "0644";
    return await expect(
      reconstructVertexEpochEvidence(
        value.outboxBytes,
        canonical(value.fence),
        now
      )
    ).rejects.toThrow();
  });
  return it("rejects wrong prior ACK head rather than trusting native boolean", async () => {
    const value = await fixture();
    value.outbox.priorProjectionHash = "f".repeat(64);
    return await expect(
      reconstructVertexEpochEvidence(
        canonical(value.outbox),
        value.fenceBytes,
        now
      )
    ).rejects.toThrow();
  });
});

describe("native canonical and authority boundaries", () => {
  it.each(['{"a":1,"a":2}', '{ "a":1}', '{"a":"\\u0061"}', '{"__proto__":{}}'])(
    "rejects noncanonical or prototype source %s",
    (source) => {
      return expect(() =>
        canonicalRecord(new TextEncoder().encode(source))
      ).toThrow();
    }
  );
  it("rejects oversized/base64 aliases", () => {
    expect(() => decodeBase64("YQ", 1)).toThrow();
    expect(() => decodeBase64("YR==", 1)).toThrow();
    return expect(() => decodeBase64("YWE=", 1)).toThrow();
  });
  it("fails unavailable without user-owned authority before signature acceptance", async () => {
    // The paper-only subject guard runs first and fails closed as integrity;
    // a paper subject isolates the missing-authority boundary under test.
    await expect(
      verifyVertexEpochApproval(undefined, "e30=", {}, "fixture-actor", now)
    ).rejects.toMatchObject({ code: "integrity" });
    return await expect(
      verifyVertexEpochApproval(
        undefined,
        "e30=",
        { environment: "paper" },
        "fixture-actor",
        now
      )
    ).rejects.toMatchObject({ code: "unavailable" });
  });
  return it("factory construction performs no authorization, DB, crypto or storage effect", () => {
    const ctx = new Proxy(
      {},
      {
        get: () => {
          throw new Error("factory must not read context");
        },
      }
    ) as PersistenceContext;
    const capabilities = vi.fn(() => {
      throw new Error("factory must not open storage");
    });
    const operations = createVertexRuntimeEpochOperations(ctx, {
      objectCapabilities: capabilities,
    });
    expect(typeof operations.epochTransition).toBe("function");
    return expect(capabilities).not.toHaveBeenCalled();
  });
});
