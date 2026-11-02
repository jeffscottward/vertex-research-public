"""Bounded synthetic v3 originals, not native execution or real review evidence.

The finite authority below exercises byte binding and pure Python contracts only.
No broker, SDK loader, worker, containment, database, rights service or source data
is invoked. The dated sessions are fictional fixtures, not an exchange calendar.
"""
from base64 import b64encode
from copy import deepcopy
from dataclasses import asdict, replace
from datetime import UTC, datetime
from fractions import Fraction
import hashlib
import json
import struct
from types import SimpleNamespace

import pytest

from backtesting.historical import (
    ASSUMPTIONS, CLASS, CONTENT, ENGINE_ID, ENGINE_VERSION, INTERPRETATION, MODELED,
    RESTRICTIONS, RESULT, HistoricalBarInput, HistoricalBarLineage, HistoricalBarPlanner,
    HistoricalUnavailable, canonical, embedded, interpretation, qualify, scientific_core, transformed,
)
from backtesting.lineage import Pin, time_ns
from backtesting.planner import BacktestRequest, EngineDescriptor, SandboxReceipt, SimulationOutput
from backtesting.ports import PortUnavailable, PublicBoundary, ResourceBudget
from providers.ibkr_history import MEDIA_TYPE
from vertex_host.research_engine import ReviewedResearchModel


MAXIMUM = 1_048_576
ONE = {"numerator": "1", "denominator": "1"}


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def bits(value):
    return struct.pack(">d", value).hex()


def timestamp_text(ns_value):
    """Fixture-only exact whole-second conversion, never float timestamp division."""
    seconds, remainder = divmod(int(ns_value), 1_000_000_000)
    text = datetime.fromtimestamp(seconds, UTC).strftime("%Y-%m-%dT%H:%M:%S")
    return text + (f".{remainder:09d}" if remainder else "") + "Z"


def original(raw):
    return {"bytesBase64": b64encode(raw).decode("ascii"), "sha256": digest(raw)}


class SyntheticAuthority:
    """Canonical ASCII JSON domain and exact registered fixture admission only."""
    def __init__(self):
        self.allowed = set()
        self.current = set()
        self.review_calls = []

    def encode(self, value):
        return json.dumps(value, sort_keys=True, ensure_ascii=False, allow_nan=False,
                          separators=(",", ":")).encode("utf-8")

    def digest(self, value):
        return digest(self.encode(value))

    def allow(self, name, value):
        self.allowed.add((name, self.encode(value)))

    def validate(self, name, value, schema_version="1.0.0"):
        return schema_version == "1.0.0" and (name, self.encode(value)) in self.allowed

    def review(self, artifact):
        self.review_calls.append(artifact.digest)
        if artifact.payload_bytes not in self.current:
            raise PortUnavailable("synthetic-review-not-current")


def rules_model(authority, rules, calendar):
    rules = deepcopy(rules)
    rules["calendar"] = original(authority.encode(calendar))
    config = {"format": "vertex-nautilus-historical-bars-v1", "distribution": {"synthetic": True},
              "instrument": {"synthetic": True}, "issuedNs": "1", "expiresNs": "2",
              "interpretation": original(authority.encode(rules))}
    # interpretation()/qualify() do not admit a native configuration or load SDKs.
    return SimpleNamespace(native_configuration_bytes=authority.encode(config),
                           instrument_id="ibkr-conid-7001.RESEARCH")


