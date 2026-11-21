"""Cboe jobs: vol index closes, VX futures curve, option IV / GEX snapshot."""

from __future__ import annotations

import csv
import io
import re
from datetime import date, timedelta
from typing import Any

from .. import options_math
from ..context import CORE7, ArgumentError, Context
from ..rows import VOL_INDEX_IDS
from ..upstream import UpstreamError
from ..values import iso_date, num, parse_day, rounded, weekdays

VX_MONTH_DIGITS = 7  # YYYY-MM
# CFE daily settlement file (all CFE futures of one session), used when the Cboe delayed-quotes
# path fails. Columns: Product, Symbol, Expiration Date, Price. Only the header line: no settlement
# for that day (weekend, holiday, or not yet published).
CFE_SETTLEMENT_URL = "https://www.cboe.com/us/futures/market_statistics/settlement/csv?dt={day}"
# Monthly VX contract, for example VX/Z6. Weekly contracts (VX47/X6) are left out, as in the Cboe curve.
CFE_VX_MONTHLY = re.compile(r"^VX/[FGHJKMNQUVXZ]\d$")
# How many calendar days before the session the fallback looks for the nearest settlement.
CFE_LOOKBACK_DAYS = 4
# Part of the run warning when the CFE file gave the rows. The Markets page looks for this exact text
# (OPENBB_CFE_FALLBACK_NOTE in packages/api/src/contracts/openbb.ts); tests on both sides pin it.
CFE_FALLBACK_NOTE = "used the CFE settlement file"


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
    date, which becomes asOf. --since earlier than today requests each weekday (backfill). When the
    Cboe call fails, the CFE daily settlement file gives the same monthly contracts.
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
            await _settlement_fallback(ctx, source, session, exc, rows)
            continue
        ctx.take(source, data, lambda d=data, s=session: curve_rows(s, d), rows)
    return {"vx_curve": rows}


def settlement_rows(session: date, text: str) -> list[dict[str, Any]]:
    """vx_curve rows of one CFE settlement file: the monthly VX contracts, one row per contract month."""
    by_month: dict[str, dict[str, Any]] = {}
    for item in csv.DictReader(io.StringIO(text)):
        symbol = (item.get("Symbol") or "").strip().upper()
        if (item.get("Product") or "").strip().upper() != "VX" or not CFE_VX_MONTHLY.fullmatch(symbol):
            continue
        expiration = iso_date((item.get("Expiration Date") or "").strip())
        if expiration is None:
            raise ValueError(f"no expiration date for {symbol}")
        price = rounded(item.get("Price"), 6)
        if price is None:  # no settlement price: not a row (the row schema would drop it later)
            continue
        month = expiration[:VX_MONTH_DIGITS]
        by_month[month] = {"asOf": session.isoformat(), "contractMonth": month, "price": price}
    return [by_month[month] for month in sorted(by_month)]


async def _settlement_fallback(
    ctx: Context, source: str, session: date, first: UpstreamError, rows: list[dict[str, Any]]
) -> None:
    """Read the VX curve of `session` from the CFE settlement file after the Cboe curve failed with `first`.

    Like the Cboe curve, it gives the nearest session: the newest file with VX rows among `session`
    and the CFE_LOOKBACK_DAYS days before it; asOf is the day of that file. With rows the source is
    ok and a warning names the file. In every other case the source fails with the Cboe error, so a
    blocked Cboe path stays `blocked`.
    """
    for back in range(CFE_LOOKBACK_DAYS + 1):
        day = session - timedelta(days=back)
        try:
            text = await ctx.up.http_text(CFE_SETTLEMENT_URL.format(day=day.isoformat()))
            found = settlement_rows(day, text or "")
        except (UpstreamError, ValueError, csv.Error) as exc:
            reason = exc.message if isinstance(exc, UpstreamError) else f"{type(exc).__name__}: {exc}"
            ctx.warn(f"{source}: CFE settlement file {day.isoformat()}: {reason}")
            break
        if found:
            ctx.take(source, found, lambda f=found: f, rows)
            ctx.warn(f"{source}: {first.message}; {CFE_FALLBACK_NOTE} of {day.isoformat()}")
            return
    else:
        ctx.warn(f"{source}: no CFE settlement file with VX rows in the {CFE_LOOKBACK_DAYS + 1} days up to {session.isoformat()}")
    ctx.failed(source, first)


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
