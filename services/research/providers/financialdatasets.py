"""Financialdatasets request/shape adapters from authorized Gamma source, not vendor entitlement.

Source: gamma-forge/forge/src/options_alpha/adapters/financial_datasets_adapter.py:16-270.
No quote, option-Greek, trade-side or undocumented news endpoint is asserted.
"""
from __future__ import annotations

import re
from datetime import date
from typing import Any
from urllib.parse import urlsplit

from .boundary import BoundaryError
from .client import Endpoint, ProviderClient, required_rows
from .ports import PagePlan, ProviderCapture, Unavailable


SOURCE = "gamma-forge:forge/src/options_alpha/adapters/financial_datasets_adapter.py:16-270"
ENDPOINTS = tuple(Endpoint(operation, method, path, SOURCE) for operation, method, path in (
    ("company-facts", "GET", "/company/facts"),
    ("financial-statements", "GET", "/financials"),
    ("financial-metrics", "GET", "/financial-metrics/snapshot"),
    ("earnings", "GET", "/earnings"),
    ("filings", "GET", "/filings"),
    ("filing-item", "GET", "/filings/items"),
    ("insider-trades", "GET", "/insider-trades"),
    ("institutional-holdings", "GET", "/institutional-holdings"),
    ("index-funds", "GET", "/index-funds"),
    ("equity-bars", "GET", "/prices"),
    ("screener", "POST", "/financials/search/screener"),
))


def ticker(value: str) -> str:
    if not isinstance(value, str) or re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9.:-]{0,31}", value) is None:
        raise BoundaryError("invalid-symbol")
    return value.upper()


DEFAULT_ORIGIN = "https://api.financialdatasets.ai"
# The documented statements endpoint returns at most 10 records per page; pages are never followed here.
MAXIMUM_STATEMENT_LIMIT = 10


def origin_url(value: str) -> str:
    """Accept only a bare HTTPS origin, so a configured base URL cannot carry a path, query or credentials."""
    parts = urlsplit(value) if isinstance(value, str) else None
    if (parts is None or len(value) > 256 or parts.scheme != "https" or not parts.hostname or parts.username
            or parts.password or parts.path not in ("", "/") or parts.query or parts.fragment
            or any(ord(char) < 33 or ord(char) == 127 for char in value)):
        raise BoundaryError("invalid-provider-origin")
    return value.rstrip("/")


class FinancialDatasets:
    def __init__(self, *, origin: str = DEFAULT_ORIGIN, **ports: Any):
        self.client = ProviderClient(origin=origin_url(origin), endpoints=ENDPOINTS, **ports)
        if self.client.config.provider != "financialdatasets":
            raise BoundaryError("provider-identity-mismatch")

    def request_plan(self, operation: str, symbol: str, *, start_date: str | None = None, end_date: str | None = None,
                     interval: str | None = None, period: str = "ttm", filing_type: str | None = None,
                     accession_number: str | None = None, item: str | None = None, limit: int | None = None) -> PagePlan | Unavailable:
        try:
            query = [("holding" if operation == "index-funds" else "ticker", ticker(symbol))]
            if operation == "equity-bars":
                if start_date is None or end_date is None or interval is None:
                    raise BoundaryError("bar-range-required")
                start, end = date.fromisoformat(start_date), date.fromisoformat(end_date)
                if start > end or interval not in ("second", "minute", "day", "week", "month"):
                    raise BoundaryError("invalid-bar-range-or-interval")
                query.extend((("start_date", start.isoformat()), ("end_date", end.isoformat()), ("interval", interval)))
            elif operation == "financial-statements":
                if period not in ("ttm", "annual", "quarterly"):
                    raise BoundaryError("unsupported-period")
                query.append(("period", period))
                if limit is not None:
                    if type(limit) is not int or not 1 <= limit <= MAXIMUM_STATEMENT_LIMIT:
                        raise BoundaryError("unsupported-limit")
                    query.append(("limit", str(limit)))
            elif operation == "filings" and filing_type is not None:
                query.append(("filing_type", filing_type))
            elif operation == "filing-item":
                if not accession_number or not item:
                    raise BoundaryError("filing-locator-required")
                query.extend((("accession_number", accession_number), ("item", item)))
            if operation == "screener":
                return self.client.unavailable("explicit-filter-plan-required", "Use screener_plan with bounded caller-supplied filter records.")
            return self.client.plan(operation, query=tuple(query))
        except (BoundaryError, ValueError, TypeError):
            return self.client.unavailable("invalid-request", "Source request arguments are invalid or unsupported.")

    def screener_plan(self, filters: list[dict[str, Any]]) -> PagePlan | Unavailable:
        if not isinstance(filters, list) or not 1 <= len(filters) <= 32 or any(not isinstance(row, dict) for row in filters):
            return self.client.unavailable("invalid-filter-budget", "Provide one to 32 explicit provider filter records.")
        return self.client.plan("screener", body={"filters": filters})

    def records(self, capture: ProviderCapture) -> list[dict[str, Any]] | dict[str, Any] | Unavailable:
        try:
            if capture.provider != "financialdatasets":
                raise BoundaryError("capture-provider-mismatch")
            payload = self.client.decode_capture(capture)
            list_keys = {"equity-bars": "prices", "earnings": "earnings", "filings": "filings", "insider-trades": "insider_trades",
                         "institutional-holdings": "institutional_holdings", "index-funds": "funds", "screener": "results"}
            if capture.operation in list_keys:
                return required_rows(payload, list_keys[capture.operation], self.client.config.maximum_rows)
            key = {"company-facts": "company_facts", "financial-metrics": "snapshot"}.get(capture.operation)
            if key is not None:
                if not isinstance(payload.get(key), dict):
                    raise BoundaryError("missing-provider-record")
                return payload[key]
            if capture.operation in ("financial-statements", "filing-item"):
                return payload
            raise BoundaryError("unsupported-response")
        except Exception:
            return self.client.unavailable("invalid-response", "Provider response is not a supported source shape; missing data is not zero.")
