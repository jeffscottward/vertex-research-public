"""Reviewed supplied claims -> existing Hypothesis/ExperimentRequest contracts.

Reuses SSRN PaperInput/SourceInput; does not parse, download, store or run papers.
The mapping is a retained private sidecar. Its digest in every citation locator
binds quotes/review pins/assumptions to the unchanged v1 experiment schema.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from hashlib import sha256

from knowledge.models import SourceInput
from knowledge.papers import PaperInput
from .core import count, digest_text, identity, instant
from .lab_authority import (LabScope, LabVerifier, LabVerifierPin, LabVerificationReceipt,
                            ReviewedEvidence, bounded_tuple, evidence_record, original_record,
                            public_record, receipt_record, text, timestamp, verify_binding)
from .publication import AuthoritativeValidator, CanonicalCodec, Unavailable, encode_authoritatively
from .quant import ClaimCitation, ExperimentHandoff, ExperimentRequest, Hypothesis, plan_experiment


@dataclass(frozen=True)
class PaperClaim:
    paper: PaperInput
    source: SourceInput
    evidence: ReviewedEvidence
    claim_id: str
    page_number: int
    normalized_start: int
    quote: str
    statement: str
    rights_receipt_id: str

    def __post_init__(self) -> None:
        if type(self.paper) is not PaperInput or type(self.source) is not SourceInput:
            raise ValueError("Existing supplied-paper/source contracts required")
        if type(self.evidence) is not ReviewedEvidence:
            raise ValueError("Exact reviewed paper evidence required")
        identity(self.claim_id)
        identity(self.rights_receipt_id)
        count(self.page_number, positive=True)
        count(self.normalized_start)
        if self.page_number > 64 or self.normalized_start > 1800:
            raise ValueError("Claim exceeds existing supplied-page bounds")
        text(self.quote, 1800)
        text(self.statement)


@dataclass(frozen=True)
class PaperClaimMapRequest:
    mapping_id: str
    revision: int
    hypothesis_id: str
    hypothesis_revision: int
    statement: str
    falsification: str
    assumptions: tuple[str, ...]
    created_at: datetime
    claims: tuple[PaperClaim, ...]

    def __post_init__(self) -> None:
        identity(self.mapping_id)
        identity(self.hypothesis_id)
        count(self.revision, positive=True)
        count(self.hypothesis_revision, positive=True)
        text(self.statement)
        text(self.falsification)
        instant(self.created_at)
        bounded_tuple(self.assumptions, 64, minimum=1)
        bounded_tuple(self.claims, 64, minimum=1)
        for value in self.assumptions:
            text(value)
        if any(type(claim) is not PaperClaim for claim in self.claims):
            raise ValueError("Reviewed supplied claim required")
        if len({claim.claim_id for claim in self.claims}) != len(self.claims):
            raise ValueError("Duplicate claim identity")


@dataclass(frozen=True)
class MappedPaperHypothesis:
    hypothesis: Hypothesis
    mapping_bytes: bytes
    mapping_hash: str
    receipt: LabVerificationReceipt

    def record(self) -> dict:
        """JSON-safe summary; retain mapping_bytes and originals privately verbatim."""
        return {"format": "vertex-paper-hypothesis-result-v1", "mappingSha256": self.mapping_hash,
                "hypothesisId": self.hypothesis.hypothesis_id,
                "hypothesisRevision": self.hypothesis.revision, "receipt": receipt_record(self.receipt),
                "executionAuthority": "none", "simulatedCapitalEntersNav": False}


def _claim_record(claim: PaperClaim, *, scope: LabScope, as_of: datetime,
                  codec: CanonicalCodec, validator: AuthoritativeValidator) -> tuple[dict, dict, tuple[bytes, ...]]:
    paper, source = claim.paper, claim.source
    if (type(paper.data) is not bytes or not 1 <= len(paper.data) <= 8_000_000
            or paper.media_type not in {"text/plain", "application/pdf"}
            or source.raw_content != paper.data or type(source.raw_content) is not bytes
            or sha256(paper.data).hexdigest() != paper.expected_digest
            or source.expected_raw_digest != paper.expected_digest):
        raise ValueError("Original paper/version/raw-byte identity mismatch")
    digest_text(paper.expected_digest)
    identity(paper.version_id)
    bounded_tuple(paper.authors, 32, minimum=1)
    bounded_tuple(source.segments, 64, minimum=1)
    for author in paper.authors:
        text(author, 200)
    metadata = original_record(source.source_metadata_json, codec=codec, maximum=64_000)
    if (source.source_id != "ssrn:" + paper.ssrn_id + ":" + paper.version_id
            or not paper.ssrn_id.isascii() or not paper.ssrn_id.isdecimal()
            or not 1 <= len(paper.ssrn_id) <= 12 or paper.ssrn_id.startswith("0")
            or source.source_uri != "https://ssrn.com/abstract=" + paper.ssrn_id
            or source.source_type != "paper" or source.content_class != "paper"
            or source.unavailable_reason is not None
            or source.rights_policy_id != paper.rights_policy_id
            or (source.captured_at, source.published_at) != (paper.captured_at, paper.published_at)
            or (metadata.get("ssrnId"), metadata.get("versionId"), metadata.get("rawPaperDigest"),
                metadata.get("title"), metadata.get("authors"), metadata.get("doi"))
            != (paper.ssrn_id, paper.version_id, paper.expected_digest, paper.title, list(paper.authors), paper.doi)):
        raise ValueError("Existing SSRN source provenance does not match supplied paper")
    pages = metadata.get("parsedPages")
    if type(pages) is not list or not 1 <= len(pages) <= 64 or any(type(page) is not dict for page in pages):
        raise ValueError("Supplied parser page identities required")
    page_matches = [page for page in pages if type(page.get("number")) is int and page["number"] == claim.page_number]
    if len(page_matches) != 1:
        raise ValueError("Exact parsed page identity required")
    page = page_matches[0]
    digest_text(page["textDigest"])
    locator = "page:" + str(claim.page_number) + ":normalized-char:0"
    segments = [segment for segment in source.segments if segment.locator == locator]
    if len(segments) != 1:
        raise ValueError("Exact existing source page locator required")
    segment = segments[0]
    if (segment.method != page["method"] or len(segment.text) > 1800
            or segment.text != " ".join(segment.text.split())
            or segment.text[claim.normalized_start:claim.normalized_start + len(claim.quote)] != claim.quote):
        raise ValueError("Claim quote must be an exact bounded page excerpt")
    evidence, review = evidence_record(claim.evidence, scope=scope, as_of=as_of, codec=codec, validator=validator)
    if (evidence["sourceType"] != "paper" or evidence["sourceIdentity"]["provider"] != "ssrn"
            or evidence["sourceIdentity"]["sourceId"] != source.source_id
            or evidence["sourceIdentity"]["snapshotId"] != scope.snapshot_id
            or evidence["contentHash"] != paper.expected_digest
            or evidence["sourceLocator"] != locator or evidence["claim"] != segment.text
            or evidence["method"] != segment.method or evidence["sourceUri"] != source.source_uri
            or evidence["attribution"] != source.attribution or evidence["rightsPolicyId"] != paper.rights_policy_id
            or (evidence["capturedAt"], evidence["publishedAt"]) != (source.captured_at, source.published_at)):
        raise ValueError("Original evidence does not bind this exact supplied page/source")
    record = {"claimId": claim.claim_id, "sourceId": source.source_id, "ssrnId": paper.ssrn_id,
              "versionId": paper.version_id, "rawPaperHash": paper.expected_digest, "mediaType": paper.media_type,
              "metadataHash": sha256(source.source_metadata_json).hexdigest(),
              "pageNumber": claim.page_number, "pageTextHash": page["textDigest"],
              "sourceLocator": locator, "normalizedStart": claim.normalized_start,
              "quote": claim.quote, "statement": claim.statement, "claimKind": "source-asserted",
              "evidenceId": evidence["evidenceId"], "evidenceHash": claim.evidence.artifact_hash,
              "reviewId": claim.evidence.current_review.review_id,
              "reviewRevision": claim.evidence.current_review.revision,
              "sourceSnapshotId": evidence["sourceIdentity"]["snapshotId"],
              "urlOrDoi": paper.doi or source.source_uri, "author": source.attribution,
              "rightsReceiptId": claim.rights_receipt_id}
    return record, review, (paper.data, source.source_metadata_json, claim.evidence.original_bytes)


def map_reviewed_claims(request: PaperClaimMapRequest, *, scope: LabScope, as_of: datetime,
                        codec: CanonicalCodec | None, validator: AuthoritativeValidator | None,
                        verifier: LabVerifier | None, verifier_pin: LabVerifierPin | None) -> MappedPaperHypothesis | Unavailable:
    if codec is None or validator is None or verifier is None or verifier_pin is None:
        return Unavailable(("reviewed-paper-mapping-ports-unavailable",))
    if request.created_at > instant(as_of):
        raise ValueError("Future hypothesis mapping")
    records, reviews, originals = [], [], []
    for claim in request.claims:
        record, review, blobs = _claim_record(claim, scope=scope, as_of=as_of, codec=codec, validator=validator)
        records.append(record)
        reviews.append(review)
        originals.extend(blobs)
    # Deduplicate immutable inputs without merging distinct source/evidence identities.
    originals = tuple(dict.fromkeys(originals))
    payload = {"format": "vertex-reviewed-paper-claim-map-v1", "mappingId": request.mapping_id,
               "revision": request.revision, "scope": {"actorId": scope.actor_id,
               "accountAlias": scope.account_alias, "environment": scope.environment,
               "collectionId": scope.collection_id, "snapshotId": scope.snapshot_id},
               "hypothesis": {"id": request.hypothesis_id, "revision": request.hypothesis_revision,
               "statement": request.statement, "falsification": request.falsification,
               "assumptions": list(request.assumptions), "createdAt": timestamp(request.created_at)},
               "claims": records, "executionAuthority": "none"}
    encoded, digest = encode_authoritatively(payload, codec)
    until = min(min(claim.evidence.current_review.expires_ns, claim.evidence.current_review.rights_valid_until_ns)
                for claim in request.claims)
    receipt = verify_binding("paper-claim-map", {"mapping": payload, "mappingHash": digest,
        "currentReviews": reviews}, (*originals, encoded), scope=scope, as_of=as_of, codec=codec,
        verifier=verifier, verifier_pin=verifier_pin, valid_until_ns=until)
    if isinstance(receipt, Unavailable):
        return receipt
    citations = tuple(ClaimCitation(record["sourceId"], record["evidenceHash"],
        "page:" + str(record["pageNumber"]) + ":normalized-char:" + str(record["normalizedStart"])
        + ":length:" + str(len(record["quote"])) + ":claim:" + record["claimId"] + ":mapping-sha256:" + digest,
        record["urlOrDoi"], record["author"], record["versionId"], record["rightsReceiptId"], "source-asserted")
        for record in records)
    hypothesis = Hypothesis(request.hypothesis_id, request.hypothesis_revision, request.statement,
        request.falsification, request.assumptions, citations, request.created_at)
    return MappedPaperHypothesis(hypothesis, encoded, digest, receipt)


@dataclass(frozen=True)
class PaperExperimentPlan:
    handoff: ExperimentHandoff
    mapping: MappedPaperHypothesis
    cost_model_hash: str
    receipt: LabVerificationReceipt

    def record(self) -> dict:
        return {"format": "vertex-paper-experiment-plan-v1", "experimentId": self.handoff.experiment_id,
                "experimentHash": self.handoff.content_hash, "mappingHash": self.mapping.mapping_hash,
                "costModelHash": self.cost_model_hash, "receipt": receipt_record(self.receipt),
                "executionAuthority": "none", "simulatedCapitalEntersNav": False}


def plan_mapped_experiment(claims: PaperClaimMapRequest, request: ExperimentRequest, *,
                           expected_mapping_hash: str, scope: LabScope, as_of: datetime,
                           codec: CanonicalCodec | None, validator: AuthoritativeValidator | None,
                           verifier: LabVerifier | None, verifier_pin: LabVerifierPin | None) -> PaperExperimentPlan | Unavailable:
    """Re-admit current claims, then freeze with quant.plan_experiment unchanged.

    First call map_reviewed_claims; use its exact Hypothesis to author/review the
    StrategySpec and ExperimentRequest. This call rechecks, not trusts, that result.
    The caller retains originals and mapping_bytes, then uses the existing private
    experiment publication path. No persistence or job is implied by this plan.
    """
    mapping = map_reviewed_claims(claims, scope=scope, as_of=as_of, codec=codec,
        validator=validator, verifier=verifier, verifier_pin=verifier_pin)
    if isinstance(mapping, Unavailable):
        return mapping
    digest_text(expected_mapping_hash)
    if mapping.mapping_hash != expected_mapping_hash or request.hypothesis != mapping.hypothesis:
        raise ValueError("Experiment must bind the exact reviewed versioned claim mapping")
    if request.requested_at > instant(as_of):
        raise ValueError("Future experiment request")
    bounded_tuple(request.datasets, 64, minimum=1)
    bounded_tuple(request.parameter_grid, 64)
    dependency_hashes = {request.strategy.content_hash, *(d.manifest_hash for d in request.datasets),
                         *(c.artifact_hash for c in request.hypothesis.citations)}
    if len(dependency_hashes) > 64:
        raise ValueError("Existing experiment publication dependency-pin budget exceeded")
    for _, values in request.parameter_grid:
        bounded_tuple(values, 64, minimum=1)
        for value in values:
            text(value, 65536)
    strategy = public_record(request.strategy.canonical_bytes, "StrategySpec", codec=codec, validator=validator)
    if strategy["codeDigest"] != request.implementation_digest:
        raise ValueError("Experiment implementation must equal frozen StrategySpec code digest")
    _, cost_hash = encode_authoritatively(strategy["costModel"], codec)
    handoff = plan_experiment(request, codec=codec, validator=validator)
    if isinstance(handoff, Unavailable):
        return handoff
    if len(handoff.canonical_bytes) > 700_000:
        raise ValueError("Existing experiment publication byte budget exceeded")
    receipt = verify_binding("paper-experiment", {"mappingHash": mapping.mapping_hash,
        "experimentHash": handoff.content_hash, "costModelHash": cost_hash,
        "mappingReceipt": receipt_record(mapping.receipt)},
        (mapping.mapping_bytes, handoff.canonical_bytes, request.strategy.canonical_bytes),
        scope=scope, as_of=as_of, codec=codec, verifier=verifier, verifier_pin=verifier_pin,
        valid_until_ns=min(min(c.evidence.current_review.expires_ns, c.evidence.current_review.rights_valid_until_ns)
                           for c in claims.claims))
    if isinstance(receipt, Unavailable):
        return receipt
    return PaperExperimentPlan(handoff, mapping, cost_hash, receipt)
