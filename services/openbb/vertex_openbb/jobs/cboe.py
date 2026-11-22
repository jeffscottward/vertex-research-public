"""Cboe jobs: vol index closes, VX futures curve, option IV / GEX snapshot."""

from __future__ import annotations

import csv
import io
import math
import re
import time
from collections.abc import Callable
from datetime import date, datetime, timedelta
from typing import Any

from .. import options_math, yahoo_chains
from ..context import CORE7, ArgumentError, Context
from ..rows import VOL_INDEX_IDS
from ..upstream import UpstreamError
from ..values import iso_date, num, parse_day, rounded, weekdays

VX_MONTH_DIGITS = 7  # YYYY-MM
VX_MONTH_PATTERN = re.compile(r"^\d{4}-(?:0[1-9]|1[0-2])$", re.ASCII)
# Maximum relative price difference from an adjacent contract month before a VX curve point is
# dropped as an outlier (2026-11-19: Cboe VX_EOD returned 15.9 for 2027-08 next to 24.6 for 2027-07).
VX_CURVE_MAX_NEIGHBOR_DIFF = 0.20
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
# Part of the run warning when the Yahoo chain gave the rows. The Markets page looks for this exact
# text (OPENBB_YAHOO_FALLBACK_NOTE in packages/api/src/contracts/openbb.ts); tests on both sides pin it.
YAHOO_FALLBACK_NOTE = "used the Yahoo option chain"
# A Yahoo helper call starts only when at least this many seconds remain to the job deadline
# (one full CALL_TIMEOUT_S = 90 s call plus margin). The gate counts all elapsed job time, so
# slow Cboe probes consume the same clock. See the plan's accepted slow-Cboe regression case.
YAHOO_FALLBACK_RESERVE_S = 100.0


