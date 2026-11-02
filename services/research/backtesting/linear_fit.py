"""Opt-in exact Candle linear fitting; candidates are not qualified FoldFitResults.

Only the existing CandleFeatures.v1/CandleSimpleReturn.v1 representations are
accepted. Callers must independently admit the current source/model policies and
verify selection BEFORE exposing training to an isolated fitter. A request's
verificationDigest is a binding, not proof that such verification happened.
This module cannot issue authority, sandbox receipts or stage evidence, and does
not implement FoldFitter. Source/artifact pins below are declared commitments,
not an assertion that the running implementation has been independently checked.

The future host must enforce CPU/wall/memory/trial limits, input-only isolation,
current independent admission and real stage evidence. Arithmetic/byte limits and
cooperative cancellation here are additional bounds, never host qualification.
No data access, fitted-state cache, decimal rounding, model selection, predictions,
trading mapping, capital, aggregate metric or external fitting library exists.
"""
from __future__ import annotations

import re
from dataclasses import asdict, dataclass, field
from fractions import Fraction
from typing import Any, Callable

from .candle_labels import CandleDatasetPolicy, CandleLabelPolicy, decimal_fraction, interval_ns
from .fold_contracts import FoldFitRequest, FoldPortPin, FoldRecord
from .lineage import Pin, time_ns
from .ports import Artifact, PortUnavailable, PublicBoundary, require_hash, require_id


LINEAR_POLICY_CONTRACT = "internal.CandleLinearModelPolicy.v1"
LINEAR_PARAMETER_CONTRACT = "internal.CandleLinearParameters.v1"
LINEAR_PROVENANCE_CONTRACT = "internal.CandleLinearFitProvenance.v1"
_FEATURE_CONTRACT = "internal.CandleFeatures.v1"
_LABEL_CONTRACT = "internal.CandleSimpleReturn.v1"
_FIELDS = frozenset({"open", "high", "low", "close", "volume"})


def _unavailable(reason: str) -> None:
    raise PortUnavailable("candle-linear-" + reason)


def _count(value: int, ceiling: int) -> None:
    if type(value) is not int or not 1 <= value <= ceiling:
        _unavailable("bounded-explicit-dimension-required")


def _object(value: Any, keys: set[str]) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != keys:
        _unavailable("exact-contract-shape-required")
    return value


def _same(boundary: PublicBoundary, left: Any, right: Any) -> bool:
    # Do not equate bool/int/float or infer object-field order as vector order.
    return boundary.internal("internal.CandleLinearComparison.v1", left) == boundary.internal(
        "internal.CandleLinearComparison.v1", right,
    )


def _canonical(artifact: Artifact, name: str, boundary: PublicBoundary) -> Any:
    if (not isinstance(artifact, Artifact) or artifact.contract_name != name
            or not 0 < len(artifact.payload_bytes) <= boundary.maximum_bytes):
        _unavailable("canonical-artifact-required")
    value = artifact.decode()
    if boundary.internal(name, value) != artifact:
        _unavailable("original-canonical-bytes-required")
    return value


@dataclass(frozen=True)
class ExactRational:
    """Reduced signed integer/positive integer strings, with no decimal alias."""
    numerator: str
    denominator: str

    def __post_init__(self) -> None:
        for value, pattern in ((self.numerator, r"(?:0|-?[1-9][0-9]*)"),
                               (self.denominator, r"[1-9][0-9]*")):
            if not isinstance(value, str) or len(value) > 1234 or re.fullmatch(pattern, value) is None:
                _unavailable("reduced-rational-required")
        value = Fraction(int(self.numerator), int(self.denominator))
        if (max(abs(value.numerator).bit_length(), value.denominator.bit_length()) > 4096
                or str(value.numerator) != self.numerator or str(value.denominator) != self.denominator):
            _unavailable("bounded-reduced-rational-required")

    def record(self) -> dict[str, str]:
        return {"numerator": self.numerator, "denominator": self.denominator}


@dataclass(frozen=True)
class LinearFeature:
    """Zero-based index in oldest-to-newest CandleFeatures.rows, then field."""
    window_index: int
    field: str

    def __post_init__(self) -> None:
        if (type(self.window_index) is not int or not 0 <= self.window_index < 4096
                or not isinstance(self.field, str) or self.field not in _FIELDS):
            _unavailable("feature-identity-unsupported")

    def record(self) -> dict[str, Any]:
        return {"windowIndex": self.window_index, "field": self.field}


