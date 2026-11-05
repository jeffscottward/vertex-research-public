"""Joined source-only fakes; no model/provider/SQL and no real ledger guarantee."""
import asyncio
import base64
from dataclasses import replace
from datetime import datetime, timezone
from hashlib import sha256
from types import SimpleNamespace

import pytest

from adapters.configuration import AdapterConfiguration
from adapters.handlers import _research, create_handlers
from adapters.ports import AdapterUnavailable
from agents.types import RetrievalResult, Scope
from agents.wire import internal_value
from vertex_control import ArtifactAdapter, ControlError, RunAdmissionAdapter
from vertex_control.adapters import _revision

from tests.test_quant_agents_safety import (
    AUTHORIZATION, BASE, CodecFixture, Model, Rights, request, staged,
)


class Authority(CodecFixture):
    """Injected unit authority, not public-schema conformance evidence."""
    def validate(self, name, value, schema_version="1.0.0"):
        assert schema_version == "1.0.0"
        return True

    def epoch_ns(self, value):
        if value in ("captured", "published"):
            return BASE if value == "captured" else BASE - 1
        if value.isdecimal():
            return int(value)
        whole = datetime.fromisoformat(value[:19]).replace(tzinfo=timezone.utc)
        return int(whole.timestamp()) * 1_000_000_000 + int(value[20:29])


class TestBridge:
    __test__ = False

    def run(self, factory, *, timeout_seconds):
        assert timeout_seconds > 0
        return asyncio.run(factory())


class LedgerClient:
    """Characterizes publishAgent's public-only output ownership and complete.

    Stage is private storage, not publication; this intentionally has no path
    promoting an advisory to the public output ledger. It is not a DB substitute.
    """
    def __init__(self, authority, lease, mode):
        self.authority, self.lease, self.mode = authority, lease, mode
        self.calls, self.staged, self.public, self.owned = [], {}, {}, set()
        self.publication = self.completion = self.admission = None
        self.publication_writes = 0

    def receipt(self, status="accepted", state="running", **changes):
        return {"status": status, "jobId": self.lease["jobId"], "state": state,
                "lease": dict(self.lease), "outputArtifactIds": sorted(self.owned),
                "reason": None, **changes}

    def commit_agent(self, payload):
        assert self.admission is not None
        assert payload["run"]["runId"] == self.admission["runId"]
        assert payload["collectionId"] == "collection-1"
        assert all(pin["collectionId"] == "collection-1" for pin in payload["reviewPins"])
        for key in ("artifact", "advisoryProfileArtifact"):
            ref = payload[key]
            assert sha256(self.staged[ref["artifactId"]]).hexdigest() == ref["artifactSha256"]
        digest = self.authority.digest(payload)
        if self.publication is not None:
            if digest != self.publication:
                raise ControlError("conflicting-publication")
            return self.receipt("duplicate")
        public_id = payload["artifact"]["artifactId"]
        self.public[public_id] = payload["run"]
        self.owned.add(public_id)
        self.publication = digest
        self.publication_writes += 1
        return self.receipt()

    async def call(self, method, payload):
        self.calls.append((method, payload))
        for key in ("accountAlias", "environment", "jobId", "leaseId", "leaseEpoch"):
            assert payload[key] == self.lease[key]
        if method == "admitRun":
            if self.admission is not None:
                assert payload == self.admission
                return self.receipt("duplicate")
            self.admission = payload
            return self.receipt()
        if method == "stageArtifact":
            content = base64.b64decode(payload["contentBase64"], validate=True)
            assert payload["collectionId"] == "collection-1"
            assert sha256(content).hexdigest() == payload["contentSha256"]
            previous = self.staged.setdefault(payload["artifactId"], content)
            if previous != content:
                raise ControlError("conflicting-stage")
            return {"status": "accepted", "artifact": {"artifactId": payload["artifactId"],
                    "artifactSha256": payload["contentSha256"]}, "contentSha256": payload["contentSha256"],
                    "canonicalSha256": payload["canonicalSha256"]}
        if method == "publishAgent":
            receipt = self.commit_agent(payload)
            if self.mode == "duplicate":
                return self.commit_agent(payload)
            if self.mode == "lost-ack":
                raise ControlError("transport-timeout", effect="unknown")
            if self.mode == "unknown":
                return self.receipt("unknown", "unknown")
            if self.mode == "missing-owned-output":
                return self.receipt(outputArtifactIds=[])
            return receipt
        if method == "complete":
            assert set(payload["outputArtifactIds"]) <= self.owned, "unowned completion output"
            assert all(identity in self.public for identity in payload["outputArtifactIds"])
            digest = self.authority.digest(payload)
            if self.completion is not None:
                assert digest == self.completion, "conflicting completion"
                return self.receipt("duplicate", "succeeded")
            self.completion = digest
            return self.receipt("completed", "succeeded")
        raise AssertionError("unexpected control operation")


