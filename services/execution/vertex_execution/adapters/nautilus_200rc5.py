"""Lazy exact-rc5 Rust/PyO3 bridge; no import or default engine factory.

An injected factory is a trusted offline composition dependency, not a Python
sandbox. This module never discovers clients, starts a LiveNode, or exposes
order submission. Isolation for backtests is separately supervisor-attested.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable, Literal, Protocol

from .callbacks import BoundedTickBuffer, TickEvent


NAUTILUS_VERSION = "2.0.0rc5"


class EngineUnavailable(RuntimeError):
    pass


class EngineVersionMismatch(EngineUnavailable):
    pass


@dataclass(frozen=True, slots=True)
class OfflineEngineScope:
    mode: Literal["research", "paper"]
    version: str = field(default=NAUTILUS_VERSION, init=False)
    simulation_only: bool = field(default=True, init=False)
    live_authorization: bool = field(default=False, init=False)
    broker_submission_allowed: bool = field(default=False, init=False)

    def __post_init__(self) -> None:
        if type(self.mode) is not str or self.mode not in ("research", "paper"):
            raise ValueError("Nautilus adapter is research/paper simulation only")


class OfflineEngine(Protocol):
    """Intentionally has no connect, start, submit, cancel, or broker capability."""

    async def process_tick(self, tick: TickEvent) -> None: ...

    async def close(self) -> None: ...


class OfflineEngineFactory(Protocol):
    def __call__(self, module: object, scope: OfflineEngineScope) -> OfflineEngine: ...


class Nautilus200rc5Adapter:
    __slots__ = ("_scope", "_loader", "_factory", "_buffer", "_engine", "_attempted", "_closed")

    def __init__(
        self,
        *,
        mode: Literal["research", "paper"],
        buffer: BoundedTickBuffer,
        load_module: Callable[[], object] | None = None,
        factory: OfflineEngineFactory | None = None,
    ) -> None:
        self._scope = OfflineEngineScope(mode)
        if type(buffer) is not BoundedTickBuffer:
            raise TypeError("engine requires the pure bounded tick ingress")
        self._buffer = buffer
        self._loader = load_module
        self._factory = factory
        self._engine: OfflineEngine | None = None
        self._attempted = False
        self._closed = False

    @property
    def scope(self) -> OfflineEngineScope:
        return self._scope

    @property
    def active(self) -> bool:
        return self._engine is not None and not self._closed

    def activate(self) -> None:
        """Explicit composition only; never called by construction or on_tick.

        Failed activation is latched: a partially created injected engine must
        be independently cleaned up before constructing another adapter.
        """
        if self._closed:
            raise EngineUnavailable("adapter is closed")
        if self.active:
            return
        if self._attempted:
            raise EngineUnavailable("activation failed; automatic retry is forbidden")
        if self._loader is None or self._factory is None:
            raise EngineUnavailable("offline module loader and factory are not supplied")
        self._attempted = True
        module = self._loader()
        version = getattr(module, "__version__", None)
        if type(version) is not str or version != NAUTILUS_VERSION:
            raise EngineVersionMismatch("only exact Nautilus 2.0.0rc5 is supported")
        engine = self._factory(module, self._scope)
        if not callable(getattr(engine, "process_tick", None)) or not callable(getattr(engine, "close", None)):
            raise EngineUnavailable("factory did not supply an offline tick engine")
        self._engine = engine

    def on_tick(self, tick: TickEvent) -> bool:
        """The synchronous engine callback only queues a private value."""
        return self._buffer.on_tick(tick)

    async def process_tick(self, tick: TickEvent) -> None:
        """Inject this sink into AsyncTickDrain; never call from an engine callback."""
        if not self.active or self._engine is None:
            raise EngineUnavailable("offline engine is not active")
        if type(tick) is not TickEvent:
            raise TypeError("only normalized private ticks are accepted")
        if self._buffer.state().continuity_lost:
            raise EngineUnavailable("tick stream must be independently reconciled")
        await self._engine.process_tick(tick)

    async def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        self._buffer.close()
        engine, self._engine = self._engine, None
        if engine is not None:
            await engine.close()
