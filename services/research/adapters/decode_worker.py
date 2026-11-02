"""Host sandbox entrypoint. Importing does not parse input or start a process.

The host MUST apply process CPU/RSS/wall/output limits before this module starts:
malicious Arrow/PDF compressed inputs can allocate before Python can inspect them.
No parser receives a URL or local filename, and no dynamic code is deserialized.
"""
from __future__ import annotations

import base64
import csv
import io
import json
from importlib.metadata import version
from typing import Any, Mapping

from .ports import AdapterUnavailable


PINNED_PACKAGES = {"pyarrow": "19.0.1", "pypdf": "5.7.0"}


def _pin(name: str) -> None:
    if version(name) != PINNED_PACKAGES[name]:
        raise AdapterUnavailable("decoder-version-unavailable")


def _bounded(value: Any, maximum: int) -> int:
    if type(value) is not int or not 1 <= value <= maximum:
        raise AdapterUnavailable("decoder-bound-invalid")
    return value


def _csv(data: bytes, rows: int, columns: int) -> list[dict[str, Any]]:
    csv.field_size_limit(65536)
    text = data.decode("utf-8-sig", errors="strict")
    if "\x00" in text:
        raise AdapterUnavailable("csv-nul-rejected")
    reader = csv.reader(io.StringIO(text, newline=""), strict=True)
    header = next(reader, None)
    if (not header or len(header) > columns or len(set(header)) != len(header)
            or any(not key or len(key) > 200 or key.strip() != key or any(ord(c) < 32 for c in key) for key in header)):
        raise AdapterUnavailable("csv-header-invalid")
    result = []
    for record in reader:
        if len(result) >= rows or len(record) != len(header):
            raise AdapterUnavailable("csv-shape-or-row-budget")
        # Do not infer financial floats, locale, units, timestamps or missing data.
        # Formula-like text stays untrusted text; nothing is evaluated/exported.
        result.append(dict(zip(header, record, strict=True)))
    return result


def _arrow(data: bytes, rows: int, columns: int) -> list[dict[str, Any]]:
    _pin("pyarrow")
    import pyarrow as pa
    import pyarrow.ipc as ipc
    source = pa.BufferReader(data)
    reader = ipc.open_file(source) if data.startswith(b"ARROW1") else ipc.open_stream(source)
    schema = reader.schema
    names = schema.names
    if not names or len(names) > columns or len(set(names)) != len(names) or any(not key or len(key) > 200 for key in names):
        raise AdapterUnavailable("arrow-schema-invalid")
    for field in schema:
        kind = field.type
        if not (pa.types.is_string(kind) or pa.types.is_large_string(kind) or pa.types.is_boolean(kind)
                or pa.types.is_integer(kind) or pa.types.is_decimal(kind) or pa.types.is_null(kind)
                or pa.types.is_date(kind) or pa.types.is_timestamp(kind)):
            # Floats, extension/dictionary types, binary and nested objects need
            # a separately source-qualified financial interpretation; no coercion.
            raise AdapterUnavailable("arrow-type-unavailable")
        if pa.types.is_timestamp(kind) and kind.tz is None:
            raise AdapterUnavailable("arrow-timezone-unavailable")
    batches = (reader.get_batch(i) for i in range(reader.num_record_batches)) if data.startswith(b"ARROW1") else iter(reader)
    result: list[dict[str, Any]] = []
    for batch in batches:
        if batch.num_rows + len(result) > rows or batch.nbytes > 16_000_000:
            raise AdapterUnavailable("arrow-decoded-budget")
        for offset in range(batch.num_rows):
            row: dict[str, Any] = {}
            for index, field in enumerate(schema):
                scalar = batch.column(index)[offset]
                if not scalar.is_valid:
                    value = None
                elif pa.types.is_decimal(field.type) or pa.types.is_date(field.type) or pa.types.is_timestamp(field.type):
                    value = scalar.cast(pa.string()).as_py()
                else:
                    value = scalar.as_py()
                if isinstance(value, str) and len(value) > 65536:
                    raise AdapterUnavailable("arrow-cell-budget")
                row[field.name] = value
            result.append(row)
    # A file reader is random-access and need not leave its cursor at EOF.
    # File framing is footer-validated by Arrow; streams must consume all bytes.
    if not data.startswith(b"ARROW1") and source.tell() != len(data):
        raise AdapterUnavailable("arrow-trailing-input")
    return result


