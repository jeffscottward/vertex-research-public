import { describe, expect, it } from "vitest";
import {
  canonicalArtifactJson,
  hashArtifact,
} from "@darkfactory/shared/vertex";
import {
  PortfolioSnapshotSchema,
  computePortfolioGenesisHash,
} from "./vertex-control.ts";
import {
  PortfolioEpochTransitionSchema,
  NativeOutboxReplayGrantSchema,
  NativeOutboxReplaySchema,
  VERTEX_EPOCH_CONTRACT_SCHEMAS,
  computePortfolioEpochTransitionHash,
  computeNativeOutboxReplayGrantHash,
  parsePortfolioEpochTransition,
  parseNativeOutboxReplay,
} from "./vertex-worker-epoch.ts";

const sha = "a".repeat(64);
const at = "2026-09-22T12:00:00.000000001Z";
const scope = {
  accountAlias: "synthetic-paper",
  environment: "paper",
  streamId: "restored-stream",
  ownerEpoch: "2",
} as const;
const fixture = async () => {
  const snapshot = PortfolioSnapshotSchema.parse({
    schemaVersion: "1.0.0",
    snapshotId: "restored-epoch-2",
    ...scope,
    sequence: "1",
    sourceEventHash: sha,
    sourceKind: "paper-simulation",
    asOfAt: at,
    receivedAt: at,
    currency: "USD",
    cash: "80",
    netAssetValue: "100",
    positions: [],
    lots: [],
    reservations: [],
    sleeveAllocations: [],
    continuity: {
      ...scope,
      highWaterSequence: "1",
      highWaterEventHash: sha,
      lastOccurredAt: at,
      lastReceivedAt: at,
      evaluatedAt: at,
      freshness: {
        status: "fresh",
        observedAt: at,
        evaluatedAt: at,
        maxAgeMs: 1000,
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
  const genesisHash = await computePortfolioGenesisHash(snapshot);
  return {
    schemaVersion: "1.0.0",
    transitionId: "transition-2",
    snapshot: {
      ...snapshot,
      sourceEventHash: genesisHash,
      continuity: { ...snapshot.continuity, highWaterEventHash: genesisHash },
    },
    priorOwnerEpoch: "1",
    priorProjectionSequence: "9007199254740993",
    priorProjectionHash: sha,
    journalIdentity: "journal-1",
    journalSequence: "9007199254740999",
    journalHeadSha256: sha,
    nativeOutboxEvidenceSha256: "b".repeat(64),
    nativeOwnerFenceSha256: "c".repeat(64),
    approvalBase64: "e30=",
  };
};

// Syntax/hash tests only; the synthetic bytes are NOT signed human approval.
// Actual permission and native evidence verification belongs to the separately
// injected enrolled-signer verifier and is mandatory at persistence time.
// Authored under build-first sequencing; unexecuted.
describe("explicit portfolio owner epoch transition envelope", () => {
  it("registers strict additive epoch and replay contracts and retains restored balance", async () => {
    const input = await fixture();
    const value = await parsePortfolioEpochTransition(input);
    expect(Object.keys(VERTEX_EPOCH_CONTRACT_SCHEMAS)).toEqual([
      "PortfolioEpochTransition",
      "NativeOutboxReplayGrant",
      "NativeOutboxReplay",
    ]);
    expect(value.snapshot.cash).toBe("80");
    expect(value.priorProjectionSequence).toBe("9007199254740993");
    expect(value.journalSequence).toBe("9007199254740999");
    expect(Object.isFrozen(value.snapshot.continuity)).toBe(true);
    return expect(await computePortfolioEpochTransitionHash(input)).toBe(
      await hashArtifact(value)
    );
  });

  it("rejects implicit approvals reseeding flags drain assertions and extra epoch fields", async () => {
    const input = await fixture();
    for (const extra of [
      { nativeOutboxDrained: true },
      { executionAuthorized: true },
      { currentOwnerEpoch: "2" },
      { seedCapital: "100" },
      { callerApproved: true },
    ]) {
      expect(
        PortfolioEpochTransitionSchema.safeParse({ ...input, ...extra }).success
      ).toBe(false);
    }

    for (const field of [
      "nativeOutboxEvidenceSha256",
      "nativeOwnerFenceSha256",
      "approvalBase64",
      "priorProjectionHash",
    ]) {
      const missing = { ...input } as Record<string, unknown>;
      delete missing[field];
      expect(PortfolioEpochTransitionSchema.safeParse(missing).success).toBe(
        false
      );
    }
  });

  it("requires a strictly increased epoch and explicit first newepoch snapshot", async () => {
    const input = await fixture();
    for (const priorOwnerEpoch of ["0", "2", "3", "01", 1]) {
      expect(
        PortfolioEpochTransitionSchema.safeParse({ ...input, priorOwnerEpoch })
          .success
      ).toBe(false);
    }

    for (const change of [
      { sequence: "2" },
      { environment: "live" },
      { sourceKind: "broker-observation" },
    ]) {
      expect(
        PortfolioEpochTransitionSchema.safeParse({
          ...input,
          snapshot: { ...input.snapshot, ...change },
        }).success
      ).toBe(false);
    }
  });

  it("accepts only canonical bounded approval base64 bytes", async () => {
    const input = await fixture();
    for (const approvalBase64 of [
      "",
      "e30",
      "e30=\n",
      "e31=",
      "-_==",
      "a".repeat(1_398_108),
    ]) {
      expect(
        PortfolioEpochTransitionSchema.safeParse({ ...input, approvalBase64 })
          .success
      ).toBe(false);
    }
    return expect(
      PortfolioEpochTransitionSchema.safeParse({
        ...input,
        approvalBase64: "AA==",
      }).success
    ).toBe(true);
  });

  it("validates the exact restored genesis hash and request signed-byte identity", async () => {
    const input = await fixture();
    await expect(
      parsePortfolioEpochTransition({
        ...input,
        snapshot: { ...input.snapshot, cash: "81" },
      })
    ).rejects.toThrow();
    expect(
      await computePortfolioEpochTransitionHash({
        ...input,
        approvalBase64: "AA==",
      })
    ).not.toBe(await computePortfolioEpochTransitionHash(input));
    return expect(
      await computePortfolioEpochTransitionHash({
        ...input,
        nativeOutboxEvidenceSha256: sha,
      })
    ).not.toBe(await computePortfolioEpochTransitionHash(input));
  });

  it("rejects accessors before inspecting externally supplied command data", async () => {
    const input = await fixture();
    const unsafe = { ...input };
    Object.defineProperty(unsafe, "approvalBase64", {
      enumerable: true,
      get: () => {
        throw new Error("getter must not execute");
      },
    });
    return await expect(
      parsePortfolioEpochTransition(unsafe)
    ).rejects.toThrow();
  });
});

const replayFixture = async () => {
  const epoch = await fixture();
  const snapshot = epoch.snapshot;
  const text = canonicalArtifactJson(snapshot);
  const projectionBase64 = btoa(text);
  const identity = {
    projectionId: snapshot.snapshotId,
    sequence: "1",
    eventHash: snapshot.sourceEventHash,
    projectionRawSha256: await hashArtifact(text),
    kind: "portfolio-genesis",
    proofSha256: null,
  };
  const grant = {
    schemaVersion: "1.0.0",
    grantId: "replay-2",
    accountAlias: snapshot.accountAlias,
    environment: "paper",
    streamId: snapshot.streamId,
    priorOwnerEpoch: "2",
    currentOwnerEpoch: "3",
    serviceActorId: "native-emitter",
    startingSequence: "0",
    startingEventHash: null,
    journalIdentity: "journal-1",
    journalSequence: "9007199254740999",
    journalHeadSha256: sha,
    nativeJournalEvidenceSha256: sha,
    nativeOwnerFenceSha256: sha,
    retainedEpochTransitionSha256: null as string | null,
    issuedAt: at,
    expiresAt: "2026-09-22T12:01:00Z",
    rows: [identity],
    approvalBase64: "e30=",
  };
  return {
    grant,
    retainedEpochTransitionBase64: null as string | null,
    rows: [{ kind: "portfolio-genesis", projectionBase64, proofBase64: null }],
  };
};

describe("independently approved retained native outbox replay", () => {
  it("retains exact canonical old genesis bytes without authorizing reseed", async () => {
    const value = await replayFixture();
    expect(await parseNativeOutboxReplay(value)).toEqual(value);
    const { approvalBase64: _approval, ...subject } = value.grant;
    expect(await computeNativeOutboxReplayGrantHash(value.grant)).toBe(
      await hashArtifact(subject)
    );
    return expect(
      await computeNativeOutboxReplayGrantHash({
        ...value.grant,
        approvalBase64: "AA==",
      })
    ).toBe(await computeNativeOutboxReplayGrantHash(value.grant));
  });

  it("permits original snapshots only at their exact current oldepoch reference", async () => {
    const value = await replayFixture();
    const first = value.grant.rows[0]!;
    const grant = {
      ...value.grant,
      startingSequence: "1",
      startingEventHash: first.eventHash,
      rows: [{ ...first, kind: "portfolio-snapshot" }],
    };
    expect(
      await parseNativeOutboxReplay({
        grant,
        retainedEpochTransitionBase64: null,
        rows: [{ ...value.rows[0]!, kind: "portfolio-snapshot" }],
      })
    ).toBeTruthy();
    expect(
      NativeOutboxReplayGrantSchema.safeParse({
        ...grant,
        startingEventHash: sha,
      }).success
    ).toBe(false);
    return expect(
      NativeOutboxReplayGrantSchema.safeParse({
        ...grant,
        startingSequence: "0",
        startingEventHash: null,
      }).success
    ).toBe(false);
  });

  it("rejects unlisted kinds phantom proofs and changed canonical old bytes", async () => {
    const value = await replayFixture();
    expect(
      NativeOutboxReplaySchema.safeParse({
        ...value,
        rows: [{ ...value.rows[0]!, proofBase64: "AA==" }],
      }).success
    ).toBe(false);
    expect(
      NativeOutboxReplaySchema.safeParse({
        ...value,
        rows: [{ ...value.rows[0]!, kind: "new-order" }],
      }).success
    ).toBe(false);
    return await expect(
      parseNativeOutboxReplay({
        ...value,
        rows: [
          {
            ...value.rows[0]!,
            projectionBase64: btoa(`${atob(value.rows[0]!.projectionBase64)} `),
          },
        ],
      })
    ).rejects.toThrow("hash mismatch");
  });

  it("requires exact declared rows monotonic native ownership and bounded count", async () => {
    const value = await replayFixture();
    expect(
      NativeOutboxReplayGrantSchema.safeParse({
        ...value.grant,
        currentOwnerEpoch: "2",
      }).success
    ).toBe(false);
    expect(
      NativeOutboxReplayGrantSchema.safeParse({
        ...value.grant,
        startingSequence: "0",
        startingEventHash: sha,
      }).success
    ).toBe(false);
    expect(
      NativeOutboxReplaySchema.safeParse({ ...value, rows: [] }).success
    ).toBe(false);
    expect(
      NativeOutboxReplaySchema.safeParse({
        ...value,
        rows: Array.from({ length: 65 }, () => value.rows[0]),
      }).success
    ).toBe(false);
    expect(
      NativeOutboxReplayGrantSchema.safeParse({
        ...value.grant,
        rows: [value.grant.rows[0], value.grant.rows[0]],
      }).success
    ).toBe(false);
    return expect(
      NativeOutboxReplayGrantSchema.safeParse({
        ...value.grant,
        nativeOutboxDrained: true,
      }).success
    ).toBe(false);
  });

  it("binds exact retained transition bytes only to its original first genesis", async () => {
    const value = await replayFixture();
    const transition = await fixture();
    const text = canonicalArtifactJson(transition);
    const retained = {
      ...value,
      retainedEpochTransitionBase64: btoa(text),
      grant: {
        ...value.grant,
        retainedEpochTransitionSha256: await hashArtifact(text),
      },
    };
    expect(await parseNativeOutboxReplay(retained)).toEqual(retained);
    expect(await computeNativeOutboxReplayGrantHash(retained.grant)).not.toBe(
      await computeNativeOutboxReplayGrantHash(value.grant)
    );
    expect(
      NativeOutboxReplaySchema.safeParse({
        ...retained,
        retainedEpochTransitionBase64: null,
      }).success
    ).toBe(false);
    expect(
      NativeOutboxReplaySchema.safeParse({
        ...value,
        retainedEpochTransitionBase64: btoa(text),
      }).success
    ).toBe(false);
    await expect(
      parseNativeOutboxReplay({
        ...retained,
        grant: { ...retained.grant, retainedEpochTransitionSha256: sha },
      })
    ).rejects.toThrow("raw hash mismatch");
    const changed = canonicalArtifactJson({
      ...transition,
      snapshot: { ...transition.snapshot, snapshotId: "different-original" },
    });
    await expect(
      parseNativeOutboxReplay({
        ...retained,
        retainedEpochTransitionBase64: btoa(changed),
        grant: {
          ...retained.grant,
          retainedEpochTransitionSha256: await hashArtifact(changed),
        },
      })
    ).rejects.toThrow();
    return expect(
      NativeOutboxReplayGrantSchema.safeParse({
        ...retained.grant,
        startingSequence: "1",
        startingEventHash: value.grant.rows[0]?.eventHash,
      }).success
    ).toBe(false);
  });
});
