"""IBKR daily history for the research fetchers, with Yahoo (and Cboe, Treasury) gap fill.

What: a stdlib client (urllib, json) for the read-only vertex-history service (1.3.0,
``GET {VERTEX_HISTORY_URL}/bars``), the Python twin of packages/api/src/server/ibkr-history.ts,
plus the merge rules the fetch scripts share:

* IBKR first: every date IBKR returns is kept as IBKR's bar (``source: "ibkr"``).
* Yahoo fills the dates before IBKR's first date, and everything when IBKR fails or is not
  configured (``VERTEX_HISTORY_URL`` and ``VERTEX_DEPLOY_STATUS_TOKEN`` unset).
* Indices: IBKR IND, then Yahoo, then the Cboe published daily CSV (volatility indices), then the
  US Treasury daily par yield curve (IRX: 3-month, TNX: 10-year).

Why: card vertex-yahoo-terms-decision (owner 2026-11-10): move the Yahoo Finance call sites to
IBKR history; Yahoo stays only as the gap filler for history IBKR does not serve.

Service facts this module relies on (docs/vertex-rebuild/quantvps-status-endpoint.md):
daily windows up to 30 Y (``N Y`` above 365 days); ``ADJUSTED_LAST`` (split and dividend
adjusted) is STK 1 day only and takes no end date, so it reaches back 30 years at most;
``CONTFUT`` takes no end date either; ``IND`` is TRADES only with an exchange; end dates before
1990-01-01 are refused; US stock volume arrives in lots of 100 shares (scaled here to shares);
pacing answers 429 with ``retry_after_seconds``.

Best-effort links (unverified against a live run; each falls through to the next source):
* IBKR CONTFUT keeps expired contracts for about two years, so only the latest window
  (CONTFUT_YEARS) is requested; whether IBKR back-adjusts that series is not verified, so every
  seam records the close ratio of both sources on the seam date.
* IBKR IRX/TNX may quote 10 x the yield (Cboe convention); a series whose newest window peaks
  above 20 is divided by 10 so all sources give percent (yields since 1990 never reached 20 %).
* The Cboe CSV exists for the Cboe volatility indices only (CBOE_CSV); its column layout varies
  (``CLOSE`` or a single value column).
* The Treasury par yield curve is a constant-maturity bond-equivalent yield, close to but not the
  same as Cboe's IRX (13-week bill discount rate) and TNX; it is the last resort, one request per year.

Safety: read-only market data, no orders. The token and the service URL never appear in error
messages, reprs or output; this module logs nothing.
"""
from __future__ import annotations

import csv
import io
import json
import math
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta
from typing import Any

URL_ENV = "VERTEX_HISTORY_URL"
TOKEN_ENV = "VERTEX_DEPLOY_STATUS_TOKEN"
SCHEMA = "vertex-history-bars-v1"
SEC_TYPES = ("STK", "FUT", "CONTFUT", "CASH", "IND")
WHAT_TO_SHOW = ("TRADES", "MIDPOINT", "BID_ASK", "ADJUSTED_LAST")
MAX_YEARS = 30
MAX_PAGES = 40
MAX_BARS = 20_000
END_FLOOR = date(1990, 1, 1)
STK_VOLUME_LOT = 100
TIMEOUT_SECONDS = 60.0
MAX_BYTES = 2 * 1024 * 1024
ERROR_BODY_MAX_BYTES = 4 * 1024
PACED_RETRIES = 6
PACED_WAIT_SECONDS = 25.0
CONTFUT_YEARS = 2
YIELD_TENTHS_ABOVE = 20.0

Row = dict[str, Any]


class IbkrHistoryError(Exception):
    """A failed history read. ``code`` as the TypeScript client (MarketDataError); the message never
    carries the token or the URL."""

    def __init__(self, code: str, message: str, *, retry_after: float | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.retry_after = retry_after

    def __str__(self) -> str:
        return f"{self.code}: {self.message}"


@dataclass(frozen=True)
class HttpResponse:
    status: int
    headers: Mapping[str, str]  # lower-case names
    body: bytes


# (url, headers, timeout seconds, max body bytes) -> response. Raises IbkrHistoryError on a transport failure.
Transport = Callable[[str, Mapping[str, str], float, int], HttpResponse]


def configured(env: Mapping[str, str] | None = None) -> bool:
    """True when both VERTEX_HISTORY_URL and VERTEX_DEPLOY_STATUS_TOKEN are set (non-blank)."""
    env = os.environ if env is None else env
    return bool(env.get(URL_ENV, "").strip()) and bool(env.get(TOKEN_ENV, "").strip())


# --- transport -------------------------------------------------------------------------------------------


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):  # noqa: ANN002, ANN003 - urllib signature
        return None  # a 3xx answer surfaces as its own status, never followed


