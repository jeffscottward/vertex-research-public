"""Source regressions for research-port translations; never live I/O."""
import asyncio
import base64
from dataclasses import replace
from hashlib import sha256
import json
from types import SimpleNamespace
import unittest

from vertex_control import ArtifactAdapter, CollectionAdapter, ControlError, ResearchContext, RightsAdapter, RunAdmissionAdapter, RunBinding
from vertex_control.adapters import _revision


FENCE = {"accountAlias": "acct", "environment": "research", "jobId": "job", "leaseId": "lease", "leaseEpoch": "1"}


class Authority:
    """Unit double ONLY; real contract authority is mandatory in composition."""
    def encode(self, value):
        return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()

    def digest(self, value):
        return sha256(self.encode(value)).hexdigest()

    def validate(self, name, value, schema_version="1.0.0"):
        return True

    def epoch_ns(self, value):
        return int(value)


class ScriptedClient:
    def __init__(self):
        self.authority = Authority()
        self.calls = []
        self.responses = {}

    async def call(self, method, payload):
        self.calls.append((method, payload))
        result = self.responses[method]
        if isinstance(result, Exception):
            raise result
        return json.loads(json.dumps(result))


class TestOnlyBridge:
    # Unit driver, not exported and not used by production. Production requires
    # the already-running host event loop and refuses nesting.
    def run(self, factory, *, timeout_seconds):
        return asyncio.run(factory())


