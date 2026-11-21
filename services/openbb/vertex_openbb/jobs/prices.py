"""Stored daily prices: the 16 price ids and EY_TNX_RATIO -> daily_series and daily_bars.

Card vertex-daily-series-refresh. Research data only: nothing here places an order.

Sources: IBKR daily bars through vertex-history first; Yahoo's chart endpoint when IBKR does not
cover the window (the merge rules of services/research/ibkr_history.py, loaded from the checkout).
The Treasury par yield curve is never used: it is not the Cboe IRX/TNX index, and the ingest side
appends rows and never changes them. Only complete sessions are emitted, for the same reason.
"""

from __future__ import annotations

import importlib.util
import json
import math
import re
import sys
import time
import urllib.parse
import urllib.request
from collections.abc import Callable, Mapping
from datetime import UTC, date, datetime
from datetime import time as clock_time
from pathlib import Path
from types import ModuleType
from typing import Any
from zoneinfo import ZoneInfo

from ..context import ArgumentError, Context
from ..upstream import UpstreamError

ETFS = ("SPY", "QQQ", "DIA", "IWM", "GLD", "SLV", "USO")
FUTURES = ("ES=F", "NQ=F", "YM=F", "RTY=F", "GC=F", "SI=F", "CL=F")
RATES = ("IRX", "TNX")
PRICE_IDS = ETFS + FUTURES + RATES
DERIVED_ID = "EY_TNX_RATIO"
EARNINGS_LAG_MONTHS = 6

NEW_YORK = ZoneInfo("America/New_York")
# CME closes the daily futures bar at 17:00 New York; a row dated today is complete from 17:15.
SESSION_COMPLETE_AT = clock_time(17, 15)
DEFAULT_DAYS = 45
# The tick client posts 2000 rows per chunk; a longer window could split one series over two chunks.
MAX_SINCE_DAYS = 120
# No new id starts after this many seconds, so the job ends before its 240 s deadline:
# 120 s + one id (2 IBKR requests of 30 s and Yahoo 20 s) + the Shiller page and workbook (2 x 15 s) = 230 s.
BUDGET_S = 120.0
IBKR_TIMEOUT_S = 30.0
YAHOO_TIMEOUT_S = 20.0
SHILLER_TIMEOUT_S = 15.0
MAX_BYTES = 8 * 1024 * 1024

AGENT = {"User-Agent": "Mozilla/5.0 (vertex-research; public data)"}
YAHOO_URL = (
    "https://query1.finance.yahoo.com/v8/finance/chart/{symbol}"
    "?period1={start}&period2={end}&interval=1d&events=div%2Csplits"
)
SHILLER_PAGE = "https://shillerdata.com/"
HISTORY_FILE = ("research", "ibkr_history.py")
OHLC = ("open", "high", "low", "close")

monotonic = time.monotonic