def _lower(headers) -> dict[str, str]:
    return {str(k).lower(): str(v) for k, v in (headers.items() if headers is not None else ())}


def _read_capped(stream, max_bytes: int) -> bytes:
    body = stream.read(max_bytes + 1)
    if len(body) > max_bytes:
        raise IbkrHistoryError("UPSTREAM_ERROR", "History response exceeds the size cap")
    return body


def urllib_transport(url: str, headers: Mapping[str, str], timeout: float, max_bytes: int) -> HttpResponse:
    """GET without redirects, with a timeout and a body size cap; exceptions are replaced by safe ones."""
    opener = urllib.request.build_opener(_NoRedirect)
    request = urllib.request.Request(url, headers=dict(headers), method="GET")
    try:
        with opener.open(request, timeout=timeout) as response:
            head = _lower(response.headers)
            declared = head.get("content-length", "")
            if declared.isdigit() and int(declared) > max_bytes:
                raise IbkrHistoryError("UPSTREAM_ERROR", "History response exceeds the size cap")
            return HttpResponse(response.status, head, _read_capped(response, max_bytes))
    except IbkrHistoryError:
        raise
    except urllib.error.HTTPError as error:
        try:
            body = error.read(ERROR_BODY_MAX_BYTES)
        except Exception:  # noqa: BLE001 - an unreadable error body is just empty
            body = b""
        finally:
            error.close()
        return HttpResponse(error.code, _lower(error.headers), body)
    except urllib.error.URLError as error:
        timed_out = isinstance(error.reason, TimeoutError)
        raise IbkrHistoryError("UNAVAILABLE", "History request timed out" if timed_out
                               else "History request failed") from None
    except TimeoutError:
        raise IbkrHistoryError("UNAVAILABLE", "History request timed out") from None
    except Exception:  # noqa: BLE001 - http.client and socket errors may quote the host
        raise IbkrHistoryError("UNAVAILABLE", "History request failed") from None


# --- request rules and parsing ---------------------------------------------------------------------------

_ACCOUNT = re.compile(r"\b(?:D?U|F|I)\d{5,}\b")
_CONTROL = re.compile(r"[\x00-\x1f\x7f]+")
_END_DATETIME = re.compile(r"^\d{8}-\d{2}:\d{2}:\d{2}$")


def _clean(text: str) -> str:
    return _CONTROL.sub(" ", _ACCOUNT.sub("[account]", text)).strip()[:300]


def end_date_time(day: date) -> str:
    """IBKR's UTC end form for the last second of ``day``."""
    return f"{day:%Y%m%d}-23:59:59"


def check_request(*, sec_type: str, exchange: str | None, what: str, years: int,
                  end_date_time: str | None) -> None:
    """Raises BAD_REQUEST when a daily request breaks a vertex-history 1.3.0 rule; no network call."""
    rules = (
        (sec_type not in SEC_TYPES, "secType must be one of " + " ".join(SEC_TYPES)),
        (what not in WHAT_TO_SHOW, "whatToShow must be one of " + " ".join(WHAT_TO_SHOW)),
        (isinstance(years, bool) or not isinstance(years, int) or not 1 <= years <= MAX_YEARS,
         f"years must be 1 to {MAX_YEARS}"),
        (end_date_time is not None and not _END_DATETIME.match(end_date_time),
         "endDateTime must be YYYYMMDD-HH:MM:SS (UTC)"),
        (sec_type not in ("STK", "CASH") and not exchange, "Futures and indices need an exchange"),
        (sec_type == "CONTFUT" and end_date_time is not None, "CONTFUT takes no endDateTime"),
        (what == "ADJUSTED_LAST" and sec_type != "STK", "ADJUSTED_LAST is for STK 1 day bars only"),
        (what == "ADJUSTED_LAST" and end_date_time is not None, "ADJUSTED_LAST takes no endDateTime"),
        (what == "BID_ASK" and sec_type != "STK", "BID_ASK is for STK only"),
        (sec_type == "IND" and what != "TRADES", "IND offers TRADES only"),
    )
    for broken, message in rules:
        if broken:
            raise IbkrHistoryError("BAD_REQUEST", message)


