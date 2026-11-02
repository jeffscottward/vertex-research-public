"""Offline native artifact boundary; deliberately NOT a public Vertex wire adapter.

The mirrored kernels remain source-compatible. Use this boundary for research
artifacts: explicit knowledge cutoffs, digest-verified JSON inputs and detached,
recursively immutable output graphs. Input metadata is a caller assertion, not
an entitlement decision or proof of provider truth. No clock or provider I/O.
"""

from __future__ import annotations

import hashlib
import json
import math
import re
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import UTC, date, datetime
from types import MappingProxyType
from typing import Any

from pydantic import BaseModel

from gamma.engines import SetupEngine
from gamma.features import (
    FundamentalCatalystFeatures,
    LiquidityFeatures,
    MarketStructureFeatures,
    MomentumFeatures,
    OptionFlowFeatures,
    VolatilityFeatures,
)
from gamma.features.fundamental_catalyst_features import FundamentalCatalystFeatureSnapshot
from gamma.features.liquidity_features import LiquidityFeatureSnapshot
from gamma.features.volatility_features import _coerce_datetime as _volatility_time
from gamma.schemas import (
    CandidateCompany,
    MarketRegime,
    MarketStructureSnapshot,
    OptionFlowSnapshot,
    ResearchBrief,
    VolatilitySnapshot,
)
from gamma.schemas.base import canonical_artifact_json

MAX_INPUT_BYTES = 8 * 1024 * 1024
MAX_DEPTH = 48
OBSERVATION_KEYS = frozenset({"as_of", "datetime", "timestamp", "observed_at", "published_at"})
AVAILABILITY_KEYS = frozenset({"available_at", "captured_at", "fetched_at"})


def _aware(value: datetime, label: str) -> datetime:
    if not isinstance(value, datetime) or value.tzinfo is None or value.utcoffset() is None:
        raise ValueError(f"{label} requires an explicit timezone-aware datetime")
    normalized = value.astimezone(UTC)
    # Reconstruct a plain datetime with immutable UTC, not caller-owned tzinfo
    # or a datetime subclass. Receipt identities must not change after hashing.
    return datetime(normalized.year, normalized.month, normalized.day, normalized.hour,
                    normalized.minute, normalized.second, normalized.microsecond, tzinfo=UTC)


def _timestamp(value: Any) -> datetime:
    """Native microsecond timestamps only; never silently truncate wire nanos."""
    if isinstance(value, bool):
        raise ValueError("boolean is not a timestamp")
    if isinstance(value, (int, float)):
        if not math.isfinite(value):
            raise ValueError("timestamp must be finite")
        seconds = value / 1000 if abs(value) >= 1e11 else value
        return datetime.fromtimestamp(seconds, tz=UTC)
    if not isinstance(value, str):
        raise ValueError("timestamp must be an ISO string or native epoch number")
    if value.lstrip("-").isdigit():
        return _timestamp(int(value))
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        return datetime.combine(date.fromisoformat(value), datetime.min.time(), UTC)
    fraction = re.search(r"[.,](\d+)", value)
    if fraction and len(fraction[1]) > 6:
        raise ValueError("native timestamps do not support nanosecond precision")
    return _aware(datetime.fromisoformat(value.replace("Z", "+00:00")), "timestamp")


def _unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON object key")
        result[key] = value
    return result


def _invalid_constant(value: str) -> Any:
    raise ValueError(f"non-finite JSON constant: {value}")


def _finite_fields(value: Any, keys: Any) -> None:
    """Reject nonfinite numeric coercions only where a kernel consumes numbers.

    Preserve native handling of ordinary malformed/missing values and unrelated
    free text: a prose value saying 'Infinity' is not necessarily numeric data.
    """
    if not isinstance(value, dict):
        return
    for key in keys:
        number = value.get(key)
        if number is None:
            continue
        try:
            converted = float(number)
        except (TypeError, ValueError):
            continue
        if not math.isfinite(converted):
            raise ValueError(f"{key} requires a finite numeric value")


def _fundamental_numbers(data: dict[str, Any]) -> None:
    facts = data.get("company_facts") or data.get("company")
    _finite_fields(facts, ("market_cap", "marketCap", "employee_count", "employeeCount"))
    metrics = data.get("financial_metrics") or data.get("metrics")
    if isinstance(metrics, dict):
        _finite_fields(metrics, [key for key in metrics if key.endswith(("_change", "_growth", "_delta"))])
    earnings = data.get("earnings")
    if isinstance(earnings, list):
        for event in earnings:
            _finite_fields(event, ("surprise_percent", "surprisePercent", "actual_eps", "reported_eps", "eps_actual"))