class JoinedRights(Rights):
    def __init__(self, context):
        super().__init__()
        self.context = context
        self._pins = {}

    def current(self, policy, uses, **fields):
        assert policy == "rights-1"
        if self.denied:
            raise ControlError("rights-denied")

    def resolve_current(self, **kwargs):
        assert kwargs["authorization"] is self.context.authorization
        result = super().resolve_current(**{**kwargs, "authorization": AUTHORIZATION})
        result = replace(result, revision=_revision("1.0.0"))
        self._pins[kwargs["evidence_id"]] = {
            "collectionId": kwargs["collection_id"], "evidenceId": kwargs["evidence_id"],
            "artifactId": kwargs["evidence_id"], "artifactSha256": kwargs["artifact_digest"],
            "reviewId": result.review_id, "reviewVersion": "1.0.0",
            "rightsPolicyId": "rights-1", "rightsVersion": "1.0.0",
        }
        return result

    def authorize(self, **kwargs):
        assert kwargs["authorization"] is self.context.authorization
        return super().authorize(**{**kwargs, "authorization": AUTHORIZATION})


class JoinedRetrieval:
    def __init__(self):
        self.calls = []

    def retrieve(self, **kwargs):
        self.calls.append(kwargs)
        snapshot = kwargs["snapshot_id"]
        citation = staged(collectionId=kwargs["collection_id"], snapshotId=snapshot,
                          evidenceId="evidence-" + snapshot)
        return RetrievalResult("available", kwargs["collection_id"], snapshot, (citation,))


def joined(monkeypatch, *, scopes=(Scope("collection-1", "snapshot-1"),), mode="accepted"):
    authority = Authority()
    req = request(environment="research", reference_ns=BASE, deadline_ns=BASE + 100_000,
                  per_attempt_timeout_ns=50_000, scopes=scopes)
    payload = {"profile": "vertex-research-run-v1", "request": internal_value(req), "thread_id": None}
    lease = {"kind": "research-run", "jobId": "job-1", "leaseId": "lease-1", "leaseEpoch": "1",
             "researchPrincipalId": req.actor_id, "accountAlias": req.account_alias, "environment": req.environment,
             "deadlineAt": str(req.deadline_ns), "policySelectionId": "selection-1",
             "policySelectionSha256": "a" * 64, "payloadSha256": authority.digest(payload)}
    model = Model()
    client = LedgerClient(authority, lease, mode)
    selection = {"selectionId": "selection-1", "selectionSha256": "a" * 64,
        "accountAlias": req.account_alias, "environment": req.environment,
        "issuedAt": str(BASE - 1), "expiresAt": str(BASE + 100_000),
        "policies": [{"role": "licensing-rights", "policyId": "rights-1", "version": "1.0.0"}],
        "research": {"modelVersion": req.model_version, "taskContract": req.task_contract,
                     "tokenBudget": req.budget.tokens, "costBudgetUsd": req.budget.usd,
                     "allowedTools": req.allowed_tools, "modelCapabilityId": "model-capability"},
        "providerCapabilities": [{"capabilityId": "model-capability", "providerId": "fixture",
            "operation": "model-completion", "modelVersion": req.model_version, "state": "ready",
            "observedAt": str(BASE - 1), "expiresAt": str(BASE + 100_000), "rightsPolicyId": "rights-1"}]}
    config = AdapterConfiguration(selection_id="selection-1", selection_sha256="a" * 64,
        endpoint_policies=(), providers={}, model=SimpleNamespace(model_version=req.model_version),
        model_use=None, admission_limits=(), calendars={})
    context = SimpleNamespace(contracts=authority, selection=selection, adapter_config=config,
        clock=SimpleNamespace(now_ns=lambda: BASE), cancellation=SimpleNamespace(is_set=lambda: False),
        control=client, control_bridge=TestBridge(), admission=object(), supervisor=object(),
        chat_events=None, secret_resolver=None)
    composed = []

    def compose(*, client, bridge, context, rights_mode):
        # Same keyword contract as vertex_control.create_research_adapters. The
        # fixture uses the default (non-observation) adapter profile.
        assert rights_mode == "legacy"
        rights = JoinedRights(context)
        bundle = SimpleNamespace(rights=rights, retrieval=JoinedRetrieval(),
            artifacts=ArtifactAdapter(client, bridge, context, rights),
            admission=RunAdmissionAdapter(client, bridge, context))
        composed.append(bundle)
        return bundle

    monkeypatch.setattr("vertex_control.create_research_adapters", compose)
    monkeypatch.setattr("adapters.handlers.create_model", lambda **kwargs: model)
    return context, payload, lease, client, model, composed


def complete(client, lease, outcome):
    assert outcome["executionAuthorized"] is False
    payload = {key: lease[key] for key in ("accountAlias", "environment", "jobId", "leaseId", "leaseEpoch")}
    payload.update(outcome="succeeded", outcomeSha256=client.authority.digest(outcome),
                   outputArtifactIds=outcome["outputArtifactIds"])
    return asyncio.run(client.call("complete", payload))


