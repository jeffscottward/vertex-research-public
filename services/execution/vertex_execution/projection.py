"""Observation-only projection construction and ordered asynchronous outbox IO."""
from __future__ import annotations

import asyncio
from typing import Any

import json
from .exact import decimal, timestamp, units
from .journal import Journal
from .ports import ContractAuthority, ExecutionError, ProjectionPort


def build_projection(*, authority: ContractAuthority, state: dict[str, Any],
                     order_key: str, stream_id: str, epoch: int, sequence: int,
                     previous_hash: str | None, occurred_ns: int, received_ns: int,
                     ttl_ns: int, audit_event_id: str, native_emitter_actor_id: str) -> dict[str, Any]:
    if received_ns < occurred_ns or ttl_ns <= 0:
        raise ExecutionError("projection-chronology-invalid")
    order = state["orders"][order_key]
    admission, intent = order["admission"], order["intent"]
    total = units(intent["quantity"])
    # Public receipt describes completed package units; per-leg obligations stay
    # in the native journal. Imbalanced legs are UNKNOWN, not falsely netted.
    fractions = [(units(leg["filled"]), units(leg["maximumQuantity"])) for leg in order["legs"].values()]
    numerator, denominator = fractions[0]
    balanced = all(a * denominator == numerator * b for a, b in fractions)
    exact = (total * numerator) % denominator == 0
    filled = total * numerator // denominator if balanced and exact else 0
    status = order["status"] if balanced and exact else "unknown"
    if status == "partially-filled" and not (0 < filled < total):
        status = "unknown"
    if status not in {"not-submitted", "rejected", "unknown"} and order["orderRef"] is None:
        status = "unknown"
    if status == "filled" and filled != total:
        status = "unknown"
    receipt = {"schemaVersion": "1.0.0", "intentId": intent["intentId"],
               "submissionKey": order_key, "brokerOrderRef": order["orderRef"],
               "environment": "paper", "observationOnly": True, "status": status,
               "totalQuantity": intent["quantity"], "filledQuantity": decimal(filled),
               "remainingQuantity": decimal(total - filled), "lastReconciledAt": timestamp(received_ns),
               "errorClass": "unknown-outcome" if status == "unknown" else None,
               "auditEventIds": [audit_event_id]}
    if authority.validate("ExecutionReceipt", receipt) is not True:
        raise ExecutionError("native-receipt-validation-required")
    value = {"schemaVersion": "1.0.0", "projectionId": f"projection-{epoch}-{sequence}",
             "accountAlias": state["accountAlias"], "environment": "paper", "streamId": stream_id,
             "ownerEpoch": str(epoch), "sequence": str(sequence), "previousEventHash": previous_hash,
             "occurredAt": timestamp(occurred_ns), "receivedAt": timestamp(received_ns),
             "actorId": native_emitter_actor_id, "policyVersion": admission["policyVersion"],
             "strategyVersion": admission["strategyVersion"],
             "reviewedArtifactSha256": admission["reviewedArtifactSha256"],
             "admissionId": admission["admissionId"],
             # This is explicit observation retention/freshness policy, NOT a
             # renewed admission expiry or permission to dispatch after expiry.
             "expiresAt": timestamp(received_ns + ttl_ns),
             "idempotencyKey": admission["idempotencyKey"], "sourceKind": "paper-simulation",
             "receipt": receipt, "authoritative": False, "reservationAuthority": "native-owner-only"}
    value["eventHash"] = authority.digest(value)
    if authority.validate("ExecutionProjection", value) is not True:
        raise ExecutionError("native-projection-validation-required")
    return value


class OrderedProjectionPublisher:
    def __init__(self, journal: Journal, port: ProjectionPort) -> None:
        with journal.mutex:
            if getattr(journal, "_publisher_claimed", False):
                raise ExecutionError("ordered-publisher-already-attached")
            journal._publisher_claimed = True
        self.journal, self.port = journal, port
        self._lock = asyncio.Lock()

    async def publish_one(self) -> bool:
        async with self._lock:
            item = await asyncio.to_thread(self.journal.next_projection)
            if item is None:
                return False
            number, digest, encoded = item
            # No regenerated timestamp, rehash, retry loop or next-row bypass.
            # Network failure leaves durable exact bytes for later explicit retry.
            kind = await asyncio.to_thread(self.journal.next_projection_kind)
            if kind == "portfolio-genesis":
                acknowledged = await self.port.publish_portfolio_genesis(encoded, source_hash=digest)
            elif kind == "execution":
                acknowledged = await self.port.publish(encoded, event_hash=digest)
            elif kind == "portfolio-snapshot":
                acknowledged = await self.port.publish_portfolio_snapshot(encoded, source_hash=digest)
            elif kind == "native-fact":
                proof = await asyncio.to_thread(self.journal.native_proof, json.loads(encoded))
                acknowledged = await self.port.publish_native_fact(encoded, proof, event_hash=digest)
            else:
                raise ExecutionError("unsupported-publication-kind")
            if acknowledged != digest:
                raise ExecutionError("projection-acknowledgment-hash-mismatch")
            await asyncio.to_thread(self.journal.acknowledge_projection, number, digest)
            return True
