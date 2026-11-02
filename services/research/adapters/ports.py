"""Host-owned effect ports; these are internal interfaces, not public schemas.

The sole Host dispatcher owns admission, cancellation and worker lifetime. No
adapter starts a poller, discovers credentials, selects 'latest', or owns a
process-local rate window. Public payload validation stays in ContractAuthority.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Mapping, Protocol


class AdapterUnavailable(RuntimeError):
    """Only constant, non-sensitive reason codes cross adapter boundaries."""


class Clock(Protocol):
    def now_ns(self) -> int: ...
    def monotonic(self) -> float: ...


class Cancellation(Protocol):
    def cancelled(self) -> bool: ...


class SecretResolver(Protocol):
    def resolve(self, reference_id: str, *, endpoint_id: str) -> str:
        """Resolve only the selected reference and endpoint; never log the value."""
        ...


class SharedAdmission(Protocol):
    def acquire(self, provider: str, policy_id: str, now_ns: int, cost: int) -> bool: ...
    def cool_down(self, provider: str, policy_id: str, until_ns: int) -> None: ...
    def reserve_model(self, *, run_id: str, attempt_id: str, model_policy_id: str,
                      tokens: int, usd: str, deadline_ns: int) -> str | None:
        """Atomic shared Host/durable admission, not one counter per worker.

        Only a NEW reservation returns a receipt. Duplicate/unknown admission
        returns None. Crashes retain the full reservation; never refund on timeout.
        """
        ...
    def settle_model(self, receipt: str, *, tokens: int | None, usd: str | None) -> None:
        """None means uncertain full charge; otherwise atomically account actuals."""
        ...


class Supervisor(Protocol):
    def call(self, operation: str, payload: Mapping[str, Any], *, deadline_ns: int,
             max_output_bytes: int) -> Mapping[str, Any]:
        """Host-approved worker opcode, never arbitrary module/path/code.

        Must enforce CPU/wall/RSS/output limits, process-tree kill, cancellation,
        network denial, no subprocess/filesystem/vault access, and bounded input.
        Methods here are called from the handler's effect thread, never its loop.
        """
        ...


class ChatEventDelivery(Protocol):
    def deliver(self, *, thread_id: str, run_id: str, trace_id: str,
                events: tuple[Mapping[str, Any], ...], deadline_ns: int) -> str:
        """Existing authenticated chat transport; bind thread membership server-side.

        Return accepted/duplicate only after durable idempotent event admission;
        unknown must not trigger automatic retry. Never execute/render model HTML.
        """
        ...


@dataclass(frozen=True)
class EndpointPolicy:
    endpoint_id: str
    provider: str
    operation: str
    origin: str
    path: str
    method: str
    credential_reference_id: str
    credential_header: str
    credential_prefix: str
    allowed_query_keys: tuple[str, ...]
    policy_id: str
    source_reference: str
    maximum_request_bytes: int = 32_000
    maximum_response_bytes: int = 2_000_000
    timeout_ms: int = 10_000
    # Explicit deployment addresses pin routing as well as TLS hostname identity.
    # No runtime DNS worker/thread or DNS-rebinding race is needed.
    allowed_ip_addresses: tuple[str, ...] = ()


class EventCancellation:
    def __init__(self, event: Any):
        self.event = event

    def cancelled(self) -> bool:
        return self.event.is_set() is not False


class ResearchClock:
    def __init__(self, clock: Clock, contracts: Any):
        self.clock, self.contracts = clock, contracts

    def now_ns(self) -> int:
        return self.clock.now_ns()

    def timestamp_ns(self, value: str) -> int:
        return self.contracts.epoch_ns(value)

    def now(self) -> str:
        # No float or millisecond truncation in public timestamps.
        from datetime import datetime, timezone
        seconds, nanos = divmod(self.now_ns(), 1_000_000_000)
        return datetime.fromtimestamp(seconds, timezone.utc).strftime("%Y-%m-%dT%H:%M:%S") + f".{nanos:09d}Z"