def fixture_documents(interval="1d", what_to_show="TRADES"):
    """Two tiny fictional bars with later acquisition and independent dated sessions."""
    authority = SyntheticAuthority()
    request = {
        "schema_version": "1.0.0", "request_id": "synthetic-request", "contract_ref": "synthetic-contract",
        "kind": {"type": "bars", "what_to_show": what_to_show,
                 "bar_size": "1 day" if interval == "1d" else "1 min", "duration_days": 1,
                 "end_unix_seconds": time_ns("2026-01-07T00:00:00Z") // 1_000_000_000 if what_to_show == "TRADES" else None,
                 "use_rth": True},
        "limits": {"timeout_ms": 1000, "max_rows": 4, "max_bytes": MAXIMUM, "max_events": 4},
    }
    contract = {"contract_id": 7001, "symbol": "SYNTHETIC", "security_type": "STK", "currency": "USD"}
    details_raw = authority.encode({"contract": contract, "price_magnifier": 1, "time_zone_id": "EST"})
    acquisition = {"started_unix_ns": str(time_ns("2026-01-08T11:59:58Z")),
                   "finished_unix_ns": str(time_ns("2026-01-08T12:00:00Z")), "elapsed_monotonic_ns": "2000000000"}
    calendar = {
        "format": "vertex-qualified-dated-sessions-v1", "calendarId": "synthetic-dated-sessions", "version": "1.0.0",
        "timezone": "America/New_York", "dateLabelConvention": "session-close-local-date",
        "sessions": [{"sessionDate": f"2026-01-0{day}", "startNs": str(time_ns(f"2026-01-0{day}T14:30:00Z")),
                      "endNs": str(time_ns(f"2026-01-0{day}T21:00:00Z")), "sourceLocator": f"synthetic-session-{day}"}
                     for day in (5, 6)],
    }
    records = []
    for ordinal, day in enumerate((5, 6)):
        stamp = ({"kind": "date", "sdk_decoded_label": f"2026-01-0{day}"} if interval == "1d" else
                 {"kind": "datetime", "value": {"unix_ns": str(time_ns("2026-01-05T14:30:00Z") + ordinal * 60_000_000_000),
                                                "offset_seconds": 0}})
        records.append({"type": "bar", "provider_timestamp": stamp, "open_f64_bits": bits(10.0),
                        "high_f64_bits": bits(12.0), "low_f64_bits": bits(9.0), "close_f64_bits": bits(11.0),
                        "volume_f64_bits": bits(100.0), "wap_f64_bits": bits(10.5), "trade_count": 7,
                        "decoded_receive_ordinal": ordinal, "acquired_unix_ns": str(int(acquisition["started_unix_ns"]) + ordinal + 1)})
    capture = {
        "schema_version": "1.0.0", "request": request, "request_sha256": authority.digest(request),
        "effective_request": {}, "owner": {"identity": "synthetic-owner-not-started"},
        "sdk": {"version": "ibapi=3.3.0", "extension": "vertex-history-strict-v1"},
        "qualified_contract": {"decoded_contract": contract,
            "semantics": {"price_magnifier": 1, "timezone": "EST", "volume_unit": "shares", "size_unit": "shares",
                          "details_sha256": digest(details_raw)},
            "qualification_capture": {"encoding": "ibapi-serde-json", "original_bytes_base64": b64encode(details_raw).decode("ascii"),
                                      "sha256": digest(details_raw), "observed_unix_ns": str(time_ns("2026-01-08T11:59:57Z")),
                                      "raw_wire": False}},
        "acquisition": acquisition, "attempts": {"synthetic": True}, "status": "source-response-complete",
        "source_response_complete": True, "data_valid": True, "capture_complete": True,
        "market_coverage": "unqualified", "point_in_time_adjustments": False, "admissible": False,
        "cancel_status": "not-requested", "owner_slot_quarantined": False,
        "provider_window": {"start": {"unix_ns": str(time_ns("2026-01-05T00:00:00Z")), "offset_seconds": 0},
                            "end": {"unix_ns": str(time_ns("2026-01-07T00:00:00Z")), "offset_seconds": 0}},
        "records": records, "events": [], "limitations": ["Synthetic fixture only; not observed broker data"],
    }
    rules = {
        "format": INTERPRETATION, "instrumentId": "ibkr-conid-7001.RESEARCH", "interval": interval,
        "labelConvention": "dated-session" if interval == "1d" else "interval-start",
        "numericTransform": {"format": "ieee754-exact-rational-half-even-fixed-v1", "priceScale": dict(ONE),
                             "volumeScale": dict(ONE), "pricePrecision": 2, "volumePrecision": 0,
                             "sourcePriceMagnifier": 1, "sourceVolumeUnit": "shares", "targetVolumeUnit": "retrieval-adjusted-share-units"},
        "availability": {"format": "modeled-interval-close-plus-delay-v1", "delayNs": "5000000000"},
        "assumptions": deepcopy(ASSUMPTIONS),
    }
    return SimpleNamespace(authority=authority, request=request, capture=capture, calendar=calendar, rules=rules)


def seal(documents):
    """Hash real canonical fixture bytes; never bypass capture/row reconstruction."""
    authority, capture, request = documents.authority, documents.capture, documents.request
    request_raw = authority.encode(request)
    capture["request"] = deepcopy(request)
    capture["request_sha256"] = digest(request_raw)
    kind = request["kind"]
    adjustment = "split-adjusted-not-dividend-adjusted" if kind["what_to_show"] == "TRADES" else "split-and-dividend-adjusted"
    capture["effective_request"] = {
        "type": "bars", "what_to_show": kind["what_to_show"], "bar_size": kind["bar_size"], "duration": "1 D",
        "end_unix_seconds": kind["end_unix_seconds"], "use_rth": kind["use_rth"], "format_date": 2,
        "keep_up_to_date": False, "adjustment": adjustment,
        "end_semantics": "explicit-UTC-second" if kind["end_unix_seconds"] is not None else "provider-now-single-request",
    }
    capture_raw = authority.encode(capture)
    identity = {"provider": "ibkr", "sourceId": "ibkr-conid-7001", "snapshotId": "ibkr-capture-" + digest(capture_raw),
                "contentHash": digest(capture_raw)}
    semantics = {"profile": CONTENT, "intervalSemantics": "provider-terminal-window-not-certified-market-coverage",
                 "marketCoverage": "unqualified", "calendarQualification": "unqualified", "pointInTime": False,
                 "researchAdmission": "unqualified", "rowSemantics": "sdk-decoded-bar-bits-v1", "adjustment": adjustment}
    producer = "synthetic-producer"
    content = {
        "profile": CONTENT, "source": identity, "instrumentId": "ibkr-conid-7001",
        "capture": {"artifactId": "blob-" + digest(capture_raw), "sha256": digest(capture_raw), "mediaType": MEDIA_TYPE},
        "request": {"artifactId": "ibkr-history-intent-" + authority.digest({"jobId": producer, "requestSha256": digest(request_raw)}),
                    "sha256": digest(request_raw), "bytesBase64": b64encode(request_raw).decode("ascii")},
        "records": capture["records"],
        "rowBindings": [{"ordinal": i, "captureJsonPointer": f"/records/{i}", "rowSha256": authority.digest(row)}
                        for i, row in enumerate(capture["records"])],
        "acquisition": capture["acquisition"], "qualifiedContractPointer": "/qualified_contract",
        "effectiveRequestPointer": "/effective_request", "providerWindowPointer": "/provider_window", "semantics": semantics,
        "snapshotIdentitySemantics": "vertex-capture-sha256-not-provider-snapshot",
        "availabilitySemantics": "actual-later-acquisition-not-historical-arrival",
        "numericSemantics": "unchanged-sdk-ieee754-bits-no-volume-or-price-unit-conversion",
        "orderingSemantics": "sdk-decoded-receive-order-not-exchange-tie-order", "limitations": capture["limitations"],
    }
    content_raw = authority.encode(content)
    manifest = {
        "schemaVersion": "1.0.0", "datasetId": "synthetic-dataset", "provider": "ibkr", "entitlementPolicyId": "synthetic-rights",
        "instrumentUniverse": ["ibkr-conid-7001"],
        "startAtInclusive": timestamp_text(capture["provider_window"]["start"]["unix_ns"]),
        "endAtExclusive": timestamp_text(capture["provider_window"]["end"]["unix_ns"]),
        "captureTime": "2026-01-08T12:00:01Z", "dataVintageId": None, "dataVintageStatus": "unavailable",
        "asOfAt": "2026-01-08T12:00:00Z", "adjustmentMethod": "split-adjusted" if kind["what_to_show"] == "TRADES" else "provider-defined",
        "calendar": None, "contentHash": digest(content_raw), "storageRef": "blob-" + digest(content_raw),
        "retentionPolicy": "synthetic-retention", "sources": [identity], "gammaProvenance": None, "historicalSemantics": semantics,
    }
    manifest_raw = authority.encode(manifest)
    authority.allow("DatasetManifest", manifest)
    rules = {**deepcopy(documents.rules), "manifestSha256": digest(manifest_raw), "contentSha256": digest(content_raw),
             "captureSha256": digest(capture_raw), "requestSha256": digest(request_raw),
             "qualificationSha256": capture["qualified_contract"]["qualification_capture"]["sha256"],
             "calendar": original(authority.encode(documents.calendar))}
    source = HistoricalBarInput(manifest_raw, content_raw, CONTENT, len(capture["records"]), capture_raw, producer)
    return SimpleNamespace(source=source, authority=authority, model=rules_model(authority, rules, documents.calendar),
                           rules=rules, calendar=deepcopy(documents.calendar), manifest=manifest, content=content, capture=deepcopy(capture))


