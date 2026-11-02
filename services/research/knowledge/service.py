"""Offline collection import planning; publication/retrieval use explicit control ports."""
from __future__ import annotations

import re
from collections import defaultdict
from typing import Any

from providers.boundary import Boundary, BoundaryError, authorize, epoch_ns, identifier, parse_json, plain_text, public_uri, raw_sha256
from providers.ports import Clock, Content, RightRequest, RightsPort, Unavailable, ValidatedRecord
from .models import COLLECTIONS, Citation, CollectionStore, KnowledgePlan, PublicationReceipt, RetrievalResult, SourceInput


_UNAVAILABLE = {"not-found", "rights-denied", "provider-unavailable", "unsupported-format", "unknown"}
# Only known collection-adapter rejections map to the public v1 categories.
# The original code is retained in immutable membership, never as evidence.
_ADAPTER_UNAVAILABLE = {
    ("nicholas-crown", "raw-transcript-unavailable"): "not-found",
    ("nicholas-crown", "transcript-hash-contract-unavailable"): "unsupported-format",
    ("nicholas-crown", "transcript-digest-mismatch"): "unknown",
    ("define-your-risk", "raw-transcript-unavailable"): "not-found",
    ("define-your-risk", "non-video-source"): "unsupported-format",
    ("define-your-risk", "transcript-section-unavailable"): "unsupported-format",
}
_CLASSES = {"raw-transcript", "editorial-summary", "derived-embedding", "paper", "article"}
_QUALITY = {"human-verified", "machine-generated", "partial", "unavailable", "not-applicable", "unknown"}


