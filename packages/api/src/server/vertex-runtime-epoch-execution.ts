import { parseExecutionProjection } from "../contracts/vertex-control.ts";
import {
  hashArtifact,
  ns,
  record,
  requireEpoch,
  same,
  timestampToEpochNanoseconds,
  type NativeRecord,
} from "./vertex-runtime-epoch-bytes.ts";
import { decimal, units } from "./vertex-runtime-epoch-replay.ts";
import { present } from "./present.ts";

// Native parity: projection.py build_projection. Fractions remain exact; an
// imbalanced multi-leg fill is UNKNOWN, never fabricated completed package units.
export const rebuildEpochExecutionProjection = async (
  state: NativeRecord,
  sourceEvent: NativeRecord,
  input: unknown
): Promise<void> => {
  const projection = await parseExecutionProjection(input);
  requireEpoch(
    projection.ownerEpoch === sourceEvent["ownerEpoch"] &&
      projection.ownerEpoch === state["ownerEpoch"] &&
      projection.accountAlias === state["accountAlias"] &&
      state["environment"] === "paper"
  );
  requireEpoch(
    projection.receipt.auditEventIds.length === 1 &&
      projection.receipt.auditEventIds[0] === sourceEvent["eventId"] &&
      timestampToEpochNanoseconds(projection.occurredAt) ===
        ns(sourceEvent["occurredNs"])
  );
  const received = timestampToEpochNanoseconds(projection.receivedAt);
  requireEpoch(
    received >= ns(sourceEvent["occurredNs"]) &&
      timestampToEpochNanoseconds(projection.expiresAt) > received
  );
  const orderKey = projection.receipt.submissionKey;
  requireEpoch(Object.hasOwn(record(state["orders"]), orderKey));
  const order = record(state["orders"][orderKey]);
  const admission = record(order["admission"]);
  const intent = record(order["intent"]);
  const total = units(intent["quantity"]);
  const legs = Object.values(record(order["legs"])).map(record);
  requireEpoch(legs.length > 0 && legs.length <= 64);
  const fractions = legs.map(
    (leg) => [units(leg["filled"]), units(leg["maximumQuantity"])] as const
  );
  const [numerator, denominator] = present(fractions[0]);
  requireEpoch(
    denominator > 0n &&
      total > 0n &&
      fractions.every(
        ([legFilled, legMaximum]) =>
          legMaximum > 0n && legFilled >= 0n && legFilled <= legMaximum
      )
  );
  const balanced = fractions.every(
    ([a, b]) => a * denominator === numerator * b
  );
  const exact = (total * numerator) % denominator === 0n;
  const filled = balanced && exact ? (total * numerator) / denominator : 0n;
  let status = balanced && exact ? order["status"] : "unknown";
  if (status === "partially-filled" && !(filled > 0n && filled < total))
    status = "unknown";
  if (
    !["not-submitted", "rejected", "unknown"].includes(status) &&
    order["orderRef"] === null
  )
    status = "unknown";
  if (status === "filled" && filled !== total) status = "unknown";
  const receipt = {
    schemaVersion: "1.0.0",
    intentId: intent["intentId"],
    submissionKey: orderKey,
    brokerOrderRef: order["orderRef"],
    environment: "paper",
    observationOnly: true,
    status,
    totalQuantity: intent["quantity"],
    filledQuantity: decimal(filled),
    remainingQuantity: decimal(total - filled),
    lastReconciledAt: projection.receivedAt,
    errorClass: status === "unknown" ? "unknown-outcome" : null,
    auditEventIds: [sourceEvent["eventId"]],
  };
  const body: NativeRecord = {
    schemaVersion: "1.0.0",
    projectionId: `projection-${projection.ownerEpoch}-${projection.sequence}`,
    accountAlias: state["accountAlias"],
    environment: "paper",
    streamId: projection.streamId,
    ownerEpoch: projection.ownerEpoch,
    sequence: projection.sequence,
    previousEventHash: projection.previousEventHash,
    occurredAt: projection.occurredAt,
    receivedAt: projection.receivedAt,
    actorId: projection.actorId,
    policyVersion: admission["policyVersion"],
    strategyVersion: admission["strategyVersion"],
    reviewedArtifactSha256: admission["reviewedArtifactSha256"],
    admissionId: admission["admissionId"],
    expiresAt: projection.expiresAt,
    idempotencyKey: admission["idempotencyKey"],
    sourceKind: "paper-simulation",
    receipt,
    authoritative: false,
    reservationAuthority: "native-owner-only",
  };
  body["eventHash"] = await hashArtifact(body);
  requireEpoch(same(body, projection));
};
