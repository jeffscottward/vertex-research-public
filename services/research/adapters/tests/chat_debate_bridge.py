"""Synthetic source-test bridge, NOT a production route or authority.

One bounded stdin JSON request -> one stdout JSON receipt. API fixtures supply
actual recipe, selected artifacts, immutable approved buffers and original
synthetic source/review/queued-run bytes. Real Python configuration, handler,
consumer, proof adapters, HTTPS framing and governed stage/publication execute;
only external control/HTTP boundaries use the existing explicit doubles. The
API test must independently verify/rejoin returned actual bytes and provenance.
No SDK, filesystem persistence, real credentials, network or authority issuance.
"""
from base64 import b64decode, b64encode
from copy import deepcopy
from hashlib import sha256
import json
import signal
import socket
import sys
import threading
from types import SimpleNamespace

import pytest

from adapters.chat_consumer import _input_json
from adapters.chat_inputs import PreparedChatInputs
from adapters.configuration import load_configuration
from adapters.tests.test_chat_consumer import AuthorityDouble, ControlDouble, HttpDouble
from adapters.tests.test_chat_output import dispatch
from agents.types import Evidence


MAX_BRIDGE_BYTES = 8_388_608
_KEYS = {"action", "recipe", "lease", "selection", "artifacts", "copies", "queuedRunBase64",
         "originalEvidenceBase64", "acceptedReview", "nowNs"}


def _bytes(value):
    if type(value) is not str or len(value) > 1_398_104:
        raise ValueError("bridge-input-invalid")
    content = b64decode(value, validate=True)
    if not 1 <= len(content) <= 1_048_576 or b64encode(content).decode() != value:
        raise ValueError("bridge-input-invalid")
    return content


