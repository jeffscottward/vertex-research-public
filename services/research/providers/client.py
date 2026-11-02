"""Injected, opt-in provider capture. No credentials, discovery, retry loop or HTTP client."""
from __future__ import annotations

from dataclasses import dataclass
from threading import Lock
from typing import Any

from .boundary import Boundary, BoundaryError, authorize, epoch_ns, identifier, parse_json
from .ports import Clock, HttpRequest, PagePlan, ProviderCapture, ProviderConfig, RateBudget, RightRequest, RightsPort, Transport, Unavailable
from .wire import encode_provider_request


@dataclass(frozen=True)
class Endpoint:
    operation: str
    method: str
    path: str
    source_reference: str


class WindowBudget:
    """Local injectable budget; multi-worker hosts must bind an atomic shared budget."""
    def __init__(self, limit: int, window_ns: int):
        if type(limit) is not int or limit < 1 or type(window_ns) is not int or window_ns < 1:
            raise BoundaryError("invalid-rate-budget")
        self.limit, self.window_ns = limit, window_ns
        self._state: dict[tuple[str, str], tuple[int, int, int, int]] = {}
        self._lock = Lock()

    def acquire(self, provider: str, policy_id: str, now_ns: int, cost: int) -> bool:
        if type(cost) is not int or not 1 <= cost <= self.limit:
            return False
        key = (provider, policy_id)
        with self._lock:
            start, spent, cooldown, last = self._state.get(key, (now_ns, 0, now_ns, now_ns))
            if now_ns < last or now_ns < cooldown:
                return False
            if now_ns - start >= self.window_ns:
                start, spent = now_ns, 0
            if spent + cost > self.limit:
                return False
            self._state[key] = (start, spent + cost, cooldown, now_ns)
            return True

    def cool_down(self, provider: str, policy_id: str, until_ns: int) -> None:
        key = (provider, policy_id)
        with self._lock:
            start, spent, cooldown, last = self._state.get(key, (until_ns, 0, until_ns, until_ns))
            self._state[key] = (start, spent, max(cooldown, until_ns), last)