class KnowledgeService:
    def __init__(self, *, boundary: Boundary, clock: Clock, rights: RightsPort | None, store: CollectionStore | None = None,
                 maximum_sources: int = 10_000, maximum_bytes: int = 32_000_000, maximum_segments: int = 64):
        if not 1 <= maximum_sources <= 10_000 or not 1 <= maximum_bytes <= 64_000_000 or not 1 <= maximum_segments <= 64:
            raise BoundaryError("invalid-knowledge-budget")
        self.boundary, self.clock, self.rights, self.store = boundary, clock, rights, store
        self.maximum_sources, self.maximum_bytes, self.maximum_segments = maximum_sources, maximum_bytes, maximum_segments

    def plan(self, collection_id: str, snapshot_id: str, sources: tuple[SourceInput, ...], *, rights_policy_id: str,
             expected_snapshot_id: str | None = None) -> KnowledgePlan | Unavailable:
        try:
            self.boundary.require()
            collection = COLLECTIONS.get(collection_id)
            if collection is None or collection.identity_status != "documented":
                raise BoundaryError("collection-identity-unavailable")
            identifier(snapshot_id)
            identifier(rights_policy_id)
            if expected_snapshot_id is not None:
                identifier(expected_snapshot_id)
            if not sources or len(sources) > self.maximum_sources or len({source.source_id for source in sources}) != len(sources):
                raise BoundaryError("invalid-source-membership")
            classes = {source.content_class for source in sources}
            qualities = {source.transcript_quality for source in sources}
            if len(classes) != 1:
                raise BoundaryError("mixed-content-classes-require-separate-snapshots")
            aggregate_quality = next(iter(qualities)) if len(qualities) == 1 else "partial"
            now = self.clock.now()
            decision = authorize(self.rights, RightRequest(collection_id, rights_policy_id, "collection-import", now))
            revisions = [("collection", rights_policy_id, decision.revision)]
            identities: dict[str, dict[str, str]] = {}
            available: dict[tuple[str, str, str], list[dict[str, str]]] = defaultdict(list)
            unavailable: dict[tuple[str, str, str], list[dict[str, str]]] = defaultdict(list)
            blobs: dict[str, Content] = {}
            evidence: list[ValidatedRecord] = []
            membership: list[dict[str, Any]] = []
            consumed = 0
            evidence_bytes = 0
            for source in sorted(sources, key=lambda row: row.source_id):
                identifier(source.source_id)
                if source.source_id == "collection":
                    raise BoundaryError("reserved-source-identity")
                identifier(source.rights_policy_id)
                public_uri(source.source_uri)
                plain_text(source.attribution, 200)
                if source.content_class not in _CLASSES or source.transcript_quality not in _QUALITY:
                    raise BoundaryError("invalid-source-classification")
                if epoch_ns(source.captured_at) > epoch_ns(now) or (source.published_at is not None and epoch_ns(source.published_at) > epoch_ns(source.captured_at)):
                    raise BoundaryError("invalid-source-chronology")
                if len(source.segments) > self.maximum_segments or len(source.limitations) > 50:
                    raise BoundaryError("source-citation-budget")
                metadata = parse_json(source.source_metadata_json, maximum_bytes=64_000, maximum_nodes=4000)
                consumed += len(source.source_metadata_json) + (len(source.raw_content) if source.raw_content is not None else 0)
                if consumed > self.maximum_bytes:
                    raise BoundaryError("collection-byte-budget")
                group = (source.content_class, aggregate_quality, rights_policy_id)
                entry: dict[str, Any] = {"sourceId": source.source_id, "sourceUri": source.source_uri, "metadata": metadata,
                                         "capturedAt": source.captured_at, "publishedAt": source.published_at,
                                         "rightsPolicyId": source.rights_policy_id, "contentClass": source.content_class}
                reason = source.unavailable_reason
                if reason is not None and reason not in _UNAVAILABLE:
                    reason = _ADAPTER_UNAVAILABLE.get((collection_id, reason))
                    if reason is None:
                        raise BoundaryError("invalid-unavailable-reason")
                    entry["sourceUnavailableReason"] = source.unavailable_reason
                if source.raw_content is None:
                    reason = reason or "unknown"
                if reason is None:
                    try:
                        source_rights = authorize(self.rights, RightRequest(collection_id, source.rights_policy_id, "source-import", now, (source.source_id,)))
                    except BoundaryError:
                        reason = "rights-denied"
                    else:
                        revisions.append((source.source_id, source.rights_policy_id, source_rights.revision))
                if reason is not None:
                    unavailable[group].append({"sourceId": source.source_id, "reason": reason})
                    entry["unavailableReason"] = reason
                    # Never preserve denied raw content, segments or potentially content-bearing metadata.
                    entry.pop("metadata")
                    membership.append(entry)
                    continue
                if not source.raw_content or not source.segments:
                    raise BoundaryError("empty-evidence-source")
                content = self.boundary.content(source.raw_content, "text/plain; charset=utf-8" if source.source_type != "paper" else "application/octet-stream")
                if source.expected_raw_digest is not None and source.expected_raw_digest != content.digest:
                    raise BoundaryError("original-source-digest-mismatch")
                blobs.setdefault(content.digest, content)
                identity = {"provider": collection.provider, "sourceId": source.source_id, "snapshotId": snapshot_id, "contentHash": content.digest}
                identities[source.source_id] = identity
                available[group].append(identity)
                entry["contentHash"] = content.digest
                membership.append(entry)
                for ordinal, segment in enumerate(source.segments):
                    claim = plain_text(" ".join(segment.text.split()), 2000)
                    locator = plain_text(segment.locator, 200)
                    # Every provided segment must actually occur in its input text unless a paper parser supplies it.
                    if source.source_type != "paper":
                        normalized = " ".join(source.raw_content.decode("utf-8", errors="strict").split())
                        if claim not in normalized:
                            raise BoundaryError("citation-not-in-source")
                    identity_hash = raw_sha256((collection_id + "\0" + snapshot_id + "\0" + source.source_id + "\0" + str(ordinal)).encode("utf-8"))
                    record = {"schemaVersion": "1.0.0", "evidenceId": "evidence:" + identity_hash,
                              "collectionId": collection_id, "snapshotId": snapshot_id, "sourceType": source.source_type,
                              "sourceUri": source.source_uri, "sourceIdentity": identity, "sourceLocator": locator,
                              "attribution": source.attribution, "publishedAt": source.published_at, "capturedAt": source.captured_at,
                              "contentHash": content.digest, "claim": claim, "method": plain_text(segment.method),
                              "limitations": list(collection.limitations + source.limitations), "acceptanceStatus": "unreviewed",
                              "rightsPolicyId": source.rights_policy_id, "untrustedContent": True}
                    frozen = self.boundary.record("ResearchEvidence", record)
                    evidence_bytes += len(frozen.payload_bytes)
                    if consumed + evidence_bytes > self.maximum_bytes:
                        raise BoundaryError("citation-artifact-byte-budget")
                    evidence.append(frozen)
            imports = []
            for group in sorted(set(available) | set(unavailable)):
                content_class, quality, policy_id = group
                quality = "unavailable" if not available[group] else "partial" if unavailable[group] else quality
                # Co-locate duplicates when possible; public cross-shard mappings are not legal v1.
                by_hash: dict[str, list[dict[str, str]]] = defaultdict(list)
                for identity in available[group]:
                    by_hash[identity["contentHash"]].append(identity)
                batches: list[list[dict[str, str]]] = []
                current: list[dict[str, str]] = []
                for digest in sorted(by_hash):
                    members = by_hash[digest]
                    for offset in range(0, len(members), 512):
                        part = members[offset:offset + 512]
                        if len(current) + len(part) > 512:
                            batches.append(current)
                            current = []
                        current.extend(part)
                if current:
                    batches.append(current)
                unavailable_rows = unavailable[group]
                assigned = []
                cursor = 0
                for members in batches:
                    missing = unavailable_rows[cursor:cursor + 512 - len(members)]
                    cursor += len(missing)
                    assigned.append((members, missing))
                while cursor < len(unavailable_rows):
                    assigned.append(([], unavailable_rows[cursor:cursor + 512]))
                    cursor += 512
                for members, missing in assigned:
                    canonical: dict[str, str] = {}
                    duplicates = []
                    for identity in members:
                        digest, source_id = identity["contentHash"], identity["sourceId"]
                        if digest in canonical:
                            duplicates.append({"sourceId": source_id, "canonicalSourceId": canonical[digest], "contentHash": digest})
                        else:
                            canonical[digest] = source_id
                    imports.append(self.boundary.record("KnowledgeImport", {
                        "schemaVersion": "1.0.0", "collectionId": collection_id, "snapshotId": snapshot_id,
                        "sourceIdentities": members, "contentHashes": sorted(canonical), "duplicateMappings": duplicates,
                        "unavailableSources": missing, "transcriptQuality": quality,
                        "retrievalScope": "collection-only", "rightsPolicyId": policy_id, "replacementScope": "collection-snapshot",
                        "contentClass": content_class, "untrustedContent": True,
                    }))
            if not 1 <= len(imports) <= 64:
                raise BoundaryError("generation-shard-budget")
            canonical_sources = {}
            global_duplicates = []
            for source_id in sorted(identities):
                digest = identities[source_id]["contentHash"]
                if digest in canonical_sources:
                    global_duplicates.append({"sourceId": source_id, "canonicalSourceId": canonical_sources[digest], "contentHash": digest})
                else:
                    canonical_sources[digest] = source_id
            # This internal content artifact is not advertised as a new public schema.
            manifest_value = {"collectionId": collection_id, "snapshotId": snapshot_id, "expectedSnapshotId": expected_snapshot_id,
                              "preparedAt": now, "membership": membership, "importDigests": [record.digest for record in imports],
                              "evidenceDigests": [record.digest for record in evidence], "contentDigests": sorted(blobs),
                              "globalDuplicateMappings": global_duplicates,
                              "rightsRevisions": [list(row) for row in sorted(revisions)], "untrustedContent": True}
            manifest = self.boundary.content(self.boundary.encode(manifest_value), "application/json")
            total = len(manifest.data) + sum(len(blob.data) for blob in blobs.values()) + sum(len(row.payload_bytes) for row in imports + evidence)
            if total > self.maximum_bytes:
                raise BoundaryError("staged-generation-byte-budget")
            return KnowledgePlan(collection_id, snapshot_id, expected_snapshot_id, tuple(imports), tuple(evidence),
                                 tuple(blobs[key] for key in sorted(blobs)), manifest, tuple(sorted(revisions)), now)
        except BoundaryError as error:
            return Unavailable(str(error), collection_id, "No generation was published; unavailable membership remains scoped to this collection.")
        except Exception:
            return Unavailable("knowledge-dependency-unavailable", collection_id, "An input or injected boundary failed closed; nothing was published.")

    def _check_plan(self, plan: KnowledgePlan) -> dict[str, Any]:
        self.boundary.require()
        if plan.collection_id not in COLLECTIONS or COLLECTIONS[plan.collection_id].identity_status != "documented":
            raise BoundaryError("collection-identity-unavailable")
        if not 1 <= len(plan.imports) <= 64 or plan.status != "staged-only":
            raise BoundaryError("invalid-generation-shards")
        if epoch_ns(plan.prepared_at) > epoch_ns(self.clock.now()):
            raise BoundaryError("future-generation")
        manifest = parse_json(plan.manifest.data, maximum_bytes=self.maximum_bytes, maximum_nodes=1_000_000)
        if self.boundary.content(plan.manifest.data, "application/json") != plan.manifest:
            raise BoundaryError("manifest-digest-mismatch")
        if self.boundary.encode(manifest) != plan.manifest.data:
            raise BoundaryError("manifest-not-canonical")
        if (manifest.get("collectionId") != plan.collection_id or manifest.get("snapshotId") != plan.snapshot_id
                or manifest.get("expectedSnapshotId") != plan.expected_snapshot_id or manifest.get("preparedAt") != plan.prepared_at
                or manifest.get("importDigests") != [row.digest for row in plan.imports]
                or manifest.get("evidenceDigests") != [row.digest for row in plan.evidence]
                or manifest.get("contentDigests") != sorted(blob.digest for blob in plan.content)
                or manifest.get("rightsRevisions") != [list(row) for row in plan.rights_revisions]):
            raise BoundaryError("generation-binding-mismatch")
        size = len(plan.manifest.data) + sum(len(blob.data) for blob in plan.content) + sum(len(row.payload_bytes) for row in plan.imports + plan.evidence)
        if size > self.maximum_bytes or len(manifest.get("membership", [])) > self.maximum_sources:
            raise BoundaryError("stored-generation-budget")
        content = {blob.digest: blob for blob in plan.content}
        for blob in plan.content:
            if raw_sha256(blob.data) != blob.digest:
                raise BoundaryError("stored-content-corrupt")
        sources: dict[str, str] = {}
        unavailable: set[str] = set()
        profiles = set()
        evidence_sources = set()
        evidence_ids = set()
        policies = {}
        for record in plan.imports:
            value = self.boundary.recheck(record)
            if record.contract_name != "KnowledgeImport" or value["collectionId"] != plan.collection_id or value["snapshotId"] != plan.snapshot_id:
                raise BoundaryError("cross-collection-import")
            profiles.add((value["rightsPolicyId"], value["contentClass"], value["transcriptQuality"]))
            for source in value["sourceIdentities"]:
                if source["sourceId"] in sources or source["sourceId"] in unavailable or source["snapshotId"] != plan.snapshot_id or source["contentHash"] not in content:
                    raise BoundaryError("invalid-import-membership")
                sources[source["sourceId"]] = source["contentHash"]
            for source in value["unavailableSources"]:
                if source["sourceId"] in unavailable or source["sourceId"] in sources:
                    raise BoundaryError("duplicate-unavailable-membership")
                unavailable.add(source["sourceId"])
        for record in plan.evidence:
            value = self.boundary.recheck(record)
            if (record.contract_name != "ResearchEvidence" or value["collectionId"] != plan.collection_id or value["snapshotId"] != plan.snapshot_id
                    or value["sourceIdentity"]["snapshotId"] != plan.snapshot_id or sources.get(value["sourceIdentity"]["sourceId"]) != value["contentHash"]):
                raise BoundaryError("cross-collection-evidence")
            source_id = value["sourceIdentity"]["sourceId"]
            if value["evidenceId"] in evidence_ids or (source_id in policies and policies[source_id] != value["rightsPolicyId"]):
                raise BoundaryError("evidence-identity-or-policy-conflict")
            evidence_ids.add(value["evidenceId"])
            evidence_sources.add(source_id)
            policies[source_id] = value["rightsPolicyId"]
        if {row["sourceId"] for row in manifest["membership"]} != set(sources) | unavailable:
            raise BoundaryError("manifest-membership-mismatch")
        if len(profiles) != 1 or evidence_sources != set(sources):
            raise BoundaryError("incomplete-or-mixed-generation")
        collection_policy = next(iter(profiles))[0]
        expected_policies = {"collection": collection_policy, **policies}
        revisions = {source: (policy, revision) for source, policy, revision in plan.rights_revisions}
        if (len(revisions) != len(plan.rights_revisions) or set(revisions) != set(expected_policies)
                or any(revisions[source][0] != policy or not revisions[source][1] for source, policy in expected_policies.items())):
            raise BoundaryError("generation-rights-binding-mismatch")
        if len(manifest["membership"]) != len(sources) + len(unavailable):
            raise BoundaryError("duplicate-manifest-membership")
        for row in manifest["membership"]:
            source_id = row["sourceId"]
            if source_id in sources and (row.get("contentHash") != sources[source_id] or row.get("rightsPolicyId") != policies[source_id]):
                raise BoundaryError("source-manifest-binding-mismatch")
        canonical_sources = {}
        expected_duplicates = []
        for source_id in sorted(sources):
            digest = sources[source_id]
            if digest in canonical_sources:
                expected_duplicates.append({"sourceId": source_id, "canonicalSourceId": canonical_sources[digest], "contentHash": digest})
            else:
                canonical_sources[digest] = source_id
        if manifest.get("globalDuplicateMappings") != expected_duplicates:
            raise BoundaryError("global-duplicate-provenance-mismatch")
        return manifest

    def _current_revisions(self, plan: KnowledgePlan) -> tuple[tuple[str, str, str], ...]:
        now = self.clock.now()
        revisions = []
        for source_id, policy_id, _ in plan.rights_revisions:
            decision = authorize(self.rights, RightRequest(plan.collection_id, policy_id, "collection-import" if source_id == "collection" else "source-import",
                                                          now, () if source_id == "collection" else (source_id,)))
            revisions.append((source_id, policy_id, decision.revision))
        if tuple(revisions) != plan.rights_revisions:
            raise BoundaryError("rights-revision-changed-replan-required")
        return tuple(revisions)

    def publish(self, plan: KnowledgePlan) -> PublicationReceipt | Unavailable:
        try:
            if self.store is None:
                raise BoundaryError("collection-store-unavailable")
            self._check_plan(plan)
            self._current_revisions(plan)
            receipt = self.store.publish_collection(plan, plan.expected_snapshot_id)
            if (receipt.collection_id != plan.collection_id or receipt.snapshot_id != plan.snapshot_id
                    or receipt.manifest_digest != plan.manifest.digest or receipt.status not in ("published", "idempotent")
                    or receipt.previous_snapshot_id != plan.expected_snapshot_id):
                raise BoundaryError("publication-receipt-mismatch")
            return receipt
        except BoundaryError as error:
            return Unavailable(str(error), plan.collection_id, "Publication is not confirmed; inspect the collection transaction by manifest digest before retrying.")
        except Exception:
            return Unavailable("publication-outcome-unknown", plan.collection_id, "Do not assume activation; reconcile by immutable manifest digest.")

    def rollback(self, collection_id: str, snapshot_id: str, *, expected_snapshot_id: str) -> PublicationReceipt | Unavailable:
        try:
            if self.store is None:
                raise BoundaryError("collection-store-unavailable")
            plan = self.store.read_snapshot(collection_id, snapshot_id, self.maximum_bytes)
            if plan is None or plan.collection_id != collection_id or plan.snapshot_id != snapshot_id:
                raise BoundaryError("snapshot-unavailable")
            self._check_plan(plan)
            revisions = self._current_revisions(plan)
            receipt = self.store.activate_snapshot(collection_id, snapshot_id, expected_snapshot_id, plan.manifest.digest, revisions)
            if (receipt.collection_id != collection_id or receipt.snapshot_id != snapshot_id
                    or receipt.manifest_digest != plan.manifest.digest or receipt.previous_snapshot_id != expected_snapshot_id
                    or receipt.status not in ("published", "idempotent")):
                raise BoundaryError("rollback-receipt-mismatch")
            return receipt
        except BoundaryError as error:
            return Unavailable(str(error), collection_id, "Rollback does not bypass expired or revoked rights.")
        except Exception:
            return Unavailable("rollback-outcome-unknown", collection_id, "Reconcile this collection before retrying activation.")

    def retrieve(self, collection_id: str, snapshot_id: str, query: str, limit: int = 8) -> RetrievalResult:
        try:
            if self.store is None:
                raise BoundaryError("collection-store-unavailable")
            identifier(collection_id)
            identifier(snapshot_id)
            if not isinstance(query, str) or not 1 <= len(query) <= 500 or type(limit) is not int or not 1 <= limit <= 32:
                raise BoundaryError("retrieval-budget")
            plan = self.store.read_snapshot(collection_id, snapshot_id, self.maximum_bytes)
            if plan is None or plan.collection_id != collection_id or plan.snapshot_id != snapshot_id:
                raise BoundaryError("snapshot-unavailable")
            self._check_plan(plan)
            collection_policy = next(policy for source, policy, _ in plan.rights_revisions if source == "collection")
            now = self.clock.now()
            authorize(self.rights, RightRequest(collection_id, collection_policy, "collection-retrieve", now))
            unavailable = [(row["sourceId"], row["reason"]) for record in plan.imports for row in record.decode()["unavailableSources"]]
            terms = frozenset(re.findall(r"[\w-]{2,40}", query.casefold()))
            if not terms:
                raise BoundaryError("empty-search-terms")
            scored = []
            decisions: dict[tuple[str, str], bool] = {}
            for record in plan.evidence:
                value = record.decode()
                key = (value["sourceIdentity"]["sourceId"], value["rightsPolicyId"])
                if key not in decisions:
                    try:
                        authorize(self.rights, RightRequest(collection_id, key[1], "source-retrieve", now, (key[0],)))
                        decisions[key] = True
                    except BoundaryError:
                        decisions[key] = False
                        unavailable.append((key[0], "rights-denied"))
                if not decisions[key] or value["acceptanceStatus"] in ("rejected", "superseded"):
                    continue
                claim_terms = frozenset(re.findall(r"[\w-]{2,40}", value["claim"].casefold()))
                score = len(terms & claim_terms)
                if score:
                    scored.append((-score, value["evidenceId"], Citation(record, value["claim"], raw_sha256(value["claim"].encode("utf-8")))))
            scored.sort(key=lambda row: (row[0], row[1]))
            citations = tuple(row[2] for row in scored[:limit])
            # A final policy check closes expiration during expensive retrieval; store must scope reads as well.
            later = self.clock.now()
            authorize(self.rights, RightRequest(collection_id, collection_policy, "collection-retrieve", later))
            for citation in citations:
                value = citation.evidence.decode()
                authorize(self.rights, RightRequest(collection_id, value["rightsPolicyId"], "source-retrieve", later, (value["sourceIdentity"]["sourceId"],)))
            return RetrievalResult("available" if citations else "empty", collection_id, snapshot_id, citations, tuple(sorted(set(unavailable))))
        except BoundaryError as error:
            return RetrievalResult("unavailable", collection_id, snapshot_id, reason=str(error))
        except Exception:
            return RetrievalResult("unavailable", collection_id, snapshot_id, reason="retrieval-dependency-unavailable")
