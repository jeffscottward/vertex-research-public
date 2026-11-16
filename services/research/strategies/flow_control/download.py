"""Pure core of the net drift history download: request bodies, plan, checks and pacing (research only).

The network call is an argument (`post`), so tests use no network. The API key never enters this module and no
log line holds the key, a header or a body.
"""
from __future__ import annotations

import copy
import json
from collections.abc import Callable, Mapping, Sequence
from datetime import date, timedelta
from pathlib import Path

from strategies.imom.data import is_closed

from .data import PARTS, TICKERS, DataError, bucket_path, parse_part

BASE_URL = "https://api.quantdata.us"
ENDPOINT = "/v1/options/tool/net-drift"
KEY_ENV = "QUANTDATA_API_KEY"
FILTER_PROFILE = "otm-clean.v1"
FIRST_DAY = "2025-01-02"
REQUEST_INTERVAL_SECONDS = 3.75
COOLDOWN_SECONDS = 60
MAX_RETRIES = 5
REQUEST_TIMEOUT_SECONDS = 30
ERROR_WAIT_SECONDS = 15
EMPTY_STOP = 10

_FILTERS = [
    {"field": "isComplex", "operation": "=", "value": False},
    {"field": "isFloor", "operation": "=", "value": False},
    {"field": "isTied", "operation": "=", "value": False},
    {"field": "isCancelled", "operation": "=", "value": False},
]
# The two POST bodies of the golden fixture header `netDriftRequests` (placeholders "YYYY-MM-DD" and "T").
NET_DRIFT_REQUESTS: dict[str, dict] = {
    "total": {"sessionDate": "YYYY-MM-DD", "aggregationPeriod": "1m",
              "filter": {"tickers": ["T"], "moneyTypes": ["OTM"]},
              "filterExpression": {"conjunction": "AND", "filters": _FILTERS}},
    "zero_dte": {"sessionDate": "YYYY-MM-DD", "aggregationPeriod": "1m",
                 "filter": {"tickers": ["T"], "moneyTypes": ["OTM"]},
                 "filterExpression": {"conjunction": "AND",
                                      "filters": [*_FILTERS, {"field": "dte", "operation": "<", "value": 1}]}},
}

Post = Callable[[dict], tuple[int, object, Mapping[str, str]]]


class AuthError(Exception):
    pass


def request_body(part: str, day: str, ticker: str) -> dict:
    body = copy.deepcopy(NET_DRIFT_REQUESTS[part])
    body["sessionDate"] = day
    body["filter"]["tickers"] = [ticker]
    return body


def _status(path: Path) -> str:
    if not path.exists():
        return "pending"
    try:
        buckets = parse_part(path.read_text())
    except DataError:
        return "pending"
    return "data" if buckets else "empty"


def trading_days(first_day: str, last_day: str) -> list[str]:
    day, end, out = date.fromisoformat(first_day), date.fromisoformat(last_day), []
    while day <= end:
        if day.weekday() < 5 and not is_closed(day):
            out.append(day.isoformat())
        day += timedelta(days=1)
    return out


def plan(root: Path, last_day: str, first_day: str = FIRST_DAY) -> list[tuple[str, str, str, str]]:
    """(ticker, part, day, status) per ticker, part and trading day, newest day first."""
    out = []
    for day in reversed(trading_days(first_day, last_day)):
        for ticker in TICKERS:
            for part in PARTS:
                out.append((ticker, part, day, _status(bucket_path(root, ticker, part, day))))
    return out


def outside_repository(path: Path, repo: Path) -> Path:
    resolved, top = Path(path).expanduser().resolve(), Path(repo).resolve()
    if resolved == top or top in resolved.parents:
        raise SystemExit(f"refusing a folder inside the repository: {resolved}")
    return resolved


def _write(path: Path, data: Mapping) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(data, separators=(",", ":")))
    tmp.replace(path)


def _retry_after(headers: Mapping[str, str]) -> float:
    for key, value in (headers or {}).items():
        if key.lower() == "retry-after":
            try:
                return max(0.0, float(value))
            except (TypeError, ValueError):
                return COOLDOWN_SECONDS
    return COOLDOWN_SECONDS


def fetch_all(items: Sequence[tuple[str, str, str, str]], root: Path, post: Post, sleep: Callable[[float], None],
              log: Callable[[str], None]) -> dict:
    counts = {"written": 0, "empty": 0, "failed": 0, "dropped": 0, "pending": 0, "stopped": False}
    empty_run: dict[tuple[str, str], int] = {}
    ended: set[tuple[str, str]] = set()
    started = False
    for index, (ticker, part, day, status) in enumerate(items):
        pair = (ticker, part)
        if pair in ended:
            counts["dropped"] += 1
            continue
        if status == "data":
            empty_run[pair] = 0
            continue
        if status == "empty":
            empty_run[pair] = empty_run.get(pair, 0) + 1
            if empty_run[pair] >= EMPTY_STOP:
                ended.add(pair)
            continue
        path = bucket_path(root, ticker, part, day)
        attempts = 0
        while True:
            if started:
                sleep(REQUEST_INTERVAL_SECONDS)
            started = True
            code, body, headers = post(request_body(part, day, ticker))
            if code == 200:
                data = body.get("data") if isinstance(body, dict) else None
                try:
                    buckets = parse_part(json.dumps(data)) if isinstance(data, dict) else None
                except DataError:
                    buckets = None
                if buckets is None:
                    counts["failed"] += 1
                    log(f"{ticker} {part} {day}: invalid body")
                elif buckets:
                    _write(path, data)
                    counts["written"] += 1
                    empty_run[pair] = 0
                else:
                    _write(path, {})
                    counts["empty"] += 1
                    empty_run[pair] = empty_run.get(pair, 0) + 1
                    if empty_run[pair] >= EMPTY_STOP:
                        ended.add(pair)
                        log(f"{ticker} {part}: {EMPTY_STOP} empty sessions in a row; older days dropped")
                break
            if code in (401, 403):
                raise AuthError(f"status {code}")
            if code == 429:
                attempts += 1
                if attempts > MAX_RETRIES:
                    counts["stopped"] = True
                    counts["pending"] = len(items) - index
                    log(f"{ticker} {part} {day}: rate limited {MAX_RETRIES} times; run stopped")
                    return counts
                wait = _retry_after(headers)
                log(f"{ticker} {part} {day}: status 429, waiting {wait:.0f} s")
                sleep(wait)
                continue
            if code == 0 or 500 <= code < 600:
                attempts += 1
                if attempts > MAX_RETRIES:
                    counts["failed"] += 1
                    log(f"{ticker} {part} {day}: status {code} after {MAX_RETRIES} retries")
                    break
                log(f"{ticker} {part} {day}: status {code}, waiting {ERROR_WAIT_SECONDS} s")
                sleep(ERROR_WAIT_SECONDS)
                continue
            counts["failed"] += 1
            log(f"{ticker} {part} {day}: status {code}")
            break
    return counts
