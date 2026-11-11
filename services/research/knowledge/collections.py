"""Explicit caller-supplied collection metadata/content adapters. Never reads a corpus path."""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Callable
from urllib.parse import urlsplit, parse_qs

from providers.boundary import Boundary, BoundaryError, authorize, identifier, parse_json, raw_sha256
from providers.ports import Clock, RightRequest, RightsPort, Unavailable
from .crown_preparation import parse_crown_chunks
from .models import Segment, SourceInput


TranscriptLoader = Callable[[str], bytes | None]
_TIME_LINE = re.compile(r"^\s*(?:\*\*)?\[(\d{1,3}:\d{2}(?::\d{2})?(?:\.\d{1,9})?)\](?:\*\*)?\s*(.+)$", re.MULTILINE)
_VIDEO = re.compile(r"[A-Za-z0-9_-]{11}")
_CAPTION_OCR = "caption/ocr captured"


@dataclass(frozen=True)
class InstagramProfile:
    """Documented Instagram profile identity for the shared run-manifest adapter."""
    collection_id: str
    profile_handle: str
    profile_url: str
    attribution: str
    # Image/carousel posts whose text is caption + local slide OCR ("## Caption and OCR").
    caption_ocr: bool = False


_DEFINE_YOUR_RISK = InstagramProfile("define-your-risk", "defineyourrisk", "https://www.instagram.com/defineyourrisk/",
                                     "DefineYourRisk (profile attribution; speaker unverified)")
_JAY_MEDROW = InstagramProfile("jay-medrow", "jay_medrow", "https://www.instagram.com/jay_medrow/",
                               "Jay Medrow (profile attribution; speaker unverified)", caption_ocr=True)


def youtube_uri(video_id: str, original: str) -> str:
    if _VIDEO.fullmatch(video_id) is None:
        raise BoundaryError("invalid-youtube-identity")
    url = urlsplit(original)
    if url.scheme != "https" or url.username or url.password or url.hostname not in ("www.youtube.com", "youtube.com", "youtu.be"):
        raise BoundaryError("channel-source-url-mismatch")
    actual = url.path.lstrip("/") if url.hostname == "youtu.be" else parse_qs(url.query).get("v", [None])[0]
    if url.path.startswith(("/shorts/", "/embed/")):
        actual = url.path.split("/")[-1]
    if actual != video_id:
        raise BoundaryError("video-source-url-mismatch")
    # Strict v1 evidence URIs exclude query strings; original watch URL remains in metadata.
    return "https://www.youtube.com/embed/" + video_id


def _segments(content: bytes, method: str, maximum: int = 64, *, timed: bool = True) -> tuple[Segment, ...]:
    if len(content) > 2_000_000:
        raise BoundaryError("transcript-byte-budget")
    text = content.decode("utf-8", errors="strict")
    segments = []
    # Untimed sources (caption/slide OCR) never parse "[9:30]"-like text as a media clock.
    for match in (_TIME_LINE.finditer(text) if timed else ()):
        timestamp, prose = match.group(1, 2)
        components = timestamp.split(":")
        if any(int(part.split(".")[0]) >= 60 for part in components[1:]):
            raise BoundaryError("invalid-transcript-clock")
        clean = " ".join(prose.split())
        # Long segments are split, preserving original timestamp and exact text provenance.
        chunks = [clean[index:index + 1800] for index in range(0, len(clean), 1800)]
        for ordinal, chunk in enumerate(chunks):
            if len(segments) >= maximum:
                return tuple(segments)
            segments.append(Segment("timestamp:" + timestamp + ":part:" + str(ordinal), chunk, method))
    if not segments and text.strip():
        # Crown ASR and caption/OCR text can be untimed. Character locators do not invent a video timestamp.
        clean = " ".join(text.split())
        for index in range(0, min(len(clean), maximum * 1800), 1800):
            segments.append(Segment("normalized-char:" + str(index), clean[index:index + 1800], method + "; no timestamp available"))
    return tuple(segments)


def _published(clock: Any) -> str | None:
    # Day-only acquisition metadata remains day precision; never manufacture midnight.
    return clock if isinstance(clock, str) and "T" in clock else None


