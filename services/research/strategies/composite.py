"""Implemented-components agreement envelope over reviewed HMM and jump results.

Research section 6 of the supplied macro-regime package: preserve each
component's native meaning and publish a per-timestamp stance table, NOT a
numeric average, vote count, weight, learned fusion or probability. Components
are the verified causal HMM forward filter (macro-hmm-forward-v1) and the
fixed-centroid jump model (macro-jump-state-v1), consumed as review-pinned
result contents. ORCA is a pending detector and HMM-RL a pending downstream
policy; neither is a stance and neither is ever counted. The Ruuj article is
methodological provenance only.

Stance rules (declared research parameters, uncalibrated):
- HMM: exact Decimal sums of the published posterior strings over states the
  reviewed map calls defensive / non-defensive (neutral states count toward
  neither). Threshold t is a reviewed Decimal strictly inside (0.5, 1).
  defensive if defensive mass >= t; non-defensive if non-defensive mass >= t;
  otherwise neutral. Both >= t (possible only through published 15-place
  rounding) is status indeterminate, never a guessed stance.
- JM: warmup rows have status warmup; exact-tie rows (arbitrary lowest-index
  winner) have status indeterminate; otherwise the reviewed map of state_label.
- implemented_components_summary over exactly {HMM, JM}: incomplete when any
  status is not available; aligned-defensive / aligned-non-defensive only when
  both stances agree; otherwise mixed (neutral always gives mixed). Coverage is
  partial because ORCA is pending; there is no bare composite aligned label.

Binding (reviewed attestation): each component is consumed through a reviewed
binding naming its evidence id, content sha256, market identity and calendar
(exactly the composite recipe's declared identity; NOT machine-verified from
the component results, which carry no universe), the model content sha256 the
stance map is keyed to, and a stance map total and exact over state_labels.
Causality: component asOf identical and <= composite as_of; capturedAt <=
composite as_of; identical observed_at sequences (mismatch rejects, never
intersects); each row is eligible at the maximum component available_at.
No fitting, data IO, allocation, backtest or execution.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, fields
from datetime import datetime, timezone
from decimal import Context, Decimal, DivisionByZero, InvalidOperation, Overflow, ROUND_HALF_EVEN, localcontext
from typing import Any

from strategies.hmm import NUMERICAL_ENCODING as HMM_ENCODING, FilteredState, ForwardFilterResult
from strategies.jump import (ASSIGNMENT_KIND as JUMP_ASSIGNMENT_KIND, NUMERICAL_ENCODING as JUMP_ENCODING,
                             VARIANT as JUMP_VARIANT, JumpStateResult, PublishedJumpState)

OPERATION = "macro-regime-composite-envelope-v1"
VARIANT = "implemented-components-agreement-envelope-v1"
PROFILE = "vertex-regime-composite-envelope-result-v1"
AGGREGATION = "agreement-envelope-replaces-numeric-average-v1"
IDENTITY_BASIS = "reviewed-attestation-not-machine-verified-v1"
NUMERICAL_ENCODING = "exact-decimal-sum-of-published-hmm-posterior-strings-v1"
HMM_OPERATION = "macro-hmm-forward-v1"
HMM_VARIANT = "diagonal-gaussian-log-forward-v1"
HMM_RESULT_PROFILE = "vertex-hmm-forward-result-v1"
JUMP_OPERATION = "macro-jump-state-v1"
JUMP_RESULT_PROFILE = "vertex-jump-state-result-v1"
HMM_BINDING_PROFILE = "vertex-composite-hmm-binding-v1"
JUMP_BINDING_PROFILE = "vertex-composite-jump-binding-v1"
STANCES = ("defensive", "non-defensive", "neutral")
SUMMARY_SCOPE = ("HMM", "JM")
COVERAGE = "partial"
MAX_ROWS = 512
MAX_STATES = 8
SLEEVE_RESULT_FIELDS = frozenset({
    "profile", "operation", "asOf", "recipeSha256", "parameters", "proposalOnly", "executionAuthorized",
    "acceptanceStatus", "simulatedCapitalEntersNav", "projectedResult", "projectionTimeEncoding",
    "projectionDecimalEncoding", "stateBasis", "inputs", "limitations"})
BINDING_FIELDS = frozenset({"profile", "component_evidence_id", "component_content_sha256", "market_id",
                            "calendar_id", "identity_basis", "model_content_sha256", "stance_map"})
HMM_BINDING_FIELDS = BINDING_FIELDS | {"posterior_mass_threshold"}
ARITHMETIC = Context(prec=60, rounding=ROUND_HALF_EVEN, traps=[InvalidOperation, Overflow, DivisionByZero])
LIMITATIONS = (
    "Declared, uncalibrated HMM posterior-mass threshold and reviewed stance maps; market identity and calendar "
    "are reviewed binding attestations, not machine-verified from component results.",
    "HMM and jump model share market-return inputs, so their agreement is not independent confirmation; ORCA "
    "(pending detector) and HMM-RL (pending downstream policy) are never counted.",
    "Agreement envelope replaces a numeric average: no counts, votes, weights, averaging, probability or "
    "allocation claim; no fitting, calibration or backtest.",
)
_EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)
_NS_TEXT = re.compile(r"0|[1-9][0-9]{0,19}")
_SHA = re.compile(r"[0-9a-f]{64}")
_POSTERIOR = re.compile(r"1|0|0\.[0-9]{0,14}[1-9]")
_THRESHOLD = re.compile(r"0\.[0-9]{0,17}[1-9]")


@dataclass(frozen=True)
class ComponentSource:
    """Adapter-verified component: pinned+current-reviewed record, exact content bytes."""
    evidence_id: str
    content_sha256: str
    captured_at_ns: int
    as_of_ns: int
    content: Any


@dataclass(frozen=True)
class StanceMapEntry:
    state_label: str
    stance: str


@dataclass(frozen=True)
class BoundComponent:
    component: str
    operation: str
    variant: str
    native_kind: str
    evidence_id: str
    content_sha256: str
    model_content_sha256: str
    component_as_of: str
    captured_at: str
    state_labels: tuple[str, ...]
    stance_map: tuple[StanceMapEntry, ...]
    posterior_mass_threshold: Decimal | None


@dataclass(frozen=True)
class PendingComponent:
    """Listed outside the stance set; never zero, neutral or counted."""
    component: str
    role: str
    status: str


@dataclass(frozen=True)
class ProvenanceReference:
    source: str
    role: str


@dataclass(frozen=True)
class ComponentStance:
    component: str
    status: str
    stance: str | None
    state_label: str
    mapped_defensive_posterior_mass: Decimal | None
    mapped_non_defensive_posterior_mass: Decimal | None


@dataclass(frozen=True)
class EnvelopeRow:
    observed_at: str
    eligible_at: str
    components: tuple[ComponentStance, ...]
    coverage: str
    pending: tuple[PendingComponent, ...]
    implemented_components_summary: str


@dataclass(frozen=True)
class CompositeEnvelopeResult:
    profile: str
    variant: str
    aggregation: str
    prediction_as_of: datetime
    market_id: str
    calendar_id: str
    identity_basis: str
    summary_scope: tuple[str, ...]
    components: tuple[BoundComponent, ...]
    pending: tuple[PendingComponent, ...]
    provenance_only: tuple[ProvenanceReference, ...]
    numerical_encoding: str
    rows: tuple[EnvelopeRow, ...]
    limitations: tuple[str, ...]


@dataclass(frozen=True)
class _HmmRow:
    observed_ns: int
    available_ns: int
    posterior: tuple[str, ...]
    state_label: str


@dataclass(frozen=True)
class _JumpRow:
    observed_ns: int
    available_ns: int
    warmup: bool
    tie: bool
    state_label: str


@dataclass(frozen=True)
class BoundComponents:
    as_of_ns: int
    market_id: str
    calendar_id: str
    hmm: BoundComponent
    jump: BoundComponent
    hmm_rows: tuple[_HmmRow, ...]
    jump_rows: tuple[_JumpRow, ...]


PENDING = (
    PendingComponent("ORCA", "detector", "pending-not-implemented-excluded-from-summary"),
    PendingComponent("HMM-RL", "downstream-policy-not-a-stance", "pending-not-implemented-excluded-from-summary"),
)
PROVENANCE_ONLY = (
    ProvenanceReference("ruuj-hmm-article-x-2074503360208884204",
                        "methodological-provenance-only-not-a-component-stance-or-signal"),
)


def _require(condition: bool, reason: str) -> None:
    if not condition:
        raise ValueError("composite-" + reason)


def _epoch_ns(value: datetime) -> int:
    _require(type(value) is datetime and value.tzinfo is not None and value.utcoffset() is not None, "timezone-required")
    delta = value.astimezone(timezone.utc) - _EPOCH
    return (delta.days * 86_400 + delta.seconds) * 1_000_000_000 + delta.microseconds * 1000


def _ns(value: Any, reason: str) -> int:
    _require(type(value) is str and _NS_TEXT.fullmatch(value) is not None, reason)
    return int(value)


def _sha(value: Any) -> bool:
    return type(value) is str and _SHA.fullmatch(value) is not None


def posterior_mass_threshold(value: Any) -> Decimal:
    """Reviewed Decimal text strictly inside (0.5, 1); public-domain representable."""
    _require(type(value) is str and _THRESHOLD.fullmatch(value) is not None, "posterior-mass-threshold-invalid")
    threshold = Decimal(value)
    _require(Decimal("0.5") < threshold < Decimal(1), "posterior-mass-threshold-invalid")
    return threshold


def _stance_map(value: Any, labels: tuple[str, ...]) -> dict[str, str]:
    _require(type(value) is dict and set(value) == set(labels) and len(value) == len(labels)
             and all(type(item) is str and item in STANCES for item in value.values()), "stance-map-not-total")
    return dict(value)


def hmm_stance(posterior: tuple[str, ...], labels: tuple[str, ...], stance_map: dict[str, str],
               threshold: Decimal, *, state_label: str) -> ComponentStance:
    """Exact Decimal posterior mass from published strings; the published label is carried, not recomputed."""
    _require(len(posterior) == len(labels) and set(stance_map) == set(labels) and state_label in labels,
             "hmm-row-shape-invalid")
    _require(all(type(item) is str and _POSTERIOR.fullmatch(item) is not None for item in posterior),
             "hmm-posterior-text-invalid")
    with localcontext(ARITHMETIC):
        defensive = sum((Decimal(p) for p, label in zip(posterior, labels) if stance_map[label] == "defensive"), Decimal(0))
        calm = sum((Decimal(p) for p, label in zip(posterior, labels) if stance_map[label] == "non-defensive"), Decimal(0))
    if defensive >= threshold and calm >= threshold:
        status, stance = "indeterminate", None
    elif defensive >= threshold:
        status, stance = "available", "defensive"
    elif calm >= threshold:
        status, stance = "available", "non-defensive"
    else:
        status, stance = "available", "neutral"
    return ComponentStance("HMM", status, stance, state_label, defensive, calm)


def jump_stance(*, warmup: bool, tie: bool, state_label: str, stance_map: dict[str, str]) -> ComponentStance:
    """Warmup (short window) is status warmup; exact tie is indeterminate; never a guessed stance."""
    _require(type(warmup) is bool and type(tie) is bool and state_label in stance_map, "jump-row-shape-invalid")
    if warmup:
        return ComponentStance("JM", "warmup", None, state_label, None, None)
    if tie:
        return ComponentStance("JM", "indeterminate", None, state_label, None, None)
    return ComponentStance("JM", "available", stance_map[state_label], state_label, None, None)


def implemented_components_summary(components: tuple[ComponentStance, ...]) -> str:
    """Over exactly the implemented {HMM, JM}; pending entries are never inputs."""
    _require(type(components) is tuple and all(type(item) is ComponentStance for item in components)
             and tuple(item.component for item in components) == SUMMARY_SCOPE, "summary-scope-invalid")
    if any(item.status != "available" for item in components):
        return "incomplete"
    stances = {item.stance for item in components}
    if stances == {"defensive"}:
        return "aligned-defensive"
    if stances == {"non-defensive"}:
        return "aligned-non-defensive"
    return "mixed"


def _binding(value: Any, keys: frozenset[str], profile: str, source: ComponentSource,
             market_id: str, calendar_id: str) -> dict[str, Any]:
    _require(type(source) is ComponentSource, "component-source-invalid")
    _require(type(value) is dict and set(value) == keys and value["profile"] == profile, "binding-shape-invalid")
    _require(value["identity_basis"] == IDENTITY_BASIS, "binding-identity-basis-invalid")
    _require(value["market_id"] == market_id and value["calendar_id"] == calendar_id, "market-identity-mismatch")
    _require(value["component_evidence_id"] == source.evidence_id, "component-evidence-mismatch")
    _require(_sha(value["component_content_sha256"]) and _sha(source.content_sha256)
             and value["component_content_sha256"] == source.content_sha256, "component-content-hash-mismatch")
    _require(_sha(value["model_content_sha256"]), "stance-map-model-mismatch")
    return value


def _content(source: ComponentSource, *, operation: str, variant: str, result_profile: str, encoding: str,
             result_kind: Any, model_role: str) -> tuple[dict[str, Any], str]:
    content = source.content
    _require(type(content) is dict and set(content) == SLEEVE_RESULT_FIELDS, "component-content-shape-invalid")
    _require(content["profile"] == "vertex-sleeve-result-v1" and content["operation"] == operation,
             "component-operation-or-profile-invalid")
    _require(content["parameters"] == {"variant": variant}, "component-variant-invalid")
    _require(content["proposalOnly"] is True and content["executionAuthorized"] is False
             and content["acceptanceStatus"] == "unreviewed" and content["simulatedCapitalEntersNav"] is False
             and content["stateBasis"] is None
             and content["projectionTimeEncoding"] == "epoch-nanoseconds-decimal-string"
             and content["projectionDecimalEncoding"] == encoding, "component-content-semantics-invalid")
    result = content["projectedResult"]
    _require(type(result) is dict and set(result) == {field.name for field in fields(result_kind)}
             and result["profile"] == result_profile and result["numerical_encoding"] == encoding,
             "component-result-profile-invalid")
    _require(_ns(result["prediction_as_of"], "component-as-of-invalid") == source.as_of_ns, "component-as-of-inconsistent")
    inputs = content["inputs"]
    models = [item for item in inputs if type(item) is dict and item.get("role") == model_role] if type(inputs) is list else []
    _require(len(models) == 1 and type(models[0].get("content")) is dict and _sha(models[0]["content"].get("sha256")),
             "component-model-reference-invalid")
    return result, models[0]["content"]["sha256"]


def _labels(result: dict[str, Any]) -> tuple[str, ...]:
    labels = result["state_labels"]
    _require(type(labels) is list and 2 <= len(labels) <= MAX_STATES and len(set(labels)) == len(labels)
             and all(type(item) is str and item for item in labels), "component-state-labels-invalid")
    return tuple(labels)


def _rows(value: Any, kind: Any, labels: tuple[str, ...]) -> list[dict[str, Any]]:
    _require(type(value) is list and 1 <= len(value) <= MAX_ROWS, "component-row-budget")
    keys = {field.name for field in fields(kind)}
    previous = None
    for row in value:
        _require(type(row) is dict and set(row) == keys, "component-row-shape-invalid")
        observed = _ns(row["observed_at"], "component-row-time-invalid")
        available = _ns(row["available_at"], "component-row-time-invalid")
        index = row["state_index"]
        _require(observed <= available and (previous is None or previous < observed), "component-row-order-invalid")
        _require(type(index) is int and 0 <= index < len(labels) and row["state_label"] == labels[index],
                 "component-row-label-invalid")
        previous = observed
    return value


def bind_components(*, market_id: str, calendar_id: str, hmm_binding: Any, jump_binding: Any,
                    hmm: ComponentSource, jump: ComponentSource, as_of: datetime,
                    maximum_age_ns: int) -> BoundComponents:
    """Validate reviewed bindings and causal alignment; no stance is computed here."""
    as_of_ns = _epoch_ns(as_of)
    _require(type(market_id) is str and market_id and type(calendar_id) is str and calendar_id,
             "market-identity-invalid")
    _require(type(maximum_age_ns) is int and maximum_age_ns > 0, "freshness-policy-invalid")
    hmm_raw = _binding(hmm_binding, HMM_BINDING_FIELDS, HMM_BINDING_PROFILE, hmm, market_id, calendar_id)
    jump_raw = _binding(jump_binding, BINDING_FIELDS, JUMP_BINDING_PROFILE, jump, market_id, calendar_id)
    _require(hmm.evidence_id != jump.evidence_id and hmm.content_sha256 != jump.content_sha256,
             "component-identity-duplicated")
    hmm_result, hmm_model = _content(hmm, operation=HMM_OPERATION, variant=HMM_VARIANT,
        result_profile=HMM_RESULT_PROFILE, encoding=HMM_ENCODING, result_kind=ForwardFilterResult, model_role="hmm_model")
    jump_result, jump_model = _content(jump, operation=JUMP_OPERATION, variant=JUMP_VARIANT,
        result_profile=JUMP_RESULT_PROFILE, encoding=JUMP_ENCODING, result_kind=JumpStateResult, model_role="jump_model")
    _require(jump_result["variant"] == JUMP_VARIANT and jump_result["assignment_kind"] == JUMP_ASSIGNMENT_KIND,
             "component-variant-invalid")
    _require(hmm_raw["model_content_sha256"] == hmm_model and jump_raw["model_content_sha256"] == jump_model,
             "stance-map-model-mismatch")
    hmm_labels, jump_labels = _labels(hmm_result), _labels(jump_result)
    hmm_map = _stance_map(hmm_raw["stance_map"], hmm_labels)
    jump_map = _stance_map(jump_raw["stance_map"], jump_labels)
    threshold = posterior_mass_threshold(hmm_raw["posterior_mass_threshold"])
    hmm_rows = _rows(hmm_result["filtered"], FilteredState, hmm_labels)
    jump_rows = _rows(jump_result["states"], PublishedJumpState, jump_labels)
    for row in hmm_rows:
        _require(type(row["posterior"]) is list and len(row["posterior"]) == len(hmm_labels)
                 and all(type(item) is str and _POSTERIOR.fullmatch(item) is not None for item in row["posterior"]),
                 "hmm-posterior-text-invalid")
    for row in jump_rows:
        _require(type(row["warmup"]) is bool and type(row["tie"]) is bool, "jump-row-shape-invalid")
    # Causal alignment: asOf identity, publication time, exact observed_at sequences, row availability.
    _require(hmm.as_of_ns == jump.as_of_ns, "component-as-of-mismatch")
    _require(hmm.as_of_ns <= as_of_ns, "component-as-of-after-composite-as-of")
    _require(type(hmm.captured_at_ns) is int and type(jump.captured_at_ns) is int
             and max(hmm.captured_at_ns, jump.captured_at_ns) <= as_of_ns, "component-captured-after-composite-as-of")
    observed = [int(row["observed_at"]) for row in hmm_rows]
    _require(observed == [int(row["observed_at"]) for row in jump_rows], "observed-at-mismatch")
    _require(all(int(row["available_at"]) <= as_of_ns for row in (*hmm_rows, *jump_rows)),
             "component-available-after-composite-as-of")
    _require(as_of_ns - observed[-1] <= maximum_age_ns, "component-stale")

    def component(name: str, operation: str, variant: str, kind: str, source: ComponentSource, model: str,
                  labels: tuple[str, ...], mapping: dict[str, str], cut: Decimal | None) -> BoundComponent:
        return BoundComponent(name, operation, variant, kind, source.evidence_id, source.content_sha256, model,
            str(source.as_of_ns), str(source.captured_at_ns), labels,
            tuple(StanceMapEntry(label, mapping[label]) for label in labels), cut)

    return BoundComponents(as_of_ns, market_id, calendar_id,
        component("HMM", HMM_OPERATION, HMM_VARIANT, "filtered-posterior-vector", hmm, hmm_model, hmm_labels,
                  hmm_map, threshold),
        component("JM", JUMP_OPERATION, JUMP_VARIANT, JUMP_ASSIGNMENT_KIND, jump, jump_model, jump_labels,
                  jump_map, None),
        tuple(_HmmRow(int(row["observed_at"]), int(row["available_at"]), tuple(row["posterior"]), row["state_label"])
              for row in hmm_rows),
        tuple(_JumpRow(int(row["observed_at"]), int(row["available_at"]), row["warmup"], row["tie"], row["state_label"])
              for row in jump_rows))


def compose_envelope(*, bound: BoundComponents, as_of: datetime) -> CompositeEnvelopeResult:
    """Per-timestamp stance table; published rows are a pure function of bound inputs."""
    _require(type(bound) is BoundComponents and _epoch_ns(as_of) == bound.as_of_ns, "bound-as-of-mismatch")
    hmm_map = {entry.state_label: entry.stance for entry in bound.hmm.stance_map}
    jump_map = {entry.state_label: entry.stance for entry in bound.jump.stance_map}
    threshold = bound.hmm.posterior_mass_threshold
    rows = []
    for hmm_row, jump_row in zip(bound.hmm_rows, bound.jump_rows, strict=True):
        _require(hmm_row.observed_ns == jump_row.observed_ns, "observed-at-mismatch")
        components = (hmm_stance(hmm_row.posterior, bound.hmm.state_labels, hmm_map, threshold,
                                 state_label=hmm_row.state_label),
                      jump_stance(warmup=jump_row.warmup, tie=jump_row.tie, state_label=jump_row.state_label,
                                  stance_map=jump_map))
        rows.append(EnvelopeRow(str(hmm_row.observed_ns), str(max(hmm_row.available_ns, jump_row.available_ns)),
                                components, COVERAGE, PENDING, implemented_components_summary(components)))
    return CompositeEnvelopeResult(PROFILE, VARIANT, AGGREGATION, as_of, bound.market_id, bound.calendar_id,
        IDENTITY_BASIS, SUMMARY_SCOPE, (bound.hmm, bound.jump), PENDING, PROVENANCE_ONLY, NUMERICAL_ENCODING,
        tuple(rows), LIMITATIONS)
