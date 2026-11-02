"""Pure normalized-Candle fold candidates, not verified training authority.

Only DatasetPlanner's exact records/unitsAndAvailability envelope is supported.
No source I/O, clock, fitter, executor, economic aggregation or default policy is
provided. Public schema/canonical ports remain authoritative. A separate current
source/policy authority and a real bounded host are mandatory for the optional
FoldSelector adapter; the workflow's independent FoldVerifier is still required
before any fitter sees records. Counts/byte checks here are not sandbox evidence.
"""
from __future__ import annotations

import hashlib
from dataclasses import asdict, dataclass, field
from datetime import datetime
from typing import Any, Protocol

from .candle_labels import (
    CANDLE_CONTENT_FORMAT, CandleDatasetPolicy, CandleLabelPolicy, CandleSourcePin,
    decimal_fraction, interval_ns, simple_return,
)
from .fold_contracts import FoldPortPin, FoldRecord, FoldSelection, FoldSelectionRequest
from .lineage import Pin, time_ns, timestamp, utc
from .planner import DatasetInput
from .ports import Artifact, ContractRejected, PortUnavailable, PublicBoundary, decode_json, require_hash


_UNIT_KEYS = frozenset({
    "sourceId", "snapshotId", "contentHash", "instrumentId", "currency", "priceUnit",
    "quantityUnit", "calendar", "providerTimezone", "asOfAt", "receivedAt", "dataKind",
    "syntheticReason", "sourceReference",
})
_PRICE_FIELDS = ("open", "high", "low", "close", "volume")


def _object(value: Any, keys: set[str] | frozenset[str]) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != keys:
        raise PortUnavailable("candle-envelope-shape-unsupported")
    return value


def _canonical(boundary: PublicBoundary, name: str, raw: bytes, *, public: bool = False) -> Artifact:
    if not isinstance(raw, bytes) or not 0 < len(raw) <= boundary.maximum_bytes:
        raise ContractRejected("candle-canonical-byte-budget-rejected")
    value = decode_json(raw)
    if public and not isinstance(value, dict):
        raise ContractRejected("candle-public-object-required")
    artifact = boundary.public(name, value) if public else boundary.internal(name, value)
    if artifact.payload_bytes != raw:
        raise ContractRejected("candle-noncanonical-source-bytes")
    return artifact


def _same(boundary: PublicBoundary, left: Any, right: Any) -> bool:
    return boundary.internal("internal.CandleComparison.v1", left) == boundary.internal("internal.CandleComparison.v1", right)


def _source_key(value: dict[str, Any]) -> tuple[str, str, str]:
    return value["sourceId"], value["snapshotId"], value["contentHash"]


@dataclass(frozen=True)
class CandleRow:
    candle_id: str
    row_index: int
    row_digest: str
    source: CandleSourcePin
    unit_digest: str
    start_at: str
    end_at: str
    available_at: str
    values: tuple[tuple[str, str], ...]

    def reference(self, policy: CandleDatasetPolicy) -> dict[str, Any]:
        return {
            "datasetId": policy.data_pin.dataset_id, "manifestDigest": policy.data_pin.manifest_digest,
            "contentDigest": policy.data_pin.content_digest, "rowIndex": self.row_index,
            "rowDigest": self.row_digest, "candleId": self.candle_id,
            "source": self.source.record(policy.provider), "unitsAndAvailabilityDigest": self.unit_digest,
            "startAtInclusive": self.start_at, "endAtExclusive": self.end_at, "receivedAt": self.available_at,
        }


@dataclass(frozen=True)
class DecodedCandleDataset:
    policy: CandleDatasetPolicy
    manifest: Artifact
    rows: tuple[CandleRow, ...]