@dataclass(frozen=True)
class LinearFitLimits:
    """Explicit algorithm ceilings; not measurements or sandbox promises.

    Input counts request/training/policy bytes. Output counts all five returned
    Artifact payloads, including the unchanged request binding. Integer bounds
    cover reduced values and conservative unreduced arithmetic intermediates;
    operation counts cover rational parsing, feature conversion and arithmetic.
    CPU/wall/memory and the authoritative codec require separate host limits.
    """
    maximum_rows: int
    maximum_features: int
    maximum_input_bytes: int
    maximum_output_bytes: int
    maximum_integer_bits: int
    maximum_arithmetic_operations: int

    def __post_init__(self) -> None:
        for value, ceiling in (
            (self.maximum_rows, 100_000), (self.maximum_features, 64),
            (self.maximum_input_bytes, 64_000_000), (self.maximum_output_bytes, 64_000_000),
            (self.maximum_integer_bits, 4096), (self.maximum_arithmetic_operations, 10_000_000),
        ):
            _count(value, ceiling)


@dataclass(frozen=True)
class CandleLinearModelPolicy:
    """Every supported choice is explicit; the supplied policy pin seals config.

    OLS requires ridge=0; ridge least squares requires ridge>0. The objective is
    sum_i (y_i - prediction_i)^2 + ridge * sum_j beta_j^2, not a sample mean.
    The optional constant-one coefficient is last, and is penalized only when
    explicitly selected. No centering/scaling/weighting/feature selection occurs.
    Ill-conditioning means the exact infinity condition number of the penalized
    normal matrix exceeds maximum_condition_number; no floating tolerance exists.
    """
    policy_id: str
    version: str
    algorithm: str
    solver: str
    objective: str
    pooling: str
    output_semantics: str
    fitter_pin: FoldPortPin
    implementation_source_pin: Pin
    implementation_artifact_pin: Pin
    candle_policy_pin: Pin
    parameter_mapping_pin: Pin
    parameter_contract: str
    feature_order: tuple[LinearFeature, ...]
    feature_count: int
    parameter_count: int
    training_row_count: int
    intercept: str
    penalize_intercept: bool
    ridge: ExactRational
    condition_measure: str
    maximum_condition_number: ExactRational
    limits: LinearFitLimits
    registered_at: str
    review_evidence_ids: tuple[str, ...]

    def __post_init__(self) -> None:
        require_id(self.policy_id)
        if (self.version != "1.0.0" or self.algorithm not in {"ordinary-least-squares-v1", "ridge-least-squares-v1"}
                or self.solver != "exact-rational-normal-equations-gauss-jordan-v1"
                or self.objective != "sum-squared-error-plus-l2-v1" or self.pooling != "single-dataset-v1"
                or self.output_semantics != "exact-dimensionless-simple-return-linear-score-v1"
                or self.parameter_contract != LINEAR_PARAMETER_CONTRACT
                or self.condition_measure != "penalized-normal-matrix-infinity-norm-v1"
                or self.intercept not in {"none", "constant-one"} or type(self.penalize_intercept) is not bool
                or (self.intercept == "none" and self.penalize_intercept)):
            _unavailable("model-policy-unsupported")
        if (not isinstance(self.fitter_pin, FoldPortPin) or not isinstance(self.fitter_pin.pin, Pin)
                or any(not isinstance(pin, Pin) for pin in (
                    self.implementation_source_pin, self.implementation_artifact_pin,
                    self.candle_policy_pin, self.parameter_mapping_pin,
                ))):
            _unavailable("explicit-model-pins-required")
        if not isinstance(self.limits, LinearFitLimits) or any(not isinstance(value, ExactRational) for value in (
            self.ridge, self.maximum_condition_number,
        )):
            _unavailable("explicit-rational-policy-and-limits-required")
        _count(self.feature_count, self.limits.maximum_features)
        _count(self.parameter_count, self.limits.maximum_features + 1)
        _count(self.training_row_count, self.limits.maximum_rows)
        object.__setattr__(self, "feature_order", tuple(self.feature_order))
        if (len(self.feature_order) != self.feature_count
                or any(not isinstance(item, LinearFeature) for item in self.feature_order)
                or len(set(self.feature_order)) != self.feature_count
                or self.parameter_count != self.feature_count + int(self.intercept == "constant-one")):
            _unavailable("explicit-feature-dimensions-required")
        ridge = int(self.ridge.numerator)
        if (ridge < 0 or (self.algorithm == "ordinary-least-squares-v1" and ridge != 0)
                or (self.algorithm == "ridge-least-squares-v1" and ridge <= 0)
                or int(self.maximum_condition_number.numerator) < int(self.maximum_condition_number.denominator)):
            _unavailable("regularization-or-condition-policy-rejected")
        if not isinstance(self.registered_at, str):
            _unavailable("exact-policy-registration-required")
        time_ns(self.registered_at)
        object.__setattr__(self, "review_evidence_ids", tuple(self.review_evidence_ids))
        if (not 1 <= len(self.review_evidence_ids) <= 64
                or len(set(self.review_evidence_ids)) != len(self.review_evidence_ids)):
            _unavailable("existing-review-references-required")
        for identity in self.review_evidence_ids:
            require_id(identity)

    def record(self) -> dict[str, Any]:
        return {
            "policyId": self.policy_id, "version": self.version, "algorithm": self.algorithm,
            "solver": self.solver, "objective": self.objective, "pooling": self.pooling,
            "outputSemantics": self.output_semantics, "fitterPin": asdict(self.fitter_pin),
            "implementationSourcePin": asdict(self.implementation_source_pin),
            "implementationArtifactPin": asdict(self.implementation_artifact_pin),
            "candlePolicyPin": asdict(self.candle_policy_pin), "parameterMappingPin": asdict(self.parameter_mapping_pin),
            "parameterContract": self.parameter_contract, "featureOrder": [item.record() for item in self.feature_order],
            "featureCount": self.feature_count, "parameterCount": self.parameter_count,
            "trainingRowCount": self.training_row_count, "intercept": self.intercept,
            "penalizeIntercept": self.penalize_intercept, "ridge": self.ridge.record(),
            "conditionMeasure": self.condition_measure, "maximumConditionNumber": self.maximum_condition_number.record(),
            "limits": asdict(self.limits), "registeredAt": self.registered_at,
            "reviewEvidenceIds": list(self.review_evidence_ids), "executionAuthorized": False,
        }

    def seal(self, boundary: PublicBoundary, expected_pin: Pin) -> Artifact:
        artifact = boundary.internal(LINEAR_POLICY_CONTRACT, self.record())
        if (not isinstance(expected_pin, Pin) or expected_pin.identity != self.policy_id
                or expected_pin.version != self.version or expected_pin.digest != artifact.digest):
            _unavailable("model-policy-pin-mismatch")
        return artifact


