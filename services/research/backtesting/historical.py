"""Closed retrospective Bar study, separate from strict PIT/OOS planning.

Original capture/manifest bytes remain immutable. Interpretation is independently
reviewed, versioned private data; it never upgrades the capture's unavailable
vintage, unknown coverage or null calendar. No ports are opened by this module.
"""
from __future__ import annotations

import base64
import hashlib
import math
import re
import struct
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from decimal import Decimal
from fractions import Fraction
from typing import Any
from zoneinfo import ZoneInfo

from .lineage import Pin, time_ns, timestamp
from .planner import BacktestCompletion, BacktestPlan
from .ports import PortUnavailable, decode_json, require_hash, require_id, utc

RECIPE = "vertex-host-backtest-recipe-v3"
CONTENT = "vertex-ibkr-historical-bars-v1"
INTERPRETATION = "vertex-historical-bar-interpretation-v1"
RESULT = "vertex-historical-bar-results-v1"
CLASS = "limited-retrospective-adjusted-bar-simulation-nonpromotion"
ENGINE_ID = "vertex-nautilus-historical-bar-research"
ENGINE_VERSION = "1.0.0"
MODELED = ("commission", "slippage", "bar-path", "bar-volume", "replay-availability", "adjusted-share-basis")
RESTRICTIONS = (
    "historical-vintage-unavailable", "point-in-time-unavailable", "market-coverage-unqualified",
    "survivorship-unqualified", "corporate-action-cash-accounting-unavailable",
    "independent-oos-unavailable", "modeled-liquidity-not-observed-executable-pnl",
    "retrospective-result-not-promotion-evidence",
)
ASSUMPTIONS = {
    "format": "vertex-rc5-adjusted-bar-round-trip-assumptions-v1",
    "barExecution": "rc5-external-LAST-L1_MBP",
    "path": "native-O-H-L-C-adaptive-disabled",
    "decisionTiming": "on_bar-after-current-bar-path-native-command-drain",
    "fill": "native-FOK-market-default-limit-probability-1-slippage-probability-0-seed-0",
    "fee": "reviewed-fixed-USD-per-fill-charge-each-fill",
    "slippage": "explicit-zero-additional-slippage-not-calibrated",
    "volume": "rc5-BarTickSizes-quarter-remainder-instrument-increments-liquidity-consumption",
    "participation": "reviewed-source-bar-volume-cap-before-FOK-not-path-liquidity",
    "latency": "explicit-native-static-zero-base-insert-update-cancel-nanoseconds",
    "ledgerPrecision": "whole-adjusted-share-units-USD-cent-native-prices-and-fees",
    "shareBasis": "fixed-hypothetical-retrieval-adjusted-share-units-no-old-share-cash-accounting",
    "adjustments": "provider-retrieval-adjustment-not-PIT-not-total-return",
    "coverage": "preserve-nonobserved-gaps-no-completeness-inference",
    "revisions": "originals-retained-overlapping-or-reordered-replay-unavailable",
}


class HistoricalUnavailable(ValueError):
    """A precise private reason, not a scientific rejection of the original."""


def need(condition: bool, reason: str) -> None:
    if not condition:
        raise HistoricalUnavailable(reason)


def exact(value: Any, keys: set[str], reason: str) -> dict:
    need(type(value) is dict and set(value) == keys, reason)
    return value


def ns(value: Any) -> int:
    need(type(value) is str and re.fullmatch(r"(?:0|[1-9][0-9]{0,19})", value) is not None,
         "historical-canonical-nanosecond-string-required")
    result = int(value)
    need(0 <= result < 2**64, "historical-nanosecond-range")
    return result


