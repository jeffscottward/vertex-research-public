"""Python boundary tests ONLY; not real issuer/worker integration acceptance.

Actual configuration/_Job/admission/read/evidence/proof/HTTPS Python owners run
against external control-client and HTTP doubles. No provider, DB, SDK, model or
privacy issuer is installed/executed. Main runs these after both writers release.
"""
from __future__ import annotations

from base64 import b64decode, b64encode
from copy import deepcopy
from dataclasses import asdict, replace
from hashlib import sha256
import asyncio
import json
import socket
import threading
from types import SimpleNamespace

import pytest

from adapters.chat_consumer import ApprovedChatConsumer, ChatTransportUnknown, _input_json, decode_chat_recipe, run_research_chat
from adapters.chat_inputs import _timestamp_ns, canonical_chat_input_bytes, prepare_chat_inputs
from adapters.configuration import load_configuration
from adapters.handlers import _Job, _research, create_handlers
from adapters.model_use import ModelUsePolicy, timestamp_ns
from adapters.ports import AdapterUnavailable
from adapters.tests.test_chat_inputs import fixture as input_fixture
from vertex_control.adapters import _revision
from vertex_control.client import ControlError, SameORPCJSON


class AuthorityDouble:
    """Contract boundary double; never a real TS authority/issuer claim."""
    def encode(self, value):
        return json.dumps(value, ensure_ascii=False, allow_nan=False, sort_keys=True, separators=(",", ":")).encode()

    def digest(self, value):
        return sha256(self.encode(value)).hexdigest()

    def epoch_ns(self, value):
        return _timestamp_ns(value)

    def validate(self, name, value, version="1.0.0"):
        assert version == "1.0.0"
        assert name in {"RuntimePolicySelection", "WorkerLease", "WorkerFence", "ModelUseRequest", "ModelUseProof",
                        "AcceptedReview", "AgentRun", "WorkerStageArtifactInput", "WorkerStageArtifactOutput", "WorkerResult", "WorkerModelPrivacyReviewOutput"}
        if name == "ModelUseRequest":
            assert value["tools"] == []
            assert value["maximumOutputTokens"] == 0 or type(value["inputTokens"]) is int
        if name == "ModelUseProof":
            assert set(value) == {"schemaVersion", "requestId", "requestSha256", "accountAlias", "environment",
                "researchPrincipalId", "consumerServiceId", "selectionId", "selectionSha256", "providerId", "modelVersion",
                "tokenizerArtifactId", "tokenizerSha256", "endpointReferenceId", "endpointSha256", "modelUsePolicyVersion",
                "jobId", "leaseId", "leaseEpoch", "grantId", "grantVersion", "grantRevision", "operation", "decision",
                "reasonCodes", "checkedAt", "validUntil", "currentEvidenceSha256", "privacyPolicyId", "privacyPolicyVersion",
                "externalDispatchAllowed", "modelProcessingOnly", "executionAuthorized"}
        return True


