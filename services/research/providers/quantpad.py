"""QuantPad authorized-input boundary only; no asserted subscription or live equivalence."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Protocol

from .boundary import Boundary, BoundaryError, authorize, epoch_ns, identifier, public_uri
from .ports import Clock, Content, RightRequest, RightsPort, Unavailable


@dataclass(frozen=True)
class AuthorizedHistoricalInput:
    source_id: str
    snapshot_id: str
    operation: str
    format: str
    data: bytes
    public_source_uri: str
    coverage_start: str
    coverage_end: str
    available_at: str
    received_at: str
    vintage_id: str
    calendar: str
    retention_policy: str
    rights_policy_id: str
    expected_digest: str
    # Contents are supplied by a separately authorized caller, never downloaded here.


@dataclass(frozen=True)
class HistoricalCapture:
    input: AuthorizedHistoricalInput
    content: Content
    rows_json: bytes
    rights_revision: str
    limitations: tuple[str, ...]


class HistoricalDecoder(Protocol):
    def decode(self, data: bytes, *, format: str, maximum_rows: int, maximum_columns: int) -> list[dict[str, Any]]: ...


class QuantPadInputBoundary:
    OPERATIONS = frozenset({"universe", "coverage", "symbology", "bars", "ticks"})

    def __init__(self, *, boundary: Boundary, clock: Clock, rights: RightsPort | None, decoder: HistoricalDecoder | None,
                 enabled: bool = False, maximum_bytes: int = 8_000_000, maximum_rows: int = 100_000):
        if not 1 <= maximum_bytes <= 32_000_000 or not 1 <= maximum_rows <= 100_000:
            raise BoundaryError("invalid-input-budget")
        self.boundary, self.clock, self.rights, self.decoder = boundary, clock, rights, decoder
        self.enabled, self.maximum_bytes, self.maximum_rows = enabled, maximum_bytes, maximum_rows

    def accept(self, source: AuthorizedHistoricalInput, *, current_session_start: str) -> HistoricalCapture | Unavailable:
        try:
            if not self.enabled:
                raise BoundaryError("quantpad-entitlement-unavailable")
            self.boundary.require()
            if self.decoder is None:
                raise BoundaryError("historical-format-decoder-unavailable")
            if source.operation not in self.OPERATIONS or source.format not in ("arrow", "csv"):
                raise BoundaryError("unsupported-historical-operation")
            if not isinstance(source.data, bytes) or len(source.data) > self.maximum_bytes:
                raise BoundaryError("input-byte-budget")
            for value in (source.source_id, source.snapshot_id, source.vintage_id, source.calendar, source.retention_policy):
                identifier(value)
            public_uri(source.public_source_uri)
            now = self.clock.now()
            if not (epoch_ns(source.coverage_start) < epoch_ns(source.coverage_end) <= epoch_ns(source.available_at)
                    <= epoch_ns(source.received_at) <= epoch_ns(now)):
                raise BoundaryError("invalid-historical-chronology")
            if epoch_ns(source.coverage_end) > epoch_ns(current_session_start):
                raise BoundaryError("current-session-not-qualified")
            decision = authorize(self.rights, RightRequest("quantpad", source.rights_policy_id, "historical-authorized-input", now, (source.source_id,)))
            if decision.retention_policy != source.retention_policy:
                raise BoundaryError("retention-policy-mismatch")
            content = self.boundary.content(source.data, "text/csv" if source.format == "csv" else "application/vnd.apache.arrow.file")
            if content.digest != source.expected_digest:
                raise BoundaryError("source-digest-mismatch")
            rows = self.decoder.decode(source.data, format=source.format, maximum_rows=self.maximum_rows, maximum_columns=128)
            if not isinstance(rows, list) or len(rows) > self.maximum_rows or any(not isinstance(row, dict) or len(row) > 128 for row in rows):
                raise BoundaryError("decoder-budget-or-shape")
            # Codec rejects binary-float financial values; decoder must return exact strings.
            encoded = self.boundary.encode(rows)
            decision = authorize(self.rights, RightRequest("quantpad", source.rights_policy_id, "historical-authorized-input", self.clock.now(), (source.source_id,)))
            return HistoricalCapture(source, content, encoded, decision.revision,
                                     ("Historical authorized input only; not live-current-session evidence.",
                                      "No price, quota, OPRA, export, model-use, post-cancel retention or V01-V06 equivalence is inferred."))
        except BoundaryError as error:
            return Unavailable(str(error), "quantpad", "Historical input is unavailable until all explicit rights and format ports accept it.")
        except Exception:
            return Unavailable("input-adapter-unavailable", "quantpad", "Historical input adapter failed closed.")


def missing_macro_input() -> Unavailable:
    return Unavailable("macro-source-links-unavailable", "user-macro-links", "Exact user-selected macro links, release vintages and lawful access are unresolved; news is not a substitute.")
