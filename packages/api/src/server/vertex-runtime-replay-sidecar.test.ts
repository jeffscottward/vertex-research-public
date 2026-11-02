import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Transaction } from "@darkfactory/db/server";
import type { PersistenceContext } from "@darkfactory/db/server/vertex-epoch";
import { VertexStoreError } from "@darkfactory/db/server/vertex";
import {
  canonical,
  hashArtifact,
  rawSha,
  timestampToEpochNanoseconds,
} from "./vertex-runtime-epoch-bytes.ts";
import {
  verifyVertexRuntimeNativeOutboxReplay,
  type VertexRuntimeReplayOptions,
} from "./vertex-runtime-replay.ts";

// These deferred wrapper regressions isolate the linkage checks. The shared
// epoch suites separately exercise real Ed25519 and original journal replay;
// mocked proofs below are deliberately NOT production authority providers.
const dependencies = vi.hoisted(() => ({
  parse: vi.fn(),
  grantHash: vi.fn(),
  approval: vi.fn(),
  reconstruct: vi.fn(),
  read: vi.fn(),
  historical: vi.fn(),
}));
vi.mock("../contracts/vertex-worker-epoch.ts", () => ({
  parseNativeOutboxReplay: dependencies.parse,
  computeNativeOutboxReplayGrantHash: dependencies.grantHash,
}));
vi.mock("./vertex-runtime-epoch-approval.ts", () => ({
  verifyVertexNativeApproval: dependencies.approval,
  toVertexVerifiedNativeApproval: vi.fn(),
}));
vi.mock("./vertex-runtime-epoch-evidence.ts", () => ({
  reconstructVertexEpochEvidence: dependencies.reconstruct,
}));
vi.mock("./vertex-runtime-epoch.ts", () => ({
  readVertexEpochEvidenceArtifact: dependencies.read,
}));
vi.mock("./vertex-runtime-epoch-historical.ts", () => ({
  verifyVertexHistoricalEpochTransition: dependencies.historical,
}));

const encode = (value: unknown): string =>
  btoa(
    Array.from(canonical(value), (byte) => String.fromCharCode(byte)).join("")
  );
const at = "2026-09-22T12:00:00.000000000Z";
const issuedNs = timestampToEpochNanoseconds(at).toString();
const expiresNs = (BigInt(issuedNs) + 60_000_000_000n).toString();
const principal = { actorId: "configured-emitter" };
const scope = { accountAlias: "paper-account", environment: "paper" as const };
const digest = (letter: string): string => letter.repeat(64);
const fixture = async (retained = true) => {
  const prior = retained ? "2" : "1";
  const current = retained ? "3" : "2";
  const snapshot = {
    snapshotId: "original-genesis",
    ownerEpoch: prior,
    sequence: "1",
    accountAlias: scope.accountAlias,
    environment: "paper",
    streamId: "paper-stream",
    sourceEventHash: digest("d"),
    cash: "10",
  };
  const original = { transitionId: "original-transition", snapshot };
  const projectionBase64 = encode(snapshot);
  const projectionRawSha256 = await hashArtifact(snapshot);
  const sidecarSha256 = retained ? await hashArtifact(original) : null;
  const approvalBase64 = encode({ payload: { issuedNs, expiresNs } });
  const approval = {
    keyId: "fresh-key",
    signerKeySha256: digest("e"),
    actorId: "human-approver",
    approvalId: "fresh-replay",
    nonce: digest("f"),
    grantId: "enrolled-replay-permission",
    statusRevision: "9",
    statusSha256: digest("9"),
    nativeTransitionSha256: digest("a"),
    approvalSha256: await rawSha(
      canonical({ payload: { issuedNs, expiresNs } })
    ),
    action: "native-outbox-replay",
    expiresNs,
  };
  const grant = {
    schemaVersion: "1.0.0",
    grantId: approval.approvalId,
    accountAlias: scope.accountAlias,
    environment: "paper",
    streamId: "paper-stream",
    priorOwnerEpoch: prior,
    currentOwnerEpoch: current,
    serviceActorId: principal.actorId,
    startingSequence: "0",
    startingEventHash: null,
    journalIdentity: "native-journal",
    journalSequence: "9",
    journalHeadSha256: digest("b"),
    nativeJournalEvidenceSha256: digest("c"),
    nativeOwnerFenceSha256: digest("8"),
    retainedEpochTransitionSha256: sidecarSha256,
    issuedAt: at,
    expiresAt: "2026-09-22T12:01:00.000000000Z",
    rows: [
      {
        projectionId: snapshot.snapshotId,
        sequence: "1",
        eventHash: snapshot.sourceEventHash,
        projectionRawSha256,
        kind: "portfolio-genesis",
        proofSha256: null,
      },
    ],
    approvalBase64,
  };
  const replay = {
    grant,
    retainedEpochTransitionBase64: retained ? encode(original) : null,
    rows: [{ kind: "portfolio-genesis", projectionBase64, proofBase64: null }],
  };
  const genesisEvent = {
    sequence: "8",
    previousHash: digest("7"),
    ownerEpoch: prior,
    eventId: "recorded-genesis",
    occurredNs: issuedNs,
    kind: "portfolio-genesis",
    data: {
      snapshotId: snapshot.snapshotId,
      sequence: snapshot.sequence,
      ownerEpoch: snapshot.ownerEpoch,
      sourceEventHash: snapshot.sourceEventHash,
    },
  };
  const events = [
    {
      sequence: "7",
      eventHash: digest("7"),
      payloadBase64: encode({ prefix: true }),
    },
    {
      sequence: "8",
      eventHash: await hashArtifact(genesisEvent),
      payloadBase64: encode(genesisEvent),
    },
  ];
  const evidence = {
    outbox: {
      accountAlias: scope.accountAlias,
      environment: "paper",
      streamId: grant.streamId,
      priorOwnerEpoch: prior,
      ownerEpoch: current,
      journalIdentity: grant.journalIdentity,
      journalSequence: grant.journalSequence,
      journalHeadSha256: grant.journalHeadSha256,
      simulatorId: "simulator",
      currency: "USD",
      capturedAtNs: issuedNs,
      nativeProofs: [],
      events,
    },
    outboxSha256: grant.nativeJournalEvidenceSha256,
    fenceSha256: grant.nativeOwnerFenceSha256,
    projections: [
      {
        acknowledged: false,
        ownerEpoch: prior,
        kind: "portfolio-genesis",
        sequence: "1",
        eventHash: snapshot.sourceEventHash,
        payloadBase64: projectionBase64,
        payloadSha256: projectionRawSha256,
        projection: snapshot,
      },
    ],
  };
  const historical = {
    historicalOnly: true,
    transitionSha256: sidecarSha256,
    snapshotSha256: projectionRawSha256,
    ownerEpoch: prior,
    journalIdentity: grant.journalIdentity,
    journalSequence: "7",
    journalHeadSha256: digest("7"),
    ratification: approval,
  };
  const ctx = {
    capture: (value: unknown) => structuredClone(value),
    authorize: vi.fn(async () => undefined),
  } as unknown as PersistenceContext;
  const options = {
    authority: {
      policy: {
        simulatorId: "simulator",
        currency: "USD",
        maximumApprovalTtlNs: "60000000000",
      },
    },
    objectCapabilities: vi.fn(),
  } as unknown as VertexRuntimeReplayOptions;
  const tx = {} as Transaction;
  dependencies.parse.mockImplementation(async (input: unknown) => input);
  dependencies.grantHash.mockResolvedValue(digest("a"));
  dependencies.approval.mockResolvedValue(approval);
  dependencies.reconstruct.mockResolvedValue(evidence);
  dependencies.read.mockResolvedValue(canonical({ original: true }));
  dependencies.historical.mockResolvedValue(historical);
  const verify = () =>
    verifyVertexRuntimeNativeOutboxReplay(
      ctx,
      options,
      tx,
      principal,
      scope,
      replay,
      at
    );
  return { replay, original, evidence, historical, approval, verify };
};

