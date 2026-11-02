"""Explicit endpoint-only HTTPS. No redirects, DNS, proxies or URL discovery."""
from __future__ import annotations

import http.client
import ipaddress
import re
import socket
import ssl
import threading
from typing import Callable
from urllib.parse import urlencode, urlsplit

from providers.ports import HttpRequest, HttpResponse
from .ports import AdapterUnavailable, Cancellation, Clock, EndpointPolicy, ResearchClock, SecretResolver, SharedAdmission


class SharedRateGate:
    """Connect the existing ProviderClient RateBudget to the host-owned authority.

    A grant is single-use and local only as a consumed receipt, NOT a rate window.
    Lost grants are charged; a new worker cannot reset the host's shared budget.
    """
    def __init__(self, admission: SharedAdmission, clock: Clock):
        self.admission, self.clock = admission, clock
        self._lock = threading.Lock()
        self._permits: dict[int, tuple[str, str, float]] = {}

    def acquire(self, provider: str, policy_id: str, now_ns: int, cost: int) -> bool:
        if cost != 1 or self.admission.acquire(provider, policy_id, now_ns, cost) is not True:
            return False
        with self._lock:
            self._permits[threading.get_ident()] = (provider, policy_id, self.clock.monotonic())
        return True

    def consume(self, policy: EndpointPolicy) -> None:
        with self._lock:
            grant = self._permits.pop(threading.get_ident(), None)
        if grant is None or grant[:2] != (policy.provider, policy.policy_id) or not 0 <= self.clock.monotonic() - grant[2] <= 5:
            raise AdapterUnavailable("shared-admission-required")

    def cool_down(self, provider: str, policy_id: str, until_ns: int) -> None:
        self.admission.cool_down(provider, policy_id, until_ns)


class _PinnedHTTPSConnection(http.client.HTTPSConnection):
    def __init__(self, hostname: str, address: str, timeout: float):
        # create_default_context requires normal system trust and hostname checks.
        super().__init__(hostname, 443, timeout=timeout, context=ssl.create_default_context())
        self._address = address

    def connect(self) -> None:
        raw = socket.create_connection((self._address, 443), timeout=self.timeout)
        self.sock = raw
        try:
            self.sock = self._context.wrap_socket(raw, server_hostname=self.host)
        except BaseException:
            raw.close()
            self.sock = None
            raise


