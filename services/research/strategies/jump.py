"""Fixed-centroid discrete statistical jump model, online inference only.

A named source variant of the Shu/Yu/Mulvey online inference (arXiv:2402.05272v3;
author jump-models commit d0fa00ce), NOT a paper reproduction. Centroids, jump
penalty, window length and scaler are supplied and reviewed; nothing is fitted.
Features are consumed already computed; the paper's E[R^2 1(R<0)] versus the
code's sqrt(EWM(min(r,0)^2)) downside-deviation construction is a declared
unknown here, never silently chosen. Output is a HARD state assignment, not a
calibrated probability, and must never be averaged with HMM posteriors.
No fitting, penalty selection, data IO, allocation or backtest.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime
from decimal import Context, Decimal, DivisionByZero, InvalidOperation, Overflow, ROUND_HALF_EVEN, localcontext

MAX_STATES = 8
MAX_FEATURES = 16
MAX_OBSERVATIONS = 512
MAX_WINDOW = 512
VARIANT = "discrete-fixed-centroid-trailing-window-dp-v1"
WINDOW_SEMANTICS = "trailing-window-fresh-start-each-step-v1"
TIE_RULE = "lowest-state-index-v1"
FEATURE_CONSTRUCTION = "upstream-reviewed-downside-deviation-variant-declared-unknown-v1"
ASSIGNMENT_KIND = "hard-assignment-not-probability"
NUMERICAL_ENCODING = "decimal-prec-200-half-even-cost-margin-rounded-15-decimal-places-v1"
# Deterministic decimal arithmetic: inputs are exact; division, products and sums
# round only at 200 significant digits, so an order-one penalty is never absorbed
# by large costs (the binary64 absorption hazard found in the HMM review).
ARITHMETIC = Context(prec=200, rounding=ROUND_HALF_EVEN, traps=[InvalidOperation, Overflow, DivisionByZero])
MARGIN_QUANTUM = Decimal("0.000000000000001")
LIMITATIONS = (
    "Fixed supplied centroids, penalty and window; discrete jump-model online inference only, not paper reproduction or fitting.",
    "Hard state assignment with fit-specific supplied labels; not a calibrated probability and never averaged with HMM posteriors.",
    "Upstream feature construction (paper versus author-code downside deviation) is a declared unknown; no allocation or backtest.",
)
_DECIMAL_TEXT = re.compile(r"-?(?:0|[1-9][0-9]{0,59})(?:\.[0-9]{1,60})?")
_PUBLIC_TEXT = re.compile(r"(?:0|-?(?:[1-9][0-9]{0,29}(?:\.[0-9]{0,17}[1-9])?|0\.[0-9]{0,17}[1-9]))")


@dataclass(frozen=True)
class JumpFeatureObservation:
    observed_at: datetime
    available_at: datetime
    values: tuple[str, ...]
    source_id: str
    source_hash: str


@dataclass(frozen=True)
class FixedCentroidJumpModel:
    profile: str
    feature_order: tuple[str, ...]
    state_labels: tuple[str, ...]
    centroids: tuple[tuple[str, ...], ...]
    jump_penalty: str
    window_length: int
    window_semantics: str
    tie_rule: str
    fit_cutoff: datetime
    available_at: datetime
    source_id: str
    source_hash: str


@dataclass(frozen=True)
class JumpFeatureScaler:
    profile: str
    feature_order: tuple[str, ...]
    center: tuple[str, ...]
    scale: tuple[str, ...]
    fit_cutoff: datetime
    available_at: datetime
    source_id: str
    source_hash: str


@dataclass(frozen=True)
class PublishedJumpState:
    """Final state of the window ending at this observation; published once."""
    observed_at: datetime
    available_at: datetime
    window_start_observed_at: datetime
    window_observations: int
    warmup: bool
    state_index: int
    state_label: str
    tie: bool
    cost_margin: str


@dataclass(frozen=True)
class JumpStateResult:
    profile: str
    assignment_kind: str
    variant: str
    prediction_as_of: datetime
    feature_order: tuple[str, ...]
    feature_construction: str
    state_labels: tuple[str, ...]
    jump_penalty: str
    window_length: int
    window_semantics: str
    tie_rule: str
    model_fit_cutoff: datetime
    model_available_at: datetime
    scaler_fit_cutoff: datetime
    scaler_available_at: datetime
    numerical_encoding: str
    states: tuple[PublishedJumpState, ...]
    limitations: tuple[str, ...]


def _require(condition: bool, reason: str) -> None:
    if not condition:
        raise ValueError("jump-" + reason)


def _time(value: datetime) -> None:
    _require(isinstance(value, datetime) and value.tzinfo is not None and value.utcoffset() is not None,
             "aware-time-required")


def _names(value: tuple[str, ...], minimum: int, maximum: int) -> None:
    _require(type(value) is tuple and minimum <= len(value) <= maximum, "dimension-budget")
    _require(all(type(item) is str and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}", item)
                 for item in value), "names-invalid")
    _require(len(set(value)) == len(value), "names-duplicate")


def _decimal(value: str) -> Decimal:
    _require(type(value) is str and len(value) <= 123 and _DECIMAL_TEXT.fullmatch(value) is not None,
             "finite-decimal-text-required")
    result = Decimal(value)
    _require(result.copy_abs() <= Decimal("1000000000000"), "number-budget")
    return result


def _vector(value: tuple[str, ...], size: int, *, positive: bool = False) -> tuple[Decimal, ...]:
    _require(type(value) is tuple and len(value) == size, "vector-dimension")
    result = tuple(_decimal(item) for item in value)
    if positive:
        _require(all(item >= Decimal("0.000000000001") for item in result), "positive-scale-required")
    return result


def _public(value: Decimal) -> str:
    text = "0" if value == 0 else format(value, "f")
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    _require(_PUBLIC_TEXT.fullmatch(text) is not None, "output-decimal-domain")
    return text


def assign_fixed_centroid_states(*, feature_order: tuple[str, ...], feature_construction: str,
                                 observations: tuple[JumpFeatureObservation, ...],
                                 model: FixedCentroidJumpModel, scaler: JumpFeatureScaler,
                                 as_of: datetime) -> JumpStateResult:
    """Per observation t, solve the fresh DP over the trailing window ending at t.

    z = (x-center)/scale; loss_k = 0.5*||z - c_k||^2; V_s = loss_s at window
    start s (no carried state, no prior); V_i(k) = loss_i(k) + min(V_{i-1}(k),
    min_j V_{i-1}(j) + lambda). Publish argmin_k V_t(k), ties to the lowest
    index, plus the unrounded-tie flag and rounded margin to the runner-up.
    Each step uses only rows <= t; earlier published states are never revised.
    """
    _names(feature_order, 1, MAX_FEATURES)
    _names(model.state_labels, 2, MAX_STATES)
    _require(model.profile == "vertex-jump-fixed-centroid-model-v1" and scaler.profile == "vertex-jump-scaler-v1",
             "profile-invalid")
    _require(feature_construction == FEATURE_CONSTRUCTION, "feature-construction-undeclared")
    _require(model.window_semantics == WINDOW_SEMANTICS and model.tie_rule == TIE_RULE, "semantics-unavailable")
    _require(type(model.window_length) is int and 1 <= model.window_length <= MAX_WINDOW, "window-budget")
    _require(feature_order == model.feature_order == scaler.feature_order, "feature-order-mismatch")
    _require(type(observations) is tuple and 1 <= len(observations) <= MAX_OBSERVATIONS, "observation-budget")
    for timestamp in (as_of, model.fit_cutoff, model.available_at, scaler.fit_cutoff, scaler.available_at):
        _time(timestamp)
    states, dimensions = len(model.state_labels), len(feature_order)
    _require(type(model.centroids) is tuple and len(model.centroids) == states, "centroid-dimension")
    centroids = tuple(_vector(row, dimensions) for row in model.centroids)
    penalty = _decimal(model.jump_penalty)
    _require(penalty >= 0, "penalty-negative")
    penalty_text = _public(penalty)
    center = _vector(scaler.center, dimensions)
    scale = _vector(scaler.scale, dimensions, positive=True)
    rows = []
    previous = None
    for row in observations:
        _require(isinstance(row, JumpFeatureObservation), "observation-invalid")
        _time(row.observed_at)
        _time(row.available_at)
        _require(row.observed_at <= row.available_at <= as_of, "future-observation")
        _require(previous is None or (previous.observed_at < row.observed_at
                                     and previous.available_at <= row.available_at), "observation-order")
        rows.append(_vector(row.values, dimensions))
        previous = row
    first = observations[0].observed_at
    _require(model.fit_cutoff <= model.available_at <= first and scaler.fit_cutoff <= scaler.available_at <= first
             and scaler.fit_cutoff <= model.fit_cutoff, "future-model-or-scaler")
    window = model.window_length
    published = []
    with localcontext(ARITHMETIC):
        half = Decimal("0.5")
        losses = []
        for vector in rows:
            scaled = tuple((value - center[j]) / scale[j] for j, value in enumerate(vector))
            losses.append(tuple(half * sum(((scaled[j] - centroid[j]) ** 2 for j in range(dimensions)), Decimal(0))
                                for centroid in centroids))
        for index, row in enumerate(observations):
            start = max(0, index - window + 1)
            values = losses[start]
            for loss in losses[start + 1:index + 1]:
                switch = min(values) + penalty
                values = tuple(loss[k] + (values[k] if values[k] <= switch else switch) for k in range(states))
            best = min(values)
            state = values.index(best)  # lowest index among exact ties
            runner = min(value for k, value in enumerate(values) if k != state)
            margin = (runner - best).quantize(MARGIN_QUANTUM, rounding=ROUND_HALF_EVEN)
            published.append(PublishedJumpState(row.observed_at, row.available_at, observations[start].observed_at,
                index - start + 1, index - start + 1 < window, state, model.state_labels[state],
                runner == best, _public(margin)))
    return JumpStateResult("vertex-jump-state-result-v1", ASSIGNMENT_KIND, VARIANT, as_of, feature_order,
        feature_construction, model.state_labels, penalty_text, window, WINDOW_SEMANTICS, TIE_RULE,
        model.fit_cutoff, model.available_at, scaler.fit_cutoff, scaler.available_at,
        NUMERICAL_ENCODING, tuple(published), LIMITATIONS)
