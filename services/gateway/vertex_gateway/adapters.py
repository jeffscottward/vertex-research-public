"""Explicitly injected read-only collection. Import/startup never touches a host."""
from __future__ import annotations

from dataclasses import replace

from .models import GatewayTarget, HostTrust, ObservationSnapshot, ReadinessAssessment, nanoseconds
from .ports import ClockPort, HostTrustPort, ObservationPort
from .readiness import ObservationPolicy, assess_readiness


class GatewayObservationService:
    """No HTTP/BFF/server or broker SDK; the enclosing native service owns ports.

    There is no concrete SSH/TLS/socket implementation or configuration discovery.
    Preserve infrastructure_probe.py as an independent metadata-only utility;
    its successful result cannot be promoted into broker authentication evidence.
    """
    def __init__(self, *, clock: ClockPort, policy: ObservationPolicy,
                 trust: HostTrustPort | None = None,
                 observations: ObservationPort | None = None,
                 enabled: bool = False) -> None:
        if type(enabled) is not bool:
            raise ValueError("explicit_observation_flag_required")
        self._clock = clock
        self._policy = policy
        self._trust = trust
        self._observations = observations
        self._enabled = enabled

    def observe(self, target: GatewayTarget) -> ReadinessAssessment:
        now = nanoseconds(self._clock.now_ns())
        trust = None
        snapshot = None
        reason = "observation-disabled"
        if self._enabled:
            if self._trust is None or self._observations is None:
                reason = "observation-ports-unavailable"
            else:
                try:
                    trust = self._trust.inspect(target)
                    now = nanoseconds(self._clock.now_ns())
                    if not isinstance(trust, HostTrust):
                        trust = None
                        reason = "host-trust-unverified"
                    elif not trust.current(target, now):
                        reason = "host-trust-unverified"
                    else:
                        snapshot = self._observations.collect(target)
                        if not isinstance(snapshot, ObservationSnapshot):
                            raise ValueError("invalid_observation_snapshot")
                        reason = "observation-collected"
                except Exception:
                    # Never leak raw transport exceptions, routes or account data.
                    reason = "observation-unavailable"
                    snapshot = None
                now = nanoseconds(self._clock.now_ns())
        assessment = assess_readiness(target, snapshot, trust, self._policy, now)
        return replace(assessment, reason_codes=(reason, *assessment.reason_codes))
