"""Daily option-chain snapshot of the Core 7 ETF twins (research only, no orders).

Captures up to three standard monthly expiries per ETF (next two monthly expiries >= 21 DTE,
covering DTE_RANGE 30-75 for model calibration and spread studies, plus the nearest LEAPS expiry
>= 365 DTE). One run writes <store>/<New York day>/<HHMMSS>Z/ with coherent Yahoo CSVs and
summary.json (measuring DTE_RANGE monthlies only so calibrate.py and golive stay unchanged), and
when VERTEX_ORIGIN (or VERTEX_API_URL) and VERTEX_AGENT_API_KEY are set, overlays live IBKR
quotes from optionsChain.chain (Yahoo fills every gap) and posts each (snapshotAt, underlying,
expiry) chain to optionsChain.ingestSnapshot in Postgres.

Implied volatility: computed from quote mids (Black-76 on the put-call parity forward) whenever
usable quotes exist; Yahoo's impliedVolatility column is only used as a per-strike fallback when
parity IV is unavailable and the vendor value is finite and above MIN_PROVIDER_IV.

A live run measures only while the US option market trades: New York time inside SESSION on a
weekday, and SPY with an option trade in the last MAX_TRADE_AGE_MIN minutes (covers holidays and
half days). Otherwise it writes nothing and exits 0 ("skipped"). Exit 1: Yahoo failed for SPY
(nothing written), or a symbol/expiry/ingest step failed (the rest is written, complete: false).

  uv run --no-project --python 3.12 --with yfinance==0.2.66 --exclude-newer 2026-11-11T00:00:00Z \
      python research/backtests/option-chain/snapshot.py --store ~/.local/share/vertex/option-chain

--backfill walks stored <store>/<day>/<HHMMSS>Z/ folders chronologically and upserts every stored
chain into Postgres via optionsChain.ingestSnapshot (use --dry-run to validate without posting).
--remeasure <run directory> computes summary.json again from its stored CSV files.
"""
from __future__ import annotations

import argparse
import csv
import ipaddress
import json
import math
import os
import re
import statistics
import sys
import time as clock
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable, Mapping
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from zoneinfo import ZoneInfo

SCHEMA = 2  # 2: implied volatility from the mids on the parity forward (1 used the Yahoo column)
SYMBOLS = ("SPY", "QQQ", "DIA", "IWM", "GLD", "SLV", "USO")
PROBE = "SPY"
DTE_RANGE = (30, 75)  # calibration and go-live monthly window (read by services/research/golive/generator.py)
NEAR_DTE_RANGE = (21, 150)  # next two liquid monthly expiries for spread entry and management
NEAR_MONTHLY_COUNT = 2
LEAPS_MIN_DTE = 365  # owner LEAPS threshold (2026-10-22)
FAR_FALLBACK_MIN_DTE = 180  # fallback long-dated expiry when an ETF has no >=365d listing yet
SESSION = (time(9, 45), time(16, 0))  # New York; Yahoo delays quotes by up to 15 minutes
MAX_TRADE_AGE_MIN = 45
NEW_YORK = ZoneInfo("America/New_York")
ATTEMPTS = 3
PARITY_STRIKES = 5  # the forward comes from the nearest strikes that have a call and a put quote
PARITY_WINDOW = 0.06  # and that are within 6% of spot (three $1 strikes at a $33 spot)
RATE = 0.04  # for the discount factor only: one point of rate moves a 75-day price by 0.2%
ATM_TOLERANCE = 0.02  # the nearest quoted strike must be within 2% of spot
VOL_BOUNDS = (0.005, 5.0)
MIN_PROVIDER_IV = 0.001
MAX_IV = 100.0
MAX_INT32 = 2_147_483_647
MAX_INGEST_QUOTES = 4000

API_KEY_ENV = "VERTEX_AGENT_API_KEY"
API_URL_ENVS = ("VERTEX_API_URL", "VERTEX_ORIGIN")
API_PROCEDURES = ("chain", "expiries", "ingestSnapshot", "snapshot")
MAX_RESPONSE_BYTES = 8_000_000
HTTP_TIMEOUT_S = 20.0
QUOTE_SOURCES = frozenset({"ibkr", "yahoo", "quantdata"})
_CSV_NAME_RE = re.compile(r"^(.+)-(\d{4}-\d{2}-\d{2})-(calls|puts)\.csv$")


class _NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Refuse all redirects so urllib never forwards x-api-key to another location."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise urllib.error.HTTPError(req.full_url, code, f"redirect refused ({msg})", headers, fp)


_NO_REDIRECT_OPENER = urllib.request.build_opener(_NoRedirectHandler())


def _is_loopback(hostname: str) -> bool:
    if hostname == "localhost":
        return True
    try:
        return ipaddress.ip_address(hostname).is_loopback
    except ValueError:
        return False


def _origin(base_url: str) -> str:
    parsed = urllib.parse.urlsplit(base_url)
    if not parsed.scheme or not parsed.netloc or not parsed.hostname:
        raise ValueError(f"invalid Vertex API URL: {base_url!r}")
    if parsed.scheme == "http" and not _is_loopback(parsed.hostname):
        raise ValueError("plain http is allowed only for loopback hosts; use https")
    if parsed.scheme not in ("http", "https"):
        raise ValueError(f"unsupported URL scheme: {parsed.scheme!r}")
    return f"{parsed.scheme}://{parsed.netloc}"


