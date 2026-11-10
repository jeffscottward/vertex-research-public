"""U.S. Treasury job: TGA balance (Daily Treasury Statement) and auction results (TreasuryDirect)."""

from __future__ import annotations

from typing import Any

from ..context import ArgumentError, Context
from ..upstream import UpstreamError
from ..values import label, num
from .fed import td_auction_date, td_list
from .macro import point

TGA_CLOSING = "Treasury General Account (TGA) Closing Balance (Open Today)"
TD_AUCTIONED = "https://www.treasurydirect.gov/TA_WS/securities/auctioned?format=json&days={days}"


def tga_rows(statements: list[dict[str, Any]], first: str) -> list[dict[str, Any]]:
    rows = []
    for item in statements:
        value = num(item.get(TGA_CLOSING))
        row = point("TGA", item.get("date"), value, 2)
        if value is not None and row["date"] and row["date"] >= first:
            rows.append(row)
    return rows


def td_result_rows(items: list[dict[str, Any]], first: str) -> list[dict[str, Any]]:
    """TreasuryDirect auctioned securities (rates in percent) -> treasury_auction_result events."""
    rows = []
    for item in items:
        day = td_auction_date(item)
        cusip = str(item.get("cusip") or "").strip()
        bid_to_cover = num(item.get("bidToCoverRatio"))
        if day is None or not cusip or day < first or bid_to_cover is None:
            continue
        term = label(item.get("securityTerm"), 60) or ""
        kind_name = label(item.get("securityType"), 40) or "security"
        details = []
        for key, name in (("highYield", "high yield"), ("highRate", "high discount rate"),
                          ("highInvestmentRate", "high investment rate"), ("interestRate", "coupon")):
            value = num(item.get(key))
            if value is not None:
                details.append(f"{name} {value:.3f}%")
        details.append(f"bid-to-cover {bid_to_cover:.2f}")
        for key, name in (("offeringAmount", "offered"), ("totalAccepted", "accepted")):
            amount = num(item.get(key))
            if amount:
                details.append(f"{name} ${amount / 1e9:,.1f} bn")
        details.append(f"CUSIP {cusip}")
        rows.append(
            {
                "date": day,
                "detail": "; ".join(details),
                "eventKey": f"auction-result:{cusip}:{day}",
                "kind": "treasury_auction_result",
                "source": "us_treasury",
                "time": None,
                "title": f"{term} {kind_name} auction results".strip(),
            }
        )
    return rows


async def tga(ctx: Context) -> dict[str, list[dict[str, Any]]]:
    if ctx.symbols is not None:
        raise ArgumentError("treasury-tga takes no --symbols")
    start = ctx.start(30)
    first = start.isoformat()
    window = {"start_date": first, "end_date": ctx.today.isoformat()}
    macro = ctx.table("macro_points")
    events = ctx.table("event_calendar")
    source = "ustreasury daily_statement"
    try:
        statements = await ctx.up.fetcher("us_treasury", "DailyTreasuryStatement", {"table": "operating_cash_balance", **window})
        ctx.take(source, statements, lambda: tga_rows(statements, first), macro)
    except UpstreamError as exc:
        if exc.kind == "empty":
            ctx.ok()
            ctx.warn(f"{source}: no statements in the window")
        else:
            ctx.failed(source, exc)
    # Auction results from TreasuryDirect's own feed (fiscaldata lags; see fed.events).
    days = max((ctx.today - start).days, 1)
    source = "treasurydirect auctioned"
    try:
        text = await ctx.up.http_text(TD_AUCTIONED.format(days=days))
        ctx.take(source, [text] if text else [], lambda: td_result_rows(td_list(text), first), events, expect_rows=False)
    except UpstreamError as exc:
        ctx.failed(source, exc)
    return {"macro_points": macro, "event_calendar": events}
