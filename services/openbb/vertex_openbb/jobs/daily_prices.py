"""daily-prices: appends the finished sessions to the stored daily price series and 1d bar series.

Units, in order: TNX (with the derived EY_TNX_RATIO), IRX, the Core 7 ETFs, their futures. The tick
passes the stored last rows (`--state-stdin`, openbb.dailyPricesState). For each unit that is behind
the last finished session the job fetches daily rows from OVERLAP_DAYS before the stored last date
(IBKR first, Yahoo when IBKR fails: services/research/ibkr_history.py), checks the fetched close on
the stored last date against the stored close (the seam check) and emits only the rows after it.
openbb.ingest appends them; a stored row never changes.

Rules (docs/vertex-rebuild/designs/daily-series-refresh/plan.md):
- A row is accepted when its date is before today (New York): the run after midnight writes the
  session of the day before, when every source holds its final row.
- ETF adjClose continues the stored total-return series: fetched adj_close x (stored adjClose on the
  seam / fetched adj_close on the seam). Futures: adjClose = close. Indices and the ratio: null.
- A unit that stops before its last newer row (a row the row schema refuses, or an ETF row without
  an adjusted close) warns, so a series that cannot advance is visible in the run status.
- A paced IBKR answer ends the run; the next run continues, because the state then shows the
  remaining units as behind. A unit starts only when UNIT_RESERVE_S remain to the job deadline.
- EY_TNX_RATIO uses the Shiller figures of the run day. Shiller revises the newest months, so the
  appended rows can step away from the stored rows; the run then warns once.
- Without state (dry run) nothing is treated as stored: the rows of the last DEFAULT_DAYS are
  printed without a seam check, with one warning.
Research only: public and read-only market data, no orders.
"""

from __future__ import annotations

import importlib.util
import json
import sys
import time
from collections.abc import Mapping
from datetime import date, timedelta
from pathlib import Path
from types import ModuleType
from typing import Any, TextIO

from .. import rows as row_rules
from ..context import ArgumentError, Context
from ..upstream import UpstreamError
from ..values import rounded
from . import nyse_closures

# The folder with ibkr_history.py and shiller.py. The tick sets it (the venv holds a copy of this
# package, not the repository); the default is the source tree.
RESEARCH_DIR_ENV = "OPENBB_RESEARCH_DIR"
DEFAULT_RESEARCH_DIR = Path(__file__).resolve().parents[3] / "research"
# Environment values of the IBKR history client; cli.run scrubs them from every output.
SECRET_ENV = ("VERTEX_HISTORY_URL", "VERTEX_DEPLOY_STATUS_TOKEN")
UNITS = row_rules.YIELD_INDEX_IDS + row_rules.ETF_IDS + row_rules.FUTURE_IDS
RATIO_ID = "EY_TNX_RATIO"
# Months between the Shiller month and its use (data.EARNINGS_LAG_MONTHS of the qc ports).
EARNINGS_LAG_MONTHS = 6
# Fetched days before the stored last date, so the seam date is in the answer.
OVERLAP_DAYS = 7
# The window of a run without state.
DEFAULT_DAYS = 10
# Largest relative difference between the fetched and the stored close on the seam. Futures get
# more room: the stored series is not back-adjusted, and two sources can hold different contracts
# on the days around a roll. 2 % is also ibkr_history.SEAM_WARN_TOLERANCE (the join of two
# sources inside one fetch); the two limits are set separately on purpose.
SEAM_TOLERANCE = 0.02
FUTURE_SEAM_TOLERANCE = 0.10
# A unit starts only with this many seconds left to the job deadline (one 90 s upstream call).
UNIT_RESERVE_S = 100.0
# One IBKR request may take this long; a paced answer is not retried inside the run.
IBKR_TIMEOUT_S = 30.0
DECIMALS = 6


def kind_of(series_id: str) -> str:
    if series_id in row_rules.ETF_IDS:
        return "etf"
    return "future" if series_id in row_rules.FUTURE_IDS else "index"


def yahoo_symbol(series_id: str) -> str:
    return f"^{series_id}" if series_id in row_rules.YIELD_INDEX_IDS else series_id