class OptionChainApiError(RuntimeError):
    """A failed oRPC call to optionsChain.* without exposing the API key."""

    def __init__(self, procedure: str, status: int, code: str, message: str = "") -> None:
        super().__init__(f"optionsChain.{procedure} failed: {status} {code} {message}".strip())
        self.procedure, self.status, self.code = procedure, status, code


def _error_detail(error: urllib.error.HTTPError) -> tuple[str, str]:
    code, message = "HTTP_ERROR", ""
    try:
        body = json.loads(error.read(MAX_RESPONSE_BYTES) or b"{}")
        detail = body.get("json", body) if isinstance(body, dict) else {}
        if isinstance(detail, dict):
            code = str(detail.get("code") or code)[:64]
            message = str(detail.get("message") or "")[:300]
    except (ValueError, OSError):
        pass
    return code, message


class VertexOptionChainClient:
    """Stdlib-only HTTP client for optionsChain.{chain,ingestSnapshot} over /api/orpc."""

    def __init__(self, base_url: str, api_key: str, *,
                 opener: Callable[..., Any] = _NO_REDIRECT_OPENER.open,
                 timeout_s: float = HTTP_TIMEOUT_S) -> None:
        if not api_key:
            raise ValueError(f"{API_KEY_ENV} is empty")
        self._origin = _origin(base_url)
        self._base = base_url.rstrip("/")
        self._key = api_key
        self._open = opener
        self._timeout = timeout_s

    def __repr__(self) -> str:
        return f"VertexOptionChainClient({self._base!r})"

    @classmethod
    def from_env(cls, environ: Mapping[str, str] = os.environ, **kwargs: Any) -> VertexOptionChainClient | None:
        base = next((environ[name].strip() for name in API_URL_ENVS if environ.get(name, "").strip()), "")
        key = environ.get(API_KEY_ENV, "").strip()
        if not base or not key:
            return None
        return cls(base, key, **kwargs)

    def _safe(self, text: str) -> str:
        return text.replace(self._key, "<hidden>")

    def _fail(self, procedure: str, status: int, code: str, message: str = "") -> OptionChainApiError:
        return OptionChainApiError(procedure, status, self._safe(code), self._safe(message))

    def _call(self, procedure: str, payload: Mapping[str, Any]) -> Any:
        if procedure not in API_PROCEDURES:
            raise ValueError(f"optionsChain.{procedure} is not a procedure of this client")
        request = urllib.request.Request(
            f"{self._base}/api/orpc/optionsChain/{procedure}",
            data=json.dumps({"json": payload}).encode(),
            headers={
                "content-type": "application/json",
                "origin": self._origin,
                "x-api-key": self._key,
            },
            method="POST",
        )
        try:
            with self._open(request, timeout=self._timeout) as response:
                raw = response.read(MAX_RESPONSE_BYTES + 1)
        except urllib.error.HTTPError as error:
            if 300 <= error.code < 400:
                raise self._fail(procedure, error.code, "REDIRECT",
                                 f"redirects are refused; set {API_URL_ENVS[0]} to the final URL") from None
            raise self._fail(procedure, error.code, *_error_detail(error)) from None
        except (urllib.error.URLError, TimeoutError, OSError) as error:
            raise self._fail(procedure, 0, "UNREACHABLE", type(error).__name__) from None
        if len(raw) > MAX_RESPONSE_BYTES:
            raise self._fail(procedure, 0, "BAD_RESPONSE", "the answer is too large")
        try:
            body = json.loads(raw or b"{}")
        except ValueError:
            raise self._fail(procedure, 0, "BAD_RESPONSE", "the answer is not JSON") from None
        return body.get("json") if isinstance(body, dict) else None

    def chain(self, symbol: str, expiry: str) -> dict[str, Any]:
        answer = self._call("chain", {"symbol": symbol, "expiry": expiry})
        if not isinstance(answer, dict) or not isinstance(answer.get("rows"), list):
            raise self._fail("chain", 0, "BAD_RESPONSE", "the answer has no rows list")
        return answer

    def ingest_snapshot(self, payload: Mapping[str, Any]) -> dict[str, Any]:
        answer = self._call("ingestSnapshot", payload)
        if not isinstance(answer, dict) or not isinstance(answer.get("snapshotId"), str):
            raise self._fail("ingestSnapshot", 0, "BAD_RESPONSE", "the answer has no snapshotId")
        return answer


def standard_monthly_expiries(expiries) -> list[date]:
    """All standard monthly expiries: third Friday, or the Thursday before it when Friday is a holiday."""
    listed = {date.fromisoformat(value) for value in expiries}
    out = []
    for day in sorted(listed):
        friday = day if day.weekday() == 4 else day + timedelta(days=1)
        monthly = friday.weekday() == 4 and 15 <= friday.day <= 21 and (day == friday or friday not in listed)
        if monthly:
            out.append(day)
    return out


def monthly_expiries(expiries, today: date) -> list[str]:
    """The standard monthly expiries inside DTE_RANGE: the third Friday, or the Thursday before it when
    the exchange is closed on that Friday (then the Friday is not listed)."""
    return [
        day.isoformat()
        for day in standard_monthly_expiries(expiries)
        if DTE_RANGE[0] <= (day - today).days <= DTE_RANGE[1]
    ]


