"""Closed, source-only Candle target policy; neither review nor execution authority.

No target/window/rounding default exists. This v1 capability supports only raw,
partition-local, contiguous fixed-duration bars and an exact rational simple
return. Calendar/session bars, adjusted-price interpretation, synthetic data,
legacy availability and inferred publication times are deliberately unavailable.
The caller must supply the authoritative public boundary and an independently
reviewed policy pin. Review IDs are references, never approvals by this module.
"""
from __future__ import annotations

import re
from dataclasses import asdict, dataclass
from fractions import Fraction
from typing import Any

from .lineage import DataPin, Pin, time_ns
from .ports import Artifact, ContractRejected, PortUnavailable, PublicBoundary, require_hash, require_id


CANDLE_CONTENT_FORMAT = "vertex-normalized-candle-envelope-v1"
CANDLE_POLICY_CONTRACT = "internal.CandleLabelPolicy.v1"
_INTERVAL_NS = {"1s": 1_000_000_000, "1m": 60_000_000_000, "5m": 300_000_000_000,
                "15m": 900_000_000_000, "1h": 3_600_000_000_000}
_FIELDS = frozenset({"open", "high", "low", "close", "volume"})


def interval_ns(interval: str) -> int:
    if not isinstance(interval, str) or interval not in _INTERVAL_NS:
        raise PortUnavailable("candle-fixed-interval-policy-unsupported")
    return _INTERVAL_NS[interval]


def _count(value: int, maximum: int) -> None:
    if type(value) is not int or not 1 <= value <= maximum:
        raise PortUnavailable("candle-positive-whole-bar-policy-required")


def _window(start: str, end: str) -> None:
    if not isinstance(start, str) or not isinstance(end, str) or time_ns(start) >= time_ns(end):
        raise ValueError("explicit nonempty UTC source bounds required")


def decimal_fraction(value: str) -> Fraction:
    """Lossless arithmetic subset, not a replacement public Candle validator."""
    if (not isinstance(value, str) or len(value) > 49
            or re.fullmatch(r"(?:0|[1-9][0-9]{0,29})(?:\.[0-9]{0,17}[1-9])?", value) is None):
        raise PortUnavailable("candle-exact-nonnegative-decimal-required")
    whole, _, fraction = value.partition(".")
    return Fraction(int(whole + fraction), 10 ** len(fraction))


def simple_return(start_close: str, end_close: str) -> dict[str, str]:
    """The ONLY target: (endpoint close / starting close) - 1, without rounding."""
    start, end = decimal_fraction(start_close), decimal_fraction(end_close)
    if start <= 0:
        raise PortUnavailable("candle-simple-return-zero-denominator")
    result = end / start - 1
    return {"numerator": str(result.numerator), "denominator": str(result.denominator)}


@dataclass(frozen=True)
class CandleSourcePin:
    source_id: str
    snapshot_id: str
    content_hash: str

    def __post_init__(self) -> None:
        require_id(self.source_id)
        require_id(self.snapshot_id)
        require_hash(self.content_hash)

    def record(self, provider: str) -> dict[str, str]:
        return {"provider": provider, "sourceId": self.source_id,
                "snapshotId": self.snapshot_id, "contentHash": self.content_hash}


@dataclass(frozen=True)
class CandleDatasetPolicy:
    """One exact series per dataset; no joins, ticker inference or source fallback."""
    data_pin: DataPin
    provider: str
    sources: tuple[CandleSourcePin, ...]
    instrument_id: str
    currency: str
    quantity_unit: str
    provider_timezone: str
    interval: str
    adjustment_method: str
    source_start_at: str
    source_end_at: str
    availability_start_at: str
    availability_end_at: str

    def __post_init__(self) -> None:
        if not isinstance(self.data_pin, DataPin):
            raise ValueError("exact dataset pin required")
        for identity in (self.provider, self.instrument_id):
            require_id(identity)
        object.__setattr__(self, "sources", tuple(self.sources))
        if (not 1 <= len(self.sources) <= 512 or any(not isinstance(item, CandleSourcePin) for item in self.sources)
                or len(set(self.sources)) != len(self.sources)):
            raise ValueError("unique exact source triples required")
        if set(self.data_pin.source_digests) != {item.content_hash for item in self.sources}:
            raise ValueError("source digest and dataset pin mismatch")
        if self.data_pin.data_kinds != ("candles",) or self.data_pin.vintage_id is None:
            raise PortUnavailable("candle-vintage-pinned-data-required")
        if not isinstance(self.currency, str) or re.fullmatch(r"[A-Z]{3}", self.currency) is None:
            raise ValueError("explicit currency required")
        if self.quantity_unit not in ("shares", "contracts", "base-asset"):
            raise PortUnavailable("candle-quantity-unit-unsupported")
        if (not isinstance(self.provider_timezone, str) or len(self.provider_timezone) > 80
                or re.fullmatch(r"[A-Za-z_]+(?:/[A-Za-z0-9_+-]+)*", self.provider_timezone) is None):
            raise ValueError("explicit provider timezone required")
        interval_ns(self.interval)
        if self.adjustment_method != "unadjusted":
            raise PortUnavailable("candle-adjustment-policy-unsupported")
        _window(self.source_start_at, self.source_end_at)
        _window(self.availability_start_at, self.availability_end_at)

    def record(self) -> dict[str, Any]:
        return {
            "dataPin": asdict(self.data_pin), "provider": self.provider,
            "sources": [item.record(self.provider) for item in self.sources],
            "instrumentId": self.instrument_id, "currency": self.currency,
            "quantityUnit": self.quantity_unit, "providerTimezone": self.provider_timezone,
            "interval": self.interval, "adjustmentMethod": self.adjustment_method,
            "sourceStartAtInclusive": self.source_start_at, "sourceEndAtExclusive": self.source_end_at,
            "availabilityStartAtInclusive": self.availability_start_at,
            "availabilityEndAtExclusive": self.availability_end_at,
        }