beforeEach(() => vi.resetAllMocks());

describe("retained epoch transition replay linkage (deferred)", () => {
  it("returns only the fresh replay proof after exact original sidecar/genesis/journal linkage", async () => {
    const value = await fixture();
    const proof = await value.verify();
    expect(proof.retainedEpochTransitionSha256).toBe(
      value.replay.grant.retainedEpochTransitionSha256
    );
    expect(proof.approval).toEqual(value.approval);
    return expect(dependencies.historical).toHaveBeenCalledTimes(1);
  });

  it("does not invoke historical authority for explicit null sidecars", async () => {
    const value = await fixture(false);
    expect((await value.verify()).retainedEpochTransitionSha256).toBeNull();
    return expect(dependencies.historical).not.toHaveBeenCalled();
  });

  it("rejects changed canonical sidecar bytes even when a historical verifier would accept", async () => {
    const value = await fixture();
    value.replay.retainedEpochTransitionBase64 = encode({
      ...value.original,
      transitionId: "different-transition",
    });
    await expect(value.verify()).rejects.toMatchObject({ code: "integrity" });
    return expect(dependencies.historical).not.toHaveBeenCalled();
  });

  it("rejects an updated sidecar hash when the entire original genesis snapshot differs", async () => {
    const value = await fixture();
    const changed = {
      ...value.original,
      snapshot: { ...value.original.snapshot, cash: "11" },
    };
    value.replay.retainedEpochTransitionBase64 = encode(changed);
    value.replay.grant.retainedEpochTransitionSha256 =
      await hashArtifact(changed);
    await expect(value.verify()).rejects.toMatchObject({ code: "integrity" });
    return expect(dependencies.historical).not.toHaveBeenCalled();
  });

  it("rejects a valid historical proof belonging to another current ratification", async () => {
    const value = await fixture();
    dependencies.historical.mockResolvedValue({
      ...value.historical,
      ratification: { ...value.approval, approvalSha256: digest("6") },
    });
    return await expect(value.verify()).rejects.toMatchObject({
      code: "integrity",
    });
  });

  it("requires the current recorded journal to extend the exact historical head", async () => {
    const value = await fixture();
    value.evidence.outbox.events[0]!.eventHash = digest("5");
    return await expect(value.verify()).rejects.toMatchObject({
      code: "integrity",
    });
  });

  it("requires the exact original genesis immediately after the historical journal head", async () => {
    const value = await fixture();
    value.evidence.outbox.events[1]!.payloadBase64 = encode({
      sequence: "8",
      previousHash: digest("7"),
      ownerEpoch: "2",
      kind: "pause",
      data: {},
    });
    return await expect(value.verify()).rejects.toMatchObject({
      code: "integrity",
    });
  });

  return it("does not fall back to an expired original approval when current revocation rejects it", async () => {
    const value = await fixture();
    dependencies.historical.mockRejectedValue(new VertexStoreError("denied"));
    return await expect(value.verify()).rejects.toMatchObject({
      code: "denied",
    });
  });
});