def research_module(name: str, env: Mapping[str, str]) -> ModuleType:
    """`services/research/<name>.py`, loaded once by file path (it is not an installed package)."""
    key = f"vertex_research_{name}"
    if key in sys.modules:
        return sys.modules[key]
    folder = Path((env.get(RESEARCH_DIR_ENV) or "").strip() or DEFAULT_RESEARCH_DIR)
    spec = importlib.util.spec_from_file_location(key, folder / f"{name}.py")
    if spec is None or spec.loader is None:
        raise ArgumentError(f"{RESEARCH_DIR_ENV}: cannot load {name}.py from {folder}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[key] = module  # dataclasses resolve their module while the body runs
    try:
        spec.loader.exec_module(module)
    except FileNotFoundError:
        del sys.modules[key]
        raise ArgumentError(f"{RESEARCH_DIR_ENV}: {name}.py not found in {folder}") from None
    return module


def read_state(stream: TextIO) -> dict[str, dict[str, dict[str, Any]]]:
    """The tick's state JSON as `{"series": {id: entry}, "bars": {symbol: entry}}`."""
    try:
        raw = json.load(stream)
        series = {str(item["id"]): item for item in raw["series"]}
        bars = {str(item["symbol"]): item for item in raw["bars"]}
        for item in (*series.values(), *bars.values()):
            date.fromisoformat(item["lastDate"])
            float(item["close"])
    except (ValueError, TypeError, KeyError, AttributeError) as exc:
        raise ArgumentError(f"daily-prices state is not valid ({type(exc).__name__})") from None
    return {"series": series, "bars": bars}


def last_session(today: date) -> date:
    """The newest NYSE session before `today`: the last day whose rows are final."""
    day = today - timedelta(days=1)
    while day.weekday() >= 5 or nyse_closures.is_closed(day):
        day -= timedelta(days=1)
    return day


def unit_done(series: Mapping[str, Any] | None, bars: Mapping[str, Any] | None, session: date) -> bool:
    """True when the stored series, and the bar series when there is one, hold `session`."""
    if series is None:
        return False
    newest = session.isoformat()
    return series["lastDate"] >= newest and (bars is None or bars["lastDate"] >= newest)


def after_seam(
    fetched: list[dict[str, Any]], stored: Mapping[str, Any] | None, tolerance: float
) -> tuple[list[dict[str, Any]], dict[str, Any] | None, str | None]:
    """(rows after the stored last date, the fetched row on that date, problem).

    Nothing stored: every row, no seam. No newer row: nothing to do, no problem. Otherwise the
    fetched close on the stored last date must be within `tolerance` of the stored close.
    """
    if stored is None:
        return fetched, None, None
    last = stored["lastDate"]
    newer = [row for row in fetched if row["date"] > last]
    if not newer:
        return [], None, None
    seam = next((row for row in fetched if row["date"] == last), None)
    close = None if seam is None else rounded(seam.get("close"), DECIMALS)
    if seam is None or close is None:
        return [], None, f"no fetched close on the stored last date {last}"
    if not stored["close"] or abs(close / stored["close"] - 1.0) > tolerance:
        return [], None, f"close {close:g} on {last} differs from the stored {stored['close']:g} by more than {tolerance:.0%}"
    return newer, seam, None


def series_rows(
    series_id: str, newer: list[dict[str, Any]], seam: Mapping[str, Any] | None, stored: Mapping[str, Any] | None
) -> list[dict[str, Any]]:
    """daily_series rows of one unit; stops at the first row the row schema refuses (no holes)."""
    kind = kind_of(series_id)
    factor = None
    if kind == "etf" and seam is not None and stored is not None:
        fetched_adj = rounded(seam.get("adj_close"), DECIMALS)
        if stored.get("adjClose") and fetched_adj:
            factor = stored["adjClose"] / fetched_adj
    out = []
    for item in newer:
        close = rounded(item.get("close"), DECIMALS)
        adj: float | None = None
        if kind == "future":
            adj = close
        elif kind == "etf":
            fetched_adj = rounded(item.get("adj_close"), DECIMALS)
            scale = 1.0 if seam is None else factor
            adj = None if fetched_adj is None or scale is None else round(fetched_adj * scale, DECIMALS)
        prices = kind != "index"
        row = {
            "adjClose": adj,
            "close": close,
            "date": item["date"],
            "high": rounded(item.get("high"), DECIMALS) if prices else None,
            "low": rounded(item.get("low"), DECIMALS) if prices else None,
            "open": rounded(item.get("open"), DECIMALS) if prices else None,
            "seriesId": series_id,
        }
        complete = kind == "index" or None not in (row["open"], row["high"], row["low"], row["adjClose"])
        if not complete or row_rules.row_problem("daily_series", row) is not None:
            break
        out.append(row)
    return out


def bar_rows(symbol: str, newer: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """daily_bars rows of one unit; stops at the first bar the row schema refuses (no holes)."""
    out = []
    for item in newer:
        row = {
            "close": rounded(item.get("close"), DECIMALS),
            "date": item["date"],
            "high": rounded(item.get("high"), DECIMALS),
            "low": rounded(item.get("low"), DECIMALS),
            "open": rounded(item.get("open"), DECIMALS),
            "symbol": symbol,
            "volume": rounded(item.get("volume"), 0),
        }
        if row["volume"] is not None and row["volume"] < 0:
            row["volume"] = None
        if row_rules.row_problem("daily_bars", row) is not None:
            break
        out.append(row)
    return out


def shift_month(month: str, delta: int) -> str:
    """`YYYY-MM` moved by `delta` months (data._shift_month)."""
    serial = int(month[:4]) * 12 + int(month[5:7]) - 1 + delta
    return f"{serial // 12:04d}-{serial % 12 + 1:02d}"


def ratio_rows(tnx: list[dict[str, Any]], shiller: list[list[Any]], after: str | None) -> list[dict[str, Any]]:
    """EY_TNX_RATIO rows for TNX dates after `after` (data.ey_tnx_ratio): 100 x earnings / price of
    the Shiller month EARNINGS_LAG_MONTHS back, over the TNX close in percent. Stops at the first
    date without a published Shiller month, so the series has no hole."""
    table = {str(month): (float(price), float(earnings)) for month, price, earnings in shiller if price > 0}
    out = []
    for item in tnx:
        close = rounded(item.get("close"), DECIMALS)
        if after is not None and item["date"] <= after:
            continue
        month = table.get(shift_month(item["date"][:7], -EARNINGS_LAG_MONTHS))
        if month is None or close is None or close <= 0:
            break
        price, earnings = month
        out.append(
            {"adjClose": None, "close": 100 * earnings / price / close, "date": item["date"], "high": None,
             "low": None, "open": None, "seriesId": RATIO_ID}
        )
    return out


class _Probe:
    """The IBKR client for one unit: remembers its last error code; without a client every call fails
    at once (IBKR not configured, or switched off for the rest of the run)."""

    def __init__(self, ih: ModuleType, client: Any) -> None:
        self._ih = ih
        self._client = client
        self.code: str | None = None

    def _run(self, method: str, *args: Any, **options: Any) -> Any:
        if self._client is None:
            raise self._ih.IbkrHistoryError("NOT_CONFIGURED", "IBKR history is not used in this run")
        try:
            return getattr(self._client, method)(*args, **options)
        except self._ih.IbkrHistoryError as error:
            self.code = error.code
            raise

    def daily_bars(self, *args: Any, **options: Any) -> Any:
        return self._run("daily_bars", *args, **options)

    def paged(self, *args: Any, **options: Any) -> Any:
        return self._run("paged", *args, **options)


def yahoo_rows(symbol: str, start: str) -> list[dict[str, Any]]:
    """Yahoo daily rows from `start`: split-adjusted OHLC, the dividend-adjusted close, volume."""
    import yfinance as yf

    frame = yf.Ticker(symbol).history(start=start, interval="1d", auto_adjust=False)
    columns = {"open": "Open", "high": "High", "low": "Low", "close": "Close", "adj_close": "Adj Close", "volume": "Volume"}
    return [
        {"date": stamp.strftime("%Y-%m-%d"), **{key: float(record[column]) for key, column in columns.items() if column in record}}
        for stamp, record in frame.iterrows()
    ]


def fetch_unit(
    series_id: str, start: str, env: Mapping[str, str], use_ibkr: bool, yahoo: Any = yahoo_rows, transport: Any = None
) -> dict[str, Any]:
    """One unit's merged rows (runs inside ctx.up.helper): `{rows, errors, warnings, paced}`.

    IBKR first (no paced retry), then Yahoo. A paced IBKR answer is not replaced by Yahoo rows:
    `paced` is true and the rows are empty, so the unit keeps its source on the next run.
    """
    ih = research_module("ibkr_history", env)
    client = None
    if use_ibkr and ih.configured(env):
        client = ih.Client.from_env(env, paced_retries=0, timeout=IBKR_TIMEOUT_S, transport=transport)
    probe = _Probe(ih, client)
    symbol = yahoo_symbol(series_id)

    def fill() -> list[dict[str, Any]]:
        if probe.code == "PACED":
            raise ih.IbkrHistoryError("PACED", "IBKR paced the request")
        return yahoo(symbol, start)

    try:
        if series_id in row_rules.YIELD_INDEX_IDS:
            merged = ih.index_daily(symbol, fill, start=start, client=probe)
        else:
            adjust = "adj_close" if series_id in row_rules.ETF_IDS else "none"
            merged = ih.merged_daily(symbol, fill, start=start, adjust=adjust, client=probe)
    except ih.IbkrHistoryError as error:
        if error.code != "PACED":
            raise
        return {"errors": {}, "paced": True, "rows": [], "warnings": []}
    if probe.code == "PACED":
        # index_daily has a third source (Treasury), so a paced index unit raises nothing.
        return {"errors": {}, "paced": True, "rows": [], "warnings": []}
    fields = ("date", "open", "high", "low", "close", "adj_close", "volume", "source")
    # An adjusted close that IBKR carried over from another day is not a measured value: without
    # it the unit stops at that row (series_rows) and the next run reads the day again.
    rows = [{key: None if key == "adj_close" and row.get("adj_close_carried") else row.get(key) for key in fields} for row in merged.rows]
    return {"errors": merged.errors, "paced": False, "rows": rows, "warnings": merged.warnings}


def fetch_shiller(env: Mapping[str, str]) -> list[list[Any]]:
    """[month, price, earnings] rows of the Shiller workbook (runs inside ctx.up.helper)."""
    ih = research_module("ibkr_history", env)
    shiller = research_module("shiller", env)
    url = shiller.workbook_url(ih.public_get(shiller.PAGE_URL).decode("utf-8", "ignore"))
    return [list(row) for row in shiller.monthly_rows(ih.public_get(url))]


def _warn_cut(ctx: Context, name: str, newer: list[dict[str, Any]], kept: list[dict[str, Any]]) -> None:
    """A unit that stops before its last newer row says so: a row that never changes upstream would
    otherwise keep the series stale with run status ok."""
    if len(kept) < len(newer):
        ctx.warn(
            f"{name}: stopped at {newer[len(kept)]['date']} (the row cannot be stored: a missing or invalid price, "
            f"or no adjusted close); {len(newer) - len(kept)} rows not appended"
        )


async def _ratio(ctx: Context, usable: list[dict[str, Any]], stored: Mapping[str, Any] | None, sink: list[dict[str, Any]]) -> None:
    after = None if stored is None else stored["lastDate"]
    if not any(after is None or row["date"] > after for row in usable):
        return
    try:
        table = await ctx.up.helper("daily-prices:shiller", lambda: fetch_shiller(ctx.env))
    except UpstreamError as exc:
        ctx.failed("shiller workbook", exc)
        return
    ctx.take("shiller workbook", table, lambda: ratio_rows(usable, table, after), sink, expect_rows=False)
    # Shiller revises the newest months. The stored rows keep the figures of their fetch day, so a
    # revision shows as a step between the stored rows and the appended rows: say so once.
    again = [row for row in ratio_rows(usable, table, None) if stored is not None and row["date"] == after]
    if again and stored["close"] and abs(again[0]["close"] / stored["close"] - 1.0) > SEAM_TOLERANCE:
        ctx.warn(
            f"{RATIO_ID}: the Shiller figures changed since the stored rows ({after}: stored {stored['close']:.4f}, "
            f"now {again[0]['close']:.4f}); the appended rows use the new figures"
        )


async def daily_prices(ctx: Context) -> dict[str, list[dict[str, Any]]]:
    """IBKR / Yahoo daily rows of the finished sessions -> daily_series and daily_bars."""
    if ctx.symbols is not None:
        raise ArgumentError("daily-prices takes no --symbols")
    # Outside the upstream calls: a missing research folder is a configuration error (exit 2).
    research_module("ibkr_history", ctx.env)
    research_module("shiller", ctx.env)
    series_out = ctx.table("daily_series")
    bars_out = ctx.table("daily_bars")
    # Empty tables are normal: every unit is up to date, or no source has a newer row yet.
    ctx.nothing_new = True
    state = ctx.daily_prices_state
    if state is None:
        ctx.warn("daily-prices: no stored state (dry run): rows are not checked against stored rows")
    session = last_session(ctx.today)
    if session.year not in nyse_closures.YEARS:
        ctx.warn(f"daily-prices: the NYSE closure list does not cover {session.year}; extend jobs/nyse_closures.py")
    newest = session.isoformat()
    use_ibkr = True
    for series_id in UNITS:
        stored = None if state is None else state["series"].get(series_id)
        stored_bars = None if state is None else state["bars"].get(series_id)
        ratio = None if state is None else state["series"].get(RATIO_ID)
        if state is not None and stored is None:
            ctx.warn(f"{series_id}: no stored series, nothing is appended")
            continue
        if unit_done(stored, stored_bars, session):
            continue
        if ctx.deadline_at is not None and ctx.deadline_at - time.monotonic() < UNIT_RESERVE_S:
            break
        if series_id == "TNX" and state is not None and ratio is None:
            ctx.warn(f"{RATIO_ID}: no stored series, nothing is appended")
        lasts = [entry["lastDate"] for entry in (stored, stored_bars, ratio if series_id == "TNX" else None) if entry]
        first = date.fromisoformat(min(lasts)) - timedelta(days=OVERLAP_DAYS) if lasts else ctx.today - timedelta(days=DEFAULT_DAYS)
        start = min(first, ctx.since or first).isoformat()
        try:
            result = await ctx.up.helper(
                f"daily-prices:{series_id}:{start}:{'ibkr' if use_ibkr else 'yahoo'}",
                lambda s=series_id, d=start, i=use_ibkr: fetch_unit(s, d, ctx.env, i),
            )
        except UpstreamError as exc:
            ctx.failed(series_id, exc)
            continue
        if result["paced"]:
            break
        if result["errors"].get("ibkr"):
            use_ibkr = False  # the remaining units of this run go to Yahoo at once
        ctx.ok()
        for warning in result["warnings"]:
            ctx.warn(f"{series_id}: {warning}")
        usable = [row for row in result["rows"] if row["date"] <= newest]
        tolerance = FUTURE_SEAM_TOLERANCE if kind_of(series_id) == "future" else SEAM_TOLERANCE
        newer, seam, problem = after_seam(usable, stored, tolerance)
        if problem is not None:
            ctx.warn(f"{series_id}: {problem}; nothing is appended to the series")
        elif any(row.get("source") == "treasury" for row in usable):
            # Any Treasury row in the answer: no row of this unit is trusted, the ratio included.
            if newer:
                ctx.warn(f"{series_id}: the answer holds rows of the Treasury par yield fallback; nothing is appended")
        else:
            kept = series_rows(series_id, newer, seam, stored)
            series_out.extend(kept)
            _warn_cut(ctx, series_id, newer, kept)
            # The ratio is derived only from TNX rows that passed the stored-seam check in this run
            # (or in a dry run), and only for a stored ratio series.
            if series_id == "TNX" and (state is None or (seam is not None and ratio is not None)):
                await _ratio(ctx, usable, ratio, series_out)
        if series_id in row_rules.DAILY_BAR_SYMBOLS and (state is None or stored_bars is not None):
            bars_newer, _, bars_problem = after_seam(usable, stored_bars, tolerance)
            if bars_problem is not None:
                ctx.warn(f"{series_id} bars: {bars_problem}; nothing is appended to the bar series")
            else:
                kept = bar_rows(series_id, bars_newer)
                bars_out.extend(kept)
                _warn_cut(ctx, f"{series_id} bars", bars_newer, kept)
    return {"daily_series": series_out, "daily_bars": bars_out}