def decode_candle_dataset(
    source: DatasetInput, policy: CandleDatasetPolicy, boundary: PublicBoundary, *, maximum_rows: int,
) -> DecodedCandleDataset:
    """Verify every row before selecting; old unbound availability is unavailable.

    receivedAt is acquisition, not observation/asOfAt. The independent policy
    authority must qualify that exact mapping for the pinned original sources;
    this structural check never upgrades raw historical data to point-in-time.
    """
    if boundary.missing_ports:
        raise PortUnavailable(",".join(boundary.missing_ports))
    if (source.content_format != CANDLE_CONTENT_FORMAT or source.content_bytes is None
            or type(maximum_rows) is not int or not 1 <= maximum_rows <= 100_000):
        raise PortUnavailable("candle-content-format-or-budget-unsupported")
    if (source.declared_events > maximum_rows
            or len(source.manifest_bytes) + len(source.content_bytes) > boundary.maximum_bytes):
        raise ContractRejected("candle-dataset-input-budget-rejected")
    manifest = _canonical(boundary, "DatasetManifest", source.manifest_bytes, public=True)
    data = manifest.decode()
    pin = policy.data_pin
    if (manifest.digest != pin.manifest_digest or data["datasetId"] != pin.dataset_id
            or hashlib.sha256(source.content_bytes).hexdigest() != pin.content_digest
            or data["contentHash"] != pin.content_digest):
        raise ContractRejected("candle-manifest-or-content-pin-mismatch")
    expected_sources = [item.record(policy.provider) for item in policy.sources]
    if (not _same(boundary, data["sources"], expected_sources)
            or tuple(item["contentHash"] for item in data["sources"]) != pin.source_digests
            or data["provider"] != policy.provider or data["instrumentUniverse"] != [policy.instrument_id]
            or data["calendar"] != pin.calendar_pin.identity or data["adjustmentMethod"] != policy.adjustment_method
            or data["dataVintageStatus"] != "available" or data["dataVintageId"] != pin.vintage_id):
        raise ContractRejected("candle-dataset-policy-mismatch")
    if (data["startAtInclusive"] != policy.source_start_at or data["endAtExclusive"] != policy.source_end_at
            or not time_ns(data["endAtExclusive"]) <= time_ns(data["asOfAt"]) <= time_ns(data["captureTime"])):
        raise ContractRejected("candle-dataset-time-bound-mismatch")
    envelope = _canonical(boundary, "internal.NormalizedCandleEnvelope.v1", source.content_bytes).decode()
    envelope = _object(envelope, {"records", "unitsAndAvailability"})
    records, units = envelope["records"], envelope["unitsAndAvailability"]
    if (not isinstance(records, list) or len(records) != source.declared_events or not 1 <= len(records) <= maximum_rows
            or not isinstance(units, list) or not 1 <= len(units) <= 512):
        raise ContractRejected("candle-envelope-count-rejected")
    expected_keys = {_source_key(item) for item in expected_sources}
    unit_map: dict[tuple[str, str, str], tuple[dict[str, Any], Artifact]] = {}
    for item in units:
        unit = _object(item, _UNIT_KEYS)
        source_pin = CandleSourcePin(unit["sourceId"], unit["snapshotId"], unit["contentHash"])
        key = (source_pin.source_id, source_pin.snapshot_id, source_pin.content_hash)
        if key not in expected_keys or key in unit_map:
            raise ContractRejected("candle-availability-source-ambiguous-or-unpinned")
        if (unit["instrumentId"] != policy.instrument_id or unit["currency"] != policy.currency
                or unit["priceUnit"] != policy.currency or unit["quantityUnit"] != policy.quantity_unit
                or unit["calendar"] != pin.calendar_pin.identity or unit["providerTimezone"] != policy.provider_timezone
                or unit["dataKind"] != "real" or unit["syntheticReason"] is not None):
            raise PortUnavailable("candle-availability-units-or-data-kind-unsupported")
        if (not isinstance(unit["sourceReference"], str) or not 1 <= len(unit["sourceReference"]) <= 4096
                or any(ord(char) < 32 or ord(char) == 127 for char in unit["sourceReference"])):
            raise ContractRejected("candle-source-reference-rejected")
        as_of, received = time_ns(unit["asOfAt"]), time_ns(unit["receivedAt"])
        if (not as_of <= received <= time_ns(data["captureTime"]) or as_of > time_ns(data["asOfAt"])
                or not time_ns(policy.availability_start_at) <= received < time_ns(policy.availability_end_at)):
            raise ContractRejected("candle-availability-time-bound-rejected")
        unit_map[key] = (unit, boundary.internal("internal.CandleUnitsAndAvailability.v1", unit))
    if set(unit_map) != expected_keys:
        raise ContractRejected("candle-source-availability-missing")
    rows: list[CandleRow] = []
    seen: set[str] = set()
    used: set[tuple[str, str, str]] = set()
    for ordinal, item in enumerate(records):
        row = _object(item, {"contract", "digest", "record"})
        if row["contract"] != "Candle" or not isinstance(row["record"], dict):
            raise PortUnavailable("candle-only-records-required")
        checked = boundary.public("Candle", row["record"])
        require_hash(row["digest"])
        if checked.digest != row["digest"]:
            raise ContractRejected("candle-row-digest-mismatch")
        value = checked.decode()
        identity, metadata = value["source"]["identity"], value["source"]
        key = _source_key(identity)
        if key not in unit_map or identity["provider"] != policy.provider:
            raise ContractRejected("candle-row-source-not-pinned")
        unit, unit_artifact = unit_map[key]
        if (value["instrumentId"] != policy.instrument_id or value["currency"] != policy.currency
                or value["interval"] != policy.interval or metadata["providerTimezone"] != policy.provider_timezone
                or metadata["dataKind"] != "real" or metadata["syntheticReason"] is not None
                or metadata["entitlement"]["policyId"] != data["entitlementPolicyId"]):
            raise ContractRejected("candle-row-series-binding-mismatch")
        begins, ends = time_ns(value["startAtInclusive"]), time_ns(value["endAtExclusive"])
        observed = metadata["freshness"]["observedAt"]
        if observed is None:
            raise PortUnavailable("candle-source-observation-unavailable")
        if (ends - begins != interval_ns(policy.interval)
                or not time_ns(policy.source_start_at) <= begins < ends <= time_ns(policy.source_end_at)
                or not ends <= time_ns(observed) <= time_ns(unit["asOfAt"]) <= time_ns(unit["receivedAt"])
                or not time_ns(observed) <= time_ns(metadata["freshness"]["evaluatedAt"]) <= time_ns(data["captureTime"])
                or time_ns(metadata["entitlement"]["checkedAt"]) > time_ns(data["captureTime"])):
            raise ContractRejected("candle-row-time-or-completion-rejected")
        if value["candleId"] in seen:
            raise ContractRejected("candle-duplicate-row-identity")
        seen.add(value["candleId"])
        used.add(key)
        values = tuple((name, value[name]) for name in _PRICE_FIELDS)
        for _, number in values:
            decimal_fraction(number)
        rows.append(CandleRow(value["candleId"], ordinal, checked.digest,
                              CandleSourcePin(*key), unit_artifact.digest,
                              value["startAtInclusive"], value["endAtExclusive"], unit["receivedAt"], values))
    if used != expected_keys:
        raise ContractRejected("candle-unused-pinned-source")
    rows.sort(key=lambda row: (time_ns(row.start_at), row.candle_id))
    for previous, current in zip(rows, rows[1:]):
        if time_ns(previous.end_at) != time_ns(current.start_at):
            raise PortUnavailable("candle-gap-overlap-or-revision-unsupported")
    return DecodedCandleDataset(policy, manifest, tuple(rows))


