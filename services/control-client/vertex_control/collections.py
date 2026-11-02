"""Immutable collection generations. Rollback is an explicit scoped CAS only."""
from __future__ import annotations

from dataclasses import dataclass
from hashlib import sha256

from .adapters import _Port, ArtifactAdapter, DatasetAdapter, ResearchContext, RightsAdapter, RunAdmissionAdapter, decode_content
from .client import ControlError, parse_json

_PROFILE = "vertex-control-knowledge-index-v1"
_INDEX_FIELDS = frozenset({"profile", "collectionId", "snapshotId", "expectedSnapshotId", "preparedAt",
                           "imports", "evidence", "content", "manifest", "rightsRevisions"})


class CollectionAdapter(_Port):
    def __init__(self, client, bridge, context, artifacts, rights):
        super().__init__(client, bridge, context)
        self.artifacts, self.rights = artifacts, rights
        self.service = None

    def _index_id(self, collection_id, snapshot_id):
        return "knowledge-index-" + self.authority.digest({"collectionId": collection_id, "snapshotId": snapshot_id})

    def _check(self, plan):
        if self.service is None:
            raise ControlError("knowledge-service-unavailable")
        self.scope(plan.collection_id)
        # Reuse the research package's complete immutable-plan integrity boundary.
        self.service._check_plan(plan)
        if (len(plan.imports) > 64 or len(plan.evidence) > 512 or len(plan.content) > 10_000
                or not 1 <= len(plan.rights_revisions) <= 1024):
            raise ControlError("collection-generation-too-large")
        if self.context.snapshot_id is not None and plan.snapshot_id != self.context.snapshot_id:
            raise ControlError("collection-snapshot-denied")

    def _rights(self, plan):
        for _, policy, version in plan.rights_revisions:
            self.rights.current(policy, ("store",), collection_id=plan.collection_id, expected_version=version)

    def publish_collection(self, plan, expected_snapshot_id):
        from knowledge.models import PublicationReceipt
        self._check(plan)
        if expected_snapshot_id != plan.expected_snapshot_id:
            raise ControlError("collection-cas-mismatch")
        self._rights(plan)
        revisions = {source: (policy, version) for source, policy, version in plan.rights_revisions}
        collection_policy, collection_version = revisions["collection"]
        index = {"profile": _PROFILE, "collectionId": plan.collection_id, "snapshotId": plan.snapshot_id,
                 "expectedSnapshotId": plan.expected_snapshot_id, "preparedAt": plan.prepared_at,
                 "imports": [], "evidence": [], "content": [], "manifest": None,
                 "rightsRevisions": [list(row) for row in plan.rights_revisions]}
        imports, evidence = [], []
        content_policies = {}
        for row in plan.evidence:
            value = row.decode()
            policy = revisions[value["sourceIdentity"]["sourceId"]]
            previous = content_policies.setdefault(value["contentHash"], policy)
            # One stored blob has one rights binding. Ambiguous mixed-policy
            # deduplication must be split upstream, never broadened here.
            if previous != policy:
                raise ControlError("content-rights-binding-conflict")
        for blob in plan.content:
            policy, version = content_policies.get(blob.digest, (collection_policy, collection_version))
            reference = self.artifacts.stage(artifact_id="blob-" + blob.digest, content=blob.data,
                content_type=blob.media_type, collection_id=plan.collection_id,
                rights_policy_id=policy, rights_version=version)
            index["content"].append({"artifact": reference, "mediaType": blob.media_type})
        for name, rows, output, indexed in (("KnowledgeImport", plan.imports, imports, index["imports"]),
                                            ("ResearchEvidence", plan.evidence, evidence, index["evidence"])):
            for row in rows:
                record = self.validate_record(name, row.payload_bytes, row.digest)
                if name == "KnowledgeImport":
                    identity, policy, version = "import-" + row.digest, collection_policy, collection_version
                    lineage = []
                else:
                    identity = record["evidenceId"]
                    policy, version = revisions[record["sourceIdentity"]["sourceId"]]
                    # Raw stages are not public artifact parents. Source bytes
                    # bind through contentHash + exact reconstruction membership.
                    lineage = []
                reference = self.artifacts.stage(artifact_id=identity, content=row.payload_bytes,
                    content_type="application/json", canonical_digest=row.digest,
                    collection_id=plan.collection_id, lineage_artifact_ids=lineage,
                    rights_policy_id=policy, rights_version=version)
                output.append({"record": record, "artifact": reference})
                indexed.append(reference)
        index["manifest"] = self.artifacts.stage(artifact_id="knowledge-manifest-" + plan.manifest.digest,
            content=plan.manifest.data, content_type="application/json", canonical_digest=plan.manifest.digest,
            collection_id=plan.collection_id, rights_policy_id=collection_policy, rights_version=collection_version)
        index_bytes = self.authority.encode(index)
        reconstruction = self.artifacts.stage(artifact_id=self._index_id(plan.collection_id, plan.snapshot_id), content=index_bytes,
            content_type="application/json", canonical_digest=sha256(index_bytes).hexdigest(),
            collection_id=plan.collection_id, rights_policy_id=collection_policy, rights_version=collection_version)
        result = self.call("publishCollection", collectionId=plan.collection_id,
            expectedActiveSnapshotId=expected_snapshot_id, imports=imports, evidence=evidence, datasets=[],
            reconstructionArtifact=reconstruction, manifestSha256=plan.manifest.digest,
            rightsPins=self._rights_pins(plan.rights_revisions),
            idempotencyKey="collection-" + plan.manifest.digest)
        self._receipt(result, plan.collection_id, plan.snapshot_id, expected_snapshot_id, {"published", "duplicate"})
        if result["reconstructionArtifact"] != reconstruction or result["manifestSha256"] != plan.manifest.digest:
            raise ControlError("collection-reconstruction-receipt-mismatch", effect="unknown")
        if self._refs(result["importArtifacts"]) != self._refs(index["imports"]):
            raise ControlError("collection-import-receipt-mismatch", effect="unknown")
        return PublicationReceipt(plan.collection_id, plan.snapshot_id, plan.manifest.digest,
            result["previousSnapshotId"], "idempotent" if result["status"] == "duplicate" else "published")

    @staticmethod
    def _rights_pins(revisions):
        return [{"sourceId": source, "policyId": policy, "version": version} for source, policy, version in revisions]

    @staticmethod
    def _refs(references):
        return sorted((row["artifactId"], row["artifactSha256"]) for row in references)

    @staticmethod
    def _receipt(result, collection_id, snapshot_id, previous_id, statuses):
        if (result["collectionId"] != collection_id or result["snapshotId"] != snapshot_id
                or result["previousSnapshotId"] != previous_id or result["status"] not in statuses):
            raise ControlError("collection-receipt-mismatch", effect="unknown")

    def read_snapshot(self, collection_id, snapshot_id, maximum_bytes):
        from knowledge.models import KnowledgePlan
        from providers.ports import Content, ValidatedRecord
        self.scope(collection_id)
        if type(maximum_bytes) is not int or not 0 < maximum_bytes <= 64_000_000:
            raise ControlError("collection-read-budget-rejected")
        public = self.call("readCollection", collectionId=collection_id, snapshotId=snapshot_id)
        if (public["status"] != "available" or public["collectionId"] != collection_id or public["snapshotId"] != snapshot_id):
            raise ControlError("collection-read-scope-mismatch")
        reconstruction = public["reconstructionArtifact"]
        # The server returns the exact generation->private-index link committed
        # atomically with membership. Never guess a prefix or select latest.
        data = self.artifacts.read(artifact_id=reconstruction["artifactId"],
                                   expected_digest=reconstruction["artifactSha256"], collection_id=collection_id)
        index = parse_json(data)
        if (type(index) is not dict or set(index) != _INDEX_FIELDS or index["profile"] != _PROFILE
                or index["collectionId"] != collection_id or index["snapshotId"] != snapshot_id
                or self.authority.encode(index) != data or index["manifest"]["artifactSha256"] != public["manifestSha256"]
                or not 1 <= len(index["imports"]) <= 64 or len(index["evidence"]) > 512 or len(index["content"]) > 10_000
                or self._refs(public["importArtifacts"]) != self._refs(index["imports"])):
            raise ControlError("collection-index-binding-rejected")
        size = len(data)

        def read_reference(reference):
            nonlocal size
            # Before another read reserve the remaining bound, then enforce actual
            # length. Every individual artifact also has the 1 MiB hard ceiling.
            if size >= maximum_bytes:
                raise ControlError("collection-read-budget-exhausted")
            value = self.artifacts.read(artifact_id=reference["artifactId"],
                expected_digest=reference["artifactSha256"], collection_id=collection_id)
            size += len(value)
            if size > maximum_bytes:
                raise ControlError("collection-read-budget-exhausted")
            return value

        imports, evidence = [], []
        for name, references, output in (("KnowledgeImport", index["imports"], imports),
                                          ("ResearchEvidence", index["evidence"], evidence)):
            for reference in references:
                payload = read_reference(reference)
                self.validate_record(name, payload, reference["artifactSha256"])
                output.append(ValidatedRecord(name, payload, reference["artifactSha256"]))
        content = tuple(Content(read_reference(row["artifact"]), row["artifact"]["artifactSha256"], row["mediaType"])
                        for row in index["content"])
        manifest = Content(read_reference(index["manifest"]), index["manifest"]["artifactSha256"], "application/json")
        plan = KnowledgePlan(collection_id, snapshot_id, index["expectedSnapshotId"], tuple(imports), tuple(evidence),
            content, manifest, tuple(tuple(row) for row in index["rightsRevisions"]), index["preparedAt"])
        self._check(plan)
        return plan

    def activate_snapshot(self, collection_id, snapshot_id, expected_snapshot_id, manifest_digest, rights_revisions):
        from knowledge.models import PublicationReceipt
        plan = self.read_snapshot(collection_id, snapshot_id, 64_000_000)
        if plan.manifest.digest != manifest_digest or plan.rights_revisions != rights_revisions:
            raise ControlError("collection-activation-binding-rejected")
        self._rights(plan)
        result = self.call("activateCollection", collectionId=collection_id, expectedActiveSnapshotId=expected_snapshot_id,
            manifestSha256=manifest_digest, rightsPins=self._rights_pins(rights_revisions),
            targetSnapshotId=snapshot_id, idempotencyKey="activate-" + self.authority.digest({
                "collectionId": collection_id, "expected": expected_snapshot_id, "target": snapshot_id, "digest": manifest_digest}))
        self._receipt(result, collection_id, snapshot_id, expected_snapshot_id, {"activated", "duplicate"})
        if result["manifestSha256"] != manifest_digest:
            raise ControlError("collection-activation-manifest-mismatch", effect="unknown")
        return PublicationReceipt(collection_id, snapshot_id, manifest_digest, expected_snapshot_id,
                                  "idempotent" if result["status"] == "duplicate" else "published")

    def rollback(self, collection_id, snapshot_id, *, expected_snapshot_id):
        # No reverse writes/deletion. Historical target must remain immutable,
        # current-rights-authorized and protected by this exact active-snapshot CAS.
        return self.service.rollback(collection_id, snapshot_id, expected_snapshot_id=expected_snapshot_id)

    publish = publish_collection
    read = read_snapshot
    activate = activate_snapshot