class ControlDouble:
    """External authority responses; fixture privacy/grants are not issuance."""
    def __init__(self, authority, clock):
        self.authority, self.clock = authority, clock
        self.calls, self.proofs = [], []
        self.dispatched = set()
        self.mutate = lambda method, fields, reply: None
        self.copies = {}
        self.admissions = 0
        self.config = SimpleNamespace(max_request_bytes=2_097_152, envelope=SameORPCJSON())
        self.records, self.governed, self.ordinary = {}, {}, {}
        self.publications, self.proof_replies, self.durable_outputs = [], [], []
        self.collection_id, self.evidence_id, self.evidence_artifact_id = "collection", "evidence", "evidence-artifact"
        self.rights_policy_id, self.rights_version = "rights", "1.0.0"
        self.publication_rights_policy_id, self.publication_rights_version = "rights", "1.0.0"

    def call(self, method, fields):
        self.calls.append((method, deepcopy(fields)))
        assert all(fields[key] == self.lease[key] for key in ("accountAlias", "environment", "jobId", "leaseId", "leaseEpoch"))
        if method == "admitRun":
            assert fields["requestSha256"] == self.lease["payloadSha256"]
            assert fields["runId"] == self.recipe["run_id"]
            self.admissions += 1
            reply = {"jobId": self.lease["jobId"], "status": "accepted" if self.admissions == 1 else "duplicate",
                     "state": "running", "lease": deepcopy(self.lease), "admittedAt": timestamp_ns(self.clock.now_ns())}
        elif method == "readArtifact":
            artifact = fields["artifactId"]
            if artifact in self.copies:
                assert fields["collectionId"] is None
                body = self.copies[artifact]
                canonical = None
            elif artifact in self.records:
                assert fields["collectionId"] == self.collection_id
                body = self.records[artifact]
                canonical = sha256(body).hexdigest()
            else:
                assert artifact == self.evidence_artifact_id and fields["collectionId"] == self.collection_id
                body = self.original
                canonical = sha256(body).hexdigest()
            digest = sha256(body).hexdigest()
            reply = {"artifact": {"artifactId": artifact, "artifactSha256": digest}, "contentSha256": digest,
                     "canonicalSha256": canonical, "contentBase64": b64encode(body).decode(), "contentType": "application/json"}
        elif method == "acceptedEvidence":
            assert fields["collectionId"] == self.collection_id and fields["evidenceId"] == self.evidence_id
            reply = {"artifact": {"artifactId": self.evidence_artifact_id, "artifactSha256": sha256(self.original).hexdigest()},
                     "contentBase64": b64encode(self.original).decode(), "evidence": json.loads(self.original),
                     "review": deepcopy(self.review), "rights": self.rights(self.rights_policy_id)}
        elif method == "currentRights":
            reply = self.rights(fields["policyId"])
        elif method == "currentModelUse":
            request = deepcopy(fields)
            assert self.authority.digest({k: v for k, v in request.items() if k != "requestSha256"}) == request["requestSha256"]
            assert request["requestId"] == "model-use-" + self.authority.digest(
                {k: v for k, v in request.items() if k not in {"requestId", "requestSha256"}})
            self.proofs.append(request)
            key = (self.recipe["response_request_id"], request["operation"])
            fresh = key not in self.dispatched
            self.dispatched.add(key)
            bound = ("schemaVersion", "requestId", "requestSha256", "accountAlias", "environment", "researchPrincipalId",
                "consumerServiceId", "selectionId", "selectionSha256", "providerId", "modelVersion", "tokenizerArtifactId",
                "tokenizerSha256", "endpointReferenceId", "endpointSha256", "modelUsePolicyVersion", "jobId", "leaseId",
                "leaseEpoch", "grantId", "grantVersion", "operation")
            reply = {**{key: request[key] for key in bound}, "decision": "allowed",
                "currentEvidenceSha256": self.authority.digest(request["evidence"]), "reasonCodes": ["allowed"],
                "checkedAt": timestamp_ns(self.clock.now_ns()), "validUntil": request["deadlineAt"], "grantRevision": "1",
                "privacyPolicyId": "fixture-private-decision", "privacyPolicyVersion": "1.0.0",
                "modelProcessingOnly": True, "executionAuthorized": False, "externalDispatchAllowed": fresh}
        elif method == "stageArtifact":
            body = b64decode(fields["contentBase64"], validate=True)
            assert fields["collectionId"] == self.collection_id
            assert fields["rightsPolicyId"] == self.publication_rights_policy_id
            assert fields["rightsVersion"] == self.publication_rights_version
            assert fields["contentSha256"] == fields["canonicalSha256"] == sha256(body).hexdigest()
            assert fields["contentType"] == "application/json" and self.authority.encode(json.loads(body)) == body
            if fields["artifactId"] == self.recipe["copies"]["advisory"]["copyId"]:
                assert set(fields["chatCompletion"]) == {"request", "responseBase64", "proof"}
                assert fields["lineageArtifactIds"] == [self.evidence_artifact_id]
                assert fields["chatCompletion"]["proof"] == self.proof_replies[-1]
                assert fields["chatCompletion"]["proof"]["externalDispatchAllowed"] is False
                assert b64decode(fields["chatCompletion"]["responseBase64"]) == self.http.received["/v1/chat/completions"]
                self.governed[fields["artifactId"]] = body
            else:
                assert fields["artifactId"] == self.recipe["run_id"] and "chatCompletion" not in fields
                assert fields["lineageArtifactIds"] == []
                assert json.loads(body)["status"] == "completed"
                self.ordinary[fields["artifactId"]] = body
            reply = {"status": "accepted", "artifact": {"artifactId": fields["artifactId"], "artifactSha256": fields["contentSha256"]},
                     "contentSha256": fields["contentSha256"], "canonicalSha256": fields["canonicalSha256"]}
        elif method == "publishAgent":
            assert fields["idempotencyKey"] == "chat-publish-" + self.recipe["response_request_id"] and fields["collectionId"] == self.collection_id
            run_id = self.recipe["run_id"]
            assert fields["artifact"] == {"artifactId": run_id, "artifactSha256": sha256(self.ordinary[run_id]).hexdigest()}
            advisory_id = self.recipe["copies"]["advisory"]["copyId"]
            assert fields["advisoryProfileArtifact"] == {"artifactId": advisory_id, "artifactSha256": sha256(self.governed[advisory_id]).hexdigest()}
            assert fields["run"] == json.loads(self.ordinary[run_id])
            assert fields["reviewPins"] == self.recipe["execution"]["reviewPins"]
            self.publications.append(deepcopy(fields))
            self.durable_outputs = [run_id]
            reply = {"status": "accepted", "jobId": self.lease["jobId"], "state": "running", "lease": deepcopy(self.lease),
                     "outputArtifactIds": [run_id], "reason": None}
        else:
            raise AssertionError("No staging, publication, completion, cleanup, or unrelated operation is permitted: " + method)
        self.mutate(method, fields, reply)
        if method == "currentModelUse":
            self.proof_replies.append(deepcopy(reply))
        return reply

    def rights(self, policy):
        version = self.publication_rights_version if policy == self.publication_rights_policy_id else self.rights_version
        return {"policyId": policy, "version": version, "status": "granted",
                "allowedUses": ["read", "store", "derive", "export"], "checkedAt": timestamp_ns(self.clock.now_ns()),
                "expiresAt": self.lease["deadlineAt"], "retentionUntil": None}