@dataclass(frozen=True)
class CandleSelectionCandidate:
    request_digest: str
    policy_pin: Pin
    training: tuple[FoldRecord, ...]
    test: tuple[FoldRecord, ...]
    selection_proof: Artifact
    execution_authorized: bool = field(default=False, init=False)


def _checked_binding(
    request: FoldSelectionRequest, policy: CandleLabelPolicy, policy_pin: Pin,
    selector_pin: FoldPortPin, boundary: PublicBoundary,
) -> Artifact:
    if request.binding.contract_name != "internal.FoldBinding.v1":
        raise ContractRejected("candle-fold-binding-contract-rejected")
    binding = _canonical(boundary, request.binding.contract_name, request.binding.payload_bytes)
    if binding != request.binding:
        raise ContractRejected("candle-fold-binding-digest-rejected")
    value = binding.decode()
    if (not isinstance(value, dict) or value.get("executionAuthorized") is not False
            or not _same(boundary, value.get("fold"), request.fold.record())
            or not _same(boundary, value.get("budget"), asdict(request.budget))
            or not _same(boundary, value.get("selectorPin"), asdict(selector_pin))
            or not _same(boundary, value.get("dataPins"), [asdict(item.data_pin) for item in policy.datasets])):
        raise ContractRejected("candle-fold-binding-policy-mismatch")
    if request.fold.failure_codes():
        raise ContractRejected("candle-fold-causal-policy-rejected")
    if time_ns(policy.registered_at) > time_ns(request.fold.fitted_at):
        raise ContractRejected("candle-policy-not-preregistered")
    return policy.seal(boundary, policy_pin)


