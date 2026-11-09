"""Cboe jobs: vol index closes, VX futures curve, option IV / GEX snapshot."""

from __future__ import annotations

from datetime import date
from typing import Any

from .. import options_math
from ..context import CORE7, ArgumentError, Context
from ..rows import VOL_INDEX_IDS
from ..upstream import UpstreamError
from ..values import iso_date, num, parse_day, rounded, weekdays

VX_MONTH_DIGITS = 7  # YYYY-MM


def index_rows(series_id: str, data: list[dict[str, Any]], first: str) -> list[dict[str, Any]]:
    rows = []
    for item in data:
        day = iso_date(item.get("date"))
        if day is None or day < first:
            continue
        rows.append(
            {
                "close": rounded(item.get("close"), 6),
                "date": day,
                "high": rounded(item.get("high"), 6),
                "low": rounded(item.get("low"), 6),
                "open": rounded(item.get("open"), 6),
                "seriesId": series_id,
            }
        )
    return rows


async def vol_indices(ctx: Context) -> dict[str, list[dict[str, Any]]]:
    """`index/price/historical` (cboe) for the 14 vol indices -> daily_series."""
    ids = ctx.symbol_list(VOL_INDEX_IDS)
    unknown = [s for s in ids if s not in VOL_INDEX_IDS]
    if unknown:
        raise ArgumentError(f"--symbols for cboe-vol-indices must be vol index ids, not {', '.join(unknown)}")
    start = ctx.start(10)
    rows = ctx.table("daily_series")
    for series_id in ids:
        params = {"symbol": series_id, "start_date": start.isoformat(), "end_date": ctx.today.isoformat(), "interval": "1d"}
        source = f"cboe {series_id}"
        try:
            data = await ctx.up.fetcher("cboe", "IndexHistorical", params)
        except UpstreamError as exc:
            if exc.kind == "empty":
                ctx.ok()
                ctx.warn(f"{source}: no closes since {start.isoformat()}")
                continue
            ctx.failed(source, exc)
            continue
        ctx.take(source, data, lambda d=data, s=series_id: index_rows(s, d, start.isoformat()), rows)
    return {"daily_series": rows}


def curve_rows(session: date, data: list[dict[str, Any]]) -> list[dict[str, Any]]:
    rows = []
    for item in data:
        as_of = iso_date(item.get("date")) or session.isoformat()
        month = str(item.get("expiration") or "")[:VX_MONTH_DIGITS]
        rows.append({"asOf": as_of, "contractMonth": month, "price": rounded(item.get("price"), 6)})
    return rows


async def vx_curve(ctx: Context) -> dict[str, list[dict[str, Any]]]:
    """`derivatives/futures/curve` (cboe, VX_EOD settlement levels by date) -> vx_curve.

    `obb.derivatives.futures.curve(symbol='VX')` rejects the symbol at this pin, so the Cboe fetcher
    is called directly. With a date it returns the curve of the nearest session and that session's
    date, which becomes asOf. --since earlier than today requests each weekday (backfill).
    """
    if ctx.symbols is not None:
        raise ArgumentError("cboe-vx-curve takes no --symbols")
    sessions = (weekdays(ctx.since, ctx.today) if ctx.since else []) or [ctx.today]
    rows = ctx.table("vx_curve")
    for session in sessions:
        source = f"cboe VX curve {session.isoformat()}"
        try:
            data = await ctx.up.fetcher("cboe", "FuturesCurve", {"symbol": "VX_EOD", "date": session.isoformat()})
        except UpstreamError as exc:
            if exc.kind == "empty":
                ctx.ok()
                continue
            ctx.failed(source, exc)
            continue
        ctx.take(source, data, lambda d=data, s=session: curve_rows(s, d), rows)
    return {"vx_curve": rows}


async def _cboe_chain(symbol: str) -> dict[str, Any]:
    """Raw Cboe delayed-quotes JSON through OpenBB's Cboe chains fetcher (URL and directory logic).

    The fetcher's own transform fails on SPY at this pin (non-OCC 'B1SPY...' rows give a NaN
    expiration), so only its extract step is used and the rows are parsed in options_math.
    """
    from openbb_cboe.models.options_chains import CboeOptionsChainsFetcher

    query = CboeOptionsChainsFetcher.transform_query({"symbol": symbol})
    return await CboeOptionsChainsFetcher.aextract_data(query, {})


def chain_rows(ctx: Context, symbol: str, payload: Any) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """(daily rows, term rows) of one Cboe chain payload (ValueError when it has no price/options)."""
    data = (payload or {}).get("data") or {}
    spot = num(data.get("current_price")) or num(data.get("close"))
    options = data.get("options") or []
    if spot is None or spot <= 0 or not options:
        raise ValueError("no underlying price or no options")
    as_of = _as_of(data.get("last_trade_time"), ctx.today)
    contracts, skipped = options_math.parse_contracts(options, as_of)
    if skipped:
        ctx.warn(f"cboe chain {symbol}: skipped {skipped} rows without a standard OCC symbol")
    if not contracts:
        ctx.warn(f"cboe chain {symbol}: no unexpired contracts")
        return [], []
    day_row, term_rows = options_math.summarize(symbol, as_of, spot, contracts)
    return [day_row], term_rows


async def option_iv(ctx: Context) -> dict[str, list[dict[str, Any]]]:
    """Cboe delayed option chains (Core 7 by default) -> option_iv_daily, option_iv_term."""
    if ctx.since is not None and ctx.since != ctx.today:
        raise ArgumentError("cboe-option-iv is a snapshot of the current Cboe chain; --since is not supported")
    daily = ctx.table("option_iv_daily")
    term = ctx.table("option_iv_term")
    for symbol in ctx.symbol_list(CORE7):
        source = f"cboe chain {symbol}"
        try:
            payload = await ctx.up.helper(f"cboe:options_chain:{symbol}", lambda s=symbol: _cboe_chain(s))
        except UpstreamError as exc:
            ctx.failed(source, exc)
            continue

        def build(p: Any = payload, s: str = symbol) -> list[dict[str, Any]]:
            day_rows, term_rows = chain_rows(ctx, s, p)
            term.extend(term_rows)
            return day_rows

        ctx.take(source, [payload], build, daily, expect_rows=False)
    return {"option_iv_daily": daily, "option_iv_term": term}


def _as_of(last_trade_time: Any, today: date) -> date:
    text = iso_date(last_trade_time)
    if text is None:
        return today
    day = parse_day(text)
    return day if day <= today else today