class HttpDouble:
    """Only the socket/HTTP external boundary is replaced, not HttpsTransport."""
    def __init__(self, prepared, evidence, authority):
        self.sent = []
        self.failure = None
        self.response_mutator = lambda path, response: None
        self.raw_response_mutator = lambda path, body: body
        self.received = {}
        citation = {key: getattr(evidence, key) for key in ("evidence_id", "source_id", "source_snapshot_id", "content_hash", "excerpt_digest")}
        citation["quote"] = "Original bounded excerpt"
        self.advisory = {"output": {"claims": [{"text": "Synthetic bounded finding.", "kind": "fact", "citations": [citation]}],
                                   "proposals": [], "execution_authorized": False}, "tool_requests": []}
        self.responses = {
            "/tokenize": {"count": 200, "tokens": list(range(200)), "max_model_len": 4096},
            "/v1/chat/completions": {"model": "served-model", "usage": {"prompt_tokens": 200, "completion_tokens": 20, "total_tokens": 220},
                "choices": [{"finish_reason": "stop", "message": {"role": "assistant", "content": authority.encode(self.advisory).decode()}}]},
        }
        self.authority = authority
        self.prepared = prepared

    def connection(self, *args):
        owner = self

        class Connection:
            sock = None
            path = None
            def connect(self):
                return None
            def request(self, method, path, *, body, headers):
                owner.sent.append((method, path, body))
                self.path = path
                assert method == "POST"
                assert body == (owner.prepared.tokenize_input if path == "/tokenize" else owner.prepared.completion_input)
                # Never retain/log even the fixture credential header.
            def getresponse(self):
                if owner.failure == self.path:
                    raise TimeoutError("SENSITIVE PROVIDER ERROR MUST NOT ESCAPE")
                value = deepcopy(owner.responses[self.path])
                owner.response_mutator(self.path, value)
                body = owner.raw_response_mutator(self.path, owner.authority.encode(value))
                owner.received[self.path] = body
                class Response:
                    status = 200
                    offset = 0
                    def getheader(self, name, default=None):
                        return str(len(body)) if name == "Content-Length" else default
                    def read1(self, size):
                        result = body[self.offset:self.offset + size]
                        self.offset += len(result)
                        return result
                return Response()
            def close(self):
                pass
        return Connection()


@pytest.fixture(autouse=True)
def prohibit_real_network(monkeypatch):
    def denied(*args, **kwargs):
        raise AssertionError("No external network in Python chat boundary tests")
    monkeypatch.setattr(socket, "create_connection", denied)
    monkeypatch.setattr(socket.socket, "connect", denied)
    monkeypatch.setattr(socket.socket, "connect_ex", denied)