@dataclass(frozen=True)
class CandleLabelPolicy:
    policy_id: str
    version: str
    target: str
    horizon_bars: int
    target_representation: str
    feature_fields: tuple[str, ...]
    feature_window_bars: int
    feature_transform: str
    window_policy: str
    gap_policy: str
    availability_policy: str
    datasets: tuple[CandleDatasetPolicy, ...]
    registered_at: str
    review_evidence_ids: tuple[str, ...]

    def __post_init__(self) -> None:
        require_id(self.policy_id)
        if (self.version != "1.0.0" or self.target != "close-to-close-simple-return"
                or self.target_representation != "reduced-rational-v1"
                or self.feature_transform != "raw-ohlcv-window-v1"
                or self.window_policy != "partition-local-contiguous-v1"
                or self.gap_policy != "unavailable"
                or self.availability_policy != "exact-source-instrument-received-at-v1"):
            raise PortUnavailable("candle-label-or-feature-policy-unsupported")
        _count(self.horizon_bars, 4096)
        _count(self.feature_window_bars, 4096)
        object.__setattr__(self, "feature_fields", tuple(self.feature_fields))
        if (not 1 <= len(self.feature_fields) <= 5 or any(not isinstance(item, str) for item in self.feature_fields)
                or len(set(self.feature_fields)) != len(self.feature_fields)
                or not set(self.feature_fields).issubset(_FIELDS)):
            raise PortUnavailable("candle-explicit-feature-fields-required")
        object.__setattr__(self, "datasets", tuple(self.datasets))
        if not 1 <= len(self.datasets) <= 64 or any(not isinstance(item, CandleDatasetPolicy) for item in self.datasets):
            raise ValueError("bounded exact dataset policies required")
        if len({item.data_pin.dataset_id for item in self.datasets}) != len(self.datasets):
            raise ValueError("duplicate dataset policy")
        if not isinstance(self.registered_at, str):
            raise ValueError("exact UTC policy registration required")
        time_ns(self.registered_at)
        object.__setattr__(self, "review_evidence_ids", tuple(self.review_evidence_ids))
        if (not 1 <= len(self.review_evidence_ids) <= 64
                or len(set(self.review_evidence_ids)) != len(self.review_evidence_ids)):
            raise ValueError("unique existing review evidence references required")
        for identity in self.review_evidence_ids:
            require_id(identity)

    def record(self) -> dict[str, Any]:
        return {
            "policyId": self.policy_id, "version": self.version, "target": self.target,
            "horizonBars": self.horizon_bars, "targetRepresentation": self.target_representation,
            "featureFields": list(self.feature_fields), "featureWindowBars": self.feature_window_bars,
            "featureTransform": self.feature_transform, "windowPolicy": self.window_policy,
            "gapPolicy": self.gap_policy, "availabilityPolicy": self.availability_policy,
            "contentFormat": CANDLE_CONTENT_FORMAT, "datasets": [item.record() for item in self.datasets],
            "registeredAt": self.registered_at, "reviewEvidenceIds": list(self.review_evidence_ids),
            "executionAuthorized": False,
        }

    def seal(self, boundary: PublicBoundary, expected_pin: Pin) -> Artifact:
        """Check supplied pin; never generate an accepted policy pin or review."""
        sealed = boundary.internal(CANDLE_POLICY_CONTRACT, self.record())
        if (expected_pin.identity != self.policy_id or expected_pin.version != self.version
                or expected_pin.digest != sealed.digest):
            raise ContractRejected("candle-reviewed-policy-pin-mismatch")
        return sealed
