"""Provider-neutral exact market values. Public schema authority is injected, never cloned."""
from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
from typing import Any, Protocol

from providers.boundary import Boundary, BoundaryError, authorize, epoch_ns, exact_decimal, identifier, parse_json, raw_sha256
from providers.ports import Clock, ProviderCapture, RightRequest, RightsPort, Unavailable, ValidatedRecord
from providers.quantdata import canonical_bar, rows_from_data


@dataclass(frozen=True)
class SourceContext:
    instrument_id: str
    currency: str
    calendar: str
    provider_timezone: str
    snapshot_id: str
    source_id: str
    as_of_at: str
    vintage_id: str | None
    maximum_age_ms: int
    price_unit: str
    quantity_unit: str
    adjustment_method: str
    data_kind: str = "real"
    synthetic_reason: str | None = None


@dataclass(frozen=True)
class BarWindow:
    start_at: str
    end_at: str
    observed_at: str
    interval: str


class CalendarPort(Protocol):
    """Resolve provider bar timestamp with explicit calendar/session/version semantics.

    Never implement end-of-session via UTC-midnight arithmetic. Must reject unknown
    timezones, DST ambiguity, partial bars and unproven provider interval conventions.
    """
    def bar_window(self, *, provider: str, row: dict[str, Any], calendar: str, interval: str, as_of_at: str) -> BarWindow: ...


@dataclass(frozen=True)
class FieldSemantics:
    # Must be explicitly supplied by a source-backed adapter, not by the provider document.
    timestamp: str
    price: str
    quantity: str
    source_reference: str
    side: str | None = None
    buy_value: str | None = None
    sell_value: str | None = None


def _quantity_units(value: str) -> int:
    whole, _, fraction = exact_decimal(value, nonnegative=True).partition(".")
    return int(whole) * 10 ** 18 + int(fraction.ljust(18, "0"))


def _quantity_decimal(value: int) -> str:
    whole, fraction = divmod(value, 10 ** 18)
    return exact_decimal(str(whole) + "." + str(fraction).rjust(18, "0"))


