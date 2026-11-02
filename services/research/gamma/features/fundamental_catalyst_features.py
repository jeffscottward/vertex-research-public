"""Optional traditional-data catalyst features from Financial Datasets payloads."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from gamma.schemas.base import NonNegativeFloat, SchemaModel, TickerSymbol


class FundamentalCatalystFeatureSnapshot(SchemaModel):
    ticker: TickerSymbol
    sector: str | None = None
    industry: str | None = None
    market_cap: NonNegativeFloat | None = None
    employee_count: int | None = None
    financial_metric_changes: dict[str, float]
    earnings_dates: list[str]
    earnings_surprise_flags: list[str]
    filing_sections: dict[str, str]
    insider_trade_summary: dict[str, Any]
    institutional_holding_summary: dict[str, Any]
    index_fund_exposure: dict[str, Any]
    raw: dict[str, Any]


class FundamentalCatalystFeatures:
    """Extract optional company/fundamental catalysts without blocking scans."""

    def compute(
        self,
        *,
        ticker: str,
        payload: Mapping[str, Any] | None,
    ) -> FundamentalCatalystFeatureSnapshot:
        data = dict(payload or {})
        facts = _mapping(data.get("company_facts") or data.get("company"))
        metrics = _mapping(data.get("financial_metrics") or data.get("metrics"))
        earnings = data.get("earnings") or []
        filings = data.get("filings") or []
        return FundamentalCatalystFeatureSnapshot(
            ticker=ticker.upper(),
            sector=_string(facts, "sector"),
            industry=_string(facts, "industry"),
            market_cap=_number(facts, "market_cap", "marketCap"),
            employee_count=_int(facts, "employee_count", "employeeCount"),
            financial_metric_changes=_metric_changes(metrics),
            earnings_dates=_earnings_dates(earnings),
            earnings_surprise_flags=_earnings_surprises(earnings),
            filing_sections=_filing_sections(filings),
            insider_trade_summary=_mapping(data.get("insider_trades")),
            institutional_holding_summary=_mapping(data.get("institutional_holdings")),
            index_fund_exposure=_mapping(data.get("index_fund_exposure")),
            raw=data,
        )


def _mapping(value: Any) -> dict[str, Any]:
    return dict(value) if isinstance(value, Mapping) else {}


def _string(payload: Mapping[str, Any], key: str) -> str | None:
    value = payload.get(key)
    return str(value) if value not in (None, "") else None


def _number(payload: Mapping[str, Any], *keys: str) -> float | None:
    for key in keys:
        value = payload.get(key)
        if value is None:
            continue
        try:
            return max(float(value), 0.0)
        except (TypeError, ValueError):
            continue
    return None


def _int(payload: Mapping[str, Any], *keys: str) -> int | None:
    value = _number(payload, *keys)
    return int(value) if value is not None else None


def _metric_changes(metrics: Mapping[str, Any]) -> dict[str, float]:
    changes: dict[str, float] = {}
    for key, value in metrics.items():
        if not str(key).endswith(("_change", "_growth", "_delta")):
            continue
        try:
            changes[str(key)] = float(value)
        except (TypeError, ValueError):
            continue
    return changes


def _earnings_dates(earnings: Any) -> list[str]:
    if not isinstance(earnings, list):
        return []
    dates: list[str] = []
    for item in earnings:
        if isinstance(item, Mapping):
            value = item.get("date") or item.get("report_date")
            if value:
                dates.append(str(value))
    return dates


def _earnings_surprises(earnings: Any) -> list[str]:
    if not isinstance(earnings, list):
        return []
    flags: list[str] = []
    for item in earnings:
        if not isinstance(item, Mapping):
            continue
        surprise = _signed_number(item, "surprise_percent", "surprisePercent")
        if surprise is None:
            continue
        if surprise >= 5:
            flags.append("positive_surprise")
        elif surprise <= -5:
            flags.append("negative_surprise")
    return flags


def _signed_number(payload: Mapping[str, Any], *keys: str) -> float | None:
    for key in keys:
        value = payload.get(key)
        if value is None:
            continue
        try:
            return float(value)
        except (TypeError, ValueError):
            continue
    return None


def _filing_sections(filings: Any) -> dict[str, str]:
    if not isinstance(filings, list):
        return {}
    sections: dict[str, str] = {}
    for filing in filings:
        if not isinstance(filing, Mapping):
            continue
        for key in ("item_1a", "risk_factors", "item_7", "mda"):
            value = filing.get(key)
            if value:
                sections[key] = str(value)
    return sections


__all__ = [
    "FundamentalCatalystFeatureSnapshot",
    "FundamentalCatalystFeatures",
]