@dataclass(frozen=True)
class LinearFitCandidate:
    """Canonical candidate only. The original request/policies remain byte-exact.

    No status='completed', verified=True, review receipt or FoldStageEvidence is
    manufactured. PortUnavailable is the explicit outcome for algebra/resource
    failure. An adapter may not turn this value into a FoldFitResult without the
    separately qualified authority and real host evidence described above.
    """
    request_binding: Artifact
    model_policy: Artifact
    candle_policy: Artifact
    parameters: Artifact
    provenance: Artifact
    execution_authorized: bool = field(default=False, init=False)


class _Arithmetic:
    def __init__(self, limits: LinearFitLimits, cancelled: Callable[[], bool] | None) -> None:
        self.limits, self.cancelled, self.operations = limits, cancelled, 0

    def check_cancelled(self) -> None:
        if self.cancelled is not None:
            result = self.cancelled()
            if type(result) is not bool:
                _unavailable("cancellation-decision-invalid")
            if result:
                _unavailable("cancelled")

    def _step(self) -> None:
        self.check_cancelled()
        self.operations += 1
        if self.operations > self.limits.maximum_arithmetic_operations:
            _unavailable("arithmetic-operation-budget-exceeded")

    def checked(self, value: Fraction) -> Fraction:
        if max(abs(value.numerator).bit_length(), value.denominator.bit_length()) > self.limits.maximum_integer_bits:
            _unavailable("integer-bit-budget-exceeded")
        return value

    def parse(self, value: ExactRational) -> Fraction:
        self._step()
        numerator, denominator = int(value.numerator), int(value.denominator)
        if max(abs(numerator).bit_length(), denominator.bit_length()) > self.limits.maximum_integer_bits:
            _unavailable("integer-bit-budget-exceeded")
        return self.checked(Fraction(numerator, denominator))

    def _multiply_integer(self, left: int, right: int) -> int:
        # Conservative preflight bounds unreduced products too. Cancellation or
        # an over-limit intermediate never produces a reduced fallback result.
        if left and right and abs(left).bit_length() + abs(right).bit_length() > self.limits.maximum_integer_bits:
            _unavailable("integer-bit-budget-exceeded")
        return left * right

    def add(self, left: Fraction, right: Fraction) -> Fraction:
        self._step()
        a = self._multiply_integer(left.numerator, right.denominator)
        b = self._multiply_integer(right.numerator, left.denominator)
        if a and b and (a > 0) == (b > 0) and max(abs(a).bit_length(), abs(b).bit_length()) + 1 > self.limits.maximum_integer_bits:
            _unavailable("integer-bit-budget-exceeded")
        return self.checked(Fraction(a + b, self._multiply_integer(left.denominator, right.denominator)))

    def multiply(self, left: Fraction, right: Fraction) -> Fraction:
        self._step()
        return self.checked(Fraction(self._multiply_integer(left.numerator, right.numerator),
                                     self._multiply_integer(left.denominator, right.denominator)))

    def divide(self, left: Fraction, right: Fraction) -> Fraction:
        self._step()
        if not right.numerator:
            _unavailable("singular-normal-matrix")
        return self.checked(Fraction(self._multiply_integer(left.numerator, right.denominator),
                                     self._multiply_integer(left.denominator, right.numerator)))

    def greater(self, left: Fraction, right: Fraction) -> bool:
        self._step()
        return self._multiply_integer(left.numerator, right.denominator) > self._multiply_integer(
            right.numerator, left.denominator,
        )


