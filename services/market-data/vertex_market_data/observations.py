"""Frozen provider-reported observation datasets (fundamentals, chains, analytics).

These payloads are NOT Quote/TradeFlow/Greeks contracts. Source fields without an
explicit unit/semantic binding remain unavailable for economic calculation.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from typing import Any

from providers.boundary import Boundary, BoundaryError, authorize, epoch_ns, exact_decimal, identifier, parse_json, raw_sha256
from providers.ports import Clock, DatasetPlan, ProviderCapture, RightRequest, RightsPort, Unavailable
from .normalization import SourceContext


@dataclass(frozen=True)
class OptionContractObservation:
    expiration_date: str
    strike: str
    right: str
    reported_fields_json: bytes
    missing_fields: tuple[str, ...]
    limitations: tuple[str, ...]


def option_contract(row: dict[str, Any], boundary: Boundary) -> OptionContractObservation:
    """Normalize only the source-backed QuantData chain identity fields.

    No bid/ask/Greek aliases or units are assumed from analytics names.
    """
    expiry = row.get("expirationDate")
    if not isinstance(expiry, str) or date.fromisoformat(expiry).isoformat() != expiry:
        raise BoundaryError("option-expiry-unavailable")
    strike = exact_decimal(row.get("strikePrice"), nonnegative=True)
    right = row.get("contractType")
    if not isinstance(right, str) or right.upper() not in ("CALL", "PUT"):
        raise BoundaryError("option-right-unavailable")
    missing = tuple(key for key in ("bid", "ask", "bidSize", "askSize", "delta", "gamma", "theta", "vega", "rho", "impliedVolatility") if row.get(key) is None)
    return OptionContractObservation(expiry, strike, right.lower(), boundary.encode(row), missing,
        ("Fields are provider-reported; no executable quote, option symbol, Greek scale or pricing unit is inferred.",
         "Unknown field semantics and absent values are unavailable, never zero."))


class ProviderObservationPlanner:
    def __init__(self, *, boundary: Boundary, clock: Clock, rights: RightsPort | None):
        self.boundary, self.clock, self.rights = boundary, clock, rights

    def plan(self, capture: ProviderCapture, context: SourceContext, *, dataset_id: str, storage_ref: str,
             start_at: str, end_at: str, retention_policy: str, field_units: tuple[tuple[str, str], ...] = (),
             unit_source_reference: str | None = None, require_point_in_time: bool = False) -> DatasetPlan | Unavailable:
        try:
            self.boundary.require()
            allowed = {
                "financialdatasets": {"company-facts", "financial-statements", "financial-metrics", "earnings", "filings", "filing-item", "insider-trades", "institutional-holdings", "index-funds", "screener"},
                "quantdata": {"equity-snapshot", "option-chain", "option-flow", "contract-statistics", "open-interest-by-strike", "iv-surface", "option-price"},
            }
            if capture.operation not in allowed.get(capture.provider, set()):
                raise BoundaryError("unsupported-observation-operation")
            if context.data_kind not in ("real", "synthetic") or (context.data_kind == "synthetic") != (context.synthetic_reason is not None):
                raise BoundaryError("observation-synthetic-label-required")
            if len(field_units) > 256 or len({field for field, _ in field_units}) != len(field_units):
                raise BoundaryError("field-unit-budget")
            if field_units and not unit_source_reference:
                raise BoundaryError("unit-source-reference-required")
            if any(not field or not unit or len(field) > 100 or len(unit) > 80 for field, unit in field_units):
                raise BoundaryError("invalid-unit-binding")
            now = self.clock.now()
            if not epoch_ns(start_at) < epoch_ns(end_at) <= epoch_ns(context.as_of_at) <= epoch_ns(capture.received_at) <= epoch_ns(now):
                raise BoundaryError("observation-cutoff-mismatch")
            if require_point_in_time and context.vintage_id is None:
                raise BoundaryError("point-in-time-vintage-unavailable")
            for value in (dataset_id, storage_ref, context.instrument_id, context.calendar, context.snapshot_id, context.source_id, retention_policy):
                identifier(value)
            if raw_sha256(capture.content.data) != capture.content.digest:
                raise BoundaryError("provider-source-digest-mismatch")
            payload = parse_json(capture.content.data, maximum_bytes=16_000_000, maximum_nodes=1_000_000)
            if self.boundary.encode(payload) != capture.normalized_json:
                raise BoundaryError("normalized-observations-not-bound-to-source")
            decision = authorize(self.rights, RightRequest(capture.provider, capture.rights.policy_id, "dataset-stage", now))
            if decision.retention_policy != retention_policy:
                raise BoundaryError("observation-retention-policy-mismatch")
            identity = {"provider": capture.provider, "sourceId": context.source_id, "snapshotId": context.snapshot_id, "contentHash": capture.content.digest}
            observed = {"operation": capture.operation, "source": identity, "providerPayload": payload,
                        "sourceReference": capture.source_reference, "fieldUnits": [list(item) for item in field_units],
                        "unitSourceReference": unit_source_reference, "unboundUnits": "unavailable", "asOfAt": context.as_of_at,
                        "receivedAt": capture.received_at, "dataVintageId": context.vintage_id, "dataKind": context.data_kind,
                        "syntheticReason": context.synthetic_reason, "calendar": context.calendar, "untrustedContent": True,
                        "limitations": list(capture.limitations) + ["Provider observations are not executable quotes or validated trade-side prints."]}
            content = self.boundary.content(self.boundary.encode(observed), "application/json")
            manifest = self.boundary.record("DatasetManifest", {"schemaVersion": "1.0.0", "datasetId": dataset_id, "provider": capture.provider,
                "entitlementPolicyId": decision.policy_id, "instrumentUniverse": [context.instrument_id], "startAtInclusive": start_at,
                "endAtExclusive": end_at, "captureTime": now, "dataVintageId": context.vintage_id,
                "dataVintageStatus": "available" if context.vintage_id is not None else "unavailable", "asOfAt": context.as_of_at,
                "adjustmentMethod": context.adjustment_method, "calendar": context.calendar, "contentHash": content.digest,
                "storageRef": storage_ref, "retentionPolicy": retention_policy, "sources": [identity], "gammaProvenance": None})
            return DatasetPlan(manifest, (content, capture.content), (), (capture.content.digest,), decision.revision)
        except BoundaryError as error:
            return Unavailable(str(error), context.source_id, "Observation staging failed closed; no economic interpretation or entitlement is fabricated.")
        except Exception:
            return Unavailable("observation-dependency-unavailable", context.source_id, "Explicit source, clock, rights and public-contract ports must accept the observation artifact.")