def qualified(fixture):
    return qualify(fixture.source, fixture.authority, fixture.model, MAXIMUM)


@pytest.mark.parametrize("number,scale,precision,volume,decimal,numerator,denominator,residual", [
    (0.1, ONE, 2, False, "0.10", 3602879701896397, 36028797018963968, Fraction(-1, 180143985094819840)),
    (1.125, ONE, 2, False, "1.12", 9, 8, Fraction(-1, 200)),
    (1.375, ONE, 2, False, "1.38", 11, 8, Fraction(1, 200)),
    (1.0, {"numerator": "1", "denominator": "3"}, 2, False, "0.33", 1, 3, Fraction(-1, 300)),
    (3.5, {"numerator": "100", "denominator": "1"}, 0, True, "350", 350, 1, Fraction(0)),
    (0.5, ONE, 0, True, "0", 1, 2, Fraction(-1, 2)),
    (1.5, ONE, 0, True, "2", 3, 2, Fraction(1, 2)),
    (2.5, ONE, 0, True, "2", 5, 2, Fraction(-1, 2)),
    (3.5, ONE, 0, True, "4", 7, 2, Fraction(1, 2)),
])
def test_exact_binary64_rationals_half_even_ties_and_residuals(number, scale, precision, volume, decimal, numerator, denominator, residual):
    result = transformed(bits(number), scale, precision, volume=volume)
    assert result == {"sourceF64Bits": bits(number), "modeledDecimal": decimal,
                      "scaledExactNumerator": str(numerator), "scaledExactDenominator": str(denominator),
                      "roundingChanged": residual != 0}
    assert Fraction(result["modeledDecimal"]) - Fraction(numerator, denominator) == residual


@pytest.mark.parametrize("source_bits,reason", [
    (None, "historical-f64-source-bits-invalid"), ("unknown", "historical-f64-source-bits-invalid"),
    ("3FF0000000000000", "historical-f64-source-bits-invalid"), ("0", "historical-f64-source-bits-invalid"),
    (0, "historical-f64-source-bits-invalid"), (True, "historical-f64-source-bits-invalid"),
    ("bff0000000000000", "historical-observed-volume-unavailable"),
    ("8000000000000000", "historical-negative-zero-volume-unqualified"),
    ("7ff8000000000000", "historical-observed-volume-unavailable"),
    ("7ff0000000000000", "historical-observed-volume-unavailable"),
    ("fff0000000000000", "historical-observed-volume-unavailable"),
])
def test_volume_missing_negative_nonfinite_or_invalid_never_becomes_zero(source_bits, reason):
    with pytest.raises(HistoricalUnavailable, match="^" + reason + "$"):
        transformed(source_bits, ONE, 0, volume=True)


def test_observed_positive_zero_volume_is_preserved_but_zero_price_is_not():
    assert transformed("0000000000000000", ONE, 0, volume=True) == {
        "sourceF64Bits": "0000000000000000", "modeledDecimal": "0", "scaledExactNumerator": "0",
        "scaledExactDenominator": "1", "roundingChanged": False,
    }
    for value in (0.0, -1.0, float("inf"), float("nan")):
        with pytest.raises(HistoricalUnavailable, match="historical-positive-finite-price-unavailable"):
            transformed(bits(value), ONE, 2, volume=False)
    with pytest.raises(HistoricalUnavailable, match="historical-rounded-positive-price-unavailable"):
        transformed(bits(0.001), ONE, 2, volume=False)


@pytest.mark.parametrize("scale,precision,reason", [
    ({"numerator": "1", "denominator": "0"}, 2, "historical-positive-rational-scale-required"),
    ({"numerator": "01", "denominator": "1"}, 2, "historical-positive-rational-scale-required"),
    ({"numerator": 1, "denominator": "1"}, 2, "historical-positive-rational-scale-required"),
    ({**ONE, "inferred": True}, 2, "historical-numeric-scale-shape"),
    (ONE, True, "historical-native-precision-or-magnitude-unavailable"),
    (ONE, -1, "historical-native-precision-or-magnitude-unavailable"),
    (ONE, 10, "historical-native-precision-or-magnitude-unavailable"),
])
def test_numeric_scale_and_precision_are_closed(scale, precision, reason):
    with pytest.raises(HistoricalUnavailable, match=reason):
        transformed(bits(1.0), scale, precision, volume=False)