def _rational(value: Fraction) -> dict[str, str]:
    return {"numerator": str(value.numerator), "denominator": str(value.denominator)}


def _record(record: FoldRecord) -> dict[str, Any]:
    # Exact internal.FoldFitRequest.v1 training entry, not a new alias schema.
    return {
        "recordId": record.record_id, "datasetId": record.dataset_id,
        "sourceContentDigest": record.source_content_digest,
        "observedAt": record.observed_at, "availableAt": record.available_at,
        "features": {"contractName": record.features.contract_name, "digest": record.features.digest},
        "label": {"contractName": record.label.contract_name, "digest": record.label.digest} if record.label else None,
        "labelEndAt": record.label_end_at, "labelAvailableAt": record.label_available_at,
    }


def _binding(
    request: FoldFitRequest, policy: CandleLinearModelPolicy, labels: CandleLabelPolicy, boundary: PublicBoundary,
) -> tuple[dict[str, Any], dict[str, Any]]:
    value = _object(_canonical(request.binding, "internal.FoldFitRequest.v1", boundary), {
        "foldBinding", "selectionDigest", "verificationDigest", "training", "executionAuthorized",
    })
    for key in ("selectionDigest", "verificationDigest"):
        require_hash(value[key])
    fold_binding = _object(value["foldBinding"], {
        "parentLineageDigest", "strategyDigest", "codePin", "enginePin", "dataPins", "assumptionDigest",
        "trialRegistry", "policyDigest", "policyAdmissionDigest", "selectorPin", "verifierPin", "fitterPin",
        "parameterMappingPin", "parameterContract", "initialStateDigest", "capitalPolicy", "positionPolicy",
        "foldIndex", "fold", "budget", "executionAuthorized",
    })
    if (request.execution_authorized is not False or value["executionAuthorized"] is not False
            or fold_binding["executionAuthorized"] is not False
            or fold_binding["parameterContract"] != policy.parameter_contract
            or not _same(boundary, fold_binding["fitterPin"], asdict(policy.fitter_pin))
            or not _same(boundary, fold_binding["parameterMappingPin"], asdict(policy.parameter_mapping_pin))
            or not _same(boundary, fold_binding["budget"], asdict(request.budget))
            or not _same(boundary, fold_binding["dataPins"], [asdict(item.data_pin) for item in labels.datasets])
            or not _same(boundary, value["training"], [_record(item) for item in request.training])):
        _unavailable("fit-binding-policy-or-training-mismatch")
    fold = _object(fold_binding["fold"], {
        "foldId", "trainingWindow", "testWindow", "fittedAt", "trainingLabelsEndAt", "purgeMs", "embargoMs",
        "parameterDigest", "evidenceIds",
    })
    require_hash(fold["parameterDigest"])
    for key in ("trainingWindow", "testWindow"):
        window = _object(fold[key], {"startAtInclusive", "endAtExclusive"})
        if time_ns(window["startAtInclusive"]) >= time_ns(window["endAtExclusive"]):
            _unavailable("empty-fold-window")
    if any(type(fold[key]) is not int or fold[key] < 0 for key in ("purgeMs", "embargoMs")):
        _unavailable("fold-gap-policy-invalid")
    train_end = time_ns(fold["trainingWindow"]["endAtExclusive"])
    test_start, fitted = time_ns(fold["testWindow"]["startAtInclusive"]), time_ns(fold["fittedAt"])
    if (not train_end <= fitted <= test_start or time_ns(fold["trainingLabelsEndAt"]) > fitted
            or time_ns(fold["trainingLabelsEndAt"]) + fold["purgeMs"] * 1_000_000 > test_start
            or train_end + fold["embargoMs"] * 1_000_000 > test_start
            or max(time_ns(policy.registered_at), time_ns(labels.registered_at)) > fitted):
        _unavailable("fold-causal-or-preregistration-policy-rejected")
    return value, fold


