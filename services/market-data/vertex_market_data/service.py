"""Dataset staging without storage writes; unavailable capabilities never imply entitlement."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from providers.boundary import Boundary, BoundaryError, authorize, epoch_ns, identifier, raw_sha256
from providers.ports import Clock, DatasetPlan, ProviderCapture, RightRequest, RightsPort, Unavailable, ValidatedRecord
from .normalization import SourceContext


@dataclass(frozen=True)
class Capability:
    provider: str
    capability: str
    implementation: str
    access: str
    source_item_ids: tuple[str, ...]
    limitations: tuple[str, ...]


def capabilities() -> tuple[Capability, ...]:
    return (
        Capability("financialdatasets", "fundamentals-filings-equity-bars", "source-authored", "disabled", ("U16", "U30", "S-48993f9d5050a6"),
                   ("Injected entitlement/transport/clock required; actual provider access unverified.", "Filing and numeric financial fields require explicit units/publication/vintage semantics.")),
        Capability("quantdata", "equity-bars-option-chain-flow-volatility-analytics", "source-authored", "disabled", ("U16", "U29", "S-396f5efb08adf7"),
                   ("No current provider access or plan rights verified.", "Aggregate analytics are not executable quotes, dealer positions, actual aggressor-side prints or Greeks.")),
        Capability("quantdata", "dark-pool-news-dealer-analytics", "unavailable", "unavailable", ("U29",),
                   ("Required role retained; endpoint/semantics coverage not source-proven in the inspected adapter.",)),
        Capability("quantpad", "historical-authorized-input", "source-authored", "unavailable", ("U28", "S-f607824dbf2fe3"),
                   ("Subscription, usage/export/model/retention rights, coverage, quotas and V01-V06 remain unresolved.", "Current-session data is not eligible.")),
        Capability("user-macro-links", "macro-vintages", "unavailable", "unavailable", ("U13",),
                   ("Exact user links and release/vintage lineage are not supplied; news cannot substitute for measured series.",)),
    )


class DatasetPlanner:
    def __init__(self, *, boundary: Boundary, clock: Clock, rights: RightsPort | None, maximum_bytes: int = 32_000_000):
        if not 1 <= maximum_bytes <= 64_000_000:
            raise BoundaryError("invalid-dataset-budget")
        self.boundary, self.clock, self.rights, self.maximum_bytes = boundary, clock, rights, maximum_bytes

    def plan(self, *, dataset_id: str, storage_ref: str, captures: tuple[ProviderCapture, ...], records: tuple[ValidatedRecord, ...],
             contexts: tuple[SourceContext, ...], start_at: str, end_at: str, as_of_at: str,
             retention_policy: str, require_point_in_time: bool = False) -> DatasetPlan | Unavailable:
        try:
            self.boundary.require()
            identifier(dataset_id)
            identifier(storage_ref)
            identifier(retention_policy)
            if not captures or len(captures) != len(contexts) or len(captures) > 512 or not records or len(records) > 100_000:
                raise BoundaryError("dataset-input-budget")
            providers = {capture.provider for capture in captures}
            policies = {capture.rights.policy_id for capture in captures}
            calendars = {context.calendar for context in contexts}
            vintages = {context.vintage_id for context in contexts}
            adjustments = {context.adjustment_method for context in contexts}
            if len(providers) != 1 or len(policies) != 1 or len(calendars) != 1 or len(vintages) != 1 or len(adjustments) != 1:
                raise BoundaryError("dataset-semantics-must-be-homogeneous")
            vintage = next(iter(vintages))
            if require_point_in_time and vintage is None:
                raise BoundaryError("point-in-time-vintage-unavailable")
            now = self.clock.now()
            if not epoch_ns(start_at) < epoch_ns(end_at) <= epoch_ns(as_of_at) <= epoch_ns(now):
                raise BoundaryError("dataset-chronology-mismatch")
            provider, policy = next(iter(providers)), next(iter(policies))
            decision = authorize(self.rights, RightRequest(provider, policy, "dataset-stage", now))
            if decision.retention_policy != retention_policy:
                raise BoundaryError("dataset-retention-not-authorized")
            sources = []
            source_bindings = set()
            raw = {}
            units = []
            for capture, context in zip(captures, contexts, strict=True):
                if raw_sha256(capture.content.data) != capture.content.digest:
                    raise BoundaryError("raw-provider-digest-mismatch")
                if (not epoch_ns(context.as_of_at) <= epoch_ns(capture.received_at) <= epoch_ns(now)
                        or epoch_ns(context.as_of_at) > epoch_ns(as_of_at)):
                    raise BoundaryError("dataset-source-cutoff-mismatch")
                source = {"provider": provider, "sourceId": context.source_id, "snapshotId": context.snapshot_id, "contentHash": capture.content.digest}
                key = (source["sourceId"], source["snapshotId"], source["contentHash"])
                if key not in source_bindings:
                    sources.append(source)
                    source_bindings.add(key)
                raw[capture.content.digest] = capture.content
                # Add provenance only to newly authored bytes; never upgrade stored content.
                units.append({"sourceId": source["sourceId"], "snapshotId": source["snapshotId"], "contentHash": source["contentHash"],
                              "instrumentId": context.instrument_id, "currency": context.currency, "priceUnit": context.price_unit,
                              "quantityUnit": context.quantity_unit, "calendar": context.calendar, "providerTimezone": context.provider_timezone,
                              "asOfAt": context.as_of_at, "receivedAt": capture.received_at, "dataKind": context.data_kind,
                              "syntheticReason": context.synthetic_reason, "sourceReference": capture.source_reference})
            values = []
            for record in records:
                value = self.boundary.recheck(record)
                if record.contract_name not in ("Candle", "Quote", "TradeFlow", "VolumeProfile"):
                    raise BoundaryError("unsupported-dataset-record")
                identity = value["source"]["identity"]
                if identity["provider"] != provider or (identity["sourceId"], identity["snapshotId"], identity["contentHash"]) not in source_bindings:
                    raise BoundaryError("dataset-record-source-mismatch")
                matched = [item for item in units if item["instrumentId"] == value["instrumentId"]
                           and (item["sourceId"], item["snapshotId"], item["contentHash"])
                           == (identity["sourceId"], identity["snapshotId"], identity["contentHash"])]
                if len(matched) != 1:
                    raise BoundaryError("dataset-record-source-units-unavailable")
                item = matched[0]
                if (value["currency"] != item["currency"] or value["source"]["providerTimezone"] != item["providerTimezone"]
                        or value["source"]["dataKind"] != item["dataKind"] or value["source"]["syntheticReason"] != item["syntheticReason"]
                        or item["priceUnit"] != value["currency"] or item["quantityUnit"] not in ("shares", "contracts", "base-asset")):
                    raise BoundaryError("dataset-record-instrument-or-label-mismatch")
                if value["source"]["entitlement"]["policyId"] != policy:
                    raise BoundaryError("dataset-record-policy-mismatch")
                observed = value.get("sourceTimestamp", value.get("endAtExclusive"))
                begins = value.get("startAtInclusive", observed)
                if epoch_ns(begins) < epoch_ns(start_at) or epoch_ns(observed) > epoch_ns(end_at):
                    raise BoundaryError("dataset-record-outside-window")
                if record.contract_name in ("Quote", "TradeFlow") and epoch_ns(observed) >= epoch_ns(end_at):
                    raise BoundaryError("event-at-exclusive-cutoff")
                if epoch_ns(observed) > epoch_ns(item["asOfAt"]):
                    raise BoundaryError("record-after-source-availability-cutoff")
                values.append({"contract": record.contract_name, "digest": record.digest, "record": value})
            content = self.boundary.content(self.boundary.encode({"records": values, "unitsAndAvailability": units}), "application/json")
            if len(content.data) + sum(len(blob.data) for blob in raw.values()) > self.maximum_bytes:
                raise BoundaryError("dataset-byte-budget")
            manifest = self.boundary.record("DatasetManifest", {"schemaVersion": "1.0.0", "datasetId": dataset_id, "provider": provider,
                "entitlementPolicyId": policy, "instrumentUniverse": sorted({context.instrument_id for context in contexts}),
                "startAtInclusive": start_at, "endAtExclusive": end_at, "captureTime": now, "dataVintageId": vintage,
                "dataVintageStatus": "unavailable" if vintage is None else "available", "asOfAt": as_of_at,
                "adjustmentMethod": next(iter(adjustments)), "calendar": next(iter(calendars)), "contentHash": content.digest,
                "storageRef": storage_ref, "retentionPolicy": retention_policy, "sources": sources, "gammaProvenance": None})
            return DatasetPlan(manifest, (content,) + tuple(raw[key] for key in sorted(raw)), tuple(records), tuple(sorted(raw)), decision.revision)
        except BoundaryError as error:
            return Unavailable(str(error), dataset_id, "No dataset was published; source hashes, canonical artifact identity, units and rights remain distinct.")
        except Exception:
            return Unavailable("dataset-boundary-unavailable", dataset_id, "An authoritative port rejected staging; no inferred data or rights fallback was used.")


@dataclass(frozen=True)
class Measurement:
    field: str
    value: str | None
    unit: str
    fiscal_period: str | None
    published_at: str | None
    vintage_id: str | None
    availability: str


def normalize_measurements(row: dict[str, Any], *, field_units: tuple[tuple[str, str], ...], fiscal_period: str | None,
                           published_at: str | None, vintage_id: str | None, as_of_at: str) -> tuple[Measurement, ...]:
    """Exact financial/fundamental numeric fields only; field/unit mapping is explicit.

    Missing publication/vintage labels stay unknown; these are not certified point-in-time facts.
    """
    from providers.boundary import exact_decimal
    if not 1 <= len(field_units) <= 256 or len({field for field, _ in field_units}) != len(field_units):
        raise BoundaryError("measurement-field-budget")
    epoch_ns(as_of_at)
    if published_at is not None and epoch_ns(published_at) > epoch_ns(as_of_at):
        raise BoundaryError("future-financial-release")
    if vintage_id is not None:
        identifier(vintage_id)
    results = []
    for field, unit in field_units:
        if not field or not unit or len(field) > 100 or len(unit) > 80:
            raise BoundaryError("measurement-unit-required")
        value = row.get(field)
        results.append(Measurement(field, None if value is None else exact_decimal(value), unit, fiscal_period, published_at, vintage_id,
                                   "missing" if value is None else "unknown-vintage" if published_at is None or vintage_id is None else "available"))
    return tuple(results)
