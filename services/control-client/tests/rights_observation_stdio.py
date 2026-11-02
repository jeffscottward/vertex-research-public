"""Finite SOURCE-validator composition, not installed ContractAuthority acceptance.

Only clock and ControlClient's external byte transport are doubled. The source
schema/semantic cores, canonical codec, loader, _Job, factory, chat binding guards,
ControlClient.call and RightsAdapter run unchanged. No model turn or provider I/O.
"""
import asyncio
import base64
import copy
import json
import socket
import sys
import threading
from types import SimpleNamespace
from unittest.mock import patch

from vertex_contracts.codec import ContractError, canonical_encode, epoch_ns, parse_canonical, rawSHA256
from vertex_contracts.schema import SchemaValidator
from vertex_contracts.semantics import SemanticPrograms
from vertex_control.client import ClientConfig, ControlClient, ControlError
from adapters.chat_consumer import ApprovedChatConsumer
from adapters.configuration import load_configuration
from adapters.handlers import _Job
from adapters.ports import AdapterUnavailable


def exchange(kind, **fields):
    print(json.dumps({"kind": kind, **fields}, separators=(",", ":")), flush=True)
    reply = json.loads(sys.stdin.readline())
    if reply.get("ok") is not True:
        raise ControlError("test-stdio-denied")
    return reply["value"]


class SourceValidatorComposition:
    """Direct actual native cores on ephemeral exact source schemas and rules.

    Deliberately NOT a ContractAuthority subclass, bundle, or alternate loader.
    The production pin/source-set/installed-artifact gate remains unqualified.
    """
    def __init__(self, setup):
        self.schemas = {key: SchemaValidator(value) for key, value in setup["schemas"].items()}
        self.programs = SemanticPrograms(setup["semantics"]["programs"])
        self.rules = setup["semantics"]["contractRules"]
        self.absent = set()

    def validate(self, name, value, version="1.0.0"):
        if version != "1.0.0" or name in self.absent or name not in self.schemas:
            raise ContractError("source-schema-unavailable")
        stage = "canonical-snapshot"
        try:
            original = parse_canonical(self.encode(value))
            stage = "native-structure"
            self.schemas[name].validate(original)
            stage = "native-semantics"
            self.programs.validate(self.rules[name], original)
        except Exception as error:
            # Test-only bounded codes, never payloads, messages, URLs or bytes.
            codes = {
                "Pinned WHATWG URL backend is unavailable": "whatwg-backend-unavailable",
                "Unsupported WHATWG backend version": "whatwg-backend-version",
                "Structural contract validation rejected input": "structural-rejected",
                "Semantic contract validation rejected input": "semantic-rejected",
            }
            code = codes.get(str(error), "unclassified-validation-failure")
            print(json.dumps({"diagnostic": "source-native-validation", "stage": stage,
                              "schema": name if name in self.schemas else "unknown",
                              "code": code}, separators=(",", ":")), file=sys.stderr, flush=True)
            raise
        return True

    @staticmethod
    def encode(value):
        return canonical_encode(value)

    def digest(self, value):
        return rawSHA256(self.encode(value))

    @staticmethod
    def epoch_ns(value):
        return epoch_ns(value)


class Clock:
    def now_ns(self):
        return epoch_ns(exchange("clock"))

    def monotonic(self):
        return self.now_ns() / 1_000_000_000


class StdioControl(ControlClient):
    def __init__(self, authority):
        super().__init__(ClientConfig(origin="https://test.invalid", credential_ref="test-only"),
                         lambda _: "synthetic-source-only", authority)
        self.fault = None
        self.calls = []
        self.fault_calls = 0

    def _exchange(self, method, body, token, pending, deadline):
        # External transport seam only; real .call still validates both sides.
        pending.sent = True
        self.calls.append(method)
        reply = exchange("worker", method=method, input=json.loads(body)["json"])
        if reply["status"] != 200 or self.fault == "missing-method":
            raise ControlError("http-response-rejected", effect="none")
        envelope = json.loads(reply["body"])
        value = envelope["json"]
        self.fault_calls += 1
        if self.fault and method.endswith("Observation"):
            rights = value["value"] if method == "currentRightsObservation" else value["value"]["rights"]
            if self.fault == "stale":
                value["observedAt"] = rights["checkedAt"]
            elif self.fault == "future":
                value["observedAt"] = "2099-01-01T00:00:00Z"
            elif self.fault == "missing":
                del value["observedAt"]
            elif self.fault == "wrong-format":
                value["format"] = "vertex-worker-observation-v0"
            elif self.fault == "historical-after-observation":
                rights["checkedAt"] = reply["receiptAt"]
            elif self.fault == "expired":
                rights["expiresAt"] = reply["receiptAt"]
            elif self.fault == "retention-expired":
                rights["retentionUntil"] = reply["receiptAt"]
            elif self.fault == "expired-review":
                value["value"]["review"]["expiresAt"] = reply["receiptAt"]
            elif self.fault == "wrong-policy":
                rights["policyId"] = "wrong-policy"
            elif self.fault == "wrong-hash":
                value["value"]["contentBase64"] = base64.b64encode(b"{}").decode()
            elif self.fault == "changed-second-pin" and self.fault_calls == 2:
                value["value"]["review"]["reviewVersion"] = "2.0.0"
            elif self.fault == "per-use-version-change" and self.fault_calls == 2:
                rights["version"] = "2.0.0"
        return json.dumps(envelope, separators=(",", ":")).encode()