def test_canonical_interpretation_embeds_and_binds_exact_calendar_bytes():
    fixture = seal(fixture_documents())
    rules, calendar, raw, calendar_raw = interpretation(fixture.authority, fixture.model, MAXIMUM)
    assert rules == fixture.rules
    assert calendar == fixture.calendar
    assert raw == fixture.authority.encode(fixture.rules)
    assert calendar_raw == fixture.authority.encode(fixture.calendar)
    assert rules["calendar"] == original(calendar_raw)
    assert embedded(original(raw), MAXIMUM) == raw
    with pytest.raises(HistoricalUnavailable, match="historical-original-canonical-bytes-required"):
        canonical(fixture.authority, b" " + raw, MAXIMUM)
    with pytest.raises(HistoricalUnavailable, match="historical-original-embedded-digest"):
        embedded({**original(raw), "sha256": "0" * 64}, MAXIMUM)
    with pytest.raises(HistoricalUnavailable, match="historical-embedded-byte-bound"):
        embedded(original(raw), 1)
    with pytest.raises(HistoricalUnavailable, match="historical-original-embedded-shape"):
        embedded({**original(raw), "accepted": True}, MAXIMUM)


@pytest.mark.parametrize("mutation,reason", [
    (lambda rules: rules.update(extra=True), "historical-interpretation-shape"),
    (lambda rules: rules.pop("manifestSha256"), "historical-interpretation-shape"),
    (lambda rules: rules.update(format="vertex-historical-bar-interpretation-v0"), "historical-interpretation-version"),
    (lambda rules: rules["assumptions"].update(adjustments="point-in-time"), "historical-explicit-native-assumptions-required"),
])
def test_interpretation_keys_version_and_explicit_assumptions_are_closed(mutation, reason):
    fixture = seal(fixture_documents())
    mutation(fixture.rules)
    model = rules_model(fixture.authority, fixture.rules, fixture.calendar)
    with pytest.raises(HistoricalUnavailable, match=reason):
        interpretation(fixture.authority, model, MAXIMUM)


@pytest.mark.parametrize("what_to_show,adjustment", [
    ("TRADES", "split-adjusted-not-dividend-adjusted"), ("ADJUSTED_LAST", "split-and-dividend-adjusted"),
])
def test_daily_qualification_preserves_originals_later_acquisition_and_adjusted_units(what_to_show, adjustment):
    fixture = seal(fixture_documents(what_to_show=what_to_show))
    original_bytes = (fixture.source.manifest_bytes, fixture.source.content_bytes, fixture.source.capture_bytes,
                      fixture.model.native_configuration_bytes)
    rows, provenance = qualified(fixture)
    assert len(rows) == 2
    for row, source, session in zip(rows, fixture.capture["records"], fixture.calendar["sessions"], strict=True):
        assert row["providerTimestamp"] == source["provider_timestamp"]
        assert row["acquiredNs"] == source["acquired_unix_ns"]
        assert row["qualifiedStartNs"] == session["startNs"]
        assert row["qualifiedEndNs"] == session["endNs"]
        assert int(row["modeledAvailableNs"]) == int(session["endNs"]) + 5_000_000_000
        assert int(row["modeledAvailableNs"]) < int(row["acquiredNs"])
        assert row["availabilityIsObserved"] is False
        assert row["sourceRowSha256"] == fixture.authority.digest(source)
        assert row["values"]["volume"]["sourceF64Bits"] == source["volume_f64_bits"]
        assert row["values"]["volume"]["modeledDecimal"] == "100"
        assert row["originalWapF64Bits"] == source["wap_f64_bits"]
        assert row["originalTradeCount"] == source["trade_count"]
    assert provenance["adjustment"] == adjustment
    assert provenance["sourceTimezoneLabel"] == "EST"
    assert provenance["qualifiedTimezone"] == "America/New_York"
    assert provenance["marketCoverage"] == "unqualified"
    assert provenance["historicalVintage"] == "unavailable"
    assert provenance["gaps"] == [{"afterOrdinal": 0, "startNs": fixture.calendar["sessions"][0]["endNs"],
                                    "endNs": fixture.calendar["sessions"][1]["startNs"],
                                    "classification": "nonobserved-time-not-certified-missing-bars"}]
    assert fixture.manifest["calendar"] is None
    assert fixture.manifest["historicalSemantics"]["pointInTime"] is False
    assert fixture.rules["numericTransform"]["targetVolumeUnit"] == "retrieval-adjusted-share-units"
    assert original_bytes == (fixture.source.manifest_bytes, fixture.source.content_bytes, fixture.source.capture_bytes,
                              fixture.model.native_configuration_bytes)


def test_minute_label_means_interval_start_not_arrival_and_lot_scaling_is_explicit():
    documents = fixture_documents("1m")
    documents.capture["qualified_contract"]["semantics"]["volume_unit"] = "lots"
    documents.rules["numericTransform"].update(sourceVolumeUnit="lots", volumeScale={"numerator": "100", "denominator": "1"})
    fixture = seal(documents)
    rows, provenance = qualified(fixture)
    assert provenance["gaps"] == []
    for row, source in zip(rows, fixture.capture["records"], strict=True):
        start = source["provider_timestamp"]["value"]["unix_ns"]
        assert row["qualifiedStartNs"] == start
        assert int(row["qualifiedEndNs"]) == int(start) + 60_000_000_000
        assert int(row["modeledAvailableNs"]) == int(start) + 65_000_000_000
        assert row["values"]["volume"]["modeledDecimal"] == "10000"
        assert row["values"]["volume"]["sourceF64Bits"] == bits(100.0)
        assert row["availabilityIsObserved"] is False


