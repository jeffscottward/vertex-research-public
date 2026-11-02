"""Quant Data analytics remain provider-reported facts, never fabricated executable quotes.

Source: authorized Gamma quantdata_adapter.py:23-43,102-406,894-954.
Opaque analytics preserve exact values; converting them requires explicit semantics/units.
"""
from __future__ import annotations

from datetime import date
from decimal import Decimal
from typing import Any

from .boundary import BoundaryError, epoch_ns, exact_decimal
from .client import Endpoint, ProviderClient
from .financialdatasets import ticker
from .ports import PagePlan, ProviderCapture, Unavailable


SOURCE = "gamma-forge:forge/src/options_alpha/adapters/quantdata_adapter.py:23-43,102-406,894-954"
ENDPOINTS = tuple(Endpoint(operation, "POST", path, SOURCE) for operation, path in (
    ("equity-snapshot", "/v1/equities/tool/market-map"),
    ("equity-bars", "/v1/equities/tool/stock-price-over-time"),
    ("option-chain", "/v1/options/tool/term-structure"),
    ("option-flow", "/v1/options/tool/order-flow/consolidated"),
    ("contract-statistics", "/v1/options/tool/contract-statistics"),
    ("open-interest-by-strike", "/v1/options/tool/open-interest-by-strike"),
    ("option-price", "/v1/options/tool/option-price-over-time"),
    ("iv-surface", "/v1/options/tool/volatility-skew"),
))
BAR_ALIASES = {"openPrice": "open", "highPrice": "high", "lowPrice": "low", "closePrice": "close", "totalVolume": "volume", "tradeVolume": "volume"}


def canonical_bar(row: dict[str, Any]) -> dict[str, Any]:
    result = dict(row)
    for provider_key, canonical in BAR_ALIASES.items():
        if provider_key not in result:
            continue
        if canonical in result and exact_decimal(result[canonical]) != exact_decimal(result[provider_key]):
            raise BoundaryError("conflicting-provider-aliases")
        result[canonical] = result[provider_key]
    return result


def rows_from_data(data: Any, maximum: int) -> list[dict[str, Any]]:
    if isinstance(data, list):
        if len(data) > maximum or any(not isinstance(row, dict) for row in data):
            raise BoundaryError("invalid-rows")
        return [dict(row) for row in data]
    if isinstance(data, dict):
        if len(data) > maximum:
            raise BoundaryError("row-budget")
        rows = []
        for timestamp, row in data.items():
            if not isinstance(row, dict) or ("timestamp" in row and row["timestamp"] != timestamp):
                raise BoundaryError("invalid-row-or-timestamp-conflict")
            rows.append({"timestamp": timestamp, **row})
        return rows
    raise BoundaryError("missing-provider-data")


class QuantData:
    def __init__(self, **ports: Any):
        self.client = ProviderClient(origin="https://api.quantdata.us", endpoints=ENDPOINTS, **ports)
        if self.client.config.provider != "quantdata":
            raise BoundaryError("provider-identity-mismatch")

    def request_plan(self, operation: str, symbol: str, *, start_at: str | None = None, end_at: str | None = None,
                     aggregation_period: str | None = None, snapshot_at: str | None = None, expiration_date: str | None = None,
                     strike: str | None = None, contract_type: str | None = None) -> PagePlan | Unavailable:
        try:
            normalized = ticker(symbol)
            body: dict[str, Any] = {"filter": {"ticker": normalized}}
            if operation == "equity-snapshot":
                body = {"filterExpression": {"field": "SYMBOL", "operation": "EQUALS", "value": normalized}}
            elif operation in ("equity-bars", "option-flow"):
                if start_at is None or end_at is None or epoch_ns(start_at) >= epoch_ns(end_at):
                    raise BoundaryError("invalid-time-range")
                body["timeRange"] = {"startTime": start_at, "endTime": end_at}
                if operation == "equity-bars":
                    if not isinstance(aggregation_period, str) or not 1 <= len(aggregation_period) <= 40:
                        raise BoundaryError("aggregation-period-required")
                    body["aggregationPeriod"] = aggregation_period
            elif operation in ("option-chain", "iv-surface") and snapshot_at is not None:
                epoch_ns(snapshot_at)
                body["snapshotTime"] = snapshot_at
            elif operation == "option-price":
                if expiration_date is None or strike is None or contract_type not in ("CALL", "PUT", "call", "put"):
                    raise BoundaryError("option-contract-identity-required")
                expiry = date.fromisoformat(expiration_date).isoformat()
                exact_strike = Decimal(exact_decimal(strike, nonnegative=True))
                if exact_strike <= 0:
                    raise BoundaryError("positive-strike-required")
                body = {"filter": {"ticker": normalized, "expirationDate": expiry, "strikePrice": exact_strike, "contractType": contract_type.upper()}}
            return self.client.plan(operation, body=body)
        except (BoundaryError, TypeError, ValueError):
            return self.client.unavailable("invalid-request", "Request range or identity is invalid.")

    def records(self, capture: ProviderCapture) -> list[dict[str, Any]] | dict[str, Any] | Unavailable:
        try:
            if capture.provider != "quantdata":
                raise BoundaryError("capture-provider-mismatch")
            data = self.client.decode_capture(capture).get("data")
            maximum = self.client.config.maximum_rows
            if capture.operation == "equity-bars":
                return [canonical_bar(row) for row in rows_from_data(data, maximum)]
            if capture.operation == "option-flow":
                return rows_from_data(data, maximum)
            if capture.operation == "option-chain":
                if isinstance(data, list):
                    return rows_from_data(data, maximum)
                if not isinstance(data, dict):
                    raise BoundaryError("missing-chain")
                result = []
                for expiration, strikes in data.items():
                    if not isinstance(strikes, dict):
                        raise BoundaryError("invalid-chain-strikes")
                    for strike, contracts in strikes.items():
                        if not isinstance(contracts, dict):
                            raise BoundaryError("invalid-chain-contracts")
                        for right, contract in contracts.items():
                            if not isinstance(contract, dict):
                                raise BoundaryError("invalid-chain-contract")
                            bindings = {"expirationDate": expiration, "strikePrice": strike, "contractType": right}
                            for key, value in bindings.items():
                                if key in contract and str(contract[key]) != value:
                                    raise BoundaryError("conflicting-chain-identity")
                            result.append({**bindings, **contract})
                            if len(result) > maximum:
                                raise BoundaryError("row-budget")
                return result
            if capture.operation in ("equity-snapshot", "contract-statistics", "open-interest-by-strike", "iv-surface", "option-price"):
                if not isinstance(data, dict):
                    raise BoundaryError("missing-analytics")
                return data
            raise BoundaryError("unsupported-response")
        except Exception:
            return self.client.unavailable("invalid-response", "Unsupported/missing analytics are unavailable, not zero or synthetic market evidence.")