class HttpsTransport:
    def __init__(self, *, policies: tuple[EndpointPolicy, ...], secrets: SecretResolver,
                 budget: SharedRateGate, clock: Clock, timestamps: ResearchClock,
                 cancellation: Cancellation, deadline_ns: int,
                 authorize_endpoint: Callable[[EndpointPolicy], None]):
        self._policies = {(p.provider, p.operation): p for p in policies}
        if len(self._policies) != len(policies):
            raise AdapterUnavailable("duplicate-endpoint-policy")
        for policy in policies:
            self._validate_policy(policy)
        self._secrets, self._budget = secrets, budget
        self._clock, self._timestamps = clock, timestamps
        self._cancellation, self._deadline_ns = cancellation, deadline_ns
        self._authorize_endpoint = authorize_endpoint

    @staticmethod
    def _validate_policy(policy: EndpointPolicy) -> None:
        parsed = urlsplit(policy.origin)
        if (parsed.scheme != "https" or not parsed.hostname or parsed.username is not None
                or parsed.password is not None or parsed.port not in (None, 443)
                or parsed.path or parsed.query or parsed.fragment
                or policy.origin != "https://" + parsed.hostname
                or parsed.hostname.endswith(".")
                or re.fullmatch(r"[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?", parsed.hostname) is None):
            raise AdapterUnavailable("endpoint-origin-invalid")
        if (policy.method not in ("GET", "POST") or not policy.path.startswith("/")
                or policy.path.startswith("//") or any(c in policy.path for c in "?#\\%")
                or any(ord(c) < 33 or ord(c) > 126 for c in policy.path)
                or "/../" in policy.path or policy.path.endswith("/..")
                or not policy.source_reference or not policy.credential_reference_id
                or policy.credential_header.lower() not in ("authorization", "x-api-key", "api-key")
                or policy.credential_prefix not in ("", "Bearer ")
                or not 1 <= policy.maximum_request_bytes <= 1_000_000
                or not 1 <= policy.maximum_response_bytes <= 16_000_000
                or not 1 <= policy.timeout_ms <= 120_000
                or not 1 <= len(policy.allowed_ip_addresses) <= 16):
            raise AdapterUnavailable("endpoint-policy-invalid")
        for address in policy.allowed_ip_addresses:
            try:
                ip = ipaddress.ip_address(address)
            except ValueError:
                raise AdapterUnavailable("endpoint-address-invalid") from None
            if not ip.is_global or ip.is_multicast or ip.is_reserved or getattr(ip, "ipv4_mapped", None):
                raise AdapterUnavailable("endpoint-address-not-public")
        if len(set(policy.allowed_query_keys)) != len(policy.allowed_query_keys):
            raise AdapterUnavailable("endpoint-query-policy-invalid")

    def request(self, request: HttpRequest) -> HttpResponse:
        return self.request_until(request, deadline_ns=self._deadline_ns)

    def request_until(self, request: HttpRequest, *, deadline_ns: int,
                      authorize_disclosure: Callable[[], None] | None = None) -> HttpResponse:
        deadline_ns = min(deadline_ns, self._deadline_ns)
        policy = self._policies.get((request.provider, request.operation))
        if policy is None or (request.origin, request.path, request.method) != (policy.origin, policy.path, policy.method):
            raise AdapterUnavailable("endpoint-not-allowed")
        if policy.operation in ("model-tokenize", "model-completion") and authorize_disclosure is None:
            raise AdapterUnavailable("independent-model-use-proof-required")
        if (type(request.maximum_response_bytes) is not int or not 1 <= request.maximum_response_bytes <= policy.maximum_response_bytes
                or type(request.timeout_ms) is not int or not 1 <= request.timeout_ms <= policy.timeout_ms
                or request.body is not None and (not isinstance(request.body, bytes) or len(request.body) > policy.maximum_request_bytes)
                or request.method == "GET" and request.body is not None
                or len(request.query) > 32 or len({k for k, _ in request.query}) != len(request.query)
                or any(k not in policy.allowed_query_keys or not isinstance(v, str) or len(v) > 500
                       or any(ord(c) < 32 or ord(c) == 127 for c in v) for k, v in request.query)):
            raise AdapterUnavailable("request-bound-exceeded")
        self._authorize_endpoint(policy)
        self._budget.consume(policy)
        if self._cancellation.cancelled() or self._clock.now_ns() >= deadline_ns:
            raise AdapterUnavailable("cancelled-or-deadline")
        started = self._clock.monotonic()
        seconds = min(request.timeout_ms / 1000, (deadline_ns - self._clock.now_ns()) / 1_000_000_000)
        if seconds <= 0:
            raise AdapterUnavailable("cancelled-or-deadline")
        # Resolution is explicit host policy. Only one approved address is tried;
        # certificate/hostname verification still uses the configured DNS name.
        conn = _PinnedHTTPSConnection(urlsplit(policy.origin).hostname, policy.allowed_ip_addresses[0], min(seconds, 1.0))
        done, aborted = threading.Event(), threading.Event()

        def interrupt() -> None:
            # Per-call watchdog: bounded lifetime, never a scheduler/retry loop.
            while not done.wait(0.025):
                if self._cancellation.cancelled() or self._clock.monotonic() - started >= seconds or self._clock.now_ns() >= deadline_ns:
                    aborted.set()
                    try:
                        if conn.sock is not None:
                            conn.sock.shutdown(socket.SHUT_RDWR)
                    except OSError:
                        pass
                    conn.close()
                    return

        guard = threading.Thread(target=interrupt, name="vertex-https-deadline", daemon=True)
        guard.start()
        try:
            credential = self._secrets.resolve(policy.credential_reference_id, endpoint_id=policy.endpoint_id)
            if not isinstance(credential, str) or not 1 <= len(credential) <= 8192 or any(ord(c) < 33 or ord(c) > 126 for c in credential):
                raise AdapterUnavailable("credential-unavailable")
            headers = {"Accept": "application/json", "Accept-Encoding": "identity", "Connection": "close",
                       policy.credential_header: policy.credential_prefix + credential}
            if request.body is not None:
                headers["Content-Type"] = "application/json"
            target = policy.path + (("?" + urlencode(request.query)) if request.query else "")
            if aborted.is_set() or self._cancellation.cancelled():
                raise AdapterUnavailable("cancelled-or-deadline")
            if authorize_disclosure is not None:
                authorize_disclosure()
            if aborted.is_set() or self._cancellation.cancelled() or self._clock.now_ns() >= deadline_ns:
                raise AdapterUnavailable("cancelled-or-deadline")
            conn.connect()
            if aborted.is_set() or self._cancellation.cancelled():
                raise AdapterUnavailable("cancelled-or-deadline")
            if conn.sock is not None:
                conn.sock.settimeout(max(0.001, seconds - (self._clock.monotonic() - started)))
            conn.request(request.method, target, body=request.body, headers=headers)
            del credential, headers
            response = conn.getresponse()
            # No redirect is ever followed, including same-origin redirects.
            if 300 <= response.status <= 399:
                raise AdapterUnavailable("redirect-rejected")
            if response.getheader("Content-Encoding", "identity").lower() != "identity":
                raise AdapterUnavailable("encoded-response-rejected")
            length = response.getheader("Content-Length")
            if length is not None and (not length.isdecimal() or int(length) > request.maximum_response_bytes):
                raise AdapterUnavailable("response-byte-budget")
            retry = response.getheader("Retry-After")
            retry_seconds = min(int(retry), 86400) if retry and retry.isdecimal() and len(retry) <= 8 else None
            body = bytearray()
            if response.status == 200:
                while True:
                    if aborted.is_set() or self._cancellation.cancelled() or self._clock.monotonic() - started >= seconds:
                        raise AdapterUnavailable("cancelled-or-deadline")
                    part = response.read1(min(65536, request.maximum_response_bytes + 1 - len(body)))
                    if not part:
                        break
                    body.extend(part)
                    if len(body) > request.maximum_response_bytes:
                        raise AdapterUnavailable("response-byte-budget")
                if length is not None and len(body) != int(length):
                    raise AdapterUnavailable("response-truncated")
            if aborted.is_set() or self._cancellation.cancelled() or self._clock.now_ns() >= deadline_ns:
                raise AdapterUnavailable("cancelled-or-deadline")
            self._authorize_endpoint(policy)
            if authorize_disclosure is not None:
                authorize_disclosure()
            if self._clock.now_ns() >= deadline_ns:
                raise AdapterUnavailable("cancelled-or-deadline")
            return HttpResponse(response.status, bytes(body), self._timestamps.now(), retry_seconds)
        except AdapterUnavailable:
            raise
        except Exception:
            raise AdapterUnavailable("https-unavailable") from None
        finally:
            done.set()
            conn.close()
            guard.join(timeout=0.2)