@pytest.mark.parametrize("key", ["manifestSha256", "contentSha256", "captureSha256", "requestSha256", "qualificationSha256"])
def test_original_root_request_and_qualification_hashes_are_not_caller_labels(key):
    fixture = seal(fixture_documents())
    fixture.rules[key] = "0" * 64
    fixture.model = rules_model(fixture.authority, fixture.rules, fixture.calendar)
    reason = ("historical-original-root-pins-mismatch" if key in {"manifestSha256", "contentSha256", "captureSha256"}
              else "historical-original-bars-request-required" if key == "requestSha256" else "historical-original-contract-pin-mismatch")
    with pytest.raises(HistoricalUnavailable, match=reason):
        qualified(fixture)


def test_content_reconstruction_and_producer_bound_request_identity_are_enforced():
    fixture = seal(fixture_documents())
    with pytest.raises(HistoricalUnavailable, match="historical-root-capture-row-reconstruction-mismatch"):
        qualify(replace(fixture.source, producer_job_id="different-synthetic-producer"), fixture.authority, fixture.model, MAXIMUM)
    fixture.content["records"][0]["volume_f64_bits"] = bits(999.0)
    changed = fixture.authority.encode(fixture.content)
    fixture.rules["contentSha256"] = digest(changed)
    fixture.model = rules_model(fixture.authority, fixture.rules, fixture.calendar)
    with pytest.raises(HistoricalUnavailable, match="historical-root-capture-row-reconstruction-mismatch"):
        qualify(replace(fixture.source, content_bytes=changed), fixture.authority, fixture.model, MAXIMUM)


@pytest.mark.parametrize("mutation,reason", [
    (lambda d: d.rules.update(labelConvention="interval-start"), "historical-source-label-convention-unavailable"),
    (lambda d: d.capture["records"][0]["provider_timestamp"].update(sdk_decoded_label="2026-01-04"), "historical-date-missing-reviewed-dated-session"),
    (lambda d: d.calendar["sessions"][0].update(sessionDate="2026-01-04"), "historical-session-local-date-mismatch"),
    (lambda d: d.calendar.update(timezone="Synthetic/NoZone"), "historical-reviewed-timezone-unavailable"),
    (lambda d: d.calendar.update(extra=True), "historical-dated-calendar-shape"),
    (lambda d: d.calendar["sessions"][1].update(startNs=d.calendar["sessions"][0]["startNs"]), "historical-qualified-session-order-or-reference"),
    (lambda d: d.calendar["sessions"].reverse(), "historical-qualified-session-order-or-reference"),
    (lambda d: d.rules["availability"].update(delayNs="86400000000001"), "historical-availability-delay-bound"),
    (lambda d: d.rules["availability"].update(delayNs="00"), "historical-canonical-nanosecond-string-required"),
    (lambda d: d.capture["qualified_contract"]["semantics"].update(volume_unit="unknown"), "historical-reviewed-price-volume-units-unavailable"),
    (lambda d: d.rules["numericTransform"].update(volumePrecision=1), "historical-reviewed-price-volume-units-unavailable"),
    (lambda d: d.capture["records"][0].update(acquired_unix_ns="1"), "historical-original-row-ordinal-or-acquisition"),
    (lambda d: d.capture["records"][0].update(volume_f64_bits=bits(-1.0)), "historical-observed-volume-unavailable"),
    (lambda d: d.capture["records"][0].update(extra=True), "historical-original-row-shape"),
    (lambda d: d.capture["records"][0].update(high_f64_bits=bits(8.0)), "historical-rounded-ohlc-order-unavailable"),
])
def test_dated_calendar_labels_availability_units_and_original_rows_fail_closed(mutation, reason):
    documents = fixture_documents()
    mutation(documents)
    with pytest.raises(HistoricalUnavailable, match=reason):
        qualified(seal(documents))


@pytest.mark.parametrize("interval,mutation", [
    ("1d", "overlap"), ("1d", "reorder"), ("1m", "overlap"), ("1m", "reorder"),
])
def test_overlapping_or_reordered_rows_are_rejected_not_sorted_or_deduplicated(interval, mutation):
    documents = fixture_documents(interval)
    rows = documents.capture["records"]
    if mutation == "overlap":
        rows[1]["provider_timestamp"] = deepcopy(rows[0]["provider_timestamp"])
    else:
        rows.reverse()
        for ordinal, row in enumerate(rows):
            row["decoded_receive_ordinal"] = ordinal
    with pytest.raises(HistoricalUnavailable, match="historical-revision-overlap-reorder-or-clock-unavailable"):
        qualified(seal(documents))


def test_minute_bar_crossing_session_end_is_not_qualified_by_its_start_alone():
    documents = fixture_documents("1m")
    documents.capture["records"][0]["provider_timestamp"]["value"]["unix_ns"] = str(time_ns("2026-01-05T20:59:30Z"))
    with pytest.raises(HistoricalUnavailable, match="historical-intraday-session-window-unqualified"):
        qualified(seal(documents))


def evidence_record(identity, content_hash, source=None):
    return {
        "schemaVersion": "1.0.0", "evidenceId": identity, "collectionId": "synthetic-collection",
        "snapshotId": "synthetic-review-snapshot", "sourceType": "derived-analysis",
        "sourceUri": "https://example.invalid/synthetic-bar-fixture",
        "sourceIdentity": source or {"provider": "synthetic", "sourceId": identity,
                                    "snapshotId": "synthetic-review-snapshot", "contentHash": content_hash},
        "sourceLocator": "synthetic-only", "attribution": "Synthetic test, no actual review or rights",
        "publishedAt": "2026-01-08T12:00:02Z", "capturedAt": "2026-01-08T12:00:03Z",
        "contentHash": content_hash, "claim": "Synthetic fixture only", "method": "Exact finite test allowlist",
        "limitations": ["Not broker, scientific, financial, native-runtime or rights evidence"],
        "acceptanceStatus": "unreviewed", "rightsPolicyId": "synthetic-rights", "untrustedContent": True,
    }


