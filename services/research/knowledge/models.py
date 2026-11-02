"""Internal staging values. Public records remain authoritative v1 contracts."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

from providers.ports import Content, ValidatedRecord


@dataclass(frozen=True)
class Collection:
    collection_id: str
    provider: str
    attribution: str
    source_item_ids: tuple[str, ...]
    identity_status: str
    historical_counts: tuple[tuple[str, int], ...]
    limitations: tuple[str, ...]


COLLECTIONS = {
    "deltatrendtrading": Collection("deltatrendtrading", "youtube", "DeltaTrend Trading", ("U22", "U26", "S-eb5192400e3225"), "documented",
        (("discovered", 98), ("transcripts", 96), ("unavailable", 2)),
        ("Channel UCVdvg3ld-rc4eai_WHquwkg; 98 uploads is an acquisition scope, not all-time completeness.", "Auto captions are not human-verified trading instructions.")),
    "verrillo-aleks": Collection("verrillo-aleks", "youtube", "VerrilloTrading / Aleks Rosme", ("U23", "U26", "S-eb5192400e3225"), "documented",
        (("discovered", 494), ("transcripts", 477), ("unavailable", 17)),
        ("Channel identities remain distinct within the collection; duplicate library locations are not independent sources.", "Editorial 0DTE summaries are not raw transcripts or strategy rules.")),
    "nicholas-crown": Collection("nicholas-crown", "instagram", "Nicholas Crown (profile harvest; uploader conflicts retained)", ("U24", "U26", "S-eb5192400e3225"), "documented",
        (("discovered", 1700), ("transcripts", 1663), ("uniqueTrimmedBodies", 1602), ("duplicateMappings", 61), ("transcriptFailures", 29), ("downloadFailures", 8)),
        ("Uploader attribution is not speaker identification; retain collaboration and authorship conflicts.", "Later reels are separately dated additions; not a complete paid newsletter archive.")),
    "define-your-risk": Collection("define-your-risk", "instagram", "Define Your Risk (captured profile; personal attribution unverified)", ("U25", "U26"), "documented",
        (("discovered", 155), ("transcripts", 153), ("transcriptCaptured", 152), ("duplicateMappings", 1), ("nonVideo", 2)),
        ("Captured profile instagram.com/defineyourrisk; documented acquisition is not all-time completeness or personal identity verification.",
         "Raw transcript files, normalized text and deduplicated views are distinct layers; duplicate mappings are not independent corroboration.",
         "Private catalog registration and local acquisition establish no license, model-use, redistribution or execution rights.")),
    "ssrn": Collection("ssrn", "ssrn", "Paper authors as individually attributed", ("U27", "U37"), "documented", (),
        ("Paper parsing grants no full-text, redistribution, model-use or execution rights.",)),
}


@dataclass(frozen=True)
class Segment:
    locator: str
    text: str
    method: str


@dataclass(frozen=True)
class SourceInput:
    source_id: str
    source_uri: str
    attribution: str
    captured_at: str
    published_at: str | None
    raw_content: bytes | None
    segments: tuple[Segment, ...]
    rights_policy_id: str
    content_class: str
    transcript_quality: str
    source_type: str
    unavailable_reason: str | None = None
    limitations: tuple[str, ...] = ()
    source_metadata_json: bytes = b"{}"
    expected_raw_digest: str | None = None


@dataclass(frozen=True)
class KnowledgePlan:
    collection_id: str
    snapshot_id: str
    expected_snapshot_id: str | None
    imports: tuple[ValidatedRecord, ...]
    evidence: tuple[ValidatedRecord, ...]
    content: tuple[Content, ...]
    manifest: Content
    rights_revisions: tuple[tuple[str, str, str], ...]
    prepared_at: str
    status: str = "staged-only"


@dataclass(frozen=True)
class PublicationReceipt:
    collection_id: str
    snapshot_id: str
    manifest_digest: str
    previous_snapshot_id: str | None
    status: str


class CollectionStore(Protocol):
    """Control adapter must atomically CAS only this collection's active snapshot.

    All KnowledgeImport shards, evidence and content are one transaction/publication;
    identical manifest is idempotent, same snapshot with differing bytes rejects.
    Compare rights_revisions against authoritative revocation state IN the commit.
    Failure leaves active snapshot unchanged; generations remain immutable.
    No global DELETE, content overwrite, shared-table SQL or implicit upload here.
    """
    def publish_collection(self, plan: KnowledgePlan, expected_snapshot_id: str | None) -> PublicationReceipt: ...
    def read_snapshot(self, collection_id: str, snapshot_id: str, maximum_bytes: int) -> KnowledgePlan | None: ...
    def activate_snapshot(self, collection_id: str, snapshot_id: str, expected_snapshot_id: str,
                          manifest_digest: str, rights_revisions: tuple[tuple[str, str, str], ...]) -> PublicationReceipt: ...


@dataclass(frozen=True)
class Citation:
    evidence: ValidatedRecord
    excerpt: str
    content_digest: str


@dataclass(frozen=True)
class RetrievalResult:
    status: str
    collection_id: str
    snapshot_id: str
    citations: tuple[Citation, ...] = ()
    unavailable_sources: tuple[tuple[str, str], ...] = ()
    reason: str | None = None