def freeze_native(value: Any) -> Any:
    """Detach native models/maps/lists; reject cycles and unsupported graphs.

    Values stay native (including float, date and datetime). A MappingProxyType
    alone is insufficient: every nested value is copied and frozen as well.
    """
    active: set[int] = set()

    def visit(item: Any, depth: int) -> Any:
        if depth > MAX_DEPTH:
            raise ValueError("native artifact exceeds maximum depth")
        if item is None or type(item) in (str, bool, int, date):
            return item
        if isinstance(item, datetime):
            return _aware(item, "native datetime")
        if type(item) is float:
            if not math.isfinite(item):
                raise ValueError("native artifacts require finite numbers")
            return item
        identity = id(item)
        if identity in active:
            raise ValueError("cyclic native artifact")
        active.add(identity)
        try:
            if isinstance(item, BaseModel):
                return visit(item.model_dump(mode="python"), depth + 1)
            if isinstance(item, Mapping):
                if any(type(key) is not str for key in item):
                    raise ValueError("native artifact keys must be strings")
                return MappingProxyType({key: visit(child, depth + 1) for key, child in item.items()})
            if isinstance(item, (list, tuple)):
                return tuple(visit(child, depth + 1) for child in item)
            raise ValueError("unsupported native artifact value")
        finally:
            active.remove(identity)

    return visit(value, 0)


@dataclass(frozen=True, slots=True)
class InputArtifact:
    """Exact source JSON bytes and caller-supplied point-in-time metadata.

    observed_at is the snapshot's observation horizon, available_at is when its
    entire contents became knowable. Neither is silently replaced by as_of.
    Future scheduled events are permitted, not future realized observations.
    """

    content: bytes
    expected_sha256: str
    observed_at: datetime
    available_at: datetime

    def __post_init__(self) -> None:
        if type(self.content) is not bytes or not self.content or len(self.content) > MAX_INPUT_BYTES:
            raise ValueError("source content must be nonempty bounded immutable bytes")
        if not isinstance(self.expected_sha256, str) or not re.fullmatch(r"[0-9a-f]{64}", self.expected_sha256):
            raise ValueError("expected source SHA-256 must be lowercase hexadecimal")
        if hashlib.sha256(self.content).hexdigest() != self.expected_sha256:
            raise ValueError("source content digest mismatch")
        observed = _aware(self.observed_at, "observed_at")
        available = _aware(self.available_at, "available_at")
        if observed > available:
            raise ValueError("observation cannot follow availability")
        object.__setattr__(self, "observed_at", observed)
        object.__setattr__(self, "available_at", available)
        # Validate without keeping mutable decoded objects on the frozen receipt.
        freeze_native(self.decode())

    def decode(self) -> Any:
        try:
            return json.loads(self.content.decode("utf-8"), object_pairs_hook=_unique_object,
                              parse_constant=_invalid_constant)
        except (UnicodeError, RecursionError) as error:
            raise ValueError("invalid source JSON encoding or depth") from error


@dataclass(frozen=True, slots=True)
class NativeResearchArtifact:
    """Internal float/microsecond artifact, not a DatasetManifest/TradeIntent."""

    module: str
    as_of: datetime
    input_identity: Mapping[str, Any]
    payload: Mapping[str, Any]
    native_json: bytes
    native_sha256: str
    identity_sha256: str