def target_expiries(expiries, today: date) -> list[str]:
    """Up to 3 standard monthly expiries: next 2 monthlies in NEAR_DTE_RANGE (unioned with DTE_RANGE)
    plus the nearest LEAPS expiry >= LEAPS_MIN_DTE (fallback: furthest monthly >= FAR_FALLBACK_MIN_DTE)."""
    monthlies = standard_monthly_expiries(expiries)
    near = [day for day in monthlies if NEAR_DTE_RANGE[0] <= (day - today).days <= NEAR_DTE_RANGE[1]][:NEAR_MONTHLY_COUNT]
    cal = [day for day in monthlies if DTE_RANGE[0] <= (day - today).days <= DTE_RANGE[1]]
    chosen = set(near) | set(cal)
    leaps = [day for day in monthlies if (day - today).days >= LEAPS_MIN_DTE]
    if leaps:
        chosen.add(leaps[0])
    else:
        far = [day for day in monthlies if (day - today).days >= FAR_FALLBACK_MIN_DTE]
        if far:
            chosen.add(far[-1])
    return [day.isoformat() for day in sorted(chosen)]


def usable(row) -> bool:
    return row.bid > 0 and row.ask > row.bid


def mid_of(row) -> float:
    return (row.bid + row.ask) / 2


def nearest(rows, target: float):
    return min(rows, key=lambda row: abs(row.strike - target)) if rows else None


def half_spread_pct(row) -> float:
    return 100 * (row.ask - row.bid) / 2 / mid_of(row)


def norm_cdf(x: float) -> float:
    return 0.5 * math.erfc(-x / math.sqrt(2))


def black(forward: float, strike: float, t: float, vol: float, call: bool) -> float:
    """Black-76 price without discounting."""
    deviation = vol * math.sqrt(t)
    d1 = math.log(forward / strike) / deviation + deviation / 2
    d2 = d1 - deviation
    if call:
        return forward * norm_cdf(d1) - strike * norm_cdf(d2)
    return strike * norm_cdf(-d2) - forward * norm_cdf(-d1)


def implied_vol(price: float, forward: float, strike: float, t: float, call: bool) -> float | None:
    """Black-76 volatility of a price without discounting, by bisection; None outside VOL_BOUNDS."""
    low, high = VOL_BOUNDS
    if not black(forward, strike, t, low, call) < price < black(forward, strike, t, high, call):
        return None
    for _ in range(60):
        middle = (low + high) / 2
        if black(forward, strike, t, middle, call) < price:
            low = middle
        else:
            high = middle
    return (low + high) / 2


def parity_forward(calls, puts, spot: float, discount: float) -> float | None:
    """Forward of one expiry from put-call parity, F = K + (C - P) / DF: the median over the PARITY_STRIKES
    strikes nearest to spot that have a call and a put quote and are within PARITY_WINDOW of spot. None
    without three such strikes."""
    put_mid = {row.strike: mid_of(row) for row in puts}
    pairs = sorted((abs(row.strike / spot - 1), row.strike + (mid_of(row) - put_mid[row.strike]) / discount)
                   for row in calls if row.strike in put_mid)
    forwards = [forward for distance, forward in pairs[:PARITY_STRIKES] if distance <= PARITY_WINDOW]
    return statistics.median(forwards) if len(forwards) >= 3 else None


def slope(vols: dict[float, float], spot: float, atm_iv: float, t: float, low: float, high: float) -> float | None:
    """Least-squares slope through (0, 1) of IV / ATM IV against x = ln(K/S) / (ATM IV * sqrt(t)), for the
    strikes with low <= x <= high. `vols` is strike -> IV."""
    points = [(math.log(strike / spot) / (atm_iv * math.sqrt(t)), vol / atm_iv) for strike, vol in vols.items()]
    points = [(x, y) for x, y in points if low <= x <= high and x != 0]
    if len(points) < 3:
        return None
    return sum(x * (y - 1) for x, y in points) / sum(x * x for x, _ in points)


def _parity_iv_maps(call_rows, put_rows, spot: float | None, expiry: str,
                    today: date) -> tuple[dict[float, float], dict[float, float]]:
    if spot is None or not (math.isfinite(spot) and spot > 0):
        return {}, {}
    days = (date.fromisoformat(expiry) - today).days
    if days <= 0:
        return {}, {}
    calls = [row for row in call_rows if usable(row)]
    puts = [row for row in put_rows if usable(row)]
    t = days / 365
    discount = math.exp(-RATE * t)
    forward = parity_forward(calls, puts, spot, discount)
    if forward is None:
        return {}, {}
    call_iv: dict[float, float] = {}
    for row in calls:
        iv = implied_vol(mid_of(row) / discount, forward, row.strike, t, call=True)
        if iv is not None:
            call_iv[row.strike] = iv
    put_iv: dict[float, float] = {}
    for row in puts:
        iv = implied_vol(mid_of(row) / discount, forward, row.strike, t, call=False)
        if iv is not None:
            put_iv[row.strike] = iv
    return call_iv, put_iv


