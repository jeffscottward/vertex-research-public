"""Exact ACK checking for durable native outbox publication over control HTTPS."""
from __future__ import annotations

import base64
import json
from typing import Any, Callable

from .cache import HostUnavailable
from .dispatcher import fence


class ControlProjectionPort:
    def __init__(self, *, control: Any, authority: Any, lease: Callable[[], dict[str, Any] | None],
                 epoch_transition: Callable[[dict[str, Any]], Any] | None = None,
                 requires_epoch_transition: Callable[[dict[str, Any]], bool] | None = None) -> None:
        self.control, self.authority, self.lease = control, authority, lease
        self.epoch_transition = epoch_transition
        self.requires_epoch_transition = requires_epoch_transition or (lambda snapshot: int(snapshot["ownerEpoch"]) > 1)

    def _fence(self) -> dict[str, str]:
        lease = self.lease()
        if lease is None:
            raise HostUnavailable("projection-publication-lease-unavailable")
        return fence(lease)

    def _ack(self, response: dict[str, Any], digest: str, sequence: str) -> str:
        self.authority.validate("WorkerProjectionAck", response)
        if (response["status"] not in ("applied", "duplicate") or response["highWaterEventHash"] != digest
                or response["highWaterSequence"] != sequence):
            raise HostUnavailable("projection-continuity-not-acknowledged")
        return digest

    async def publish(self, canonical_projection: bytes, *, event_hash: str) -> str:
        projection = json.loads(canonical_projection)
        self.authority.validate("ExecutionProjection", projection)
        if self.authority.encode(projection) != canonical_projection or projection["eventHash"] != event_hash:
            raise HostUnavailable("outbox-projection-identity-mismatch")
        result = await self.control.publish_order_projection(**self._fence(), projection=projection)
        return self._ack(result, event_hash, projection["sequence"])

    async def publish_portfolio_genesis(self, canonical_snapshot: bytes, *, source_hash: str) -> str:
        snapshot = json.loads(canonical_snapshot)
        self.authority.validate("PortfolioSnapshot", snapshot)
        if self.authority.encode(snapshot) != canonical_snapshot or snapshot["sourceEventHash"] != source_hash:
            raise HostUnavailable("outbox-snapshot-identity-mismatch")
        if self.requires_epoch_transition(snapshot):
            if self.epoch_transition is None:
                raise HostUnavailable("restored-epoch-transition-proof-unavailable")
            transition = await self.epoch_transition(snapshot)
            self.authority.validate("PortfolioEpochTransition", transition)
            if transition["snapshot"] != snapshot:
                raise HostUnavailable("restored-epoch-transition-snapshot-mismatch")
            result = await self.control.publish_epoch_transition(**self._fence(), transition=transition)
        else:
            result = await self.control.publish_genesis(**self._fence(), snapshot=snapshot)
        return self._ack(result, source_hash, snapshot["sequence"])

    async def publish_portfolio_snapshot(self, canonical_snapshot: bytes, *, source_hash: str) -> str:
        snapshot = json.loads(canonical_snapshot)
        self.authority.validate("PortfolioSnapshot", snapshot)
        if self.authority.encode(snapshot) != canonical_snapshot or snapshot["sourceEventHash"] != source_hash:
            raise HostUnavailable("outbox-snapshot-identity-mismatch")
        result = await self.control.publish_portfolio_snapshot(**self._fence(), snapshot=snapshot)
        return self._ack(result, source_hash, snapshot["sequence"])

    async def publish_native_fact(self, canonical_projection: bytes, proof_bytes: bytes, *, event_hash: str) -> str:
        projection = json.loads(canonical_projection)
        self.authority.validate("NativeFactProjection", projection)
        self.authority.validate_native_journal_proof(projection, proof_bytes)
        if self.authority.encode(projection) != canonical_projection or projection["eventHash"] != event_hash:
            raise HostUnavailable("outbox-native-fact-identity-mismatch")
        result = await self.control.publish_native_facts(**self._fence(), projection=projection,
                                                        proofBase64=base64.b64encode(proof_bytes).decode("ascii"))
        return self._ack(result, event_hash, projection["sequence"])