class ResearchAdapter:
    """Research-only computations on explicit, hash-bound offline snapshots."""

    def __init__(self, *, as_of: datetime) -> None:
        self._as_of = _aware(as_of, "as_of")

    def _input(self, artifact: InputArtifact) -> Any:
        if not isinstance(artifact, InputArtifact):
            raise TypeError("research inputs require InputArtifact")
        if _aware(artifact.available_at, "available_at") > self._as_of:
            raise ValueError("input was not available at reference cutoff")
        payload = artifact.decode()
        self._times(payload, artifact)
        return payload

    def _times(self, value: Any, artifact: InputArtifact, depth: int = 0) -> None:
        if depth > MAX_DEPTH:
            raise ValueError("input exceeds maximum depth")
        if isinstance(value, dict):
            for key, child in value.items():
                if child is not None and key in OBSERVATION_KEYS | AVAILABILITY_KEYS:
                    limit = artifact.available_at if key in AVAILABILITY_KEYS else artifact.observed_at
                    if _timestamp(child) > _aware(limit, key):
                        raise ValueError(f"{key} exceeds declared knowledge horizon")
                self._times(child, artifact, depth + 1)
        elif isinstance(value, list):
            for child in value:
                self._times(child, artifact, depth + 1)

    def _rows(self, artifact: InputArtifact, *, require_time: bool = True) -> list[dict[str, Any]]:
        rows = self._input(artifact)
        if not isinstance(rows, list) or any(not isinstance(row, dict) for row in rows):
            raise ValueError("rows must be a JSON array of objects")
        for row in rows:
            values = [row[key] for key in ("datetime", "timestamp", "date") if row.get(key) is not None]
            if require_time and not values:
                raise ValueError("row requires a timestamp")
            if any(_timestamp(value) > _aware(artifact.observed_at, "observed_at") for value in values):
                raise ValueError("row exceeds declared knowledge horizon")
            numeric_keys = ("open", "high", "low", "close", "volume", "vwap") if require_time else (
                "bid", "bid_price", "ask", "ask_price", "volume", "option_volume",
                "open_interest", "openInterest", "oi",
            )
            _finite_fields(row, numeric_keys)
        return rows

    def _object(self, artifact: InputArtifact) -> dict[str, Any]:
        value = self._input(artifact)
        if not isinstance(value, dict):
            raise ValueError("snapshot must be a JSON object")
        return value

    def _result(self, module: str, model: BaseModel, inputs: Mapping[str, InputArtifact | None]) -> NativeResearchArtifact:
        payload = freeze_native(model)
        native_json = canonical_artifact_json(model).encode("utf-8")
        digest = hashlib.sha256(native_json).hexdigest()
        identity = {
            name: {
                "source_sha256": item.expected_sha256,
                "observed_at": item.observed_at,
                "available_at": item.available_at,
            }
            for name, item in inputs.items() if item is not None
        }
        envelope = {"module": module, "as_of": self._as_of, "inputs": identity, "native_sha256": digest}
        return NativeResearchArtifact(module, self._as_of, freeze_native(identity), payload,
                                      native_json, digest,
                                      hashlib.sha256(canonical_artifact_json(envelope).encode("utf-8")).hexdigest())

    def momentum(self, *, ticker: str, rows: InputArtifact, spy_rows: InputArtifact | None = None,
                 qqq_rows: InputArtifact | None = None) -> NativeResearchArtifact:
        model = MomentumFeatures().compute(ticker=ticker, rows=self._rows(rows),
            spy_rows=self._rows(spy_rows) if spy_rows is not None else None,
            qqq_rows=self._rows(qqq_rows) if qqq_rows is not None else None)
        return self._result("momentum", model, {"rows": rows, "spy_rows": spy_rows, "qqq_rows": qqq_rows})

    def market_structure(self, *, ticker: str, rows: InputArtifact,
                         timeframe: str = "1d") -> NativeResearchArtifact:
        model = MarketStructureFeatures().compute(ticker=ticker, rows=self._rows(rows), timeframe=timeframe)
        return self._result("market_structure", model, {"rows": rows})

    def volatility(self, *, ticker: str, payload: InputArtifact) -> NativeResearchArtifact:
        data = self._object(payload)
        _finite_fields(data, (
            "front_iv", "frontMonthIv", "near_term_iv", "back_iv", "backMonthIv", "long_term_iv",
            "iv_change", "ivChange", "iv_change_pct", "iv_rank", "ivRank", "iv_percentile", "ivPercentile",
            "call_skew", "callSkew", "put_skew", "putSkew",
        ))
        has_time = any(data.get(key) is not None for key in ("as_of", "timestamp", "date"))
        for key in ("as_of", "timestamp", "date"):
            if data.get(key) is not None:
                _timestamp(data[key])  # reject unsupported precision/naive intraday strings
                # Volatility treats digit-only strings as compact ISO, unlike
                # OHLCV epoch-string parsing. Check the actual consumer semantics.
                if _volatility_time(data[key]) > payload.observed_at:
                    raise ValueError(f"volatility {key} exceeds declared knowledge horizon")
        model = VolatilityFeatures().compute(ticker=ticker, payload=data,
            as_of=None if has_time else payload.observed_at)
        if _aware(model.as_of, "volatility as_of") > payload.observed_at:
            raise ValueError("volatility result exceeds declared knowledge horizon")
        return self._result("volatility", model, {"payload": payload})

    def liquidity(self, *, ticker: str, stock_rows: InputArtifact | None = None,
                  option_chain: InputArtifact | None = None,
                  option_totals: InputArtifact | None = None) -> NativeResearchArtifact:
        inputs = {"stock_rows": stock_rows, "option_chain": option_chain, "option_totals": option_totals}
        supplied = [item for item in inputs.values() if item is not None]
        if not supplied:
            raise ValueError("liquidity requires at least one observed input")
        totals = self._object(option_totals) if option_totals is not None else None
        _finite_fields(totals, ("volume", "open_interest"))
        model = LiquidityFeatures().compute(ticker=ticker,
            stock_rows=self._rows(stock_rows) if stock_rows is not None else None,
            option_chain=self._rows(option_chain, require_time=False) if option_chain is not None else None,
            option_totals=totals,
            as_of=max(_aware(item.observed_at, "observed_at") for item in supplied))
        return self._result("liquidity", model, inputs)

    def fundamental_catalyst(self, *, ticker: str, payload: InputArtifact) -> NativeResearchArtifact:
        data = self._input(payload)
        if data is not None and not isinstance(data, dict):
            raise ValueError("fundamental payload must be a JSON object or null")
        _fundamental_numbers(data or {})
        self._earnings(data or {}, payload.observed_at)
        model = FundamentalCatalystFeatures().compute(ticker=ticker, payload=data)
        return self._result("fundamental_catalyst", model, {"payload": payload})

    @staticmethod
    def _earnings(data: dict[str, Any], observed_at: datetime) -> None:
        for event in data.get("earnings") or []:
            if not isinstance(event, dict):
                continue
            event_date = event.get("date") or event.get("report_date")
            realized_keys = {"surprise_percent", "surprisePercent", "actual_eps", "reported_eps", "eps_actual"}
            if event_date and any(event.get(key) is not None for key in realized_keys):
                text = str(event_date)
                horizon = _aware(observed_at, "observed_at")
                if re.fullmatch(r"\d{4}-\d{2}-\d{2}|\d{8}", text):
                    future = date.fromisoformat(text) > horizon.date()
                else:
                    # Keep the full supplied intraday instant and offset. Only
                    # date-only events use the caller's whole-snapshot envelope.
                    future = _timestamp(text) > horizon
                if future:
                    raise ValueError("future earnings outcome is not observable")

    def option_flow(self, snapshot: InputArtifact) -> NativeResearchArtifact:
        model = OptionFlowSnapshot.model_validate(self._object(snapshot))
        freeze_native(model)  # check coerced numeric fields before source computation
        return self._result("option_flow", OptionFlowFeatures().compute(model), {"snapshot": snapshot})

    def identify_setup(self, *, candidate: InputArtifact, research_brief: InputArtifact,
                       flow_snapshot: InputArtifact | None, market_structure: InputArtifact | None,
                       volatility: InputArtifact | None, liquidity: InputArtifact | None = None,
                       fundamental_catalyst: InputArtifact | None = None,
                       market_regime: InputArtifact | None = None) -> NativeResearchArtifact:
        inputs = {"candidate": candidate, "research_brief": research_brief,
                  "flow_snapshot": flow_snapshot, "market_structure": market_structure,
                  "volatility": volatility, "liquidity": liquidity,
                  "fundamental_catalyst": fundamental_catalyst, "market_regime": market_regime}
        types = {"candidate": CandidateCompany, "research_brief": ResearchBrief,
                 "flow_snapshot": OptionFlowSnapshot, "market_structure": MarketStructureSnapshot,
                 "volatility": VolatilitySnapshot, "liquidity": LiquidityFeatureSnapshot,
                 "fundamental_catalyst": FundamentalCatalystFeatureSnapshot, "market_regime": MarketRegime}
        models = {name: types[name].model_validate(self._object(item)) if item is not None else None
                  for name, item in inputs.items()}
        for model in models.values():
            if model is not None:
                freeze_native(model)  # typed numeric strings may coerce to NaN/Infinity
        ticker = models["candidate"].ticker.upper()
        for model in models.values():
            if model is not None and hasattr(model, "ticker") and model.ticker.upper() != ticker:
                raise ValueError("setup inputs must share the candidate ticker")
        flow = models["flow_snapshot"]
        if flow is not None and any(contract.underlying.upper() != ticker for contract in flow.notable_contracts):
            raise ValueError("flow contract underlying does not match candidate")
        fundamental = models["fundamental_catalyst"]
        if fundamental is not None:
            _fundamental_numbers(fundamental.raw)
            self._earnings(fundamental.raw, fundamental_catalyst.observed_at)
        model = SetupEngine().identify_setup(**models, as_of=self._as_of)
        return self._result("setup", model, inputs)
