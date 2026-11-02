"""Source-authored integration regressions; intentionally not executed."""
from dataclasses import replace
from hashlib import sha256
import json
from types import SimpleNamespace

import pytest

from adapters.handlers import _Job, create_handlers
from adapters.http import HttpsTransport
from adapters.model_use import ModelUsePolicy, ModelUseRequests
from adapters.ports import AdapterUnavailable, EndpointPolicy
from providers.ports import HttpRequest


class Authority:
    def encode(self, value):
        return json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
    def digest(self, value):
        return sha256(self.encode(value)).hexdigest()
    def validate(self, name, value, version="1.0.0"):
        assert name == "ModelUseRequest"
        assert value["maximumOutputTokens"] == 0 or value["inputTokens"] is not None
        return True


def requests():
    model = SimpleNamespace(model_version="model-exact", tokenizer_sha256="a" * 64,
                            tokenize_endpoint_id="tokenize", completion_endpoint_id="complete")
    policy = ModelUsePolicy("research-service", "1.0.0", "research", "tokenizer-artifact",
                            "token-grant", "1.0.0", "completion-grant", "2.0.0")
    endpoints = tuple(SimpleNamespace(endpoint_id=e, provider="model-provider") for e in ("tokenize", "complete"))
    selection = {"selectionId": "selection", "selectionSha256": "b" * 64, "artifacts": [
        {"bindingId": e, "artifact": {"artifactSha256": digest * 64}} for e, digest in (("tokenize", "c"), ("complete", "d"))]}
    lease = {"accountAlias": "account", "environment": "research", "researchPrincipalId": "principal",
             "jobId": "job", "leaseId": "lease", "leaseEpoch": "1"}
    return ModelUseRequests(config=SimpleNamespace(model=model, model_use=policy, endpoint_policies=endpoints),
                            selection=selection, lease=lease, contracts=Authority())


def test_model_use_request_binds_actual_bytes_not_provider_label_or_permission_flag():
    builder = requests()
    wire = b'{"messages":[{"content":"untrusted"}]}'
    evidence = ({"artifactId": "evidence", "artifactSha256": "e" * 64, "reviewId": "review",
                 "reviewVersion": "3.2.1", "rightsPolicyId": "rights", "rightsVersion": "2.1.0"},)
    value = builder.request(operation="model-completion", input_bytes=wire, evidence_refs=evidence,
        deadline_ns=1_800_000_000_123_456_789, input_tokens=13, maximum_output_tokens=9, maximum_cost_usd="0.04", tools=("read-evidence",))
    assert value["inputSha256"] == sha256(wire).hexdigest()
    assert value["inputBytes"] == len(wire)
    assert value["evidence"][0]["reviewVersion"] == "3.2.1"
    assert value["grantId"] == "completion-grant"
    assert value["endpointReferenceId"] == "complete"
    assert value["deadlineAt"].endswith(".123456789Z")
    assert value["requestSha256"] == Authority().digest({k: v for k, v in value.items() if k != "requestSha256"})
    changed = builder.request(operation="model-completion", input_bytes=wire + b" ", evidence_refs=evidence,
        deadline_ns=1_800_000_000_123_456_789, input_tokens=13, maximum_output_tokens=9, maximum_cost_usd="0.04", tools=("read-evidence",))
    assert changed["requestSha256"] != value["requestSha256"]


def test_evidence_eligibility_probe_never_authorizes_completion():
    builder = requests()
    probe = builder.eligibility(operation="model-tokenize", input_bytes=b"original canonical evidence",
                                evidence_refs=(), deadline_ns=1_800_000_000_000_000_001)
    assert probe["maximumOutputTokens"] == 0
    assert probe["maximumCostUsd"] == "0"
    assert probe["inputTokens"] is None
    with pytest.raises(AdapterUnavailable):
        builder.eligibility(operation="model-completion", input_bytes=b"evidence", evidence_refs=(), deadline_ns=1)


def test_https_model_request_requires_separate_proof_callback_before_socket():
    transport = object.__new__(HttpsTransport)
    policy = EndpointPolicy("tokenize", "model", "model-tokenize", "https://model.example.com", "/tokenize", "POST",
                            "ref", "Authorization", "Bearer ", (), "rights", "source", allowed_ip_addresses=("93.184.216.34",))
    transport._deadline_ns = 1_800_000_000_000_000_000
    transport._policies = {("model", "model-tokenize"): policy}
    with pytest.raises(AdapterUnavailable, match="independent-model-use-proof-required"):
        transport.request(HttpRequest("model", "model-tokenize", "POST", policy.origin, policy.path, body=b"{}"))


def test_collection_load_budget_applies_before_planner_retains_blob():
    job = object.__new__(_Job)
    job.input_bytes = 15_500_000
    job.check = lambda: None
    job.control = SimpleNamespace(artifacts=SimpleNamespace(read=lambda **fields: b"a" * 1_000_000))
    with pytest.raises(AdapterUnavailable, match="job-input-aggregate-budget"):
        job.artifact({"artifactId": "blob", "sha256": "a" * 64})
    assert job.input_bytes == 15_500_000


def test_registry_only_composes_host_jobs_no_second_scheduler():
    registry = create_handlers(SimpleNamespace())
    assert set(registry) == {"research-run", "dataset-ingest", "knowledge-import"}
    assert all(callable(handler) for handler in registry.values())
