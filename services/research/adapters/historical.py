"""Historical-only publication plan built from the existing QuantPad boundary."""
from __future__ import annotations

from providers.boundary import Boundary, authorize, identifier
from providers.ports import DatasetPlan, RightRequest, RightsPort
from providers.quantpad import HistoricalCapture
from .ports import AdapterUnavailable, ResearchClock


def plan_historical(capture: HistoricalCapture, *, boundary: Boundary, rights: RightsPort,
                    clock: ResearchClock, dataset_id: str, storage_ref: str,
                    instrument_universe: tuple[str, ...], adjustment_method: str) -> DatasetPlan:
    source = capture.input
    if not instrument_universe or len(instrument_universe) > 10_000 or len(set(instrument_universe)) != len(instrument_universe):
        raise AdapterUnavailable("historical-universe-unavailable")
    for value in (dataset_id, storage_ref, *instrument_universe):
        identifier(value)
    original = boundary.content(source.data, capture.content.media_type)
    if original != capture.content or original.digest != source.expected_digest:
        raise AdapterUnavailable("historical-source-mismatch")
    decision = authorize(rights, RightRequest("quantpad", source.rights_policy_id, "dataset-stage", clock.now(), (source.source_id,)))
    if decision.retention_policy != source.retention_policy:
        raise AdapterUnavailable("historical-retention-denied")
    from providers.boundary import parse_json
    rows = parse_json(capture.rows_json, maximum_bytes=16_000_000, maximum_nodes=1_000_000)
    identity = {"provider": "quantpad", "sourceId": source.source_id,
                "snapshotId": source.snapshot_id, "contentHash": original.digest}
    content = boundary.content(boundary.encode({
        "profile": "vertex-authorized-historical-input-v1", "source": identity,
        "operation": source.operation, "format": source.format, "rows": rows,
        "sourceUri": source.public_source_uri, "vintageId": source.vintage_id,
        "availableAt": source.available_at, "receivedAt": source.received_at,
        "calendar": source.calendar, "untrustedContent": True,
        "limitations": list(capture.limitations), "liveSessionQualified": False,
        "economicFieldSemantics": "unavailable-unless-separately-qualified",
    }), "application/json")
    manifest = boundary.record("DatasetManifest", {
        "schemaVersion": "1.0.0", "datasetId": dataset_id, "provider": "quantpad",
        "entitlementPolicyId": source.rights_policy_id,
        "instrumentUniverse": sorted(instrument_universe),
        "startAtInclusive": source.coverage_start, "endAtExclusive": source.coverage_end,
        "captureTime": clock.now(), "dataVintageId": source.vintage_id,
        "dataVintageStatus": "available", "asOfAt": source.available_at,
        "adjustmentMethod": adjustment_method, "calendar": source.calendar,
        "contentHash": content.digest, "storageRef": storage_ref,
        "retentionPolicy": source.retention_policy, "sources": [identity], "gammaProvenance": None,
    })
    # No Quote/Candle/TradeFlow synthesis: field semantics have not been granted.
    return DatasetPlan(manifest, (content, original), (), (original.digest,), decision.revision)