class MetadataOnlyEngine:
    def __init__(self, descriptor):
        self.descriptor = descriptor
        self.simulation_calls = 0

    def describe(self):
        return self.descriptor

    def simulate(self, request):
        self.simulation_calls += 1
        raise AssertionError("Native or other simulation is forbidden in this fixture")


def planner_fixture():
    fixture = seal(fixture_documents())
    authority = fixture.authority
    boundary = PublicBoundary(validator=authority, codec=authority)
    engine_digest = digest(b"synthetic-fixed-bar-runner-source-not-native-inventory")
    engine_pin = Pin(ENGINE_ID, ENGINE_VERSION, engine_digest)
    descriptor = EngineDescriptor(engine_pin, MODELED, (CONTENT,), digest(b"synthetic-isolation-policy"), True)
    engine = MetadataOnlyEngine(descriptor)
    enter = time_ns("2026-01-05T21:00:05Z")
    exit_at = time_ns("2026-01-06T21:00:05Z")
    cost = {"commissionPerUnit": "1", "spreadBps": "0", "slippageBps": "0", "borrowAnnualBps": "0",
            "impactModel": "participation-capped", "maximumParticipationBps": "100"}
    strategy = {
        "schemaVersion": "1.0.0", "strategyId": "synthetic-strategy", "version": "1.0.0", "sleeve": "quant",
        "hypothesis": "Synthetic limited retrospective test only", "universe": ["ibkr-conid-7001"],
        "signalSchedule": {"calendar": fixture.calendar["calendarId"], "timezone": fixture.calendar["timezone"],
                           "interval": "session-close"},
        "entryRules": [{"ruleId": "historical-entry", "featureId": "modeled-bar-available-ns",
                        "operator": "gte", "threshold": str(enter), "lookbackBars": 1}],
        "exitRules": [{"ruleId": "historical-exit", "featureId": "modeled-bar-available-ns",
                       "operator": "gte", "threshold": str(exit_at), "lookbackBars": 1}],
        "riskLimits": {"maximumLoss": "102", "maximumNotional": "100", "maximumPositions": 1},
        "requiredData": [{"kind": "candles", "maximumAgeMs": 5000, "pointInTimeRequired": False,
                          "entitlementPolicyId": "synthetic-rights"}],
        "costModel": cost, "codeDigest": engine_digest,
    }
    run = {
        "schemaVersion": "1.0.0", "runId": "synthetic-run", "strategyVersion": "synthetic-strategy-v1",
        "datasetManifestIds": [fixture.manifest["datasetId"]], "seed": 0, "engineVersion": ENGINE_VERSION,
        "trainingWindow": {"startAtInclusive": "2026-01-01T00:00:00Z", "endAtExclusive": "2026-01-05T00:00:00Z"},
        "testWindow": {"startAtInclusive": "2026-01-05T00:00:00Z", "endAtExclusive": "2026-01-07T00:00:00Z"},
        "benchmark": "synthetic-benchmark", "transactionCosts": cost, "slippageModel": "participation-capped",
        "resultsRef": None, "leakageChecks": [{"kind": kind, "status": "unknown", "evidenceId": None}
            for kind in ("look-ahead", "survivorship", "point-in-time", "overlap", "multiple-testing")],
        "reviewStatus": "unreviewed", "validationMode": "historical", "forwardSampleCount": 0, "gammaProvenance": None,
    }
    authority.allow("StrategySpec", strategy)
    authority.allow("BacktestRun", run)
    model = ReviewedResearchModel(
        strategy_digest=authority.digest(strategy), strategy_code_digest=engine_digest,
        assumptions_digest=authority.digest(ASSUMPTIONS), engine_digest=engine_digest, review_digest="0" * 64,
        instrument_id=fixture.model.instrument_id, quantity="1", initial_cash="1000", commission_per_fill="1",
        slippage_per_unit="0", enter_not_before_ns=enter, exit_not_before_ns=exit_at,
        evidence_template_bytes=authority.encode({"acceptanceStatus": "unreviewed", "untrustedContent": True}),
        native_configuration_bytes=fixture.model.native_configuration_bytes,
    )
    core_digest = authority.digest(scientific_core(model))
    required = {
        digest(fixture.source.manifest_bytes), digest(fixture.source.content_bytes), digest(fixture.source.capture_bytes),
        authority.digest(fixture.rules), authority.digest(fixture.calendar), engine_digest,
        digest(model.native_configuration_bytes), core_digest,
    }
    evidence, pins = [], []
    for ordinal, target in enumerate(sorted(required)):
        record = evidence_record(f"synthetic-review-{ordinal}", target,
                                 fixture.content["source"] if target == digest(fixture.source.capture_bytes) else None)
        raw = authority.encode(record)
        authority.allow("ResearchEvidence", record)
        authority.current.add(raw)
        evidence.append(raw)
        pins.append({
            "collectionId": "synthetic-collection", "evidenceId": record["evidenceId"],
            "artifactId": f"synthetic-review-artifact-{ordinal}", "artifactSha256": digest(raw),
            "reviewId": f"synthetic-current-review-{ordinal}", "reviewVersion": "1.0.0",
            "rightsPolicyId": "synthetic-rights", "rightsVersion": "1.0.0",
        })
        if target == core_digest:
            model = replace(model, review_digest=digest(raw))
    lineage = HistoricalBarLineage(
        "synthetic-strategy-v1", Pin("vertex-adjusted-bar-round-trip", ENGINE_VERSION, engine_digest), engine_pin,
        authority.digest(model.record()), authority.digest(fixture.rules), authority.encode(pins),
    )
    request = BacktestRequest(
        authority.encode(strategy), authority.encode(run), (fixture.source,), tuple(evidence), lineage,
        ResourceBudget(maximum_input_bytes=MAXIMUM, maximum_events=4), datetime(2026, 1, 9, tzinfo=UTC),
    )
    planner = HistoricalBarPlanner(boundary=boundary, engine=engine, model=model, citation_review=authority.review)
    return fixture, planner, request, required


