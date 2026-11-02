"""Native control/HTTPS boundary refusals; composed real-owner proof is in Civet."""
from copy import deepcopy
from types import SimpleNamespace

import pytest

from adapters.chat_consumer import ApprovedChatConsumer, ChatTransportUnknown, run_research_chat
from adapters.configuration import PrivacyReviewRendezvous
from adapters.tests.test_chat_consumer import build_boundary, prohibit_real_network
from vertex_control.client import ControlClient, ControlError

LIMITS = {"maximum_wait_ms": 1000, "maximum_status_reads": 3, "poll_interval_ms": 100}


def rendezvous_boundary(monkeypatch, *, limits=None, lost_ack=False, observed=True):
    f = build_boundary(monkeypatch, rendezvous=limits or LIMITS)
    original = f.control.call
    candidates, reads, submissions, decisions = {}, [], [], {}
    def call(method, request):
        if method not in {"prepareModelPrivacyReview", "readModelPrivacyReview"}:
            if method == "currentModelUse":
                assert decisions.get(request["operation"]) == "accepted"
            return original(method, request)
        f.control.calls.append((method, deepcopy(request)))
        operation = request["operation"]
        if method == "prepareModelPrivacyReview":
            submissions.append(deepcopy(request))
            assert operation not in candidates
            if observed:
                candidates[operation] = deepcopy(request)
            if lost_ack:
                raise ControlError("synthetic-lost-submit-ack", effect="unknown")
        else:
            reads.append(deepcopy(request))
            if operation in candidates:
                assert request == candidates[operation]
        candidate_id = "chat-candidate-" + f.authority.digest({
            "responseRequestId": f.recipe["response_request_id"], "planId": f.recipe["plan_id"],
            "planSha256": f.recipe["plan_sha256"], "request": request})
        reply = {"candidateId": candidate_id, "requestId": request["requestId"],
                 "requestSha256": request["requestSha256"],
                 "status": decisions.get(operation, "pending") if operation in candidates else "not-observed",
                 "expiresAt": f.lease["deadlineAt"] if operation in candidates else None}
        f.review_hook(method, request, reply)
        return reply
    f.control.call = call
    f.review_hook = lambda method, request, reply: None
    f.submissions, f.status_reads, f.decisions = submissions, reads, decisions
    return f


def approve_after_pending(f):
    def independent_transport(method, request, reply):
        # External reviewer transport DOUBLE here, never a production auto-review.
        operation = request["operation"]
        expected_sends = 0 if operation == "model-tokenize" else 1
        if reply["status"] == "pending":
            assert len(f.http.sent) == expected_sends
            assert len(f.control.proofs) == expected_sends * 2
            f.decisions[operation] = "accepted"
    f.review_hook = independent_transport


def test_pending_each_exact_request_then_existing_two_checks_and_publication(monkeypatch):
    f = rendezvous_boundary(monkeypatch)
    approve_after_pending(f)
    outcome = run_research_chat(f.job(), f.recipe)
    assert outcome["status"] == "completed"
    assert [r["inputTokens"] for r in f.submissions] == [None, 200]
    assert len(f.status_reads) == 2 and len(f.submissions) == 2
    assert [body for _, _, body in f.http.sent] == [f.prepared.tokenize_input, f.prepared.completion_input]
    assert len(f.control.proofs) == 4 and len(f.control.publications) == 1


def test_old_default_never_calls_rendezvous(monkeypatch):
    f = build_boundary(monkeypatch)
    assert f.config.privacy_review_rendezvous is None
    assert run_research_chat(f.job(), f.recipe)["status"] == "completed"
    assert all("PrivacyReview" not in method for method, _ in f.control.calls)


@pytest.mark.parametrize("lost_ack", [False, True])
def test_submit_once_reconcile_same_exact_key_without_retokenizing(monkeypatch, lost_ack):
    f = rendezvous_boundary(monkeypatch, lost_ack=lost_ack)
    approve_after_pending(f)
    consumer = ApprovedChatConsumer(f.job(), f.recipe)
    assert consumer.consume().input_tokens == 200
    assert len(f.submissions) == 2 and len(f.http.sent) == 2
    assert all(any(read == submitted for submitted in f.submissions) for read in f.status_reads)
    with pytest.raises(ChatTransportUnknown):
        consumer.consume()
    assert len(f.submissions) == 2 and len(f.http.sent) == 2


