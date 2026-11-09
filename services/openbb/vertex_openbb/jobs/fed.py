"""Federal Reserve jobs: policy/funding rates, regime indicators and the event calendar."""

from __future__ import annotations

import json
from collections.abc import Callable
from datetime import date
from typing import Any

from ..context import ArgumentError, Context
from ..upstream import UpstreamError
from ..values import clock, iso_date, label, num, plain_text, slug
from .macro import percent_point, point

FED = "federal_reserve"
TREASURY_COLUMNS = (
    ("month_1", "UST1M"), ("month_3", "UST3M"), ("month_6", "UST6M"), ("year_1", "UST1Y"),
    ("year_2", "UST2Y"), ("year_5", "UST5Y"), ("year_10", "UST10Y"), ("year_30", "UST30Y"),
)
TD_UPCOMING = "https://www.treasurydirect.gov/TA_WS/securities/upcoming?format=json"

Rows = list[dict[str, Any]]


def _no_symbols(ctx: Context) -> None:
    if ctx.symbols is not None:
        raise ArgumentError(f"{ctx.job} takes no --symbols")


def _keep(rows: Rows, start: date) -> Rows:
    """Points with a value and a date on/after start."""
    first = start.isoformat()
    return [r for r in rows if r["value"] is not None and r["date"] is not None and r["date"] >= first]


async def _source(
    ctx: Context, source: str, provider: str, model: str, params: dict[str, Any], build: Callable[[Rows], Rows], sink: Rows,
    *, expect_rows: bool = True,
) -> None:
    """Fetch one OpenBB source and add its rows (failure and no-data handled per source)."""
    try:
        data = await ctx.up.fetcher(provider, model, params)
    except UpstreamError as exc:
        if exc.kind == "empty":
            ctx.ok()
            ctx.warn(f"{source}: no data for the window")
            return
        ctx.failed(source, exc)
        return
    ctx.take(source, data, lambda: build(data), sink, expect_rows=expect_rows)


async def rates(ctx: Context) -> dict[str, Rows]:
    """EFFR, SOFR, OBFR and H.15 Treasury constant maturities (federal_reserve) -> macro_points."""
    _no_symbols(ctx)
    start = ctx.start(30)
    window = {"start_date": start.isoformat(), "end_date": ctx.today.isoformat()}
    rows = ctx.table("macro_points")
    for series_id, model in (("EFFR", "FederalFundsRate"), ("SOFR", "SOFR"), ("OBFR", "OvernightBankFundingRate")):
        await _source(
            ctx, f"federal_reserve {series_id}", FED, model, window,
            lambda d, s=series_id: _keep([percent_point(s, i.get("date"), i.get("rate")) for i in d], start), rows,
        )
    await _source(
        ctx, "federal_reserve treasury_rates", FED, "TreasuryRates", window,
        lambda d: _keep([percent_point(s, i.get("date"), i.get(c)) for i in d for c, s in TREASURY_COLUMNS], start), rows,
    )
    return {"macro_points": rows}


def nowcast_points(data: Rows) -> Rows:
    """NY Fed nowcast: per date, the newest reference quarter's nowcast."""
    latest: dict[str, tuple[str, Any]] = {}
    for item in data:
        day = iso_date(item.get("date"))
        quarter = str(item.get("reference_quarter") or "")
        if day and num(item.get("nowcast")) is not None and (day not in latest or quarter > latest[day][0]):
            latest[day] = (quarter, item.get("nowcast"))
    return [point("NY_GDP_NOWCAST", day, value) for day, (_, value) in latest.items()]


