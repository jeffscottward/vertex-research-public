"""Compose public ModelUseRequest; only fresh authenticated proof grants use.

Selected private bindings are identifiers, NOT permission. The control service
joins current grant/revocation, exact endpoint/model, lease/budget, original
artifacts/latest reviews, storage rights and privacy before returning a proof.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from hashlib import sha256
from typing import Any, Mapping

from .ports import AdapterUnavailable


@dataclass(frozen=True)
class ModelUsePolicy:
    consumer_service_id: str
    model_use_policy_version: str
    purpose: str
    tokenizer_artifact_id: str
    tokenize_grant_id: str
    tokenize_grant_version: str
    completion_grant_id: str
    completion_grant_version: str


def timestamp_ns(value: int) -> str:
    if type(value) is not int or value < 0:
        raise AdapterUnavailable("model-deadline-invalid")
    seconds, nanos = divmod(value, 1_000_000_000)
    return datetime.fromtimestamp(seconds, timezone.utc).strftime("%Y-%m-%dT%H:%M:%S") + f".{nanos:09d}Z"


class ModelUseRequests:
    def __init__(self, *, config: Any, selection: Mapping[str, Any], lease: Mapping[str, Any], contracts: Any):
        if config.model is None or config.model_use is None:
            raise AdapterUnavailable("model-use-policy-unavailable")
        self.config, self.selection, self.lease, self.contracts = config, selection, lease, contracts
        self.model, self.policy = config.model, config.model_use
        self.endpoints = {endpoint.endpoint_id: endpoint for endpoint in config.endpoint_policies}
        self.hashes = {binding["bindingId"]: binding["artifact"]["artifactSha256"] for binding in selection["artifacts"]}

    def eligibility(self, *, operation: str, input_bytes: bytes, evidence_refs: tuple[dict[str, Any], ...],
                    deadline_ns: int) -> Mapping[str, Any]:
        if operation != "model-tokenize":
            raise AdapterUnavailable("model-eligibility-operation-invalid")
        return self.request(operation=operation, input_bytes=input_bytes, evidence_refs=evidence_refs,
                            deadline_ns=deadline_ns, input_tokens=None, maximum_output_tokens=0,
                            maximum_cost_usd="0", tools=())

    def request(self, *, operation: str, input_bytes: bytes, evidence_refs: tuple[dict[str, Any], ...],
                deadline_ns: int, input_tokens: int | None, maximum_output_tokens: int,
                maximum_cost_usd: str, tools: tuple[str, ...]) -> dict[str, Any]:
        if operation not in ("model-tokenize", "model-completion") or not isinstance(input_bytes, bytes):
            raise AdapterUnavailable("model-use-input-invalid")
        tokenize = operation == "model-tokenize"
        endpoint_id = self.model.tokenize_endpoint_id if tokenize else self.model.completion_endpoint_id
        endpoint = self.endpoints[endpoint_id]
        body = {
            "schemaVersion": "1.0.0", "accountAlias": self.lease["accountAlias"], "environment": self.lease["environment"],
            "researchPrincipalId": self.lease["researchPrincipalId"], "consumerServiceId": self.policy.consumer_service_id,
            "selectionId": self.selection["selectionId"], "selectionSha256": self.selection["selectionSha256"],
            "providerId": endpoint.provider, "modelVersion": self.model.model_version,
            "tokenizerArtifactId": self.policy.tokenizer_artifact_id, "tokenizerSha256": self.model.tokenizer_sha256,
            "endpointReferenceId": endpoint_id, "endpointSha256": self.hashes[endpoint_id],
            "modelUsePolicyVersion": self.policy.model_use_policy_version,
            "jobId": self.lease["jobId"], "leaseId": self.lease["leaseId"], "leaseEpoch": self.lease["leaseEpoch"],
            "grantId": self.policy.tokenize_grant_id if tokenize else self.policy.completion_grant_id,
            "grantVersion": self.policy.tokenize_grant_version if tokenize else self.policy.completion_grant_version,
            "operation": operation, "purpose": self.policy.purpose, "tools": list(tools),
            "evidence": [dict(item) for item in evidence_refs],
            "inputSha256": sha256(input_bytes).hexdigest(), "inputBytes": len(input_bytes), "inputTokens": input_tokens,
            "maximumOutputTokens": maximum_output_tokens, "maximumCostUsd": maximum_cost_usd,
            "deadlineAt": timestamp_ns(deadline_ns),
        }
        body["requestId"] = "model-use-" + self.contracts.digest(body)
        request = {**body, "requestSha256": self.contracts.digest(body)}
        if self.contracts.validate("ModelUseRequest", request, "1.0.0") is not True:
            raise AdapterUnavailable("model-use-request-invalid")
        return request