def measure(call_rows, put_rows, spot: float, expiry: str, today: date) -> dict | None:
    """Half-spread of four reference legs and the two wing slopes of one expiry; None without usable quotes."""
    days = (date.fromisoformat(expiry) - today).days
    calls = [row for row in call_rows if usable(row)]
    puts = [row for row in put_rows if usable(row)]
    if days <= 0 or not spot > 0:
        return None
    t = days / 365
    discount = math.exp(-RATE * t)
    forward = parity_forward(calls, puts, spot, discount)
    if forward is None:
        return None
    call_iv = {row.strike: implied_vol(mid_of(row) / discount, forward, row.strike, t, call=True) for row in calls}
    put_iv = {row.strike: implied_vol(mid_of(row) / discount, forward, row.strike, t, call=False) for row in puts}
    calls = [row for row in calls if call_iv[row.strike] is not None]
    puts = [row for row in puts if put_iv[row.strike] is not None]
    atm_call, atm_put = nearest(calls, spot), nearest(puts, spot)
    if atm_call is None or atm_put is None or max(abs(row.strike / spot - 1) for row in (atm_call, atm_put)) > ATM_TOLERANCE:
        return None
    atm_iv = (call_iv[atm_call.strike] + put_iv[atm_put.strike]) / 2
    sigma = spot * atm_iv * math.sqrt(t)
    otm_call = nearest([row for row in calls if row.strike > spot], spot + sigma)
    put_25 = nearest([row for row in puts if row.strike < spot], spot - 0.67 * sigma)  # about 25 delta
    put_far = nearest([row for row in puts if row.strike < spot], spot - 1.17 * sigma)  # half a sigma further out
    legs = {"atmCall": atm_call, "oneSigmaCall": otm_call, "put25Delta": put_25, "putFurtherOut": put_far}

    def per_leg(value) -> dict:
        return {name: (value(row) if row is not None else None) for name, row in legs.items()}

    return {
        "expiry": expiry, "dte": days, "spot": spot, "forward": forward, "atmIv": atm_iv,
        "strike": per_leg(lambda row: row.strike), "halfSpreadPct": per_leg(half_spread_pct), "mid": per_leg(mid_of),
        "ivRatioOneSigmaCall": call_iv[otm_call.strike] / atm_iv if otm_call is not None else None,
        "callSlope": slope({row.strike: call_iv[row.strike] for row in calls}, spot, atm_iv, t, 0.0, 1.5),
        "putSlope": slope({row.strike: put_iv[row.strike] for row in puts}, spot, atm_iv, t, -1.5, 0.0),
        "usableQuotes": {"calls": len(calls), "puts": len(puts)},
    }


def _finite_nonneg(value: Any, *, max_val: float | None = None) -> float | None:
    if value is None or value == "":
        return None
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(parsed) or parsed < 0:
        return None
    if max_val is not None and parsed > max_val:
        return None
    return parsed


def _finite_pos(value: Any) -> float | None:
    parsed = _finite_nonneg(value)
    return parsed if parsed is not None and parsed > 0 else None


def _nonneg_int32(value: Any) -> int | None:
    parsed = _finite_nonneg(value)
    if parsed is None:
        return None
    rounded = int(round(parsed))
    return rounded if 0 <= rounded <= MAX_INT32 else None


def _provider_iv(value: Any) -> float | None:
    parsed = _finite_nonneg(value, max_val=MAX_IV)
    if parsed is None or parsed < MIN_PROVIDER_IV:
        return None
    return parsed


def quote_source_of(contract: Mapping[str, Any], *, filled_by_yahoo: bool = False) -> str:
    """Deterministic quote provenance mapping into {'ibkr', 'yahoo', 'quantdata', 'mixed'}."""
    sources = contract.get("sources") if isinstance(contract.get("sources"), Mapping) else {}
    providers = {
        str(sources.get(field))
        for field in ("quote", "iv", "openInterest")
        if sources.get(field) in QUOTE_SOURCES
    }
    if filled_by_yahoo:
        providers.add("yahoo")
    if not providers:
        return "yahoo"
    if len(providers) == 1:
        return next(iter(providers))
    return "mixed"


def build_yahoo_quotes(call_rows, put_rows, spot: float | None, expiry: str, today: date) -> list[dict[str, Any]]:
    """Normalize Yahoo call/put rows into ingestSnapshot quotes with parity IV + vendor fallback."""
    calls_list = list(call_rows)
    puts_list = list(put_rows)
    call_iv, put_iv = _parity_iv_maps(calls_list, puts_list, spot, expiry, today)
    by_key: dict[tuple[float, str], dict[str, Any]] = {}
    for right, side_rows, parity_map in (("call", calls_list, call_iv), ("put", puts_list, put_iv)):
        for row in side_rows:
            strike = _finite_pos(getattr(row, "strike", None))
            if strike is None:
                continue
            bid = _finite_nonneg(getattr(row, "bid", None))
            ask = _finite_nonneg(getattr(row, "ask", None))
            last_raw = getattr(row, "lastPrice", getattr(row, "last", None))
            last = _finite_nonneg(last_raw)
            volume = _nonneg_int32(getattr(row, "volume", None))
            open_interest = _nonneg_int32(getattr(row, "openInterest", None))
            iv = parity_map.get(strike)
            if iv is None:
                iv = _provider_iv(getattr(row, "impliedVolatility", getattr(row, "iv", None)))
            quote = {
                "strike": strike,
                "right": right,
                "bid": bid,
                "ask": ask,
                "last": last,
                "volume": volume,
                "openInterest": open_interest,
                "iv": iv,
                "source": "yahoo",
            }
            key = (strike, right)
            prev = by_key.get(key)
            if prev is None or (bid is not None and ask is not None and ask > bid):
                by_key[key] = quote
    return [by_key[key] for key in sorted(by_key)][:MAX_INGEST_QUOTES]