def build_boundary(monkeypatch, *, rendezvous=None):
    authority = AuthorityDouble()
    args = input_fixture()
    if rendezvous is not None:
        args["human_context"] = replace(args["human_context"], participant_id="first-mate")
    policy = args["policy"]
    manifest = {"profile": "vertex-exact-vllm-serving-v1", "model_version": policy.model_version,
        "served_model": policy.served_model, "model_revision": policy.model_revision, "tokenizer_sha256": policy.tokenizer_sha256,
        "chat_template_sha256": policy.chat_template_sha256, "backend": "vllm-0.9.2", "runtime_image_sha256": "f" * 64,
        "replica_policy": "immutable-identical-no-hot-swap", "template_policy": "reviewed-pure-no-clock-random-or-external-state",
        "input_profile": "text-only-decoder-only-no-documents", "adapter_policy": "no-lora-no-prompt-adapters-no-tools-no-truncation",
        "tokenize_authentication": "authenticated-reverse-proxy-both-paths",
        "pricing_profile": "all-prompt-and-completion-token-ids-single-rate-no-cache-discount"}
    args["policy"] = policy = replace(policy, serving_manifest_sha256=authority.digest(manifest))
    original = {"schemaVersion": "1.0.0", "evidenceId": "evidence", "collectionId": "collection", "snapshotId": "snapshot",
                "rightsPolicyId": "rights", "contentHash": "c" * 64,
                "sourceIdentity": {"provider": "source-provider", "sourceId": "source", "snapshotId": "source-snapshot", "contentHash": "c" * 64},
                "sourceUri": args["evidence"][0].source_uri, "sourceLocator": "paragraph-1", "attribution": "Synthetic source"}
    args["evidence"] = (replace(args["evidence"][0], artifact_digest=authority.digest(original), accepted_review_revision=_revision("1.0.0")),)
    prepared = prepare_chat_inputs(**args)
    now = 1_800_000_010_000_000_000
    clock = SimpleNamespace(now_ns=lambda: now, monotonic=lambda: 100.0)
    issued = timestamp_ns(now - 1_000_000_000)
    expiry = args["identity"].expires_at
    artifacts, bindings = {}, []

    def add(artifact_id, role, document, binding_id=None):
        data = authority.encode(document)
        artifacts[artifact_id] = data
        pin = {"artifactId": artifact_id, "artifactSha256": sha256(data).hexdigest(), "contractName": "PrivateConfig", "schemaVersion": "1.0.0"}
        bindings.append({"bindingId": binding_id or artifact_id, "role": role, "artifact": pin})
        return pin

    model_pin = add("model-policy", "tool-config", asdict(policy))
    endpoint_pins = []
    for endpoint in args["endpoints"]:
        document = asdict(endpoint)
        for key in ("allowed_query_keys", "allowed_ip_addresses"):
            document[key] = list(document[key])
        endpoint_pins.append(add(endpoint.endpoint_id + "-artifact", "endpoint", document, endpoint.endpoint_id))
    tokenizer_pin = {"artifactId": "tokenizer-artifact", "artifactSha256": policy.tokenizer_sha256,
                     "contractName": "Tokenizer", "schemaVersion": "1.0.0"}
    bindings.append({"bindingId": "tokenizer", "role": "tokenizer", "artifact": tokenizer_pin})
    add("manifest", "tool-config", manifest)
    add("prices", "tool-config", {"profile": "vertex-model-price-v1", "model_version": policy.model_version,
        "input_usd_per_million": policy.input_usd_per_million, "output_usd_per_million": policy.output_usd_per_million,
        "rounding": "ceil-aggregate-to-1e-18-usd"})
    use = ModelUsePolicy("research-service", "1.0.0", "research", "tokenizer-artifact", "token-grant", "1.0.0", "completion-grant", "1.0.0")
    add("model-use", "tool-config", asdict(use))
    descriptor = {"format": "vertex-model-binding-v1", "accountAlias": "fixture", "environment": "research",
        "providerId": "provider", "modelVersion": policy.model_version, "tokenizerArtifactId": "tokenizer-artifact",
        "tokenizerSha256": policy.tokenizer_sha256, "endpointReferenceId": "complete", "endpointSha256": endpoint_pins[1]["artifactSha256"],
        "modelUsePolicyVersion": "1.0.0", "expiresAt": expiry,
        "pricing": {"currency": "USD", "basis": "conservative-input-byte-output-token-ceiling", "expiresAt": expiry,
            "tokenizationBaseUsd": args["pricing"].tokenization_base_usd, "tokenizationInputByteUsd": args["pricing"].tokenization_input_byte_usd,
            "completionBaseUsd": args["pricing"].completion_base_usd, "completionInputByteUsd": args["pricing"].completion_input_byte_usd,
            "outputTokenUsd": args["pricing"].output_token_usd}}
    descriptor_pin = add("model-descriptor", "model", descriptor)
    config_doc = {"profile": "vertex-research-chat-adapter-config-v1", "provider_configs": [], "admission_limits": [],
                  "endpoint_artifact_ids": [p["artifactId"] for p in endpoint_pins], "model_artifact_id": "model-descriptor",
                  "model_policy_artifact_id": "model-policy", "model_use_artifact_id": "model-use", "calendar_artifact_ids": []}
    if rendezvous is not None:
        config_doc.update(profile="vertex-first-mate-review-rendezvous-adapter-config-v1", privacy_review_rendezvous=rendezvous)
    add("adapter-config", "provider-config", config_doc)
    selection = {"selectionId": "selection", "accountAlias": "fixture", "environment": "research", "issuedAt": issued, "expiresAt": expiry,
        "artifacts": bindings, "policies": [{"role": "licensing-rights", "policyId": "rights", "version": "1.0.0"}],
        "references": [{"referenceId": "secret-reference-not-a-secret", "kind": "secret-reference"}] + [
            {"referenceId": e.endpoint_id, "kind": "nonsecret-reference", "referenceSha256": pin["artifactSha256"]}
            for e, pin in zip(args["endpoints"], endpoint_pins)],
        "providerCapabilities": [{"capabilityId": e.endpoint_id + "-cap", "endpointReferenceId": e.endpoint_id,
            "endpointSha256": pin["artifactSha256"], "providerId": "provider", "operation": e.operation,
            "modelVersion": policy.model_version, "state": "ready", "observedAt": issued, "expiresAt": expiry, "rightsPolicyId": "policy"}
            for e, pin in zip(args["endpoints"], endpoint_pins)],
        "research": {"modelVersion": policy.model_version, "taskContract": "task-contract", "tokenBudget": 3000, "costBudgetUsd": "2"}}
    selection["selectionSha256"] = authority.digest(selection)
    config = load_configuration(selection, artifacts, authority)
    review_pin = {"collectionId": "collection", "evidenceId": "evidence", "artifactId": "evidence-artifact",
                  "artifactSha256": authority.digest(original), "reviewId": "review", "reviewVersion": "1.0.0",
                  "rightsPolicyId": "rights", "rightsVersion": "1.0.0"}
    limits = args["limits"]
    recipe = {"profile": "vertex-research-chat-job-v1", "run_id": "run", "trace_id": "trace", "actor_id": "owner",
        "account_alias": "fixture", "environment": "research", "response_request_id": "response", "plan_id": "plan", "plan_sha256": "e" * 64,
        "copies": {}, "execution": {"taskContract": "task-contract", "collectionId": "collection", "snapshotId": "snapshot",
            "selectionId": selection["selectionId"], "selectionSha256": selection["selectionSha256"], "deadlineAt": expiry,
            "participantConfiguration": {"artifactId": "expert-config", "artifactSha256": "a" * 64, "contractName": "PrivateConfig", "schemaVersion": "1.0.0"},
            "inputPolicy": {"modelPolicy": model_pin, "modelPolicySha256": authority.digest(asdict(policy)),
                "modelDescriptor": descriptor_pin, "modelDescriptorSha256": authority.digest(descriptor),
                "endpointPolicySha256": {e.operation: p["artifactSha256"] for e, p in zip(args["endpoints"], endpoint_pins)}},
            "provider": {"providerId": "provider", "modelVersion": policy.model_version, "servedModel": policy.served_model,
                "tokenizerArtifact": tokenizer_pin, "tokenizeEndpoint": endpoint_pins[0], "completionEndpoint": endpoint_pins[1],
                "maximumInputTokens": limits.maximum_input_tokens, "maximumOutputTokens": limits.maximum_output_tokens, "maximumCostUsd": limits.maximum_cost_usd},
            "budgets": {"requestTokens": limits.request_tokens, "attemptTokens": limits.attempt_tokens, "requestCostUsd": limits.request_cost_usd,
                "attemptCostUsd": limits.attempt_cost_usd, "tokenizeCostUsd": limits.tokenize_cost_usd, "completionCostUsd": limits.completion_cost_usd},
            "reviewPins": [review_pin]}}
    control = ControlDouble(authority, clock)
    queued = {"schemaVersion": "1.0.0", "runId": "run", "agentRole": "research", "taskContract": "task-contract",
        "allowedTools": [], "modelVersion": policy.model_version, "inputEvidenceIds": ["evidence"], "outputArtifactIds": [],
        "tokenBudget": limits.request_tokens, "costBudgetUsd": limits.request_cost_usd, "status": "queued",
        "errors": [], "approvalRequests": [], "executionAuthorized": False}
    control.records["original-queued-run-fixture"] = authority.encode(queued)
    recipe["execution"].update(advisoryMaximumBytes=200_000, queuedRun={
        "artifactId": "original-queued-run-fixture", "artifactSha256": authority.digest(queued),
        "rightsPolicyId": "rights", "rightsVersion": "1.0.0"})
    control.recipe = recipe
    for purpose, body in (("context", prepared.context), ("tokenizeInput", prepared.tokenize_input), ("completionInput", prepared.completion_input)):
        copy_id = purpose + "-copy"
        control.copies[copy_id] = body
        recipe["copies"][purpose] = {"copyId": copy_id, "reservationSha256": "f" * 64, "sha256": sha256(body).hexdigest(), "byteLength": len(body)}
    recipe["copies"]["advisory"] = {"copyId": "advisory-copy", "reservationSha256": "f" * 64, "content": None}
    lease = {"jobId": "job", "eventId": "event", "kind": "research-run", "researchPrincipalId": "owner", "accountAlias": "fixture",
             "environment": "research", "payloadArtifactId": "recipe-artifact", "payloadSha256": authority.digest(recipe),
             "policySelectionId": selection["selectionId"], "policySelectionSha256": selection["selectionSha256"],
             "deadlineAt": expiry, "leaseId": "lease", "leaseEpoch": "1"}
    control.lease, control.original = lease, authority.encode(original)
    control.review = {"reviewId": "review", "reviewVersion": "1.0.0", "accountAlias": "fixture", "environment": "research",
        "collectionId": "collection", "artifactId": "evidence-artifact", "artifactSha256": authority.digest(original),
        "purpose": "research", "decision": "accepted", "reviewedAt": issued, "expiresAt": expiry,
        "actorId": "independent-reviewer", "policyVersion": "1.0.0"}
    context = SimpleNamespace(contracts=authority, adapter_config=config, selection=selection, clock=clock,
        cancellation=threading.Event(), control=control, control_bridge=SimpleNamespace(run=lambda action, **kwargs: action()),
        admission=SimpleNamespace(acquire=lambda *args: True), supervisor=None,
        secret_resolver=SimpleNamespace(resolve=lambda *args, **kwargs: "synthetic-fixture-credential"))
    http = HttpDouble(prepared, args["evidence"][0], authority)
    control.http = http
    monkeypatch.setattr("adapters.http._PinnedHTTPSConnection", http.connection)
    return SimpleNamespace(recipe=recipe, lease=lease, context=context, control=control, http=http, authority=authority,
        args=args, selection=selection, artifacts=artifacts, config_doc=config_doc, config=config, prepared=prepared,
        job=lambda: _Job(context, lease))