def _reference(value: Any, dataset: CandleDatasetPolicy) -> dict[str, Any]:
    ref = _object(value, {
        "datasetId", "manifestDigest", "contentDigest", "rowIndex", "rowDigest", "candleId", "source",
        "unitsAndAvailabilityDigest", "startAtInclusive", "endAtExclusive", "receivedAt",
    })
    if (ref["datasetId"] != dataset.data_pin.dataset_id or ref["manifestDigest"] != dataset.data_pin.manifest_digest
            or ref["contentDigest"] != dataset.data_pin.content_digest
            or type(ref["rowIndex"]) is not int or not 0 <= ref["rowIndex"] < 100_000
            or ref["source"] not in [item.record(dataset.provider) for item in dataset.sources]):
        _unavailable("training-source-reference-mismatch")
    require_id(ref["candleId"])
    require_hash(ref["rowDigest"])
    require_hash(ref["unitsAndAvailabilityDigest"])
    start, end, received = (time_ns(ref[key]) for key in ("startAtInclusive", "endAtExclusive", "receivedAt"))
    if (end - start != interval_ns(dataset.interval) or received < end
            or not time_ns(dataset.source_start_at) <= start < end <= time_ns(dataset.source_end_at)
            or not time_ns(dataset.availability_start_at) <= received < time_ns(dataset.availability_end_at)):
        _unavailable("training-source-reference-time-rejected")
    return ref