async def regime(ctx: Context) -> dict[str, Rows]:
    """NFCI/ANFCI (FRED), KC FSI, NY nowcast / GSCPI / CBDI, Cleveland CPI nowcast, SOMA -> macro_points.

    NFCI and ANFCI come from keyless FRED (fredgraph.csv): OpenBB's Chicago Fed route stops at
    2026-04-24 while the Chicago Fed publishes weekly. The Atlanta Fed GDPNow and market-probability
    feeds answer 404 upstream at this pin and are not part of the job.
    """
    _no_symbols(ctx)
    start = ctx.start(400)
    window = {"start_date": start.isoformat(), "end_date": ctx.today.isoformat()}
    rows = ctx.table("macro_points")

    from .series import FRED_CSV, parse_fred_csv

    for series_id in ("NFCI", "ANFCI"):
        source = f"fred {series_id}"
        try:
            text = await ctx.up.http_text(FRED_CSV.format(fred_id=series_id, start=start.isoformat()))
        except UpstreamError as exc:
            ctx.failed(source, exc)
            continue
        if text is None:
            ctx.failed(source, UpstreamError("not_found", "fredgraph.csv answered 403/404"))
            continue
        ctx.take(source, text.splitlines()[1:], lambda t=text, s=series_id: parse_fred_csv(s, t, start.isoformat()), rows)

    def keep(build: Callable[[Rows], Rows]) -> Callable[[Rows], Rows]:
        return lambda d: _keep(build(d), start)

    sources: list[tuple[str, str, dict[str, Any], Callable[[Rows], Rows]]] = [
        ("kc financial_stress_index", "FederalReserveKansasCityFinancialStress", window,
         lambda d: [point("KCFSI", i.get("date"), i.get("kcfsi")) for i in d]),
        ("ny nowcast", "FederalReserveNewYorkNowcast", window, nowcast_points),
        ("ny supply_chain_pressure", "FederalReserveNewYorkSupplyChain", window,
         lambda d: [point("GSCPI", i.get("date"), i.get("gscpi")) for i in d]),
        ("ny corporate_bond_distress", "FederalReserveNewYorkCorporateDistress", window,
         lambda d: [point(s, i.get("date"), i.get(c)) for i in d
                    for s, c in (("CBDI", "market"), ("CBDI_IG", "investment_grade"), ("CBDI_HY", "high_yield"))]),
        ("cleveland inflation_nowcast", "FederalReserveClevelandInflationNowcast", {"frequency": "month", **window},
         lambda d: [point(s, i.get("date"), i.get(c)) for i in d
                    for s, c in (("CLEV_CPI_NOWCAST", "CPI Inflation"), ("CLEV_CORE_CPI_NOWCAST", "Core CPI Inflation"))]),
        ("central_bank_holdings", "CentralBankHoldings", {"summary": True},
         lambda d: [point("SOMA_TOTAL", i.get("date"), i.get("total"), 2) for i in d]),
    ]
    for source, model, params, build in sources:
        await _source(ctx, source, FED, model, params, keep(build), rows)
    return {"macro_points": rows}


# Federal Reserve events calendar (OpenBB helper openbb_federal_reserve.utils.fomc_calendar):
# event type -> kind. FOMC entries are split by title.
_CALENDAR_KINDS = {"Beige": "beige_book", "Testimony": "fed_testimony"}
_FOMC_KINDS = (("press conference", "fomc_press_conference"), ("minutes", "fomc_minutes"), ("meeting", "fomc_meeting"))


def _fed_calendar() -> Rows:
    from openbb_federal_reserve.utils.fomc_calendar import _fetch_calendar_events

    return _fetch_calendar_events()


def _fomc_kind(title: str) -> str:
    lowered = title.lower()
    for needle, kind in _FOMC_KINDS:
        if needle in lowered:
            return kind
    return "fomc_event"


def calendar_rows(events: Rows, first: str) -> Rows:
    """Fed events calendar -> FOMC / Beige Book / testimony events.

    The feed has no event id; the key is kind + date (+ the listed time), so a retitled event keeps
    its key.
    """
    from openbb_federal_reserve.utils.fomc_calendar import _event_date

    rows = []
    for event in events:
        kind_type = event.get("type")
        if kind_type == "FOMC":
            kind = _fomc_kind(str(event.get("title") or ""))
        elif kind_type in _CALENDAR_KINDS:
            kind = _CALENDAR_KINDS[kind_type]
        else:
            continue
        day = _event_date(event)
        title = label(event.get("title"), 300)
        if day is None or title is None or day.isoformat() < first:
            continue
        time = clock(event.get("time"))
        rows.append(
            {
                "date": day.isoformat(),
                "detail": plain_text(event.get("description"), 2000),
                "eventKey": f"fedcal:{kind}:{day.isoformat()}" + (f":{time}" if time else ""),
                "kind": kind,
                "source": FED,
                "time": time,
                "title": title,
            }
        )
    return rows


def release_rows(schedule: Rows, first: str) -> Rows:
    """Fed statistical release calendar; key = date + release code (H.15, G.17, ...)."""
    rows = []
    for item in schedule:
        day = iso_date(item.get("date"))
        title = label(item.get("title"), 300)
        if day is None or title is None or day < first:
            continue
        code = str(item.get("release") or title.split(" - ")[0])
        rows.append(
            {
                "date": day,
                "detail": None,
                "eventKey": f"fedrel:{day}:{slug(code)}",
                "kind": "fed_release",
                "source": FED,
                "time": clock(item.get("time")),
                "title": title,
            }
        )
    return rows