def overlay_ibkr_chain(
    yahoo_quotes: list[dict[str, Any]],
    api_chain: Mapping[str, Any] | None,
    yahoo_spot: float | None,
    expiry: str,
    today: date,
) -> tuple[list[dict[str, Any]], float | None, str]:
    """Overlay IBKR live quotes (and Quant Data analytics) from optionsChain.chain onto Yahoo base quotes."""
    by_key: dict[tuple[float, str], dict[str, Any]] = {
        (q["strike"], q["right"]): dict(q) for q in yahoo_quotes
    }
    spot = _finite_pos(yahoo_spot)
    if api_chain is not None:
        api_spot = _finite_pos(api_chain.get("spot"))
        if spot is None and api_spot is not None:
            spot = api_spot
        rows = api_chain.get("rows") if isinstance(api_chain.get("rows"), list) else []
        # Compute parity IV over API quotes as fallback when contract.iv is absent.
        api_calls, api_puts = [], []
        for entry in rows:
            if not isinstance(entry, Mapping):
                continue
            strike = _finite_pos(entry.get("strike"))
            if strike is None:
                continue
            for side_name, bucket in (("call", api_calls), ("put", api_puts)):
                contract = entry.get(side_name)
                if isinstance(contract, Mapping):
                    bid = _finite_nonneg(contract.get("bid"))
                    ask = _finite_nonneg(contract.get("ask"))
                    if bid is not None and ask is not None:
                        bucket.append(SimpleNamespace(strike=strike, bid=bid, ask=ask))
        api_call_iv, api_put_iv = _parity_iv_maps(api_calls, api_puts, spot, expiry, today)
        for entry in rows:
            if not isinstance(entry, Mapping):
                continue
            strike = _finite_pos(entry.get("strike"))
            if strike is None:
                continue
            for right, parity_map in (("call", api_call_iv), ("put", api_put_iv)):
                contract = entry.get(right)
                if not isinstance(contract, Mapping):
                    continue
                key = (strike, right)
                existing = by_key.get(key)
                sources = contract.get("sources") if isinstance(contract.get("sources"), Mapping) else {}
                quote_src = sources.get("quote")
                if quote_src == "ibkr" or existing is None:
                    bid = _finite_nonneg(contract.get("bid"))
                    ask = _finite_nonneg(contract.get("ask"))
                    last = _finite_nonneg(contract.get("last"))
                    volume = _nonneg_int32(contract.get("volume"))
                    open_interest = _nonneg_int32(contract.get("openInterest"))
                    iv = _provider_iv(contract.get("iv"))
                    if iv is None:
                        iv = parity_map.get(strike)
                    filled_by_yahoo = False
                    if existing is not None:
                        if last is None and existing["last"] is not None:
                            last, filled_by_yahoo = existing["last"], True
                        if volume is None and existing["volume"] is not None:
                            volume, filled_by_yahoo = existing["volume"], True
                        if open_interest is None and existing["openInterest"] is not None:
                            open_interest, filled_by_yahoo = existing["openInterest"], True
                        if iv is None and existing["iv"] is not None:
                            iv, filled_by_yahoo = existing["iv"], True
                    by_key[key] = {
                        "strike": strike,
                        "right": right,
                        "bid": bid,
                        "ask": ask,
                        "last": last,
                        "volume": volume,
                        "openInterest": open_interest,
                        "iv": iv,
                        "source": quote_source_of(contract, filled_by_yahoo=filled_by_yahoo),
                    }
                else:
                    # Enrich missing Yahoo fields (e.g. Quant Data IV or OI) without replacing Yahoo bid/ask.
                    enriched_non_yahoo = False
                    if existing["iv"] is None:
                        api_iv = _provider_iv(contract.get("iv"))
                        if api_iv is not None:
                            existing["iv"] = api_iv
                            if sources.get("iv") in ("ibkr", "quantdata"):
                                enriched_non_yahoo = True
                    if existing["openInterest"] is None:
                        api_oi = _nonneg_int32(contract.get("openInterest"))
                        if api_oi is not None:
                            existing["openInterest"] = api_oi
                            if sources.get("openInterest") in ("ibkr", "quantdata"):
                                enriched_non_yahoo = True
                    if enriched_non_yahoo:
                        existing["source"] = "mixed"

    merged = [by_key[key] for key in sorted(by_key)][:MAX_INGEST_QUOTES]
    used_sources = sorted({q["source"] for q in merged if q["source"] != "mixed"})
    if any(q["source"] == "mixed" for q in merged):
        if api_chain is not None:
            api_statuses = {
                s.get("source"): s.get("status")
                for s in (api_chain.get("sources") or [])
                if isinstance(s, Mapping)
            }
            for provider in ("ibkr", "quantdata", "yahoo"):
                if api_statuses.get(provider) == "used" and provider not in used_sources:
                    used_sources.append(provider)
            used_sources = sorted(set(used_sources))
        if not used_sources:
            used_sources = ["mixed"]
    header_source = "+".join(used_sources) if used_sources else "yahoo"
    return merged, spot, header_source[:64]


def last_trade(frames) -> datetime | None:
    """Latest option trade time (UTC) in the chain frames; None when there is none."""
    stamps = [stamp for frame in frames for stamp in frame["lastTradeDate"].dropna().tolist()]
    if not stamps:
        return None
    latest = max(stamps)
    latest = latest.to_pydatetime() if hasattr(latest, "to_pydatetime") else latest
    return latest if latest.tzinfo else latest.replace(tzinfo=timezone.utc)


def in_session(now: datetime) -> bool:
    local = now.astimezone(NEW_YORK)
    return local.weekday() < 5 and SESSION[0] <= local.time() < SESSION[1]


