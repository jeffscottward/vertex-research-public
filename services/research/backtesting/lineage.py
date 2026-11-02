"""Internal lineage and experiment plans; public contracts remain authoritative.

These records do not authorize orders, allocate cash, open stores, start sandboxes,
or imply that historical evidence constitutes simulated/forward-paper economics.
"""
from __future__ import annotations

import re
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from typing import Any, Literal

from .ports import capture_json, decode_json, require_hash, require_id, utc

ASSUMPTION_KINDS = frozenset({
    "commission", "spread", "slippage", "latency", "partial-fill", "multileg-fill",
    "borrow", "margin", "dividend", "corporate-action", "expiry", "assignment", "settlement",
})
LEAKAGE_KINDS = frozenset({"look-ahead", "survivorship", "point-in-time", "overlap", "multiple-testing"})


def time_ns(value: str | datetime) -> int:
    """Exact public UTC timestamp comparison, including nanosecond fractions."""
    epoch = datetime(1970, 1, 1, tzinfo=UTC)
    if isinstance(value, datetime):
        delta = utc(value) - epoch
        return (delta.days * 86400 + delta.seconds) * 1_000_000_000 + delta.microseconds * 1000
    if not isinstance(value, str):
        raise ValueError("UTC timestamp required")
    match = re.fullmatch(r"(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z", value)
    if match is None:
        raise ValueError("UTC timestamp required")
    base = datetime.fromisoformat(match.group(1)).replace(tzinfo=UTC)
    delta = base - epoch
    return (delta.days * 86400 + delta.seconds) * 1_000_000_000 + int((match.group(2) or "").ljust(9, "0"))


def timestamp(value: datetime) -> str:
    return utc(value).isoformat().replace("+00:00", "Z")


@dataclass(frozen=True)
class Pin:
    identity: str
    version: str
    digest: str

    def __post_init__(self) -> None:
        require_id(self.identity)
        require_hash(self.digest)
        if not isinstance(self.version, str) or re.fullmatch(r"(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)", self.version) is None:
            raise ValueError("version pin required")


@dataclass(frozen=True)
class DataPin:
    dataset_id: str
    manifest_digest: str
    content_digest: str
    source_digests: tuple[str, ...]
    calendar_pin: Pin
    vintage_id: str | None
    entitlement_evidence_id: str
    data_kinds: tuple[str, ...]

    def __post_init__(self) -> None:
        require_id(self.dataset_id)
        require_hash(self.manifest_digest)
        require_hash(self.content_digest)
        object.__setattr__(self, "source_digests", tuple(self.source_digests))
        object.__setattr__(self, "data_kinds", tuple(self.data_kinds))
        if not self.data_kinds or len(self.data_kinds) != len(set(self.data_kinds)):
            raise ValueError("unique declared data kinds required")
        for kind in self.data_kinds:
            require_id(kind)
        if not self.source_digests:
            raise ValueError("data source digests required")
        for digest in self.source_digests:
            require_hash(digest)
        if self.vintage_id is not None:
            require_id(self.vintage_id)
        require_id(self.entitlement_evidence_id)


@dataclass(frozen=True)
class PointInTimeEvidence:
    """Availability proof tied to a specific dataset, source and decision, not a fetch date."""
    evidence_id: str
    dataset_id: str
    source_id: str
    source_digest: str
    observed_at: datetime
    published_at: datetime
    available_at: datetime
    revision_at: datetime
    decision_at: datetime
    vintage_id: str

    def __post_init__(self) -> None:
        for value in (self.evidence_id, self.dataset_id, self.source_id, self.vintage_id):
            require_id(value)
        require_hash(self.source_digest)
        for name in ("observed_at", "published_at", "available_at", "revision_at", "decision_at"):
            object.__setattr__(self, name, utc(getattr(self, name)))

    def causal(self) -> bool:
        return (
            self.observed_at <= self.published_at <= self.available_at <= self.decision_at
            and self.published_at <= self.revision_at <= self.available_at
        )

    def record(self) -> dict[str, Any]:
        data = asdict(self)
        for name in ("observed_at", "published_at", "available_at", "revision_at", "decision_at"):
            data[name] = timestamp(getattr(self, name))
        return data


