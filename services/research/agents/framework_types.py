"""Typed boundary of the agent framework port (research only).

A framework run (TradingAgents-style desks, Vibe-Trading, ...) takes one ticker and one decision
date and returns a research rating with usage. The rating is a label: nothing here creates, sizes
or sends an order. Importing this module performs no I/O.
"""
from __future__ import annotations

import ipaddress
import re
from datetime import date
from typing import Literal
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

RATINGS = ("buy", "overweight", "hold", "underweight", "sell")
Rating = Literal["buy", "overweight", "hold", "underweight", "sell"]
RatingSource = Literal["stated", "mapped", "missing"]
EventKind = Literal[
    "llm_call", "tool_call", "tool_result", "reasoning", "message", "decision", "status", "flag",
]

SLUG = re.compile(r"^[a-z][a-z0-9_-]{0,39}$")
TICKER = re.compile(r"^[A-Z0-9][A-Z0-9.=/-]{0,19}$")
LABEL = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$")
ENV_NAME = re.compile(r"^[A-Z][A-Z0-9_]{0,63}$")


class _Frozen(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")


def is_local_base_url(base_url: str | None) -> bool:
    """A base URL on this machine or a private network: a local model server (cost 0)."""
    if base_url is None:
        return False
    host = urlsplit(base_url).hostname or ""
    if host == "localhost" or host.endswith(".localhost"):
        return True
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        return False
    return address.is_loopback or address.is_private


class ModelEndpoint(_Frozen):
    """Which model a framework calls. base_url points at an OpenAI-compatible server (for example
    llama.cpp llama-server or Ollama at http://127.0.0.1:8080/v1). api_key_env names the
    environment variable that holds the key; the key itself never enters this object."""

    provider: str = Field(min_length=1, max_length=64)
    model: str = Field(min_length=1, max_length=200)
    base_url: str | None = None
    api_key_env: str | None = None

    @field_validator("provider")
    @classmethod
    def _provider(cls, value: str) -> str:
        if not SLUG.fullmatch(value):
            raise ValueError("provider must be a lowercase slug")
        return value

    @field_validator("base_url")
    @classmethod
    def _base_url(cls, value: str | None) -> str | None:
        if value is None:
            return None
        parts = urlsplit(value)
        if parts.scheme not in ("http", "https") or not parts.hostname:
            raise ValueError("base_url must be an http(s) URL")
        if parts.username or parts.password or parts.query or parts.fragment:
            raise ValueError("base_url must not carry credentials, a query or a fragment")
        return value.rstrip("/")

    @field_validator("api_key_env")
    @classmethod
    def _api_key_env(cls, value: str | None) -> str | None:
        if value is not None and not ENV_NAME.fullmatch(value):
            raise ValueError("api_key_env must be an upper-case environment variable name")
        return value

    @property
    def local(self) -> bool:
        return is_local_base_url(self.base_url)


class FrameworkInfo(_Frozen):
    name: str
    version: str = Field(min_length=1, max_length=64)
    tools_allowed: tuple[str, ...]
    tools_excluded: tuple[str, ...]

    @field_validator("name")
    @classmethod
    def _name(cls, value: str) -> str:
        if not SLUG.fullmatch(value):
            raise ValueError("framework name must be a lowercase slug")
        return value


class FrameworkRunRequest(_Frozen):
    ticker: str
    decision_date: date
    endpoint: ModelEndpoint
    analysts: tuple[str, ...] = ()
    variant: str | None = None
    # Framework memory stays off in a benchmark so runs do not learn from each other.
    memory: Literal[False] = False
    timeout_s: float = Field(default=1800.0, gt=0, le=6 * 3600)

    @field_validator("ticker")
    @classmethod
    def _ticker(cls, value: str) -> str:
        value = value.strip().upper()
        if not TICKER.fullmatch(value):
            raise ValueError("invalid ticker")
        return value

    @field_validator("variant")
    @classmethod
    def _variant(cls, value: str | None) -> str | None:
        if value is not None and not LABEL.fullmatch(value):
            raise ValueError("invalid variant label")
        return value


class FrameworkUsage(_Frozen):
    input_tokens: int = Field(default=0, ge=0)
    output_tokens: int = Field(default=0, ge=0)
    llm_calls: int = Field(default=0, ge=0)
    tool_calls: int = Field(default=0, ge=0)
    # None: the framework could not price the run.
    cost_usd: float | None = Field(default=None, ge=0)
    duration_ms: int | None = Field(default=None, ge=0)


class ModelServed(_Frozen):
    requested: str = Field(min_length=1, max_length=200)
    served: str = Field(min_length=1, max_length=200)


class FrameworkRunResult(_Frozen):
    """A run without a rating is unrated (rating_source missing), never hold."""

    rating: Rating | None = None
    rating_source: RatingSource = "missing"
    entry_price: float | None = Field(default=None, gt=0)
    stop_price: float | None = Field(default=None, gt=0)
    target_price: float | None = Field(default=None, gt=0)
    horizon: str | None = Field(default=None, max_length=64)
    usage: FrameworkUsage = FrameworkUsage()
    models_served: tuple[ModelServed, ...] = ()
    flags: tuple[str, ...] = ()
    error: str | None = Field(default=None, max_length=2000)

    @field_validator("flags")
    @classmethod
    def _flags(cls, value: tuple[str, ...]) -> tuple[str, ...]:
        for flag in value:
            if not SLUG.fullmatch(flag):
                raise ValueError(f"flag {flag!r} is not a lowercase slug")
        return tuple(dict.fromkeys(value))

    @model_validator(mode="after")
    def _rating_source(self) -> FrameworkRunResult:
        if (self.rating is None) != (self.rating_source == "missing"):
            raise ValueError("rating_source is missing exactly when there is no rating")
        return self


class FrameworkEvent(_Frozen):
    """One step of a run for the live view. Text is model output: plain text, never markup."""

    agent: str = Field(min_length=1)
    kind: EventKind
    title: str = Field(min_length=1)
    body: str | None = None
    model: str | None = None
    tool_name: str | None = None
    input_tokens: int | None = Field(default=None, ge=0)
    output_tokens: int | None = Field(default=None, ge=0)
    cost_usd: float | None = Field(default=None, ge=0)
    duration_ms: int | None = Field(default=None, ge=0)