class RetrievalAdapter(_Port):
    def __init__(self, client, bridge, context, service):
        super().__init__(client, bridge, context)
        self.service = service

    def retrieve(self, *, collection_id, snapshot_id, query, limit, authorization, deadline_ns, cancellation):
        with self.operation(deadline_ns, cancellation):
            return self._retrieve(collection_id=collection_id, snapshot_id=snapshot_id, query=query, limit=limit,
                                  authorization=authorization, deadline_ns=deadline_ns, cancellation=cancellation)

    def _retrieve(self, *, collection_id, snapshot_id, query, limit, authorization, deadline_ns, cancellation):
        from agents.types import RetrievalResult, StagedCitation
        self.guard(deadline_ns, cancellation)
        if authorization is not self.context.authorization:
            raise ControlError("retrieval-authorization-denied")
        self.scope(collection_id)
        if self.context.snapshot_id is not None and snapshot_id != self.context.snapshot_id:
            raise ControlError("retrieval-snapshot-denied")
        result = self.service.retrieve(collection_id, snapshot_id, query, limit)
        self.guard(deadline_ns, cancellation)
        if result.collection_id != collection_id or result.snapshot_id != snapshot_id:
            raise ControlError("retrieval-result-scope-mismatch")
        citations = tuple(StagedCitation(evidence=row.evidence.decode(), excerpt=row.excerpt,
            content_digest=row.content_digest, original_bytes=row.evidence.payload_bytes) for row in result.citations)
        # Typed unavailable source IDs only; source-derived reason text stays out.
        return RetrievalResult(result.status, collection_id, snapshot_id, citations,
                               tuple(sorted({row[0] for row in result.unavailable_sources})))


@dataclass(frozen=True)
class ResearchAdapters:
    rights: RightsAdapter
    admission: RunAdmissionAdapter
    artifacts: ArtifactAdapter
    collections: CollectionAdapter
    retrieval: RetrievalAdapter
    datasets: DatasetAdapter
    knowledge: object


def create_research_adapters(*, client, bridge, context: ResearchContext, rights_mode="legacy") -> ResearchAdapters:
    from knowledge.service import KnowledgeService
    from providers.boundary import Boundary
    rights = RightsAdapter(client, bridge, context, mode=rights_mode)
    artifacts = ArtifactAdapter(client, bridge, context, rights)
    collections = CollectionAdapter(client, bridge, context, artifacts, rights)
    service = KnowledgeService(boundary=Boundary(client.authority, client.authority), clock=context.clock,
                               rights=rights, store=collections)
    collections.service = service
    return ResearchAdapters(rights, RunAdmissionAdapter(client, bridge, context), artifacts, collections,
        RetrievalAdapter(client, bridge, context, service), DatasetAdapter(client, bridge, context, artifacts), service)