def build_url(base: str, *, symbol: str, sec_type: str = "STK", exchange: str | None = None,
              currency: str = "USD", years: int = MAX_YEARS, what: str = "TRADES", use_rth: bool = True,
              end_date_time: str | None = None) -> str:
    """The /bars URL of one daily request (same parameter order as buildHistoryBarsUrl)."""
    params = {
        "barSize": "1 day",
        "currency": currency.upper(),
        "duration": f"{years} Y",
        "secType": sec_type,
        "symbol": symbol.upper(),
        "useRTH": "1" if use_rth else "0",
        "whatToShow": what,
    }
    if exchange is not None:
        params["exchange"] = exchange.upper()
    if end_date_time is not None:
        params["endDateTime"] = end_date_time
    return f"{base.rstrip('/')}/bars?{urllib.parse.urlencode(params)}"


def _failure(response: HttpResponse) -> IbkrHistoryError:
    body: dict = {}
    if response.headers.get("content-type", "").lower().startswith("application/json"):
        try:
            parsed = json.loads(response.body[:ERROR_BODY_MAX_BYTES].decode("utf-8"))
            body = parsed if isinstance(parsed, dict) else {}
        except (ValueError, UnicodeDecodeError):
            body = {}
    message = _clean(body["message"]) if isinstance(body.get("message"), str) else ""
    code = body.get("ibkr_code")
    with_code = f"IBKR {code}: {message}" if isinstance(code, int) and not isinstance(code, bool) else message
    status, error = response.status, body.get("error")
    if status == 429:
        retry = body.get("retry_after_seconds")
        if not (isinstance(retry, (int, float)) and not isinstance(retry, bool) and retry >= 0):
            header = response.headers.get("retry-after", "")
            retry = math.ceil(float(header)) if re.fullmatch(r"\d+(\.\d+)?", header) and float(header) > 0 else None
        return IbkrHistoryError("PACED", "IBKR history pacing: retry later" if retry is None
                                else f"IBKR history pacing: retry in {retry} s", retry_after=retry)
    if body:
        if status == 422 or error == "no_contract":
            return IbkrHistoryError("NOT_FOUND", with_code or "No IBKR contract matched the request")
        if error == "entitlement":
            return IbkrHistoryError("ENTITLEMENT", with_code or "IBKR market data permissions missing")
        if status in (503, 504):
            return IbkrHistoryError("UNAVAILABLE", message or "IBKR history service unavailable")
        if status == 400:
            return IbkrHistoryError("BAD_REQUEST", message or "History service rejected the request")
        if status == 502 and message:
            return IbkrHistoryError("UPSTREAM_ERROR", with_code)
    if status in (503, 504):
        return IbkrHistoryError("UNAVAILABLE", f"History endpoint returned HTTP {status}")
    return IbkrHistoryError("UPSTREAM_ERROR", f"History endpoint returned HTTP {status}")