def retry(call):
    for attempt in range(ATTEMPTS):
        try:
            return call()
        except Exception as error:  # noqa: BLE001 - yfinance / HTTP raises many types on throttled or empty replies
            if (
                isinstance(error, OptionChainApiError)
                and 400 <= error.status < 500
                and error.status not in (408, 429)
            ):
                raise
            if attempt == ATTEMPTS - 1:
                raise
            clock.sleep(5 * (attempt + 1))


def fetch_chains(ticker, today: date) -> tuple[list[tuple[str, Any]], dict[str, str]]:
    """Fetch target expiries individually so one failed/empty far expiry does not discard the rest.
    Raises when no expiry is listed or every calibration monthly fails."""
    def list_expiries() -> list[str]:
        expiries = target_expiries(ticker.options, today)
        if not expiries:
            raise RuntimeError("Yahoo listed no monthly expiry")
        return expiries

    expiries = retry(list_expiries)
    cal_set = set(monthly_expiries(expiries, today))
    chains: list[tuple[str, Any]] = []
    errors: dict[str, str] = {}
    first_error: Exception | None = None
    for expiry in expiries:
        def fetch_one(exp: str = expiry):
            chain = ticker.option_chain(exp)
            if chain.calls is None or chain.puts is None or len(chain.calls) == 0 or len(chain.puts) == 0:
                raise RuntimeError(f"Yahoo sent an empty chain for {exp}")
            return chain

        try:
            chains.append((expiry, retry(fetch_one)))
        except Exception as err:  # noqa: BLE001
            errors[expiry] = f"{type(err).__name__}: {err}"
            if first_error is None:
                first_error = err
    if not chains and first_error is not None:
        raise first_error
    if cal_set and not any(expiry in cal_set for expiry, _ in chains) and first_error is not None:
        raise first_error
    return chains, errors


def chains_of(ticker, today: date) -> list:
    """(expiry, chain) of the target expiries (up to 3: 2 near monthlies + LEAPS)."""
    chains, _ = fetch_chains(ticker, today)
    return chains


def write_summary(out: Path, summary: dict) -> None:
    partial = out / "summary.json.part"  # calibrate.py reads summary.json only, so a killed run leaves no half file
    partial.write_text(json.dumps(summary, indent=1))
    partial.replace(out / "summary.json")