def denied(action):
    try:
        action()
    except (ControlError, AdapterUnavailable, ContractError):
        return
    raise AssertionError("Expected closed refusal")


def main():
    setup = json.loads(sys.stdin.readline())
    authority, clock = SourceValidatorComposition(setup), Clock()
    client = StdioControl(authority)
    artifacts = {key: base64.b64decode(value, validate=True) for key, value in setup["artifacts"].items()}
    config = load_configuration(setup["selection"], artifacts, authority)
    context = SimpleNamespace(contracts=authority, adapter_config=config, selection=setup["selection"], clock=clock,
        cancellation=threading.Event(), control=client,
        control_bridge=SimpleNamespace(run=lambda action, **kwargs: asyncio.run(action())),
        admission=SimpleNamespace(acquire=lambda *args: True), supervisor=None)
    pin = setup["pin"]
    job = _Job(context, setup["lease"], collection_id=pin["collectionId"])
    # Constructor validates exact v2 selection/recipe and all existing FirstMate
    # rendezvous guards. Never call run()/tokenize()/completion()/privacy owner.
    consumer = ApprovedChatConsumer(job, setup["recipe"])
    assert consumer.rendezvous is config.privacy_review_rendezvous
    rights = job.control.rights
    assert rights.mode == "local-observation-v1"
    checks = []

    def current(expected=pin["rightsVersion"], uses=("read", "derive")):
        return rights.current(pin["rightsPolicyId"], uses, collection_id=pin["collectionId"], expected_version=expected)

    historical = current()
    assert epoch_ns(historical["checkedAt"]) < clock.now_ns()
    checks.append("older-history-fresh-current")
    original = asyncio.run(client.call("acceptedEvidenceObservation", {**dict(rights.context.fence),
        "collectionId": pin["collectionId"], "evidenceId": pin["evidenceId"]}))["value"]
    body = base64.b64decode(original["contentBase64"], validate=True)

    def join(port=rights):
        return port._join(actor_id=job.lease["researchPrincipalId"], collection_id=pin["collectionId"],
            snapshot_id=original["evidence"]["snapshotId"], evidence_id=pin["evidenceId"],
            artifact_digest=pin["artifactSha256"], original_bytes=body, purpose="research",
            reference_ns=clock.now_ns(), authorization=port.context.authorization)

    evidence, review, decision = join()
    assert decision == original["rights"] and evidence == original["evidence"] and review == original["review"]
    checks.append("older-history-fresh-evidence")
    before = len(client.calls)
    rights._refresh_model_pin(pin)
    assert client.calls[before:] == ["acceptedEvidenceObservation", "acceptedEvidenceObservation"]
    checks.append("second-model-pin-read")

    def refusal(label, fault, action, method, count=1):
        client.fault, client.fault_calls = fault, 0
        before = len(client.calls)
        try:
            denied(action)
            assert client.calls[before:] == [method] * count, (label, client.calls[before:])
            checks.append(label)
        finally:
            client.fault = None

    for fault in ("stale", "future", "missing", "wrong-format", "historical-after-observation", "expired", "retention-expired", "wrong-policy"):
        refusal(fault + "-current", fault, lambda: current(uses=("read",)), "currentRightsObservation")
    refusal("wrong-version-current", None, lambda: current(expected="99.0.0", uses=("read",)), "currentRightsObservation")
    refusal("per-use-version-change", "per-use-version-change", lambda: current(expected=None), "currentRightsObservation", 2)
    authority.absent.add("WorkerCurrentRightsObservationOutput")
    try:
        refusal("missing-schema-current", None, lambda: current(uses=("read",)), "currentRightsObservation")
    finally:
        authority.absent.clear()
    refusal("missing-method-current", "missing-method", lambda: current(uses=("read",)), "currentRightsObservation")
    for fault in ("stale", "future", "missing", "wrong-format", "historical-after-observation", "expired", "retention-expired"):
        refusal(fault + "-evidence", fault, join, "acceptedEvidenceObservation")
    refusal("expired-review", "expired-review", join, "acceptedEvidenceObservation")
    refusal("wrong-hash-evidence", "wrong-hash", join, "acceptedEvidenceObservation")
    refusal("changed-second-pin", "changed-second-pin", lambda: rights._refresh_model_pin(pin), "acceptedEvidenceObservation", 2)

    denied(lambda: authority.validate("WorkerCurrentRightsOutput", {**historical, "observedAt": exchange("clock")}))
    checks.append("strict-legacy-current")
    denied(lambda: authority.validate("WorkerAcceptedEvidenceOutput", {**original, "observedAt": exchange("clock")}))
    checks.append("strict-legacy-evidence")

    # Closed legacy formats still go through the same canonical/hash-pinned
    # loader and actual _Job. These are local test selection copies, not live
    # persisted config migration or operational policy issuance.
    legacy_modes, legacy_jobs = [], []
    binding = next(row for row in setup["selection"]["artifacts"] if row["role"] == "provider-config")
    artifact_id = binding["artifact"]["artifactId"]
    for profile in ("vertex-provider-adapter-config-v1", "vertex-research-chat-adapter-config-v1", "vertex-first-mate-review-rendezvous-adapter-config-v1"):
        selected, bodies = copy.deepcopy(setup["selection"]), dict(artifacts)
        document = json.loads(bodies[artifact_id])
        document["profile"] = profile
        if profile != "vertex-first-mate-review-rendezvous-adapter-config-v1":
            document.pop("privacy_review_rendezvous")
        if profile == "vertex-provider-adapter-config-v1":
            document.pop("model_policy_artifact_id")
            document.update(model_artifact_id=None, model_use_artifact_id=None, endpoint_artifact_ids=[])
        bodies[artifact_id] = authority.encode(document)
        next(row for row in selected["artifacts"] if row["role"] == "provider-config")["artifact"]["artifactSha256"] = rawSHA256(bodies[artifact_id])
        selected["selectionSha256"] = authority.digest({key: value for key, value in selected.items() if key != "selectionSha256"})
        legacy_config = load_configuration(selected, bodies, authority)
        legacy_context = SimpleNamespace(**{**vars(context), "adapter_config": legacy_config, "selection": selected})
        lease = {**setup["lease"], "policySelectionSha256": selected["selectionSha256"]}
        legacy_job = _Job(legacy_context, lease, collection_id=pin["collectionId"])
        legacy_modes.append(legacy_job.control.rights.mode)
        legacy_jobs.append(legacy_job)
    legacy = legacy_jobs[-1].control.rights
    before = len(client.calls)
    denied(lambda: legacy.current(pin["rightsPolicyId"], ("read",), collection_id=pin["collectionId"]))
    assert client.calls[before:] == ["currentRights"]
    checks.append("legacy-current-selection")
    before = len(client.calls)
    denied(lambda: join(legacy))
    assert client.calls[before:] == ["acceptedEvidence"]
    checks.append("legacy-evidence-selection")
    bad_bodies = {**artifacts, artifact_id: artifacts[artifact_id] + b" "}
    denied(lambda: load_configuration(setup["selection"], bad_bodies, authority))
    checks.append("config-hash-rejection")
    denied(lambda: _Job(context, {**setup["lease"], "policySelectionSha256": "0" * 64}))
    checks.append("job-selection-rejection")
    unknown = copy.deepcopy(setup["selection"])
    document = json.loads(artifacts[artifact_id])
    document["profile"] = "vertex-first-mate-review-rendezvous-adapter-config-v3"
    bad_bodies = {**artifacts, artifact_id: authority.encode(document)}
    next(row for row in unknown["artifacts"] if row["role"] == "provider-config")["artifact"]["artifactSha256"] = rawSHA256(bad_bodies[artifact_id])
    unknown["selectionSha256"] = authority.digest({key: value for key, value in unknown.items() if key != "selectionSha256"})
    denied(lambda: load_configuration(unknown, bad_bodies, authority))
    checks.append("closed-profile-rejection")
    asyncio.run(client.aclose())
    print(json.dumps({"kind": "done", "boundary": "source-native-core-not-installed-ContractAuthority",
        "mode": rights.mode, "legacyModes": legacy_modes, "checks": checks}), flush=True)


def forbidden(*args, **kwargs):
    raise AssertionError("No external network or provider dispatch in observation proof")


if __name__ == "__main__":
    with patch.object(socket, "create_connection", forbidden), patch.object(socket.socket, "connect", forbidden), patch.object(socket.socket, "connect_ex", forbidden):
        main()