def _pdf(data: bytes, pages: int, characters: int) -> list[dict[str, Any]]:
    _pin("pypdf")
    from pypdf import PdfReader
    if not data.startswith(b"%PDF-"):
        raise AdapterUnavailable("pdf-signature-invalid")
    reader = PdfReader(io.BytesIO(data), strict=True)
    if reader.is_encrypted:
        raise AdapterUnavailable("pdf-encrypted-unavailable")
    if not 1 <= len(reader.pages) <= pages:
        raise AdapterUnavailable("pdf-page-budget")
    # pypdf extracts text; no JavaScript, attachments, links or embedded programs
    # are executed. No OCR is inferred; image-only pages remain empty/unavailable.
    result, consumed = [], 0
    for number, page in enumerate(reader.pages, 1):
        text = page.extract_text(extraction_mode="plain")
        if not isinstance(text, str):
            raise AdapterUnavailable("pdf-text-unavailable")
        consumed += len(text)
        if consumed > characters:
            raise AdapterUnavailable("pdf-character-budget")
        result.append({"page_number": number, "text": text,
                       "method": "pypdf 5.7.0 plain text extraction; not OCR/layout verification"})
    return result


def dispatch(operation: str, payload: Mapping[str, Any]) -> dict[str, Any]:
    try:
        expected = {"contentBase64", "maximumPages", "maximumCharacters"} if operation == "adapters.decode-pdf" else {"contentBase64", "maximumRows", "maximumColumns"}
        if operation not in ("adapters.decode-csv", "adapters.decode-arrow", "adapters.decode-pdf") or set(payload) != expected:
            raise AdapterUnavailable("decoder-operation-denied")
        encoded = payload["contentBase64"]
        if not isinstance(encoded, str) or not 1 <= len(encoded) <= 42_666_668:
            raise AdapterUnavailable("decoder-input-budget")
        data = base64.b64decode(encoded, validate=True)
        if not 1 <= len(data) <= 32_000_000:
            raise AdapterUnavailable("decoder-input-budget")
        if operation == "adapters.decode-pdf":
            result = _pdf(data, _bounded(payload["maximumPages"], 64), _bounded(payload["maximumCharacters"], 1_000_000))
        else:
            parser = _csv if operation == "adapters.decode-csv" else _arrow
            result = parser(data, _bounded(payload["maximumRows"], 100_000), _bounded(payload["maximumColumns"], 128))
        response = {"status": "completed", "result": result}
        if len(json.dumps(response, ensure_ascii=False, allow_nan=False).encode("utf-8")) > 16_000_000:
            raise AdapterUnavailable("decoder-output-budget")
        return response
    except Exception:
        return {"status": "unavailable", "result": None}


def main() -> int:
    import sys
    # Host separately caps stdin and memory; one request only, never a worker loop.
    try:
        data = sys.stdin.buffer.read(43_000_001)
        if len(data) > 43_000_000:
            raise AdapterUnavailable("decoder-input-budget")
        request = json.loads(data)
        if not isinstance(request, dict) or set(request) != {"operation", "payload"}:
            raise AdapterUnavailable("decoder-envelope-invalid")
        result = dispatch(request["operation"], request["payload"])
    except Exception:
        result = {"status": "unavailable", "result": None}
    sys.stdout.write(json.dumps(result, ensure_ascii=False, allow_nan=False, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