def _number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def parse_document(body: bytes) -> list[Row]:
    """Rows of a vertex-history-bars-v1 document, ascending by date; volume in shares for US stocks."""
    try:
        document = json.loads(body.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        raise IbkrHistoryError("UPSTREAM_ERROR", "History response is not valid JSON") from None
    bad = IbkrHistoryError("UPSTREAM_ERROR", "History response failed schema validation")
    if not isinstance(document, dict) or document.get("schema") != SCHEMA:
        raise bad
    bars, request = document.get("bars"), document.get("request")
    if not isinstance(bars, list) or len(bars) > MAX_BARS or document.get("count") != len(bars):
        raise bad
    if not isinstance(request, dict):
        raise bad
    lot = STK_VOLUME_LOT if request.get("secType") == "STK" and request.get("currency") == "USD" else 1
    rows: dict[str, Row] = {}
    for bar in bars:
        if not isinstance(bar, dict) or not isinstance(bar.get("t"), int) or isinstance(bar.get("t"), bool):
            raise bad
        if not all(_number(bar.get(key)) for key in ("o", "h", "l", "c")):
            raise bad
        volume = bar.get("v")
        if volume is not None and not (_number(volume) and volume >= 0):
            raise bad
        day = datetime.fromtimestamp(bar["t"], tz=UTC).date().isoformat()
        rows.setdefault(day, {"date": day, "open": float(bar["o"]), "high": float(bar["h"]),
                              "low": float(bar["l"]), "close": float(bar["c"]),
                              "volume": None if volume is None else volume * lot, "source": "ibkr"})
    return [rows[day] for day in sorted(rows)]


# --- client ----------------------------------------------------------------------------------------------


def _utc_today() -> date:
    return datetime.now(UTC).date()


class Client:
    """Daily bars from vertex-history. Build it with ``Client.from_env()`` (or pass fakes in tests)."""

    def __init__(self, url: str, token: str, *, transport: Transport | None = None,
                 sleep: Callable[[float], None] = time.sleep, today: Callable[[], date] = _utc_today,
                 timeout: float = TIMEOUT_SECONDS, paced_retries: int = PACED_RETRIES,
                 paced_wait: float = PACED_WAIT_SECONDS) -> None:
        if urllib.parse.urlsplit(url.strip()).scheme not in ("http", "https"):
            raise IbkrHistoryError("NOT_CONFIGURED", f"{URL_ENV} must be an http(s) URL")
        self._url = url.strip()
        self._token = token.strip()
        self._transport = transport or urllib_transport
        self._sleep = sleep
        self._today = today
        self._timeout = timeout
        self._paced_retries = paced_retries
        self._paced_wait = paced_wait

    def __repr__(self) -> str:
        return "Client(<history service>)"

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None, **options: Any) -> Client:
        env = os.environ if env is None else env
        if not configured(env):
            raise IbkrHistoryError("NOT_CONFIGURED", f"IBKR history not configured ({URL_ENV}, {TOKEN_ENV})")
        return cls(env[URL_ENV], env[TOKEN_ENV], **options)

    def today(self) -> date:
        return self._today()

    def _once(self, url: str) -> list[Row]:
        headers = {"Accept": "application/json", "Authorization": f"Bearer {self._token}"}
        response = self._transport(url, headers, self._timeout, MAX_BYTES)
        if response.status != 200:
            raise _failure(response)
        if not response.headers.get("content-type", "").lower().startswith("application/json"):
            raise IbkrHistoryError("UPSTREAM_ERROR", "History endpoint returned an unexpected content type")
        if len(response.body) > MAX_BYTES:
            raise IbkrHistoryError("UPSTREAM_ERROR", "History response exceeds the size cap")
        return parse_document(response.body)

    def daily_bars(self, symbol: str, *, sec_type: str = "STK", exchange: str | None = None,
                   currency: str = "USD", what: str = "TRADES", years: int = MAX_YEARS,
                   end_date_time: str | None = None, use_rth: bool = True) -> list[Row]:
        """One daily window of ``years`` ending at ``end_date_time`` (absent: now). A paced (429) answer is
        retried after ``retry_after_seconds`` (else the default wait), up to ``paced_retries`` times."""
        check_request(sec_type=sec_type, exchange=exchange, what=what, years=years, end_date_time=end_date_time)
        url = build_url(self._url, symbol=symbol, sec_type=sec_type, exchange=exchange, currency=currency,
                        years=years, what=what, use_rth=use_rth, end_date_time=end_date_time)
        for attempt in range(self._paced_retries + 1):
            try:
                return self._once(url)
            except IbkrHistoryError as error:
                if error.code != "PACED" or attempt >= self._paced_retries:
                    raise
                wait = self._paced_wait if error.retry_after is None else float(error.retry_after) + 1.0
                self._sleep(wait)
        raise AssertionError("unreachable")

    def paged(self, symbol: str, *, start: str | None = None, sec_type: str = "STK", exchange: str | None = None,
              currency: str = "USD", what: str = "TRADES", max_pages: int = MAX_PAGES,
              use_rth: bool = True) -> list[Row]:
        """Daily bars back to ``start`` (absent: the service's 1990 floor): end-dated windows of up to 30 Y,
        newest first, each ending the day before the previous window's first bar; ascending, one row per
        date (rows before ``start`` are kept; callers cut). CONTFUT and ADJUSTED_LAST take no end date, so
        they get one window (at most 30 years back)."""
        floor = max(date.fromisoformat(start), END_FLOOR) if start else END_FLOOR

        def years_to_floor(end: date) -> int:
            return min(MAX_YEARS, max(1, math.ceil((end - floor).days / 365.25)))

        options = {"sec_type": sec_type, "exchange": exchange, "currency": currency, "what": what,
                   "use_rth": use_rth}
        if sec_type == "CONTFUT" or what == "ADJUSTED_LAST":
            return self.daily_bars(symbol, years=years_to_floor(self.today()), **options)
        rows: dict[str, Row] = {}
        end: date | None = None
        for _ in range(max_pages):
            page = self.daily_bars(symbol, years=years_to_floor(end or self.today()),
                                   end_date_time=None if end is None else end_date_time(end), **options)
            new = [row for row in page if row["date"] not in rows]
            if not new:
                break
            rows.update((row["date"], row) for row in new)
            first = date.fromisoformat(min(row["date"] for row in page))
            end = first - timedelta(days=1)
            if first <= floor or end < END_FLOOR:
                break
        return [rows[day] for day in sorted(rows)]