def test_lost_ack_absence_is_unknown_not_permission_to_resubmit(monkeypatch):
    f = rendezvous_boundary(monkeypatch, lost_ack=True, observed=False)
    assert run_research_chat(f.job(), f.recipe)["status"] == "unknown"
    assert len(f.submissions) == 1 and len(f.status_reads) == 1
    assert f.http.sent == [] and f.control.proofs == []


@pytest.mark.parametrize("refusal", ["pending", "rejected", "revoked", "expired", "cancelled", "identity", "request", "candidate", "status-unknown"])
def test_pending_refusals_and_finite_status_budget_make_no_dispatch(monkeypatch, refusal):
    f = rendezvous_boundary(monkeypatch)
    def hook(method, request, reply):
        if refusal == "rejected": reply["status"] = "rejected"
        if refusal == "revoked": raise ControlError("synthetic-review-grant-revoked")
        if refusal == "expired": reply["expiresAt"] = "2027-01-15T08:00:10Z"
        if refusal == "cancelled": f.context.cancellation.set()
        if refusal == "identity": reply["requestId"] = "other-request"
        if refusal == "request": reply["requestSha256"] = "a" * 64
        if refusal == "candidate": reply["candidateId"] = "other-candidate"
        if refusal == "status-unknown" and method == "readModelPrivacyReview": raise ControlError("synthetic-status-unavailable")
    f.review_hook = hook
    assert run_research_chat(f.job(), f.recipe)["status"] in {"failed", "cancelled", "unknown"}
    assert f.http.sent == [] and f.control.proofs == []
    assert len(f.submissions) == 1 and len(f.status_reads) <= LIMITS["maximum_status_reads"]
    if refusal == "pending": assert len(f.status_reads) == LIMITS["maximum_status_reads"]


def test_completion_wait_cancellation_retains_count_without_new_tokenizer(monkeypatch):
    f = rendezvous_boundary(monkeypatch)
    def hook(method, request, reply):
        if request["operation"] == "model-tokenize": f.decisions["model-tokenize"] = "accepted"
        else:
            assert request["inputTokens"] == 200
            f.context.cancellation.set()
    f.review_hook = hook
    # Cancellation races completion-candidate submission: the post-return guard
    # cannot confirm its effect, so the unchanged terminal mapping keeps unknown.
    assert run_research_chat(f.job(), f.recipe) == {
        "status": "unknown", "reason": "chat-output-effect-unknown",
        "outputArtifactIds": [], "executionAuthorized": False,
    }
    assert [path for _, path, _ in f.http.sent] == ["/tokenize"]
    assert len(f.submissions) == 2 and len(f.control.proofs) == 2


def test_provider_unknown_does_not_retry_or_make_completion_candidate(monkeypatch):
    f = rendezvous_boundary(monkeypatch)
    approve_after_pending(f)
    f.http.failure = "/tokenize"
    assert run_research_chat(f.job(), f.recipe)["status"] == "unknown"
    assert len(f.submissions) == 1 and len(f.http.sent) == 1


@pytest.mark.parametrize("changes", [{"maximum_wait_ms": 0}, {"maximum_status_reads": 0}, {"maximum_status_reads": True}, {"poll_interval_ms": 99}, {"maximum_wait_ms": 300001}, {"poll_interval_ms": 1001}])
def test_selected_finite_config_limits_are_strict(changes):
    with pytest.raises(Exception):
        PrivacyReviewRendezvous(**{**LIMITS, **changes})


def test_control_effects_are_submit_unknown_and_status_read_only():
    sent = SimpleNamespace(sent=True)
    assert ControlClient._effect("prepareModelPrivacyReview", sent) == "unknown"
    assert ControlClient._effect("readModelPrivacyReview", sent) == "none"
    assert ControlClient._effect("prepareModelPrivacyReview", SimpleNamespace(sent=False)) == "not-sent"