@dataclass(frozen=True)
class ModelAssumption:
    kind: str
    disposition: Literal["modeled", "not-applicable", "missing"]
    model_pin: Pin | None
    parameters_bytes: bytes
    evidence_ids: tuple[str, ...]

    def __post_init__(self) -> None:
        if self.kind not in ASSUMPTION_KINDS or self.disposition not in {"modeled", "not-applicable", "missing"}:
            raise ValueError("unknown assumption kind or disposition")
        if not isinstance(self.parameters_bytes, bytes) or len(self.parameters_bytes) > 64_000:
            raise ValueError("bounded immutable model parameters required")
        if not isinstance(decode_json(self.parameters_bytes), dict):
            raise ValueError("model parameter object required")
        object.__setattr__(self, "evidence_ids", tuple(self.evidence_ids))
        for identity in self.evidence_ids:
            require_id(identity)
        if self.disposition == "modeled" and self.model_pin is None:
            raise ValueError("modeled assumption needs a pinned model")

    def record(self) -> dict[str, Any]:
        return {
            "kind": self.kind, "disposition": self.disposition,
            "modelPin": asdict(self.model_pin) if self.model_pin else None,
            "parameters": decode_json(self.parameters_bytes), "evidenceIds": list(self.evidence_ids),
        }


@dataclass(frozen=True)
class TimeWindow:
    start_at: datetime
    end_at: datetime

    def __post_init__(self) -> None:
        object.__setattr__(self, "start_at", utc(self.start_at))
        object.__setattr__(self, "end_at", utc(self.end_at))
        if self.start_at >= self.end_at:
            raise ValueError("nonempty half-open time window required")

    def record(self) -> dict[str, str]:
        return {"startAtInclusive": timestamp(self.start_at), "endAtExclusive": timestamp(self.end_at)}


@dataclass(frozen=True)
class WalkForwardFold:
    fold_id: str
    training: TimeWindow
    test: TimeWindow
    fitted_at: datetime
    training_labels_end_at: datetime
    purge_ms: int
    embargo_ms: int
    parameter_digest: str
    evidence_ids: tuple[str, ...]

    def __post_init__(self) -> None:
        require_id(self.fold_id)
        require_hash(self.parameter_digest)
        object.__setattr__(self, "fitted_at", utc(self.fitted_at))
        object.__setattr__(self, "training_labels_end_at", utc(self.training_labels_end_at))
        object.__setattr__(self, "evidence_ids", tuple(self.evidence_ids))
        for identity in self.evidence_ids:
            require_id(identity)
        if any(type(v) is not int or v < 0 for v in (self.purge_ms, self.embargo_ms)):
            raise ValueError("nonnegative purge and embargo required")

    def failure_codes(self) -> tuple[str, ...]:
        result: list[str] = []
        if self.training.end_at > self.test.start_at:
            result.append("training-test-overlap")
        if not self.training.end_at <= self.fitted_at <= self.test.start_at:
            result.append("fit-outside-causal-window")
        if self.training_labels_end_at > self.fitted_at:
            result.append("training-labels-unavailable-at-fit")
        latest_label = time_ns(self.training_labels_end_at) + self.purge_ms * 1_000_000
        embargo_end = time_ns(self.training.end_at) + self.embargo_ms * 1_000_000
        if max(latest_label, embargo_end) > time_ns(self.test.start_at):
            result.append("purge-or-embargo-insufficient")
        if not self.evidence_ids:
            result.append("fold-evidence-missing")
        return tuple(result)

    def record(self) -> dict[str, Any]:
        return {
            "foldId": self.fold_id, "trainingWindow": self.training.record(), "testWindow": self.test.record(),
            "fittedAt": timestamp(self.fitted_at), "trainingLabelsEndAt": timestamp(self.training_labels_end_at),
            "purgeMs": self.purge_ms, "embargoMs": self.embargo_ms,
            "parameterDigest": self.parameter_digest, "evidenceIds": list(self.evidence_ids),
        }


@dataclass(frozen=True)
class TrialRegistry:
    trial_ids: tuple[str, ...]
    selected_trial_id: str
    selection_policy_digest: str
    registered_at: datetime
    evidence_id: str

    def __post_init__(self) -> None:
        object.__setattr__(self, "trial_ids", tuple(self.trial_ids))
        if not self.trial_ids or len(self.trial_ids) != len(set(self.trial_ids)):
            raise ValueError("unique registered trials required")
        for value in (*self.trial_ids, self.selected_trial_id, self.evidence_id):
            require_id(value)
        if self.selected_trial_id not in self.trial_ids:
            raise ValueError("selected trial missing from registry")
        require_hash(self.selection_policy_digest)
        object.__setattr__(self, "registered_at", utc(self.registered_at))

    def record(self) -> dict[str, Any]:
        return {
            "trialIds": list(self.trial_ids), "selectedTrialId": self.selected_trial_id,
            "selectionPolicyDigest": self.selection_policy_digest, "registeredAt": timestamp(self.registered_at),
            "evidenceId": self.evidence_id,
        }