class ProviderClient:
    def __init__(self, *, config: ProviderConfig, origin: str, endpoints: tuple[Endpoint, ...], boundary: Boundary,
                 clock: Clock, rights: RightsPort | None, transport: Transport | None, budget: RateBudget | None):
        if (not 1 <= config.maximum_response_bytes <= 16_000_000 or not 1 <= config.maximum_rows <= 100_000
                or not 1 <= config.maximum_pages <= 100 or not 1 <= config.maximum_depth <= 64
                or not 1 <= config.maximum_nodes <= 1_000_000 or not 1 <= config.timeout_ms <= 120_000
                or not 1 <= config.cooldown_seconds <= config.maximum_cooldown_seconds <= 86400):
            raise BoundaryError("invalid-provider-bounds")
        identifier(config.provider)
        identifier(config.policy_id)
        self.config, self.origin, self.boundary = config, origin, boundary
        self.endpoints = {endpoint.operation: endpoint for endpoint in endpoints}
        self.clock, self.rights, self.transport, self.budget = clock, rights, transport, budget

    def unavailable(self, reason: str, detail: str) -> Unavailable:
        return Unavailable(reason, self.config.provider, detail)

    def plan(self, operation: str, *, query: tuple[tuple[str, str], ...] = (), body: dict[str, Any] | None = None) -> PagePlan | Unavailable:
        endpoint = self.endpoints.get(operation)
        if endpoint is None:
            return self.unavailable("unsupported-capability", "No source-backed endpoint exists for this operation.")
        try:
            self.boundary.require()
            if len(query) > 32 or len({key for key, _ in query}) != len(query) or any(len(key) > 80 or len(value) > 500 for key, value in query):
                raise BoundaryError("invalid-query-bounds")
            encoded = encode_provider_request(body) if body is not None else None
            if encoded is not None and len(encoded) > 32_000:
                raise BoundaryError("request-byte-budget")
            request = HttpRequest(self.config.provider, operation, endpoint.method, self.origin, endpoint.path, query, encoded,
                                  self.config.maximum_response_bytes, self.config.timeout_ms)
            return PagePlan((request,), False, "One documented response only; no pagination or all-history completeness is inferred.")
        except BoundaryError as error:
            return self.unavailable(str(error), "A trusted request boundary is unavailable.")

    def capture(self, plan: PagePlan) -> ProviderCapture | Unavailable:
        if not self.config.enabled:
            return self.unavailable("disabled", "Provider requests are disabled by default.")
        if self.transport is None or self.budget is None:
            return self.unavailable("port-unavailable", "Transport and shared rate budget must be explicitly bound.")
        try:
            self.boundary.require()
            # These documented endpoints have no verified continuation protocol. Reject arbitrary URL/cursor plans.
            if len(plan.requests) != 1 or self.config.maximum_pages < len(plan.requests):
                raise BoundaryError("unsupported-pagination")
            request = plan.requests[0]
            endpoint = self.endpoints.get(request.operation)
            if (endpoint is None or request.provider != self.config.provider or request.origin != self.origin
                    or request.method != endpoint.method or request.path != endpoint.path
                    or request.maximum_response_bytes != self.config.maximum_response_bytes or request.timeout_ms != self.config.timeout_ms):
                raise BoundaryError("request-binding-mismatch")
            now = self.clock.now()
            decision = authorize(self.rights, RightRequest(self.config.provider, self.config.policy_id, request.operation, now))
            if not self.budget.acquire(self.config.provider, self.config.policy_id, epoch_ns(now), 1):
                return self.unavailable("rate-budget-or-cooldown", "No transport call was made; wait for an explicit later request.")
            try:
                response = self.transport.request(request)
            except Exception:
                return self.unavailable("transport-unavailable", "Injected transport failed; raw exceptions are not disclosed.")
            received = epoch_ns(response.received_at)
            if received < epoch_ns(now):
                raise BoundaryError("receive-clock-regression")
            if response.status_code == 429 or response.status_code in (408, 500, 502, 503, 504):
                delay = response.retry_after_seconds
                delay = delay if type(delay) is int and delay >= 0 else self.config.cooldown_seconds
                delay = min(max(delay, self.config.cooldown_seconds), self.config.maximum_cooldown_seconds)
                self.budget.cool_down(self.config.provider, self.config.policy_id, received + delay * 1_000_000_000)
                return self.unavailable("rate-limited" if response.status_code == 429 else "provider-unavailable", "Cooldown recorded; no automatic retry.")
            if response.status_code in (401, 403):
                return self.unavailable("provider-access-denied", "Provider rejected access; no entitlement is inferred.")
            if response.status_code != 200:
                return self.unavailable("provider-unavailable", "Provider returned a non-success response; redirects are unsupported.")
            # Re-evaluate expiry/revocation after the potentially slow transport call.
            after = self.clock.now()
            if epoch_ns(after) < received:
                raise BoundaryError("receive-clock-ahead")
            decision = authorize(self.rights, RightRequest(self.config.provider, self.config.policy_id, request.operation, after))
            parsed = parse_json(response.body, maximum_bytes=self.config.maximum_response_bytes,
                                maximum_nodes=self.config.maximum_nodes, maximum_depth=self.config.maximum_depth)
            if not isinstance(parsed, dict):
                raise BoundaryError("unexpected-provider-shape")
            for key in ("next", "next_page", "nextPage", "next_cursor", "nextCursor", "next_url", "nextUrl"):
                if parsed.get(key):
                    return self.unavailable("unsupported-pagination", "Response needs an unverified continuation; nothing is silently truncated.")
            pagination = parsed.get("pagination")
            if isinstance(pagination, dict) and any(pagination.get(key) for key in ("next", "next_cursor", "nextCursor", "hasMore", "has_more")):
                return self.unavailable("unsupported-pagination", "Nested continuation is unqualified; no next request was made.")
            return ProviderCapture(self.config.provider, request.operation, response.received_at,
                                   self.boundary.content(response.body, "application/json"), self.boundary.encode(parsed), decision,
                                   endpoint.source_reference, (plan.limitation or "Completeness has not been proven.",))
        except BoundaryError as error:
            return self.unavailable(str(error), "Provider data did not pass its explicit trusted boundary.")
        except Exception:
            return self.unavailable("dependency-unavailable", "An injected dependency failed closed.")

    def decode_capture(self, capture: ProviderCapture) -> dict[str, Any]:
        if capture.provider != self.config.provider or capture.operation not in self.endpoints:
            raise BoundaryError("capture-provider-operation-mismatch")
        content = self.boundary.content(capture.content.data, capture.content.media_type)
        if content != capture.content:
            raise BoundaryError("capture-raw-digest-mismatch")
        payload = parse_json(content.data, maximum_bytes=self.config.maximum_response_bytes,
                             maximum_nodes=self.config.maximum_nodes, maximum_depth=self.config.maximum_depth)
        if not isinstance(payload, dict) or self.boundary.encode(payload) != capture.normalized_json:
            raise BoundaryError("capture-normalized-digest-mismatch")
        authorize(self.rights, RightRequest(self.config.provider, self.config.policy_id, capture.operation, self.clock.now()))
        return payload


def required_rows(payload: dict[str, Any], key: str, maximum: int) -> list[dict[str, Any]]:
    value = payload.get(key)
    if not isinstance(value, list) or len(value) > maximum or any(not isinstance(row, dict) for row in value):
        raise BoundaryError("missing-or-invalid-provider-rows")
    return value
