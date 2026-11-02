import { rebuildEpochExecutionProjection } from "./vertex-runtime-epoch-execution.ts";
import {
  parseNativeFactProjection,
  parseNativeJournalProof,
} from "../contracts/vertex-native-facts.ts";
import {
  canonical,
  canonicalRecord,
  decodeBase64,
  exact,
  hashArtifact,
  id,
  list,
  ns,
  rawSha,
  record,
  requireEpoch,
  same,
  sha,
  text,
  timestampToEpochNanoseconds,
  type NativeRecord,
} from "./vertex-runtime-epoch-bytes.ts";
import {
  applyNativeEpochEvent,
  initialNativeEpochState,
} from "./vertex-runtime-epoch-replay.ts";
import { rebuildEpochSnapshot } from "./vertex-runtime-epoch-snapshot.ts";
import { present } from "./present.ts";

export type ReconstructedVertexEpochEvidence = Readonly<{
  outbox: NativeRecord;
  fence: NativeRecord;
  state: NativeRecord;
  priorState: NativeRecord;
  outboxSha256: string;
  fenceSha256: string;
  projections: readonly NativeRecord[];
}>;
const ECONOMIC_METADATA = [
  "ownerEpoch",
  "pausedNewRisk",
  "reconciled",
  "pauseReasons",
  "observation",
  "portfolioRevision",
];
const economic = (state: NativeRecord): NativeRecord => {
  const result = structuredClone(
    Object.fromEntries(
      Object.entries(state).filter(([key]) => !ECONOMIC_METADATA.includes(key))
    )
  );
  for (const order of Object.values(record(result["orders"])).map(record)) {
    if (order["dispatchMarked"] && !order["finalityProven"])
      order["status"] = "unknown";
  }
  return result;
};
const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export const reconstructVertexEpochEvidence = async (
  outboxBytes: Uint8Array,
  fenceBytes: Uint8Array,
  now: bigint,
  requireAcknowledged = true
): Promise<ReconstructedVertexEpochEvidence> => {
  const outbox = exact(canonicalRecord(outboxBytes), [
    "format",
    "journalIdentity",
    "accountAlias",
    "environment",
    "simulatorId",
    "currency",
    "streamId",
    "priorOwnerEpoch",
    "priorProjectionSequence",
    "priorProjectionHash",
    "ownerEpoch",
    "journalSequence",
    "journalHeadSha256",
    "capturedAtNs",
    "initialState",
    "priorStateSha256",
    "currentStateSha256",
    "metadata",
    "events",
    "checkpoints",
    "projections",
    "nativeProofs",
    "nativeFactIdentities",
  ]);
  requireEpoch(
    outbox["format"] === "vertex-native-outbox-evidence-v1" &&
      outbox["environment"] === "paper"
  );
  for (const field of [
    "journalIdentity",
    "accountAlias",
    "simulatorId",
    "streamId",
  ])
    id(outbox[field]);
  requireEpoch(/^[A-Z]{3}$/.test(text(outbox["currency"])));
  requireEpoch(
    ns(outbox["priorOwnerEpoch"]) > 0n &&
      ns(outbox["ownerEpoch"]) > ns(outbox["priorOwnerEpoch"]) &&
      ns(outbox["capturedAtNs"]) <= now
  );
  const initial = initialNativeEpochState(
    outbox["accountAlias"],
    outbox["simulatorId"],
    outbox["currency"]
  );
  requireEpoch(same(initial, outbox["initialState"]));
  const metadata = new Map<string, string>();
  let lastMetadataKey = "";
  let metadataBytes = 0;
  for (const rowValue of list(outbox["metadata"], 16)) {
    const row = exact(rowValue, ["key", "value"]);
    const key = text(row["key"]);
    const value = text(row["value"]);
    metadataBytes += new TextEncoder().encode(value).length;
    requireEpoch(
      ["scope", "epoch", "local_pause"].includes(key) &&
        compare(key, lastMetadataKey) > 0 &&
        metadataBytes <= 262_144
    );
    metadata.set(key, value);
    lastMetadataKey = key;
  }
  requireEpoch(
    metadata.get("epoch") === outbox["ownerEpoch"] &&
      metadata.get("scope") === new TextDecoder().decode(canonical(initial))
  );
  let sourceBytes = 0;
  const original = (
    base64: unknown
  ): { bytes: Uint8Array; value: NativeRecord } => {
    const bytes = decodeBase64(base64, 262_144);
    sourceBytes += bytes.length;
    requireEpoch(sourceBytes <= 524_288);
    return { bytes, value: canonicalRecord(bytes, 262_144) };
  };
  const checkpoints = new Map<
    string,
    { row: NativeRecord; bytes: Uint8Array }
  >();
  let lastCheckpoint = 0n;
  for (const raw of list(outbox["checkpoints"])) {
    const row = exact(raw, [
      "sequence",
      "eventHash",
      "stateHash",
      "payloadBase64",
    ]);
    requireEpoch(ns(row["sequence"]) > lastCheckpoint);
    lastCheckpoint = ns(row["sequence"]);
    const checkpoint = original(row["payloadBase64"]);
    checkpoints.set(row["sequence"], { row, bytes: checkpoint.bytes });
  }
  const executionSources = new Set<string>();
  for (const raw of list(outbox["projections"])) {
    const row = record(raw);
    if (row["kind"] === "execution") {
      const projection = canonicalRecord(
        decodeBase64(row["payloadBase64"], 262_144),
        262_144
      );
      const sourceIds = list(record(projection["receipt"])["auditEventIds"], 1);
      requireEpoch(sourceIds.length === 1);
      executionSources.add(id(sourceIds[0]));
    }
  }
  const executionStates = new Map<string, NativeRecord>();
  let retainedStateBytes = 0;
  const state = structuredClone(initial);
  const events = new Map<
    string,
    {
      event: NativeRecord;
      hash: string;
      bytes: Uint8Array;
      before?: NativeRecord;
    }
  >();
  const eventIds = new Set<string>();
  let sequence = 0n;
  let previous = "0".repeat(64);
  let priorState: NativeRecord | undefined;
  let claim:
    | { sequence: string; hash: string; payloadBase64: string }
    | undefined;
  for (const raw of list(outbox["events"])) {
    const row = exact(raw, [
      "sequence",
      "eventId",
      "previousHash",
      "eventHash",
      "payloadBase64",
    ]);
    const originalEvent = original(row["payloadBase64"]);
    const event = exact(originalEvent.value, [
      "sequence",
      "previousHash",
      "ownerEpoch",
      "eventId",
      "occurredNs",
      "kind",
      "data",
    ]);
    requireEpoch(
      ns(row["sequence"]) === sequence + 1n &&
        row["previousHash"] === previous &&
        event["previousHash"] === previous &&
        event["sequence"] === row["sequence"] &&
        event["eventId"] === row["eventId"] &&
        (await rawSha(originalEvent.bytes)) === sha(row["eventHash"])
    );
    id(event["eventId"]);
    requireEpoch(
      !eventIds.has(event["eventId"]) &&
        ns(event["occurredNs"]) <= ns(outbox["capturedAtNs"]) &&
        event["ownerEpoch"] === state["ownerEpoch"]
    );
    const before = ["portfolio-genesis", "portfolio-checkpoint"].includes(
      event["kind"]
    )
      ? structuredClone(state)
      : undefined;
    if (event["kind"] === "epoch-claimed") {
      exact(event["data"], ["epoch"]);
      requireEpoch(
        ns(event["data"].epoch) === ns(state["ownerEpoch"]) + 1n &&
          ns(event["data"].epoch) <= ns(outbox["ownerEpoch"])
      );
      if (state["ownerEpoch"] === outbox["priorOwnerEpoch"]) {
        requireEpoch(!priorState && state["observation"] !== null);
        priorState = structuredClone(state);
      }
      if (event["data"].epoch === outbox["ownerEpoch"]) {
        requireEpoch(!claim && priorState);
        claim = {
          sequence: row["sequence"],
          hash: row["eventHash"],
          payloadBase64: row["payloadBase64"],
        };
      }
    }
    // A process may die after claiming but before publishing genesis. Preserve
    // every intervening consecutive claim, but allow NO economics/publication
    // after leaving the last projected epoch. The final claim owns the fence.
    else if (priorState)
      requireEpoch(
        ["pause", "observation", "reconciled"].includes(event["kind"])
      );
    applyNativeEpochEvent(state, event);
    const afterBytes = canonical(state);
    requireEpoch(afterBytes.length <= 262_144);
    if (before) retainedStateBytes += canonical(before).length;
    if (executionSources.has(event["eventId"])) {
      executionStates.set(event["eventId"], structuredClone(state));
      retainedStateBytes += afterBytes.length;
    }
    requireEpoch(retainedStateBytes <= 524_288);
    sequence = ns(row["sequence"]);
    previous = row["eventHash"];
    events.set(row["sequence"], {
      event,
      hash: previous,
      bytes: originalEvent.bytes,
      ...(before ? { before } : {}),
    });
    eventIds.add(event["eventId"]);
    const checkpoint = checkpoints.get(row["sequence"]);
    if (checkpoint) {
      requireEpoch(
        checkpoint.row["eventHash"] === previous &&
          (await rawSha(checkpoint.bytes)) ===
            sha(checkpoint.row["stateHash"]) &&
          same(canonicalRecord(checkpoint.bytes, 262_144), state)
      );
      checkpoints.delete(row["sequence"]);
    }
  }
  requireEpoch(checkpoints.size === 0 && claim && priorState);
  requireEpoch(
    sequence === ns(outbox["journalSequence"]) &&
      previous === sha(outbox["journalHeadSha256"]) &&
      state["ownerEpoch"] === outbox["ownerEpoch"] &&
      (await hashArtifact(priorState)) === sha(outbox["priorStateSha256"]) &&
      (await hashArtifact(state)) === sha(outbox["currentStateSha256"])
  );
  requireEpoch(
    same(economic(state), economic(present(priorState))) &&
      state["pausedNewRisk"] === true
  );
  const proofs = new Map<string, Uint8Array>();
  let previousProofId = "";
  for (const raw of list(outbox["nativeProofs"])) {
    const row = exact(raw, ["artifactId", "sha256", "payloadBase64"]);
    requireEpoch(compare(id(row["artifactId"]), previousProofId) > 0);
    previousProofId = row["artifactId"];
    const proof = original(row["payloadBase64"]);
    requireEpoch((await rawSha(proof.bytes)) === sha(row["sha256"]));
    proofs.set(`${row["artifactId"]}:${row["sha256"]}`, proof.bytes);
  }
  const identities = new Map<string, string>();
  for (const raw of list(outbox["nativeFactIdentities"])) {
    const row = exact(raw, [
      "ownerEpoch",
      "journalSequence",
      "journalHeadHash",
      "factOrdinal",
      "projectionHash",
    ]);
    requireEpoch(
      ns(row["ownerEpoch"]) > 0n &&
        ns(row["journalSequence"]) > 0n &&
        Number.isInteger(row["factOrdinal"]) &&
        row["factOrdinal"] >= 0 &&
        row["factOrdinal"] < 64 &&
        !Object.is(row["factOrdinal"], -0)
    );
    const identity = `${row["ownerEpoch"]}:${row["journalSequence"]}:${sha(row["journalHeadHash"])}:${row["factOrdinal"]}`;
    requireEpoch(!identities.has(identity));
    identities.set(identity, sha(row["projectionHash"]));
  }
  const chains = new Map<string, { sequence: bigint; hash: string }>();
  const sourceOrdinals = new Map<string, number>();
  const latestSource = new Map<string, bigint>();
  const lastSource = new Map<string, string | null>();
  const usedProofs = new Set<string>();
  const usedSnapshotEvents = new Set<string>();
  const projections: NativeRecord[] = [];
  let publicationSequence = 0n;
  let pendingSeen = false;
  for (const raw of list(outbox["projections"])) {
    const row = exact(raw, [
      "publicationSequence",
      "ownerEpoch",
      "sequence",
      "eventHash",
      "kind",
      "acknowledged",
      "payloadBase64",
    ]);
    requireEpoch(
      ns(row["publicationSequence"]) === publicationSequence + 1n &&
        typeof row["acknowledged"] === "boolean" &&
        (!requireAcknowledged || row["acknowledged"]) &&
        !(pendingSeen && row["acknowledged"]) &&
        ns(row["ownerEpoch"]) > 0n &&
        ns(row["ownerEpoch"]) <= ns(outbox["priorOwnerEpoch"])
    );
    pendingSeen ||= !row["acknowledged"];
    publicationSequence += 1n;
    const originalProjection = original(row["payloadBase64"]);
    const projection = originalProjection.value;
    requireEpoch(
      projection["ownerEpoch"] === row["ownerEpoch"] &&
        projection["sequence"] === row["sequence"] &&
        projection["accountAlias"] === outbox["accountAlias"] &&
        projection["environment"] === "paper" &&
        projection["streamId"] === outbox["streamId"]
    );
    const chain = chains.get(row["ownerEpoch"]);
    const digest = sha(row["eventHash"]);
    if (row["kind"] === "portfolio-genesis") {
      requireEpoch(
        !chain &&
          row["sequence"] === "1" &&
          projection["sourceEventHash"] === digest
      );
      const matching = [...events.values()].filter(
        (item) =>
          item.event["kind"] === "portfolio-genesis" &&
          item.event["ownerEpoch"] === row["ownerEpoch"]
      );
      requireEpoch(matching.length === 1);
      const source = present(matching[0]);
      requireEpoch(
        same(source.event["data"], {
          snapshotId: projection["snapshotId"],
          sequence: "1",
          ownerEpoch: row["ownerEpoch"],
          sourceEventHash: digest,
        }) && source.before
      );
      await rebuildEpochSnapshot(present(source.before), projection);
      usedSnapshotEvents.add(source.event["eventId"]);
    } else if (row["kind"] === "execution" || row["kind"] === "native-fact") {
      requireEpoch(
        chain &&
          ns(row["sequence"]) === chain.sequence + 1n &&
          projection["previousEventHash"] === chain.hash &&
          projection["eventHash"] === digest
      );
      if (row["kind"] === "execution") {
        const sourceId = id(
          list(record(projection["receipt"])["auditEventIds"], 1)[0]
        );
        const source = [...events.values()].find(
          (item) => item.event["eventId"] === sourceId
        );
        const sourceState = executionStates.get(sourceId);
        requireEpoch(source && sourceState);
        await rebuildEpochExecutionProjection(
          present(sourceState),
          present(source).event,
          projection
        );
      } else {
        const parsed = await parseNativeFactProjection(projection);
        const key = `${parsed.proof.artifactId}:${parsed.proof.sha256}`;
        const proof = proofs.get(key);
        requireEpoch(proof);
        await parseNativeJournalProof(parsed, present(proof));
        usedProofs.add(key);
        const source = events.get(parsed.proofJournalSequence);
        requireEpoch(
          source &&
            source.event["eventId"] === parsed.proof.sourceEventId &&
            source.hash === parsed.proofJournalHeadHash &&
            source.event["ownerEpoch"] === row["ownerEpoch"] &&
            ns(source.event["occurredNs"]) ===
              timestampToEpochNanoseconds(parsed.occurredAt)
        );
        const identity = `${row["ownerEpoch"]}:${parsed.proofJournalSequence}:${parsed.proofJournalHeadHash}`;
        const ordinal = sourceOrdinals.get(identity) ?? 0;
        const latest = latestSource.get(row["ownerEpoch"]) ?? 0n;
        requireEpoch(
          parsed.factOrdinal === ordinal &&
            ordinal < 64 &&
            (ordinal === 0 || lastSource.get(row["ownerEpoch"]) === identity) &&
            ns(parsed.proofJournalSequence) >= latest &&
            (sourceOrdinals.has(identity) ||
              ns(parsed.proofJournalSequence) !== latest)
        );
        requireEpoch(identities.get(`${identity}:${ordinal}`) === digest);
        identities.delete(`${identity}:${ordinal}`);
        sourceOrdinals.set(identity, ordinal + 1);
        latestSource.set(row["ownerEpoch"], ns(parsed.proofJournalSequence));
        lastSource.set(row["ownerEpoch"], identity);
      }
    } else if (row["kind"] === "portfolio-snapshot") {
      requireEpoch(
        chain &&
          ns(row["sequence"]) === chain.sequence &&
          digest === chain.hash &&
          projection["sourceEventHash"] === chain.hash
      );
      const matching = [...events.values()].filter(
        (item) =>
          item.event["kind"] === "portfolio-checkpoint" &&
          item.event["ownerEpoch"] === row["ownerEpoch"] &&
          item.event["data"].snapshotId === projection["snapshotId"]
      );
      requireEpoch(matching.length === 1);
      const source = present(matching[0]);
      requireEpoch(
        same(source.event["data"], {
          snapshotId: projection["snapshotId"],
          sequence: row["sequence"],
          ownerEpoch: row["ownerEpoch"],
          sourceEventHash: digest,
        }) && source.before
      );
      await rebuildEpochSnapshot(present(source.before), projection, false);
      usedSnapshotEvents.add(source.event["eventId"]);
    } else requireEpoch(false);
    if (row["kind"] !== "native-fact") lastSource.set(row["ownerEpoch"], null);
    chains.set(row["ownerEpoch"], {
      sequence: ns(row["sequence"]),
      hash: digest,
    });
    projections.push({
      ...row,
      projection,
      payloadSha256: await rawSha(originalProjection.bytes),
    });
  }
  requireEpoch(identities.size === 0 && usedProofs.size === proofs.size);
  const expectedSnapshotEvents = [...events.values()]
    .filter((item) =>
      ["portfolio-genesis", "portfolio-checkpoint"].includes(item.event["kind"])
    )
    .map((item) => item.event["eventId"]);
  requireEpoch(
    expectedSnapshotEvents.length === usedSnapshotEvents.size &&
      expectedSnapshotEvents.every((eventId) => usedSnapshotEvents.has(eventId))
  );
  const priorHead = chains.get(outbox["priorOwnerEpoch"]);
  requireEpoch(
    priorHead &&
      priorHead.sequence === ns(outbox["priorProjectionSequence"]) &&
      priorHead.hash === sha(outbox["priorProjectionHash"])
  );
  const outboxSha256 = await rawSha(outboxBytes);
  const fenceSha256 = await rawSha(fenceBytes);
  const fence = exact(canonicalRecord(fenceBytes), [
    "format",
    "journalIdentity",
    "accountAlias",
    "environment",
    "simulatorId",
    "streamId",
    "priorOwnerEpoch",
    "ownerEpoch",
    "journalSequence",
    "journalHeadSha256",
    "capturedAtNs",
    "nativeOutboxEvidenceSha256",
    "claimSequence",
    "claimEventHash",
    "claimPayloadBase64",
    "processId",
    "ownerUid",
    "lockFile",
    "journalFile",
  ]);
  requireEpoch(
    fence["format"] === "vertex-native-owner-fence-v1" &&
      fence["nativeOutboxEvidenceSha256"] === outboxSha256
  );
  for (const field of [
    "journalIdentity",
    "accountAlias",
    "environment",
    "simulatorId",
    "streamId",
    "priorOwnerEpoch",
    "ownerEpoch",
    "journalSequence",
    "journalHeadSha256",
    "capturedAtNs",
  ])
    requireEpoch(fence[field] === outbox[field]);
  requireEpoch(
    fence["claimSequence"] === present(claim).sequence &&
      fence["claimEventHash"] === present(claim).hash &&
      fence["claimPayloadBase64"] === present(claim).payloadBase64 &&
      ns(fence["processId"]) > 0n
  );
  ns(fence["ownerUid"]);
  for (const field of ["lockFile", "journalFile"]) {
    const stat = exact(fence[field], [
      "device",
      "inode",
      "mode",
      "linkCount",
      "ownerUid",
    ]);
    ns(stat["device"]);
    requireEpoch(
      ns(stat["inode"]) > 0n &&
        stat["mode"] === "0600" &&
        stat["linkCount"] === "1" &&
        stat["ownerUid"] === fence["ownerUid"]
    );
  }
  requireEpoch(
    fence["lockFile"].device !== fence["journalFile"].device ||
      fence["lockFile"].inode !== fence["journalFile"].inode
  );
  return Object.freeze({
    outbox,
    fence,
    state,
    priorState: present(priorState),
    outboxSha256,
    fenceSha256,
    projections,
  });
};
