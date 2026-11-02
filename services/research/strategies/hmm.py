"""Fixed-parameter diagonal Gaussian HMM, forward filtering only.

A named source variant inspired by the supplied HMM references, NOT their
exact paper reproduction. No fitting, smoothing, Viterbi, allocation or data IO.
Binary64 diagnostics are explicitly rounded to decimal text at this boundary;
they are not exact economic quantities or calibrated recession probabilities.
"""
from __future__ import annotations

import math
import re
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal, localcontext

MAX_STATES = 8
MAX_FEATURES = 16
MAX_OBSERVATIONS = 512
NUMERICAL_ENCODING = "binary64-posterior-rounded-15-decimal-places-v1"
LIMITATIONS = (
    "Fixed supplied parameters; diagonal Gaussian forward filtering only, not paper reproduction.",
    "State labels are supplied fit-specific interpretations, not economic-cycle or calibrated recession probabilities.",
    "Binary64 posterior diagnostics rounded to 15 decimal places; no fitting, smoothing, allocation or backtest.",
)


@dataclass(frozen=True)
class FeatureObservation:
    observed_at: datetime
    available_at: datetime
    values: tuple[str, ...]
    source_id: str
    source_hash: str


@dataclass(frozen=True)
class DiagonalGaussianModel:
    profile: str
    feature_order: tuple[str, ...]
    state_labels: tuple[str, ...]
    initial_probabilities: tuple[str, ...]
    transitions: tuple[tuple[str, ...], ...]
    means: tuple[tuple[str, ...], ...]
    variances: tuple[tuple[str, ...], ...]
    fit_cutoff: datetime
    available_at: datetime
    source_id: str
    source_hash: str


@dataclass(frozen=True)
class FeatureScaler:
    profile: str
    feature_order: tuple[str, ...]
    center: tuple[str, ...]
    scale: tuple[str, ...]
    fit_cutoff: datetime
    available_at: datetime
    source_id: str
    source_hash: str


@dataclass(frozen=True)
class FilteredState:
    observed_at: datetime
    available_at: datetime
    posterior: tuple[str, ...]
    state_index: int
    state_label: str


@dataclass(frozen=True)
class ForwardFilterResult:
    profile: str
    prediction_as_of: datetime
    feature_order: tuple[str, ...]
    state_labels: tuple[str, ...]
    model_fit_cutoff: datetime
    model_available_at: datetime
    scaler_fit_cutoff: datetime
    scaler_available_at: datetime
    numerical_encoding: str
    filtered: tuple[FilteredState, ...]
    limitations: tuple[str, ...]


def _require(condition: bool, reason: str) -> None:
    if not condition:
        raise ValueError("hmm-" + reason)


def _time(value: datetime) -> None:
    _require(isinstance(value, datetime) and value.tzinfo is not None and value.utcoffset() is not None,
             "aware-time-required")


def _names(value: tuple[str, ...], minimum: int, maximum: int) -> None:
    _require(type(value) is tuple and minimum <= len(value) <= maximum, "dimension-budget")
    _require(all(type(item) is str and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}", item)
                 for item in value), "names-invalid")
    _require(len(set(value)) == len(value), "names-duplicate")


def _decimal(value: str) -> Decimal:
    _require(type(value) is str and len(value) <= 123
             and re.fullmatch(r"-?(?:0|[1-9][0-9]{0,59})(?:\.[0-9]{1,60})?", value) is not None,
             "finite-decimal-text-required")
    result = Decimal(value)
    _require(result.copy_abs() <= Decimal("1000000000000"), "number-budget")
    return result


def _vector(value: tuple[str, ...], size: int, *, positive: bool = False) -> tuple[float, ...]:
    _require(type(value) is tuple and len(value) == size, "vector-dimension")
    exact = tuple(_decimal(item) for item in value)
    if positive:
        _require(all(item >= Decimal("0.000000000001") for item in exact), "positive-scale-or-variance-required")
    return tuple(float(item) for item in exact)


def _probabilities(value: tuple[str, ...], size: int) -> tuple[float, ...]:
    result = _vector(value, size)
    with localcontext() as context:
        context.prec = 200
        _require(all(Decimal(item) >= 0 for item in value) and sum(map(Decimal, value)) == 1,
                 "probabilities-must-sum-to-one")
    return result


def _matrix(value: tuple[tuple[str, ...], ...], rows: int, columns: int,
            *, positive: bool = False, probabilities: bool = False) -> tuple[tuple[float, ...], ...]:
    _require(type(value) is tuple and len(value) == rows, "matrix-dimension")
    return tuple(_probabilities(row, columns) if probabilities else _vector(row, columns, positive=positive)
                 for row in value)


def _log(value: float) -> float:
    return math.log(value) if value > 0 else -math.inf