def load_history(service_dir: Path | None = None) -> ModuleType:
    """services/research/ibkr_history.py of the checkout (the collector runs in services/openbb)."""
    path = (service_dir or Path.cwd()).resolve().parent.joinpath(*HISTORY_FILE)
    if not path.is_file():
        raise ArgumentError(f"daily-prices needs {path} (run the collector in services/openbb of the checkout)")
    cached = sys.modules.get("ibkr_history")
    if cached is not None and getattr(cached, "__file__", None) == str(path):
        return cached
    spec = importlib.util.spec_from_file_location("ibkr_history", path)
    if spec is None or spec.loader is None:  # pragma: no cover - a .py path always gives a loader
        raise ArgumentError(f"daily-prices cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules["ibkr_history"] = module  # dataclasses resolve the module by name while it loads
    spec.loader.exec_module(module)
    return module


def http_get(url: str, timeout: float) -> bytes:
    request = urllib.request.Request(url, headers=AGENT)  # noqa: S310 - fixed public https URLs
    with urllib.request.urlopen(request, timeout=timeout) as response:  # noqa: S310
        return response.read(MAX_BYTES)


def yahoo_rows(payload: Mapping[str, Any]) -> list[dict[str, Any]]:
    """Rows of one Yahoo chart v8 document; a session with a missing price is skipped."""
    result = payload["chart"]["result"][0]
    zone = ZoneInfo(result["meta"]["exchangeTimezoneName"])
    quote = result["indicators"]["quote"][0]
    adjusted = ((result["indicators"].get("adjclose") or [{}])[0]).get("adjclose")
    volumes = quote.get("volume")
    rows: list[dict[str, Any]] = []
    for index, stamp in enumerate(result.get("timestamp") or []):
        prices = [quote[key][index] for key in OHLC]
        if any(value is None for value in prices):
            continue
        row: dict[str, Any] = {"date": datetime.fromtimestamp(stamp, zone).date().isoformat()}
        row.update(zip(OHLC, map(float, prices), strict=True))
        adj = None if adjusted is None else adjusted[index]
        row["adj_close"] = row["close"] if adj is None else float(adj)
        if volumes is not None and volumes[index] is not None:
            row["volume"] = float(volumes[index])
        rows.append(row)
    return rows


def fetch_yahoo(symbol: str, start: date, now: datetime) -> list[dict[str, Any]]:
    url = YAHOO_URL.format(
        symbol=urllib.parse.quote(symbol, safe=""),
        start=int(datetime(start.year, start.month, start.day, tzinfo=UTC).timestamp()),
        end=int(now.timestamp()) + 86_400,
    )
    return yahoo_rows(json.loads(http_get(url, YAHOO_TIMEOUT_S)))


def _no_treasury(_url: str) -> bytes:
    """Stands in for the public download of the merge: the Treasury source gives no row."""
    return b""


def _not_configured(history: ModuleType) -> Callable[..., Any]:
    def transport(*_request: Any) -> Any:
        raise history.IbkrHistoryError("NOT_CONFIGURED", "IBKR history not configured")

    return transport


def fetch_id(series_id: str, start: date, now: datetime, env: Mapping[str, str]) -> dict[str, Any]:
    """One id through the IBKR-first merge: {"rows", "errors", "warnings"} (JSON-ready)."""
    history = load_history()
    if history.configured(env):
        client = history.Client.from_env(env, paced_retries=0, timeout=IBKR_TIMEOUT_S)
    else:
        # Never the module's default client: it reads os.environ and waits out paced replies.
        client = history.Client("https://not-configured.invalid", "", transport=_not_configured(history),
                                paced_retries=0)
    symbol = f"^{series_id}" if series_id in RATES else series_id

    def yahoo() -> list[dict[str, Any]]:
        return fetch_yahoo(symbol, start, now)

    if series_id in RATES:
        merged = history.index_daily(symbol, yahoo, start=start.isoformat(), client=client, fetch=_no_treasury)
    else:
        adjust = "adj_close" if series_id in ETFS else "none"
        merged = history.merged_daily(symbol, yahoo, start=start.isoformat(), adjust=adjust, client=client)
    return {"errors": dict(merged.errors), "rows": list(merged.rows), "warnings": list(merged.warnings)}


def shiller_months(workbook: bytes) -> dict[str, list[float]]:
    """month (YYYY-MM) -> [price, earnings] from sheet `Data` of Shiller's ie_data.xls."""
    import xlrd

    sheet = xlrd.open_workbook(file_contents=workbook).sheet_by_name("Data")
    months: dict[str, list[float]] = {}
    for index in range(sheet.nrows):
        cells = (sheet.cell_value(index, 0), sheet.cell_value(index, 1), sheet.cell_value(index, 3))
        if not all(isinstance(cell, float) for cell in cells):
            continue
        stamp, price, earnings = cells
        year = int(stamp)
        month = int(round((stamp - year) * 100))
        if 1 <= month <= 12 and price > 0 and earnings > 0:
            months[f"{year:04d}-{month:02d}"] = [price, earnings]
    return months


def fetch_shiller() -> dict[str, list[float]]:
    page = http_get(SHILLER_PAGE, SHILLER_TIMEOUT_S).decode("utf-8", "ignore")
    match = re.search(r'href="([^"]*ie_data\.xls[^"]*)"', page)
    if match is None:
        raise RuntimeError("ie_data.xls link not found on shillerdata.com")
    url = match.group(1)
    return shiller_months(http_get("https:" + url if url.startswith("//") else url, SHILLER_TIMEOUT_S))


def shift_month(month: str, delta: int) -> str:
    serial = int(month[:4]) * 12 + int(month[5:7]) - 1 + delta
    return f"{serial // 12:04d}-{serial % 12 + 1:02d}"


def complete(day: str, now: datetime) -> bool:
    """A row dated before today (New York), or today once the session bar is closed."""
    today = now.date().isoformat()
    return day < today or (day == today and now.time() >= SESSION_COMPLETE_AT)


def _positive(value: Any) -> bool:
    return isinstance(value, int | float) and not isinstance(value, bool) and math.isfinite(value) and value > 0


def price_rows(
    series_id: str, rows: list[dict[str, Any]], start: date, now: datetime
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """(daily_series rows, daily_bars rows) of one id: complete sessions inside the window."""
    series: list[dict[str, Any]] = []
    bars: list[dict[str, Any]] = []
    for row in rows:
        day = row["date"]
        if row.get("source") == "treasury" or day < start.isoformat() or not complete(day, now):
            continue
        if series_id in RATES:
            if _positive(row.get("close")):
                series.append({"close": row["close"], "date": day, "high": None, "low": None, "open": None,
                               "seriesId": series_id})
            continue
        adj_close = row["close"] if series_id in FUTURES else row.get("adj_close")
        if not (all(_positive(row.get(key)) for key in OHLC) and _positive(adj_close)):
            continue
        # An ETF adj_close copied from the day before (no IBKR adjusted close yet) would drop an
        # ex-dividend step for good: the next run appends the row once IBKR has it.
        if series_id in ETFS and row.get("adj_close_carried"):
            continue
        prices = {key: row[key] for key in OHLC}
        series.append({**prices, "adjClose": adj_close, "date": day, "seriesId": series_id})
        # appendBars refuses a symbol with an inconsistent bar (low <= open, close <= high), and
        # the bar would stay in the window for weeks: drop the bar, keep the series row.
        if not (prices["low"] <= min(prices["open"], prices["close"]) and prices["high"] >= max(prices["open"], prices["close"])):
            continue
        volume = row.get("volume")
        valid_volume = isinstance(volume, int | float) and math.isfinite(volume) and volume >= 0
        bars.append({**prices, "date": day, "symbol": series_id, "volume": volume if valid_volume else None})
    return series, bars


def ratio_rows(tnx: list[dict[str, Any]], months: Mapping[str, Any], warn: Callable[[str], None]) -> list[dict[str, Any]]:
    """EY_TNX_RATIO per TNX date: 100 * E/P of the Shiller month 6 months back, over the TNX yield (percent)."""
    rows: list[dict[str, Any]] = []
    missing: set[str] = set()
    for point in tnx:
        month = shift_month(point["date"][:7], -EARNINGS_LAG_MONTHS)
        values = months.get(month)
        if values is None:
            missing.add(month)
            continue
        price, earnings = values
        rows.append({"close": 100 * earnings / price / point["close"], "date": point["date"], "high": None,
                     "low": None, "open": None, "seriesId": DERIVED_ID})
    if missing:
        warn(f"{DERIVED_ID}: the Shiller workbook has no month {', '.join(sorted(missing))}; no row for its dates")
    return rows


async def daily_prices(ctx: Context) -> dict[str, list[dict[str, Any]]]:
    """IBKR-first daily bars of the price ids -> daily_series (+ EY_TNX_RATIO) and daily_bars."""
    ids = ctx.symbol_list(PRICE_IDS)
    unknown = [s for s in ids if s not in PRICE_IDS]
    if unknown:
        raise ArgumentError(f"--symbols for daily-prices must be price ids, not {', '.join(unknown)}")
    start = ctx.start(DEFAULT_DAYS)
    if (ctx.today - start).days > MAX_SINCE_DAYS:
        raise ArgumentError(f"--since for daily-prices is at most {MAX_SINCE_DAYS} days back (older gaps need the full import)")
    now = (ctx.now or datetime.now(NEW_YORK)).astimezone(NEW_YORK)
    history = load_history()
    if not history.configured(ctx.env):
        ctx.warn("IBKR history is not configured (VERTEX_HISTORY_URL, VERTEX_DEPLOY_STATUS_TOKEN): Yahoo only")
    series = ctx.table("daily_series")
    bars = ctx.table("daily_bars")
    began = monotonic()
    tnx: list[dict[str, Any]] = []
    for series_id in ids:
        if monotonic() - began > BUDGET_S:
            ctx.failed(series_id, UpstreamError("error", f"not reached in {BUDGET_S:g} s; the next run reads it"))
            continue
        try:
            got = await ctx.up.helper(f"daily-prices:{series_id}", lambda s=series_id: fetch_id(s, start, now, ctx.env))
        except UpstreamError as exc:
            ctx.failed(series_id, exc)
            continue
        for warning in got["warnings"]:
            ctx.warn(f"{series_id}: {warning}")
        usable = [row for row in got["rows"] if row.get("source") != "treasury"]
        if not usable:
            errors = "; ".join(got["errors"].values()) or "no rows"
            ctx.failed(series_id, UpstreamError("error", errors))
            continue
        new_series, new_bars = price_rows(series_id, usable, start, now)
        ctx.ok()
        series.extend(new_series)
        bars.extend(new_bars)
        if series_id == "TNX":
            tnx = new_series
    if tnx:
        try:
            months = await ctx.up.helper("daily-prices:shiller", fetch_shiller)
        except UpstreamError as exc:
            ctx.failed(f"{DERIVED_ID} (Shiller workbook)", exc)
        else:
            ctx.ok()
            series.extend(ratio_rows(tnx, months, ctx.warn))
    return {"daily_bars": bars, "daily_series": series}
