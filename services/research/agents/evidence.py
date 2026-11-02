"""Lawful staged evidence only. No SSRN ingestion, URL fetch or ambient corpus."""
from __future__ import annotations

from copy import deepcopy
from hashlib import sha256
import re
from typing import Any, Mapping

from .ports import CanonicalCodec, RightsPort, TimePort, Validator
from .types import (
    AcceptedReview, AdvisoryOutput, AgentFault, CitationRef, Claim, Evidence, Proposal,
    RetrievalResult, RunRequest, Scope,
)


_IDENTIFIER = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$")
_DIGEST = re.compile(r"^[0-9a-f]{64}$")


def identifier(value: str) -> str:
    if not isinstance(value, str) or not _IDENTIFIER.fullmatch(value):
        raise AgentFault("invalid-identity")
    return value


def text(value: str, maximum: int) -> str:
    if (not isinstance(value, str) or not 1 <= len(value) <= maximum
            or any(ord(c) < 32 and c not in "\n\t" or ord(c) == 127
                   or 0xD800 <= ord(c) <= 0xDFFF for c in value)):
        raise AgentFault("invalid-text")
    return value


def canonical(value: Any, codec: CanonicalCodec) -> tuple[bytes, str]:
    encoded, digest = codec.encode(value), codec.digest(value)
    if (not isinstance(encoded, bytes) or not isinstance(digest, str)
            or not _DIGEST.fullmatch(digest) or sha256(encoded).hexdigest() != digest):
        raise AgentFault("canonical-codec-mismatch")
    return encoded, digest


class EvidenceGate:
    def __init__(self, *, validator: Validator, codec: CanonicalCodec,
                 rights: RightsPort, time: TimePort, authorization: object) -> None:
        self.validator, self.codec = validator, codec
        self.rights, self.time, self.authorization = rights, time, authorization

    def admit(self, result: RetrievalResult, *, scope: Scope, request: RunRequest,
              reference_ns: int, current: Mapping[str, Evidence]) -> tuple[Evidence, ...]:
        identifier(request.account_alias)
        if request.environment not in {"research", "paper", "live"}:
            raise AgentFault("rights-denied")
        if (not isinstance(result, RetrievalResult) or result.status != "available"
                or (result.collection_id, result.snapshot_id)
                != (scope.collection_id, scope.snapshot_id)):
            raise AgentFault("evidence-unavailable")
        if (not isinstance(result.citations, tuple)
                or len(result.citations) > request.max_evidence
                or len(result.unavailable_sources) > 512):
            raise AgentFault("evidence-bound-exceeded")
        admitted: list[Evidence] = []
        seen: set[str] = set()
        for citation in result.citations:
            # Snapshot before invoking any untrusted adapter; do not retain its dict.
            payload = deepcopy(dict(citation.evidence))
            if self.validator.validate("ResearchEvidence", payload, "1.0.0") is not True:
                raise AgentFault("invalid-evidence")
            encoded, artifact_digest = canonical(payload, self.codec)
            if (not isinstance(citation.original_bytes, bytes)
                    or not 1 <= len(citation.original_bytes) <= 262_144
                    or encoded != citation.original_bytes
                    or sha256(citation.original_bytes).hexdigest() != artifact_digest):
                raise AgentFault("invalid-evidence")
            evidence_id = payload["evidenceId"]
            if evidence_id in seen:
                raise AgentFault("duplicate-evidence")
            seen.add(evidence_id)
            if (payload["collectionId"] != scope.collection_id
                    or payload["snapshotId"] != scope.snapshot_id
                    or payload["untrustedContent"] is not True):
                raise AgentFault("evidence-scope-denied")
            # acceptanceStatus is immutable source metadata, never authority.
            # This injected resolver is the trusted StateAuth/latest-review join;
            # callers/models cannot self-issue an AcceptedReview DTO.
            resolver = getattr(self.rights, "resolve_current", None)
            if not callable(resolver):
                raise AgentFault("rights-denied")
            try:
                review = resolver(
                    actor_id=request.actor_id, account_alias=request.account_alias,
                    environment=request.environment, collection_id=scope.collection_id,
                    snapshot_id=scope.snapshot_id, evidence_id=evidence_id,
                    artifact_digest=artifact_digest, original_bytes=citation.original_bytes,
                    purpose="research", reference_ns=reference_ns,
                    authorization=self.authorization,
                )
            except Exception:
                raise AgentFault("rights-denied") from None
            if (not isinstance(review, AcceptedReview)
                    or (review.actor_id, review.account_alias, review.environment,
                        review.collection_id, review.snapshot_id, review.evidence_id,
                        review.artifact_digest, review.rights_policy_id, review.purpose)
                    != (request.actor_id, request.account_alias, request.environment,
                        scope.collection_id, scope.snapshot_id, evidence_id,
                        artifact_digest, payload["rightsPolicyId"], "research")
                    or review.status != "accepted" or review.current is not True
                    or review.superseded is not False
                    or review.rights_authorized is not True
                    or type(review.revision) is not int or review.revision < 1
                    or any(type(at) is not int for at in
                           (review.effective_ns, review.expires_ns, review.resolved_ns,
                            review.rights_valid_until_ns))
                    or review.resolved_ns != reference_ns
                    or review.rights_valid_until_ns <= reference_ns
                    or not review.effective_ns <= review.resolved_ns < review.expires_ns):
                raise AgentFault("rights-denied")
            identifier(review.review_id)
            captured = self.time.timestamp_ns(payload["capturedAt"])
            published = (self.time.timestamp_ns(payload["publishedAt"])
                         if payload["publishedAt"] is not None else None)
            if (type(captured) is not int or captured > reference_ns
                    or reference_ns - captured > request.max_evidence_age_ns
                    or published is not None and (type(published) is not int
                                                  or published > captured)):
                raise AgentFault("evidence-stale")
            excerpt = text(citation.excerpt, request.max_excerpt_chars)
            if sha256(excerpt.encode("utf-8")).hexdigest() != citation.content_digest:
                raise AgentFault("excerpt-integrity-failed")
            # The source hash and excerpt hash are intentionally different identities.
            # DataKnowledge must already have bound excerpt to source/locator bytes.
            grant = self.rights.authorize(
                actor_id=request.actor_id, evidence=deepcopy(payload),
                reference_ns=reference_ns, authorization=self.authorization,
            )
            if (grant is None or grant.actor_id != request.actor_id
                    or grant.evidence_id != evidence_id
                    or grant.collection_id != scope.collection_id
                    or grant.snapshot_id != scope.snapshot_id
                    or grant.content_hash != payload["contentHash"]
                    or grant.rights_policy_id != payload["rightsPolicyId"]
                    or grant.permitted_use != "research-advisory"
                    or type(grant.valid_until_ns) is not int
                    or grant.valid_until_ns <= reference_ns
                    or grant.allow_excerpt is not True or grant.allow_model is not True
                    or grant.allow_publication is not True):
                raise AgentFault("rights-denied")
            source = payload["sourceIdentity"]
            evidence = Evidence(
                evidence_id, scope.collection_id, scope.snapshot_id,
                source["sourceId"], source["snapshotId"], payload["sourceUri"],
                payload["sourceLocator"], payload["attribution"], payload["contentHash"],
                citation.content_digest, excerpt, payload["rightsPolicyId"], captured,
                published, min(grant.valid_until_ns, review.expires_ns, review.rights_valid_until_ns),
                artifact_digest, review.review_id, review.revision,
            )
            if evidence_id in current and current[evidence_id] != evidence:
                raise AgentFault("evidence-identity-conflict")
            admitted.append(evidence)
        if len(set(current) | seen) > request.max_evidence:
            raise AgentFault("evidence-bound-exceeded")
        return tuple(admitted)