def _features(
    rows: tuple[CandleRow, ...], dataset: CandleDatasetPolicy, policy: CandleLabelPolicy,
    pin: Pin, boundary: PublicBoundary,
) -> Artifact:
    return boundary.internal("internal.CandleFeatures.v1", {
        "policyPin": asdict(pin), "datasetPin": asdict(dataset.data_pin),
        "instrumentId": dataset.instrument_id, "currency": dataset.currency,
        "interval": dataset.interval, "quantityUnit": dataset.quantity_unit,
        "fields": list(policy.feature_fields), "windowBars": policy.feature_window_bars,
        "transform": policy.feature_transform,
        "rows": [{"source": row.reference(dataset),
                  "values": {name: dict(row.values)[name] for name in policy.feature_fields}} for row in rows],
        "executionAuthorized": False,
    })


def select_candle_candidate(
    request: FoldSelectionRequest, *, policy: CandleLabelPolicy, policy_pin: Pin,
    selector_pin: FoldPortPin, boundary: PublicBoundary,
) -> CandleSelectionCandidate:
    """Deterministic unverified candidate; no receipt or authority is fabricated.

    Training endpoints must remain strictly inside the training observation
    window, at/before label-end, before test, purge-qualified and acquired by
    fit. Feature windows are entirely partition-local (including test warmup).
    Late feature acquisition cannot be used to predict an already-ended target.
    Test targets are never computed or embedded in any test feature artifact.
    """
    sealed_policy = _checked_binding(request, policy, policy_pin, selector_pin, boundary)
    budget = request.budget
    if len(request.sources) != len(policy.datasets):
        raise ContractRejected("candle-dataset-count-mismatch")
    input_bytes = len(request.binding.payload_bytes) + len(sealed_policy.payload_bytes)
    input_bytes += sum(len(item.manifest_bytes) + len(item.content_bytes or b"") for item in request.sources)
    if input_bytes > budget.maximum_input_bytes:
        raise ContractRejected("candle-selection-input-budget-rejected")
    if sum(item.declared_events for item in request.sources) > budget.maximum_events:
        raise ContractRejected("candle-selection-source-row-budget-rejected")
    training: list[FoldRecord] = []
    test: list[FoldRecord] = []
    proof_rows: list[dict[str, Any]] = []
    retained_bytes = len(sealed_policy.payload_bytes)
    fold = request.fold
    train_start, train_end = time_ns(fold.training.start_at), time_ns(fold.training.end_at)
    test_start, test_end = time_ns(fold.test.start_at), time_ns(fold.test.end_at)
    fit_at, label_end = time_ns(fold.fitted_at), time_ns(fold.training_labels_end_at)
    for source, dataset_policy in zip(request.sources, policy.datasets, strict=True):
        decoded = decode_candle_dataset(source, dataset_policy, boundary, maximum_rows=min(100_000, budget.maximum_events))
        rows = decoded.rows
        counts = {"training": 0, "test": 0, "outsideWindow": 0, "warmup": 0,
                  "featureUnavailable": 0, "labelUnavailable": 0}
        for index, row in enumerate(rows):
            observed = time_ns(row.end_at)
            is_training = train_start <= observed < train_end
            is_test = test_start <= observed < test_end
            if not is_training and not is_test:
                counts["outsideWindow"] += 1
                continue
            start_index = index + 1 - policy.feature_window_bars
            partition_start = train_start if is_training else test_start
            if start_index < 0 or time_ns(rows[start_index].start_at) < partition_start:
                counts["warmup"] += 1
                continue
            window = rows[start_index:index + 1]
            available = max((item.available_at for item in window), key=time_ns)
            if (is_training and time_ns(available) > fit_at) or (is_test and time_ns(available) >= test_end):
                counts["featureUnavailable"] += 1
                continue
            label: Artifact | None = None
            endpoint: CandleRow | None = None
            label_available: str | None = None
            if is_training:
                endpoint_index = index + policy.horizon_bars
                if endpoint_index >= len(rows):
                    counts["labelUnavailable"] += 1
                    continue
                endpoint = rows[endpoint_index]
                endpoint_at = time_ns(endpoint.end_at)
                label_available = max(row.available_at, endpoint.available_at, key=time_ns)
                if (endpoint_at >= train_end or endpoint_at > label_end or endpoint_at >= test_start
                        or endpoint_at + fold.purge_ms * 1_000_000 > test_start
                        or time_ns(label_available) > fit_at or time_ns(available) >= endpoint_at):
                    counts["labelUnavailable"] += 1
                    continue
                label = boundary.internal("internal.CandleSimpleReturn.v1", {
                    "policyPin": asdict(policy_pin), "datasetPin": asdict(dataset_policy.data_pin),
                    "target": policy.target, "horizonBars": policy.horizon_bars,
                    "representation": policy.target_representation, "unit": "dimensionless",
                    "value": simple_return(dict(row.values)["close"], dict(endpoint.values)["close"]),
                    "start": row.reference(dataset_policy), "endpoint": endpoint.reference(dataset_policy),
                    "labelEndAt": endpoint.end_at, "labelAvailableAt": label_available,
                    "executionAuthorized": False,
                })
            features = _features(window, dataset_policy, policy, policy_pin, boundary)
            retained_bytes += len(features.payload_bytes) + (len(label.payload_bytes) if label else 0)
            if retained_bytes > budget.maximum_input_bytes:
                raise ContractRejected("candle-selection-output-byte-budget-rejected")
            record = FoldRecord(row.candle_id, dataset_policy.data_pin.dataset_id, dataset_policy.data_pin.content_digest,
                                row.end_at, available, features, label,
                                endpoint.end_at if endpoint is not None else None, label_available)
            (training if is_training else test).append(record)
            counts["training" if is_training else "test"] += 1
        proof_rows.append({"datasetPin": asdict(dataset_policy.data_pin), "inputRows": len(rows), "counts": counts})
    training.sort(key=lambda item: (time_ns(item.observed_at), item.dataset_id, item.record_id))
    test.sort(key=lambda item: (time_ns(item.available_at), item.dataset_id, item.record_id))
    if not training or not test or len(training) + len(test) > budget.maximum_events:
        raise PortUnavailable("candle-causal-training-or-test-records-unavailable")
    proof = boundary.internal("internal.CandleSelectionProof.v1", {
        "requestDigest": request.binding.digest, "policyPin": asdict(policy_pin),
        "policyDigest": sealed_policy.digest, "selectorPin": asdict(selector_pin),
        "contentFormat": CANDLE_CONTENT_FORMAT, "datasets": proof_rows,
        "training": [{"datasetId": item.dataset_id, "recordId": item.record_id,
                      "featuresDigest": item.features.digest, "labelDigest": item.label.digest}
                     for item in training if item.label is not None],
        "test": [{"datasetId": item.dataset_id, "recordId": item.record_id,
                  "featuresDigest": item.features.digest} for item in test],
        "verified": False, "executionAuthorized": False,
    })
    if retained_bytes + len(proof.payload_bytes) > budget.maximum_input_bytes:
        raise ContractRejected("candle-selection-proof-byte-budget-rejected")
    return CandleSelectionCandidate(request.binding.digest, policy_pin, tuple(training), tuple(test), proof)