def repin_recipe(f):
    f.lease["payloadSha256"] = f.authority.digest(f.recipe)


def boundary_outcome(f):
    """Test-only capture of the uncomposed lower-level boundary, NOT a handler."""
    try:
        value = ApprovedChatConsumer(f.job(), f.recipe).consume()
    except ChatTransportUnknown as error:
        return {"status": "unknown", "reason": str(error), "outputArtifactIds": []}
    except Exception as error:
        return {"status": "unavailable", "reason": str(error), "outputArtifactIds": []}
    return {"status": "in-memory-only", "value": value}


def test_real_python_boundary_exact_bytes_fixed_output_measured_count_and_no_publication(monkeypatch):
    f = build_boundary(monkeypatch)
    result = ApprovedChatConsumer(f.job(), f.recipe).consume()
    assert result.input_tokens == 200 and result.output_tokens == 20
    assert result.input_tokens != f.recipe["execution"]["budgets"]["attemptTokens"] - 128
    assert [body for _, _, body in f.http.sent] == [f.prepared.tokenize_input, f.prepared.completion_input]
    assert len(json.loads(f.http.sent[1][2])) == 14
    assert "tools" not in json.loads(f.http.sent[1][2]) and json.loads(f.http.sent[0][2])["tools"] is None
    assert json.loads(f.http.sent[1][2])["max_completion_tokens"] == 128
    assert result.human_context.response_request_id == "response"
    assert result.evidence[0].excerpt == f.args["evidence"][0].excerpt
    assert result.evidence[0].captured_ns == 1_800_000_000_000_000_001
    assert type(result.evidence[0].captured_ns) is int
    assert "Literal" not in repr(result) and "Original bounded" not in repr(result)
    first, after_token, complete, after_complete = f.control.proofs
    assert first == after_token and complete == after_complete
    assert first["inputTokens"] is None and first["maximumOutputTokens"] == 0 and first["maximumCostUsd"] == "0.01"
    assert complete["inputTokens"] == 200 and complete["maximumOutputTokens"] == 128 and complete["maximumCostUsd"] == "0.1"
    assert first["endpointReferenceId"] == "tokenize" and complete["endpointReferenceId"] == "complete"
    assert first["inputSha256"] == sha256(f.prepared.tokenize_input).hexdigest()
    assert complete["inputSha256"] == sha256(f.prepared.completion_input).hexdigest()
    assert first["jobId"] == "job" and first["leaseId"] == "lease" and first["leaseEpoch"] == "1"
    assert all(method in {"admitRun", "readArtifact", "acceptedEvidence", "currentRights", "currentModelUse"} for method, _ in f.control.calls)