def check_freshness(evidence: tuple[Evidence, ...], request: RunRequest,
                    reference_ns: int) -> None:
    for item in evidence:
        if (item.valid_until_ns <= reference_ns or item.captured_ns > reference_ns
                or reference_ns - item.captured_ns > request.max_evidence_age_ns):
            raise AgentFault("evidence-stale")


def check_citation(ref: CitationRef, evidence: Mapping[str, Evidence]) -> None:
    if not isinstance(ref, CitationRef) or ref.evidence_id not in evidence:
        raise AgentFault("citation-not-in-evidence")
    item = evidence[ref.evidence_id]
    if ((ref.source_id, ref.source_snapshot_id, ref.content_hash, ref.excerpt_digest)
            != (item.source_id, item.source_snapshot_id, item.content_hash, item.excerpt_digest)):
        raise AgentFault("citation-identity-mismatch")
    if text(ref.quote, 1000) not in item.excerpt:
        raise AgentFault("citation-quote-mismatch")


def check_claim(claim: Claim, evidence: Mapping[str, Evidence]) -> None:
    if not isinstance(claim, Claim) or claim.kind not in {"fact", "hypothesis", "limitation"}:
        raise AgentFault("invalid-claim")
    text(claim.text, 2000)
    if not isinstance(claim.citations, tuple) or not 1 <= len(claim.citations) <= 8:
        raise AgentFault("missing-citation")
    if len(set(claim.citations)) != len(claim.citations):
        raise AgentFault("duplicate-citation")
    for ref in claim.citations:
        check_citation(ref, evidence)


def check_proposal(proposal: Proposal, evidence: Mapping[str, Evidence]) -> None:
    if (not isinstance(proposal, Proposal) or proposal.execution_authorized is not False
            or proposal.kind not in {"strategy-hypothesis", "backtest-request"}):
        raise AgentFault("invalid-proposal")
    identifier(proposal.proposal_id)
    text(proposal.title, 200)
    check_claim(proposal.rationale, evidence)


def check_output(output: AdvisoryOutput, evidence: Mapping[str, Evidence]) -> None:
    if not isinstance(output, AdvisoryOutput) or output.execution_authorized is not False:
        raise AgentFault("invalid-output")
    if (not isinstance(output.claims, tuple) or not 1 <= len(output.claims) <= 12
            or not isinstance(output.proposals, tuple) or len(output.proposals) > 8):
        raise AgentFault("output-bound-exceeded")
    for claim in output.claims:
        check_claim(claim, evidence)
    ids: set[str] = set()
    for proposal in output.proposals:
        check_proposal(proposal, evidence)
        if proposal.proposal_id in ids:
            raise AgentFault("duplicate-proposal")
        ids.add(proposal.proposal_id)