def _training_row(
    record: FoldRecord, labels: CandleLabelPolicy, policy: CandleLinearModelPolicy,
    fold: dict[str, Any], boundary: PublicBoundary, arithmetic: _Arithmetic,
) -> tuple[list[Fraction], Fraction]:
    dataset = labels.datasets[0]
    if (record.dataset_id != dataset.data_pin.dataset_id or record.source_content_digest != dataset.data_pin.content_digest
            or record.label is None):
        _unavailable("labelled-single-dataset-training-required")
    features = _object(_canonical(record.features, _FEATURE_CONTRACT, boundary), {
        "policyPin", "datasetPin", "instrumentId", "currency", "interval", "quantityUnit", "fields", "windowBars",
        "transform", "rows", "executionAuthorized",
    })
    target = _object(_canonical(record.label, _LABEL_CONTRACT, boundary), {
        "policyPin", "datasetPin", "target", "horizonBars", "representation", "unit", "value", "start", "endpoint",
        "labelEndAt", "labelAvailableAt", "executionAuthorized",
    })
    for value in (features, target):
        if (value["executionAuthorized"] is not False
                or not _same(boundary, value["policyPin"], asdict(policy.candle_policy_pin))
                or not _same(boundary, value["datasetPin"], asdict(dataset.data_pin))):
            _unavailable("training-policy-pin-mismatch")
    if (features["instrumentId"] != dataset.instrument_id or features["currency"] != dataset.currency
            or features["interval"] != dataset.interval or features["quantityUnit"] != dataset.quantity_unit
            or features["fields"] != list(labels.feature_fields) or type(features["windowBars"]) is not int
            or features["windowBars"] != labels.feature_window_bars or features["transform"] != labels.feature_transform
            or not isinstance(features["rows"], list) or len(features["rows"]) != labels.feature_window_bars
            or target["target"] != labels.target or type(target["horizonBars"]) is not int
            or target["horizonBars"] != labels.horizon_bars or target["representation"] != labels.target_representation
            or target["unit"] != "dimensionless"):
        _unavailable("training-feature-or-target-semantics-mismatch")
    start, end = (time_ns(fold["trainingWindow"][key]) for key in ("startAtInclusive", "endAtExclusive"))
    refs: list[dict[str, Any]] = []
    vector: list[Fraction] = []
    for row in features["rows"]:
        arithmetic.check_cancelled()
        row = _object(row, {"source", "values"})
        ref = _reference(row["source"], dataset)
        if not start <= time_ns(ref["startAtInclusive"]) < time_ns(ref["endAtExclusive"]) < end:
            _unavailable("feature-outside-training-window")
        # rowIndex is the original envelope ordinal, NOT chronological position;
        # the Candle decoder sorts rows without rewriting their source address.
        if any(ref["rowIndex"] == previous["rowIndex"] or ref["candleId"] == previous["candleId"] for previous in refs):
            _unavailable("duplicate-feature-source-row")
        if refs and time_ns(ref["startAtInclusive"]) != time_ns(refs[-1]["endAtExclusive"]):
            _unavailable("feature-window-not-contiguous")
        refs.append(ref)
        values = _object(row["values"], set(labels.feature_fields))
        for name in labels.feature_fields:
            arithmetic._step()
            vector.append(arithmetic.checked(decimal_fraction(values[name])))
    first = _reference(target["start"], dataset)
    endpoint = _reference(target["endpoint"], dataset)
    available = max((item["receivedAt"] for item in refs), key=time_ns)
    label_available = max(first["receivedAt"], endpoint["receivedAt"], key=time_ns)
    label_end, fitted = time_ns(endpoint["endAtExclusive"]), time_ns(fold["fittedAt"])
    test_start = time_ns(fold["testWindow"]["startAtInclusive"])
    if (not _same(boundary, first, refs[-1]) or record.record_id != first["candleId"]
            or record.observed_at != first["endAtExclusive"] or record.available_at != available
            or any(endpoint["rowIndex"] == ref["rowIndex"] or endpoint["candleId"] == ref["candleId"] for ref in refs)
            or label_end != time_ns(first["endAtExclusive"]) + labels.horizon_bars * interval_ns(dataset.interval)
            or target["labelEndAt"] != endpoint["endAtExclusive"] or record.label_end_at != target["labelEndAt"]
            or target["labelAvailableAt"] != label_available or record.label_available_at != label_available
            or time_ns(available) > fitted or time_ns(available) >= label_end or time_ns(label_available) > fitted
            or label_end >= end or label_end > time_ns(fold["trainingLabelsEndAt"]) or label_end >= test_start
            or label_end + fold["purgeMs"] * 1_000_000 > test_start):
        _unavailable("training-causality-or-label-binding-rejected")
    value = _object(target["value"], {"numerator", "denominator"})
    label = arithmetic.parse(ExactRational(value["numerator"], value["denominator"]))
    if label.numerator < -label.denominator:
        _unavailable("nonnegative-close-simple-return-required")
    if policy.intercept == "constant-one":
        vector.append(arithmetic.checked(Fraction(1)))
    return vector, label


def _norm(matrix: list[list[Fraction]], arithmetic: _Arithmetic) -> Fraction:
    largest = Fraction(0)
    for row in matrix:
        total = Fraction(0)
        for value in row:
            total = arithmetic.add(total, abs(value))
        if arithmetic.greater(total, largest):
            largest = total
    return largest


def _solve(
    matrix: list[list[Fraction]], rhs: list[Fraction], arithmetic: _Arithmetic,
    maximum_condition: Fraction,
) -> tuple[list[Fraction], Fraction]:
    """Deterministic first-nonzero pivot; inverse is only a condition witness.

    Gauss-Jordan acts on [normal matrix | RHS | identity]. No normal-matrix
    mutation, pivot tolerance, pseudoinverse, library fallback or zero solution.
    """
    dimension = len(rhs)
    norm = _norm(matrix, arithmetic)
    rows = [list(row) + [rhs[i]] + [Fraction(int(i == j)) for j in range(dimension)]
            for i, row in enumerate(matrix)]
    for column in range(dimension):
        arithmetic.check_cancelled()
        pivot_index = next((i for i in range(column, dimension) if rows[i][column]), None)
        if pivot_index is None:
            _unavailable("singular-normal-matrix")
        rows[column], rows[pivot_index] = rows[pivot_index], rows[column]
        pivot = rows[column][column]
        rows[column] = [arithmetic.divide(value, pivot) for value in rows[column]]
        for index in range(dimension):
            if index == column or not rows[index][column]:
                continue
            factor = rows[index][column]
            rows[index] = [arithmetic.add(value, -arithmetic.multiply(factor, pivot_value))
                           for value, pivot_value in zip(rows[index], rows[column], strict=True)]
    inverse = [row[dimension + 1:] for row in rows]
    condition = arithmetic.multiply(norm, _norm(inverse, arithmetic))
    if arithmetic.greater(condition, maximum_condition):
        _unavailable("ill-conditioned-normal-matrix")
    solution = [row[dimension] for row in rows]
    # Exact residual check is algebraic consistency, never predicted performance.
    for row, target in zip(matrix, rhs, strict=True):
        total = Fraction(0)
        for value, coefficient in zip(row, solution, strict=True):
            total = arithmetic.add(total, arithmetic.multiply(value, coefficient))
        if total != target:
            _unavailable("exact-normal-equation-residual-rejected")
    return solution, condition