def client_from_env(**options: Any) -> Client:
    return Client.from_env(**options)


def daily_bars(symbol: str, **request: Any) -> list[Row]:
    """``Client.from_env().daily_bars``: raises IbkrHistoryError NOT_CONFIGURED without the env vars."""
    return Client.from_env().daily_bars(symbol, **request)


def paged(symbol: str, **request: Any) -> list[Row]:
    """``Client.from_env().paged``."""
    return Client.from_env().paged(symbol, **request)


# --- Yahoo symbols to IBKR contracts ---------------------------------------------------------------------


@dataclass(frozen=True)
class Contract:
    symbol: str
    sec_type: str = "STK"
    exchange: str | None = None
    currency: str = "USD"
    what: str = "TRADES"


# Cboe volatility indices trade on CBOE; NDX on NASDAQ; ^GSPC is SPX on CBOE; the yield indices on CBOE.
INDICES: dict[str, Contract] = {
    **{f"^{name}": Contract(name, "IND", "CBOE")
       for name in ("VIX", "VIX3M", "VIX9D", "VXN", "VXD", "RVX", "GVZ", "OVX", "VXSLV")},
    "^NDX": Contract("NDX", "IND", "NASDAQ"),
    "^GSPC": Contract("SPX", "IND", "CBOE"),
    "^SPX": Contract("SPX", "IND", "CBOE"),
    "^IRX": Contract("IRX", "IND", "CBOE"),
    "^TNX": Contract("TNX", "IND", "CBOE"),
}
YIELD_INDICES = frozenset({"IRX", "TNX"})
FUTURES: dict[str, Contract] = {
    f"{root}=F": Contract(root, "CONTFUT", exchange)
    for root, exchange in (("ES", "CME"), ("NQ", "CME"), ("RTY", "CME"), ("MES", "CME"), ("MNQ", "CME"),
                           ("YM", "CBOT"), ("ZN", "CBOT"), ("ZC", "CBOT"),
                           ("GC", "COMEX"), ("SI", "COMEX"), ("CL", "NYMEX"))
}
_FX = re.compile(r"^([A-Z]{3})([A-Z]{3})=X$")
_STOCK = re.compile(r"^[A-Z][A-Z0-9]*(?:[-.][A-Z])?$")


def contract_for(yahoo_symbol: str) -> Contract | None:
    """The IBKR contract of a Yahoo symbol, or None when there is no mapping (Yahoo only)."""
    if yahoo_symbol in INDICES:
        return INDICES[yahoo_symbol]
    if yahoo_symbol in FUTURES:
        return FUTURES[yahoo_symbol]
    fx = _FX.match(yahoo_symbol)
    if fx:
        return Contract(fx.group(1), "CASH", "IDEALPRO", fx.group(2), "MIDPOINT")
    if _STOCK.match(yahoo_symbol) and len(yahoo_symbol) <= 12:
        return Contract(re.sub(r"[-.]", " ", yahoo_symbol))  # BRK-B -> "BRK B"
    return None


# --- IBKR rows per kind ----------------------------------------------------------------------------------


def _yields_in_percent(rows: list[Row]) -> list[Row]:
    if rows and max(row["close"] for row in rows) > YIELD_TENTHS_ABOVE:
        return [{**row, **{key: row[key] / 10 for key in ("open", "high", "low", "close")}} for row in rows]
    return rows


