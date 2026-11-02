"""Synthetic wiring spies only. NOT authoritative v1 schema or canonical conformance tests."""
from __future__ import annotations

import hashlib
import json
from dataclasses import replace

from providers.ports import RightsDecision

NOW = "2026-09-22T15:00:00.123456789Z"
EXPIRES = "2026-09-23T15:00:00Z"


class FixedClock:
    def __init__(self, value=NOW):
        self.value = value

    def now(self):
        return self.value


class CodecSpy:
    def encode(self, value):
        def reject_float(node):
            if isinstance(node, float):
                raise ValueError("fixture refuses float")
            if isinstance(node, dict):
                for child in node.values():
                    reject_float(child)
            elif isinstance(node, list):
                for child in node:
                    reject_float(child)
        reject_float(value)
        return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")

    def digest(self, value):
        if isinstance(value, bytes):
            raise AssertionError("raw bytes must never use canonical digest")
        return hashlib.sha256(self.encode(value)).hexdigest()


class ValidatorSpy:
    def __init__(self, result=True):
        self.result = result
        self.calls = []

    def validate(self, contract_name, payload, schema_version="1.0.0"):
        self.calls.append((contract_name, payload, schema_version))
        return self.result


class RightsSpy:
    def __init__(self):
        self.denied = set()
        self.revision = "policy-v1"
        self.calls = []

    def decide(self, request):
        self.calls.append(request)
        return RightsDecision(request.scope_id, request.policy_id, request.operation,
                              "denied" if request.scope_id in self.denied or any(source in self.denied for source in request.source_ids) else "granted",
                              request.evaluated_at, EXPIRES, self.revision, request.source_ids, "retain-test")


class TransportSpy:
    def __init__(self, response):
        self.response, self.calls = response, []

    def request(self, request):
        self.calls.append(request)
        return self.response
