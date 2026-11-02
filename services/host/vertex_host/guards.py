"""Pure synchronous guards around native compute and simulator mutation."""
from __future__ import annotations

from typing import Any, Callable
from .cache import HostUnavailable


class LeaseBoundRisk:
    def __init__(self, delegate: Any, current: Callable[[], bool]) -> None:
        self.delegate, self.current = delegate, current

    def assess(self, **kwargs: Any) -> Any:
        if not self.current():
            raise HostUnavailable("risk-worker-lease-fenced")
        result = self.delegate.assess(**kwargs)
        if not self.current():
            raise HostUnavailable("risk-worker-lease-fenced-after-computation")
        return result

    def assess_batch(self, **kwargs: Any) -> Any:
        if not self.current():
            raise HostUnavailable("risk-worker-lease-fenced")
        result = self.delegate.assess_batch(**kwargs)
        if not self.current():
            raise HostUnavailable("risk-worker-lease-fenced-after-computation")
        return result


class LeaseBoundPaperTransport:
    simulation_only = True
    broker_submission_allowed = False

    def __init__(self, delegate: Any, current: Callable[[], bool]) -> None:
        if delegate.simulation_only is not True or delegate.broker_submission_allowed is not False:
            raise HostUnavailable("only-paper-transport-may-be-guarded")
        self.delegate, self.current = delegate, current

    def submit(self, *args: Any, **kwargs: Any) -> Any:
        if not self.current():
            raise HostUnavailable("paper-dispatch-worker-lease-fenced")
        return self.delegate.submit(*args, **kwargs)

    def cancel(self, *args: Any, **kwargs: Any) -> Any:
        # Cancellation is separately signed native-local authority; no worker
        # token is required or promoted into authority by this wrapper.
        return self.delegate.cancel(*args, **kwargs)

    def reconcile(self, *args: Any, **kwargs: Any) -> Any:
        # Reconciliation remains necessary after lease loss; no new dispatch.
        return self.delegate.reconcile(*args, **kwargs)