def ibkr_rows(yahoo_symbol: str, *, start: str | None = None, adjust: str = "none",
              client: Client | None = None) -> list[Row]:
    """IBKR daily rows for a Yahoo symbol. ``adjust``: ``none`` (TRADES, split-adjusted OHLC),
    ``adj_close`` (TRADES OHLC plus ADJUSTED_LAST close as ``adj_close``, dates in both only) or ``ohlc``
    (ADJUSTED_LAST OHLC, the auto_adjust=True twin). Non-stock rows get ``adj_close`` = close.
    Raises IbkrHistoryError (NOT_CONFIGURED, NOT_MAPPED, ...)."""
    contract = contract_for(yahoo_symbol)
    if contract is None:
        raise IbkrHistoryError("NOT_MAPPED", f"no IBKR contract mapping for {yahoo_symbol}")
    client = client or Client.from_env()
    base = {"sec_type": contract.sec_type, "exchange": contract.exchange, "currency": contract.currency}
    if contract.sec_type == "CONTFUT":
        rows = client.daily_bars(contract.symbol, years=CONTFUT_YEARS, what=contract.what, **base)
    elif contract.sec_type != "STK" or adjust == "none":
        rows = client.paged(contract.symbol, start=start, what=contract.what, **base)
        if contract.sec_type == "IND" and contract.symbol in YIELD_INDICES:
            rows = _yields_in_percent(rows)
    elif adjust == "ohlc":
        rows = client.paged(contract.symbol, start=start, what="ADJUSTED_LAST", **base)
    elif adjust == "adj_close":
        adjusted = client.paged(contract.symbol, start=start, what="ADJUSTED_LAST", **base)
        if not adjusted:
            return []
        trades = client.paged(contract.symbol, start=max(start or "", adjusted[0]["date"]), **base)
        closes = {row["date"]: row["close"] for row in adjusted}
        return [{**row, "adj_close": closes[row["date"]]} for row in trades if row["date"] in closes]
    else:
        raise ValueError(f"adjust must be none, adj_close or ohlc, not {adjust!r}")
    return [{**row, "adj_close": row["close"]} for row in rows] if contract.sec_type != "STK" else rows


# --- public fallbacks: Cboe and Treasury -----------------------------------------------------------------

CBOE_URL = "https://cdn.cboe.com/api/global/us_indices/daily_prices/{name}_History.csv"
CBOE_CSV = frozenset({"VIX", "VIX3M", "VIX9D", "VXN", "VXD", "RVX", "GVZ", "OVX", "VXSLV"})
TREASURY_URL = ("https://home.treasury.gov/resource-center/data-chart-center/interest-rates/"
                "daily-treasury-rates.csv/{year}/all?type=daily_treasury_yield_curve"
                "&field_tdr_date_value={year}&page&_format=csv")
TREASURY_COLUMN = {"IRX": "3 Mo", "TNX": "10 Yr"}
PUBLIC_AGENT = {"User-Agent": "Mozilla/5.0 (vertex-research; public data)"}

Fetch = Callable[[str], bytes]


def public_get(url: str) -> bytes:
    """GET a fixed public https URL (Cboe, Treasury)."""
    request = urllib.request.Request(url, headers=PUBLIC_AGENT)
    with urllib.request.urlopen(request, timeout=60) as response:  # noqa: S310 - fixed public https URLs
        return response.read()


def _ohlc_row(day: str, close: float, source: str, record: Mapping[str, str] | None = None) -> Row:
    values = {}
    for key in ("open", "high", "low"):
        text = (record or {}).get(key.upper(), "")
        try:
            values[key] = float(text) if text.strip() else close
        except ValueError:
            values[key] = close
    return {"date": day, **values, "close": close, "adj_close": close, "volume": None, "source": source}


def cboe_daily(name: str, *, fetch: Fetch | None = None) -> list[Row]:
    """Cboe's published daily history CSV (DATE as MM/DD/YYYY, then CLOSE or one value column); rows with a
    close above 0, ascending."""
    text = (fetch or public_get)(CBOE_URL.format(name=name)).decode("utf-8")
    reader = csv.DictReader(io.StringIO(text))
    value_column = "CLOSE" if "CLOSE" in (reader.fieldnames or []) else (reader.fieldnames or [""])[-1]
    rows: dict[str, Row] = {}
    for record in reader:
        day = datetime.strptime(record["DATE"].strip(), "%m/%d/%Y").date().isoformat()
        close = float(record[value_column])
        if close > 0:
            rows[day] = _ohlc_row(day, close, "cboe", record if value_column == "CLOSE" else None)
    return [rows[day] for day in sorted(rows)]


