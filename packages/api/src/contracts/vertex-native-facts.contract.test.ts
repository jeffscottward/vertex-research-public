import { describe, expect, it } from "vitest";
import {
  canonicalArtifactJson,
  hashArtifact,
} from "@darkfactory/shared/vertex";
import {
  NativeFactSchema,
  NativeFactProjectionSchema,
  NativeJournalProofSchema,
  VERTEX_NATIVE_FACT_CONTRACT_SCHEMAS,
  computeNativeFactProjectionHash,
  parseNativeFactProjection,
  parseNativeJournalProof,
} from "./vertex-native-facts.ts";

const at = "2026-09-22T12:00:00.000000001Z";
const later = "2026-09-22T12:00:00.000000002Z";
const expires = "2026-09-22T12:01:00Z";
const sha = "a".repeat(64);
const scope = {
  accountAlias: "synthetic-paper",
  environment: "paper",
  streamId: "native-stream",
  ownerEpoch: "1",
} as const;
const option = {
  settlementId: "settlement-1",
  instrumentId: "option-1",
  underlyingId: "equity-1",
  settlementKind: "physical",
  settlementState: "pending",
  quantity: "1",
  currency: "USD",
  cashDelta: "-100",
  shareDelta: "1",
  dueAt: expires,
  fillEventIds: ["fill-1"],
} as const;
const facts = [
  {
    kind: "checkpoint",
    snapshotId: "snapshot-1",
    snapshotSha256: sha,
    journalSequence: "9007199254740993",
    journalHeadHash: sha,
  },
  {
    kind: "cash-settlement",
    settlementId: "cash-1",
    currency: "USD",
    cashDelta: "10",
    fillEventIds: ["fill-1"],
  },
  { kind: "assignment", ...option },
  { kind: "exercise", ...option },
  { kind: "option-expiry", ...option, cashDelta: "0", shareDelta: "0" },
  {
    kind: "corporate-action",
    actionId: "split-1",
    oldInstrumentId: "old-1",
    newInstrumentId: "new-1",
    quantityNumerator: "2",
    quantityDenominator: "1",
    previousQuantity: "1",
    newQuantity: "2",
    cashDelta: "0",
    currency: "USD",
    previousQualificationSha256: sha,
    replacementQualificationSha256: "b".repeat(64),
  },
  {
    kind: "reconciliation",
    reconciliationId: "reconcile-1",
    observedSnapshotId: "snapshot-1",
    unknownCount: 0,
    reconciled: true,
  },
  {
    kind: "kill-state",
    action: "pause-new-risk",
    reasonCodes: ["operator-pause"],
    grantId: null,
  },
] as const;
const fixture = async (factInput: unknown = facts[2]) => {
  const fact = NativeFactSchema.parse(factInput);
  const proof = NativeJournalProofSchema.parse({
    schemaVersion: "1.0.0",
    proofKind: "native-journal-event",
    ...scope,
    sourceEventId: "journal-event-1",
    journalSequence:
      fact.kind === "checkpoint" ? fact.journalSequence : "9007199254740993",
    journalHeadHash: fact.kind === "checkpoint" ? fact.journalHeadHash : sha,
    factOrdinal: 0,
    occurredAt: at,
    eventType: fact.kind,
    payload: fact,
  });
  const proofBytes = new TextEncoder().encode(canonicalArtifactJson(proof));
  const projection = NativeFactProjectionSchema.parse({
    schemaVersion: "1.0.0",
    projectionId: "fact-2",
    ...scope,
    sequence: "2",
    proofJournalSequence: proof.journalSequence,
    proofJournalHeadHash: proof.journalHeadHash,
    factOrdinal: proof.factOrdinal,
    previousEventHash: sha,
    eventHash: sha,
    occurredAt: at,
    receivedAt: later,
    actorId: "native-emitter",
    policyVersion: "1.0.0",
    expiresAt: expires,
    idempotencyKey: "fact-key-2",
    sourceKind: "paper-simulation",
    proof: {
      artifactId: "journal-proof-1",
      sha256: await hashArtifact(proofBytes),
      sourceEventId: proof.sourceEventId,
    },
    fact,
    authoritative: false,
    reservationAuthority: "native-owner-only",
    executionAuthorized: false,
  });
  return {
    proof,
    proofBytes,
    projection: NativeFactProjectionSchema.parse({
      ...projection,
      eventHash: await computeNativeFactProjectionHash(projection),
    }),
  };
};

