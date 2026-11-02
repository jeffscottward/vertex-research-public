"""Fresh-process native evidence proof. Only external RPC/schema/socket ports.

No internal owner, serializer, SDK invoke, guard, or authority result is mocked.
A missing pinned SDK is a proof failure, never a silent alternate implementation.
"""
import base64
from hashlib import sha256
import json
import socket
import sys
import threading
from types import SimpleNamespace
from unittest.mock import patch

from adapters.chat_inputs import _timestamp_ns
from adapters.configuration import load_configuration
from adapters.handlers import _research
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


class Provider:
    def __init__(self, authority, scenario):
        self.authority = authority
        self.scenario = scenario
        self.sends = []
        self.completions = 0
        self.tokenizers = 0

    def connection(self, *args):
        owner = self

        class Connection:
            sock = None

            def connect(self):
                pass

            def request(self, method, path, *, body, headers):
                assert method == "POST" and path in ("/tokenize", "/v1/chat/completions")
                self.path, self.body = path, json.loads(body)
                owner.sends.append({"path": path, "sha256": sha256(body).hexdigest()})
                # Never retain SDK/host authorization headers, even synthetic.

            def getresponse(self):
                if self.path == "/tokenize":
                    owner.tokenizers += 1
                    assert owner.tokenizers <= 2
                    value = {"count": 37, "tokens": list(range(37)), "max_model_len": 4096}
                else:
                    owner.completions += 1
                    assert owner.completions <= 2
                    if owner.scenario == "unknown-outcome" and owner.completions == 1:
                        raise TimeoutError("synthetic provider outcome unknown")
                    value = {"id": "synthetic-native-" + str(owner.completions), "object": "chat.completion", "created": 0,
                             "model": self.body["model"], "usage": {"prompt_tokens": 37, "completion_tokens": 7, "total_tokens": 44}}
                    if owner.completions == 1:
                        data = json.loads(self.body["messages"][1]["content"])["data"]
                        evidence_id = data["evidence_manifest"][0]["evidence_id"]
                        arguments = {"evidence_id": evidence_id}
                        if owner.scenario == "invalid-call":
                            arguments["unapproved"] = True
                        call = {"id": "synthetic-reviewed-call", "type": "function", "function": {
                            "name": "read_reviewed_evidence", "arguments": owner.authority.encode(arguments).decode()}}
                        calls = [call, {**call, "id": "synthetic-second-call"}] if owner.scenario == "multiple-calls" else [call]
                        value["choices"] = [{"index": 0, "finish_reason": "tool_calls", "message": {"role": "assistant", "content": None, "tool_calls": calls}}]
                    else:
                        assert self.body["tool_choice"] == "none" and "tools" not in self.body
                        delivered = json.loads(self.body["messages"][-1]["content"])
                        citation = {key: delivered[key] for key in ("evidence_id", "source_id", "source_snapshot_id", "content_hash", "excerpt_digest")}
                        citation["quote"] = delivered["excerpt"][:32]
                        if owner.scenario == "undelivered-citation":
                            citation["evidence_id"] = "never-delivered-evidence"
                        advisory = {"output": {"claims": [{"text": "Synthetic bounded finding.", "kind": "fact", "citations": [citation]}],
                                                "proposals": [], "execution_authorized": False}, "tool_requests": []}
                        value["choices"] = [{"index": 0, "finish_reason": "stop", "message": {"role": "assistant", "content": owner.authority.encode(advisory).decode()}}]
                        if owner.scenario == "further-call":
                            value["choices"][0]["finish_reason"] = "tool_calls"
                            value["choices"][0]["message"]["tool_calls"] = [{"id": "forbidden-third-phase", "type": "function", "function": {
                                "name": "read_reviewed_evidence", "arguments": owner.authority.encode({"evidence_id": delivered["evidence_id"]}).decode()}}]
                body = owner.authority.encode(value)

                class Response:
                    status, offset = 200, 0

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


def main():
    setup = json.loads(sys.stdin.readline())
    authority = Authority()
    config = load_configuration(setup["selection"], {key: base64.b64decode(value) for key, value in setup["artifacts"].items()}, authority)
    provider = Provider(authority, setup.get("scenario", "positive"))
    clock = SimpleNamespace(now_ns=lambda: authority.epoch_ns(setup["at"]), monotonic=lambda: 100.0)
    context = SimpleNamespace(contracts=authority, adapter_config=config, selection=setup["selection"], clock=clock,
        cancellation=threading.Event(), control=Control(authority), control_bridge=SimpleNamespace(run=lambda action, **kwargs: action()),
        admission=SimpleNamespace(acquire=lambda *args: True), supervisor=None,
        secret_resolver=SimpleNamespace(resolve=lambda *args, **kwargs: "synthetic-test-only-not-secret"))

    def forbidden(*args, **kwargs):
        raise AssertionError("No network in native source composition")

    with patch("adapters.http._PinnedHTTPSConnection", provider.connection), patch.object(socket, "create_connection", forbidden), patch.object(socket.socket, "connect", forbidden), patch.object(socket.socket, "connect_ex", forbidden):
        outcome = _research(context, setup["recipe"], setup["lease"])
    print(json.dumps({"kind": "done", "outcome": outcome, "sends": provider.sends, "completions": provider.completions, "tokenizers": provider.tokenizers}), flush=True)


if __name__ == "__main__":
    main()
