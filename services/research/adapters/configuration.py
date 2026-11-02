"""Read only explicitly selected canonical private config artifacts.

No filesystem, environment, credential discovery, default endpoints, or 'latest'
lookup. Public selection validation is delegated to native ContractAuthority.
"""
from __future__ import annotations

from dataclasses import dataclass, fields
from hashlib import sha256
from types import MappingProxyType
from typing import Any, Mapping

from providers.boundary import parse_json
from providers.ports import ProviderConfig
from vertex_market_data.calendar import BarBinding, ExplicitSessionCalendar, Session
from vertex_market_data.normalization import BarWindow
from .admission import AdmissionLimit
from .http import HttpsTransport
from .model_policy import ModelPolicy
from .model_use import ModelUsePolicy
from .ports import AdapterUnavailable, EndpointPolicy


RENDEZVOUS_PROFILE = "vertex-first-mate-review-rendezvous-adapter-config-v1"
OBSERVATION_RENDEZVOUS_PROFILE = "vertex-first-mate-review-rendezvous-adapter-config-v2"
RENDEZVOUS_PROFILES = (RENDEZVOUS_PROFILE, OBSERVATION_RENDEZVOUS_PROFILE)
NATIVE_EVIDENCE_PROFILE = "vertex-first-mate-native-evidence-adapter-config-v1"
NATIVE_EVIDENCE_PROTOCOL = "first-mate-read-reviewed-evidence-v1"
NATIVE_EVIDENCE_SERIALIZER = "agno-1.7.12-openai-1.93.0-native-single-invoke-v1"


def native_evidence_tool_schema() -> dict[str, Any]:
    return {"type": "function", "function": {
        "name": "read_reviewed_evidence",
        "description": "Read one reviewed evidence projection from the approved immutable bundle.",
        "strict": True, "parameters": {"type": "object", "properties": {"evidence_id": {"type": "string"}},
                                     "required": ["evidence_id"], "additionalProperties": False}}}


@dataclass(frozen=True)
class NativeEvidenceConfiguration:
    protocol: str
    native_serving: Mapping[str, Any]
    serializer_profile: str
    allowed_tools: tuple[str, ...]


@dataclass(frozen=True)
class PrivacyReviewRendezvous:
    maximum_wait_ms: int
    maximum_status_reads: int
    poll_interval_ms: int

    def __post_init__(self):
        if (type(self.maximum_wait_ms) is not int or not 1000 <= self.maximum_wait_ms <= 300000
                or type(self.maximum_status_reads) is not int or not 1 <= self.maximum_status_reads <= 300
                or type(self.poll_interval_ms) is not int or not 100 <= self.poll_interval_ms <= 10000
                or self.poll_interval_ms > self.maximum_wait_ms):
            raise AdapterUnavailable("privacy-review-limits-invalid")


@dataclass(frozen=True)
class AdapterConfiguration:
    selection_id: str
    selection_sha256: str
    endpoint_policies: tuple[EndpointPolicy, ...]
    providers: Mapping[str, ProviderConfig]
    model: ModelPolicy | None
    model_use: ModelUsePolicy | None
    admission_limits: tuple[AdmissionLimit, ...]
    calendars: Mapping[str, ExplicitSessionCalendar]
    profile: str = "vertex-provider-adapter-config-v1"
    model_descriptor: Mapping[str, Any] | None = None
    model_artifact_id: str | None = None
    model_policy_artifact_id: str | None = None
    privacy_review_rendezvous: PrivacyReviewRendezvous | None = None
    native_evidence: NativeEvidenceConfiguration | None = None


def _record(value: Any, keys: set[str]) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != keys:
        raise AdapterUnavailable("config-shape-invalid")
    return dict(value)


def _construct(kind: Any, value: Any) -> Any:
    return kind(**_record(value, {f.name for f in fields(kind)}))


