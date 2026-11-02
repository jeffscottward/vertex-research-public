"""Bounded, nonauthoritative tick ingress; orchestration is never a callback.

One owning event-loop thread calls both ingress and drain. Cross-thread producers
must marshal to that thread outside this module. This is not a durable command
queue, an admission gate, or a source of spendable portfolio authority.
"""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass
from decimal import Decimal
from typing import Awaitable, Callable


class TickContinuityLost(RuntimeError):
    """Replace the buffer after independently reconciling an observed gap."""


def _identifier(value: str) -> None:
    if type(value) is not str or not 1 <= len(value) <= 128:
        raise ValueError("tick identifiers must contain 1..128 characters")
    if not value.isascii() or any(ord(char) < 33 or ord(char) > 126 for char in value):
        raise ValueError("tick identifiers must be printable ASCII without spaces")


def _price(value: Decimal | None) -> None:
    if value is None:
        return
    if type(value) is not Decimal or not value.is_finite() or value <= 0:
        raise ValueError("tick prices must be positive finite Decimal values")
    _, digits, exponent = value.as_tuple()
    if len(digits) > 38 or not -18 <= exponent <= 18:
        raise ValueError("tick price representation exceeds bounded decimal profile")


@dataclass(frozen=True, slots=True)
class TickEvent:
    """Private ingress value, not a replacement for the public Quote contract."""

    instrument_id: str
    event_id: str
    event_ns: int
    bid: Decimal | None = None
    ask: Decimal | None = None
    last: Decimal | None = None

    def __post_init__(self) -> None:
        _identifier(self.instrument_id)
        _identifier(self.event_id)
        if type(self.event_ns) is not int or not 0 <= self.event_ns < 2**127:
            raise ValueError("event_ns must be an exact nonnegative i128 nanosecond epoch")
        for value in (self.bid, self.ask, self.last):
            _price(value)
        if self.bid is None and self.ask is None and self.last is None:
            raise ValueError("a tick must contain an observed price")
        if self.bid is not None and self.ask is not None and self.bid > self.ask:
            raise ValueError("crossed quotes are not accepted")


@dataclass(frozen=True, slots=True)
class TickBufferState:
    capacity: int
    pending: int
    dropped: int
    continuity_lost: bool
    closed: bool


class BoundedTickBuffer:
    """O(1) synchronous enqueue, no observers, clocks, logging, IO or hooks.

    Overflow rejects the new tick, preserves earlier ticks, and latches a gap.
    Neither ingress nor drain resumes after a gap; an external reconciler must
    establish a new source baseline and construct a fresh buffer. Counters
    saturate so an indefinitely disconnected consumer has bounded memory too.
    """

    __slots__ = ("_capacity", "_ticks", "_dropped", "_gap", "_closed", "_draining")

    def __init__(self, capacity: int = 1024) -> None:
        if type(capacity) is not int or not 1 <= capacity <= 65536:
            raise ValueError("capacity must be an integer in 1..65536")
        self._capacity = capacity
        self._ticks: deque[TickEvent] = deque()
        self._dropped = 0
        self._gap = False
        self._closed = False
        self._draining = False

    def on_tick(self, tick: TickEvent) -> bool:
        if type(tick) is not TickEvent:
            raise TypeError("callback accepts only a pre-normalized TickEvent")
        if self._closed or self._gap or len(self._ticks) >= self._capacity:
            self._dropped = min(self._dropped + 1, 2**63 - 1)
            if not self._closed:
                self._gap = True
            return False
        self._ticks.append(tick)
        return True

    def state(self) -> TickBufferState:
        return TickBufferState(
            self._capacity, len(self._ticks), self._dropped, self._gap, self._closed
        )

    def close(self) -> None:
        """Stop new ingress without discarding already queued observations."""
        self._closed = True


TickSink = Callable[[TickEvent], Awaitable[None]]


class AsyncTickDrain:
    """Explicit async boundary; sink runs only here, never inside on_tick.

    A failed/cancelled sink retains the head for at-least-once retry. The sink
    must deduplicate event IDs: an exception cannot prove that no effect occurred.
    There is no automatic task scheduling, retry loop, disk write or transport.
    """

    __slots__ = ("_buffer", "_sink")

    def __init__(self, buffer: BoundedTickBuffer, sink: TickSink) -> None:
        if type(buffer) is not BoundedTickBuffer or not callable(sink):
            raise TypeError("drain requires a bounded buffer and an async sink")
        self._buffer = buffer
        self._sink = sink

    async def drain(self, max_items: int = 256) -> int:
        if type(max_items) is not int or not 1 <= max_items <= 65536:
            raise ValueError("max_items must be an integer in 1..65536")
        buffer = self._buffer
        if buffer._draining:
            raise RuntimeError("only one drain may own a buffer")
        if buffer._gap:
            raise TickContinuityLost("tick overflow requires a reconciled new buffer")
        buffer._draining = True
        consumed = 0
        try:
            count = min(max_items, len(buffer._ticks))
            for _ in range(count):
                if buffer._gap:
                    raise TickContinuityLost("tick continuity lost while draining")
                tick = buffer._ticks[0]
                await self._sink(tick)
                buffer._ticks.popleft()
                consumed += 1
                if buffer._gap:
                    raise TickContinuityLost("tick continuity lost while draining")
            return consumed
        finally:
            buffer._draining = False