def completion_fixture(fixture, planner, plan):
    """Construct only synthetic output metadata; no native economics is generated."""
    authority = fixture.authority
    economics = {
        "format": "vertex-nautilus-historical-bar-economics-v1", "researchClass": CLASS,
        "metricScope": "limited-retrospective", "promotionEligible": False, "pointInTime": False,
        "syntheticFixture": True,
    }
    raw = authority.encode(economics)
    isolation = evidence_record("synthetic-isolation-evidence", digest(raw))
    authority.allow("ResearchEvidence", isolation)
    isolation_raw = authority.encode(isolation)
    receipt = SandboxReceipt(plan.engine.sandbox_policy_digest, plan.request.budget, True, False, False,
                             100, 2, 1000, 1, 1, isolation["evidenceId"])
    output = SimulationOutput(
        plan.lineage.digest, plan.strategy.digest, plan.engine.pin, (digest(fixture.source.content_bytes),),
        planner.model.assumptions_digest, raw, (isolation_raw,), MODELED, receipt, False, False, True, "inconclusive",
    )
    expected_result = {
        "format": RESULT, "researchClass": CLASS, "lineageDigest": output.lineage_digest,
        "strategyDigest": output.strategy_digest, "enginePin": asdict(output.engine_pin),
        "datasetContentDigests": list(output.dataset_content_digests), "assumptionDigest": output.assumption_digest,
        "economics": economics, "economicsOrigin": "native-retrospective-adjusted-bar-simulation",
        "economicsSimulated": True, "sandbox": asdict(receipt), "evidenceDigests": [digest(isolation_raw)],
        "incidentCodes": [], "restrictions": list(RESTRICTIONS), "pointInTimeEnforced": False, "dataComplete": False,
        "forwardAssessment": None, "promotionEligible": False, "executionAuthorized": False,
    }
    authority.allow("BacktestRun", {
        **plan.run.decode(), "resultsRef": "backtest-results-" + authority.digest(expected_result),
        "forwardSampleCount": 0, "reviewStatus": "incomplete",
    })
    return output, expected_result


def test_full_pure_plan_reviews_all_original_hashes_and_cannot_promote_synthetic_output():
    fixture, planner, request, required = planner_fixture()
    plan = planner.plan(request)
    assert plan.status == "ready", plan.reasons
    assert plan.reasons == ()
    assert {artifact.decode()["contentHash"] for artifact in plan.evidence} == required
    assert fixture.authority.review_calls == [artifact.digest for artifact in plan.evidence]
    assert plan.lineage.decode()["researchClass"] == CLASS
    assert plan.lineage.decode()["promotionEligible"] is False
    assert plan.request.lineage.record()["promotionEligible"] is False
    assert plan.execution_authorized is False
    output, expected_result = completion_fixture(fixture, planner, plan)
    completed = planner.complete(plan, output, as_of=datetime(2026, 1, 10, tzinfo=UTC))
    assert completed.status == "incomplete", completed.reasons
    assert completed.results.decode() == expected_result
    assert completed.reasons == RESTRICTIONS
    assert completed.realism_qualified is False
    assert completed.execution_authorized is False
    assert completed.forward is None
    assert completed.run.decode()["forwardSampleCount"] == 0
    assert completed.run.decode()["reviewStatus"] == "incomplete"
    assert completed.evidence[-1].decode()["acceptanceStatus"] == "unreviewed"
    assert fixture.authority.review_calls == [artifact.digest for artifact in plan.evidence] * 2
    assert planner.engine.simulation_calls == 0


@pytest.mark.parametrize("changed", [
    {"data_complete": True}, {"point_in_time_enforced": True}, {"status": "completed"},
    {"lineage_digest": "0" * 64},
])
def test_completion_rejects_promotion_completeness_or_lineage_upgrade(changed):
    fixture, planner, request, _ = planner_fixture()
    plan = planner.plan(request)
    assert plan.status == "ready", plan.reasons
    output, _ = completion_fixture(fixture, planner, plan)
    output = replace(output, **changed)
    completed = planner.complete(plan, output, as_of=datetime(2026, 1, 10, tzinfo=UTC))
    assert completed.status == "unavailable"
    assert completed.reasons == ("historical-result-binding-or-restrictions-mismatch",)
    assert completed.results is None
    assert completed.output is output
    assert completed.realism_qualified is False
    assert planner.engine.simulation_calls == 0


def test_completion_caller_review_flag_and_revoked_current_review_cannot_admit_output():
    fixture, planner, request, _ = planner_fixture()
    plan = planner.plan(request)
    assert plan.status == "ready", plan.reasons
    output, _ = completion_fixture(fixture, planner, plan)
    self_review = planner.complete(plan, output, as_of=datetime(2026, 1, 10, tzinfo=UTC), reviewed_acceptance=True)
    assert self_review.status == "unavailable"
    assert self_review.reasons == ("historical-plan-or-current-review-changed",)
    fixture.authority.current.clear()
    revoked = planner.complete(plan, output, as_of=datetime(2026, 1, 10, tzinfo=UTC))
    assert revoked.status == "unavailable"
    assert revoked.reasons == ("historical-plan-or-current-review-changed",)
    assert revoked.results is None
    assert planner.engine.simulation_calls == 0


