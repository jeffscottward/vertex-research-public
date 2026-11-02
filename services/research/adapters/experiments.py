"""Lease-scoped private ExperimentHandoff persistence, with no execution authority.

Composition supplies the existing ArtifactAdapter plus expected, source-bound
current dependency review/rights pins. The server—not these input pins—decides
whether publication is authorized. A commit receipt is the only success signal.
"""
from __future__ import annotations

from types import MappingProxyType

from strategies.quant import ExperimentHandoff
from vertex_control.client import ControlError


class ControlImmutableExperimentStore:
    def __init__(self, artifacts, *, dependency_pins, deadline_ns, cancellation,
                 source_review_pins=None):
        if (artifacts.context.collection_id is None or type(deadline_ns) is not int
                or deadline_ns <= 0 or not callable(getattr(cancellation, "cancelled", None))):
            raise ControlError("experiment-store-context-unavailable")
        pins = tuple(MappingProxyType(dict(pin)) for pin in dependency_pins)
        if (not 1 <= len(pins) <= 64
                or len({pin.get("artifactId") for pin in pins}) != len(pins)):
            raise ControlError("experiment-dependency-pins-required")
        self._artifacts = artifacts
        self._dependency_pins = pins
        self._source_review_pins = None
        if source_review_pins is not None:
            source_pins = tuple(MappingProxyType(dict(pin)) for pin in source_review_pins)
            if (not 1 <= len(source_pins) <= 64
                    or len({pin.get("evidenceId") for pin in source_pins}) != len(source_pins)
                    or len({pin.get("artifactId") for pin in source_pins}) != len(source_pins)
                    or any(pin.get("collectionId") != artifacts.context.collection_id
                           or dict(pin) != artifacts.rights._pins.get(pin.get("evidenceId"))
                           or pin.get("artifactId") in {item["artifactId"] for item in pins}
                           for pin in source_pins)):
                raise ControlError("experiment-source-review-pin-mismatch")
            self._source_review_pins = source_pins
        self._deadline_ns = deadline_ns
        self._cancellation = cancellation

    def put_if_absent(self, handoff: ExperimentHandoff) -> str:
        if type(handoff) is not ExperimentHandoff:
            raise ControlError("experiment-handoff-required")
        # Frozen dataclass invariants plus authoritative server profile validation
        # preserve the original ID, strategy/dataset hashes and exact bytes.
        result = self._artifacts.publish_experiment_handoff(
            experiment_id=handoff.experiment_id, content=handoff.canonical_bytes,
            digest=handoff.content_hash, dependency_pins=self._dependency_pins,
            deadline_ns=self._deadline_ns, cancellation=self._cancellation,
            **({} if self._source_review_pins is None else
               {"source_review_pins": self._source_review_pins}),
        )
        if result["artifact"]["artifactSha256"] != handoff.content_hash:
            raise ControlError("experiment-commit-unconfirmed", effect="unknown")
        # No retry loop: transport/commit uncertainty propagates unchanged.
        return handoff.content_hash

    def read(self, *, experiment_id: str, expected_digest: str) -> bytes:
        """Read only an authorized committed private binding through readExperiment."""
        collection = self._artifacts.context.collection_id
        artifact_id = "experiment-" + self._artifacts.authority.digest({
            "collectionId": collection, "experimentId": experiment_id})
        return self._artifacts.read_experiment(
            experiment_id=experiment_id, artifact_id=artifact_id,
            expected_digest=expected_digest, collection_id=collection,
            deadline_ns=self._deadline_ns, cancellation=self._cancellation,
        )