def treasury_daily(name: str, *, start: str | None = None, end: str | None = None,
                   fetch: Fetch | None = None, today: date | None = None) -> list[Row]:
    """US Treasury daily par yield curve column for IRX (3 Mo) or TNX (10 Yr), in percent; one CSV per year
    from ``start`` (default 1990) to ``end`` or today."""
    column = TREASURY_COLUMN[name]
    first = date.fromisoformat(start).year if start else END_FLOOR.year
    last = date.fromisoformat(end).year if end else (today or _utc_today()).year
    rows: dict[str, Row] = {}
    for year in range(max(first, END_FLOOR.year), last + 1):
        text = (fetch or public_get)(TREASURY_URL.format(year=year)).decode("utf-8-sig")
        for record in csv.DictReader(io.StringIO(text)):
            value = (record.get(column) or "").strip()
            if not value:
                continue
            day = datetime.strptime(record["Date"].strip(), "%m/%d/%Y").date().isoformat()
            rows[day] = _ohlc_row(day, float(value), "treasury")
    return [rows[day] for day in sorted(rows)]


# --- merge -----------------------------------------------------------------------------------------------


@dataclass(frozen=True)
class Source:
    """One provider in priority order. ``fetch`` returns rows with a ``date`` (YYYY-MM-DD) and the price
    fields; it may raise. With ``open_start`` the source is consulted for a request without a start date
    even when earlier sources already returned rows (to extend history backwards)."""

    name: str
    fetch: Callable[[], Sequence[Row]]
    open_start: bool = True


@dataclass
class Merged:
    rows: list[Row]
    sources: dict[str, dict] = field(default_factory=dict)  # name -> rows, first, last (rows kept)
    errors: dict[str, str] = field(default_factory=dict)    # name -> safe error text
    seams: list[dict] = field(default_factory=list)

    def summary(self) -> dict:
        """JSON-ready provenance for manifests."""
        return {"rows": self.sources, "errors": self.errors, "seams": self.seams}

    def label(self) -> str:
        """`ibkr 2001-01-02..2026-11-06 (6500); yahoo 1993-01-29..2000-12-29 (2000)` (newest source first)."""
        return "; ".join(f"{name} {info['first']}..{info['last']} ({info['rows']})"
                         for name, info in self.sources.items()) or "no rows"


def _error_text(name: str, error: BaseException) -> str:
    if isinstance(error, IbkrHistoryError):
        return str(error)
    if name == "ibkr":
        return type(error).__name__  # never a message that could quote the service URL
    return f"{type(error).__name__}: {str(error)[:200]}"


def _ratio(new: Row, old: Row, key: str) -> float | None:
    a, b = new.get(key), old.get(key)
    if _number(a) and _number(b) and b != 0:
        return a / b
    return None


