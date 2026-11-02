"""Lease-local ports shared by the single host dispatcher and provider adapters."""
from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field
from typing import Any, Mapping

from vertex_execution.exact import timestamp


class SystemClock:
    def now_ns(self) -> int:
        return time.time_ns()

    def monotonic(self) -> float:
        return time.monotonic()

    def now(self) -> str:
        return timestamp(self.now_ns())


@dataclass(frozen=True, slots=True)
class HostContext:
    selection: Mapping[str, Any]
    contracts: Any
    control: Any
    secret_resolver: Any
    clock: Any
    cancellation: asyncio.Event
    supervisor: Any
    publication: Any
    admission: Any
    endpoint_policies: Mapping[str, Any]
    chat_events: Any
    adapter_config: Any = None
    control_bridge: Any = None
    lease: Mapping[str, Any] = field(default_factory=dict)
    # Optional trusted same-owner bytes capability; no broker construction here.
    ibkr_history: Any = None


class UnavailablePort:
    """Missing configuration never silently becomes an allow/no-op port."""
    def __init__(self, reason: str) -> None:
        self.reason = reason

    def __getattr__(self, name: str) -> Any:
        from .cache import HostUnavailable
        raise HostUnavailable(self.reason)
