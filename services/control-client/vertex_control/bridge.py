"""The host owns the one event loop. Research ports run in a worker thread."""
from __future__ import annotations

import asyncio
import concurrent.futures
import math
from .client import ControlError


class LoopBridge:
    def __init__(self, loop: asyncio.AbstractEventLoop, *, timeout_seconds: float = 120.0):
        if (not isinstance(loop, asyncio.AbstractEventLoop) or not loop.is_running()
                or loop.is_closed() or type(timeout_seconds) not in (int, float)
                or not math.isfinite(timeout_seconds) or not 0 < timeout_seconds <= 120):
            raise ControlError("host-loop-unavailable")
        self.loop, self.timeout_seconds = loop, timeout_seconds

    def run(self, coroutine_factory, *, timeout_seconds: float | None = None):
        # Refuse ANY running loop: no nesting, loop hijacking or hidden scheduler.
        try:
            asyncio.get_running_loop()
        except RuntimeError:
            pass
        else:
            raise ControlError("synchronous-port-called-on-event-loop")
        if self.loop.is_closed() or not self.loop.is_running():
            raise ControlError("host-loop-unavailable")
        limit = self.timeout_seconds if timeout_seconds is None else min(self.timeout_seconds, timeout_seconds)
        if not math.isfinite(limit) or limit <= 0:
            raise ControlError("domain-deadline-expired")
        coroutine = coroutine_factory()
        try:
            future = asyncio.run_coroutine_threadsafe(coroutine, self.loop)
        except Exception:
            coroutine.close()
            raise ControlError("host-loop-unavailable") from None
        try:
            return future.result(timeout=limit)
        except concurrent.futures.TimeoutError:
            future.cancel()
            raise ControlError("domain-call-timeout", effect="unknown") from None
        except concurrent.futures.CancelledError:
            raise ControlError("domain-call-cancelled", effect="unknown") from None