def test_original_capture_review_cannot_be_omitted_with_matching_smaller_pin_set():
    fixture, planner, request, _ = planner_fixture()
    capture_hash = digest(fixture.source.capture_bytes)
    remaining = tuple(raw for raw in request.evidence_bytes if json.loads(raw)["contentHash"] != capture_hash)
    ids = {json.loads(raw)["evidenceId"] for raw in remaining}
    pins = [pin for pin in json.loads(request.lineage.review_pins_bytes) if pin["evidenceId"] in ids]
    request = replace(request, evidence_bytes=remaining,
                      lineage=replace(request.lineage, review_pins_bytes=fixture.authority.encode(pins)))
    plan = planner.plan(request)
    assert plan.status == "unavailable"
    assert plan.reasons == ("historical-current-source-calendar-model-review-missing",)
    assert planner.engine.simulation_calls == 0


def test_daily_label_uses_reviewed_local_close_date_not_utc_midnight_or_fixed_day_length():
    documents = fixture_documents()
    # Fictional extended session: Jan 6 UTC, still Jan 5 in New York.
    documents.calendar["sessions"][0]["endNs"] = str(time_ns("2026-01-06T00:30:00Z"))
    documents.rules["availability"]["delayNs"] = "0"
    fixture = seal(documents)
    rows, _ = qualified(fixture)
    assert rows[0]["sessionDate"] == "2026-01-05"
    assert rows[0]["qualifiedEndNs"] == str(time_ns("2026-01-06T00:30:00Z"))
    assert int(rows[0]["qualifiedEndNs"]) - int(rows[0]["qualifiedStartNs"]) == 10 * 60 * 60 * 1_000_000_000
    assert rows[0]["modeledAvailableNs"] == rows[0]["qualifiedEndNs"]
    assert rows[0]["availabilityIsObserved"] is False


def test_native_configuration_is_closed_and_calendar_hash_cannot_be_relabelled():
    fixture = seal(fixture_documents())
    config = json.loads(fixture.model.native_configuration_bytes)
    config["networkAllowed"] = True
    bad_model = SimpleNamespace(native_configuration_bytes=fixture.authority.encode(config))
    with pytest.raises(HistoricalUnavailable, match="historical-native-configuration-shape"):
        interpretation(fixture.authority, bad_model, MAXIMUM)
    config.pop("networkAllowed")
    rules = json.loads(fixture.authority.encode(fixture.rules))
    rules["calendar"]["sha256"] = "0" * 64
    config["interpretation"] = original(fixture.authority.encode(rules))
    bad_model.native_configuration_bytes = fixture.authority.encode(config)
    with pytest.raises(HistoricalUnavailable, match="historical-original-embedded-digest"):
        interpretation(fixture.authority, bad_model, MAXIMUM)


def test_declared_count_and_immutable_original_inputs_are_not_coerced():
    fixture = seal(fixture_documents())
    with pytest.raises(HistoricalUnavailable, match="historical-original-declared-row-count"):
        qualify(replace(fixture.source, declared_events=1), fixture.authority, fixture.model, MAXIMUM)
    with pytest.raises(HistoricalUnavailable, match="historical-input-format-or-count"):
        replace(fixture.source, declared_events=True)
    with pytest.raises(HistoricalUnavailable, match="historical-immutable-original-bytes-required"):
        replace(fixture.source, capture_bytes=bytearray(fixture.source.capture_bytes))


def test_numeric_magnitude_bound_is_exact_before_rounding():
    boundary = transformed(bits(1_000_000_000_000.0), ONE, 2, volume=False)
    assert boundary["modeledDecimal"] == "1000000000000.00"
    assert boundary["roundingChanged"] is False
    with pytest.raises(HistoricalUnavailable, match="historical-native-precision-or-magnitude-unavailable"):
        transformed(bits(1_000_000_000_001.0), ONE, 2, volume=False)


@pytest.mark.parametrize("boundary,terminal", [
    ("start", "2026-01-05T14:30:01Z"),
    ("end", "2026-01-06T20:59:59Z"),
])
def test_daily_session_must_stay_inside_original_provider_window(boundary, terminal):
    documents = fixture_documents()
    documents.capture["provider_window"][boundary]["unix_ns"] = str(time_ns(terminal))
    fixture = seal(documents)
    originals = (fixture.source.manifest_bytes, fixture.source.content_bytes, fixture.source.capture_bytes)
    # Whole reviewed sessions are required; neither clipping nor fabricated dates is permissible.
    with pytest.raises(HistoricalUnavailable):
        qualified(fixture)
    assert originals == (fixture.source.manifest_bytes, fixture.source.content_bytes, fixture.source.capture_bytes)


def test_minute_interval_end_must_stay_inside_original_provider_window():
    documents = fixture_documents("1m")
    # Both labels/start instants fit, but the second complete minute ends at 14:32.
    documents.capture["provider_window"]["end"]["unix_ns"] = str(time_ns("2026-01-05T14:31:30Z"))
    fixture = seal(documents)
    assert fixture.manifest["endAtExclusive"] == "2026-01-05T14:31:30Z"
    assert all(int(row["provider_timestamp"]["value"]["unix_ns"]) < time_ns(fixture.manifest["endAtExclusive"])
               for row in fixture.capture["records"])
    with pytest.raises(HistoricalUnavailable):
        qualified(fixture)


@pytest.mark.parametrize("interval,end", [("1d", "2026-01-06T21:00:00Z"), ("1m", "2026-01-05T14:32:00Z")])
def test_exact_provider_window_edges_are_admitted_without_clipping(interval, end):
    documents = fixture_documents(interval)
    documents.capture["provider_window"]["start"]["unix_ns"] = str(time_ns("2026-01-05T14:30:00Z"))
    documents.capture["provider_window"]["end"]["unix_ns"] = str(time_ns(end))
    fixture = seal(documents)
    rows, _ = qualified(fixture)
    assert rows[0]["qualifiedStartNs"] == fixture.capture["provider_window"]["start"]["unix_ns"]
    assert rows[-1]["qualifiedEndNs"] == fixture.capture["provider_window"]["end"]["unix_ns"]
    assert rows[-1]["modeledAvailableNs"] == str(time_ns(end) + 5_000_000_000)
