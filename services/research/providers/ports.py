"""Internal Python ports, not alternate public contracts. No default live adapters."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable, Protocol


class Validator(Protocol):
    def validate(self, contract_name: str, payload: dict[str, Any], schema_version: str = "1.0.0") -> bool: ...


class CanonicalCodec(Protocol):
    def encode(self, value: Any) -> bytes: ...
    def digest(self, value: Any) -> str: ...


class Clock(Protocol):
    def now(self) -> str: ...


@dataclass(frozen=True)
class Unavailable:
    reason: str
    source_id: str
    detail: str
    retry_at: str | None = None
    status: str = "unavailable"


@dataclass(frozen=True)
class Content:
    data: bytes
    digest: str
    media_type: str


@dataclass(frozen=True)
class ValidatedRecord:
    contract_name: str
    payload_bytes: bytes
    digest: str

    def decode(self) -> dict[str, Any]:
        # Fresh values prevent a caller from mutating a staged immutable record.
        import json
        return json.loads(self.payload_bytes)


@dataclass(frozen=True)
class RightRequest:
    scope_id: str
    policy_id: str
    operation: str
    evaluated_at: str
    source_ids: tuple[str, ...] = ()


@dataclass(frozen=True)
class RightsDecision:
    scope_id: str
    policy_id: str
    operation: str
    status: str
    checked_at: str
    expires_at: str | None
    revision: str
    source_ids: tuple[str, ...] = ()
    retention_policy: str | None = None
    reason: str | None = None


class RightsPort(Protocol):
    """Trusted control-plane policy including revocation; never document metadata."""
    def decide(self, request: RightRequest) -> RightsDecision: ...


@dataclass(frozen=True)
class HttpRequest:
    provider: str
    operation: str
    method: str
    origin: str
    path: str
    query: tuple[tuple[str, str], ...] = ()
    body: bytes | None = None
    maximum_response_bytes: int = 2_000_000
    timeout_ms: int = 10_000


@dataclass(frozen=True)
class HttpResponse:
    status_code: int
    body: bytes
    received_at: str
    retry_after_seconds: int | None = None
    # Transport must reject redirects and enforce limits before buffering bytes.


class Transport(Protocol):
    """Credentials are privately bound by the host; this port never exposes them."""
    def request(self, request: HttpRequest) -> HttpResponse: ...


class RateBudget(Protocol):
    """Atomic across clients sharing provider policy. No ambient clock or sleeps."""
    def acquire(self, provider: str, policy_id: str, now_ns: int, cost: int) -> bool: ...
    def cool_down(self, provider: str, policy_id: str, until_ns: int) -> None: ...


@dataclass(frozen=True)
class ProviderConfig:
    provider: str
    enabled: bool = False
    policy_id: str = "unconfigured"
    maximum_response_bytes: int = 2_000_000
    maximum_rows: int = 10_000
    maximum_pages: int = 1
    maximum_depth: int = 24
    maximum_nodes: int = 100_000
    timeout_ms: int = 10_000
    cooldown_seconds: int = 60
    maximum_cooldown_seconds: int = 3600


@dataclass(frozen=True)
class ProviderCapture:
    provider: str
    operation: str
    received_at: str
    content: Content
    normalized_json: bytes
    rights: RightsDecision
    source_reference: str
    limitations: tuple[str, ...]

    def decode(self) -> Any:
        import json
        return json.loads(self.normalized_json)


@dataclass(frozen=True)
class DatasetPlan:
    manifest: ValidatedRecord
    content: tuple[Content, ...]
    records: tuple[ValidatedRecord, ...]
    source_digests: tuple[str, ...]
    rights_revision: str
    # Publication is a separate injected control-plane operation.


@dataclass(frozen=True)
class PagePlan:
    requests: tuple[HttpRequest, ...]
    complete: bool
    limitation: str | None = None


PageDecoder = Callable[[dict[str, Any]], list[dict[str, Any]]]