class DomainTests(unittest.TestCase):
    def setUp(self):
        self.client = ScriptedClient()
        self.authorization = object()
        self.context = ResearchContext(fence=FENCE, actor_id="actor", authorization=self.authorization,
            clock=SimpleNamespace(now=lambda: "20"), deadline_ns=100_000_000_000,
            rights_policy_id="policy", rights_version="v1", collection_id="collection", snapshot_id="snapshot",
            run_binding=RunBinding(run_id="run", trace_id="trace", request_digest="a" * 64,
                                   token_budget=100, cost_budget_usd="1.00"))
        self.cancellation = SimpleNamespace(cancelled=lambda: False)
        self.bridge = TestOnlyBridge()
        self.rights = RightsAdapter(self.client, self.bridge, self.context)
        self.artifacts = ArtifactAdapter(self.client, self.bridge, self.context, self.rights)
        self.rights_value = {"policyId": "policy", "version": "v1", "status": "granted",
            "allowedUses": ["store", "read", "derive", "export"], "checkedAt": "20", "expiresAt": "100",
            "retentionUntil": "100"}
        self.client.responses["currentRights"] = self.rights_value

    def review_response(self):
        evidence = {"evidenceId": "evidence", "collectionId": "collection", "snapshotId": "snapshot",
                    "rightsPolicyId": "policy", "contentHash": "b" * 64}
        body = self.client.authority.encode(evidence)
        digest = sha256(body).hexdigest()
        return {"artifact": {"artifactId": "evidence", "artifactSha256": digest},
            "contentBase64": base64.b64encode(body).decode(), "evidence": evidence,
            "review": {"reviewId": "review", "reviewVersion": "1.0.0", "collectionId": "collection",
                "artifactId": "evidence", "artifactSha256": digest, "accountAlias": "acct",
                "environment": "research", "purpose": "research", "decision": "accepted",
                "reviewedAt": "1", "expiresAt": "100"}, "rights": self.rights_value}

    def resolve(self, response):
        self.client.responses["acceptedEvidence"] = response
        return self.rights.resolve_current(actor_id="actor", account_alias="acct", environment="research",
            collection_id="collection", snapshot_id="snapshot", evidence_id="evidence",
            artifact_digest=response["artifact"]["artifactSha256"],
            original_bytes=base64.b64decode(response["contentBase64"]), purpose="research", reference_ns=20,
            authorization=self.authorization)

    def test_latest_rejected_review_never_falls_back_to_cached_acceptance(self):
        response = self.review_response()
        self.assertIsNotNone(self.resolve(response))
        response["review"]["decision"] = "rejected"
        self.assertIsNone(self.resolve(response))
        self.assertNotIn("evidence", self.rights._pins)
        self.assertEqual([method for method, _ in self.client.calls], ["acceptedEvidence", "acceptedEvidence"])

    def test_exact_artifact_original_bytes_required(self):
        response = self.review_response()
        response["contentBase64"] = base64.b64encode(b"{}").decode()
        self.assertIsNone(self.resolve(response))

    def test_expired_rights_reject_even_accepted_review(self):
        response = self.review_response()
        response["rights"]["expiresAt"] = "20"
        self.assertIsNone(self.resolve(response))

    def test_retention_identifier_requires_explicit_version_bound_mapping(self):
        from providers.ports import RightRequest
        request = RightRequest("collection", "policy", "collection-import", "20")
        self.assertIsNone(self.rights.decide(request).retention_policy)
        selected = replace(self.context, retention_policy_bindings={("policy", "v1"): "retention-selected"})
        adapter = RightsAdapter(self.client, self.bridge, selected)
        self.assertEqual(adapter.decide(request).retention_policy, "retention-selected")
        self.client.responses["currentRights"]["version"] = "v2"
        self.assertIsNone(adapter.decide(request).retention_policy)

    def test_new_admission_only_and_no_budget_fields_in_public_wire(self):
        admission = RunAdmissionAdapter(self.client, self.bridge, self.context)
        args = dict(actor_id="actor", run_id="run", trace_id="trace", request_digest="a" * 64,
                    token_budget=100, cost_budget_usd="1.00", deadline_ns=self.context.deadline_ns,
                    cancellation=self.cancellation)
        self.client.responses["admitRun"] = {"status": "duplicate", "jobId": "job"}
        self.assertFalse(admission.claim(**args))
        self.assertEqual(self.client.calls[-1], ("admitRun", {**FENCE, "runId": "run", "requestSha256": "a" * 64}))
        self.client.responses["admitRun"]["status"] = "accepted"
        self.assertTrue(admission.claim(**args))
        calls = len(self.client.calls)
        self.assertFalse(admission.claim(**{**args, "token_budget": 101}))
        self.assertEqual(len(self.client.calls), calls)

    def agent_pair(self, *, collection="collection"):
        authority = self.client.authority
        public = {"runId": "run", "tokenBudget": 100, "costBudgetUsd": "1.00", "status": "completed",
                  "taskContract": "task", "modelVersion": "model", "inputEvidenceIds": ["evidence"]}
        advisory = {"profile": "vertex-internal-agent-advisory-v1", "taskContract": "task", "modelVersion": "model",
                    "result": {"run_id": "run", "trace_id": "trace", "status": "completed", "evidence": [
                        {"evidence_id": "evidence", "collection_id": collection,
                         "accepted_review_id": "review", "accepted_review_revision": _revision("1.0.0"),
                         "artifact_digest": "b" * 64}]}}
        public_bytes, advisory_bytes = authority.encode(public), authority.encode(advisory)
        public_hash, advisory_hash = sha256(public_bytes).hexdigest(), sha256(advisory_bytes).hexdigest()
        staged = []
        def stage(**fields):
            staged.append(fields)
            return {"artifactId": fields["artifact_id"], "artifactSha256": sha256(fields["content"]).hexdigest()}
        self.artifacts.stage = stage
        self.rights._pins["evidence"] = {"collectionId": collection, "evidenceId": "evidence",
            "artifactId": "evidence", "artifactSha256": "b" * 64, "reviewId": "review", "reviewVersion": "1.0.0",
            "rightsPolicyId": "policy", "rightsVersion": "v1"}
        self.client.responses["publishAgent"] = self.agent_receipt()
        return (("AgentRun", "run", public_bytes, public_hash),
                ("vertex-internal-agent-advisory-v1", "agent-advisory-" + advisory_hash, advisory_bytes, advisory_hash)), staged

    def agent_receipt(self, **changes):
        return {"status": "accepted", "jobId": "job", "state": "running", "lease": dict(FENCE),
                "outputArtifactIds": ["run"], "reason": None, **changes}

    def publish_agent_pair(self, artifacts):
        return self.artifacts.publish(run_id="run", trace_id="trace", artifacts=artifacts,
            deadline_ns=self.context.deadline_ns, cancellation=self.cancellation)

    def test_agent_public_and_private_commit_is_one_method(self):
        artifacts, staged = self.agent_pair()
        self.assertEqual(self.publish_agent_pair(artifacts), ("run",))
        self.assertEqual(len(staged), 2)
        self.assertEqual([method for method, _ in self.client.calls], ["publishAgent"])
        wire = self.client.calls[0][1]
        self.assertEqual(wire["run"], json.loads(artifacts[0][2]))
        self.assertEqual(wire["advisoryProfileArtifact"]["artifactSha256"], artifacts[1][3])
        self.assertEqual(wire["collectionId"], "collection")

    def test_duplicate_agent_receipt_preserves_only_owned_public_output(self):
        artifacts, _ = self.agent_pair()
        self.client.responses["publishAgent"]["status"] = "duplicate"
        self.assertEqual(self.publish_agent_pair(artifacts), ("run",))
        self.assertEqual([method for method, _ in self.client.calls], ["publishAgent"])

    def test_unproven_agent_acknowledgement_never_becomes_completion_outputs(self):
        for changes in ({"status": "unknown"}, {"status": "completed"}, {"jobId": "other"},
                        {"state": "unknown"}, {"lease": None}, {"lease": {**FENCE, "leaseEpoch": "2"}},
                        {"outputArtifactIds": []}, {"outputArtifactIds": ["other"]},
                        {"outputArtifactIds": ["run", "private-advisory"]}):
            with self.subTest(changes=changes):
                artifacts, _ = self.agent_pair()
                self.client.responses["publishAgent"] = self.agent_receipt(**changes)
                with self.assertRaises(ControlError) as raised:
                    self.publish_agent_pair(artifacts)
                self.assertEqual(raised.exception.effect, "unknown")

    def test_agent_receipt_requires_authoritative_validation(self):
        artifacts, _ = self.agent_pair()
        self.client.authority.validate = lambda name, *args: name != "WorkerResult"
        with self.assertRaises(ControlError) as raised:
            self.publish_agent_pair(artifacts)
        self.assertEqual(raised.exception.effect, "unknown")

    def test_missing_or_contradictory_collection_denied_before_staging(self):
        for collection in (None, "", "other"):
            with self.subTest(collection=collection):
                artifacts, staged = self.agent_pair()
                self.artifacts.context = replace(self.context, collection_id=collection)
                with self.assertRaises(ControlError):
                    self.publish_agent_pair(artifacts)
                self.assertFalse(staged)
        self.assertFalse(self.client.calls)

    def test_mixed_private_evidence_and_review_collection_denied_before_staging(self):
        for used, pin in (("other", "other"), ("other", "collection"), ("collection", "other")):
            with self.subTest(used=used, pin=pin):
                artifacts, staged = self.agent_pair(collection=used)
                self.rights._pins["evidence"]["collectionId"] = pin
                with self.assertRaises(ControlError):
                    self.publish_agent_pair(artifacts)
                self.assertFalse(staged)
                self.assertFalse(self.client.calls)

    def test_read_artifact_binds_content_and_returned_reference(self):
        content = b"source bytes"
        digest = sha256(content).hexdigest()
        self.client.responses["readArtifact"] = {"artifact": {"artifactId": "blob", "artifactSha256": digest},
            "contentSha256": digest, "contentBase64": base64.b64encode(content).decode(), "canonicalSha256": None}
        self.assertEqual(self.artifacts.read(artifact_id="blob", expected_digest=digest), content)
        self.client.responses["readArtifact"]["artifact"]["artifactId"] = "wrong"
        with self.assertRaisesRegex(ControlError, "artifact-reference-mismatch"):
            self.artifacts.read(artifact_id="blob", expected_digest=digest)

    def test_semver_revision_is_lossless_and_never_unsafe_json_integer(self):
        self.assertNotEqual(_revision("1.11.1"), _revision("11.1.1"))
        with self.assertRaises(ControlError):
            _revision("12345678901234567890.0.0")

    def test_read_collection_uses_only_committed_reconstruction_ref(self):
        collection = CollectionAdapter(self.client, self.bridge, self.context, self.artifacts, self.rights)
        self.client.responses["readCollection"] = {"status": "available", "collectionId": "collection",
            "snapshotId": "snapshot", "previousSnapshotId": None, "importArtifacts": [],
            "manifestSha256": "c" * 64, "reconstructionArtifact": {"artifactId": "server-linked-index", "artifactSha256": "d" * 64}}
        read_calls = []
        def bounded_read(**fields):
            read_calls.append(fields)
            raise ControlError("intentional-unit-stop")
        self.artifacts.read = bounded_read
        with self.assertRaisesRegex(ControlError, "intentional-unit-stop"):
            collection.read_snapshot("collection", "snapshot", 10000)
        self.assertEqual(read_calls, [{"artifact_id": "server-linked-index",
            "expected_digest": "d" * 64, "collection_id": "collection"}])

    def test_activation_carries_exact_manifest_rights_and_cas(self):
        collection = CollectionAdapter(self.client, self.bridge, self.context, self.artifacts, self.rights)
        plan = SimpleNamespace(manifest=SimpleNamespace(digest="c" * 64),
            rights_revisions=(("collection", "policy", "v1"),))
        collection.read_snapshot = lambda *args: plan
        collection._rights = lambda _: None
        self.client.responses["activateCollection"] = {"status": "activated", "collectionId": "collection",
            "snapshotId": "snapshot", "previousSnapshotId": "previous", "manifestSha256": "c" * 64}
        receipt = collection.activate_snapshot("collection", "snapshot", "previous", "c" * 64, plan.rights_revisions)
        self.assertEqual(receipt.snapshot_id, "snapshot")
        method, wire = self.client.calls[-1]
        self.assertEqual(method, "activateCollection")
        self.assertEqual(wire["expectedActiveSnapshotId"], "previous")
        self.assertEqual(wire["manifestSha256"], "c" * 64)
        self.assertEqual(wire["rightsPins"], [{"sourceId": "collection", "policyId": "policy", "version": "v1"}])

    def model_request(self, body=b"prepared-input"):
        value = {**FENCE, "schemaVersion": "1.0.0", "requestId": "request",
            "researchPrincipalId": "actor", "consumerServiceId": "research-worker",
            "selectionId": "selection", "selectionSha256": "1" * 64, "providerId": "model-provider",
            "modelVersion": "model", "tokenizerArtifactId": "tokenizer", "tokenizerSha256": "2" * 64,
            "endpointReferenceId": "endpoint", "endpointSha256": "3" * 64, "modelUsePolicyVersion": "1.0.0",
            "grantId": "grant", "grantVersion": "1.0.0", "operation": "model-tokenize",
            "purpose": "research", "tools": [], "evidence": [], "inputSha256": sha256(body).hexdigest(),
            "inputBytes": len(body), "inputTokens": None, "maximumOutputTokens": 0,
            "maximumCostUsd": "0", "deadlineAt": "100"}
        value["requestSha256"] = self.client.authority.digest(value)
        return value

    def model_proof(self, request):
        keys = ("schemaVersion", "requestId", "requestSha256", "accountAlias", "environment", "researchPrincipalId",
                "consumerServiceId", "selectionId", "selectionSha256", "providerId", "modelVersion",
                "tokenizerArtifactId", "tokenizerSha256", "endpointReferenceId", "endpointSha256",
                "modelUsePolicyVersion", "jobId", "leaseId", "leaseEpoch", "grantId", "grantVersion", "operation")
        return {**{key: request[key] for key in keys}, "decision": "allowed", "grantRevision": "1",
            "checkedAt": "20", "validUntil": "100", "privacyPolicyId": "privacy", "privacyPolicyVersion": "1.0.0",
            "currentEvidenceSha256": self.client.authority.digest([]),
            "modelProcessingOnly": True, "executionAuthorized": False, "reasonCodes": ["allowed"]}

    def test_model_proof_binds_prepared_bytes_not_storage_permission(self):
        request = self.model_request()
        self.client.responses["currentModelUse"] = self.model_proof(request)
        proof = self.rights.authorize_model_use(request=request, input_bytes=b"prepared-input", deadline_ns=100)
        self.assertEqual(proof["decision"], "allowed")
        self.assertEqual([method for method, _ in self.client.calls], ["currentModelUse"])
        with self.assertRaisesRegex(ControlError, "model-use-request-rejected"):
            self.rights.authorize_model_use(request=request, input_bytes=b"changed-input", deadline_ns=100)

    def test_model_proof_wrong_endpoint_or_current_evidence_is_denied(self):
        request = self.model_request()
        for key, wrong in (("endpointSha256", "f" * 64), ("currentEvidenceSha256", "e" * 64),
                           ("decision", "denied"), ("validUntil", "20")):
            with self.subTest(key=key):
                self.client.responses["currentModelUse"] = {**self.model_proof(request), key: wrong}
                with self.assertRaisesRegex(ControlError, "model-use-proof-denied"):
                    self.rights.authorize_model_use(request=request, input_bytes=b"prepared-input", deadline_ns=100)

    def test_storage_rights_without_independent_factory_never_allow_model(self):
        response = self.review_response()
        self.assertIsNotNone(self.resolve(response))
        grant = self.rights.authorize(actor_id="actor", evidence=response["evidence"],
                                     reference_ns=20, authorization=self.authorization)
        self.assertFalse(grant.allow_model)
