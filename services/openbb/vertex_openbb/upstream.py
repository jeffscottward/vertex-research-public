"""Upstream access: OpenBB provider fetchers, OpenBB helpers and plain HTTP files.

Every upstream read of a job goes through `Upstream._call(key, factory)`. The live class runs the
call in its own daemon thread and event loop (so a blocking OpenBB helper can neither stall the job
loop nor outlive the per-call timeout); `RecordingUpstream` also keeps each result
(tests/record.py writes them as fixtures) and `ReplayUpstream` answers from those recordings, so the
tests exercise the same job code with no network. Results are plain JSON values (dates as
`YYYY-MM-DD` strings, NaN/Infinity as the strings "NaN"/"Infinity").
"""

from __future__ import annotations

import asyncio
import importlib
import json
import math
import threading
import time
from collections import defaultdict, deque
from collections.abc import Awaitable, Callable
from datetime import date, datetime
from decimal import Decimal
from typing import Any

# provider name -> (module, attribute) of the OpenBB provider object (fetcher_dict).
PROVIDERS: dict[str, tuple[str, str]] = {
    "cboe": ("openbb_cboe", "cboe_provider"),
    "cftc": ("openbb_cftc", "cftc_provider"),
    "famafrench": ("openbb_famafrench", "famafrench_provider"),
    "federal_reserve": ("openbb_federal_reserve", "federal_reserve_provider"),
    "finra": ("openbb_finra", "finra_provider"),
    "oecd": ("openbb_oecd", "oecd_provider"),
    "sec": ("openbb_sec", "sec_provider"),
    "us_treasury": ("openbb_government_us.treasury", "us_treasury_provider"),
}

CALL_TIMEOUT_S = 90.0
# Plain HTTP files (FINRA, FRED, TreasuryDirect) go out with the requests default User-Agent: FRED
# stalls the response for some custom agents (seen 2026-11-08). SEC requests get theirs from
# sec_guard.
_MISSING_STATUSES = (403, 404)
_RETRY_STATUSES = (429, 500, 502, 503, 504)
# OpenBB errors that mean "the upstream has no data for this query" (not a failure).
_EMPTY_MESSAGES = ("No Form 4 data was returned for ", "No 13F-HR filings found for ")


class UpstreamError(Exception):
    """An upstream call failed. kind: `empty` (no data), `not_found` (404) or `error`."""

    def __init__(self, kind: str, message: str) -> None:
        super().__init__(message)
        self.kind = kind
        self.message = message


def _is_empty_data_error(exc: BaseException) -> bool:
    try:
        from openbb_core.provider.utils.errors import EmptyDataError
    except ImportError:  # pragma: no cover - openbb-core is pinned
        return False
    return isinstance(exc, EmptyDataError)


def classify(exc: BaseException, scrub: tuple[str, ...] = ()) -> UpstreamError:
    """Map an exception from OpenBB, requests or aiohttp to an UpstreamError."""
    if isinstance(exc, UpstreamError):
        return exc
    if isinstance(exc, TimeoutError):
        return UpstreamError("error", f"timed out after {CALL_TIMEOUT_S:.0f} s")
    raw = str(exc)
    text = f"{type(exc).__name__}: {raw}"
    for secret in scrub:
        if secret:
            text = text.replace(secret, "<redacted>")
    text = " ".join(text.split())[:400]
    if _is_empty_data_error(exc) or (type(exc).__name__ == "OpenBBError" and raw.startswith(_EMPTY_MESSAGES)):
        return UpstreamError("empty", text)
    lowered = text.lower()
    if "http 404" in lowered or "status code 404" in lowered or "404 client error" in lowered or "not found" in lowered:
        return UpstreamError("not_found", text)
    return UpstreamError("error", text)