class MarketNormalizer:
    def __init__(self, *, boundary: Boundary, clock: Clock, rights: RightsPort | None, calendar: CalendarPort | None):
        self.boundary, self.clock, self.rights, self.calendar = boundary, clock, rights, calendar

    def _capture_payload(self, capture: ProviderCapture) -> dict[str, Any]:
        self.boundary.require()
        if raw_sha256(capture.content.data) != capture.content.digest:
            raise BoundaryError("provider-capture-digest-mismatch")
        payload = parse_json(capture.content.data, maximum_bytes=16_000_000, maximum_nodes=1_000_000)
        if not isinstance(payload, dict) or self.boundary.encode(payload) != capture.normalized_json:
            raise BoundaryError("provider-normalized-content-mismatch")
        return payload

    def _assert_row_present(self, capture: ProviderCapture, row: dict[str, Any]) -> None:
        payload = self._capture_payload(capture)
        target = self.boundary.encode(row)
        pending = [payload]
        while pending:
            value = pending.pop()
            if isinstance(value, dict):
                if self.boundary.encode(value) == target:
                    return
                pending.extend(value.values())
            elif isinstance(value, list):
                pending.extend(value)
        raise BoundaryError("normalized-row-not-in-source")

    def _source(self, capture: ProviderCapture, context: SourceContext, observed_at: str) -> dict[str, Any]:
        for value in (context.instrument_id, context.calendar, context.snapshot_id, context.source_id):
            identifier(value)
        if context.price_unit != context.currency or context.quantity_unit not in ("shares", "contracts", "base-asset"):
            raise BoundaryError("explicit-units-required")
        if context.data_kind not in ("real", "synthetic") or (context.data_kind == "synthetic") != (context.synthetic_reason is not None):
            raise BoundaryError("invalid-synthetic-label")
        if type(context.maximum_age_ms) is not int or not 0 <= context.maximum_age_ms <= 9_007_199_254_740_991:
            raise BoundaryError("invalid-freshness-policy")
        if context.adjustment_method not in ("unadjusted", "split-adjusted", "total-return", "provider-defined"):
            raise BoundaryError("adjustment-semantics-unavailable")
        if context.vintage_id is not None:
            identifier(context.vintage_id)
        now = self.clock.now()
        if not epoch_ns(observed_at) <= epoch_ns(context.as_of_at) <= epoch_ns(capture.received_at) <= epoch_ns(now):
            raise BoundaryError("future-or-inconsistent-observation")
        decision = authorize(self.rights, RightRequest(capture.provider, capture.rights.policy_id, capture.operation, now))
        age = epoch_ns(now) - epoch_ns(observed_at)
        source = {"identity": {"provider": capture.provider, "sourceId": context.source_id, "snapshotId": context.snapshot_id,
                               "contentHash": capture.content.digest},
                  "dataKind": context.data_kind, "syntheticReason": context.synthetic_reason, "providerTimezone": context.provider_timezone,
                  "entitlement": {"policyId": decision.policy_id, "status": "granted", "checkedAt": now, "expiresAt": decision.expires_at},
                  "freshness": {"status": "fresh" if age <= context.maximum_age_ms * 1_000_000 else "stale", "observedAt": observed_at,
                                "evaluatedAt": now, "maxAgeMs": context.maximum_age_ms}}
        self.boundary.record("MarketDataSource", source)
        return source

    def candles(self, capture: ProviderCapture, rows: list[dict[str, Any]], context: SourceContext, *, interval: str) -> tuple[ValidatedRecord, ...] | Unavailable:
        try:
            self.boundary.require()
            if self.calendar is None:
                raise BoundaryError("exchange-calendar-unavailable")
            if capture.operation != "equity-bars" or capture.provider not in ("financialdatasets", "quantdata"):
                raise BoundaryError("unsupported-bar-source")
            if not rows or len(rows) > 10_000:
                raise BoundaryError("bar-row-budget-or-unavailable")
            payload = self._capture_payload(capture)
            actual = ([canonical_bar(row) for row in rows_from_data(payload.get("data"), 10_000)]
                      if capture.provider == "quantdata" else payload.get("prices"))
            if self.boundary.encode(rows) != self.boundary.encode(actual):
                raise BoundaryError("bar-rows-not-bound-to-capture")
            result = []
            seen: set[str] = set()
            previous_end: int | None = None
            for ordinal, raw_row in enumerate(rows):
                row = canonical_bar(raw_row) if capture.provider == "quantdata" else dict(raw_row)
                if any(row.get(field) is None for field in ("open", "high", "low", "close", "volume")):
                    raise BoundaryError("missing-ohlcv-field")
                window = self.calendar.bar_window(provider=capture.provider, row=row, calendar=context.calendar, interval=interval, as_of_at=context.as_of_at)
                if (window.interval != interval or epoch_ns(window.start_at) >= epoch_ns(window.end_at)
                        or epoch_ns(window.end_at) > epoch_ns(window.observed_at) or epoch_ns(window.observed_at) > epoch_ns(context.as_of_at)):
                    raise BoundaryError("partial-future-or-invalid-bar")
                start = epoch_ns(window.start_at)
                if window.start_at in seen or (previous_end is not None and start < previous_end):
                    raise BoundaryError("duplicate-overlapping-or-unsorted-bars")
                seen.add(window.start_at)
                previous_end = epoch_ns(window.end_at)
                source = self._source(capture, context, window.observed_at)
                values = {field: exact_decimal(row[field], nonnegative=True) for field in ("open", "high", "low", "close", "volume")}
                identity = raw_sha256(self.boundary.encode([capture.provider, context.snapshot_id, context.source_id, context.instrument_id, window.start_at, interval, ordinal]))
                value = {"schemaVersion": "1.0.0", "instrumentId": context.instrument_id, "currency": context.currency, "source": source,
                         "candleId": "candle:" + identity, "startAtInclusive": window.start_at, "endAtExclusive": window.end_at,
                         "interval": interval, **values}
                result.append(self.boundary.record("Candle", value))
            return tuple(result)
        except BoundaryError as error:
            return Unavailable(str(error), context.source_id, "No partially normalized batch is published; missing OHLCV is never zero-filled.")
        except Exception:
            return Unavailable("normalizer-dependency-unavailable", context.source_id, "Calendar, rights or authoritative validator rejected the batch.")

    def quote(self, capture: ProviderCapture, row: dict[str, Any], context: SourceContext, *, fields: dict[str, str], source_reference: str) -> ValidatedRecord | Unavailable:
        try:
            self._assert_row_present(capture, row)
            if not source_reference or set(fields) != {"bid", "ask", "bidSize", "askSize", "lastPrice", "sourceTimestamp"}:
                raise BoundaryError("quote-field-semantics-unavailable")
            required = ("bid", "ask", "bidSize", "askSize", "sourceTimestamp")
            if any(row.get(fields[key]) is None for key in required):
                raise BoundaryError("quote-bid-ask-size-unavailable")
            timestamp = row[fields["sourceTimestamp"]]
            source = self._source(capture, context, timestamp)
            values = {key: exact_decimal(row[fields[key]], nonnegative=True) for key in ("bid", "ask", "bidSize", "askSize")}
            last = row.get(fields["lastPrice"])
            value = {"schemaVersion": "1.0.0", "instrumentId": context.instrument_id, "currency": context.currency, "source": source,
                     "quoteId": "quote:" + raw_sha256(self.boundary.encode([capture.provider, context.snapshot_id, context.source_id, context.instrument_id, timestamp, row])),
                     "sourceTimestamp": timestamp, "receivedAt": capture.received_at, "lastPrice": None if last is None else exact_decimal(last, nonnegative=True), **values}
            return self.boundary.record("Quote", value)
        except BoundaryError as error:
            return Unavailable(str(error), context.source_id, "No quote is fabricated from a last trade or aggregate analytics.")
        except Exception:
            return Unavailable("normalizer-dependency-unavailable", context.source_id, "The quote was not accepted by all explicit ports.")

    def trade_flow(self, capture: ProviderCapture, row: dict[str, Any], context: SourceContext, semantics: FieldSemantics) -> ValidatedRecord | Unavailable:
        try:
            self._assert_row_present(capture, row)
            if not semantics.source_reference or row.get(semantics.timestamp) is None:
                raise BoundaryError("trade-semantics-unavailable")
            timestamp = row[semantics.timestamp]
            side = row.get(semantics.side) if semantics.side is not None else None
            aggressor = "unknown"
            if semantics.side is not None:
                if not semantics.buy_value or not semantics.sell_value or semantics.buy_value == semantics.sell_value:
                    raise BoundaryError("side-semantics-unavailable")
                aggressor = "buy" if side == semantics.buy_value else "sell" if side == semantics.sell_value else "unknown"
            value = {"schemaVersion": "1.0.0", "instrumentId": context.instrument_id, "currency": context.currency,
                     "source": self._source(capture, context, timestamp),
                     "flowId": "flow:" + raw_sha256(self.boundary.encode([capture.provider, context.snapshot_id, context.source_id, context.instrument_id, row])),
                     "sourceTimestamp": timestamp, "receivedAt": capture.received_at, "price": exact_decimal(row.get(semantics.price), nonnegative=True),
                     "quantity": exact_decimal(row.get(semantics.quantity), nonnegative=True), "aggressor": aggressor}
            return self.boundary.record("TradeFlow", value)
        except BoundaryError as error:
            return Unavailable(str(error), context.source_id, "Aggregate option premium/volume is not a trade event; unknown side remains unknown.")
        except Exception:
            return Unavailable("normalizer-dependency-unavailable", context.source_id, "The trade was not accepted by all explicit ports.")

    def volume_profile(self, trades: tuple[ValidatedRecord, ...], context: SourceContext, *, profile_id: str, start_at: str, end_at: str,
                       bins: tuple[tuple[str, str], ...]) -> ValidatedRecord | Unavailable:
        try:
            if not trades or len(trades) > 100_000 or not 1 <= len(bins) <= 10_000:
                raise BoundaryError("profile-input-budget")
            bounds = [(Decimal(exact_decimal(low, nonnegative=True)), Decimal(exact_decimal(high, nonnegative=True))) for low, high in bins]
            if any(low >= high or (index and bounds[index - 1][1] > low) for index, (low, high) in enumerate(bounds)):
                raise BoundaryError("profile-overlapping-bins")
            totals = [[0, 0, 0] for _ in bounds]
            source = None
            seen = set()
            for trade in trades:
                value = self.boundary.recheck(trade)
                if trade.contract_name != "TradeFlow" or value["instrumentId"] != context.instrument_id or value["currency"] != context.currency:
                    raise BoundaryError("profile-instrument-mismatch")
                if value["flowId"] in seen:
                    raise BoundaryError("profile-duplicate-trade")
                seen.add(value["flowId"])
                if not epoch_ns(start_at) <= epoch_ns(value["sourceTimestamp"]) < epoch_ns(end_at):
                    raise BoundaryError("profile-trade-outside-window")
                if source is None:
                    source = value["source"]
                elif value["source"]["identity"] != source["identity"]:
                    raise BoundaryError("profile-mixed-source-snapshots")
                price, quantity = Decimal(value["price"]), _quantity_units(value["quantity"])
                matching = [index for index, (low, high) in enumerate(bounds) if low <= price < high]
                if len(matching) != 1:
                    raise BoundaryError("profile-uncovered-trade")
                totals[matching[0]][{"buy": 0, "sell": 1, "unknown": 2}[value["aggressor"]]] += quantity
            now = self.clock.now()
            decision = authorize(self.rights, RightRequest(source["identity"]["provider"], source["entitlement"]["policyId"], "volume-profile", now))
            source["entitlement"] = {"policyId": decision.policy_id, "status": "granted", "checkedAt": now, "expiresAt": decision.expires_at}
            observed = source["freshness"]["observedAt"]
            source["freshness"] = {"status": "fresh" if epoch_ns(now) - epoch_ns(observed) <= context.maximum_age_ms * 1_000_000 else "stale",
                                   "observedAt": observed, "evaluatedAt": now, "maxAgeMs": context.maximum_age_ms}
            rows = [{"lowerPriceInclusive": exact_decimal(low), "upperPriceExclusive": exact_decimal(high),
                     "buyVolume": _quantity_decimal(totals[index][0]), "sellVolume": _quantity_decimal(totals[index][1]), "unknownVolume": _quantity_decimal(totals[index][2])}
                    for index, (low, high) in enumerate(bounds)]
            return self.boundary.record("VolumeProfile", {"schemaVersion": "1.0.0", "instrumentId": context.instrument_id, "currency": context.currency,
                "source": source, "profileId": identifier(profile_id), "startAtInclusive": start_at, "endAtExclusive": end_at, "bins": rows})
        except BoundaryError as error:
            return Unavailable(str(error), context.source_id, "Only actual individually evidenced trades form this volume profile.")
        except Exception:
            return Unavailable("profile-dependency-unavailable", context.source_id, "Profile could not be derived under explicit source/rights semantics.")