def _logsumexp(values: tuple[float, ...]) -> float:
    maximum = max(values)
    if maximum == -math.inf:
        return maximum
    return maximum + math.log(math.fsum(math.exp(value - maximum) for value in values))


def _decimal_posterior(value: float) -> str:
    _require(math.isfinite(value) and 0 <= value <= 1, "posterior-nonfinite")
    return format(value, ".15f").rstrip("0").rstrip(".") or "0"


def filter_diagonal_gaussian(*, feature_order: tuple[str, ...], observations: tuple[FeatureObservation, ...],
                             model: DiagonalGaussianModel, scaler: FeatureScaler,
                             as_of: datetime) -> ForwardFilterResult:
    """P(S_t | x_0..x_t, fixed parameters); initial distribution is at x_0.

    Standardization is (x-center)/scale; means/diagonal variances are in that
    scaled feature space. Ties choose the first supplied state index. Zero
    probabilities stay impossible. No rounded posterior is reused internally.
    Every historical output requires model/scaler availability before x_0.
    """
    _names(feature_order, 1, MAX_FEATURES)
    _names(model.state_labels, 2, MAX_STATES)
    _require(model.profile == "vertex-hmm-diagonal-model-v1" and scaler.profile == "vertex-hmm-scaler-v1",
             "profile-invalid")
    _require(feature_order == model.feature_order == scaler.feature_order, "feature-order-mismatch")
    _require(type(observations) is tuple and 1 <= len(observations) <= MAX_OBSERVATIONS, "observation-budget")
    for timestamp in (as_of, model.fit_cutoff, model.available_at, scaler.fit_cutoff, scaler.available_at):
        _time(timestamp)
    states, dimensions = len(model.state_labels), len(feature_order)
    initial = _probabilities(model.initial_probabilities, states)
    transitions = _matrix(model.transitions, states, states, probabilities=True)
    means = _matrix(model.means, states, dimensions)
    variances = _matrix(model.variances, states, dimensions, positive=True)
    center = _vector(scaler.center, dimensions)
    scale = _vector(scaler.scale, dimensions, positive=True)
    values = []
    previous = None
    for row in observations:
        _time(row.observed_at)
        _time(row.available_at)
        _require(row.observed_at <= row.available_at <= as_of, "future-observation")
        _require(previous is None or (previous.observed_at < row.observed_at
                                     and previous.available_at <= row.available_at), "observation-order")
        values.append(_vector(row.values, dimensions))
        previous = row
    first = observations[0].observed_at
    _require(model.fit_cutoff <= model.available_at <= first and scaler.fit_cutoff <= scaler.available_at <= first
             and scaler.fit_cutoff <= model.fit_cutoff, "future-model-or-scaler")
    log_transition = tuple(tuple(_log(item) for item in row) for row in transitions)
    log_alpha = tuple(_log(item) for item in initial)
    filtered = []
    for index, (row, vector) in enumerate(zip(observations, values)):
        scaled = tuple((value - center[j]) / scale[j] for j, value in enumerate(vector))
        if index:
            log_alpha = tuple(_logsumexp(tuple(log_alpha[i] + log_transition[i][j] for i in range(states)))
                              for j in range(states))
        emissions = tuple(-0.5 * math.fsum(math.log(2 * math.pi) + math.log(variances[k][j])
                          + (scaled[j] - means[k][j]) ** 2 / variances[k][j] for j in range(dimensions))
                          for k in range(states))
        # Remove the common Gaussian offset before adding the predictive prior:
        # large finite log densities must not round away its order-one log odds.
        emission_offset = max(emissions[k] for k in range(states) if log_alpha[k] != -math.inf)
        weighted = tuple(log_alpha[k] + (emissions[k] - emission_offset) for k in range(states))
        maximum = max(weighted)
        _require(math.isfinite(maximum), "numerical-normalization-unavailable")
        # Subtract the maximum BEFORE adding the normalizer, avoiding loss of
        # its low bits when absolute log densities have very large magnitude.
        shifted = tuple(value - maximum for value in weighted)
        normalizer = math.log(math.fsum(math.exp(value) for value in shifted))
        log_alpha = tuple(value - normalizer for value in shifted)
        state = max(range(states), key=lambda k: log_alpha[k])
        filtered.append(FilteredState(row.observed_at, row.available_at,
            tuple(_decimal_posterior(math.exp(value)) for value in log_alpha), state, model.state_labels[state]))
    return ForwardFilterResult("vertex-hmm-forward-result-v1", as_of, feature_order, model.state_labels,
        model.fit_cutoff, model.available_at, scaler.fit_cutoff, scaler.available_at,
        NUMERICAL_ENCODING, tuple(filtered), LIMITATIONS)