def jsonable(value: Any) -> Any:
    """Convert OpenBB/pandas/numpy values into plain JSON values."""
    if value is None or isinstance(value, (bool, str, int)):
        return value
    if isinstance(value, float):
        if math.isfinite(value):
            return value
        return "NaN" if math.isnan(value) else ("Infinity" if value > 0 else "-Infinity")
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, Decimal):
        return jsonable(float(value))
    if isinstance(value, dict):
        return {str(k): jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [jsonable(v) for v in value]
    if hasattr(value, "model_dump"):
        return jsonable(value.model_dump())
    if hasattr(value, "item"):  # numpy scalar
        return jsonable(value.item())
    if hasattr(value, "isoformat"):  # pandas Timestamp
        return value.isoformat()
    return str(value)


def provider_fetcher(provider: str, model: str) -> Any:
    """Return the OpenBB Fetcher class for `provider` / model name.

    Standard-model fetchers are keyed by the bare model name in some installs ("FuturesCurve") and
    with the provider prefix in others ("CboeFuturesCurve"); both are accepted.
    """
    module_name, attribute = PROVIDERS[provider]
    module = importlib.import_module(module_name)
    fetchers = getattr(module, attribute).fetcher_dict
    if model in fetchers:
        return fetchers[model]
    candidates = sorted((k for k in fetchers if k.endswith(model)), key=len)
    if not candidates:
        raise KeyError(f"{provider} has no fetcher for {model}")
    return fetchers[candidates[0]]


def canonical(params: dict[str, Any]) -> str:
    return json.dumps(jsonable(params), sort_keys=True, separators=(",", ":"))


async def in_thread(func: Callable[[], Any]) -> Any:
    """Run `func` in a daemon thread; an awaitable result is run to completion in that thread's own
    event loop. A daemon thread never delays process exit after a timeout."""
    loop = asyncio.get_running_loop()
    future: asyncio.Future[Any] = loop.create_future()

    def settle(result: Any, error: BaseException | None) -> None:
        if future.done():
            return
        if error is not None:
            future.set_exception(error)
        else:
            future.set_result(result)

    def work() -> None:
        try:
            result = func()
            if isinstance(result, Awaitable):
                result = asyncio.run(_awaited(result))
            outcome: tuple[Any, BaseException | None] = (result, None)
        except BaseException as exc:  # noqa: BLE001 - handed to the waiting coroutine
            outcome = (None, exc)
        try:
            loop.call_soon_threadsafe(settle, *outcome)
        except RuntimeError:  # the job loop is gone (deadline or exit): drop the late result
            pass

    threading.Thread(target=work, daemon=True, name="vertex-openbb-upstream").start()
    return await future


async def _awaited(awaitable: Awaitable[Any]) -> Any:
    return await awaitable


class Upstream:
    """Live upstream access (network)."""

    def __init__(self, scrub: tuple[str, ...] = (), timeout_s: float = CALL_TIMEOUT_S) -> None:
        self.scrub = scrub
        self.timeout_s = timeout_s
        self.calls = 0

    async def fetcher(self, provider: str, model: str, params: dict[str, Any]) -> list[dict[str, Any]]:
        """Run an OpenBB provider fetcher; returns its rows as plain dicts."""
        key = f"fetcher:{provider}:{model}:{canonical(params)}"

        async def run() -> Any:
            fetcher = provider_fetcher(provider, model)
            result = await fetcher.fetch_data(params, {})
            if hasattr(result, "result"):
                result = result.result
            items = result if isinstance(result, list) else [result]
            return [jsonable(item) for item in items]

        return await self._call(key, run)

    async def helper(self, key: str, func: Callable[[], Any]) -> Any:
        """Run an OpenBB helper (sync, or returning an awaitable) whose result is JSON-convertible."""

        async def run() -> Any:
            result = func()
            if isinstance(result, Awaitable):
                result = await result
            return jsonable(result)

        return await self._call(f"helper:{key}", run)

    async def http_text(self, url: str, headers: dict[str, str] | None = None) -> str | None:
        """GET a text file; None when the upstream answers 403/404 (file not published)."""

        async def run() -> Any:
            return _get_text(url, headers or {})

        return await self._call(f"http:{url}", run)

    async def _call(self, key: str, factory: Callable[[], Awaitable[Any]]) -> Any:
        self.calls += 1
        try:
            return await asyncio.wait_for(in_thread(factory), self.timeout_s)
        except UpstreamError:
            raise
        except Exception as exc:  # noqa: BLE001 - every upstream failure becomes an UpstreamError
            raise classify(exc, self.scrub) from exc


def _get_text(url: str, headers: dict[str, str]) -> str | None:
    import requests

    delay = 1.0
    for attempt in range(2):
        try:
            response = requests.get(url, headers=headers or None, timeout=(10, 45))
        except requests.ConnectionError:
            if attempt == 1:
                raise
            time.sleep(delay)
            continue
        if response.status_code in _MISSING_STATUSES:
            return None
        if response.status_code in _RETRY_STATUSES and attempt == 0:
            time.sleep(delay)
            continue
        response.raise_for_status()
        return response.content.decode("utf-8-sig", errors="replace")
    return None


class RecordingUpstream(Upstream):
    """Live access that also keeps every call and its outcome (for fixtures)."""

    def __init__(self, scrub: tuple[str, ...] = ()) -> None:
        super().__init__(scrub)
        self.records: list[dict[str, Any]] = []

    async def _call(self, key: str, factory: Callable[[], Awaitable[Any]]) -> Any:
        try:
            result = await super()._call(key, factory)
        except UpstreamError as exc:
            self.records.append({"key": key, "error": {"kind": exc.kind, "message": exc.message}})
            raise
        self.records.append({"key": key, "result": result})
        return result


class ReplayUpstream(Upstream):
    """Answers calls from recordings; an unrecorded call is an error (no network).

    `delay_s` makes every call take that long (tests of the job deadline).
    """

    def __init__(self, records: list[dict[str, Any]], delay_s: float = 0.0) -> None:
        super().__init__()
        self.delay_s = delay_s
        self.pending: dict[str, deque[dict[str, Any]]] = defaultdict(deque)
        for record in records:
            self.pending[record["key"]].append(record)

    async def _call(self, key: str, factory: Callable[[], Awaitable[Any]]) -> Any:
        self.calls += 1
        if self.delay_s:
            await asyncio.sleep(self.delay_s)
        queue = self.pending.get(key)
        if not queue:
            raise LookupError(f"unrecorded upstream call: {key}")
        record = queue.popleft() if len(queue) > 1 else queue[0]
        if "error" in record:
            raise UpstreamError(record["error"]["kind"], record["error"]["message"])
        return json.loads(json.dumps(record["result"]))
