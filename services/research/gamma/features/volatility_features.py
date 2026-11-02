"""Volatility feature extraction from QuantData volatility payloads."""

from __future__ import annotations

from collections.abc import Mapping
from datetime import UTC, date, datetime
from typing import Any

from gamma.schemas import VolatilitySnapshot


class VolatilityFeatures:
    """Normalize QuantData IV/skew/term-structure fields into a typed snapshot."""

    def compute(
        self,
        *,
        ticker: str,
        payload: Mapping[str, Any],
        as_of: datetime | None = None,
    ) -> VolatilitySnapshot:
        front_iv = _number(payload, "front_iv", "frontMonthIv", "near_term_iv")
        back_iv = _number(payload, "back_iv", "backMonthIv", "long_term_iv")
        iv_change = _number(payload, "iv_change", "ivChange", "iv_change_pct")
        return VolatilitySnapshot(
            ticker=ticker.upper(),
            as_of=_coerce_datetime(as_of) if as_of else _payload_datetime(payload),
            iv_rank=_number(payload, "iv_rank", "ivRank"),
            iv_percentile=_number(payload, "iv_percentile", "ivPercentile"),
            front_iv=front_iv,
            back_iv=back_iv,
            term_structure_label=_term_structure_label(front_iv, back_iv),
            skew_label=_skew_label(payload),
            event_risk=_event_risks(payload),
            iv_change_label=_iv_change_label(iv_change),
            notes="Defaulted to provider supplied QuantData IV/skew fields.",
            raw=dict(payload),
        )


def _payload_datetime(payload: Mapping[str, Any]) -> datetime:
    value = payload.get("as_of") or payload.get("timestamp") or payload.get("date")
    if value is None:
        raise ValueError("Volatility payload requires as_of, timestamp, or date")
    return _coerce_datetime(value)


def _coerce_datetime(value: datetime | date | str) -> datetime:
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=UTC)
    if isinstance(value, date):
        return datetime(value.year, value.month, value.day, tzinfo=UTC)
    if isinstance(value, str):
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)
    raise TypeError("as_of must be a datetime, date, or ISO timestamp string")


def _number(payload: Mapping[str, Any], *keys: str) -> float | None:
    for key in keys:
        value = payload.get(key)
        if value is None:
            continue
        try:
            return float(value)
        except (TypeError, ValueError):
            continue
    return None


def _term_structure_label(
    front_iv: float | None,
    back_iv: float | None,
) -> str:
    if front_iv is None or back_iv is None:
        return "unknown"
    if front_iv > back_iv * 1.05:
        return "backwardation"
    if back_iv > front_iv * 1.05:
        return "contango"
    return "flat"


def _skew_label(payload: Mapping[str, Any]) -> str:
    explicit = payload.get("skew_label") or payload.get("skewLabel")
    if isinstance(explicit, str):
        normalized = explicit.strip().lower()
        if normalized in {"call_skew", "put_skew", "balanced", "unknown"}:
            return normalized
    call_skew = _number(payload, "call_skew", "callSkew")
    put_skew = _number(payload, "put_skew", "putSkew")
    if call_skew is None or put_skew is None:
        return "unknown"
    if call_skew > put_skew * 1.05:
        return "call_skew"
    if put_skew > call_skew * 1.05:
        return "put_skew"
    return "balanced"


def _event_risks(payload: Mapping[str, Any]) -> list[str]:
    risks: list[str] = []
    for key in ("event_risk", "eventRisk", "events", "earnings_date"):
        value = payload.get(key)
        if value is None:
            continue
        if isinstance(value, list | tuple):
            risks.extend(str(item) for item in value if str(item).strip())
        else:
            risks.append(str(value))
    return risks


def _iv_change_label(iv_change: float | None) -> str:
    if iv_change is None:
        return "unknown"
    if iv_change >= 0.03:
        return "expanding"
    if iv_change <= -0.03:
        return "contracting"
    return "stable"


__all__ = ["VolatilityFeatures"]
