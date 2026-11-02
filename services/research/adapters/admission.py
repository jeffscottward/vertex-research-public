"""One Host owner, shared by every job; never instantiate in create_handlers.

A restarted owner quarantines every complete configured rate/accounting window.
This deliberately sacrifices availability rather than reset spent quota. Durable
run admission remains in ControlLink; local receipts never authorize a second run.
"""
from __future__ import annotations

import os
import threading
from dataclasses import dataclass
from typing import Any

from agents.budget import usd_units
from .ports import AdapterUnavailable, Clock


@dataclass(frozen=True)
class AdmissionLimit:
    provider: str
    policy_id: str
    window_seconds: int
    requests: int
    model_tokens: int
    model_usd: str


class HostAdmissionOwner:
    def __init__(self, limits: tuple[AdmissionLimit, ...], *, clock: Clock, owner_fence: Any):
        if not limits or len(limits) > 128 or len({(v.provider, v.policy_id) for v in limits}) != len(limits):
            raise AdapterUnavailable("admission-policy-invalid")
        self.limits = {(v.provider, v.policy_id): v for v in limits}
        for item in limits:
            if (not 1 <= item.window_seconds <= 86400 or not 1 <= item.requests <= 1_000_000
                    or not 0 <= item.model_tokens <= 2**53 - 1 or usd_units(item.model_usd) < 0):
                raise AdapterUnavailable("admission-policy-invalid")
        self.clock, self.owner_fence, self.pid = clock, owner_fence, os.getpid()
        self._lock = threading.Lock()
        started = clock.monotonic()
        self._last_ns, self._last_mono = clock.now_ns(), started
        self._states = {key: [started + v.window_seconds, 0, 0, 0, 0] for key, v in self.limits.items()}
        self._receipts: dict[str, tuple[tuple[str, str], float, int, int, bool]] = {}
        self._attempts: set[tuple[str, str]] = set()
        self._halted = False

    def _check(self) -> tuple[int, float]:
        now, mono = self.clock.now_ns(), self.clock.monotonic()
        if (os.getpid() != self.pid or self.owner_fence.is_current() is not True
                or self._halted or now < self._last_ns or mono < self._last_mono):
            raise AdapterUnavailable("admission-owner-unavailable")
        self._last_ns, self._last_mono = now, mono
        return now, mono

    def _state(self, key: tuple[str, str], mono: float) -> list[Any] | None:
        limit = self.limits.get(key)
        if limit is None:
            return None
        state = self._states[key]
        if mono < state[0]:
            return None  # cold-owner quarantine
        if mono >= state[0] + limit.window_seconds:
            state[:] = [mono, 0, 0, 0, state[4]]
        return state

    def acquire(self, provider: str, policy_id: str, now_ns: int, cost: int) -> bool:
        with self._lock:
            now, mono = self._check()
            key = (provider, policy_id)
            state = self._state(key, mono)
            if (type(cost) is not int or cost != 1 or type(now_ns) is not int or now_ns > now
                    or state is None or now < state[4] or state[1] + cost > self.limits[key].requests):
                return False
            state[1] += cost
            return True

    def cool_down(self, provider: str, policy_id: str, until_ns: int) -> None:
        with self._lock:
            now, _ = self._check()
            state = self._states.get((provider, policy_id))
            if state is None or type(until_ns) is not int or not now <= until_ns <= now + 86400 * 1_000_000_000:
                raise AdapterUnavailable("cooldown-policy-invalid")
            state[4] = max(state[4], until_ns)

    def reserve_model(self, *, run_id: str, attempt_id: str, model_policy_id: str,
                      tokens: int, usd: str, deadline_ns: int) -> str | None:
        with self._lock:
            now, mono = self._check()
            matches = [key for key in self.limits if key[1] == model_policy_id and self.limits[key].model_tokens > 0]
            if len(matches) != 1 or type(tokens) is not int or tokens < 1 or deadline_ns <= now:
                return None
            key = matches[0]
            state, units = self._state(key, mono), usd_units(usd)
            limit = self.limits[key]
            if (state is None or now < state[4] or (run_id, attempt_id) in self._attempts
                    or len(self._attempts) >= 100_000 or state[2] + tokens > limit.model_tokens
                    or state[3] + units > usd_units(limit.model_usd)):
                return None
            receipt = "host-model-" + str(len(self._receipts) + 1)
            self._attempts.add((run_id, attempt_id))
            self._receipts[receipt] = (key, state[0], tokens, units, False)
            state[2] += tokens
            state[3] += units
            return receipt

    def settle_model(self, receipt: str, *, tokens: int | None, usd: str | None) -> None:
        with self._lock:
            self._check()
            record = self._receipts.get(receipt)
            if record is None or record[4]:
                raise AdapterUnavailable("model-reservation-unknown")
            key, window, reserved_tokens, reserved_usd, _ = record
            self._receipts[receipt] = (*record[:4], True)
            if tokens is None or usd is None:
                return  # retain full charge on cancellation/timeout/unknown usage
            units = usd_units(usd)
            if type(tokens) is not int or tokens < 0 or tokens > reserved_tokens or units > reserved_usd:
                self._halted = True
                raise AdapterUnavailable("model-usage-exceeds-reservation")
            state = self._states[key]
            if state[0] == window:
                state[2] -= reserved_tokens - tokens
                state[3] -= reserved_usd - units


def create_host_admission(config: Any, clock: Clock, owner_fence: Any) -> HostAdmissionOwner:
    """Host lifecycle calls once and supplies the resulting object to all jobs."""
    return HostAdmissionOwner(config.admission_limits, clock=clock, owner_fence=owner_fence)