@pytest.mark.parametrize("missing", ["advisoryMaximumBytes", "queuedRun"])
def test_older_recipe_denies_before_job_admission_reads_model_use_or_http(monkeypatch, missing):
    f = build_boundary(monkeypatch)
    del f.recipe["execution"][missing]
    repin_recipe(f)
    def forbidden(*args, **kwargs):
        raise AssertionError("Missing original output pins must deny before any job or consumer")
    monkeypatch.setattr("adapters.handlers._Job", forbidden)
    monkeypatch.setattr("adapters.chat_consumer.ApprovedChatConsumer", forbidden)
    result = asyncio.run(create_handlers(f.context)["research-run"](f.recipe, f.lease))
    assert result["status"] == "unavailable" and result["outputArtifactIds"] == []
    assert f.control.calls == [] and f.control.proofs == [] and f.http.sent == []


@pytest.mark.parametrize("mutation", ["body", "copy", "plan", "role", "endpoint", "selection", "actor", "deadline", "budget", "descriptor"])
def test_bodyless_decoder_and_original_projection_mismatches_deny_before_http(monkeypatch, mutation):
    f = build_boundary(monkeypatch)
    if mutation == "body":
        f.recipe["query"] = "must never enter recipe"
    elif mutation == "copy":
        f.recipe["copies"]["context"]["copyId"] = f.recipe["copies"]["completionInput"]["copyId"]
    elif mutation == "plan":
        f.recipe["plan_sha256"] = "bad"
    elif mutation == "role":
        next(b for b in f.selection["artifacts"] if b["artifact"]["artifactId"] == "model-policy")["role"] = "model"
    elif mutation == "endpoint":
        f.recipe["execution"]["provider"]["tokenizeEndpoint"] = f.recipe["execution"]["provider"]["completionEndpoint"]
    elif mutation == "selection":
        f.recipe["execution"]["selectionSha256"] = "f" * 64
    elif mutation == "actor":
        f.recipe["actor_id"] = "other"
    elif mutation == "deadline":
        f.recipe["execution"]["deadlineAt"] = "2027-01-15T08:00:59Z"
    elif mutation == "budget":
        f.recipe["execution"]["budgets"]["attemptTokens"] = True
    elif mutation == "descriptor":
        f.context.adapter_config = replace(f.config, model_descriptor={**f.config.model_descriptor, "endpointReferenceId": "tokenize"})
    repin_recipe(f)
    with pytest.raises(Exception):
        ApprovedChatConsumer(f.job(), f.recipe).consume()
    assert f.http.sent == []


@pytest.mark.parametrize("mutation", ["identity", "sha", "length", "canonical", "content-type", "response"])
def test_governed_read_checks_copy_id_digest_length_null_canonical_and_current_response(monkeypatch, mutation):
    f = build_boundary(monkeypatch)
    def mutate(method, fields, reply):
        if method == "readArtifact" and fields["artifactId"] == "context-copy":
            if mutation == "identity": reply["artifact"]["artifactId"] = "different-copy"
            if mutation == "sha": reply["contentSha256"] = "e" * 64
            if mutation == "length": reply["contentBase64"] = b64encode(b"{}").decode()
            if mutation == "canonical": reply["canonicalSha256"] = reply["contentSha256"]
            if mutation == "content-type": reply["contentType"] = "text/plain"
            if mutation == "response": raise ControlError("original-response-no-longer-current")
    f.control.mutate = mutate
    assert boundary_outcome(f)["status"] == "unavailable"
    assert f.http.sent == []


@pytest.mark.parametrize("mutation", ["denied", "stale", "expired", "hash", "grant", "privacy", "replay", "fence", "evidence"])
def test_real_rights_adapter_rejects_stale_denied_mismatched_or_replayed_proof(monkeypatch, mutation):
    f = build_boundary(monkeypatch)
    def mutate(method, fields, reply):
        if method != "currentModelUse": return
        if mutation == "denied": reply["decision"] = "denied"
        if mutation == "stale": reply["checkedAt"] = timestamp_ns(f.context.clock.now_ns() - 1)
        if mutation == "expired": reply["validUntil"] = timestamp_ns(f.context.clock.now_ns())
        if mutation == "hash": reply["requestSha256"] = "f" * 64
        if mutation == "grant": reply["grantRevision"] = None
        if mutation == "privacy": reply["privacyPolicyId"] = None
        if mutation == "replay": reply["externalDispatchAllowed"] = False
        if mutation == "fence": reply["leaseEpoch"] = "2"
        if mutation == "evidence": reply["currentEvidenceSha256"] = "e" * 64
    f.control.mutate = mutate
    assert boundary_outcome(f)["status"] == ("unknown" if mutation == "replay" else "unavailable")
    assert f.http.sent == []