@dataclass(frozen=True)
class Incident:
    incident_id: str
    code: str
    severity: Literal["info", "warning", "blocking"]
    evidence_ids: tuple[str, ...]
    resolved: bool = False

    def __post_init__(self) -> None:
        require_id(self.incident_id)
        require_id(self.code)
        if self.severity not in {"info", "warning", "blocking"} or type(self.resolved) is not bool:
            raise ValueError("invalid incident state")
        object.__setattr__(self, "evidence_ids", tuple(self.evidence_ids))
        for value in self.evidence_ids:
            require_id(value)


@dataclass(frozen=True)
class ForwardCriteria:
    registered_at: datetime
    not_before: datetime
    minimum_samples: int
    minimum_duration_ms: int
    minimum_regimes: int
    maximum_open_blocking_incidents: int
    policy_digest: str
    evidence_ids: tuple[str, ...]

    def __post_init__(self) -> None:
        object.__setattr__(self, "registered_at", utc(self.registered_at))
        object.__setattr__(self, "not_before", utc(self.not_before))
        require_hash(self.policy_digest)
        object.__setattr__(self, "evidence_ids", tuple(self.evidence_ids))
        for identity in self.evidence_ids:
            require_id(identity)
        if self.registered_at > self.not_before:
            raise ValueError("forward policy must precede sampling")
        if any(type(v) is not int or v < 1 for v in (
            self.minimum_samples, self.minimum_duration_ms, self.minimum_regimes,
        )) or self.maximum_open_blocking_incidents != 0:
            raise ValueError("positive forward sampling gates and zero unresolved blockers required")

    def record(self) -> dict[str, Any]:
        result = asdict(self)
        result["registered_at"] = timestamp(self.registered_at)
        result["not_before"] = timestamp(self.not_before)
        return result


@dataclass(frozen=True)
class ForwardSample:
    sample_id: str
    strategy_digest: str
    lineage_digest: str
    observed_at: datetime
    available_at: datetime
    regime: str
    evidence_id: str
    origin: Literal["paper-observation", "simulation", "supplied-outcome"]

    def __post_init__(self) -> None:
        for value in (self.sample_id, self.regime, self.evidence_id):
            require_id(value)
        require_hash(self.strategy_digest)
        require_hash(self.lineage_digest)
        object.__setattr__(self, "observed_at", utc(self.observed_at))
        object.__setattr__(self, "available_at", utc(self.available_at))
        if self.origin not in {"paper-observation", "simulation", "supplied-outcome"}:
            raise ValueError("forward sample origin required")

    def record(self) -> dict[str, Any]:
        result = asdict(self)
        result["observed_at"] = timestamp(self.observed_at)
        result["available_at"] = timestamp(self.available_at)
        return result


@dataclass(frozen=True)
class ForwardAssessment:
    qualified: bool
    sample_count: int
    reasons: tuple[str, ...]
    samples: tuple[ForwardSample, ...]
    incidents: tuple[Incident, ...]

    def record(self) -> dict[str, Any]:
        """Retain every submitted sample and incident, including rejected ones."""
        return {
            "qualified": self.qualified, "sampleCount": self.sample_count,
            "reasons": list(self.reasons),
            "samples": [sample.record() for sample in self.samples],
            "incidents": [
                {**asdict(incident), "evidence_ids": list(incident.evidence_ids)}
                for incident in self.incidents
            ],
        }


def assess_forward(
    *, criteria: ForwardCriteria, samples: tuple[ForwardSample, ...],
    incidents: tuple[Incident, ...], strategy_digest: str, lineage_digest: str,
    as_of: datetime, evidence_ids: frozenset[str],
) -> ForwardAssessment:
    """Keep rejected samples; only externally evidenced paper observations count."""
    as_of = utc(as_of)
    reasons: list[str] = []
    if len({sample.sample_id for sample in samples}) != len(samples):
        reasons.append("duplicate-forward-sample")
    eligible: list[ForwardSample] = []
    for sample in samples:
        if (
            sample.origin != "paper-observation" or sample.strategy_digest != strategy_digest
            or sample.lineage_digest != lineage_digest or sample.evidence_id not in evidence_ids
            or not criteria.not_before <= sample.observed_at <= sample.available_at <= as_of
        ):
            reasons.append("ineligible-forward-sample")
        else:
            eligible.append(sample)
    if not criteria.evidence_ids or not set(criteria.evidence_ids).issubset(evidence_ids):
        reasons.append("forward-policy-evidence-missing")
    if len(eligible) < criteria.minimum_samples:
        reasons.append("forward-sample-count-insufficient")
    if len({sample.regime for sample in eligible}) < criteria.minimum_regimes:
        reasons.append("forward-regime-coverage-insufficient")
    duration = 0 if len(eligible) < 2 else time_ns(max(s.observed_at for s in eligible)) - time_ns(min(s.observed_at for s in eligible))
    if duration < criteria.minimum_duration_ms * 1_000_000:
        reasons.append("forward-duration-insufficient")
    if any(item.severity == "blocking" and not item.resolved for item in incidents):
        reasons.append("open-blocking-incident")
    return ForwardAssessment(not reasons, len(eligible), tuple(dict.fromkeys(reasons)), tuple(samples), tuple(incidents))