def load_configuration(selection: Mapping[str, Any], artifacts: Mapping[str, bytes], contracts: Any) -> AdapterConfiguration:
    if contracts.validate("RuntimePolicySelection", selection, "1.0.0") is not True:
        raise AdapterUnavailable("selection-invalid")
    body = {key: value for key, value in selection.items() if key != "selectionSha256"}
    if contracts.digest(body) != selection["selectionSha256"]:
        raise AdapterUnavailable("selection-digest-mismatch")
    bindings = {item["artifact"]["artifactId"]: item for item in selection["artifacts"]}
    if len(bindings) != len(selection["artifacts"]):
        raise AdapterUnavailable("config-binding-ambiguous")

    def selected(artifact_id: str, role: str) -> dict[str, Any]:
        binding = bindings.get(artifact_id)
        data = artifacts.get(artifact_id)
        if binding is None or binding["role"] != role or not isinstance(data, bytes) or not 1 <= len(data) <= 1_048_576:
            raise AdapterUnavailable("selected-config-unavailable")
        if sha256(data).hexdigest() != binding["artifact"]["artifactSha256"]:
            raise AdapterUnavailable("selected-config-digest-mismatch")
        parsed = parse_json(data, maximum_bytes=1_048_576, maximum_nodes=30_000)
        if not isinstance(parsed, dict) or contracts.encode(parsed) != data:
            raise AdapterUnavailable("selected-config-noncanonical")
        return parsed

    candidates = [key for key, value in bindings.items() if value["role"] == "provider-config"]
    if len(candidates) != 1:
        raise AdapterUnavailable("adapter-config-selection-unavailable")
    document = selected(candidates[0], "provider-config")
    profile = document.get("profile")
    native = profile == NATIVE_EVIDENCE_PROFILE
    rendezvous = profile in RENDEZVOUS_PROFILES or native
    chat = profile in ("vertex-research-chat-adapter-config-v1", *RENDEZVOUS_PROFILES) or native
    if profile not in ("vertex-provider-adapter-config-v1", "vertex-research-chat-adapter-config-v1", *RENDEZVOUS_PROFILES, NATIVE_EVIDENCE_PROFILE):
        raise AdapterUnavailable("adapter-config-version-unavailable")
    config = _record(document, {
        "profile", "provider_configs", "admission_limits", "endpoint_artifact_ids",
        "model_artifact_id", "model_use_artifact_id", "calendar_artifact_ids",
    } | ({"model_policy_artifact_id"} if chat else set()) | ({"privacy_review_rendezvous"} if rendezvous else set())
      | ({"native_evidence"} if native else set()))
    privacy_review = _construct(PrivacyReviewRendezvous, config["privacy_review_rendezvous"]) if rendezvous else None
    native_config = None
    if native:
        descriptor = _record(config["native_evidence"], {"protocol", "nativeServing", "serializerProfile", "allowedTools"})
        pin = _record(descriptor["nativeServing"], {"artifactId", "artifactSha256", "contractName", "schemaVersion"})
        if (descriptor["protocol"] != NATIVE_EVIDENCE_PROTOCOL
                or descriptor["serializerProfile"] != NATIVE_EVIDENCE_SERIALIZER
                or descriptor["allowedTools"] != ["read_reviewed_evidence"]
                or type(pin["artifactId"]) is not str or pin["artifactId"] not in bindings
                or bindings[pin["artifactId"]]["artifact"] != pin
                or bindings[pin["artifactId"]]["role"] != "tool-config"):
            raise AdapterUnavailable("native-evidence-capability-invalid")
        native_config = NativeEvidenceConfiguration(descriptor["protocol"], MappingProxyType(pin),
                                                     descriptor["serializerProfile"], tuple(descriptor["allowedTools"]))
    if chat and (any(type(config[key]) is not str or not config[key] for key in
                    ("model_artifact_id", "model_policy_artifact_id", "model_use_artifact_id"))
                 or len([row for row in bindings.values() if row["role"] == "model"]) != 1):
        raise AdapterUnavailable("chat-model-role-split-required")
    if any(not isinstance(config[key], list) or len(config[key]) > 128 for key in
           ("provider_configs", "admission_limits", "endpoint_artifact_ids", "calendar_artifact_ids")):
        raise AdapterUnavailable("config-list-budget")
    providers = tuple(_construct(ProviderConfig, row) for row in config["provider_configs"])
    if len({p.provider for p in providers}) != len(providers) or any(type(p.enabled) is not bool for p in providers):
        raise AdapterUnavailable("provider-config-invalid")
    limits = tuple(_construct(AdmissionLimit, row) for row in config["admission_limits"])
    endpoints = []
    reference_ids = {ref["referenceId"] for ref in selection["references"] if ref["kind"] == "secret-reference"}
    for artifact_id in config["endpoint_artifact_ids"]:
        value = _record(selected(artifact_id, "endpoint"), {f.name for f in fields(EndpointPolicy)})
        for field in ("allowed_query_keys", "allowed_ip_addresses"):
            if not isinstance(value[field], list) or any(not isinstance(v, str) for v in value[field]):
                raise AdapterUnavailable("endpoint-list-invalid")
            value[field] = tuple(value[field])
        endpoint = EndpointPolicy(**value)
        HttpsTransport._validate_policy(endpoint)
        if endpoint.credential_reference_id not in reference_ids:
            raise AdapterUnavailable("credential-reference-not-selected")
        binding = bindings[artifact_id]
        endpoint_reference = next((ref for ref in selection["references"]
                                   if ref["referenceId"] == endpoint.endpoint_id
                                   and ref["kind"] == "nonsecret-reference"), None)
        facts = [fact for fact in selection["providerCapabilities"]
                 if fact["endpointReferenceId"] == endpoint.endpoint_id
                 and fact["providerId"] == endpoint.provider and fact["operation"] == endpoint.operation]
        if (binding["bindingId"] != endpoint.endpoint_id or endpoint_reference is None
                or endpoint_reference["referenceSha256"] != binding["artifact"]["artifactSha256"]
                or len(facts) != 1 or facts[0]["endpointSha256"] != binding["artifact"]["artifactSha256"]):
            raise AdapterUnavailable("endpoint-capability-pin-mismatch")
        endpoints.append(endpoint)
    if len({p.endpoint_id for p in endpoints}) != len(endpoints) or len({(p.provider, p.operation) for p in endpoints}) != len(endpoints):
        raise AdapterUnavailable("endpoint-identity-ambiguous")
    model = None
    descriptor = None
    if config["model_artifact_id"] is not None:
        if chat:
            descriptor = _record(selected(config["model_artifact_id"], "model"), {
                "format", "accountAlias", "environment", "providerId", "modelVersion",
                "tokenizerArtifactId", "tokenizerSha256", "endpointReferenceId", "endpointSha256",
                "modelUsePolicyVersion", "expiresAt", "pricing",
            })
            price = _record(descriptor["pricing"], {
                "currency", "basis", "tokenizationBaseUsd", "tokenizationInputByteUsd",
                "completionBaseUsd", "completionInputByteUsd", "outputTokenUsd", "expiresAt",
            })
            from agents.budget import usd_units
            if (descriptor["format"] != "vertex-model-binding-v1"
                    or descriptor["accountAlias"] != selection["accountAlias"]
                    or descriptor["environment"] != "research"
                    or selection["environment"] != "research"
                    or price["currency"] != "USD"
                    or price["basis"] != "conservative-input-byte-output-token-ceiling"):
                raise AdapterUnavailable("chat-model-descriptor-invalid")
            for key in ("tokenizationBaseUsd", "tokenizationInputByteUsd", "completionBaseUsd",
                        "completionInputByteUsd", "outputTokenUsd"):
                usd_units(price[key])
            for value in (descriptor["expiresAt"], price["expiresAt"]):
                contracts.epoch_ns(value)
            model = _construct(ModelPolicy, selected(config["model_policy_artifact_id"], "tool-config"))
        else:
            # Legacy role=model remains a ModelPolicy, not a descriptor.
            model = _construct(ModelPolicy, selected(config["model_artifact_id"], "model"))
        model.require()
        endpoint_ids = {p.endpoint_id for p in endpoints}
        selected_hashes = {item["artifact"]["artifactSha256"] for item in bindings.values()}
        if (model.tokenize_endpoint_id not in endpoint_ids or model.completion_endpoint_id not in endpoint_ids
                or model.tokenizer_sha256 not in selected_hashes
                or model.serving_manifest_sha256 not in selected_hashes
                or model.pricing_source_artifact_id not in bindings):
            raise AdapterUnavailable("model-provenance-not-selected")
        manifests = [key for key, item in bindings.items() if item["artifact"]["artifactSha256"] == model.serving_manifest_sha256]
        if len(manifests) != 1:
            raise AdapterUnavailable("serving-manifest-ambiguous")
        manifest = _record(selected(manifests[0], "tool-config"), {
            "profile", "model_version", "served_model", "model_revision", "tokenizer_sha256",
            "chat_template_sha256", "backend", "runtime_image_sha256", "replica_policy",
            "template_policy", "input_profile", "adapter_policy", "tokenize_authentication",
            "pricing_profile",
        } | ({"protocol", "serializerProfile", "allowedTools", "toolSchema"} if native else set()))
        import re
        required = {
            "profile": "vertex-exact-vllm-serving-v1", "model_version": model.model_version,
            "served_model": model.served_model, "model_revision": model.model_revision,
            "tokenizer_sha256": model.tokenizer_sha256, "chat_template_sha256": model.chat_template_sha256,
            "backend": "vllm-0.9.2", "replica_policy": "immutable-identical-no-hot-swap",
            "template_policy": "reviewed-pure-no-clock-random-or-external-state",
            "input_profile": "text-only-decoder-only-no-documents",
            "adapter_policy": "no-lora-no-prompt-adapters-no-tools-no-truncation",
            "tokenize_authentication": "authenticated-reverse-proxy-both-paths",
            "pricing_profile": "all-prompt-and-completion-token-ids-single-rate-no-cache-discount",
        }
        if native:
            if native_config is None or dict(native_config.native_serving) != bindings[manifests[0]]["artifact"]:
                raise AdapterUnavailable("native-evidence-serving-pin-mismatch")
            required.update({
                "profile": "vertex-exact-vllm-native-evidence-serving-v1",
                "adapter_policy": "no-lora-no-prompt-adapters-native-single-tool-no-truncation",
                "protocol": NATIVE_EVIDENCE_PROTOCOL, "serializerProfile": NATIVE_EVIDENCE_SERIALIZER,
                "allowedTools": list(native_config.allowed_tools), "toolSchema": native_evidence_tool_schema(),
            })
        if (any(manifest[key] != value for key, value in required.items())
                or re.fullmatch(r"[0-9a-f]{64}", manifest["runtime_image_sha256"]) is None):
            raise AdapterUnavailable("exact-meter-deployment-unqualified")
        price = _record(selected(model.pricing_source_artifact_id, "tool-config"), {
            "profile", "model_version", "input_usd_per_million", "output_usd_per_million", "rounding",
        })
        if price != {"profile": "vertex-model-price-v1", "model_version": model.model_version,
                     "input_usd_per_million": model.input_usd_per_million,
                     "output_usd_per_million": model.output_usd_per_million,
                     "rounding": "ceil-aggregate-to-1e-18-usd"}:
            raise AdapterUnavailable("model-price-policy-mismatch")
    model_use = None
    if config["model_use_artifact_id"] is not None:
        model_use = _construct(ModelUsePolicy, selected(config["model_use_artifact_id"], "tool-config"))
        tokenizer = bindings.get(model_use.tokenizer_artifact_id)
        if (model is None or tokenizer is None or tokenizer["role"] != "tokenizer"
                or tokenizer["artifact"]["artifactSha256"] != model.tokenizer_sha256
                or model_use.purpose != "research"
                or any(not isinstance(value, str) or not value for value in (
                    model_use.consumer_service_id, model_use.model_use_policy_version,
                    model_use.tokenize_grant_id, model_use.tokenize_grant_version,
                    model_use.completion_grant_id, model_use.completion_grant_version))):
            raise AdapterUnavailable("model-use-binding-invalid")
    if chat:
        completion = next((endpoint for endpoint in endpoints
                           if model is not None and endpoint.endpoint_id == model.completion_endpoint_id), None)
        if (model is None or model_use is None or descriptor is None or completion is None
                or completion.operation != "model-completion"
                or descriptor["providerId"] != completion.provider
                or descriptor["modelVersion"] != model.model_version
                or descriptor["tokenizerArtifactId"] != model_use.tokenizer_artifact_id
                or descriptor["tokenizerSha256"] != model.tokenizer_sha256
                or descriptor["endpointReferenceId"] != completion.endpoint_id
                or descriptor["modelUsePolicyVersion"] != model_use.model_use_policy_version
                or not any(row["role"] == "endpoint" and row["bindingId"] == completion.endpoint_id
                           and row["artifact"]["artifactSha256"] == descriptor["endpointSha256"]
                           for row in bindings.values())):
            raise AdapterUnavailable("chat-model-descriptor-binding-mismatch")
        descriptor = MappingProxyType({**descriptor, "pricing": MappingProxyType(dict(descriptor["pricing"]))})
    calendars = {}
    for artifact_id in config["calendar_artifact_ids"]:
        value = _record(selected(artifact_id, "calendar"), {"calendar_id", "version", "sessions", "bindings"})
        sessions = tuple(_construct(Session, row) for row in value["sessions"])
        bars = []
        for row in value["bindings"]:
            binding = _record(row, {f.name for f in fields(BarBinding)})
            binding["windows"] = tuple(_construct(BarWindow, w) for w in binding["windows"])
            bars.append(BarBinding(**binding))
        if value["calendar_id"] in calendars:
            raise AdapterUnavailable("calendar-identity-ambiguous")
        calendars[value["calendar_id"]] = ExplicitSessionCalendar(calendar_id=value["calendar_id"], version=value["version"],
                                                                 sessions=sessions, bindings=tuple(bars))
    return AdapterConfiguration(selection["selectionId"], selection["selectionSha256"], tuple(endpoints),
                                MappingProxyType({p.provider: p for p in providers}), model, model_use, limits,
                                MappingProxyType(calendars), profile, descriptor, config["model_artifact_id"],
                                config.get("model_policy_artifact_id"), privacy_review, native_config)
