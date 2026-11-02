"""Private selected deployment facts; never infer a provider/model or token rate."""
from __future__ import annotations

from dataclasses import dataclass
import re

from agents.adapters import ModelPricing
from agents.budget import usd_units
from .ports import AdapterUnavailable


@dataclass(frozen=True)
class ModelPolicy:
    policy_id: str
    model_version: str
    served_model: str
    backend: str
    model_revision: str
    tokenizer_sha256: str
    chat_template_sha256: str
    serving_manifest_sha256: str
    tokenize_endpoint_id: str
    completion_endpoint_id: str
    pricing_source_artifact_id: str
    input_usd_per_million: str
    output_usd_per_million: str
    maximum_context_tokens: int

    def require(self) -> None:
        if (self.backend != "vllm-0.9.2" or not self.model_version or not self.served_model
                or not self.policy_id or not self.pricing_source_artifact_id
                or re.fullmatch(r"[0-9a-f]{40}", self.model_revision) is None
                or any(re.fullmatch(r"[0-9a-f]{64}", value) is None for value in
                       (self.tokenizer_sha256, self.chat_template_sha256, self.serving_manifest_sha256))
                or type(self.maximum_context_tokens) is not int or not 1 <= self.maximum_context_tokens <= 1_000_000):
            raise AdapterUnavailable("model-selection-unavailable")
        if usd_units(self.input_usd_per_million) <= 0 or usd_units(self.output_usd_per_million) <= 0:
            raise AdapterUnavailable("model-pricing-unavailable")

    def pricing(self) -> ModelPricing:
        self.require()
        return ModelPricing(self.input_usd_per_million, self.output_usd_per_million)
