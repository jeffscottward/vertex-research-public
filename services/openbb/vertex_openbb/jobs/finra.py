"""FINRA jobs: weekly OTC (ATS / non-ATS) volume, short interest, Reg SHO daily short volume."""

from __future__ import annotations

from datetime import timedelta
from typing import Any

from ..context import Context
from ..upstream import UpstreamError
from ..values import count, iso_date, rounded, weekdays

REGSHO_URL = "https://cdn.finra.org/equity/regsho/daily/CNMSshvol{day}.txt"
OTC_TIERS = ("T1", "T2")


def otc_rows(symbol: str, tier: str, venue: str, data: list[dict[str, Any]], first: str) -> list[dict[str, Any]]:
    rows = []
    for item in data:
        week = iso_date(item.get("week_start_date"))
        if week is None or week < first:
            continue
        rows.append(
            {
                "lastUpdated": iso_date(item.get("update_date")),
                "shares": count(item.get("share_quantity")),
                "symbol": symbol,
                "tier": tier,
                "trades": count(item.get("trade_quantity")),
                "venue": venue,
                "weekStart": week,
            }
        )
    return rows


async def otc(ctx: Context) -> dict[str, list[dict[str, Any]]]:
    """`equity/darkpool/otc` (finra): ATS and non-ATS weekly volume per symbol (NMS Tier 1, else 2)."""
    first = ctx.start(56).isoformat()
    rows = ctx.table("finra_otc_weekly")
    for symbol in ctx.symbol_list(ctx.core_and_stocks):
        found = False
        for tier in OTC_TIERS:
            for venue, is_ats in (("ats", True), ("non_ats", False)):
                params = {"symbol": symbol, "tier": tier, "is_ats": is_ats}
                try:
                    data = await ctx.up.fetcher("finra", "OTCAggregate", params)
                except UpstreamError as exc:
                    if exc.kind == "empty":
                        ctx.ok()
                        continue
                    ctx.failed(f"finra otc {symbol} {tier} {venue}", exc)
                    continue
                found = True
                ctx.take(
                    f"finra otc {symbol} {tier} {venue}",
                    data,
                    lambda d=data, t=tier, v=venue: otc_rows(symbol, t, v, d, first),
                    rows,
                )
            if found:
                break
        if not found:
            ctx.warn(f"finra otc {symbol}: no OTC volume in tier 1 or 2")
    return {"finra_otc_weekly": rows}


def short_interest_rows(symbol: str, data: list[dict[str, Any]], first: str) -> list[dict[str, Any]]:
    rows = []
    for item in data:
        day = iso_date(item.get("settlement_date"))
        if day is None or day < first:
            continue
        rows.append(
            {
                "avgDailyVolume": count(item.get("avg_daily_volume")),
                "daysToCover": rounded(item.get("days_to_cover"), 4),
                "previousShortInterest": count(item.get("previous_short_position")),
                "settlementDate": day,
                "shortInterest": count(item.get("current_short_position")),
                "symbol": symbol,
            }
        )
    return rows


async def short_interest(ctx: Context) -> dict[str, list[dict[str, Any]]]:
    """`equity/shorts/short_interest` (finra), twice-monthly settlement dates."""
    first = ctx.start(60).isoformat()
    rows = ctx.table("short_interest")
    for symbol in ctx.symbol_list(ctx.core_and_stocks):
        try:
            data = await ctx.up.fetcher("finra", "EquityShortInterest", {"symbol": symbol})
        except UpstreamError as exc:
            if exc.kind == "empty":
                ctx.ok()
                ctx.warn(f"finra short interest {symbol}: no data")
                continue
            ctx.failed(f"finra short interest {symbol}", exc)
            continue
        ctx.take(f"finra short interest {symbol}", data, lambda d=data, s=symbol: short_interest_rows(s, d, first), rows)
    return {"short_interest": rows}


def parse_regsho(text: str, symbols: set[str]) -> list[dict[str, Any]]:
    """`Date|Symbol|ShortVolume|ShortExemptVolume|TotalVolume|Market` (volumes may be fractional)."""
    rows = []
    lines = text.splitlines()
    if not lines:
        return rows
    header = [h.strip().lower() for h in lines[0].split("|")]
    index = {name: i for i, name in enumerate(header)}
    needed = ("date", "symbol", "shortvolume", "shortexemptvolume", "totalvolume")
    if any(name not in index for name in needed):
        raise ValueError(f"unexpected Reg SHO header: {lines[0][:200]}")
    for line in lines[1:]:
        parts = line.split("|")
        if len(parts) < len(header):
            continue
        symbol = parts[index["symbol"]].strip()
        if symbol not in symbols:
            continue
        rows.append(
            {
                "date": iso_date(parts[index["date"]].strip()),
                "shortExemptVolume": count(parts[index["shortexemptvolume"]]),
                "shortVolume": count(parts[index["shortvolume"]]),
                "symbol": symbol,
                "totalVolume": count(parts[index["totalvolume"]]),
            }
        )
    return rows


async def short_volume(ctx: Context) -> dict[str, list[dict[str, Any]]]:
    """FINRA Reg SHO consolidated NMS daily short volume file (not in OpenBB); holidays skipped."""
    symbols = set(ctx.symbol_list(ctx.core_and_stocks))
    start = ctx.start(10)
    rows = ctx.table("short_volume_daily")
    missing = []
    for day in weekdays(start, ctx.today):
        url = REGSHO_URL.format(day=day.strftime("%Y%m%d"))
        try:
            text = await ctx.up.http_text(url)
        except UpstreamError as exc:
            ctx.failed(f"finra regsho {day.isoformat()}", exc)
            continue
        if text is None:
            ctx.ok()
            missing.append(day.isoformat())
            continue
        ctx.take(f"finra regsho {day.isoformat()}", text.splitlines()[1:], lambda t=text: parse_regsho(t, symbols), rows)
    if missing:
        recent = ctx.today - timedelta(days=1)
        older = [d for d in missing if d < recent.isoformat()]
        if older:
            ctx.warn(f"finra regsho: no file for {', '.join(older)} (holiday or not published)")
    return {"short_volume_daily": rows}