def _fit_candle_linear_candidate(
    request: FoldFitRequest, *, policy: CandleLinearModelPolicy, policy_pin: Pin,
    candle_policy: CandleLabelPolicy, boundary: PublicBoundary, cancelled: Callable[[], bool] | None,
) -> LinearFitCandidate:
    """One fit of verified-only training supplied by the caller; no port adapter.

    Explicit cancellation is cooperative (None means no callback); FoldFitRequest
    has no cancellation/authority field and this function invents neither. Only
    original immutable training artifacts are decoded. Canonical parameter bytes
    omit requestDigest/fold.parameterDigest to avoid a hash cycle with the expected
    parameter pin. The separate provenance binds both after fitting. Existing
    orchestration MUST still enforce the preregistered expected parameter digest.
    """
    if not isinstance(request, FoldFitRequest) or not isinstance(policy, CandleLinearModelPolicy):
        _unavailable("typed-fit-request-and-policy-required")
    if not isinstance(candle_policy, CandleLabelPolicy) or len(candle_policy.datasets) != 1:
        _unavailable("single-dataset-candle-policy-required")
    if cancelled is not None and not callable(cancelled):
        _unavailable("cancellation-callback-invalid")
    arithmetic = _Arithmetic(policy.limits, cancelled)
    arithmetic.check_cancelled()
    if candle_policy.feature_window_bars * len(candle_policy.feature_fields) != policy.feature_count:
        _unavailable("declared-feature-count-required")
    expected_order = tuple(LinearFeature(index, name) for index in range(candle_policy.feature_window_bars)
                           for name in candle_policy.feature_fields)
    if policy.feature_order != expected_order:
        _unavailable("declared-oldest-first-field-order-required")
    if (len(request.training) != policy.training_row_count or len(request.training) > request.budget.maximum_events
            or any(not isinstance(item, FoldRecord) or item.label is None for item in request.training)):
        _unavailable("declared-training-row-count-or-labels-required")
    input_bytes = len(request.binding.payload_bytes)
    for item in request.training:
        input_bytes += len(item.features.payload_bytes) + (len(item.label.payload_bytes) if item.label else 0)
    input_limit = min(policy.limits.maximum_input_bytes, request.budget.maximum_input_bytes)
    if input_bytes > input_limit:
        _unavailable("input-byte-budget-exceeded")
    sealed_model = policy.seal(boundary, policy_pin)
    sealed_labels = candle_policy.seal(boundary, policy.candle_policy_pin)
    input_bytes += len(sealed_model.payload_bytes) + len(sealed_labels.payload_bytes)
    if input_bytes > input_limit:
        _unavailable("input-byte-budget-exceeded")
    binding, fold = _binding(request, policy, candle_policy, boundary)
    ridge, max_condition = arithmetic.parse(policy.ridge), arithmetic.parse(policy.maximum_condition_number)
    dimension = policy.parameter_count
    matrix = [[Fraction(0) for _ in range(dimension)] for _ in range(dimension)]
    rhs = [Fraction(0) for _ in range(dimension)]
    records: list[dict[str, Any]] = []
    previous: tuple[int, str, str] | None = None
    identities: set[tuple[str, str]] = set()
    for record in request.training:
        arithmetic.check_cancelled()
        identity = (record.dataset_id, record.record_id)
        order = (time_ns(record.observed_at), *identity)
        if identity in identities or (previous is not None and order <= previous):
            _unavailable("unique-original-training-order-required")
        identities.add(identity)
        previous = order
        vector, label = _training_row(record, candle_policy, policy, fold, boundary, arithmetic)
        for i in range(dimension):
            rhs[i] = arithmetic.add(rhs[i], arithmetic.multiply(vector[i], label))
            for j in range(dimension):
                matrix[i][j] = arithmetic.add(matrix[i][j], arithmetic.multiply(vector[i], vector[j]))
        captured = boundary.internal("internal.CandleLinearTrainingRecord.v1", _record(record))
        records.append({"record": _record(record), "recordDigest": captured.digest})
    for i in range(dimension):
        if i < policy.feature_count or policy.penalize_intercept:
            matrix[i][i] = arithmetic.add(matrix[i][i], ridge)
    solution, condition = _solve(matrix, rhs, arithmetic, max_condition)
    training = boundary.internal("internal.CandleLinearTraining.v1", {
        "records": records, "rowCount": len(records), "executionAuthorized": False,
    })
    parameters = boundary.internal(LINEAR_PARAMETER_CONTRACT, {
        "version": "1.0.0", "modelPolicyPin": asdict(policy_pin), "candlePolicyPin": asdict(policy.candle_policy_pin),
        "parameterMappingPin": asdict(policy.parameter_mapping_pin), "datasetPin": asdict(candle_policy.datasets[0].data_pin),
        "trainingDigest": training.digest, "representation": "reduced-rational-v1",
        "outputSemantics": policy.output_semantics, "unit": "dimensionless",
        "featureTransform": candle_policy.feature_transform, "featureOrder": [item.record() for item in policy.feature_order],
        "coefficients": [_rational(value) for value in solution[:policy.feature_count]],
        "intercept": {"kind": policy.intercept,
                      "value": _rational(solution[-1]) if policy.intercept == "constant-one" else None},
        "executionAuthorized": False,
    })
    provenance = boundary.internal(LINEAR_PROVENANCE_CONTRACT, {
        "requestDigest": request.binding.digest, "modelPolicyPin": asdict(policy_pin),
        "modelPolicyDigest": sealed_model.digest, "candlePolicyDigest": sealed_labels.digest,
        "fitterPin": asdict(policy.fitter_pin), "implementationSourcePin": asdict(policy.implementation_source_pin),
        "implementationArtifactPin": asdict(policy.implementation_artifact_pin),
        "selectionDigest": binding["selectionDigest"], "verificationDigest": binding["verificationDigest"],
        "parameterDigest": parameters.digest, "trainingDigest": training.digest, "training": training.decode(),
        "solver": policy.solver, "objective": policy.objective, "ridge": policy.ridge.record(),
        "penalizeIntercept": policy.penalize_intercept, "conditionMeasure": policy.condition_measure,
        "conditionNumber": _rational(condition), "arithmeticOperations": arithmetic.operations,
        "inputBytes": input_bytes, "verified": False, "executionAuthorized": False,
    })
    returned_bytes = sum(len(item.payload_bytes) for item in (
        request.binding, sealed_model, sealed_labels, parameters, provenance,
    ))
    if returned_bytes > policy.limits.maximum_output_bytes:
        _unavailable("output-byte-budget-exceeded")
    arithmetic.check_cancelled()
    return LinearFitCandidate(request.binding, sealed_model, sealed_labels, parameters, provenance)


def fit_candle_linear_candidate(
    request: FoldFitRequest, *, policy: CandleLinearModelPolicy, policy_pin: Pin,
    candle_policy: CandleLabelPolicy, boundary: PublicBoundary, cancelled: Callable[[], bool] | None,
) -> LinearFitCandidate:
    """Produce one unqualified exact candidate or raise PortUnavailable.

    Coefficients align one-for-one with featureOrder's oldest-first row/field
    identities. A future engine computes intercept + sum(coefficient * raw field)
    as an exact rational dimensionless simple-return score, never as a position,
    order or economic result. Decimal conversion or score-to-strategy mapping
    requires a separately pinned, reviewed implementation; none is inferred here.
    """
    try:
        return _fit_candle_linear_candidate(
            request, policy=policy, policy_pin=policy_pin, candle_policy=candle_policy,
            boundary=boundary, cancelled=cancelled,
        )
    except (ValueError, TypeError, KeyError, AttributeError, OverflowError, RecursionError):
        # Includes malformed JSON/schema/canonical artifacts, not an alternate
        # algorithm or a replacement coefficient vector. PortUnavailable itself
        # propagates unchanged with the specific bounded failure reason.
        raise PortUnavailable("candle-linear-invalid-input-or-canonical-boundary") from None