@pytest.mark.parametrize("mode", ["accepted", "duplicate"])
def test_joined_publication_handler_completion_owns_public_run_only(monkeypatch, mode):
    context, payload, lease, client, model, composed = joined(monkeypatch, mode=mode)
    outcome = asyncio.run(create_handlers(context)["research-run"](payload, lease))
    assert outcome["status"] == "completed"
    assert outcome["outputArtifactIds"] == [payload["request"]["run_id"]]
    assert len(model.calls) == 1
    assert composed[0].artifacts.context.collection_id == "collection-1"
    assert client.publication_writes == 1
    run = client.public[outcome["outputArtifactIds"][0]]
    private_ids = run["outputArtifactIds"]
    assert len(private_ids) == 1 and private_ids[0] in client.staged
    assert private_ids[0] not in client.owned and private_ids[0] not in client.public
    assert complete(client, lease, outcome)["status"] == "completed"
    assert complete(client, lease, outcome)["status"] == "duplicate"
    with pytest.raises(AssertionError, match="unowned completion output"):
        complete(client, lease, {**outcome, "outputArtifactIds": private_ids + outcome["outputArtifactIds"]})
    assert len(model.calls) == 1


@pytest.mark.parametrize("mode", ["unknown", "lost-ack", "missing-owned-output"])
def test_joined_uncertain_publication_never_claims_completion_or_retries(monkeypatch, mode):
    context, payload, lease, client, model, _ = joined(monkeypatch, mode=mode)
    outcome = _research(context, payload, lease)
    assert outcome["status"] == "unknown"
    assert outcome["outputArtifactIds"] == []
    assert outcome["executionAuthorized"] is False
    assert len(model.calls) == client.publication_writes == 1
    assert [method for method, _ in client.calls].count("publishAgent") == 1
    assert not any(method == "complete" for method, _ in client.calls)


@pytest.mark.parametrize("scopes", [(), (Scope("", "snapshot-1"),), (Scope(None, "snapshot-1"),),
    (Scope("collection-1", "snapshot-1"), Scope("other", "snapshot-2")),
    (Scope("collection-1", "snapshot-1"), Scope("collection-1", "snapshot-1"))])
def test_invalid_or_mixed_collection_denied_before_control_or_model(monkeypatch, scopes):
    context, payload, lease, client, model, composed = joined(monkeypatch, scopes=scopes)
    with pytest.raises(AdapterUnavailable):
        _research(context, payload, lease)
    assert not composed and not client.calls and not model.calls


def test_same_collection_multiple_snapshots_remain_independent_admitted_scopes(monkeypatch):
    scopes = (Scope("collection-1", "snapshot-1"), Scope("collection-1", "snapshot-2"))
    context, payload, lease, client, model, composed = joined(monkeypatch, scopes=scopes)
    outcome = _research(context, payload, lease)
    assert outcome["status"] == "completed"
    assert composed[0].artifacts.context.collection_id == "collection-1"
    assert composed[0].artifacts.context.snapshot_id is None
    assert [call["snapshot_id"] for call in composed[0].retrieval.calls] == ["snapshot-1", "snapshot-2"]
    assert {item.snapshot_id for item in model.calls[0].untrusted_evidence} == {"snapshot-1", "snapshot-2"}
    assert complete(client, lease, outcome)["status"] == "completed"


def test_tampered_request_collection_rejected_by_admitted_payload_digest(monkeypatch):
    context, payload, lease, client, model, composed = joined(monkeypatch)
    payload["request"]["scopes"][0]["collection_id"] = "other"
    outcome = asyncio.run(create_handlers(context)["research-run"](payload, lease))
    assert outcome["status"] == "unavailable"
    assert outcome["reason"] == "job-payload-digest-mismatch"
    assert not client.calls and not model.calls and not composed


def test_joined_rights_revocation_during_model_call_blocks_staging(monkeypatch):
    context, payload, lease, client, model, composed = joined(monkeypatch)
    respond = model.handler
    def revoke(call):
        result = respond(call)
        composed[0].rights.denied = True
        return result
    model.handler = revoke
    outcome = _research(context, payload, lease)
    assert outcome["status"] != "completed"
    assert outcome["outputArtifactIds"] == []
    assert len(model.calls) == 1
    assert not client.staged and not client.public


@pytest.mark.parametrize("stop", ["cancelled", "deadline"])
def test_joined_stop_before_publication_cannot_return_completion_outputs(monkeypatch, stop):
    context, payload, lease, client, model, _ = joined(monkeypatch)
    respond = model.handler
    def interrupt(call):
        result = respond(call)
        if stop == "cancelled":
            context.cancellation.is_set = lambda: True
        else:
            context.clock.now_ns = lambda: int(lease["deadlineAt"])
        return result
    model.handler = interrupt
    outcome = asyncio.run(create_handlers(context)["research-run"](payload, lease))
    assert outcome["status"] == "unavailable"
    assert outcome["outputArtifactIds"] == []
    assert len(model.calls) == 1
    assert not client.staged and not client.public