@pytest.mark.parametrize("path", ["/tokenize", "/v1/chat/completions"])
def test_actual_http_uncertainty_is_unknown_never_retried_or_reported_absent(monkeypatch, path):
    f = build_boundary(monkeypatch)
    f.http.failure = path
    consumer = ApprovedChatConsumer(f.job(), f.recipe)
    with pytest.raises(ChatTransportUnknown, match="chat-model-outcome-unknown"):
        consumer.consume()
    sent = list(f.http.sent)
    assert len(sent) == (1 if path == "/tokenize" else 2)
    with pytest.raises(AdapterUnavailable, match="replay"):
        consumer.consume()
    assert f.http.sent == sent
    # A fresh worker object also cannot turn an existing durable dispatch into a send.
    result = boundary_outcome(f)
    assert result["status"] == "unknown" and result["outputArtifactIds"] == []
    assert f.http.sent == sent


def test_uncomposed_boundary_preserves_unknown_and_scrubs_transport_details(monkeypatch):
    f = build_boundary(monkeypatch)
    f.http.failure = "/tokenize"
    result = boundary_outcome(f)
    assert result["status"] == "unknown" and "SENSITIVE" not in repr(result)
    assert result["outputArtifactIds"] == [] and len(f.http.sent) == 1


@pytest.mark.parametrize("mutation", ["count", "tokens", "context", "input-limit", "output-limit", "cost"])
def test_independent_measured_budget_usage_and_fixed_output_checks(monkeypatch, mutation):
    f = build_boundary(monkeypatch)
    def change(path, reply):
        if path == "/tokenize":
            if mutation == "count": reply["count"] = True
            if mutation == "tokens": reply["tokens"] = [1]
            if mutation == "context": reply["max_model_len"] = 8192
            if mutation == "input-limit": reply.update(count=1001, tokens=list(range(1001)))
        elif mutation == "output-limit":
            reply["usage"].update(completion_tokens=129, total_tokens=329)
    f.http.response_mutator = change
    if mutation == "cost":
        f.recipe["execution"]["budgets"]["tokenizeCostUsd"] = "0"
        repin_recipe(f)
    result = boundary_outcome(f)
    assert result["status"] == "unavailable" and result["outputArtifactIds"] == []
    assert len(f.http.sent) == (0 if mutation == "cost" else 2 if mutation == "output-limit" else 1)


def test_post_return_revocation_is_unknown_and_prevents_completion(monkeypatch):
    f = build_boundary(monkeypatch)
    def mutate(method, fields, reply):
        if method == "currentModelUse" and len(f.control.proofs) == 2:
            reply["decision"] = "denied"
    f.control.mutate = mutate
    assert boundary_outcome(f)["status"] == "unknown"
    assert len(f.http.sent) == 1


def test_duplicate_running_admission_is_not_fresh_external_permission(monkeypatch):
    f = build_boundary(monkeypatch)
    first = boundary_outcome(f)
    assert first["status"] == "in-memory-only"
    sent = list(f.http.sent)
    second = boundary_outcome(f)
    assert second["status"] == "unknown" and f.http.sent == sent


def repin_document(f, artifact_id, document):
    data = f.authority.encode(document)
    f.artifacts[artifact_id] = data
    next(row for row in f.selection["artifacts"] if row["artifact"]["artifactId"] == artifact_id)["artifact"]["artifactSha256"] = sha256(data).hexdigest()
    f.selection["selectionSha256"] = f.authority.digest({k: v for k, v in f.selection.items() if k != "selectionSha256"})


def test_new_config_explicit_roles_and_legacy_decoder_unchanged(monkeypatch):
    f = build_boundary(monkeypatch)
    assert f.config.model == f.args["policy"] and f.config.model_descriptor["format"] == "vertex-model-binding-v1"
    legacy = {k: v for k, v in f.config_doc.items() if k != "model_policy_artifact_id"}
    legacy.update(profile="vertex-provider-adapter-config-v1", model_artifact_id="model-policy")
    f.selection["artifacts"] = [r for r in f.selection["artifacts"] if r["artifact"]["artifactId"] != "model-descriptor"]
    next(r for r in f.selection["artifacts"] if r["artifact"]["artifactId"] == "model-policy")["role"] = "model"
    repin_document(f, "adapter-config", legacy)
    result = load_configuration(f.selection, f.artifacts, f.authority)
    assert result.model == f.args["policy"] and result.model_descriptor is None
    assert result.profile == "vertex-provider-adapter-config-v1"
    legacy["model_policy_artifact_id"] = "model-policy"
    repin_document(f, "adapter-config", legacy)
    with pytest.raises(AdapterUnavailable):
        load_configuration(f.selection, f.artifacts, f.authority)


