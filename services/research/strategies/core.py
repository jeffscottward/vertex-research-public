"""Internal deterministic research primitives, not public Vertex schemas.

Money enters as Decimal or decimal text, never float. Arithmetic uses an explicit
80-digit context. Derived ratios are rounded HALF_EVEN to 18 places; public exact
values are normalized without rounding and rejected when outside the v1 domain.
No clock, storage, provider, broker, or canonical-identity fallback is installed.
"""
from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Context, Decimal, ROUND_HALF_EVEN, localcontext
from functools import wraps
import re
from typing import Callable, Literal, TypeVar

ZERO = Decimal("0")
ONE = Decimal("1")
ARITHMETIC = Context(prec=80, rounding=ROUND_HALF_EVEN)
SLEEVES = ("wheel", "fundamental", "swing", "macro", "quant")
F = TypeVar("F", bound=Callable)


def deterministic(fn: F) -> F:
    @wraps(fn)
    def wrapped(*args, **kwargs):
        with localcontext(ARITHMETIC):
            return fn(*args, **kwargs)
    return wrapped  # type: ignore[return-value]


def exact(value: Decimal | str, *, nonnegative: bool = False, positive: bool = False) -> Decimal:
    if not isinstance(value, (str, Decimal)):
        raise TypeError("Exact Decimal or decimal text required; floats/integers are not money")
    if isinstance(value, str) and not re.fullmatch(r"-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?", value):
        raise ValueError("Plain decimal text required")
    result = Decimal(value)
    if not result.is_finite() or len(result.as_tuple().digits) > 60 or abs(result.as_tuple().exponent) > 60:
        raise ValueError("Nonfinite or unbounded decimal")
    if positive and result <= ZERO or nonnegative and result < ZERO:
        raise ValueError("Decimal outside required range")
    return ZERO if result == ZERO else result


def require_decimal(value: Decimal, **limits) -> Decimal:
    if not isinstance(value, Decimal):
        raise TypeError("Internal numeric fields require Decimal; use exact at input boundary")
    return exact(value, **limits)


def fraction(value: Decimal) -> Decimal:
    require_decimal(value, nonnegative=True)
    if value > ONE:
        raise ValueError("Fraction exceeds one")
    return value


def count(value: int, *, positive: bool = False) -> int:
    if type(value) is not int or value < (1 if positive else 0) or value > 9_007_199_254_740_991:
        raise ValueError("Count must be a bounded nonnegative integer")
    return value


def instant(value: datetime) -> datetime:
    if not isinstance(value, datetime) or value.tzinfo is None or value.utcoffset() is None:
        raise ValueError("Explicit timezone required")
    return value.astimezone(timezone.utc)


def identity(value: str) -> str:
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}", value):
        raise ValueError("Invalid identity")
    return value


def digest_text(value: str) -> str:
    if not isinstance(value, str) or not re.fullmatch(r"[0-9a-f]{64}", value):
        raise ValueError("Lowercase SHA256 required")
    return value


def public_decimal(value: Decimal) -> str:
    require_decimal(value)
    text = format(value, "f")
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    if value == ZERO:
        text = "0"
    # Output-domain guard only; authoritative public validation remains mandatory.
    if not re.fullmatch(r"(?:0|-?(?:[1-9][0-9]{0,29}(?:\.[0-9]{0,17}[1-9])?|0\.[0-9]{0,17}[1-9]))", text):
        raise ValueError("Exact value cannot be represented by public v1 decimal policy")
    return text


@deterministic
def ratio(numerator: Decimal, denominator: Decimal) -> Decimal:
    # Intermediates may use the full arithmetic precision; bounded exact input
    # guards belong at the caller's input boundary, not after discounted sums.
    if any(not isinstance(value, Decimal) or not value.is_finite() for value in (numerator, denominator)):
        raise TypeError("Finite Decimal ratio operands required")
    if denominator == ZERO:
        raise ValueError("Undefined ratio")
    return (numerator / denominator).quantize(Decimal("0.000000000000000001"))


