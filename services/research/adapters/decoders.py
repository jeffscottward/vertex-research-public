"""Authorized-byte decoders, dispatched through the host's bounded sandbox."""
from __future__ import annotations

import base64
from typing import Any

from knowledge.papers import ParsedPage, SuppliedTextParser
from .ports import AdapterUnavailable, Cancellation, Clock, Supervisor


class IsolatedDecoders:
    def __init__(self, *, supervisor: Supervisor, clock: Clock,
                 cancellation: Cancellation, deadline_ns: int):
        self.supervisor, self.clock = supervisor, clock
        self.cancellation, self.deadline_ns = cancellation, deadline_ns

    def _call(self, operation: str, data: bytes, limits: dict[str, int]) -> Any:
        if (not isinstance(data, bytes) or not 1 <= len(data) <= 32_000_000
                or self.cancellation.cancelled() or self.clock.now_ns() >= self.deadline_ns):
            raise AdapterUnavailable("decoder-input-unavailable")
        reply = self.supervisor.call(operation, {
            "contentBase64": base64.b64encode(data).decode("ascii"), **limits,
        }, deadline_ns=min(self.deadline_ns, self.clock.now_ns() + 30_000_000_000), max_output_bytes=16_000_000)
        if self.cancellation.cancelled() or self.clock.now_ns() >= self.deadline_ns:
            raise AdapterUnavailable("decoder-cancelled")
        if not isinstance(reply, dict) or set(reply) != {"status", "result"} or reply["status"] != "completed":
            raise AdapterUnavailable("decoder-unavailable")
        return reply["result"]

    def decode(self, data: bytes, *, format: str, maximum_rows: int, maximum_columns: int) -> list[dict[str, Any]]:
        if format not in ("csv", "arrow") or type(maximum_rows) is not int or not 1 <= maximum_rows <= 100_000 or type(maximum_columns) is not int or not 1 <= maximum_columns <= 128:
            raise AdapterUnavailable("decoder-bounds-invalid")
        result = self._call("adapters.decode-" + format, data, {"maximumRows": maximum_rows, "maximumColumns": maximum_columns})
        if (not isinstance(result, list) or len(result) > maximum_rows
                or any(not isinstance(row, dict) or len(row) > maximum_columns for row in result)):
            raise AdapterUnavailable("decoder-output-invalid")
        for row in result:
            for key, value in row.items():
                if not isinstance(key, str) or not 1 <= len(key) <= 200 or value is not None and type(value) not in (str, bool, int):
                    raise AdapterUnavailable("decoder-scalar-invalid")
                if isinstance(value, str) and len(value) > 65536:
                    raise AdapterUnavailable("decoder-cell-budget")
        return result

    def parse(self, data: bytes, media_type: str, *, maximum_pages: int, maximum_characters: int) -> tuple[ParsedPage, ...]:
        if type(maximum_pages) is not int or not 1 <= maximum_pages <= 64 or type(maximum_characters) is not int or not 1 <= maximum_characters <= 1_000_000:
            raise AdapterUnavailable("paper-bounds-invalid")
        if media_type == "text/plain":
            if not isinstance(data, bytes) or not 1 <= len(data) <= 32_000_000 or self.cancellation.cancelled() or self.clock.now_ns() >= self.deadline_ns:
                raise AdapterUnavailable("paper-input-unavailable")
            return SuppliedTextParser().parse(data, media_type, maximum_pages=maximum_pages, maximum_characters=maximum_characters)
        if media_type != "application/pdf":
            raise AdapterUnavailable("paper-format-unavailable")
        result = self._call("adapters.decode-pdf", data, {"maximumPages": maximum_pages, "maximumCharacters": maximum_characters})
        if not isinstance(result, list) or not 1 <= len(result) <= maximum_pages:
            raise AdapterUnavailable("paper-output-invalid")
        pages = []
        for number, row in enumerate(result, 1):
            if (not isinstance(row, dict) or set(row) != {"page_number", "text", "method"}
                    or type(row["page_number"]) is not int or row["page_number"] != number
                    or not isinstance(row["text"], str) or not isinstance(row["method"], str)):
                raise AdapterUnavailable("paper-output-invalid")
            pages.append(ParsedPage(**row))
        if sum(len(p.text) for p in pages) > maximum_characters:
            raise AdapterUnavailable("paper-character-budget")
        return tuple(pages)