def plan_ibkr_bars(capture, *, request, boundary: Boundary, rights: RightsPort,
                   clock: ResearchClock, publication: dict, producer_job_id: str) -> DatasetPlan:
    """Versioned immutable bar projection, NOT Candle/PIT/replay qualification.

    Exact SDK bytes are a separate source object. JSON pointers and canonical
    row hashes make this lossless decoded projection reconstructible without
    reserializing the SDK's contract floats or pretending to retain wire text.
    """
    import base64
    import re
    from datetime import datetime, timezone
    from hashlib import sha256
    from providers.ibkr_history import HistoricalCapture
    from vertex_control.adapters import MAX_ARTIFACT_BYTES

    value = HistoricalCapture.bind(capture.content.data, request).decode()
    if (value["request"]["kind"]["type"] != "bars"
            or not all(value[key] for key in ("source_response_complete", "capture_complete", "data_valid"))
            or value["admissible"] is not False):
        raise AdapterUnavailable("ibkr-bars-complete-decoded-capture-required")
    if set(publication) != {"dataset_id", "storage_ref", "instrument_id", "rights_policy_id",
                            "retention_policy"}:
        raise AdapterUnavailable("ibkr-bars-publication-shape-invalid")
    for key in ("dataset_id", "storage_ref", "instrument_id", "rights_policy_id", "retention_policy"):
        identifier(publication[key])
    qualified = value["qualified_contract"]
    if (type(qualified) is not dict or set(qualified) != {"decoded_contract", "semantics", "qualification_capture"}
            or type(qualified["semantics"]) is not dict
            or set(qualified["semantics"]) != {"details_sha256", "price_magnifier", "price_precision",
                                              "size_unit", "volume_unit", "timezone", "calendar_ref"}):
        raise AdapterUnavailable("ibkr-bars-qualified-contract-shape-invalid")
    qualification = qualified["qualification_capture"]
    if (type(qualification) is not dict
            or set(qualification) != {"encoding", "original_bytes_base64", "sha256", "observed_unix_ns", "raw_wire"}
            or qualification["encoding"] != "ibapi-serde-json" or qualification["raw_wire"] is not False
            or type(qualification["original_bytes_base64"]) is not str
            or not 0 < len(qualification["original_bytes_base64"]) <= 87_384
            or type(qualification["sha256"]) is not str
            or re.fullmatch(r"[0-9a-f]{64}", qualification["sha256"]) is None):
        raise AdapterUnavailable("ibkr-bars-qualification-original-invalid")
    try:
        qualification_bytes = base64.b64decode(qualification["original_bytes_base64"], validate=True)
    except Exception:
        raise AdapterUnavailable("ibkr-bars-qualification-base64-invalid") from None
    if (not 0 < len(qualification_bytes) <= 65_536
            or base64.b64encode(qualification_bytes).decode("ascii") != qualification["original_bytes_base64"]
            or sha256(qualification_bytes).hexdigest() != qualification["sha256"]
            or qualified["semantics"]["details_sha256"] != qualification["sha256"]):
        raise AdapterUnavailable("ibkr-bars-qualification-original-mismatch")
    # Hash exact SDK-serde bytes, never a float-bearing JSON reserialization.
    # The native qualified owner binds details.contract to decoded_contract.
    contract = qualified["decoded_contract"]
    if type(contract) is not dict or type(contract.get("contract_id")) is not int or not 0 < contract["contract_id"] <= 2_147_483_647:
        raise AdapterUnavailable("ibkr-bars-qualified-contract-unavailable")
    source_id = "ibkr-conid-" + str(contract["contract_id"])
    if publication["instrument_id"] != source_id:
        raise AdapterUnavailable("ibkr-bars-instrument-contract-mismatch")

    def ns(raw):
        if type(raw) is not str or re.fullmatch(r"[0-9]{1,30}", raw) is None:
            raise AdapterUnavailable("ibkr-bars-acquisition-clock-invalid")
        return int(raw)

    acquisition = value["acquisition"]
    if set(acquisition) != {"started_unix_ns", "finished_unix_ns", "elapsed_monotonic_ns"}:
        raise AdapterUnavailable("ibkr-bars-acquisition-shape-invalid")
    start, finish = ns(acquisition["started_unix_ns"]), ns(acquisition["finished_unix_ns"])
    ns(acquisition["elapsed_monotonic_ns"])
    now = clock.now()
    if not 0 < start <= finish <= clock.timestamp_ns(now):
        raise AdapterUnavailable("ibkr-bars-acquisition-chronology-invalid")
    if not 0 < ns(qualification["observed_unix_ns"]) <= start:
        raise AdapterUnavailable("ibkr-bars-qualification-observation-invalid")
    def timestamp(value_ns):
        seconds, nanos = divmod(value_ns, 1_000_000_000)
        return datetime.fromtimestamp(seconds, timezone.utc).strftime("%Y-%m-%dT%H:%M:%S") + f".{nanos:09d}Z"

    def terminal_instant(raw):
        if (type(raw) is not dict or set(raw) != {"unix_ns", "offset_seconds"}
                or type(raw["offset_seconds"]) is not int or not -86399 <= raw["offset_seconds"] <= 86399):
            raise AdapterUnavailable("ibkr-bars-terminal-window-invalid")
        value_ns = ns(raw["unix_ns"])
        if not 946_684_800_000_000_000 <= value_ns <= 4_102_444_800_000_000_000:
            raise AdapterUnavailable("ibkr-bars-terminal-window-invalid")
        return value_ns

    window = value["provider_window"]
    if type(window) is not dict or set(window) != {"start", "end"}:
        raise AdapterUnavailable("ibkr-bars-genuine-terminal-window-required")
    window_start, window_end = terminal_instant(window["start"]), terminal_instant(window["end"])
    kind = value["request"]["kind"]
    expected_effective = {"type": "bars", "what_to_show": kind["what_to_show"], "bar_size": kind["bar_size"],
        "duration": f"{kind['duration_days']} D", "end_unix_seconds": kind["end_unix_seconds"],
        "use_rth": kind["use_rth"], "format_date": 2, "keep_up_to_date": False,
        "adjustment": "split-adjusted-not-dividend-adjusted" if kind["what_to_show"] == "TRADES" else "split-and-dividend-adjusted",
        "end_semantics": "explicit-UTC-second" if kind["end_unix_seconds"] is not None else "provider-now-single-request"}
    if value["effective_request"] != expected_effective or not window_start < window_end <= finish:
        raise AdapterUnavailable("ibkr-bars-terminal-request-semantics-mismatch")
    if kind["end_unix_seconds"] is not None and window_end > kind["end_unix_seconds"] * 1_000_000_000:
        raise AdapterUnavailable("ibkr-bars-terminal-exceeds-explicit-end")
    # Duration remains the actual SDK '<N> D' request, not an invented UTC-day
    # subtraction/calendar. The terminal's genuine decoded window is retained
    # verbatim in the original, including offsets; no coverage/PIT certification.
    available_at = timestamp(finish)
    fields = {"type", "provider_timestamp", "open_f64_bits", "high_f64_bits", "low_f64_bits",
              "close_f64_bits", "volume_f64_bits", "wap_f64_bits", "trade_count",
              "decoded_receive_ordinal", "acquired_unix_ns"}
    bindings = []
    for ordinal, row in enumerate(value["records"]):
        if (type(row) is not dict or set(row) != fields or row["type"] != "bar"
                or type(row["decoded_receive_ordinal"]) is not int or row["decoded_receive_ordinal"] != ordinal
                or type(row["trade_count"]) is not int or not -2_147_483_648 <= row["trade_count"] <= 2_147_483_647
                or not start <= ns(row["acquired_unix_ns"]) <= finish):
            raise AdapterUnavailable("ibkr-bar-row-shape-invalid")
        for field in ("open", "high", "low", "close", "volume", "wap"):
            bits = row[field + "_f64_bits"]
            if type(bits) is not str or re.fullmatch(r"[0-9a-f]{16}", bits) is None:
                raise AdapterUnavailable("ibkr-bar-numeric-bits-invalid")
        stamp = row["provider_timestamp"]
        if type(stamp) is not dict:
            raise AdapterUnavailable("ibkr-bar-timestamp-invalid")
        if request.decode()["kind"]["bar_size"] == "1 day":
            if (set(stamp) != {"kind", "sdk_decoded_label"} or stamp["kind"] != "date"
                    or type(stamp["sdk_decoded_label"]) is not str
                    or re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}", stamp["sdk_decoded_label"]) is None):
                raise AdapterUnavailable("ibkr-bar-date-label-invalid")
            # A source Date remains a Date. No invented midnight/session close.
        else:
            instant = stamp.get("value")
            if (set(stamp) != {"kind", "value"} or stamp["kind"] != "datetime" or type(instant) is not dict
                    or set(instant) != {"unix_ns", "offset_seconds"}
                    or type(instant["offset_seconds"]) is not int or not -86399 <= instant["offset_seconds"] <= 86399):
                raise AdapterUnavailable("ibkr-bar-datetime-invalid")
            if not window_start <= ns(instant["unix_ns"]) <= window_end:
                raise AdapterUnavailable("ibkr-bar-timestamp-outside-terminal-window")
        bindings.append({"ordinal": ordinal, "captureJsonPointer": f"/records/{ordinal}",
                         "rowSha256": boundary.content(boundary.encode(row), "application/json").digest})
    original = boundary.content(capture.content.data, capture.content.media_type)
    identity = {"provider": "ibkr", "sourceId": source_id,
                "snapshotId": "ibkr-capture-" + original.digest, "contentHash": original.digest}
    what = value["request"]["kind"]["what_to_show"]
    adjustment = "split-adjusted-not-dividend-adjusted" if what == "TRADES" else "split-and-dividend-adjusted"
    semantics = {"profile": "vertex-ibkr-historical-bars-v1",
        "intervalSemantics": "provider-terminal-window-not-certified-market-coverage",
        "marketCoverage": "unqualified", "calendarQualification": "unqualified",
        "pointInTime": False, "researchAdmission": "unqualified",
        "rowSemantics": "sdk-decoded-bar-bits-v1", "adjustment": adjustment}
    decision = authorize(rights, RightRequest("ibkr", publication["rights_policy_id"],
        "dataset-stage", clock.now(), (source_id,)))
    if decision.retention_policy != publication["retention_policy"]:
        raise AdapterUnavailable("ibkr-bars-retention-denied")
    intent_digest = boundary.content(boundary.encode(
        {"jobId": identifier(producer_job_id), "requestSha256": request.sha256}), "application/json").digest
    intent_id = "ibkr-history-intent-" + intent_digest
    content = boundary.content(boundary.encode({
        "profile": semantics["profile"], "source": identity, "instrumentId": source_id,
        "capture": {"artifactId": "blob-" + original.digest, "sha256": original.digest, "mediaType": original.media_type},
        "request": {"artifactId": intent_id, "sha256": request.sha256,
                    "bytesBase64": base64.b64encode(request.data).decode("ascii")},
        "records": value["records"], "rowBindings": bindings, "acquisition": acquisition,
        "qualifiedContractPointer": "/qualified_contract", "effectiveRequestPointer": "/effective_request",
        "providerWindowPointer": "/provider_window", "semantics": semantics,
        "snapshotIdentitySemantics": "vertex-capture-sha256-not-provider-snapshot",
        "availabilitySemantics": "actual-later-acquisition-not-historical-arrival",
        "numericSemantics": "unchanged-sdk-ieee754-bits-no-volume-or-price-unit-conversion",
        "orderingSemantics": "sdk-decoded-receive-order-not-exchange-tie-order",
        "limitations": value["limitations"],
    }), "application/json")
    if max(len(content.data), len(original.data)) > MAX_ARTIFACT_BYTES:
        raise AdapterUnavailable("ibkr-bars-worker-artifact-byte-bound")
    if publication["storage_ref"] in {publication["dataset_id"], "blob-" + original.digest, intent_id}:
        raise AdapterUnavailable("ibkr-bars-publication-identity-collision")
    manifest = boundary.record("DatasetManifest", {
        "schemaVersion": "1.0.0", "datasetId": publication["dataset_id"], "provider": "ibkr",
        "entitlementPolicyId": publication["rights_policy_id"], "instrumentUniverse": [source_id],
        "startAtInclusive": timestamp(window_start), "endAtExclusive": timestamp(window_end),
        "captureTime": now, "dataVintageId": None, "dataVintageStatus": "unavailable", "asOfAt": available_at,
        "adjustmentMethod": "split-adjusted" if what == "TRADES" else "provider-defined",
        "calendar": None, "contentHash": content.digest, "storageRef": publication["storage_ref"],
        "retentionPolicy": publication["retention_policy"], "sources": [identity], "gammaProvenance": None,
        "historicalSemantics": semantics,
    })
    return DatasetPlan(manifest, (content, original), (), (original.digest,), decision.revision)