def consume_fixture(value):
    """Consume exact externally prepared bytes; never repair pins or identities."""
    if type(value) is not dict or set(value) != _KEYS or value["action"] != "consume":
        raise ValueError("bridge-input-invalid")
    if (type(value["nowNs"]) is not str or not value["nowNs"].isascii()
            or not value["nowNs"].isdigit() or not 1 <= len(value["nowNs"]) <= 30):
        raise ValueError("bridge-input-invalid")
    if (type(value["artifacts"]) is not dict or not 1 <= len(value["artifacts"]) <= 32
            or type(value["copies"]) is not dict or set(value["copies"]) != {"context", "tokenizeInput", "completionInput"}):
        raise ValueError("bridge-input-invalid")
    authority = AuthorityDouble()
    recipe, lease, selection = value["recipe"], value["lease"], value["selection"]
    if authority.digest(recipe) != lease["payloadSha256"]:
        raise ValueError("bridge-input-invalid")
    artifacts = {key: _bytes(encoded) for key, encoded in value["artifacts"].items()}
    copies = {key: _bytes(encoded) for key, encoded in value["copies"].items()}
    for purpose, content in copies.items():
        pin = recipe["copies"][purpose]
        if sha256(content).hexdigest() != pin["sha256"] or len(content) != pin["byteLength"]:
            raise ValueError("bridge-input-invalid")
    execution = recipe["execution"]
    if len(execution["reviewPins"]) != 1:
        raise ValueError("bridge-single-synthetic-source-required")
    config = load_configuration(selection, artifacts, authority)
    now = int(value["nowNs"])
    clock = SimpleNamespace(now_ns=lambda: now, monotonic=lambda: 100.0)
    control = ControlDouble(authority, clock)
    control.recipe, control.lease = recipe, lease
    control.original, control.review = _bytes(value["originalEvidenceBase64"]), deepcopy(value["acceptedReview"])
    review_pin = execution["reviewPins"][0]
    if sha256(control.original).hexdigest() != review_pin["artifactSha256"]:
        raise ValueError("bridge-input-invalid")
    control.collection_id = execution["collectionId"]
    control.evidence_id, control.evidence_artifact_id = review_pin["evidenceId"], review_pin["artifactId"]
    control.rights_policy_id, control.rights_version = review_pin["rightsPolicyId"], review_pin["rightsVersion"]
    queued_pin = execution["queuedRun"]
    # Separate immutable synthetic owner projections: source read/model rights
    # are not the queued original's output storage/publication rights.
    control.publication_rights_policy_id = queued_pin["rightsPolicyId"]
    control.publication_rights_version = queued_pin["rightsVersion"]
    queued = _bytes(value["queuedRunBase64"])
    if sha256(queued).hexdigest() != queued_pin["artifactSha256"]:
        raise ValueError("bridge-input-invalid")
    control.records[queued_pin["artifactId"]] = queued
    control.copies = {recipe["copies"][purpose]["copyId"]: content for purpose, content in copies.items()}
    prepared = PreparedChatInputs({}, copies["context"], copies["tokenizeInput"], copies["completionInput"])
    body = _input_json(copies["completionInput"], maximum_bytes=1_048_576)
    envelope = _input_json(body["messages"][1]["content"].encode(), maximum_bytes=500_000)
    if len(envelope["data"]["evidence"]) != 1:
        raise ValueError("bridge-single-synthetic-source-required")
    evidence = Evidence(**envelope["data"]["evidence"][0])
    http = HttpDouble(prepared, evidence, authority)
    # Synthetic model result cites only the API-approved original excerpt. It
    # does not quote a predecessor or manufacture a corpus/rights identity.
    http.advisory["output"]["claims"][0]["citations"][0]["quote"] = evidence.excerpt[:1000]
    http.responses["/tokenize"].update(count=37, tokens=list(range(37)), max_model_len=config.model.maximum_context_tokens)
    completion = http.responses["/v1/chat/completions"]
    completion["model"] = config.model.served_model
    completion["choices"][0]["message"]["content"] = authority.encode(http.advisory).decode()
    control.http = http
    context = SimpleNamespace(contracts=authority, adapter_config=config, selection=selection, clock=clock,
        cancellation=threading.Event(), control=control, control_bridge=SimpleNamespace(run=lambda action, **kwargs: action()),
        admission=SimpleNamespace(acquire=lambda *args: True), supervisor=None,
        secret_resolver=SimpleNamespace(resolve=lambda *args, **kwargs: "synthetic-fixture-credential"))
    completion["usage"] = {"prompt_tokens": 37, "completion_tokens": 7, "total_tokens": 44}

    def deny_network(*args, **kwargs):
        raise AssertionError("bridge-network-forbidden")

    with pytest.MonkeyPatch.context() as monkeypatch:
        monkeypatch.setattr(socket, "create_connection", deny_network)
        monkeypatch.setattr(socket.socket, "connect", deny_network)
        monkeypatch.setattr(socket.socket, "connect_ex", deny_network)
        monkeypatch.setattr("adapters.http._PinnedHTTPSConnection", http.connection)
        outcome = dispatch(SimpleNamespace(context=context, recipe=recipe, lease=lease))
    advisory_id = recipe["copies"]["advisory"]["copyId"]
    stages = [fields for method, fields in control.calls if method == "stageArtifact"]
    advisory_stage = next((stage for stage in stages if stage["artifactId"] == advisory_id), None)
    exchange = None if advisory_stage is None else advisory_stage["chatCompletion"]
    retained, public = control.governed.get(advisory_id), control.ordinary.get(recipe["run_id"])
    return {"outcome": outcome,
            "retainedBase64": None if retained is None else b64encode(retained).decode(),
            "publicBase64": None if public is None else b64encode(public).decode(),
            "completionRequest": None if exchange is None else exchange["request"],
            "responseBase64": None if exchange is None else exchange["responseBase64"],
            "proof": None if exchange is None else exchange["proof"],
            "stageRequests": stages, "publicationRequests": control.publications,
            "controlMethods": [method for method, _ in control.calls],
            "sentBodies": [{"method": method, "path": path, "bodyBase64": b64encode(content).decode()}
                           for method, path, content in http.sent]}


def main():
    def timeout(*args):
        raise TimeoutError("bridge-time-budget")
    signal.signal(signal.SIGALRM, timeout)
    signal.alarm(25)
    try:
        raw = sys.stdin.buffer.read(MAX_BRIDGE_BYTES + 1)
        if not 1 <= len(raw) <= MAX_BRIDGE_BYTES:
            raise ValueError("bridge-input-invalid")
        # The outer envelope has only small JSON integers. Lossless Evidence
        # integer nanoseconds remain inside exact approved Base64 input buffers.
        from vertex_control.client import parse_json
        result = consume_fixture(parse_json(raw))
        encoded = json.dumps(result, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode()
        if len(encoded) > MAX_BRIDGE_BYTES:
            raise ValueError("bridge-output-budget")
        sys.stdout.buffer.write(encoded + b"\n")
        return 0
    except Exception:
        sys.stdout.write('{"error":"synthetic-native-bridge-rejected"}\n')
        return 1
    finally:
        signal.alarm(0)


if __name__ == "__main__":
    raise SystemExit(main())
