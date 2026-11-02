"""Test-only synchronous stdio external ports. No listener, network or service.

The Civet fixture owns real SQL/auth/privacy/model-use/publication operations;
this process runs the existing configuration, _Job, consumer and output owners.
"""
import base64
from hashlib import sha256
import json
import socket
import sys
import threading
from types import SimpleNamespace
from unittest.mock import patch

from adapters.chat_consumer import _input_json, run_research_chat
from adapters.chat_inputs import _timestamp_ns
from adapters.configuration import load_configuration
from adapters.handlers import _Job
from adapters.tests.test_chat_consumer import HttpDouble
from agents.types import Evidence
from vertex_control.client import ControlError, SameORPCJSON


def exchange(kind, **fields):
    print(json.dumps({"kind": kind, **fields}, ensure_ascii=False, separators=(",", ":")), flush=True)
    response = json.loads(sys.stdin.readline())
    if not response.get("ok"):
        raise ControlError("synthetic-source-transport-denied", effect=response.get("effect", "none"))
    return response["value"]


class Authority:
    def encode(self, value):
        return json.dumps(value, ensure_ascii=False, allow_nan=False, sort_keys=True, separators=(",", ":")).encode()

    def digest(self, value):
        return sha256(self.encode(value)).hexdigest()

    def epoch_ns(self, value):
        return _timestamp_ns(value)

    def validate(self, name, value, version="1.0.0"):
        return exchange("validate", name=name, value=value, version=version)


class Control:
    def __init__(self, authority):
        self.authority = authority
        self.config = SimpleNamespace(max_request_bytes=2_097_152, envelope=SameORPCJSON())

    def call(self, method, fields):
        return exchange("worker", method=method, value=fields)


def main():
    setup = json.loads(sys.stdin.readline())
    authority = Authority()
    config = load_configuration(setup["selection"], {key: base64.b64decode(value) for key, value in setup["artifacts"].items()}, authority)
    copies = {key: base64.b64decode(value) for key, value in setup["copies"].items()}
    completion = _input_json(copies["completionInput"], maximum_bytes=1_048_576)
    data = _input_json(completion["messages"][1]["content"].encode(), maximum_bytes=500_000)["data"]
    evidence = Evidence(**data["evidence"][0])
    http = HttpDouble(SimpleNamespace(tokenize_input=copies["tokenizeInput"], completion_input=copies["completionInput"]), evidence, authority)
    http.advisory["output"]["claims"][0]["citations"][0]["quote"] = evidence.excerpt[:32]
    http.responses["/tokenize"] = {"count": 37, "tokens": list(range(37)), "max_model_len": config.model.maximum_context_tokens}
    http.responses["/v1/chat/completions"] = {"model": config.model.served_model,
        "usage": {"prompt_tokens": 37, "completion_tokens": 7, "total_tokens": 44},
        "choices": [{"finish_reason": "stop", "message": {"role": "assistant", "content": authority.encode(http.advisory).decode()}}]}
    clock = SimpleNamespace(now_ns=lambda: authority.epoch_ns(setup["at"]), monotonic=lambda: 100.0)
    context = SimpleNamespace(contracts=authority, adapter_config=config, selection=setup["selection"], clock=clock,
        cancellation=threading.Event(), control=Control(authority), control_bridge=SimpleNamespace(run=lambda action, **kwargs: action()),
        admission=SimpleNamespace(acquire=lambda *args: True), supervisor=None,
        secret_resolver=SimpleNamespace(resolve=lambda *args, **kwargs: "synthetic-test-only-not-secret"))
    def forbidden(*args, **kwargs):
        raise AssertionError("No external network in source rendezvous composition")
    with patch("adapters.http._PinnedHTTPSConnection", http.connection), patch.object(socket, "create_connection", forbidden), patch.object(socket.socket, "connect", forbidden), patch.object(socket.socket, "connect_ex", forbidden):
        outcome = run_research_chat(_Job(context, setup["lease"]), setup["recipe"])
    print(json.dumps({"kind": "done", "outcome": outcome, "sends": [{"path": path, "sha256": sha256(body).hexdigest()} for _, path, body in http.sent]}), flush=True)


if __name__ == "__main__":
    main()