def sha(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def embedded(value: Any, maximum: int) -> bytes:
    exact(value, {"bytesBase64", "sha256"}, "historical-original-embedded-shape")
    require_hash(value["sha256"])
    need(type(value["bytesBase64"]) is str and len(value["bytesBase64"]) <= (maximum + 2) // 3 * 4,
         "historical-embedded-byte-bound")
    try:
        raw = base64.b64decode(value["bytesBase64"], validate=True)
    except (ValueError, TypeError):
        raise HistoricalUnavailable("historical-original-base64-invalid") from None
    need(0 < len(raw) <= maximum and sha(raw) == value["sha256"]
         and base64.b64encode(raw).decode("ascii") == value["bytesBase64"],
         "historical-original-embedded-digest")
    return raw


def canonical(authority: Any, raw: bytes, maximum: int) -> Any:
    need(type(raw) is bytes and 0 < len(raw) <= maximum, "historical-canonical-byte-bound")
    value = decode_json(raw)
    need(authority.encode(value) == raw and authority.digest(value) == sha(raw),
         "historical-original-canonical-bytes-required")
    return value


@dataclass(frozen=True)
class HistoricalBarInput:
    manifest_bytes: bytes
    content_bytes: bytes
    content_format: str
    declared_events: int
    capture_bytes: bytes
    producer_job_id: str

    def __post_init__(self) -> None:
        need(all(type(v) is bytes for v in (self.manifest_bytes, self.content_bytes, self.capture_bytes)),
             "historical-immutable-original-bytes-required")
        need(self.content_format == CONTENT and type(self.declared_events) is int
             and 1 <= self.declared_events <= 5000, "historical-input-format-or-count")
        require_id(self.producer_job_id)


@dataclass(frozen=True)
class HistoricalBarLineage:
    strategy_version_id: str
    code_pin: Pin
    engine_pin: Pin
    model_digest: str
    interpretation_digest: str
    review_pins_bytes: bytes

    def __post_init__(self) -> None:
        require_id(self.strategy_version_id)
        require_hash(self.model_digest)
        require_hash(self.interpretation_digest)
        need(type(self.review_pins_bytes) is bytes and 0 < len(self.review_pins_bytes) <= 262144,
             "historical-current-review-pins-required")

    def record(self) -> dict:
        return {"format": "vertex-historical-bar-lineage-inputs-v1", "researchClass": CLASS,
                "strategyVersionId": self.strategy_version_id, "codePin": asdict(self.code_pin),
                "enginePin": asdict(self.engine_pin), "modelDigest": self.model_digest,
                "interpretationDigest": self.interpretation_digest,
                "reviewPins": decode_json(self.review_pins_bytes), "promotionEligible": False}


def scientific_core(model: Any) -> dict:
    """No circular review identity: all scientific parameters, not review/template."""
    body = model.record()
    return {"format": "vertex-historical-bar-scientific-core-v1",
            **{key: value for key, value in body.items()
               if key not in {"review_digest", "evidence_template_bytes", "native_configuration_bytes"}},
            "nativeConfigurationSha256": sha(model.native_configuration_bytes)}


def interpretation(authority: Any, model: Any, maximum: int) -> tuple[dict, dict, bytes, bytes]:
    config = canonical(authority, model.native_configuration_bytes, min(maximum, 1048576))
    exact(config, {"format", "distribution", "instrument", "issuedNs", "expiresNs", "interpretation"},
          "historical-native-configuration-shape")
    need(config["format"] == "vertex-nautilus-historical-bars-v1", "historical-native-configuration-version")
    raw = embedded(config["interpretation"], maximum)
    value = canonical(authority, raw, maximum)
    exact(value, {"format", "manifestSha256", "contentSha256", "captureSha256", "requestSha256",
                  "qualificationSha256", "calendar", "instrumentId", "interval", "labelConvention",
                  "numericTransform", "availability", "assumptions"}, "historical-interpretation-shape")
    need(value["format"] == INTERPRETATION, "historical-interpretation-version")
    for key in ("manifestSha256", "contentSha256", "captureSha256", "requestSha256", "qualificationSha256"):
        require_hash(value[key])
    need(value["assumptions"] == ASSUMPTIONS, "historical-explicit-native-assumptions-required")
    calendar_raw = embedded(value["calendar"], maximum)
    calendar = canonical(authority, calendar_raw, maximum)
    return value, calendar, raw, calendar_raw


def transformed(bits: Any, scale: dict, precision: int, *, volume: bool) -> dict:
    """Decode IEEE bits exactly; rational scaling + explicit half-even rounding.

    Source bits are never replaced by a rounded decimal or a float JSON number.
    Rational pre-rounding values and whether conversion changed them survive in
    each modeled field. No missing/negative volume is replaced with zero.
    """
    need(type(bits) is str and re.fullmatch(r"[0-9a-f]{16}", bits) is not None,
         "historical-f64-source-bits-invalid")
    floating = struct.unpack(">d", bytes.fromhex(bits))[0]
    need(math.isfinite(floating) and (floating >= 0 if volume else floating > 0),
         "historical-observed-volume-unavailable" if volume else "historical-positive-finite-price-unavailable")
    # Reject a negative zero sentinel as unqualified rather than erase its sign.
    need(not (volume and bits == "8000000000000000"), "historical-negative-zero-volume-unqualified")
    exact(scale, {"numerator", "denominator"}, "historical-numeric-scale-shape")
    for part in scale.values():
        need(type(part) is str and re.fullmatch(r"[1-9][0-9]{0,11}", part) is not None,
             "historical-positive-rational-scale-required")
    number = Fraction.from_float(floating) * Fraction(int(scale["numerator"]), int(scale["denominator"]))
    need(type(precision) is int and 0 <= precision <= 9 and number <= 10**12,
         "historical-native-precision-or-magnitude-unavailable")
    numerator = number.numerator * 10**precision
    units, remainder = divmod(numerator, number.denominator)
    if 2 * remainder > number.denominator or (2 * remainder == number.denominator and units % 2):
        units += 1
    need(volume or units > 0, "historical-rounded-positive-price-unavailable")
    whole, fraction = divmod(units, 10**precision)
    text = str(whole) + (("." + str(fraction).zfill(precision)) if precision else "")
    return {"sourceF64Bits": bits, "modeledDecimal": text,
            "scaledExactNumerator": str(number.numerator), "scaledExactDenominator": str(number.denominator),
            "roundingChanged": Fraction(units, 10**precision) != number}


def qualify(source: HistoricalBarInput, authority: Any, model: Any, maximum: int) -> tuple[list[dict], dict]:
    """Reconstruct original root/capture/rows/contracts BEFORE modeling anything."""
    from providers.ibkr_history import HistoricalCapture, HistoricalRequest, MEDIA_TYPE

    manifest = canonical(authority, source.manifest_bytes, maximum)
    content = canonical(authority, source.content_bytes, maximum)
    rules, calendar, rules_raw, calendar_raw = interpretation(authority, model, maximum)
    need(authority.validate("DatasetManifest", manifest, schema_version="1.0.0") is True,
         "historical-original-manifest-invalid")
    need((rules["manifestSha256"], rules["contentSha256"], rules["captureSha256"])
         == (sha(source.manifest_bytes), sha(source.content_bytes), sha(source.capture_bytes)),
         "historical-original-root-pins-mismatch")
    request_ref = exact(content.get("request"), {"artifactId", "sha256", "bytesBase64"},
                        "historical-original-request-binding")
    request_raw = embedded({"bytesBase64": request_ref["bytesBase64"], "sha256": request_ref["sha256"]}, 8192)
    request = HistoricalRequest(request_raw)
    capture = HistoricalCapture.bind(source.capture_bytes, request).decode()
    need(request.sha256 == rules["requestSha256"] and capture["request"]["kind"]["type"] == "bars",
         "historical-original-bars-request-required")
    need(capture["source_response_complete"] and capture["capture_complete"] and capture["data_valid"],
         "historical-incomplete-capture-unavailable")
    qualified = capture["qualified_contract"]
    contract, units = qualified["decoded_contract"], qualified["semantics"]
    qualification = qualified["qualification_capture"]
    need(qualification["sha256"] == rules["qualificationSha256"], "historical-original-contract-pin-mismatch")
    source_id = "ibkr-conid-" + str(contract["contract_id"])
    identity = {"provider": "ibkr", "sourceId": source_id, "snapshotId": "ibkr-capture-" + sha(source.capture_bytes),
                "contentHash": sha(source.capture_bytes)}
    kind = capture["request"]["kind"]
    adjustment = "split-adjusted-not-dividend-adjusted" if kind["what_to_show"] == "TRADES" else "split-and-dividend-adjusted"
    effective = {"type": "bars", "what_to_show": kind["what_to_show"], "bar_size": kind["bar_size"],
                 "duration": f"{kind['duration_days']} D", "end_unix_seconds": kind["end_unix_seconds"],
                 "use_rth": kind["use_rth"], "format_date": 2, "keep_up_to_date": False,
                 "adjustment": adjustment,
                 "end_semantics": "explicit-UTC-second" if kind["end_unix_seconds"] is not None else "provider-now-single-request"}
    need(capture["effective_request"] == effective, "historical-original-effective-request-mismatch")
    semantics = {"profile": CONTENT, "intervalSemantics": "provider-terminal-window-not-certified-market-coverage",
                 "marketCoverage": "unqualified", "calendarQualification": "unqualified", "pointInTime": False,
                 "researchAdmission": "unqualified", "rowSemantics": "sdk-decoded-bar-bits-v1", "adjustment": adjustment}
    bindings = [{"ordinal": i, "captureJsonPointer": f"/records/{i}", "rowSha256": authority.digest(row)}
                for i, row in enumerate(capture["records"])]
    expected_content = {"profile": CONTENT, "source": identity, "instrumentId": source_id,
        "capture": {"artifactId": "blob-" + identity["contentHash"], "sha256": identity["contentHash"], "mediaType": MEDIA_TYPE},
        "request": {"artifactId": "ibkr-history-intent-" + authority.digest({"jobId": source.producer_job_id, "requestSha256": request.sha256}),
                    "sha256": request.sha256, "bytesBase64": base64.b64encode(request_raw).decode("ascii")},
        "records": capture["records"], "rowBindings": bindings, "acquisition": capture["acquisition"],
        "qualifiedContractPointer": "/qualified_contract", "effectiveRequestPointer": "/effective_request",
        "providerWindowPointer": "/provider_window", "semantics": semantics,
        "snapshotIdentitySemantics": "vertex-capture-sha256-not-provider-snapshot",
        "availabilitySemantics": "actual-later-acquisition-not-historical-arrival",
        "numericSemantics": "unchanged-sdk-ieee754-bits-no-volume-or-price-unit-conversion",
        "orderingSemantics": "sdk-decoded-receive-order-not-exchange-tie-order", "limitations": capture["limitations"]}
    need(authority.encode(expected_content) == source.content_bytes, "historical-root-capture-row-reconstruction-mismatch")
    window = capture["provider_window"]
    exact(window, {"start", "end"}, "historical-original-terminal-window-required")
    for instant in window.values():
        exact(instant, {"unix_ns", "offset_seconds"}, "historical-original-terminal-shape")
        need(type(instant["offset_seconds"]) is int and -86399 <= instant["offset_seconds"] <= 86399,
             "historical-original-terminal-offset")
    acquisition = exact(capture["acquisition"], {"started_unix_ns", "finished_unix_ns", "elapsed_monotonic_ns"},
                        "historical-original-acquisition-shape")
    started, finished = ns(acquisition["started_unix_ns"]), ns(acquisition["finished_unix_ns"])
    ns(acquisition["elapsed_monotonic_ns"])
    need(0 < ns(qualification["observed_unix_ns"]) <= started <= finished <= time_ns(manifest["captureTime"])
         and ns(window["start"]["unix_ns"]) < ns(window["end"]["unix_ns"]) <= finished,
         "historical-original-acquisition-chronology")
    need(manifest["provider"] == "ibkr" and manifest["sources"] == [identity]
         and manifest["instrumentUniverse"] == [source_id] and manifest["contentHash"] == sha(source.content_bytes)
         and manifest["historicalSemantics"] == semantics and manifest["calendar"] is None
         and manifest["dataVintageId"] is None and manifest["dataVintageStatus"] == "unavailable"
         and manifest["gammaProvenance"] is None and time_ns(manifest["asOfAt"]) == finished
         and time_ns(manifest["startAtInclusive"]) == ns(window["start"]["unix_ns"])
         and time_ns(manifest["endAtExclusive"]) == ns(window["end"]["unix_ns"])
         and manifest["adjustmentMethod"] == ("split-adjusted" if kind["what_to_show"] == "TRADES" else "provider-defined"),
         "historical-original-manifest-semantics-mismatch")
    if kind["end_unix_seconds"] is not None:
        need(ns(window["end"]["unix_ns"]) <= kind["end_unix_seconds"] * 1000000000,
             "historical-terminal-after-request-end")
    exact(calendar, {"format", "calendarId", "version", "timezone", "dateLabelConvention", "sessions"},
          "historical-dated-calendar-shape")
    need(calendar["format"] == "vertex-qualified-dated-sessions-v1"
         and calendar["dateLabelConvention"] == "session-close-local-date"
         and type(calendar["version"]) is str and bool(calendar["version"])
         and type(calendar["sessions"]) is list and 1 <= len(calendar["sessions"]) <= 5000,
         "historical-qualified-dated-calendar-required")
    require_id(calendar["calendarId"])
    try:
        zone = ZoneInfo(calendar["timezone"])
    except (ValueError, KeyError, TypeError):
        raise HistoricalUnavailable("historical-reviewed-timezone-unavailable") from None
    # Calendar timezone is an explicit reviewed interpretation, not a claim that
    # the SDK's often abbreviated time_zone_id itself is an IANA calendar.
    sessions = {}
    prior_end = -1
    for session in calendar["sessions"]:
        exact(session, {"sessionDate", "startNs", "endNs", "sourceLocator"}, "historical-dated-session-shape")
        start, end = ns(session["startNs"]), ns(session["endNs"])
        need(prior_end <= start < end and session["sessionDate"] not in sessions
             and type(session["sourceLocator"]) is str and 0 < len(session["sourceLocator"]) <= 2048,
             "historical-qualified-session-order-or-reference")
        need(datetime.fromtimestamp(end // 1000000000, timezone.utc).astimezone(zone).date().isoformat()
             == session["sessionDate"], "historical-session-local-date-mismatch")
        sessions[session["sessionDate"]] = session
        prior_end = end
    transform = exact(rules["numericTransform"], {"format", "priceScale", "volumeScale", "pricePrecision", "volumePrecision",
                                               "sourcePriceMagnifier", "sourceVolumeUnit", "targetVolumeUnit"},
                      "historical-explicit-numeric-transform-required")
    need(transform["format"] == "ieee754-exact-rational-half-even-fixed-v1"
         and transform["sourcePriceMagnifier"] == units["price_magnifier"]
         and transform["sourceVolumeUnit"] == units["volume_unit"] and units["volume_unit"] in {"shares", "lots"}
         and units["size_unit"] == "shares" and transform["targetVolumeUnit"] == "retrieval-adjusted-share-units"
         and transform["volumePrecision"] == 0, "historical-reviewed-price-volume-units-unavailable")
    availability = exact(rules["availability"], {"format", "delayNs"}, "historical-availability-model-required")
    need(availability["format"] == "modeled-interval-close-plus-delay-v1", "historical-availability-model-version")
    delay = ns(availability["delayNs"])
    need(delay <= 86400000000000, "historical-availability-delay-bound")
    need((rules["interval"], kind["bar_size"]) in {("1m", "1 min"), ("1d", "1 day")},
         "historical-exact-interval-unavailable")
    need(rules["labelConvention"] == ("dated-session" if rules["interval"] == "1d" else "interval-start"),
         "historical-source-label-convention-unavailable")
    need(rules["instrumentId"] == model.instrument_id and model.instrument_id == source_id + ".RESEARCH",
         "historical-source-native-instrument-mismatch")
    need(len(capture["records"]) == source.declared_events, "historical-original-declared-row-count")
    rows, gaps = [], []
    prior_end, prior_available = -1, -1
    fields = {"type", "provider_timestamp", "open_f64_bits", "high_f64_bits", "low_f64_bits", "close_f64_bits",
              "volume_f64_bits", "wap_f64_bits", "trade_count", "decoded_receive_ordinal", "acquired_unix_ns"}
    for ordinal, row in enumerate(capture["records"]):
        exact(row, fields, "historical-original-row-shape")
        need(row["type"] == "bar" and type(row["decoded_receive_ordinal"]) is int
             and row["decoded_receive_ordinal"] == ordinal and type(row["trade_count"]) is int
             and -2147483648 <= row["trade_count"] <= 2147483647
             and started <= ns(row["acquired_unix_ns"]) <= finished,
             "historical-original-row-ordinal-or-acquisition")
        stamp = row["provider_timestamp"]
        if rules["interval"] == "1d":
            exact(stamp, {"kind", "sdk_decoded_label"}, "historical-original-date-required")
            need(stamp["kind"] == "date" and stamp["sdk_decoded_label"] in sessions,
                 "historical-date-missing-reviewed-dated-session")
            session = sessions[stamp["sdk_decoded_label"]]
            start, end = ns(session["startNs"]), ns(session["endNs"])
        else:
            exact(stamp, {"kind", "value"}, "historical-original-datetime-required")
            need(stamp["kind"] == "datetime", "historical-original-datetime-kind")
            instant = exact(stamp["value"], {"unix_ns", "offset_seconds"}, "historical-original-datetime-shape")
            start = ns(instant["unix_ns"])
            end = start + 60000000000
            need(type(instant["offset_seconds"]) is int and -86399 <= instant["offset_seconds"] <= 86399
                 and ns(window["start"]["unix_ns"]) <= start <= ns(window["end"]["unix_ns"]),
                 "historical-original-datetime-window")
            matching = [s for s in sessions.values() if ns(s["startNs"]) <= start < end <= ns(s["endNs"])]
            need(len(matching) == 1, "historical-intraday-session-window-unqualified")
            session = matching[0]
        need(ns(window["start"]["unix_ns"]) <= start < end <= ns(window["end"]["unix_ns"]),
             "historical-modeled-interval-outside-source-window")
        available = end + delay
        need(end <= finished and available < 2**64 and prior_end <= start and prior_available < available,
             "historical-revision-overlap-reorder-or-clock-unavailable")
        if prior_end >= 0 and start > prior_end:
            gaps.append({"afterOrdinal": ordinal - 1, "startNs": str(prior_end), "endNs": str(start),
                         "classification": "nonobserved-time-not-certified-missing-bars"})
        values = {field: transformed(row[field + "_f64_bits"], transform["volumeScale" if field == "volume" else "priceScale"],
                                    transform["volumePrecision" if field == "volume" else "pricePrecision"], volume=field == "volume")
                  for field in ("open", "high", "low", "close", "volume")}
        numeric = {field: Decimal(value["modeledDecimal"]) for field, value in values.items()}
        need(numeric["low"] <= min(numeric["open"], numeric["close"]) <= max(numeric["open"], numeric["close"]) <= numeric["high"],
             "historical-rounded-ohlc-order-unavailable")
        need(re.fullmatch(r"[0-9a-f]{16}", row["wap_f64_bits"]) is not None, "historical-original-wap-bits-invalid")
        rows.append({"ordinal": ordinal, "sourceRowSha256": bindings[ordinal]["rowSha256"],
            "captureSha256": identity["contentHash"], "providerTimestamp": stamp, "acquiredNs": row["acquired_unix_ns"],
            "qualifiedStartNs": str(start), "qualifiedEndNs": str(end), "modeledAvailableNs": str(available),
            "sessionDate": session["sessionDate"], "values": values, "originalWapF64Bits": row["wap_f64_bits"],
            "originalTradeCount": row["trade_count"], "availabilityIsObserved": False})
        prior_end, prior_available = end, available
    return rows, {"interpretationSha256": sha(rules_raw), "calendarSha256": sha(calendar_raw),
        "adjustment": adjustment, "sourceTimezoneLabel": units["timezone"], "qualifiedTimezone": calendar["timezone"],
        "gaps": gaps, "originalLimitations": capture["limitations"], "marketCoverage": "unqualified",
        "historicalVintage": "unavailable", "sourceResponseComplete": True, "captureComplete": True}


class HistoricalBarPlanner:
    """Ready means only eligible for restricted simulation; NEVER strict OOS ready."""
    def __init__(self, *, boundary: Any, engine: Any, model: Any, citation_review: Any) -> None:
        self.boundary, self.engine, self.model, self.citation_review = boundary, engine, model, citation_review

    def plan(self, request: Any) -> BacktestPlan:
        strategy = run = lineage = descriptor = None
        datasets = evidence = ()
        try:
            need(not self.boundary.missing_ports and self.engine is not None and self.citation_review is not None,
                 "historical-current-authority-unavailable")
            need(type(request.lineage) is HistoricalBarLineage and len(request.datasets) == 1
                 and type(request.datasets[0]) is HistoricalBarInput and request.replay_evidence is None,
                 "historical-one-series-sealed-request-required")
            source, model, inputs = request.datasets[0], self.model, request.lineage
            size = sum(len(raw) for raw in (request.strategy_bytes, request.run_bytes, source.manifest_bytes,
                source.content_bytes, source.capture_bytes, *request.evidence_bytes, model.native_configuration_bytes,
                inputs.review_pins_bytes))
            need(size <= request.budget.maximum_input_bytes and source.declared_events <= request.budget.maximum_events,
                 "historical-input-budget-exceeded")
            strategy = self.boundary.public("StrategySpec", decode_json(request.strategy_bytes))
            run = self.boundary.public("BacktestRun", decode_json(request.run_bytes))
            datasets = (self.boundary.public("DatasetManifest", decode_json(source.manifest_bytes)),)
            evidence = tuple(self.boundary.public("ResearchEvidence", decode_json(raw)) for raw in request.evidence_bytes)
            descriptor = self.engine.describe()
            need(inputs.engine_pin == descriptor.pin and inputs.code_pin.digest == model.strategy_code_digest
                 and strategy.digest == model.strategy_digest and strategy.decode()["codeDigest"] == inputs.code_pin.digest
                 and inputs.model_digest == self.boundary.codec.digest(model.record()), "historical-scientific-model-pin-mismatch")
            need(inputs.code_pin == Pin("vertex-adjusted-bar-round-trip", ENGINE_VERSION, descriptor.pin.digest),
                 "historical-fixed-strategy-source-required")
            rules, calendar, rule_bytes, calendar_bytes = interpretation(self.boundary.codec, model, request.budget.maximum_input_bytes)
            need(inputs.interpretation_digest == sha(rule_bytes) and model.assumptions_digest == self.boundary.codec.digest(rules["assumptions"]),
                 "historical-interpretation-assumption-pin-mismatch")
            pins = canonical(self.boundary.codec, inputs.review_pins_bytes, 262144)
            need(type(pins) is list and 1 <= len(pins) <= 32, "historical-actual-review-pins-required")
            pin_map = {pin["evidenceId"]: pin for pin in pins}
            need(len(pin_map) == len(pins) == len(evidence), "historical-exact-review-evidence-set-required")
            required = {datasets[0].digest, sha(source.content_bytes), sha(source.capture_bytes), sha(rule_bytes), sha(calendar_bytes),
                        descriptor.pin.digest, inputs.code_pin.digest, sha(model.native_configuration_bytes),
                        self.boundary.codec.digest(scientific_core(model))}
            covered = set()
            for artifact in evidence:
                record = artifact.decode()
                pin = pin_map.get(record["evidenceId"])
                need(pin is not None and pin["artifactSha256"] == artifact.digest and record["contentHash"] in required
                     and time_ns(record["capturedAt"]) <= time_ns(request.planned_at), "historical-original-review-coverage-mismatch")
                need(self.citation_review(artifact) is None, "historical-current-review-authority-unavailable")
                covered.add(record["contentHash"])
            need(covered == required, "historical-current-source-calendar-model-review-missing")
            core_digest = self.boundary.codec.digest(scientific_core(model))
            need(any(item.digest == model.review_digest and item.decode()["contentHash"] == core_digest for item in evidence),
                 "historical-scientific-parameters-review-missing")
            record, spec, manifest = run.decode(), strategy.decode(), datasets[0].decode()
            need(record["strategyVersion"] == inputs.strategy_version_id and record["engineVersion"] == descriptor.pin.version
                 and record["datasetManifestIds"] == [manifest["datasetId"]] and record["resultsRef"] is None
                 and record["reviewStatus"] == "unreviewed" and record["forwardSampleCount"] == 0
                 and record["validationMode"] == "historical" and record["gammaProvenance"] is None,
                 "historical-original-run-binding-invalid")
            need({check["kind"] for check in record["leakageChecks"]}
                 == {"look-ahead", "survivorship", "point-in-time", "overlap", "multiple-testing"}
                 and all(check["status"] in {"not-run", "unknown"} and check["evidenceId"] is None
                         for check in record["leakageChecks"]),
                 "historical-leakage-conclusions-must-remain-unavailable")
            need(spec["universe"] == manifest["instrumentUniverse"] and spec["signalSchedule"]["calendar"] == calendar["calendarId"]
                 and time_ns(manifest["captureTime"]) <= time_ns(request.planned_at)
                 and record["transactionCosts"] == spec["costModel"] and record["slippageModel"] == spec["costModel"]["impactModel"],
                 "historical-strategy-scope-calendar-cost-mismatch")
            for side, threshold in (("entry", model.enter_not_before_ns), ("exit", model.exit_not_before_ns)):
                need(spec[side + "Rules"] == [{"ruleId": "historical-" + side, "featureId": "modeled-bar-available-ns",
                     "operator": "gte", "threshold": str(threshold), "lookbackBars": 1}],
                     "historical-fixed-time-gated-strategy-rule-required")
            requirements = spec["requiredData"]
            need(len(requirements) == 1 and requirements[0]["kind"] == "candles"
                 and requirements[0]["pointInTimeRequired"] is False
                 and requirements[0]["entitlementPolicyId"] == manifest["entitlementPolicyId"]
                 and ns(rules["availability"]["delayNs"]) <= requirements[0]["maximumAgeMs"] * 1000000
                 and spec["signalSchedule"]["interval"] == ("session-close" if rules["interval"] == "1d" else "bar-close"),
                 "historical-bar-requirement-or-modeled-schedule-mismatch")
            cost = spec["costModel"]
            need(Decimal(cost["commissionPerUnit"]) * Decimal(model.quantity) == Decimal(model.commission_per_fill)
                 and all(Decimal(cost[key]) == 0 for key in ("spreadBps", "slippageBps", "borrowAnnualBps"))
                 and cost["impactModel"] == "participation-capped"
                 and Decimal(0) < Decimal(cost["maximumParticipationBps"]) <= Decimal(10000),
                 "historical-public-cost-must-match-reviewed-native-model")
            rows, provenance = qualify(source, self.boundary.codec, model, request.budget.maximum_input_bytes)
            risk = spec["riskLimits"]
            modeled_notional = Decimal(model.quantity) * max(Decimal(row["values"]["high"]["modeledDecimal"]) for row in rows)
            fees = Decimal(model.commission_per_fill) * 2
            need(risk["maximumPositions"] == 1 and modeled_notional <= Decimal(risk["maximumNotional"])
                 and Decimal(risk["maximumNotional"]) + fees <= Decimal(risk["maximumLoss"])
                 and modeled_notional + fees <= Decimal(model.initial_cash),
                 "historical-fixed-no-stop-cash-risk-bound-unavailable")
            begin, end = time_ns(record["testWindow"]["startAtInclusive"]), time_ns(record["testWindow"]["endAtExclusive"])
            need(begin <= model.enter_not_before_ns < model.exit_not_before_ns < end
                 and all(begin <= ns(row["qualifiedEndNs"]) <= ns(row["modeledAvailableNs"]) < end for row in rows),
                 "historical-full-series-study-window-required")
            lineage = self.boundary.internal("internal.HistoricalBarLineage.v1", {
                "format": "vertex-historical-bar-lineage-v1", "researchClass": CLASS, "strategyDigest": strategy.digest,
                "runDigest": run.digest, "datasetManifestDigests": [item.digest for item in datasets],
                "evidenceDigests": [item.digest for item in evidence], "lineage": inputs.record(),
                "budget": asdict(request.budget), "engineDescriptor": asdict(descriptor),
                "originalCaptureSha256": sha(source.capture_bytes), "qualification": provenance,
                "plannedAt": timestamp(request.planned_at), "promotionEligible": False, "executionAuthorized": False})
            return BacktestPlan(request, "ready", strategy, run, datasets, evidence, lineage, (), (), descriptor)
        except HistoricalUnavailable as exc:
            return BacktestPlan(request, "unavailable", strategy, run, datasets, evidence, lineage, (str(exc),), (), descriptor)
        except PortUnavailable:
            return BacktestPlan(request, "unavailable", strategy, run, datasets, evidence, lineage,
                                ("historical-authority-unavailable",), (), descriptor)
        except (ValueError, TypeError, KeyError, RecursionError, OverflowError):
            return BacktestPlan(request, "unavailable", strategy, run, datasets, evidence, lineage,
                                ("historical-original-contract-or-qualification-unavailable",), (), descriptor)

    def complete(self, plan: Any, output: Any, *, as_of: datetime, reviewed_acceptance: bool = False) -> BacktestCompletion:
        try:
            fresh = self.plan(plan.request)
            need(fresh.status == "ready" and fresh.lineage == plan.lineage and reviewed_acceptance is False,
                 "historical-plan-or-current-review-changed")
            need(output.lineage_digest == plan.lineage.digest and output.strategy_digest == plan.strategy.digest
                 and output.engine_pin == plan.engine.pin and output.dataset_content_digests == (sha(plan.request.datasets[0].content_bytes),)
                 and output.assumption_digest == self.model.assumptions_digest and output.modeled_assumptions == MODELED
                 and output.sandbox.qualified(plan.engine, plan.request.budget) and output.status == "inconclusive"
                 and output.point_in_time_enforced is False and output.data_complete is False,
                 "historical-result-binding-or-restrictions-mismatch")
            need(utc(as_of) >= plan.request.planned_at and len(output.evidence_bytes) == 1
                 and len(output.economics_bytes) + sum(map(len, output.evidence_bytes)) <= plan.request.budget.maximum_input_bytes,
                 "historical-result-budget-or-clock")
            extra = tuple(self.boundary.public("ResearchEvidence", decode_json(raw)) for raw in output.evidence_bytes)
            need(all(item.decode()["acceptanceStatus"] == "unreviewed" and item.decode()["untrustedContent"] is True
                     and time_ns(item.decode()["capturedAt"]) <= time_ns(as_of) for item in extra)
                 and extra[0].decode()["evidenceId"] == output.sandbox.isolation_evidence_id,
                 "historical-original-unreviewed-isolation-required")
            economics = canonical(self.boundary.codec, output.economics_bytes, plan.request.budget.maximum_input_bytes)
            need(economics.get("format") == "vertex-nautilus-historical-bar-economics-v1"
                 and economics.get("researchClass") == CLASS and economics.get("metricScope") == "limited-retrospective"
                 and economics.get("promotionEligible") is False and economics.get("pointInTime") is False,
                 "historical-economic-result-class-mismatch")
            results = self.boundary.internal("internal.HistoricalBarResults.v1", {
                "format": RESULT, "researchClass": CLASS, "lineageDigest": output.lineage_digest,
                "strategyDigest": output.strategy_digest, "enginePin": asdict(output.engine_pin),
                "datasetContentDigests": list(output.dataset_content_digests), "assumptionDigest": output.assumption_digest,
                "economics": economics, "economicsOrigin": "native-retrospective-adjusted-bar-simulation",
                "economicsSimulated": output.economics_simulated, "sandbox": asdict(output.sandbox),
                "evidenceDigests": [item.digest for item in extra], "incidentCodes": list(output.incident_codes),
                "restrictions": list(RESTRICTIONS), "pointInTimeEnforced": False, "dataComplete": False,
                "forwardAssessment": None, "promotionEligible": False, "executionAuthorized": False})
            need(len(results.payload_bytes) <= 1048576, "historical-result-publication-byte-bound")
            run = plan.run.decode()
            run.update(resultsRef="backtest-results-" + results.digest, forwardSampleCount=0, reviewStatus="incomplete")
            updated = self.boundary.public("BacktestRun", run)
            return BacktestCompletion(plan, output, "incomplete", updated, results, (*plan.evidence, *extra), RESTRICTIONS, False, None)
        except HistoricalUnavailable as exc:
            return BacktestCompletion(plan, output, "unavailable", plan.run, None, plan.evidence,
                                      (str(exc),), False, None)
        except (ValueError, TypeError, KeyError, RecursionError, OverflowError, PortUnavailable):
            return BacktestCompletion(plan, output, "rejected", plan.run, None, plan.evidence,
                                      ("historical-result-contract-or-authority-unavailable",), False, None)