def collect(
    ticker_for,
    now: datetime,
    store: Path,
    source: str,
    log=print,
    *,
    api_client: VertexOptionChainClient | None = None,
    use_ibkr: bool = True,
) -> int:
    """One snapshot run. `ticker_for(symbol)` returns a yfinance-like ticker. Returns the exit code."""
    today = now.astimezone(NEW_YORK).date()
    if not in_session(now):
        log(f"skipped: {now.astimezone(NEW_YORK):%a %H:%M} New York is outside {SESSION[0]:%H:%M} to {SESSION[1]:%H:%M} on a weekday")
        return 0
    probe = ticker_for(PROBE)
    probe_chains, probe_expiry_errors = fetch_chains(probe, today)
    probe_cal = set(monthly_expiries([expiry for expiry, _ in probe_chains], today))
    probe_frames = [
        frame
        for expiry, chain in probe_chains
        if not probe_cal or expiry in probe_cal
        for frame in (chain.calls, chain.puts)
    ]
    latest = last_trade(probe_frames)
    if latest is None:
        raise RuntimeError(f"The {PROBE} chain has no trade time")
    if now - latest > timedelta(minutes=MAX_TRADE_AGE_MIN):
        log(f"skipped: no {PROBE} option trade in the last {MAX_TRADE_AGE_MIN} minutes (latest {latest}); the market is closed")
        return 0
    out = store / today.isoformat() / now.strftime("%H%M%SZ")
    out.mkdir(parents=True, exist_ok=False)
    snapshot_iso = now.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    summary: dict[str, Any] = {
        "schema": SCHEMA,
        "day": today.isoformat(),
        "fetchedAt": now.isoformat(timespec="seconds"),
        "source": source,
        "probeLastTrade": latest.isoformat(timespec="seconds"),
        "complete": False,
        "spots": {},
        "errors": {},
        "storedExpiries": {},
        "symbols": {},
    }
    for symbol in SYMBOLS:
        items, chains = [], []
        try:
            ticker = probe if symbol == PROBE else ticker_for(symbol)
            chains, expiry_errors = (
                (probe_chains, dict(probe_expiry_errors))
                if symbol == PROBE
                else fetch_chains(ticker, today)
            )
            summary["storedExpiries"][symbol] = [expiry for expiry, _ in chains]
            for expiry, chain in chains:  # the raw quotes first: a later failure must not lose them
                for side, frame in (("calls", chain.calls), ("puts", chain.puts)):
                    frame.to_csv(out / f"{symbol}-{expiry}-{side}.csv", index=False)
            spot = retry(lambda: float(ticker.fast_info["last_price"]))
            summary["spots"][symbol] = spot
            cal_expiries = set(monthly_expiries([expiry for expiry, _ in chains], today))
            cal_chains = [(expiry, chain) for expiry, chain in chains if expiry in cal_expiries]
            measured = [
                measure(chain.calls.itertuples(), chain.puts.itertuples(), spot, expiry, today)
                for expiry, chain in cal_chains
            ]
            items = [item for item in measured if item is not None]
            symbol_errors: list[str] = []
            if len(items) < len(cal_chains):
                symbol_errors.append(
                    f"{len(cal_chains) - len(items)} of {len(cal_chains)} expiries without usable quotes"
                )
            if api_client is not None:
                ingest_errors: list[str] = []
                ingested_map: dict[str, Any | None] = {expiry: chain for expiry, chain in chains}
                for failed_exp in expiry_errors:
                    ingested_map.setdefault(failed_exp, None)
                for expiry in sorted(ingested_map):
                    chain = ingested_map[expiry]
                    yahoo_quotes = (
                        build_yahoo_quotes(chain.calls.itertuples(), chain.puts.itertuples(), spot, expiry, today)
                        if chain is not None
                        else []
                    )
                    api_chain: dict[str, Any] | None = None
                    if use_ibkr:
                        try:
                            api_chain = api_client.chain(symbol, expiry)
                        except OptionChainApiError as api_err:
                            log(f"{symbol} {expiry}: optionsChain.chain fallback to Yahoo ({api_err})")
                    quotes, ingest_spot, header_source = overlay_ibkr_chain(
                        yahoo_quotes, api_chain, spot, expiry, today
                    )
                    if not quotes:
                        if expiry not in expiry_errors:
                            ingest_errors.append(f"{expiry}: no quotes to ingest")
                        continue
                    payload = {
                        "snapshotAt": snapshot_iso,
                        "tradingDay": today.isoformat(),
                        "underlying": symbol,
                        "expiry": expiry,
                        "spot": ingest_spot,
                        "source": header_source,
                        "quotes": quotes,
                    }
                    try:
                        retry(lambda p=payload: api_client.ingest_snapshot(p))
                        if expiry in expiry_errors:
                            # Recovered into Postgres via optionsChain.chain fallback.
                            expiry_errors.pop(expiry, None)
                    except Exception as ingest_err:  # noqa: BLE001
                        ingest_errors.append(f"{expiry}: {ingest_err}")
                if ingest_errors:
                    symbol_errors.append(f"ingest: {'; '.join(ingest_errors)}")
            for failed_exp, failed_msg in sorted(expiry_errors.items()):
                symbol_errors.append(f"{failed_exp}: {failed_msg}")
            if symbol_errors:
                summary["errors"][symbol] = "; ".join(symbol_errors)
        except Exception as error:  # noqa: BLE001 - one failed symbol must not lose the other six
            summary["errors"][symbol] = f"{type(error).__name__}: {error}"
        summary["symbols"][symbol] = items
        write_summary(out, summary)  # a killed run keeps the symbols it has, marked incomplete
        log(symbol, summary["errors"].get(symbol, "ok"), [
            (item["expiry"], {name: None if value is None else round(value, 2) for name, value in item["halfSpreadPct"].items()},
             None if item["callSlope"] is None else round(item["callSlope"], 3),
             None if item["putSlope"] is None else round(item["putSlope"], 3)) for item in items])
    summary["complete"] = not summary["errors"]
    write_summary(out, summary)
    log(f"wrote {out / 'summary.json'} (complete: {summary['complete']})")
    return 0 if summary["complete"] else 1


def csv_rows(path: Path) -> list:
    def number(text: str | None) -> float:
        if not text:
            return math.nan
        try:
            return float(text)
        except ValueError:
            return math.nan

    with path.open(newline="") as handle:
        return [
            SimpleNamespace(
                strike=number(row.get("strike")),
                bid=number(row.get("bid")),
                ask=number(row.get("ask")),
                lastPrice=row.get("lastPrice", row.get("last", "")),
                volume=row.get("volume", ""),
                openInterest=row.get("openInterest", ""),
                impliedVolatility=row.get("impliedVolatility", row.get("iv", "")),
            )
            for row in csv.DictReader(handle)
        ]


def remeasure(run: Path, log=print) -> int:
    """Computes summary.json of a stored run again from its CSV files and the stored spot prices.
    Measures only DTE_RANGE monthly expiries for summary['symbols'] (calibrate.py compatibility)."""
    if not (run / "summary.json").is_file():
        log(f"{run} has no summary.json, so no spot prices: the run cannot be measured again")
        return 1
    old = json.loads((run / "summary.json").read_text())
    today = date.fromisoformat(old.get("day") or run.parent.name)
    spots = {symbol: items[0]["spot"] for symbol, items in old["symbols"].items() if items} | old.get("spots", {})
    summary: dict[str, Any] = {
        **old,
        "schema": SCHEMA,
        "day": today.isoformat(),
        "remeasured": True,
        "spots": spots,
        "errors": {},
        "storedExpiries": {},
        "symbols": {},
    }
    for symbol in SYMBOLS:
        found = sorted(path.name.removeprefix(f"{symbol}-").removesuffix("-calls.csv") for path in run.glob(f"{symbol}-*-calls.csv"))
        summary["storedExpiries"][symbol] = found
        expiries = monthly_expiries(found, today) if found else []
        items = []
        if symbol not in spots or not found:
            summary["errors"][symbol] = old.get("errors", {}).get(symbol) or ("no spot price stored" if found else "no chain stored")
        elif not expiries:
            summary["errors"][symbol] = "no DTE-range monthly chain stored"
        else:
            measured = [measure(csv_rows(run / f"{symbol}-{expiry}-calls.csv"), csv_rows(run / f"{symbol}-{expiry}-puts.csv"),
                                spots[symbol], expiry, today) for expiry in expiries]
            items = [item for item in measured if item is not None]
            if len(items) < len(expiries):
                summary["errors"][symbol] = f"{len(expiries) - len(items)} of {len(expiries)} expiries without usable quotes"
        summary["symbols"][symbol] = items
    summary["complete"] = not summary["errors"]
    write_summary(run, summary)
    log(f"wrote {run / 'summary.json'} (complete: {summary['complete']})")
    return 0 if summary["complete"] else 1