class CollectionAdapters:
    def __init__(self, boundary: Boundary, *, clock: Clock, rights: RightsPort | None, maximum_ledger_bytes: int = 8_000_000):
        self.boundary, self.clock, self.rights = boundary, clock, rights
        if not 1 <= maximum_ledger_bytes <= 16_000_000:
            raise BoundaryError("invalid-ledger-budget")
        self.maximum_ledger_bytes = maximum_ledger_bytes

    def _authorize_collection(self, collection: str, policy: str) -> None:
        self.boundary.require()
        authorize(self.rights, RightRequest(collection, policy, "collection-import", self.clock.now()))

    def _allowed(self, collection: str, policy: str, source_id: str) -> bool:
        try:
            authorize(self.rights, RightRequest(collection, policy, "source-import", self.clock.now(), (source_id,)))
            return True
        except BoundaryError:
            return False

    def delta_trend(self, manifest_bytes: bytes, load_transcript: TranscriptLoader, *, captured_at: str, rights_policy_id: str) -> tuple[SourceInput, ...] | Unavailable:
        try:
            self._authorize_collection("deltatrendtrading", rights_policy_id)
            manifest = parse_json(manifest_bytes, maximum_bytes=self.maximum_ledger_bytes)
            if manifest.get("channel", {}).get("id") != "UCVdvg3ld-rc4eai_WHquwkg":
                raise BoundaryError("deltatrend-channel-mismatch")
            videos = manifest.get("videos")
            if not isinstance(videos, list) or not 1 <= len(videos) <= 10_000:
                raise BoundaryError("invalid-acquisition-ledger")
            ids = [row["video_id"] for row in videos]
            scope = manifest.get("scope", {})
            catalogs = scope.get("catalogs", [])
            if not catalogs or {video for catalog in catalogs for video in catalog["video_ids"]} != set(ids):
                raise BoundaryError("catalog-membership-mismatch")
            if len(set(ids)) != len(ids) or ("expected_count" in scope and scope["expected_count"] != len(ids)):
                raise BoundaryError("acquisition-count-mismatch")
            result = []
            for row in videos:
                video_id = row["video_id"]
                if row.get("channel_id") != manifest["channel"]["id"] or row.get("status") not in ("ok", "skipped", "blocked"):
                    raise BoundaryError("source-channel-or-status-mismatch")
                uri = youtube_uri(video_id, row["url"])
                source_id = "deltatrend:" + video_id
                allowed = self._allowed("deltatrendtrading", rights_policy_id, source_id)
                content = load_transcript(video_id) if row["status"] == "ok" and allowed else None
                if row["status"] == "ok" and row.get("transcript_file") != video_id + ".md":
                    raise BoundaryError("transcript-file-binding-mismatch")
                reason = "rights-denied" if not allowed else None if content else "provider-unavailable"
                metadata = {"videoId": video_id, "channelId": row["channel_id"], "title": row["title"], "originalUrl": row["url"],
                            "publicationDate": row.get("upload_date"), "originalStatus": row["status"], "originalReason": row.get("reason"),
                            "language": row.get("language"), "captionType": row.get("caption_type"), "acquisitionManifestDigest": raw_sha256(manifest_bytes)}
                result.append(SourceInput(source_id, uri, str(row.get("uploader") or "DeltaTrend Trading"), captured_at,
                    _published(row.get("upload_date")), content, _segments(content, "English auto-caption extraction; unreviewed") if content else (),
                    rights_policy_id, "raw-transcript", "machine-generated" if content else "unavailable", "transcript", reason,
                    ("Publication day is retained separately when a full source timestamp is unavailable.", "At most 64 bounded citation segments; full authorized raw bytes are retained."), self.boundary.encode(metadata)))
            return tuple(result)
        except Exception:
            return Unavailable("deltatrend-input-unavailable", "deltatrendtrading", "Ledger/channel/membership or supplied transcript inputs are invalid; no corpus was read or fetched implicitly.")

    def verrillo_aleks(self, manifest_bytes: bytes, load_transcript: TranscriptLoader, *, captured_at: str, rights_policy_id: str) -> tuple[SourceInput, ...] | Unavailable:
        try:
            self._authorize_collection("verrillo-aleks", rights_policy_id)
            manifest = parse_json(manifest_bytes, maximum_bytes=self.maximum_ledger_bytes)
            if manifest.get("manifest_type") != "combined-raw-corpus" or manifest.get("merge_strategy") != "channel-prefixed-slugs":
                raise BoundaryError("verrillo-manifest-identity-mismatch")
            videos, skipped = manifest.get("videos"), manifest.get("skipped_videos")
            if not isinstance(videos, list) or not isinstance(skipped, list) or not 1 <= len(videos) + len(skipped) <= 10_000:
                raise BoundaryError("invalid-ledger-rows")
            if manifest.get("total_videos") != len(videos) + len(skipped) or manifest.get("transcripts_fetched") != len(videos):
                raise BoundaryError("ledger-count-mismatch")
            result = []
            seen = set()
            for row, available in [(row, True) for row in videos] + [(row, False) for row in skipped]:
                prefix, video_id = row.get("channel_prefix"), row.get("youtube_id")
                if prefix not in ("verrillo", "aleks"):
                    raise BoundaryError("unknown-channel-prefix")
                source_id = identifier(prefix + ":" + video_id)
                if source_id in seen:
                    raise BoundaryError("duplicate-source-mapping")
                seen.add(source_id)
                uri = youtube_uri(video_id, row["url"])
                # Loader takes identity, not the untrusted source path.
                allowed = self._allowed("verrillo-aleks", rights_policy_id, source_id)
                content = load_transcript(source_id) if available and allowed else None
                reason = "rights-denied" if not allowed else None if content else "provider-unavailable"
                metadata = {"videoId": video_id, "channelPrefix": prefix, "channel": row.get("channel"), "uploader": row.get("uploader"),
                            "originalSlug": row.get("original_slug"), "originalUrl": row["url"], "publicationDate": row.get("upload_date") or row.get("published"),
                            "originalStatus": row.get("status"), "originalReason": row.get("reason"), "acquisitionManifestDigest": raw_sha256(manifest_bytes)}
                result.append(SourceInput(source_id, uri, "VerrilloTrading" if prefix == "verrillo" else "Aleks Rosme", captured_at,
                    _published(row.get("published")), content, _segments(content, "Source transcript extraction; ASR unverified") if content else (),
                    rights_policy_id, "raw-transcript", "machine-generated" if content else "unavailable", "transcript", reason,
                    ("A library duplicate is not independent corroboration.", "Only raw inputs are admitted here; semantic summaries require a separate content class.",
                     "At most 64 bounded citation segments; full authorized raw bytes are retained."), self.boundary.encode(metadata)))
            return tuple(result)
        except Exception:
            return Unavailable("verrillo-input-unavailable", "verrillo-aleks", "Combined acquisition identity or supplied inputs could not be bound without ambiguity.")

    def crown(self, bundle_bytes: bytes, *, captured_at: str, rights_policy_id: str) -> tuple[SourceInput, ...] | Unavailable:
        try:
            self._authorize_collection("nicholas-crown", rights_policy_id)
            bundle = parse_json(bundle_bytes, maximum_bytes=self.maximum_ledger_bytes, maximum_nodes=500_000)
            # Prepared envelopes must use the complete-group entry point, even
            # when a caller tries to submit one chunk as a legacy single bundle.
            if not isinstance(bundle, dict) or "preparation" in bundle:
                raise BoundaryError("crown-prepared-group-required")
        except Exception:
            return Unavailable("crown-input-unavailable", "nicholas-crown", "Invalid original Crown bundle; prepared chunks require a complete group.")
        return self._crown_bundle(bundle_bytes, bundle, captured_at=captured_at, rights_policy_id=rights_policy_id)

    def crown_chunks(self, bundle_bytes: tuple[bytes, ...], *, captured_at: str, rights_policy_id: str) -> tuple[SourceInput, ...] | Unavailable:
        try:
            self._authorize_collection("nicholas-crown", rights_policy_id)
            if any(len(chunk) > self.maximum_ledger_bytes for chunk in bundle_bytes):
                raise BoundaryError("crown-chunk-byte-budget")
            bundles = parse_crown_chunks(bundle_bytes)
            result = []
            for content, bundle in zip(bundle_bytes, bundles):
                sources = self._crown_bundle(content, bundle, captured_at=captured_at, rights_policy_id=rights_policy_id)
                if isinstance(sources, Unavailable):
                    return sources
                result.extend(sources)
            return tuple(result)
        except Exception:
            return Unavailable("crown-input-unavailable", "nicholas-crown", "Incomplete, unordered or conflicting Crown chunks; no collection publication occurred.")

    def _crown_bundle(self, bundle_bytes: bytes, bundle: dict[str, Any], *, captured_at: str, rights_policy_id: str) -> tuple[SourceInput, ...] | Unavailable:
        try:
            documents = bundle.get("documents")
            if not isinstance(documents, list) or not 1 <= len(documents) <= 10_000:
                raise BoundaryError("invalid-crown-bundle")
            bundle_digest = raw_sha256(bundle_bytes)
            source_metadata_digest = (raw_sha256(self.boundary.encode(bundle["sourceMetadata"]))
                                      if "preparation" in bundle else None)
            result = []
            seen = set()
            for row in documents:
                source_id = identifier(row["sourceId"])
                if source_id in seen:
                    raise BoundaryError("duplicate-crown-source")
                seen.add(source_id)
                url = urlsplit(row["sourceUrl"])
                if url.scheme != "https" or url.username or url.password or url.hostname not in ("instagram.com", "www.instagram.com") or url.query or url.fragment:
                    raise BoundaryError("crown-public-source-url-required")
                metadata = row.get("metadata") or {}
                status = metadata.get("status")
                body = row.get("body")
                if not isinstance(body, str):
                    raise BoundaryError("crown-body-type")
                transcript = metadata.get("transcript")
                allowed = self._allowed("nicholas-crown", rights_policy_id, source_id)
                content = None
                reason = "rights-denied" if not allowed else "raw-transcript-unavailable"
                if allowed and status == "transcribed" and isinstance(transcript, str) and transcript.strip():
                    # Legacy body is a search composite: transcript + caption + description.
                    # Its dedicated ASR field has a separately declared hash contract.
                    if metadata.get("hashBasis") != "exact trimmed transcript UTF-8":
                        reason = "transcript-hash-contract-unavailable"
                    elif raw_sha256(transcript.encode("utf-8")) != metadata.get("bodySha256"):
                        reason = "transcript-digest-mismatch"
                    else:
                        content, reason = transcript.encode("utf-8"), None
                original = {"title": row["title"], "shortcode": row.get("shortcode"), "sourceIds": row.get("sourceIds"),
                            "authorship": metadata.get("authorship"), "status": status, "publicationDate": metadata.get("publicationDate"),
                            "collectedAt": row.get("collectedAt"), "downloadedAt": metadata.get("downloadedAt"), "transcribedAt": metadata.get("transcribedAt"),
                            "duplicateSourceIds": metadata.get("duplicateSourceIds"), "originalBodyDigest": raw_sha256(body.encode("utf-8")),
                            "trimmedBodyDigest": raw_sha256(body.strip().encode("utf-8")), "bundleDigest": bundle_digest,
                            "transcriptDigest": raw_sha256(content) if content is not None else None,
                            "declaredTranscriptDigest": metadata.get("bodySha256"), "transcriptHashBasis": metadata.get("hashBasis"),
                            "caption": metadata.get("caption"), "captionSnippet": metadata.get("captionSnippet"), "description": metadata.get("description"),
                            "provenanceFiles": metadata.get("provenanceFiles"), "inventorySource": metadata.get("inventorySource"),
                            "originalCollection": metadata.get("collection"), "failureReason": metadata.get("failureReason"),
                            "publicationDatePrecision": metadata.get("publicationDatePrecision"), "publicationEvidence": metadata.get("publicationEvidence"),
                            "discoveryCaptures": metadata.get("discoveryCaptures"), "collectedAtBasis": metadata.get("collectedAtBasis"),
                            "durationSeconds": metadata.get("durationSeconds"), "warnings": metadata.get("warnings")}
                if "preparation" in bundle:
                    original["preparation"] = bundle["preparation"]
                    # Root metadata remains intact in the pinned chunk. Repeating
                    # the acquisition-wide header per source would consume the
                    # collection's unchanged aggregate metadata budget.
                    original["sourceBundleMetadataDigest"] = source_metadata_digest
                    original["sourceBundleMetadataLocation"] = "sourceMetadata in preparedArtifactDigest"
                    original["preparedArtifactDigest"] = bundle_digest
                    original["preparationBasis"] = (
                        "Transformed exact-source JSON; decimal scalars normalized to exact decimal strings. "
                        "sourceBundleDigest is an original-acquisition provenance claim, not revalidated from chunk bytes."
                    )
                result.append(SourceInput(source_id, row["sourceUrl"], str(row.get("author") or "Nicholas Crown (uploader not speaker proof)"),
                    captured_at, _published(row.get("publishedAt")), content, _segments(content, str(row.get("method") or "Automatic speech recognition")) if content else (),
                    rights_policy_id, "raw-transcript", "machine-generated" if content else "unavailable", "transcript", reason,
                    ("ASR body, uploader, captions and collaboration metadata may conflict; do not infer corrected attribution.",
                     "Only the dedicated prepared ASR body is cited; original Markdown file bytes are not supplied by this bundle.",
                     "Composite-body and transcript digests are distinct; hash reuse never merges source identities.",
                     "At most 64 bounded citations; full supplied ASR bytes retained."), self.boundary.encode(original),
                    metadata.get("bodySha256") if content is not None else None))
            return tuple(result)
        except Exception:
            return Unavailable("crown-input-unavailable", "nicholas-crown", "Crown source mappings or clocks could not be bound; no global knowledge replacement occurred.")

    def define_your_risk(self, manifest_bytes: bytes, load_transcript: TranscriptLoader, *, captured_at: str, rights_policy_id: str) -> tuple[SourceInput, ...] | Unavailable:
        return self._instagram_profile(_DEFINE_YOUR_RISK, manifest_bytes, load_transcript, captured_at=captured_at, rights_policy_id=rights_policy_id)

    def jay_medrow(self, manifest_bytes: bytes, load_transcript: TranscriptLoader, *, captured_at: str, rights_policy_id: str) -> tuple[SourceInput, ...] | Unavailable:
        return self._instagram_profile(_JAY_MEDROW, manifest_bytes, load_transcript, captured_at=captured_at, rights_policy_id=rights_policy_id)

    def _instagram_profile(self, spec: InstagramProfile, manifest_bytes: bytes, load_transcript: TranscriptLoader, *, captured_at: str,
                           rights_policy_id: str) -> tuple[SourceInput, ...] | Unavailable:
        prefix = spec.collection_id
        try:
            self._authorize_collection(spec.collection_id, rights_policy_id)
            manifest = parse_json(manifest_bytes, maximum_bytes=self.maximum_ledger_bytes)
            if (type(manifest.get("schema_version")) is not int or manifest["schema_version"] != 1
                    or manifest.get("profile_handle") != spec.profile_handle
                    or manifest.get("profile_url") != spec.profile_url):
                raise BoundaryError(prefix + "-manifest-identity-mismatch")
            hash_contract = manifest.get("hash_contract", {})
            if (hash_contract.get("algorithm") != "SHA-256" or hash_contract.get("encoding") != "UTF-8"
                    or hash_contract.get("transcript_sha256") != "SHA-256 of the complete on-disk file bytes at transcript_path, including its final LF."):
                raise BoundaryError(prefix + "-hash-contract-unavailable")
            items = manifest.get("items")
            if not isinstance(items, list) or not 1 <= len(items) <= 1000:
                raise BoundaryError("invalid-" + prefix + "-ledger")
            by_id = {identifier(row["source_id"]): row for row in items}
            if len(by_id) != len(items):
                raise BoundaryError("duplicate-source-mapping")
            statuses = {"transcript captured": "transcript_captured", "duplicate": "duplicate", "non-video": "non_video"}
            expected_counts = {"discovered": len(items), "transcript_count": 0, "transcript_captured": 0,
                               "duplicate": 0, "non_video": 0, "unresolved": 0, "pending": 0}
            if spec.caption_ocr:
                statuses[_CAPTION_OCR] = "caption_ocr_captured"
                expected_counts["caption_ocr_captured"] = 0
            for row in items:
                status = row.get("terminal_status")
                if status not in statuses:
                    raise BoundaryError(prefix + "-source-format-unavailable")
                expected_counts[statuses[status]] += 1
                if status not in ("non-video", _CAPTION_OCR):
                    expected_counts["transcript_count"] += 1
            counts = manifest.get("counts", {})
            if any(type(counts.get(key)) is not int or counts[key] != value for key, value in expected_counts.items()):
                raise BoundaryError(prefix + "-count-mismatch")
            result = []
            for source_id, row in by_id.items():
                shortcode = row["shortcode"]
                if not isinstance(shortcode, str) or re.fullmatch(r"[A-Za-z0-9_-]{1,128}", shortcode) is None or source_id != "ig-" + shortcode:
                    raise BoundaryError(prefix + "-source-identity-mismatch")
                uri = row["canonical_url"]
                url = urlsplit(uri)
                if (url.scheme != "https" or url.netloc not in ("instagram.com", "www.instagram.com")
                        or url.query or url.fragment or url.path not in ("/p/" + shortcode + "/", "/reel/" + shortcode + "/")):
                    raise BoundaryError(prefix + "-source-url-mismatch")
                status = row["terminal_status"]
                available = status != "non-video"
                ocr = status == _CAPTION_OCR
                if (row.get("source_type") not in ("image", "carousel") if ocr
                        else row.get("source_type") != ("video" if available else "non-video")):
                    raise BoundaryError(prefix + "-source-type-mismatch")
                digest = row.get("transcript_sha256")
                if available:
                    if (row.get("transcript_path") != "transcripts/" + shortcode + ".md"
                            or not isinstance(digest, str) or re.fullmatch(r"[a-f0-9]{64}", digest) is None
                            or not isinstance(row.get("normalized_text_sha256"), str)
                            or re.fullmatch(r"[a-f0-9]{64}", row["normalized_text_sha256"]) is None
                            or not isinstance(row.get("normalized_path"), str) or not row["normalized_path"]
                            or not isinstance(row.get("deduplicated_path"), str) or not row["deduplicated_path"]
                            or not isinstance(row.get("extraction_method"), str) or not row["extraction_method"]):
                        raise BoundaryError(prefix + "-transcript-binding-mismatch")
                elif any(row.get(key) is not None for key in ("transcript_path", "transcript_sha256", "normalized_path",
                         "normalized_text_sha256", "deduplicated_path", "duplicate_of")):
                    raise BoundaryError(prefix + "-nonvideo-transcript-mismatch")
                if status == "duplicate":
                    canonical = by_id.get(row.get("duplicate_of"))
                    if (canonical is None or canonical is row or canonical.get("terminal_status") != "transcript captured"
                            or canonical.get("deduplicated_path") != row["deduplicated_path"]
                            or canonical.get("normalized_text_sha256") != row["normalized_text_sha256"]):
                        raise BoundaryError(prefix + "-duplicate-binding-mismatch")
                elif row.get("duplicate_of") is not None:
                    raise BoundaryError(prefix + "-duplicate-binding-mismatch")
                allowed = self._allowed(spec.collection_id, rights_policy_id, source_id)
                # Identity-keyed, acquired/pinned bytes only. Paths above are provenance,
                # never arguments to filesystem access or substitutes for the raw file.
                content = load_transcript(source_id) if available and allowed else None
                reason = "rights-denied" if not allowed else "non-video-source" if not available else "raw-transcript-unavailable"
                segments = ()
                if content is not None:
                    if not isinstance(content, bytes) or len(content) > 2_000_000 or raw_sha256(content) != digest:
                        raise BoundaryError(prefix + "-raw-digest-mismatch")
                    text = content.decode("utf-8", errors="strict")
                    marker = "## Caption and OCR\n\n" if ocr else "## Transcript\n\n"
                    # Hash the entire original wrapper, but cite only the transcript (or, for OCR
                    # rows, the caption + slide OCR) section; never metadata or a normalized/dedup
                    # file. Caption/OCR text is never promoted to speech.
                    if text.count(marker) != 1 or not text.endswith("\n"):
                        content, reason = None, "transcript-section-unavailable"
                    else:
                        body = text.split(marker, 1)[1]
                        if not body.strip() or "\n## " in body:
                            content, reason = None, "transcript-section-unavailable"
                        else:
                            section, review = ("Caption and OCR", "; caption + local OCR unreviewed") if ocr else ("Transcript", "; ASR unreviewed")
                            segments = tuple(Segment("markdown-section:" + section + ":" + segment.locator, segment.text, segment.method)
                                             for segment in _segments(body.encode("utf-8"), row["extraction_method"] + review, timed=not ocr))
                            reason = None
                original_source = {key: row.get(key) for key in ("source_id", "shortcode", "canonical_url", "source_type",
                    "published_at_utc", "surfaces", "terminal_status", "extraction_method", "transcript_path", "transcript_sha256",
                    "normalized_path", "normalized_text_sha256", "deduplicated_path", "duplicate_of", "unresolved_reason")}
                original_hash_contract = {key: hash_contract.get(key) for key in ("algorithm", "encoding", "transcript_sha256",
                    "normalized_text_sha256", "normalized_body_locator", "normalization_steps", "deduplication_key")}
                metadata = {"originalSource": original_source, "acquisitionManifestDigest": raw_sha256(manifest_bytes),
                            "profileHandle": manifest["profile_handle"], "profileUrl": manifest["profile_url"], "runId": manifest.get("run_id"),
                            "sourceScope": manifest.get("scope"), "sourceStartedAt": manifest.get("started_at_utc"),
                            "sourceCompletedAt": manifest.get("completed_at_utc"), "hashContract": original_hash_contract,
                            "citationBodyLocator": ("Markdown section ## Caption and OCR" if ocr else "Markdown section ## Transcript") + "; locators relative to section body",
                            "normalizedAndDeduplicatedContentLoaded": False}
                # OCR rows stay "raw-transcript"/"transcript": service.py rejects mixed content classes
                # within a collection and vertex.ts limits sourceType; non-speech is carried by the
                # method, the Caption and OCR locator section and the limitations below.
                result.append(SourceInput(source_id, uri, spec.attribution, captured_at,
                    _published(row.get("published_at_utc")), content, segments, rights_policy_id, "raw-transcript",
                    "machine-generated" if content is not None else "unavailable", "transcript", reason,
                    ("Run membership is a captured profile snapshot, not all-time completeness or a rights grant.",
                     "Raw file hash includes Markdown metadata and final LF; citations cover only the ## Caption and OCR section.",
                     "Normalized-body and deduplication hashes are distinct source assertions, not verified raw-file hashes.",
                     "Duplicate identities retain their own raw files and URLs; at most 64 bounded citation segments.",
                     "Caption and local slide OCR text is machine-extracted, unreviewed and not speech.") if ocr else
                    ("Run membership is a captured profile snapshot, not all-time completeness or a rights grant.",
                     "Raw file hash includes Markdown metadata and final LF; citations exclude caption/metadata.",
                     "Normalized-body and deduplication hashes are distinct source assertions, not verified raw-file hashes.",
                     "Duplicate identities retain their own raw files and URLs; at most 64 bounded citation segments.",
                     "ASR completion is not transcript accuracy, speaker validation or human acceptance."),
                    self.boundary.encode(metadata),
                    digest if content is not None else None))
            return tuple(result)
        except Exception:
            return Unavailable(prefix + "-input-unavailable", spec.collection_id,
                               "Unsupported run-manifest/hash/identity mapping, denied rights, or invalid supplied raw bytes; no paths were opened implicitly.")