def index_rows(series_id: str, data: list[dict[str, Any]], first: str) -> list[dict[str, Any]]:
    rows = []
    for item in data:
        day = iso_date(item.get("date"))
        if day is None or day < first:
            continue
        rows.append(
            {
                "adjClose": None,
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


def _is_valid_curve_row(row: dict[str, Any]) -> bool:
    price = row.get("price")
    return (
        isinstance(price, (int, float))
        and not isinstance(price, bool)
        and math.isfinite(price)
        and price > 0
        and bool(VX_MONTH_PATTERN.fullmatch(str(row.get("contractMonth") or "")))
    )


def filter_curve_outliers(
    rows: list[dict[str, Any]],
    warn: Callable[[str], None] | None = None,
    *,
    limit: float = VX_CURVE_MAX_NEIGHBOR_DIFF,
    drop: bool = True,
) -> list[dict[str, Any]]:
    """Drop VX curve rows deviating more than `limit` from adjacent contract months (curves of 3+).

    Interior months that differ from both neighbours and back months that differ from the month before
    are dropped with a warning. The front month is never dropped: a front month far above the second
    month is real backwardation in a stress regime, so it only gets a warning. With `drop=False`
    (official CFE settlements) every outlier is kept and only warned about.
    """
    groups: dict[str, list[dict[str, Any]]] = {}
    for row in rows:
        groups.setdefault(str(row.get("asOf") or ""), []).append(row)
    kept: list[dict[str, Any]] = []
    pct_limit = int(round(limit * 100))

    def note(action: str, as_of: str, row: dict[str, Any], detail: str) -> None:
        if warn is not None:
            price = float(row["price"])
            warn(f"cboe VX curve {as_of}: {action} outlier {row['contractMonth']} at {price} ({detail}, limit {pct_limit}%)")

    def differs(row: dict[str, Any], neighbour: dict[str, Any]) -> tuple[float, str]:
        p_row, p_neighbour = float(row["price"]), float(neighbour["price"])
        diff = abs(p_row - p_neighbour) / p_neighbour
        return diff, f"differs {diff * 100:.1f}% from {neighbour['contractMonth']} at {p_neighbour}"

    action = "dropped" if drop else "kept"
    for as_of, group in groups.items():
        valid_by_month: dict[str, dict[str, Any]] = {}
        passthrough: list[dict[str, Any]] = []
        for row in group:
            if _is_valid_curve_row(row):
                valid_by_month[row["contractMonth"]] = row
            else:
                passthrough.append(row)
        ordered = [valid_by_month[month] for month in sorted(valid_by_month)]
        if len(ordered) == 2:
            p0, p1 = float(ordered[0]["price"]), float(ordered[1]["price"])
            diff = abs(p1 - p0) / min(p0, p1)
            if diff > limit and warn is not None:
                warn(
                    f"cboe VX curve {as_of}: two-contract mismatch {ordered[0]['contractMonth']}={p0} vs "
                    f"{ordered[1]['contractMonth']}={p1} ({diff * 100:.1f}%, limit {pct_limit}%); both kept"
                )
        elif len(ordered) >= 3:
            full = ordered
            # Interior pass: compare with the last kept month, so one dropped month never condemns its neighbour.
            after_interior: list[dict[str, Any]] = [ordered[0]]
            for idx in range(1, len(ordered) - 1):
                cur_row, next_row = ordered[idx], ordered[idx + 1]
                diff_prev, text_prev = differs(cur_row, after_interior[-1])
                diff_next, text_next = differs(cur_row, next_row)
                if diff_prev > limit and diff_next > limit:
                    note(action, as_of, cur_row, f"{text_prev} and {text_next}")
                    continue
                after_interior.append(cur_row)
            after_interior.append(ordered[-1])
            ordered = after_interior
            # Back end: a newly listed back month can carry a far-off quote (2026-11-19); drop it while 3+ remain.
            while len(ordered) >= 3:
                diff_back, text_back = differs(ordered[-1], ordered[-2])
                if diff_back <= limit:
                    break
                note(action, as_of, ordered[-1], text_back)
                ordered.pop()
            # Front end: warn only; never drop the front month.
            diff_front, text_front = differs(ordered[0], ordered[1])
            if diff_front > limit:
                note("kept", as_of, ordered[0], text_front)
            # Warn-only mode (drop=False) checked against the filtered curve but keeps every month.
            if not drop:
                ordered = full
        kept.extend(ordered)
        kept.extend(passthrough)
    return kept


def curve_rows(
    session: date,
    data: list[dict[str, Any]],
    warn: Callable[[str], None] | None = None,
) -> list[dict[str, Any]]:
    rows = []
    for item in data:
        as_of = iso_date(item.get("date")) or session.isoformat()
        month = str(item.get("expiration") or "")[:VX_MONTH_DIGITS]
        rows.append({"asOf": as_of, "contractMonth": month, "price": rounded(item.get("price"), 6)})
    return filter_curve_outliers(rows, warn=warn)


async def vx_curve(ctx: Context) -> dict[str, list[dict[str, Any]]]:
    """`derivatives/futures/curve` (cboe, VX_EOD quotes by date) -> vx_curve.

    `obb.derivatives.futures.curve(symbol='VX')` rejects the symbol at this pin, so the Cboe fetcher
    is called directly. For today's date, OpenBB's Cboe fetcher reads delayed `last_price` quotes
    (not CFE official settlements); for prior dates it reads historical daily closes. With a date it
    returns the curve of the nearest session and that session's date, which becomes asOf. --since
    earlier than today requests each weekday (backfill). When the Cboe call fails, the CFE daily
    settlement file gives the same monthly contracts.
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
        ctx.take(source, data, lambda d=data, s=session: curve_rows(s, d, warn=ctx.warn), rows)
    return {"vx_curve": rows}


def settlement_rows(
    session: date,
    text: str,
    warn: Callable[[str], None] | None = None,
) -> list[dict[str, Any]]:
    """vx_curve rows of one CFE settlement file: the monthly VX contracts, one row per contract month.

    Settlements are official CFE prices, so outliers are only warned about and never dropped.
    """
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
    return filter_curve_outliers([by_month[month] for month in sorted(by_month)], warn=warn, drop=False)


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
            found = settlement_rows(day, text or "", warn=ctx.warn)
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
    """Cboe delayed option chains (Core 7 by default) -> option_iv_daily, option_iv_term.

    When a symbol's Cboe call fails (any failure except `empty`, the CFE pattern), the Yahoo
    chain is the second source: same tables, a warning with YAHOO_FALLBACK_NOTE, run `partial`.
    The session guard skips the re-fetch when the newest run already stored Yahoo rows for this
    New York session; the fallback gate skips it when less than YAHOO_FALLBACK_RESERVE_S remains
    to the job deadline. When Yahoo also fails, the source fails with the Cboe error, so a
    blocked Cboe path stays `blocked_upstream`.
    """
    if ctx.since is not None and ctx.since != ctx.today:
        raise ArgumentError("cboe-option-iv is a snapshot of the current Cboe chain; --since is not supported")
    daily = ctx.table("option_iv_daily")
    term = ctx.table("option_iv_term")
    stored = _yahoo_stored_symbols(ctx)
    for symbol in ctx.symbol_list(CORE7):
        source = f"cboe chain {symbol}"
        try:
            payload = await ctx.up.helper(f"cboe:options_chain:{symbol}", lambda s=symbol: _cboe_chain(s))
        except UpstreamError as exc:
            if exc.kind == "empty":
                ctx.failed(source, exc)
                continue
            await _yahoo_fallback(ctx, source, symbol, exc, symbol in stored, daily, term)
            continue

        def build(p: Any = payload, s: str = symbol) -> list[dict[str, Any]]:
            day_rows, term_rows = chain_rows(ctx, s, p)
            term.extend(term_rows)
            return day_rows

        ctx.take(source, [payload], build, daily, expect_rows=False)
    return {"option_iv_daily": daily, "option_iv_term": term}


def _yahoo_stored_symbols(ctx: Context) -> frozenset[str]:
    """The symbols whose Yahoo rows are already stored for this New York session.

    Reads the tick's state (the newest run's summary): its start time on the current New York
    date and the per-symbol warnings. A first-use marker (`...; used the Yahoo option chain
    (IV: ...)`) counts only when that run persisted EVERY row it received
    (`rowsWritten == rowsReceived > 0`): the tick records the document warnings even when
    ingest chunks failed (a partial write leaves missing rows), and an incomplete write must
    not silence the next fetch. The explicit carry-forward warning
    (`... earlier this session; skipped the re-fetch`) counts on its own: it is only ever
    written after a fully stored run, and it keeps the guard alive across zero-row skip runs.
    Only marked symbols are guarded; a newly blocked symbol of a mixed run still fetches.
    A manual run passes no state.
    """
    state = ctx.option_iv_state
    if not isinstance(state, dict):
        return frozenset()
    try:
        started_day = datetime.fromisoformat(str(state.get("startedAt")).replace("Z", "+00:00"))
    except ValueError:
        return frozenset()
    if started_day.astimezone(yahoo_chains.NEW_YORK).date() != ctx.today:
        return frozenset()
    received = state.get("rowsReceived") or 0
    wrote_all = received > 0 and (state.get("rowsWritten") or 0) == received
    stored = set()
    for warning in state.get("warnings") or []:
        text = str(warning)
        if YAHOO_FALLBACK_NOTE not in text:
            continue
        match = re.match(r"^cboe chain ([A-Z0-9.^=-]{1,16}):", text)
        if match is None:
            continue
        if "skipped the re-fetch" in text or wrote_all:
            stored.add(match[1])
    return frozenset(stored)


def _gate_open(ctx: Context) -> bool:
    """True when a Yahoo helper call may start (enough time left to the job deadline)."""
    if ctx.deadline_at is None:
        return True
    return ctx.deadline_at - time.monotonic() >= YAHOO_FALLBACK_RESERVE_S


async def _yahoo_fallback(
    ctx: Context,
    source: str,
    symbol: str,
    first: UpstreamError,
    stored: bool,
    daily: list[dict[str, Any]],
    term: list[dict[str, Any]],
) -> None:
    """Read one symbol's chain from Yahoo after the Cboe call failed with `first` (CFE pattern).

    With rows the source is ok and a warning names the source. In every other case the source
    fails with the Cboe error (never the Yahoo error: a Yahoo `error`-kind failure would flip a
    blocked run to `failed`).
    """
    if stored:
        # This session's Yahoo rows are already stored; nothing new to write. The warning keeps
        # the marker so the run stays `partial`, the panel keeps the source note, and the NEXT
        # run's session guard still sees this symbol (the guard reads the newest run's warnings).
        ctx.ok()
        ctx.warn(f"{source}: {YAHOO_FALLBACK_NOTE} earlier this session; skipped the re-fetch")
        return
    if not _gate_open(ctx):
        ctx.warn(f"{source}: less than {YAHOO_FALLBACK_RESERVE_S:g} s to the job deadline; skipped the Yahoo fallback")
        ctx.failed(source, first)
        return
    try:
        payload = await ctx.up.helper(f"yahoo:options_chain:{symbol}", lambda s=symbol: yahoo_chains.fetch_symbol(s))
    except UpstreamError as exc:
        ctx.warn(f"{source}: yahoo chain: {exc.message}")
        ctx.failed(source, first)
        return

    def build(p: Any = payload, s: str = symbol) -> list[dict[str, Any]]:
        as_of = yahoo_chains.quote_day(p, ctx.today)
        spot, contracts, skipped, missing = yahoo_chains.contracts_of(p, as_of)
        if skipped:
            ctx.warn(f"{source}: skipped {skipped} Yahoo rows without a standard OCC symbol or strike")
        if missing:
            ctx.warn(f"{source}: {missing} Yahoo expirations returned no chain")
        if not contracts:
            raise ValueError("no unexpired contracts")
        day_row, term_rows = options_math.summarize(s, as_of, spot, contracts)
        term.extend(term_rows)
        ctx.warn(
            f"{source}: {first.message}; {YAHOO_FALLBACK_NOTE} "
            "(IV: Yahoo column; greeks: Black-Scholes, rate 4%, trailing dividend yield)"
        )
        return [day_row]

    try:
        rows = build()
    except (ValueError, KeyError, TypeError) as exc:
        # A bad Yahoo payload fails the source with the CBOE error (the blocked classification
        # stays); ctx.take would report the payload error as a plain failure instead.
        ctx.warn(f"{source}: yahoo chain: could not read the payload ({type(exc).__name__}: {exc})")
        ctx.failed(source, first)
        return
    ctx.ok()
    daily.extend(rows)


def _as_of(last_trade_time: Any, today: date) -> date:
    text = iso_date(last_trade_time)
    if text is None:
        return today
    day = parse_day(text)
    return day if day <= today else today