// Authored only; no native/runtime/schema generation or execution performed.
describe("strict native simulation fact projections", () => {
  it("releases exactly three additive schemas and eight fixed typed variants", () => {
    expect(Object.keys(VERTEX_NATIVE_FACT_CONTRACT_SCHEMAS)).toEqual([
      "NativeFact",
      "NativeFactProjection",
      "NativeJournalProof",
    ]);

    for (const fact of facts) {
      const parsed = NativeFactSchema.parse(fact);
      expect(parsed).toEqual(fact);
      expect(Object.isFrozen(parsed)).toBe(true);
      expect(
        NativeFactSchema.safeParse({ ...fact, rawMetadata: {} }).success
      ).toBe(false);
    }
  });

  it.each(facts)(
    "binds canonical $kind proof and preserves immutable journal provenance",
    async (fact) => {
      const value = await fixture(fact);
      expect(await parseNativeFactProjection(value.projection)).toEqual(
        value.projection
      );
      expect(
        await parseNativeJournalProof(value.projection, value.proofBytes)
      ).toEqual(value.proof);
      return expect(Object.isFrozen(value.projection.fact)).toBe(true);
    }
  );

  it("requires sequence2+ and a mandatory predecessor after portfolio genesis", async () => {
    const { projection } = await fixture();
    for (const sequence of ["0", "1", "01", 2, "2.0", "invalid"]) {
      expect(
        NativeFactProjectionSchema.safeParse({ ...projection, sequence })
          .success
      ).toBe(false);
    }
    expect(
      NativeFactProjectionSchema.safeParse({
        ...projection,
        sequence: "9007199254740993",
      }).success
    ).toBe(true);
    return expect(
      NativeFactProjectionSchema.safeParse({
        ...projection,
        previousEventHash: null,
      }).success
    ).toBe(false);
  });

  it("distinguishes pending future obligations from settled economic facts", async () => {
    const { projection } = await fixture();
    expect(NativeFactProjectionSchema.safeParse(projection).success).toBe(true);
    expect(
      NativeFactProjectionSchema.safeParse({
        ...projection,
        fact: { ...option, kind: "assignment", settlementState: "settled" },
      }).success
    ).toBe(false);
    expect(
      NativeFactProjectionSchema.safeParse({
        ...projection,
        fact: {
          ...option,
          kind: "assignment",
          settlementState: "settled",
          dueAt: at,
        },
      }).success
    ).toBe(true);
    expect(
      NativeFactSchema.safeParse({ ...option, kind: "option-expiry" }).success
    ).toBe(false);
    expect(
      NativeFactSchema.safeParse({
        ...option,
        kind: "assignment",
        settlementKind: "cash",
      }).success
    ).toBe(false);
    return expect(
      NativeFactSchema.safeParse({
        ...option,
        kind: "assignment",
        instrumentId: option.underlyingId,
      }).success
    ).toBe(false);
  });

  it("keeps observations paper only nonauthoritative and nanosecond ordered", async () => {
    const { projection } = await fixture();
    for (const change of [
      { environment: "live" },
      { environment: "research" },
      { sourceKind: "broker-observation" },
      { authoritative: true },
      { executionAuthorized: true },
      { reservationAuthority: "cloud" },
      { occurredAt: later, receivedAt: at },
      { expiresAt: at },
    ]) {
      expect(
        NativeFactProjectionSchema.safeParse({ ...projection, ...change })
          .success
      ).toBe(false);
    }
    return expect(
      NativeFactProjectionSchema.safeParse({
        ...projection,
        strategyVersion: "fictional-strategy",
      }).success
    ).toBe(false);
  });

  it("rejects duplicates invalid currencies noncanonical scalars and unjustified reset", () => {
    expect(
      NativeFactSchema.safeParse({
        ...facts[1],
        fillEventIds: ["fill-1", "fill-1"],
      }).success
    ).toBe(false);
    expect(
      NativeFactSchema.safeParse({ ...facts[1], cashDelta: 1 }).success
    ).toBe(false);
    expect(
      NativeFactSchema.safeParse({ ...facts[1], currency: "usd" }).success
    ).toBe(false);
    expect(
      NativeFactSchema.safeParse({ ...facts[5], quantityDenominator: "0" })
        .success
    ).toBe(false);
    expect(
      NativeFactSchema.safeParse({ ...facts[6], unknownCount: 1 }).success
    ).toBe(false);
    expect(
      NativeFactSchema.safeParse({ ...facts[6], unknownCount: -0 }).success
    ).toBe(false);
    expect(
      NativeFactSchema.safeParse({ ...facts[7], action: "reset-new-risk" })
        .success
    ).toBe(false);
    return expect(
      NativeFactSchema.safeParse({
        ...facts[7],
        action: "reset-new-risk",
        grantId: "reset-grant-1",
      }).success
    ).toBe(true);
  });

  it("hashes exactly the observation without eventHash but retains receivedAt and proof", async () => {
    const { projection } = await fixture();
    const { eventHash: _eventHash, ...body } = projection;
    expect(await computeNativeFactProjectionHash(projection)).toBe(
      await hashArtifact(body)
    );
    await expect(
      parseNativeFactProjection({ ...projection, actorId: "other" })
    ).rejects.toThrow("hash mismatch");
    await expect(
      parseNativeFactProjection({ ...projection, receivedAt: expires })
    ).rejects.toThrow("hash mismatch");
    return await expect(
      parseNativeFactProjection({
        ...projection,
        proof: { ...projection.proof, artifactId: "other" },
      })
    ).rejects.toThrow("hash mismatch");
  });

  it("rejects unknown or unbound journal proof identities even after resealing their bytes", async () => {
    const original = await fixture();

    for (const change of [
      { accountAlias: "other" },
      { streamId: "other" },
      { ownerEpoch: "2" },
      { sourceEventId: "other" },
      { journalSequence: "2" },
      { journalHeadHash: "b".repeat(64) },
      { factOrdinal: 1 },
      { occurredAt: later },
      {
        payload: NativeFactSchema.parse(facts[1]),
        eventType: "cash-settlement",
      },
    ]) {
      const proofBytes = new TextEncoder().encode(
        canonicalArtifactJson({ ...original.proof, ...change })
      );
      const proposal = {
        ...original.projection,
        proof: {
          ...original.projection.proof,
          sha256: await hashArtifact(proofBytes),
        },
      };
      const projection = {
        ...proposal,
        eventHash: await computeNativeFactProjectionHash(proposal),
      };
      await expect(
        parseNativeJournalProof(projection, proofBytes)
      ).rejects.toThrow("binding mismatch");
    }
  });

  it("requires canonical bounded bytes and does not mistake whitespace or a BOM for proof", async () => {
    const original = await fixture();
    await expect(
      parseNativeJournalProof(original.projection, new Uint8Array())
    ).rejects.toThrow("Invalid native proof bytes");
    await expect(
      parseNativeJournalProof(original.projection, new Uint8Array(1_048_577))
    ).rejects.toThrow("Invalid native proof bytes");

    for (const text of [
      ` ${canonicalArtifactJson(original.proof)}`,
      `\uFEFF${canonicalArtifactJson(original.proof)}`,
    ]) {
      const proofBytes = new TextEncoder().encode(text);
      const proposal = {
        ...original.projection,
        proof: {
          ...original.projection.proof,
          sha256: await hashArtifact(proofBytes),
        },
      };
      const projection = {
        ...proposal,
        eventHash: await computeNativeFactProjectionHash(proposal),
      };
      await expect(
        parseNativeJournalProof(projection, proofBytes)
      ).rejects.toThrow();
    }
  });

  it("requires checkpoint journal sequence/head to match its proof envelope", async () => {
    const original = await fixture(facts[0]);
    const proofBytes = new TextEncoder().encode(
      canonicalArtifactJson({ ...original.proof, journalSequence: "2" })
    );
    const proposal = {
      ...original.projection,
      proofJournalSequence: "2",
      proof: {
        ...original.projection.proof,
        sha256: await hashArtifact(proofBytes),
      },
    };
    const projection = {
      ...proposal,
      eventHash: await computeNativeFactProjectionHash(proposal),
    };
    return await expect(
      parseNativeJournalProof(projection, proofBytes)
    ).rejects.toThrow("Checkpoint proof head mismatch");
  });

  it("keeps journal sequence independent and bounds fact identity within one transition", async () => {
    const original = await fixture();
    expect(original.projection.sequence).toBe("2");
    expect(original.projection.proofJournalSequence).toBe("9007199254740993");
    for (const factOrdinal of [-1, 64, 0.5, -0, "0"]) {
      expect(
        NativeFactProjectionSchema.safeParse({
          ...original.projection,
          factOrdinal,
        }).success
      ).toBe(false);
      expect(
        NativeJournalProofSchema.safeParse({ ...original.proof, factOrdinal })
          .success
      ).toBe(false);
    }

    for (const factOrdinal of [0, 63]) {
      expect(
        NativeFactProjectionSchema.safeParse({
          ...original.projection,
          factOrdinal,
        }).success
      ).toBe(true);
      expect(
        NativeJournalProofSchema.safeParse({ ...original.proof, factOrdinal })
          .success
      ).toBe(true);
    }
  });

  it("snapshots proof bytes before yielding and never calls a caller iterator", async () => {
    const original = await fixture();
    Object.defineProperty(original.proofBytes, Symbol.iterator, {
      value: () => {
        throw new Error("untrusted iterator");
      },
    });
    const pending = parseNativeJournalProof(
      original.projection,
      original.proofBytes
    );
    original.proofBytes.fill(0);
    return expect(await pending).toEqual(original.proof);
  });
});