@dataclass(frozen=True)
class ResearchDecision:
    status: Literal["proposal", "hold", "exit", "review", "unavailable"]
    reasons: tuple[str, ...]
    metrics: tuple[tuple[str, Decimal], ...] = ()
    evidence_ids: tuple[str, ...] = ()

    @property
    def executable(self) -> bool:
        return False


@dataclass(frozen=True)
class FeatureObservation:
    feature_id: str
    value: Decimal | None
    observed_at: datetime
    available_at: datetime
    completed_bars: int
    source_id: str

    def __post_init__(self):
        identity(self.feature_id)
        identity(self.source_id)
        instant(self.observed_at)
        instant(self.available_at)
        count(self.completed_bars)
        if self.available_at < self.observed_at:
            raise ValueError("Feature cannot be available before observed")
        if self.value is not None:
            require_decimal(self.value)


@dataclass(frozen=True)
class Rule:
    rule_id: str
    feature_id: str
    operator: Literal["lt", "lte", "eq", "gte", "gt"]
    threshold: Decimal
    lookback_bars: int

    def __post_init__(self):
        identity(self.rule_id)
        identity(self.feature_id)
        require_decimal(self.threshold)
        count(self.lookback_bars, positive=True)
        if self.lookback_bars > 100_000 or self.operator not in {"lt", "lte", "eq", "gte", "gt"}:
            raise ValueError("Invalid deterministic rule")

    def public_value(self) -> dict:
        return {"ruleId": self.rule_id, "featureId": self.feature_id,
                "operator": self.operator, "threshold": public_decimal(self.threshold),
                "lookbackBars": self.lookback_bars}


@dataclass(frozen=True)
class RuleResult:
    rule_id: str
    state: Literal["pass", "fail", "unavailable"]
    reason: str


def evaluate_rules(rules: Sequence[Rule], features: Mapping[str, FeatureObservation], *,
                   as_of: datetime, maximum_age_seconds: int) -> tuple[RuleResult, ...]:
    instant(as_of)
    count(maximum_age_seconds)
    if len({rule.rule_id for rule in rules}) != len(rules):
        raise ValueError("Duplicate rule IDs")
    results = []
    for rule in rules:
        feature = features.get(rule.feature_id)
        reason = None
        if feature is None or feature.value is None:
            reason = "missing-feature"
        elif feature.feature_id != rule.feature_id:
            reason = "feature-identity-mismatch"
        elif feature.available_at > as_of or feature.observed_at > as_of:
            reason = "future-feature"
        elif (as_of - feature.observed_at).total_seconds() > maximum_age_seconds:
            reason = "stale-feature"
        elif feature.completed_bars < rule.lookback_bars:
            reason = "insufficient-completed-bars"
        if reason:
            results.append(RuleResult(rule.rule_id, "unavailable", reason))
            continue
        value = feature.value
        passed = {"lt": value < rule.threshold, "lte": value <= rule.threshold,
                  "eq": value == rule.threshold, "gte": value >= rule.threshold,
                  "gt": value > rule.threshold}[rule.operator]
        results.append(RuleResult(rule.rule_id, "pass" if passed else "fail", "deterministic-comparison"))
    return tuple(results)


@dataclass(frozen=True)
class AllocationProposal:
    sleeve: str
    target_weights: tuple[tuple[str, Decimal], ...]
    reasons: tuple[str, ...]
    status: Literal["proposal", "hold", "unavailable"] = "proposal"

    def __post_init__(self):
        if self.sleeve not in SLEEVES:
            raise ValueError("Unknown sleeve; 0DTE is not a sixth sleeve")
        if len({key for key, _ in self.target_weights}) != len(self.target_weights):
            raise ValueError("Duplicate allocation instrument")
        for key, weight in self.target_weights:
            identity(key)
            fraction(weight)
        with localcontext(ARITHMETIC):
            if sum((weight for _, weight in self.target_weights), ZERO) > ONE:
                raise ValueError("Target weights exceed capital")

    @property
    def reserves_cash(self) -> bool:
        return False

    @property
    def executable(self) -> bool:
        return False
