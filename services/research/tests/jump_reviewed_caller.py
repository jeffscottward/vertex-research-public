"""One synthetic jump-model source proof; real loader/handler/job/control adapters.

The parent Civet case supplies immutable storage and reviewer service fixtures,
and validates against actual source schemas. No network/DB/live rights/model IO.
"""
import asyncio
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
from vertex_control.client import ClientConfig, ControlClient, ControlError


def exchange(kind, **fields):
    print(json.dumps({"kind": kind, **fields}, ensure_ascii=False, separators=(",", ":")), flush=True)
    response = json.loads(sys.stdin.readline())
    if response.get("ok") is not True:
        raise ControlError("jump-fixture-service-denied")
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


class ExternalControl(ControlClient):
    def __init__(self, authority):
        super().__init__(ClientConfig(origin="https://test.invalid", credential_ref="test-only"),
                         lambda _: "synthetic-source-only", authority)

    def _exchange(self, method, body, token, pending, deadline):
        # External transport seam only: real call validates both wire schemas.
        pending.sent = True
        value = exchange("worker", method=method, value=json.loads(body)["json"])
        return json.dumps({"json": value}, separators=(",", ":")).encode()


def main():
    setup = json.loads(sys.stdin.readline())
    authority = Authority()
    config = load_configuration(setup["selection"],
        {key: base64.b64decode(value) for key, value in setup["configArtifacts"].items()}, authority)
    assert config.model is None and config.model_use is None and not config.endpoint_policies
    context = SimpleNamespace(contracts=authority, adapter_config=config, selection=setup["selection"],
        clock=SimpleNamespace(now_ns=lambda: authority.epoch_ns(setup["at"]), monotonic=lambda: 100.0),
        cancellation=threading.Event(), control=ExternalControl(authority),
        control_bridge=SimpleNamespace(run=lambda action, **kwargs: asyncio.run(action())),
        admission=SimpleNamespace(), supervisor=None)

    def forbidden(*args, **kwargs):
        raise AssertionError("No network in jump-model source proof")

    with patch.object(socket, "create_connection", forbidden), patch.object(socket.socket, "connect", forbidden), \
            patch.object(socket.socket, "connect_ex", forbidden):
        outcome = _research(context, setup["payload"], setup["lease"])
    print(json.dumps({"kind": "done", "outcome": outcome}), flush=True)


if __name__ == "__main__":
    main()