@dataclass(frozen=True)
class AcceptanceCriterion:
    """Preregistered exact-decimal OOS metric and explicit rejection condition."""
    metric_id: str
    operator: str
    threshold: str
    registered_at: datetime
    evidence_ids: tuple[str, ...]

    def __post_init__(self) -> None:
        require_id(self.metric_id)
        if self.operator not in {"lt", "lte", "eq", "gte", "gt"}:
            raise ValueError("unknown acceptance comparator")
        self._decimal(self.threshold)
        object.__setattr__(self, "registered_at", utc(self.registered_at))
        object.__setattr__(self, "evidence_ids", tuple(self.evidence_ids))
        for identity in self.evidence_ids:
            require_id(identity)

    @staticmethod
    def _decimal(value: Any) -> Any:
        from decimal import Decimal
        if not isinstance(value, str) or re.fullmatch(
            r"(?:0|-?(?:[1-9]\d{0,29}(?:\.\d{0,17}[1-9])?|0\.\d{0,17}[1-9]))", value,
        ) is None:
            raise ValueError("canonical exact-decimal metric required")
        return Decimal(value)

    def accepts(self, value: Any) -> bool:
        left, right = self._decimal(value), self._decimal(self.threshold)
        return {
            "lt": left < right, "lte": left <= right, "eq": left == right,
            "gte": left >= right, "gt": left > right,
        }[self.operator]

    def record(self) -> dict[str, Any]:
        return {
            "metricId": self.metric_id, "operator": self.operator, "threshold": self.threshold,
            "registeredAt": timestamp(self.registered_at), "evidenceIds": list(self.evidence_ids),
        }


@dataclass(frozen=True)
class LineageInputs:
    strategy_version_id: str
    strategy_frozen_at: datetime
    code_pin: Pin
    engine_pin: Pin | None
    data_pins: tuple[DataPin, ...]
    point_in_time: tuple[PointInTimeEvidence, ...]
    assumptions: tuple[ModelAssumption, ...]
    folds: tuple[WalkForwardFold, ...]
    trials: TrialRegistry | None
    forward_criteria: ForwardCriteria | None
    incidents: tuple[Incident, ...]
    citations: tuple[str, ...]
    acceptance_criteria: tuple[AcceptanceCriterion, ...] = ()
    environment_digest: str | None = None

    def __post_init__(self) -> None:
        require_id(self.strategy_version_id)
        if self.environment_digest is not None:
            require_hash(self.environment_digest)
        object.__setattr__(self, "strategy_frozen_at", utc(self.strategy_frozen_at))
        for name in ("data_pins", "point_in_time", "assumptions", "folds", "incidents", "citations", "acceptance_criteria"):
            object.__setattr__(self, name, tuple(getattr(self, name)))
        for identity in self.citations:
            require_id(identity)

    def record(self) -> dict[str, Any]:
        return {
            "strategyVersionId": self.strategy_version_id, "strategyFrozenAt": timestamp(self.strategy_frozen_at),
            "codePin": asdict(self.code_pin), "enginePin": asdict(self.engine_pin) if self.engine_pin else None,
            "environmentDigest": self.environment_digest,
            "dataPins": [asdict(item) for item in self.data_pins],
            "pointInTime": [item.record() for item in self.point_in_time],
            "assumptions": [item.record() for item in self.assumptions],
            "folds": [item.record() for item in self.folds],
            "trials": self.trials.record() if self.trials else None,
            "forwardCriteria": self.forward_criteria.record() if self.forward_criteria else None,
            "acceptanceCriteria": [item.record() for item in self.acceptance_criteria],
            "incidents": [asdict(item) for item in self.incidents], "citations": list(self.citations),
        }