def backfill(
    store: Path,
    api_client: VertexOptionChainClient | None,
    *,
    dry_run: bool = False,
    log=print,
) -> int:
    """Walk stored <store>/<day>/<HHMMSS>Z/ folders chronologically and upsert chains into Postgres."""
    if not dry_run and api_client is None:
        log(f"backfill requires {API_URL_ENVS[1]} (or {API_URL_ENVS[0]}) and {API_KEY_ENV} (or pass --dry-run)")
        return 1
    if not store.is_dir():
        log(f"backfill store does not exist: {store}")
        return 1
    runs = 0
    created_total = 0
    updated_total = 0
    posted_total = 0
    errors = 0
    for day_dir in sorted(p for p in store.iterdir() if p.is_dir()):
        for run_dir in sorted(p for p in day_dir.iterdir() if p.is_dir()):
            summary_path = run_dir / "summary.json"
            if not summary_path.is_file():
                continue
            try:
                old = json.loads(summary_path.read_text())
                fetched = datetime.fromisoformat(old["fetchedAt"])
                if fetched.tzinfo is None:
                    fetched = fetched.replace(tzinfo=timezone.utc)
                snapshot_iso = fetched.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
                trading_day = old.get("day") or day_dir.name
                today = date.fromisoformat(trading_day)
            except (ValueError, KeyError, TypeError) as err:
                log(f"skip damaged run {run_dir}: {err}")
                errors += 1
                continue
            runs += 1
            spots = {
                symbol: items[0]["spot"]
                for symbol, items in (old.get("symbols") or {}).items()
                if items and isinstance(items, list) and "spot" in items[0]
            } | (old.get("spots") or {})
            pairs: dict[tuple[str, str], dict[str, Path]] = {}
            for csv_path in sorted(run_dir.glob("*-*-*.csv")):
                match = _CSV_NAME_RE.match(csv_path.name)
                if match is not None:
                    sym, exp, side = match.group(1), match.group(2), match.group(3)
                    pairs.setdefault((sym, exp), {})[side] = csv_path
            for (symbol, expiry), sides in sorted(pairs.items()):
                try:
                    call_rows = csv_rows(sides["calls"]) if "calls" in sides else []
                    put_rows = csv_rows(sides["puts"]) if "puts" in sides else []
                except (OSError, ValueError, csv.Error) as err:
                    log(f"backfill csv error {trading_day} {symbol} {expiry}: {err}")
                    errors += 1
                    continue
                spot = _finite_pos(spots.get(symbol))
                quotes = build_yahoo_quotes(call_rows, put_rows, spot, expiry, today)
                if not quotes:
                    continue
                payload = {
                    "snapshotAt": snapshot_iso,
                    "tradingDay": trading_day,
                    "underlying": symbol,
                    "expiry": expiry,
                    "spot": spot,
                    "source": "yahoo",
                    "quotes": quotes,
                }
                if dry_run:
                    posted_total += 1
                    continue
                try:
                    result = retry(lambda p=payload: api_client.ingest_snapshot(p))  # type: ignore[union-attr]
                    posted_total += 1
                    if result.get("created"):
                        created_total += 1
                    else:
                        updated_total += 1
                except OptionChainApiError as err:
                    log(f"backfill error {trading_day} {symbol} {expiry}: {err}")
                    errors += 1
                    if err.status in (401, 403):
                        log("backfill aborted: authentication or permission error")
                        return 1
                except Exception as err:  # noqa: BLE001
                    log(f"backfill error {trading_day} {symbol} {expiry}: {err}")
                    errors += 1
    mode = "dry-run" if dry_run else "ingested"
    log(f"backfill {mode}: {runs} runs, {posted_total} snapshots (created {created_total}, updated {updated_total}), {errors} errors")
    return 0 if errors == 0 else 1


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--store", type=Path, help="snapshot store directory (local data, not committed)")
    group.add_argument("--remeasure", type=Path, metavar="RUN_DIR", help="one stored run directory: write its summary.json again")
    parser.add_argument("--backfill", action="store_true", help="ingest all stored day folders under --store into Postgres")
    parser.add_argument("--dry-run", action="store_true", help="with --backfill, validate stored runs without posting")
    parser.add_argument("--no-push", action="store_true", help="do not push snapshots to Vertex or call optionsChain.chain")
    parser.add_argument("--yahoo-only", action="store_true", help="skip optionsChain.chain IBKR overlay (still push if configured)")
    args = parser.parse_args()
    if args.remeasure is not None:
        return remeasure(args.remeasure.expanduser())
    client = None if args.no_push else VertexOptionChainClient.from_env()
    if args.backfill:
        return backfill(args.store.expanduser(), client, dry_run=args.dry_run)
    import yfinance as yf

    return collect(
        yf.Ticker,
        datetime.now(timezone.utc),
        args.store.expanduser(),
        f"Yahoo Finance via yfinance {yf.__version__}",
        api_client=client,
        use_ibkr=not args.yahoo_only,
    )


if __name__ == "__main__":
    sys.exit(main())
