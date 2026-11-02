"""Pure Crown JSON preparation; no paths, IO, acquisition, rights or publication.

Chunk bytes are a transformation, NOT the original acquired byte identity. The
exact-source parser normalizes decimal/large numeric scalars to exact decimal
strings; all source fields and document order are otherwise retained. A chunk's
sourceBundleDigest is provenance asserted by the preparer, not proof that a
consumer of the chunks has revalidated the unavailable original acquired bytes.
"""
from __future__ import annotations

import json
import re
from typing import Any

from providers.boundary import BoundaryError, identifier, parse_json, raw_sha256


MAXIMUM_CHUNK_BYTES = 1_048_576
MAXIMUM_GROUP_BYTES = 16_000_000
MAXIMUM_CHUNKS = 32
MAXIMUM_DOCUMENTS = 10_000
_PREPARATION_KEYS = frozenset({"format", "sourceBundleDigest", "sourceDocumentCount", "chunkIndex", "chunkCount"})
_CHUNK_KEYS = frozenset({"preparation", "sourceMetadata", "documents"})
_FORMAT = "vertex-crown-chunk-v1"


def _encode(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")


def _documents(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list) or not 1 <= len(value) <= MAXIMUM_DOCUMENTS:
        raise BoundaryError("invalid-crown-bundle")
    seen: set[str] = set()
    for row in value:
        if not isinstance(row, dict):
            raise BoundaryError("invalid-crown-document")
        source_id = identifier(row.get("sourceId"))
        if source_id in seen:
            raise BoundaryError("duplicate-crown-source")
        seen.add(source_id)
    return value


def prepare_crown_chunks(source_bytes: bytes) -> tuple[bytes, ...]:
    """Return deterministic complete chunks, or reject; never truncate a field.

    Hash the actual acquired bytes before exact-scalar normalization. Bounds are
    fixed, not caller-widenable. Original root fields live only in sourceMetadata
    (including source-level counts), never masquerading as chunk-level counts.
    """
    source = parse_json(source_bytes, maximum_bytes=MAXIMUM_GROUP_BYTES, maximum_nodes=500_000)
    if not isinstance(source, dict) or "preparation" in source:
        raise BoundaryError("invalid-crown-original-bundle")
    documents = _documents(source.get("documents"))
    source_metadata = {key: value for key, value in source.items() if key != "documents"}
    preparation = {"format": _FORMAT, "sourceBundleDigest": raw_sha256(source_bytes),
                   "sourceDocumentCount": len(documents), "chunkIndex": MAXIMUM_CHUNKS - 1,
                   "chunkCount": MAXIMUM_CHUNKS}
    # Reserve the largest legal index/count spelling so final headers only shrink.
    header_size = len(_encode({"preparation": preparation, "sourceMetadata": source_metadata, "documents": []}))
    if header_size >= MAXIMUM_CHUNK_BYTES:
        raise BoundaryError("crown-chunk-header-budget")
    groups: list[list[dict[str, Any]]] = []
    current: list[dict[str, Any]] = []
    size = header_size
    for document in documents:
        document_size = len(_encode(document))
        if header_size + document_size > MAXIMUM_CHUNK_BYTES:
            raise BoundaryError("crown-single-document-budget")
        if current and size + 1 + document_size > MAXIMUM_CHUNK_BYTES:
            groups.append(current)
            if len(groups) >= MAXIMUM_CHUNKS:
                raise BoundaryError("crown-chunk-count-budget")
            current, size = [], header_size
        size += document_size + (1 if current else 0)
        current.append(document)
    groups.append(current)
    chunks = tuple(_encode({"preparation": {**preparation, "chunkIndex": index, "chunkCount": len(groups)},
                            "sourceMetadata": source_metadata, "documents": group})
                   for index, group in enumerate(groups))
    # Also enforce the consumer's structure/depth envelope after wrapping fields.
    parse_crown_chunks(chunks)
    return chunks


def parse_crown_chunks(chunks: tuple[bytes, ...]) -> tuple[dict[str, Any], ...]:
    """Validate a complete ordered transformed group, not the original blob SHA.

    Each supplied chunk must already be bound to its own reviewed artifact digest
    by the caller. Matching origin claims alone confer no authenticity or rights.
    """
    if not isinstance(chunks, tuple) or not 1 <= len(chunks) <= MAXIMUM_CHUNKS:
        raise BoundaryError("crown-chunk-count-budget")
    if any(not isinstance(chunk, bytes) or len(chunk) > MAXIMUM_CHUNK_BYTES for chunk in chunks):
        raise BoundaryError("crown-chunk-byte-budget")
    if sum(map(len, chunks)) > MAXIMUM_GROUP_BYTES:
        raise BoundaryError("crown-chunk-aggregate-budget")
    parsed: list[dict[str, Any]] = []
    origin: tuple[str, int, bytes] | None = None
    seen: set[str] = set()
    for index, chunk in enumerate(chunks):
        bundle = parse_json(chunk, maximum_bytes=MAXIMUM_CHUNK_BYTES, maximum_nodes=500_000)
        if not isinstance(bundle, dict) or set(bundle) != _CHUNK_KEYS:
            raise BoundaryError("invalid-crown-chunk-envelope")
        preparation = bundle["preparation"]
        if not isinstance(preparation, dict) or set(preparation) != _PREPARATION_KEYS:
            raise BoundaryError("invalid-crown-chunk-preparation")
        digest = preparation["sourceBundleDigest"]
        count = preparation["sourceDocumentCount"]
        if (preparation["format"] != _FORMAT or not isinstance(digest, str)
                or re.fullmatch(r"[0-9a-f]{64}", digest) is None
                or type(count) is not int or not 1 <= count <= MAXIMUM_DOCUMENTS
                or type(preparation["chunkIndex"]) is not int or preparation["chunkIndex"] != index
                or type(preparation["chunkCount"]) is not int or preparation["chunkCount"] != len(chunks)):
            raise BoundaryError("crown-chunk-membership-mismatch")
        metadata = bundle["sourceMetadata"]
        if not isinstance(metadata, dict) or "documents" in metadata or "preparation" in metadata:
            raise BoundaryError("invalid-crown-source-metadata")
        current_origin = (digest, count, _encode(metadata))
        if origin is not None and current_origin != origin:
            raise BoundaryError("crown-chunk-origin-mismatch")
        origin = current_origin
        for document in _documents(bundle["documents"]):
            source_id = document["sourceId"]
            if source_id in seen:
                raise BoundaryError("duplicate-crown-source")
            seen.add(source_id)
            if len(seen) > count:
                raise BoundaryError("crown-chunk-document-count-mismatch")
        parsed.append(bundle)
    if origin is None or len(seen) != origin[1]:
        raise BoundaryError("crown-chunk-document-count-mismatch")
    return tuple(parsed)
