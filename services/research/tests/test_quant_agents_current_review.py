"""Source-only acceptance-overlay regressions; no validation/test run performed."""
from dataclasses import replace
from hashlib import sha256

import pytest

from tests.test_quant_agents_safety import (
    BASE, CodecFixture, Rights, Retrieval, request, setup, staged,
)


def test_unreviewed_original_bytes_are_preserved_with_fresh_current_acceptance():
    retrieval = Retrieval()
    original = retrieval.result.citations[0]
    original_bytes = original.original_bytes
    original_hash = sha256(original_bytes).hexdigest()
    runner, ports = setup(retrieval=retrieval)
    result = runner.run(request())
    assert result.status == "completed"
    assert original.evidence["acceptanceStatus"] == "unreviewed"
    assert original.original_bytes == original_bytes
    assert CodecFixture().encode(original.evidence) == original_bytes
    assert result.evidence[0].artifact_digest == original_hash
    assert result.evidence[0].accepted_review_id == "review-2"
    assert result.evidence[0].accepted_review_revision == 2
    assert result.evidence[0].content_hash == original.evidence["contentHash"]
    assert result.evidence[0].excerpt_digest == original.content_digest
    assert result.evidence[0].untrusted_content is True
    call = ports["rights"].review_calls[0]
    assert call["original_bytes"] == original_bytes
    assert call["artifact_digest"] == original_hash
    assert (call["account_alias"], call["environment"], call["purpose"]) == (
        "account-paper", "paper", "research",
    )
    assert call["reference_ns"] == BASE


@pytest.mark.parametrize("legacy_status", ["accepted", "unreviewed"])
def test_legacy_accepted_label_without_current_overlay_denies(legacy_status):
    retrieval = Retrieval()
    retrieval.result = replace(retrieval.result, citations=(staged(acceptanceStatus=legacy_status),))
    rights = Rights()
    rights.review_missing = True
    runner, ports = setup(retrieval=retrieval, rights=rights)
    result = runner.run(request())
    assert result.errors == ("rights-denied",)
    assert not ports["model"].calls
    assert len(rights.review_calls) == 1


def test_latest_rejected_overlay_never_falls_back_to_older_acceptance():
    retrieval = Retrieval()
    retrieval.result = replace(retrieval.result, citations=(staged(acceptanceStatus="accepted"),))
    rights = Rights()
    rights.review_changes = {"review_id": "review-3", "revision": 3, "status": "rejected"}
    runner, ports = setup(retrieval=retrieval, rights=rights)
    assert runner.run(request()).errors == ("rights-denied",)
    assert len(rights.review_calls) == 1
    assert not ports["model"].calls


@pytest.mark.parametrize("changes", [
    {"actor_id": "other"}, {"account_alias": "other"}, {"environment": "live"},
    {"collection_id": "other"}, {"snapshot_id": "other"}, {"evidence_id": "other"},
    {"artifact_digest": "f" * 64}, {"rights_policy_id": "other"}, {"purpose": "execution"},
    {"current": False}, {"current": 1}, {"superseded": True}, {"superseded": None},
    {"status": "unreviewed"}, {"expires_ns": BASE}, {"effective_ns": BASE + 1},
    {"resolved_ns": BASE - 1}, {"resolved_ns": BASE + 1},
    {"revision": 0}, {"revision": True}, {"rights_authorized": False},
    {"rights_authorized": 1}, {"rights_valid_until_ns": BASE},
])
def test_overlay_identity_currentness_expiry_and_rights_must_all_match(changes):
    rights = Rights()
    rights.review_changes = changes
    runner, ports = setup(rights=rights)
    result = runner.run(request())
    assert result.errors == ("rights-denied",)
    assert not ports["model"].calls


def test_changed_decoded_record_cannot_be_reviewed_under_original_artifact_hash():
    retrieval = Retrieval()
    original = retrieval.result.citations[0]
    changed = dict(original.evidence)
    changed["claim"] = "Altered claim under unchanged bytes"
    retrieval.result = replace(retrieval.result, citations=(replace(original, evidence=changed),))
    runner, ports = setup(retrieval=retrieval)
    assert runner.run(request()).errors == ("invalid-evidence",)
    assert not ports["rights"].review_calls
    assert not ports["model"].calls


def test_missing_or_mutable_original_bytes_are_not_an_evidence_fallback():
    for bad_bytes in (b"", bytearray(b"{}"), b"{}"):
        retrieval = Retrieval()
        retrieval.result = replace(retrieval.result, citations=(
            replace(retrieval.result.citations[0], original_bytes=bad_bytes),
        ))
        runner, ports = setup(retrieval=retrieval)
        assert runner.run(request()).errors == ("invalid-evidence",)
        assert not ports["rights"].review_calls


def test_resolver_missing_or_exception_is_denied_without_legacy_fallback():
    rights = Rights()
    rights.resolve_current = None
    runner, ports = setup(rights=rights)
    assert runner.run(request()).errors == ("rights-denied",)
    assert not ports["model"].calls
    def fail(**kwargs):
        raise RuntimeError("private stateauth detail")
    rights.resolve_current = fail
    result = runner.run(request(run_id="run-2"))
    assert result.errors == ("rights-denied",)
    assert "private stateauth detail" not in repr(result)


def test_admitted_evidence_lease_uses_earliest_current_review_rights_expiry():
    rights = Rights()
    rights.review_changes = {"expires_ns": BASE + 200, "rights_valid_until_ns": BASE + 100}
    runner, _ = setup(rights=rights)
    result = runner.run(request())
    assert result.status == "completed"
    assert result.evidence[0].valid_until_ns == BASE + 100


def test_no_default_account_or_environment_scope_is_accepted():
    runner, ports = setup()
    assert runner.run(request(environment="unknown")).errors == ("rights-denied",)
    assert not ports["rights"].review_calls
    assert not ports["model"].calls
