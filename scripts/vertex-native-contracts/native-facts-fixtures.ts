import {
  canonicalArtifactJson,
  hashArtifact,
} from "../../packages/shared/src/vertex/index.ts";
import { computeNativeFactProjectionHash } from "../../packages/api/src/contracts/vertex-native-facts.ts";
import type {
  NativeFact,
  NativeFactProjection,
  NativeJournalProof,
} from "../../packages/api/src/contracts/vertex-native-facts.ts";
import type { ContractFixture } from "./fixtures.ts";

export interface NativeProofFixture {
  name: string;
  projection: unknown;
  proofHex: string;
  valid: boolean;
}
export const buildNativeFactsFixtures = async (): Promise<{
  cases: ContractFixture[];
  proofs: NativeProofFixture[];
}> => {
  const hash = "a".repeat(64);
  const zero = "0".repeat(64);
  const occurredAt = "2026-09-22T12:00:00.000000001Z";
  const receivedAt = "2026-09-22T12:00:00.000000002Z";
  const dueAt = "2026-09-22T11:59:00Z";
  const future = "2026-09-22T12:01:00Z";
  const option = {
    settlementId: "settlement-1",
    instrumentId: "option-1",
    underlyingId: "equity-1",
    settlementKind: "physical",
    settlementState: "settled",
    quantity: "1",
    currency: "USD",
    cashDelta: "-10",
    shareDelta: "1",
    dueAt,
    fillEventIds: ["fill-1"],
  };
  const facts = [
    {
      kind: "checkpoint",
      snapshotId: "snapshot-1",
      snapshotSha256: hash,
      journalSequence: "9",
      journalHeadHash: hash,
    },
    {
      kind: "cash-settlement",
      settlementId: "cash-1",
      currency: "USD",
      cashDelta: "1",
      fillEventIds: ["fill-1"],
    },
    { kind: "assignment", ...option },
    { kind: "exercise", ...option },
    { kind: "option-expiry", ...option, cashDelta: "0", shareDelta: "0" },
    {
      kind: "corporate-action",
      actionId: "split-1",
      oldInstrumentId: "equity-1",
      newInstrumentId: "equity-2",
      quantityNumerator: "2",
      quantityDenominator: "1",
      previousQuantity: "1",
      newQuantity: "2",
      cashDelta: "0",
      currency: "USD",
      previousQualificationSha256: hash,
      replacementQualificationSha256: hash,
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
      action: "reset-new-risk",
      reasonCodes: ["human-reset"],
      grantId: "grant-1",
    },
  ] as NativeFact[];
  const cases: ContractFixture[] = [];
  const proofs: NativeProofFixture[] = [];
  const add = (
    contract: string,
    name: string,
    payload: unknown,
    valid = false
  ): void => {
    cases.push({
      name: `${contract}/${name}`,
      contract,
      payload: structuredClone(payload),
      valid,
    });
  };
  const sealedProjection = async (
    fact: NativeFact,
    proof: NativeJournalProof
  ): Promise<NativeFactProjection> => {
    const value = {
      schemaVersion: "1.0.0",
      projectionId: `projection-${fact.kind}`,
      accountAlias: "synthetic-paper",
      environment: "paper",
      streamId: "stream-1",
      ownerEpoch: "1",
      sequence: "2",
      previousEventHash: hash,
      eventHash: zero,
      proofJournalSequence: proof.journalSequence,
      proofJournalHeadHash: proof.journalHeadHash,
      factOrdinal: proof.factOrdinal,
      occurredAt,
      receivedAt,
      actorId: "native-owner",
      policyVersion: "1.0.0",
      expiresAt: future,
      idempotencyKey: `fact-${fact.kind}`,
      sourceKind: "paper-simulation",
      proof: {
        artifactId: `proof-${fact.kind}`,
        sha256: await hashArtifact(canonicalArtifactJson(proof)),
        sourceEventId: proof.sourceEventId,
      },
      fact,
      authoritative: false,
      reservationAuthority: "native-owner-only",
      executionAuthorized: false,
    } as NativeFactProjection;
    return {
      ...value,
      eventHash: await computeNativeFactProjectionHash(value),
    };
  };
  const proofCase = (
    name: string,
    projection: unknown,
    proofBytes: Uint8Array,
    valid = false
  ): void => {
    proofs.push({
      name,
      projection: structuredClone(projection),
      proofHex: Buffer.from(proofBytes).toString("hex"),
      valid,
    });
  };
  const bytes = (value: unknown): Uint8Array =>
    new TextEncoder().encode(canonicalArtifactJson(value));
  for (const fact of facts) {
    const proof = {
      schemaVersion: "1.0.0",
      proofKind: "native-journal-event",
      accountAlias: "synthetic-paper",
      environment: "paper",
      streamId: "stream-1",
      ownerEpoch: "1",
      sourceEventId: `journal-${fact.kind}`,
      journalSequence: "9",
      journalHeadHash: hash,
      factOrdinal: 0,
      occurredAt,
      eventType: fact.kind,
      payload: fact,
    } as NativeJournalProof;
    const projection = await sealedProjection(fact, proof);
    add("NativeFact", `variant-${fact.kind}`, fact, true);
    add("NativeFactProjection", `variant-${fact.kind}`, projection, true);
    add("NativeJournalProof", `variant-${fact.kind}`, proof, true);
    proofCase(`bound-${fact.kind}`, projection, bytes(proof), true);
    add("NativeFact", `unknown-field-${fact.kind}`, {
      ...fact,
      unsupported: true,
    });
    add("NativeFactProjection", `hash-${fact.kind}`, {
      ...projection,
      eventHash: zero,
    });
    add("NativeFactProjection", `receivedAt-hash-${fact.kind}`, {
      ...projection,
      receivedAt: future,
    });
    add("NativeFactProjection", `genesis-sequence-${fact.kind}`, {
      ...projection,
      sequence: "1",
    });
    add("NativeFactProjection", `null-predecessor-${fact.kind}`, {
      ...projection,
      previousEventHash: null,
    });
    add("NativeJournalProof", `wrong-type-${fact.kind}`, {
      ...proof,
      eventType: fact.kind === "checkpoint" ? "kill-state" : "checkpoint",
    });
    add("NativeJournalProof", `owner-zero-${fact.kind}`, {
      ...proof,
      ownerEpoch: "0",
    });
    add("NativeFactProjection", `journal-sequence-zero-${fact.kind}`, {
      ...projection,
      proofJournalSequence: "0",
    });
    add("NativeFactProjection", `ordinal-over-cap-${fact.kind}`, {
      ...projection,
      factOrdinal: 64,
    });
    add("NativeJournalProof", `ordinal-over-cap-${fact.kind}`, {
      ...proof,
      factOrdinal: 64,
    });
    add("NativeJournalProof", `ordinal-negative-${fact.kind}`, {
      ...proof,
      factOrdinal: -1,
    });
    // Ordinal 63 is the last admitted per-transition fact; global projection
    // sequence 2 remains deliberately different from journal sequence 9.
    const lastOrdinalProof = { ...proof, factOrdinal: 63 };
    const lastOrdinalProjection = await sealedProjection(
      fact,
      lastOrdinalProof
    );
    add(
      "NativeFactProjection",
      `last-ordinal-independent-sequence-${fact.kind}`,
      lastOrdinalProjection,
      true
    );
    add(
      "NativeJournalProof",
      `last-ordinal-${fact.kind}`,
      lastOrdinalProof,
      true
    );
    proofCase(
      `last-ordinal-bound-${fact.kind}`,
      lastOrdinalProjection,
      bytes(lastOrdinalProof),
      true
    );
    const rebind = async (name: string, changed: unknown): Promise<void> => {
      const changedBytes = bytes(changed);
      const draft = {
        ...projection,
        proof: {
          ...projection.proof,
          sha256: await hashArtifact(changedBytes),
        },
      };
      const sealed = {
        ...draft,
        eventHash: await computeNativeFactProjectionHash(draft),
      };
      proofCase(`${name}-${fact.kind}`, sealed, changedBytes);
    };
    await rebind("scope-mismatch", { ...proof, accountAlias: "other-paper" });
    await rebind("epoch-mismatch", { ...proof, ownerEpoch: "2" });
    await rebind("source-event-mismatch", {
      ...proof,
      sourceEventId: "other-source",
    });
    await rebind("literal-time-mismatch", {
      ...proof,
      occurredAt: "2026-09-22T12:00:00.000000001+00:00",
    });
    await rebind("journal-sequence-mismatch", {
      ...proof,
      journalSequence: "10",
    });
    await rebind("journal-head-mismatch", { ...proof, journalHeadHash: zero });
    await rebind("fact-ordinal-mismatch", { ...proof, factOrdinal: 1 });
    const badHashDraft = {
      ...projection,
      proof: { ...projection.proof, sha256: zero },
    };
    proofCase(
      `raw-hash-mismatch-${fact.kind}`,
      {
        ...badHashDraft,
        eventHash: await computeNativeFactProjectionHash(badHashDraft),
      },
      bytes(proof)
    );
    const noncanonical = new TextEncoder().encode(
      `${canonicalArtifactJson(proof)} `
    );
    const noncanonicalDraft = {
      ...projection,
      proof: { ...projection.proof, sha256: await hashArtifact(noncanonical) },
    };
    proofCase(
      `noncanonical-${fact.kind}`,
      {
        ...noncanonicalDraft,
        eventHash: await computeNativeFactProjectionHash(noncanonicalDraft),
      },
      noncanonical
    );
    if (fact.kind === "checkpoint") {
      await rebind("checkpoint-head-mismatch", {
        ...proof,
        journalHeadHash: zero,
      });
      // Standalone proof schema does not claim the paired parser's head binding.
      add(
        "NativeJournalProof",
        "standalone-does-not-prove-checkpoint-head",
        { ...proof, journalHeadHash: zero },
        true
      );
      await rebind("payload-mismatch", {
        ...proof,
        payload: { ...fact, snapshotId: "other-snapshot" },
      });
      await rebind("checkpoint-sequence-mismatch", {
        ...proof,
        journalSequence: "10",
      });
      const mismatchedCheckpointHead = { ...proof, journalHeadHash: zero };
      proofCase(
        "checkpoint-payload-head-join",
        await sealedProjection(fact, mismatchedCheckpointHead),
        bytes(mismatchedCheckpointHead)
      );
      const mismatchedCheckpointSequence = { ...proof, journalSequence: "10" };
      proofCase(
        "checkpoint-payload-sequence-join",
        await sealedProjection(fact, mismatchedCheckpointSequence),
        bytes(mismatchedCheckpointSequence)
      );
      const byteRejects = [
        { name: "empty", bytes: new Uint8Array() },
        {
          name: "malformed-utf8",
          bytes: Uint8Array.from([0x22, 0xc3, 0x28, 0x22]),
        },
        {
          name: "bom",
          bytes: Uint8Array.from([0xef, 0xbb, 0xbf, ...bytes(proof)]),
        },
        {
          name: "duplicate-property",
          bytes: new TextEncoder().encode(
            canonicalArtifactJson(proof).replace(
              '"environment":"paper"',
              '"environment":"paper","environment":"paper"'
            )
          ),
        },
      ];
      for (const rejected of byteRejects) {
        const draft = {
          ...projection,
          proof: {
            ...projection.proof,
            sha256: await hashArtifact(rejected.bytes),
          },
        };
        proofCase(
          rejected.name,
          { ...draft, eventHash: await computeNativeFactProjectionHash(draft) },
          rejected.bytes
        );
      }
    }
    if (
      fact.kind === "assignment" ||
      fact.kind === "exercise" ||
      fact.kind === "option-expiry"
    ) {
      add("NativeFact", `zero-quantity-${fact.kind}`, {
        ...fact,
        quantity: "0",
      });
      add("NativeFact", `same-instrument-${fact.kind}`, {
        ...fact,
        underlyingId: fact.instrumentId,
      });
      add("NativeFact", `duplicate-fill-${fact.kind}`, {
        ...fact,
        fillEventIds: ["fill-1", "fill-1"],
      });
      add("NativeFact", `invalid-calendar-${fact.kind}`, {
        ...fact,
        dueAt: "2026-02-30T00:00:00Z",
      });
      const pending = {
        ...fact,
        settlementState: "pending",
        dueAt: future,
      } as NativeFact;
      const pendingProof = { ...proof, payload: pending } as NativeJournalProof;
      const pendingProjection = await sealedProjection(pending, pendingProof);
      add(
        "NativeFactProjection",
        `pending-future-${fact.kind}`,
        pendingProjection,
        true
      );
      add(
        "NativeJournalProof",
        `pending-future-${fact.kind}`,
        pendingProof,
        true
      );
      proofCase(
        `pending-bound-${fact.kind}`,
        pendingProjection,
        bytes(pendingProof),
        true
      );
      add("NativeFactProjection", `premature-settled-${fact.kind}`, {
        ...projection,
        fact: { ...fact, dueAt: future },
      });
      add("NativeJournalProof", `premature-settled-${fact.kind}`, {
        ...proof,
        payload: { ...fact, dueAt: future },
      });
    }
    if (fact.kind === "cash-settlement") {
      add("NativeFact", "duplicate-cash-fill", {
        ...fact,
        fillEventIds: ["fill-1", "fill-1"],
      });
      add("NativeFact", "noncanonical-cash", { ...fact, cashDelta: "1.0" });
    }
    if (fact.kind === "assignment")
      add("NativeFact", "cash-settlement-cannot-change-shares", {
        ...fact,
        settlementKind: "cash",
      });
    if (fact.kind === "option-expiry")
      add("NativeFact", "expiry-cash-nonzero", { ...fact, cashDelta: "1" });
    if (fact.kind === "corporate-action") {
      add("NativeFact", "zero-corporate-ratio", {
        ...fact,
        quantityDenominator: "0",
      });
      add("NativeFact", "noncanonical-corporate-quantity", {
        ...fact,
        newQuantity: "2.0",
      });
    }
    if (fact.kind === "reconciliation")
      add("NativeFact", "unknown-cannot-be-reconciled", {
        ...fact,
        unknownCount: 1,
      });
    if (fact.kind === "kill-state") {
      add("NativeFact", "reset-needs-grant", { ...fact, grantId: null });
      add("NativeFact", "duplicate-kill-reason", {
        ...fact,
        reasonCodes: ["reason-1", "reason-1"],
      });
    }
  }
  for (const contract of [
    "NativeFact",
    "NativeFactProjection",
    "NativeJournalProof",
  ]) {
    add(contract, "wrong-root-type", "not-an-object");
    add(contract, "missing-root-fields", {});
  }
  return { cases, proofs };
};
