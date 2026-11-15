"""SEC fair-access guard: declared User-Agent and a process-wide request rate below 10/s.

OpenBB's SEC provider sends built-in placeholder User-Agents and only some of its paths use its
own rate limiter. `install` wraps the three HTTP clients it uses (requests, aiohttp and
urllib.request) so that every request hop to *.sec.gov, redirects included, carries
`vertex-research openbb (personal research; <VERTEX_RESEARCH_CONTACT_EMAIL>)` and waits for a slot
of a shared limiter (default 8 requests/s). A redirect to another host does not carry that
User-Agent (the library default is sent instead). Other hosts are untouched. The contact address is
never printed.
"""

from __future__ import annotations

import asyncio
import re
import threading
import time
from typing import Any
from urllib.parse import urljoin, urlsplit

CONTACT_ENV = "VERTEX_RESEARCH_CONTACT_EMAIL"
DEFAULT_RATE = 8.0
MAX_REDIRECTS = 10
_EMAIL = re.compile(r"^[^@\s<>()\"';,]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$")
_REDIRECTS = (301, 302, 303, 307, 308)


class ContactError(ValueError):
    """Missing or malformed contact address (the SEC jobs exit 2)."""


def user_agent(env: dict[str, str] | Any) -> str:
    """Build the SEC User-Agent from the environment (ContactError when missing or malformed)."""
    contact = (env.get(CONTACT_ENV) or "").strip()
    if not contact:
        raise ContactError(f"{CONTACT_ENV} is not set; the SEC jobs need a declared contact address")
    if not _EMAIL.fullmatch(contact):
        raise ContactError(f"{CONTACT_ENV} is not a plain e-mail address")
    return f"vertex-research openbb (personal research; {contact})"


def is_sec_host(url: Any) -> bool:
    if isinstance(url, (bytes, bytearray)):
        url = bytes(url).decode("latin-1")
    try:
        host = (urlsplit(str(url)).hostname or "").lower()
    except ValueError:
        return False
    return host == "sec.gov" or host.endswith(".sec.gov")


class RateLimiter:
    """Hands out request slots at most `rate` per second across threads and coroutines."""

    def __init__(self, rate: float) -> None:
        self.interval = 1.0 / rate
        self._lock = threading.Lock()
        self._next = 0.0
        self.granted = 0

    def reserve(self) -> float:
        """Reserve the next slot; return how long to wait before sending."""
        with self._lock:
            now = time.monotonic()
            slot = max(now, self._next)
            self._next = slot + self.interval
            self.granted += 1
            return slot - now

    def wait_sync(self) -> None:
        delay = self.reserve()
        if delay > 0:
            time.sleep(delay)

    async def wait_async(self) -> None:
        delay = self.reserve()
        if delay > 0:
            await asyncio.sleep(delay)


_installed: dict[str, Any] = {}


def _set_agent(headers: Any, agent: str, sec: bool) -> None:
    """SEC hop: our agent. Other hop: drop our agent if a previous hop set it."""
    if sec:
        for key in [k for k in headers if str(k).lower() == "user-agent"]:
            del headers[key]
        headers["User-Agent"] = agent
    else:
        for key in [k for k in headers if str(k).lower() == "user-agent" and headers[k] == agent]:
            del headers[key]


def install(agent: str, rate: float = DEFAULT_RATE) -> RateLimiter:
    """Patch requests, aiohttp and urllib.request for *.sec.gov (idempotent; returns the limiter)."""
    if _installed:
        _installed["state"]["agent"] = agent
        return _installed["limiter"]
    limiter = RateLimiter(rate)
    state = {"agent": agent}
    _installed.update(limiter=limiter, state=state)
    _patch_requests(limiter, state)
    _patch_aiohttp(limiter, state)
    _patch_urllib(limiter, state)
    _override_openbb_headers(agent)
    return limiter