def document_rows(documents: Rows, first: str, last: str) -> Rows:
    rows = []
    for doc in documents:
        day = iso_date(doc.get("date"))
        url = str(doc.get("url") or "")
        if day is None or not url.startswith("https://") or not first <= day <= last:
            continue
        doc_type = str(doc.get("doc_type") or "document").replace("_", " ").strip() or "document"
        doc_format = str(doc.get("doc_format") or "").strip()
        title = f"FOMC {doc_type}" + (f" ({doc_format})" if doc_format else "")
        rows.append(
            {
                "date": day,
                "detail": url[:2000],
                "eventKey": f"fomcdoc:{url[-180:]}",
                "kind": "fomc_document",
                "source": FED,
                "time": None,
                "title": title,
            }
        )
    return rows


def td_auction_date(item: dict[str, Any]) -> str | None:
    """TreasuryDirect auction day (auctionDate, else the competitive close date)."""
    return iso_date(item.get("auctionDate") or item.get("competitiveAuctionCloseDate"))


def td_list(text: str | None) -> Rows:
    data = json.loads(text) if text else None
    if not isinstance(data, list):
        raise ValueError("TreasuryDirect answered no list")
    return data


def td_upcoming_rows(items: Rows, first: str) -> Rows:
    """TreasuryDirect announced auctions -> treasury_auction events (key: CUSIP + auction date)."""
    rows = []
    for item in items:
        day = td_auction_date(item)
        cusip = str(item.get("cusip") or "").strip()
        if day is None or not cusip or day < first:
            continue
        term = label(item.get("securityTerm"), 60) or ""
        kind_name = label(item.get("securityType"), 40) or "security"
        details = [f"announced {iso_date(item.get('announcementDate'))}"] if item.get("announcementDate") else []
        if item.get("issueDate"):
            details.append(f"issue {iso_date(item.get('issueDate'))}")
        amount = num(item.get("offeringAmount"))
        if amount:
            details.append(f"offering ${amount / 1e9:,.1f} bn")
        if str(item.get("reopening") or "").lower() == "yes":
            details.append("reopening")
        details.append(f"CUSIP {cusip}")
        rows.append(
            {
                "date": day,
                "detail": "; ".join(details),
                "eventKey": f"auction:{cusip}:{day}",
                "kind": "treasury_auction",
                "source": "us_treasury",
                "time": clock(item.get("closingTimeCompetitive") or item.get("competitiveAuctionCloseTime")),
                "title": f"{term} {kind_name} auction".strip(),
            }
        )
    return rows


async def events(ctx: Context) -> dict[str, Rows]:
    """FOMC dates (Fed events calendar), FOMC documents, Fed release calendar, upcoming auctions."""
    _no_symbols(ctx)
    start = ctx.start(30)
    first = start.isoformat()
    rows = ctx.table("event_calendar")

    source = "federal_reserve events calendar"
    try:
        calendar = await ctx.up.helper("federal_reserve:events_calendar", _fed_calendar)
        found = ctx.take(source, calendar or [], lambda: calendar_rows(calendar or [], first), rows)
        if found and not any(r["kind"] == "fomc_meeting" and r["date"] >= ctx.today.isoformat() for r in found):
            ctx.warn(f"{source}: no future FOMC meeting listed")
    except UpstreamError as exc:
        ctx.failed(source, exc)

    for year in range(start.year, ctx.today.year + 1):
        await _source(
            ctx, f"fomc_documents {year}", FED, "FomcDocuments", {"year": year},
            lambda d: document_rows(d, first, ctx.today.isoformat()), rows, expect_rows=False,
        )

    try:
        from openbb_federal_reserve.utils.ddp import fetch_release_schedule

        schedule = await ctx.up.helper("federal_reserve:release_schedule", fetch_release_schedule)
        ctx.take("federal_reserve release_calendar", schedule or [], lambda: release_rows(schedule or [], first), rows)
    except UpstreamError as exc:
        ctx.failed("federal_reserve release_calendar", exc)

    # TreasuryDirect's own feed: fiscaldata's upcoming_auctions (OpenBB us_treasury) is stale at the
    # source (newest record 2026-10-16 on 2026-11-08).
    try:
        text = await ctx.up.http_text(TD_UPCOMING)
        ctx.take("treasurydirect upcoming auctions", [text] if text else [], lambda: td_upcoming_rows(td_list(text), first), rows,
                 expect_rows=False)
    except UpstreamError as exc:
        ctx.failed("treasurydirect upcoming auctions", exc)
    return {"event_calendar": rows}