@dataclass(frozen=True)
class CandleAuthorityRequest:
    """Current review/rights request; exact parent policy AND Candle config bound."""
    binding: Artifact
    policy: Artifact
    policy_pin: Pin
    selector_pin: FoldPortPin
    verifier_pin: Pin
    sources: tuple[DatasetInput, ...]
    checked_at: str


class CandleCurrentAuthority(Protocol):
    descriptor: Pin

    def verify(self, request: CandleAuthorityRequest) -> Artifact:
        """Return internal.CandleAuthority.v1 from independent current authority.

        Verify original source bytes/availability mapping, rights to read/derive,
        review evidence and the exact Candle policy pin's registration under the
        parent WalkForwardPolicy/selector configuration. A matching code pin alone
        is NOT a configuration review. Denied, expired, unknown or unsupported
        authority must raise; caller-supplied review IDs cannot self-approve.
        Result shape is checked by the adapter below, not minted by this module.
        This is admission only: it does not replace FoldVerifier.verify_selection.
        """
        ...


class CandleClock(Protocol):
    def now(self) -> datetime: ...


class BoundedCandleSelectionHost(Protocol):
    descriptor: FoldPortPin

    def select(
        self, request: FoldSelectionRequest, policy: CandleLabelPolicy,
        policy_pin: Pin, admission: Artifact,
    ) -> FoldSelection:
        """Run select_candle_candidate in a real pinned bounded stage.

        Enforce every ResourceBudget limit before/during allocation and execution,
        including the policy/admission bytes in input accounting. Enforce the
        admission lease throughout processing and retain its digest in genuine
        stage evidence. Return candidate fields with FoldStageEvidence from this
        run, never estimates or fabricated success. Original sources must remain
        inaccessible to fitters. No host, process or grant is supplied here.
        """
        ...