def _patch_requests(limiter: RateLimiter, state: dict[str, str]) -> None:
    import requests

    original_send = requests.Session.send

    # Session.send runs once per hop (resolve_redirects calls it again for each redirect).
    def send(self: Any, request: Any, **kwargs: Any) -> Any:
        sec = is_sec_host(request.url)
        _set_agent(request.headers, state["agent"], sec)
        if not sec and not any(str(k).lower() == "user-agent" for k in request.headers):
            request.headers["User-Agent"] = requests.utils.default_user_agent()
        if sec:
            limiter.wait_sync()
        return original_send(self, request, **kwargs)

    requests.Session.send = send  # type: ignore[method-assign]
    _installed["requests"] = original_send


def _patch_aiohttp(limiter: RateLimiter, state: dict[str, str]) -> None:
    import aiohttp

    original = aiohttp.ClientSession._request

    async def request(self: Any, method: str, str_or_url: Any, **kwargs: Any) -> Any:
        if not is_sec_host(str_or_url):
            return await original(self, method, str_or_url, **kwargs)
        # SEC: follow redirects here so every hop gets the limiter and the right User-Agent.
        follow = kwargs.pop("allow_redirects", True)
        max_hops = kwargs.pop("max_redirects", MAX_REDIRECTS)
        url = str(str_or_url)
        headers = dict(kwargs.pop("headers", None) or {})
        for _ in range(max_hops + 1):
            sec = is_sec_host(url)
            _set_agent(headers, state["agent"], sec)
            if sec:
                await limiter.wait_async()
            response = await original(self, method, url, headers=headers, allow_redirects=False, **kwargs)
            location = response.headers.get("Location")
            if not follow or response.status not in _REDIRECTS or not location:
                return response
            response.release()
            url = urljoin(url, location)
            if response.status == 303:
                method = "GET"
                kwargs.pop("data", None)
                kwargs.pop("json", None)
        raise aiohttp.TooManyRedirects(response.request_info, response.history)

    aiohttp.ClientSession._request = request  # type: ignore[method-assign]
    _installed["aiohttp"] = original


def _patch_urllib(limiter: RateLimiter, state: dict[str, str]) -> None:
    import urllib.request

    original_urlopen = urllib.request.urlopen

    class Redirects(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req: Any, fp: Any, code: int, msg: str, headers: Any, newurl: str) -> Any:
            new = super().redirect_request(req, fp, code, msg, headers, newurl)
            if new is not None:
                if is_sec_host(newurl):
                    new.remove_header("User-agent")
                    new.add_header("User-Agent", state["agent"])
                    limiter.wait_sync()
                elif new.get_header("User-agent") == state["agent"]:
                    new.remove_header("User-agent")
            return new

    def urlopen(url: Any, data: Any = None, timeout: Any = None, **kwargs: Any) -> Any:
        target = url.full_url if isinstance(url, urllib.request.Request) else url
        if not is_sec_host(target):
            args = (url, data) if timeout is None else (url, data, timeout)
            return original_urlopen(*args, **kwargs)
        if not isinstance(url, urllib.request.Request):
            url = urllib.request.Request(url.decode("latin-1") if isinstance(url, bytes) else url)
        url.remove_header("User-agent")
        url.add_header("User-Agent", state["agent"])
        limiter.wait_sync()
        opener = urllib.request.build_opener(Redirects)
        return opener.open(url, data, timeout) if timeout is not None else opener.open(url, data)

    urllib.request.urlopen = urlopen  # type: ignore[assignment]
    _installed["urlopen"] = original_urlopen


def _override_openbb_headers(agent: str) -> None:
    """Also replace OpenBB's own SEC header dicts (belt and braces for the wrappers above)."""
    import importlib

    for name in ("openbb_sec.utils.definitions", "openbb_sec.utils.form4", "openbb_sec.utils.helpers"):
        try:
            module = importlib.import_module(name)
        except ImportError:
            continue
        for value in vars(module).values():
            if isinstance(value, dict) and "User-Agent" in value:
                value["User-Agent"] = agent


def uninstall() -> None:
    """Restore the original clients (tests)."""
    if not _installed:
        return
    import urllib.request

    import aiohttp
    import requests

    requests.Session.send = _installed["requests"]  # type: ignore[method-assign]
    aiohttp.ClientSession._request = _installed["aiohttp"]  # type: ignore[method-assign]
    urllib.request.urlopen = _installed["urlopen"]  # type: ignore[assignment]
    _installed.clear()