@pytest.mark.parametrize("change", ["missing-policy", "wrong-role", "extra-model", "descriptor-endpoint", "unknown-key"])
def test_chat_configuration_never_guesses_descriptor_or_policy_roles(monkeypatch, change):
    f = build_boundary(monkeypatch)
    if change == "missing-policy":
        del f.config_doc["model_policy_artifact_id"]
    elif change == "wrong-role":
        next(r for r in f.selection["artifacts"] if r["artifact"]["artifactId"] == "model-policy")["role"] = "model"
    elif change == "extra-model":
        f.selection["artifacts"].append({"bindingId": "other-model", "role": "model", "artifact": {
            "artifactId": "other-model", "artifactSha256": "a" * 64, "contractName": "PrivateConfig", "schemaVersion": "1.0.0"}})
    elif change == "descriptor-endpoint":
        descriptor = json.loads(f.artifacts["model-descriptor"])
        descriptor["endpointReferenceId"] = "tokenize"
        repin_document(f, "model-descriptor", descriptor)
    else:
        f.config_doc["query"] = "not configuration"
    repin_document(f, "adapter-config", f.config_doc)
    with pytest.raises(AdapterUnavailable):
        load_configuration(f.selection, f.artifacts, f.authority)


@pytest.mark.parametrize("purpose,mutation", [
    ("completionInput", "tools"), ("tokenizeInput", "tools"), ("completionInput", "output"),
    ("tokenizeInput", "role"), ("context", "response"), ("completionInput", "extra"),
    ("completionInput", "strict-type"),
])
def test_governed_bytes_still_require_strict_approved_provider_shape(monkeypatch, purpose, mutation):
    f = build_boundary(monkeypatch)
    pin = f.recipe["copies"][purpose]
    body = json.loads(f.control.copies[pin["copyId"]])
    if mutation == "tools": body["tools"] = None if purpose == "completionInput" else []
    if mutation == "output": body["max_completion_tokens"] = 129
    if mutation == "role": body["messages"][1]["role"] = "system"
    if mutation == "response": body["response_request_id"] = "other-response"
    if mutation == "extra": body["temperature"] = 0
    if mutation == "strict-type": body["response_format"]["json_schema"]["strict"] = 1
    encoded = f.authority.encode(body)
    f.control.copies[pin["copyId"]] = encoded
    pin.update(sha256=sha256(encoded).hexdigest(), byteLength=len(encoded))
    repin_recipe(f)
    assert boundary_outcome(f)["status"] == "unavailable"
    assert f.http.sent == []


def test_unknown_control_ack_survives_https_exception_sanitization(monkeypatch):
    f = build_boundary(monkeypatch)
    def mutate(method, fields, reply):
        if method == "currentModelUse":
            raise ControlError("private-response-lost", effect="unknown")
    f.control.mutate = mutate
    result = boundary_outcome(f)
    assert result["status"] == "unknown" and "private-response-lost" not in repr(result)
    assert f.http.sent == []


@pytest.mark.parametrize("field,value", [
    ("requestTokens", 1000), ("attemptTokens", 1100), ("requestCostUsd", "0.01"),
    ("attemptCostUsd", "0.1"), ("tokenizeCostUsd", "0"), ("completionCostUsd", "0.001"),
])
def test_all_six_original_budgets_are_independently_enforced(monkeypatch, field, value):
    f = build_boundary(monkeypatch)
    f.recipe["execution"]["budgets"][field] = value
    repin_recipe(f)
    assert boundary_outcome(f)["status"] == "unavailable"
    assert f.http.sent == []


def test_original_admission_fence_mismatch_and_unknown_deny_no_http(monkeypatch):
    f = build_boundary(monkeypatch)
    def mutate(method, fields, reply):
        if method == "admitRun":
            reply["lease"]["leaseEpoch"] = "2"
    f.control.mutate = mutate
    assert boundary_outcome(f)["status"] == "unknown"
    assert f.http.sent == []


def test_current_corpus_review_loss_before_disclosure_is_not_context_consent(monkeypatch):
    f = build_boundary(monkeypatch)
    def mutate(method, fields, reply):
        if method == "acceptedEvidence":
            reply["review"]["reviewId"] = "replacement-review"
    f.control.mutate = mutate
    assert boundary_outcome(f)["status"] == "unavailable"
    assert f.http.sent == [] and f.control.proofs == []


@pytest.mark.parametrize("body", [b'{"x":1.0}', b'{"x":-0.0}', b'{"x":NaN}', b'{"x":1,"x":2}', b'{"x":"\\ud800"}'])
def test_lossless_input_parser_rejects_float_duplicates_and_invalid_unicode(body):
    with pytest.raises(AdapterUnavailable):
        _input_json(body, maximum_bytes=500_000)


def test_actual_advisory_cannot_replace_original_citation_provenance(monkeypatch):
    f = build_boundary(monkeypatch)
    def mutate(path, response):
        if path == "/v1/chat/completions":
            content = json.loads(response["choices"][0]["message"]["content"])
            content["output"]["claims"][0]["citations"][0]["source_id"] = "human-not-corpus"
            response["choices"][0]["message"]["content"] = f.authority.encode(content).decode()
    f.http.response_mutator = mutate
    result = boundary_outcome(f)
    assert result["status"] == "unavailable" and result["outputArtifactIds"] == []
    assert len(f.http.sent) == 2
