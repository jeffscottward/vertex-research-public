"""Hosted model prices for the framework benchmark (USD per 1M tokens, input / output).

Research cost estimates only. Prices change: check the provider's price page before a large run and
override with --price on the bench command line. An unknown hosted model has no price (cost None,
flag cost_unknown); a model on a local base URL (llama.cpp, Ollama) costs 0.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Mapping

from agents.framework_types import ModelEndpoint

PRICES_AS_OF = "2026-11-01"


@dataclass(frozen=True)
class TokenPrice:
    input_per_million: float
    output_per_million: float

    def cost(self, input_tokens: int, output_tokens: int) -> float:
        return (input_tokens * self.input_per_million
                + output_tokens * self.output_per_million) / 1_000_000


# Keyed by (provider, model) as the endpoint names them. Public list prices (standard tier).
HOSTED_PRICES: Mapping[tuple[str, str], TokenPrice] = {
    ("openai", "gpt-4o"): TokenPrice(2.50, 10.00),
    ("openai", "gpt-4o-mini"): TokenPrice(0.15, 0.60),
    ("openai", "gpt-4.1"): TokenPrice(2.00, 8.00),
    ("openai", "gpt-4.1-mini"): TokenPrice(0.40, 1.60),
    ("openai", "gpt-4.1-nano"): TokenPrice(0.10, 0.40),
    ("anthropic", "claude-sonnet-4-0"): TokenPrice(3.00, 15.00),
    ("anthropic", "claude-3-5-haiku-latest"): TokenPrice(0.80, 4.00),
}


class PriceBook:
    """The price table plus command-line overrides."""

    def __init__(self, overrides: Mapping[tuple[str, str], TokenPrice] | None = None) -> None:
        self._prices = {**HOSTED_PRICES, **(overrides or {})}

    def price(self, endpoint: ModelEndpoint) -> TokenPrice | None:
        if endpoint.local:
            return TokenPrice(0.0, 0.0)
        return self._prices.get((endpoint.provider, endpoint.model))

    def cost(self, endpoint: ModelEndpoint, input_tokens: int, output_tokens: int) -> float | None:
        price = self.price(endpoint)
        return None if price is None else price.cost(input_tokens, output_tokens)


def parse_price(text: str) -> tuple[tuple[str, str], TokenPrice]:
    """'provider:model=IN/OUT' (USD per 1M tokens), for example 'openai:gpt-5-mini=0.25/2'."""
    key, sep, value = text.partition("=")
    provider, colon, model = key.partition(":")
    inp, slash, out = value.partition("/")
    if not (sep and colon and slash and provider and model):
        raise ValueError(f"price {text!r} must look like provider:model=IN/OUT")
    price = TokenPrice(float(inp), float(out))
    if not (price.input_per_million >= 0 and price.output_per_million >= 0):
        raise ValueError(f"price {text!r} must not be negative")
    return (provider, model), price