class CandleFoldSelector:
    """Exact FoldSelector port; unavailable without external authority and host."""

    def __init__(
        self, *, descriptor: FoldPortPin, policy: CandleLabelPolicy, policy_pin: Pin,
        verifier_pin: Pin, authority: CandleCurrentAuthority | None,
        host: BoundedCandleSelectionHost | None, clock: CandleClock | None,
        boundary: PublicBoundary,
    ) -> None:
        if (descriptor.pin.identity == verifier_pin.identity or descriptor.pin.digest == verifier_pin.digest
                or (authority is not None and authority is host)):
            raise ValueError("independent Candle authority pin required")
        self.descriptor, self.policy, self.policy_pin = descriptor, policy, policy_pin
        self.verifier_pin, self.authority, self.host = verifier_pin, authority, host
        self.clock, self.boundary = clock, boundary

    def _admit(self, request: FoldSelectionRequest, sealed_policy: Artifact) -> Artifact:
        if self.authority is None or self.clock is None:
            raise PortUnavailable("candle-independent-current-authority-required")
        if self.authority.descriptor != self.verifier_pin:
            raise ContractRejected("candle-current-authority-pin-mismatch")
        now = timestamp(utc(self.clock.now()))
        checked = self.authority.verify(CandleAuthorityRequest(
            request.binding, sealed_policy, self.policy_pin, self.descriptor,
            self.verifier_pin, request.sources, now,
        ))
        if not isinstance(checked, Artifact) or checked.contract_name != "internal.CandleAuthority.v1":
            raise ContractRejected("candle-current-authority-result-rejected")
        if _canonical(self.boundary, checked.contract_name, checked.payload_bytes) != checked:
            raise ContractRejected("candle-current-authority-bytes-rejected")
        value = _object(checked.decode(), {"requestDigest", "policyDigest", "selectorPin", "verifierPin",
                                          "checkedAt", "expiresAt", "reviewEvidenceIds", "verified", "executionAuthorized"})
        after = timestamp(utc(self.clock.now()))
        if (value["requestDigest"] != request.binding.digest or value["policyDigest"] != sealed_policy.digest
                or not _same(self.boundary, value["selectorPin"], asdict(self.descriptor))
                or not _same(self.boundary, value["verifierPin"], asdict(self.verifier_pin))
                or value["checkedAt"] != now or not time_ns(now) <= time_ns(after) < time_ns(value["expiresAt"])
                or not _same(self.boundary, value["reviewEvidenceIds"], list(self.policy.review_evidence_ids))
                or value["verified"] is not True or value["executionAuthorized"] is not False):
            raise ContractRejected("candle-current-authority-scope-or-expiry-rejected")
        return checked

    def select(self, request: FoldSelectionRequest) -> FoldSelection:
        sealed_policy = _checked_binding(request, self.policy, self.policy_pin, self.descriptor, self.boundary)
        if self.host is None:
            raise PortUnavailable("candle-real-bounded-selection-host-required")
        if self.host.descriptor != self.descriptor:
            raise ContractRejected("candle-selection-host-pin-mismatch")
        admission = self._admit(request, sealed_policy)
        input_bytes = len(request.binding.payload_bytes) + len(sealed_policy.payload_bytes) + len(admission.payload_bytes)
        input_bytes += sum(len(item.manifest_bytes) + len(item.content_bytes or b"") for item in request.sources)
        if input_bytes > request.budget.maximum_input_bytes:
            raise ContractRejected("candle-host-input-byte-budget-rejected")
        selected = self.host.select(request, self.policy, self.policy_pin, admission)
        if not isinstance(selected, FoldSelection) or selected.request_digest != request.binding.digest:
            raise ContractRejected("candle-host-selection-binding-rejected")
        proof = selected.selection_proof
        if (proof.contract_name != "internal.CandleSelectionProof.v1"
                or _canonical(self.boundary, proof.contract_name, proof.payload_bytes) != proof):
            raise ContractRejected("candle-host-selection-proof-rejected")
        proof_value = proof.decode()
        if (not isinstance(proof_value, dict) or proof_value.get("requestDigest") != request.binding.digest
                or proof_value.get("policyDigest") != sealed_policy.digest
                or not _same(self.boundary, proof_value.get("policyPin"), asdict(self.policy_pin))
                or not _same(self.boundary, proof_value.get("selectorPin"), asdict(self.descriptor))
                or proof_value.get("verified") is not False or proof_value.get("executionAuthorized") is not False):
            raise ContractRejected("candle-host-policy-proof-binding-rejected")
        receipt = selected.evidence.sandbox
        budget = request.budget
        if (receipt.policy_digest != self.descriptor.sandbox_policy_digest or receipt.budget != budget
                or receipt.limits_enforced is not True or receipt.network_used is not False
                or receipt.execution_authority_used is not False
                or not input_bytes <= receipt.input_bytes <= budget.maximum_input_bytes
                or not 0 < receipt.events_processed <= budget.maximum_events
                or receipt.events_processed < sum(item.declared_events for item in request.sources)
                or receipt.peak_memory_bytes > budget.maximum_memory_bytes
                or receipt.cpu_ms > budget.maximum_cpu_ms or receipt.wall_ms > budget.maximum_wall_ms
                or not selected.evidence.evidence_bytes):
            raise ContractRejected("candle-host-stage-evidence-unqualified")
        if self.host.descriptor != self.descriptor:
            raise ContractRejected("candle-selection-host-pin-changed")
        self._admit(request, sealed_policy)
        # Still unverified. The walk-forward owner checks stage evidence and calls
        # its independent FoldVerifier against sources before exposing training.
        return selected