def merge_sources(sources: Sequence[Source], *, start: str | None = None, end: str | None = None,
                  rescale: Mapping[str, Sequence[str]] | None = None) -> Merged:
    """IBKR-first merge. Sources are consulted in order; each later source fills only the dates before the
    earliest date chosen so far (or everything when nothing was chosen). A source is skipped once the
    chosen rows reach ``start``; a failing source is recorded and skipped. ``rescale`` maps a ratio field
    to the fields scaled by it (e.g. ``{"close": ("open", "high", "low", "close")}`` for adjusted
    series): a filling source is multiplied by newer/older on the seam date, so returns stay continuous.
    Rows are cut to ``start <= date < end`` (end exclusive) and tagged with their source name. When no
    rows remain and a source raised, the last such exception is re-raised (the old Yahoo failure)."""
    chosen: list[Row] = []
    merged = Merged([])
    last_error: BaseException | None = None
    for source in sources:
        if chosen and start is not None and chosen[0]["date"] <= start:
            break
        if chosen and start is None and not source.open_start:
            continue
        try:
            rows = sorted({row["date"]: row for row in reversed(list(source.fetch()))}.values(),
                          key=lambda row: row["date"])
        except Exception as error:  # noqa: BLE001 - every provider failure falls through to the next
            merged.errors[source.name] = _error_text(source.name, error)
            last_error = error
            continue
        if not chosen:
            chosen = [{**row, "source": source.name} for row in rows]
            continue
        seam_day = chosen[0]["date"]
        fill = [row for row in rows if row["date"] < seam_day]
        if not fill:
            continue
        at_seam = next((row for row in rows if row["date"] == seam_day), None)
        seam = {"date": seam_day, "newer": chosen[0]["source"], "older": source.name,
                "close_ratio": None if at_seam is None else _ratio(chosen[0], at_seam, "close"),
                "rescaled": {}}
        factors: dict[str, float] = {}
        for ratio_field, fields in (rescale or {}).items():
            factor = None if at_seam is None else _ratio(chosen[0], at_seam, ratio_field)
            if factor is not None:
                seam["rescaled"][ratio_field] = factor
                factors.update((name, factor) for name in fields)
        filled = []
        for row in fill:
            copy = {**row, "source": source.name}
            for name, factor in factors.items():
                if _number(copy.get(name)):
                    copy[name] = copy[name] * factor
            filled.append(copy)
        merged.seams.append(seam)
        chosen = filled + chosen
    merged.rows = [row for row in chosen
                   if (start is None or row["date"] >= start) and (end is None or row["date"] < end)]
    if not merged.rows and last_error is not None:
        raise last_error
    by_source: dict[str, list[str]] = {}
    for row in merged.rows:
        by_source.setdefault(row["source"], []).append(row["date"])
    merged.sources = {name: {"rows": len(days), "first": days[0], "last": days[-1]}
                      for name, days in sorted(by_source.items(), key=lambda item: item[1][0], reverse=True)}
    return merged


ADJUST_RESCALE: dict[str, dict[str, tuple[str, ...]]] = {
    "none": {},
    "adj_close": {"adj_close": ("adj_close",)},
    "ohlc": {"close": ("open", "high", "low", "close")},
}


def _ibkr_source(yahoo_symbol: str, start: str | None, adjust: str, client: Client | None) -> Source:
    return Source("ibkr", lambda: ibkr_rows(yahoo_symbol, start=start, adjust=adjust, client=client))


def merged_daily(yahoo_symbol: str, yahoo: Callable[[], Sequence[Row]] | None, *, start: str | None = None,
                 end: str | None = None, adjust: str = "none", client: Client | None = None) -> Merged:
    """IBKR first, Yahoo fills the earlier dates (and everything when IBKR fails or is not configured).
    Adjusted series (``adjust`` ``adj_close`` or ``ohlc``) rescale the Yahoo part at the seam. Index
    symbols (``^...``) go through ``index_daily``."""
    if yahoo_symbol in INDICES:
        return index_daily(yahoo_symbol, yahoo, start=start, end=end, client=client)
    sources = [_ibkr_source(yahoo_symbol, start, adjust, client)]
    if yahoo is not None:
        sources.append(Source("yahoo", yahoo))
    return merge_sources(sources, start=start, end=end, rescale=ADJUST_RESCALE[adjust])


def index_daily(yahoo_symbol: str, yahoo: Callable[[], Sequence[Row]] | None, *, start: str | None = None,
                end: str | None = None, client: Client | None = None, fetch: Fetch | None = None) -> Merged:
    """Index closes: IBKR IND, then Yahoo (``yahoo``; None skips it), then the Cboe CSV (volatility
    indices), then the Treasury par yield curve (IRX, TNX; only when the others leave the start uncovered
    or return nothing). Every row carries ``adj_close`` = close from the non-Yahoo sources."""
    name = yahoo_symbol.lstrip("^")
    sources = [_ibkr_source(yahoo_symbol, start, "none", client)]
    if yahoo is not None:
        sources.append(Source("yahoo", yahoo))
    if name in CBOE_CSV:
        sources.append(Source("cboe", lambda: cboe_daily(name, fetch=fetch)))
    if name in TREASURY_COLUMN:
        sources.append(Source("treasury", lambda: treasury_daily(name, start=start, end=end, fetch=fetch),
                              open_start=False))
    return merge_sources(sources, start=start, end=end)


def source_note(merged: Merged) -> str:
    """One line for a script's summary print: per-source counts, and failed sources by code."""
    errors = "; ".join(f"{name} failed ({text.split(':')[0]})" for name, text in merged.errors.items())
    return merged.label() + (f"; {errors}" if errors else "")
