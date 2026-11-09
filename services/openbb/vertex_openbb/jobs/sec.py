"""SEC EDGAR jobs: filings, Form 4 insider trades, fails-to-deliver and tracked 13F-HR holders.

All SEC traffic goes through sec_guard (declared User-Agent, <= 8 requests/s).
"""

from __future__ import annotations

import re
from collections import defaultdict
from datetime import date, timedelta
from typing import Any

from ..context import CORE7, ArgumentError, Context
from ..upstream import UpstreamError
from ..values import count, iso_date, label, rounded

# Tracked 13F-HR filers, CIKs checked against data.sec.gov/submissions on 2026-11-08 (name as EDGAR
# lists it; each had a 13F-HR for period 2026-06-30).
FILERS: dict[str, str] = {
    "1067983": "BERKSHIRE HATHAWAY INC",
    "1350694": "Bridgewater Associates, LP",
    "1037389": "RENAISSANCE TECHNOLOGIES LLC",
    "1423053": "CITADEL ADVISORS LLC",
    "1446194": "SUSQUEHANNA INTERNATIONAL GROUP, LLP",
    "1595888": "JANE STREET GROUP, LLC",
}
# CUSIPs of the default universe, checked against the SEC fails-to-deliver files of 2026-07/08
# (symbol and CUSIP as SEC lists them).
CUSIPS: dict[str, str] = {
    "SPY": "78462F103", "QQQ": "46090E103", "DIA": "78467X109", "IWM": "464287655",
    "GLD": "78463V107", "SLV": "46428Q109", "USO": "91232N207", "AAPL": "037833100",
    "MSFT": "594918104", "NVDA": "67066G104", "AMZN": "023135106", "GOOGL": "02079K305",
    "META": "30303M102", "TSLA": "88160R101", "AVGO": "11135F101", "COST": "22160K105",
    "NFLX": "64110L106",
}
TOP_HOLDINGS = 50
# 13F-HR `value` is in dollars for periods from 2023-01-01 on and in thousands of dollars before.
VALUE_IN_DOLLARS_FROM = "2023-01-01"
_ACCESSION_PATH = re.compile(r"/data/(\d+)/(\d{10})(\d{2})(\d{6})/")
_ACCESSION = re.compile(r"^\d{10}-\d{2}-\d{6}$")
_FTD_KEY = re.compile(r"^(\d{4})(\d{2})([ab])$")
FTD_PAGE = "https://www.sec.gov/data-research/sec-markets-data/fails-deliver-data"
_FTD_HREF = re.compile(r'href="([^"]*?cnsfails(\d{6}[ab])\.zip)"')


def accession_from_url(url: str) -> tuple[str | None, str | None]:
    """(cik, accession) from an EDGAR archive URL."""
    match = _ACCESSION_PATH.search(url or "")
    if not match:
        return None, None
    return str(int(match[1])), f"{match[2]}-{match[3]}-{match[4]}"


# --- sec-filings -------------------------------------------------------------------------------


def filing_rows(symbol: str, data: list[dict[str, Any]], first: str) -> list[dict[str, Any]]:
    rows = []
    for item in data:
        filed = iso_date(item.get("filing_date"))
        url = str(item.get("report_url") or item.get("filing_detail_url") or "")
        cik, accession_in_url = accession_from_url(url or str(item.get("complete_submission_url") or ""))
        accession = str(item.get("accession_number") or accession_in_url or "")
        if filed is None or filed < first or not _ACCESSION.fullmatch(accession):
            continue
        description = str(item.get("primary_doc_description") or "").strip()
        items = str(item.get("items") or "").strip()
        if items:
            description = f"{description} (items {items})" if description else f"items {items}"
        rows.append(
            {
                "accessionNumber": accession,
                "cik": cik,
                "description": description[:2000],
                "filingDate": filed,
                "formType": label(item.get("report_type"), 20),
                "reportDate": iso_date(item.get("report_date")),
                "symbol": symbol,
                "url": url,
            }
        )
    return rows


async def filings(ctx: Context) -> dict[str, list[dict[str, Any]]]:
    """`equity/fundamental/filings` (sec), uncached so new filings show up on the next run."""
    start = ctx.start(30)
    rows = ctx.table("sec_filings")
    for symbol in ctx.symbol_list(ctx.stocks):
        params = {"symbol": symbol, "start_date": start.isoformat(), "end_date": ctx.today.isoformat(), "use_cache": False}
        try:
            data = await ctx.up.fetcher("sec", "Filings", params)
        except UpstreamError as exc:
            if exc.kind == "empty":
                ctx.ok()
                continue
            ctx.failed(f"sec filings {symbol}", exc)
            continue
        ctx.take(f"sec filings {symbol}", data, lambda d=data, s=symbol: filing_rows(s, d, start.isoformat()), rows)
    return {"sec_filings": rows}


# --- sec-insider -------------------------------------------------------------------------------


def _transaction_codes() -> dict[str, str]:
    from openbb_sec.utils.form4 import transaction_code_map

    return {" ".join(text.split()).lower(): code for code, text in transaction_code_map.items()}


def insider_rows(symbol: str, data: list[dict[str, Any]], first: str, codes: dict[str, str]) -> list[dict[str, Any]]:
    """Form 4 rows; rowNumber is the row's position inside its filing (OpenBB parse order)."""
    rows = []
    numbers: dict[str, int] = defaultdict(int)
    for item in data:
        url = str(item.get("filing_url") or "")
        _, accession = accession_from_url(url)
        filed = iso_date(item.get("filing_date"))
        if accession is None or filed is None or filed < first:
            continue
        numbers[accession] += 1
        description = " ".join(str(item.get("transaction_type") or "").split()).lower()
        direction = str(item.get("acquisition_or_disposition") or "").strip().upper()[:1]
        rows.append(
            {
                "accessionNumber": accession,
                "acquiredDisposed": direction if direction in ("A", "D") else None,
                "filingDate": filed,
                "ownerName": label(item.get("owner_name"), 200),
                "ownerTitle": label(item.get("owner_title"), 200),
                "price": rounded(item.get("transaction_price"), 6),
                "rowNumber": numbers[accession],
                "shares": rounded(item.get("securities_transacted"), 6),
                "sharesAfter": rounded(item.get("securities_owned"), 6),
                "symbol": symbol,
                "transactionCode": codes.get(description) if description else None,
                "transactionDate": iso_date(item.get("transaction_date")),
                "url": url if url.startswith("https://") else None,
            }
        )
    return rows


async def insider(ctx: Context) -> dict[str, list[dict[str, Any]]]:
    """`equity/ownership/insider_trading` (sec, Form 4).

    OpenBB's Form 4 URL filter keeps nothing unless both start_date and end_date are given, so both
    are always passed. use_cache=False: the filing list is otherwise cached for a day.
    """
    start = ctx.start(30)
    codes = _transaction_codes()
    rows = ctx.table("sec_insider_trades")
    for symbol in ctx.symbol_list(ctx.stocks):
        params = {"symbol": symbol, "start_date": start.isoformat(), "end_date": ctx.today.isoformat(), "use_cache": False}
        try:
            data = await ctx.up.fetcher("sec", "InsiderTrading", params)
        except UpstreamError as exc:
            if exc.kind == "empty":
                ctx.ok()
                continue
            ctx.failed(f"sec insider {symbol}", exc)
            continue
        ctx.take(f"sec insider {symbol}", data, lambda d=data, s=symbol: insider_rows(s, d, start.isoformat(), codes), rows)
    return {"sec_insider_trades": rows}


# --- sec-ftd -----------------------------------------------------------------------------------


def ftd_period_end(key: str) -> date | None:
    """Last settlement day a fails file can hold: 'YYYYMMa' -> the 15th, 'YYYYMMb' -> month end."""
    match = _FTD_KEY.fullmatch(key)
    if not match:
        return None
    year, month = int(match[1]), int(match[2])
    if match[3] == "a":
        return date(year, month, 15)
    return date(year + month // 12, month % 12 + 1, 1) - timedelta(days=1)


def ftd_links(page: str) -> dict[str, str]:
    """`YYYYMM[ab]` -> absolute URL of each fails file linked from the SEC page (SEC moved the
    newest files to /files/data/other/fails-deliver-data/ in 2026, so names are not built)."""
    links: dict[str, str] = {}
    for href, key in _FTD_HREF.findall(page):
        url = href if href.startswith("https://") else "https://www.sec.gov" + (href if href.startswith("/") else "/" + href)
        links.setdefault(key, url)
    return links


async def _ftd_file(url: str, symbols: tuple[str, ...]) -> list[dict[str, Any]]:
    """One SEC fails-to-deliver file through OpenBB's download helper, kept to `symbols`."""
    from openbb_sec.utils.helpers import download_zip_file

    wanted = set(symbols)
    rows = await download_zip_file(url, None, True)
    return [row for row in rows if str(row.get("symbol") or "").strip() in wanted]


def ftd_rows(data: list[dict[str, Any]], first: str) -> list[dict[str, Any]]:
    totals: dict[tuple[str, str], dict[str, Any]] = {}
    for item in data:
        day = iso_date(item.get("date"))
        symbol = str(item.get("symbol") or "").strip()
        quantity = count(item.get("quantity"))
        if day is None or day < first or not symbol or quantity is None:
            continue
        key = (day, symbol)
        row = totals.get(key)
        if row is None:
            totals[key] = {
                "cusip": str(item.get("cusip") or "").strip(),
                "price": rounded(item.get("price"), 6),
                "quantity": quantity,
                "settlementDate": day,
                "symbol": symbol,
            }
        else:
            row["quantity"] += quantity
    return list(totals.values())


async def ftd(ctx: Context) -> dict[str, list[dict[str, Any]]]:
    """`equity/shorts/fails_to_deliver` (sec): half-month files covering the window.

    The newest listed file is often not published yet (404); it is skipped with a warning and
    older files are used, going back past the window until one file loads.
    """
    start = ctx.start(60)
    symbols = ctx.symbol_list(ctx.core_and_stocks)
    listing: dict[str, str] = {}
    try:
        page = await ctx.up.http_text(FTD_PAGE)
        listing = ftd_links(page or "")
    except UpstreamError as exc:
        ctx.warn(f"sec fails-to-deliver page: {exc.message}")
    if not listing:
        ctx.warn("sec fails-to-deliver page listed no files; using OpenBB's data.json listing")  # json-data-ignore: warning text naming SEC's upstream listing, not a file read
        try:
            from openbb_sec.utils.helpers import get_ftd_urls

            listing = await ctx.up.helper("sec:ftd_urls", get_ftd_urls)
        except UpstreamError as exc:
            ctx.failed("sec fails-to-deliver list", exc)
            return {"sec_ftd": []}
    files = sorted(
        ((key, url, ftd_period_end(key)) for key, url in (listing or {}).items() if ftd_period_end(key)),
        reverse=True,
    )
    rows = ctx.table("sec_ftd")
    loaded = 0
    for key, url, period_end in files:
        if period_end < start and loaded:
            break
        try:
            data = await ctx.up.helper(f"sec:ftd:{key}:{','.join(symbols)}", lambda u=url: _ftd_file(u, symbols))
        except UpstreamError as exc:
            if exc.kind == "not_found":
                ctx.warn(f"sec fails-to-deliver {key}: not published (404); using older files")
                continue
            ctx.failed(f"sec fails-to-deliver {key}", exc)
            continue
        loaded += 1
        # Rows inside the window; a fallback file older than the window gives all its rows.
        first = start.isoformat() if period_end >= start else "0000-00-00"
        ctx.take(f"sec fails-to-deliver {key}", data or [], lambda d=data, f=first: ftd_rows(d or [], f), rows, expect_rows=False)
        if period_end < start:
            ctx.warn(f"sec fails-to-deliver: newest loadable file is {key}, before the window start {start.isoformat()}")
            break
    if not loaded and not ctx.sources_failed:
        ctx.failed("sec fails-to-deliver", UpstreamError("not_found", "no fails-to-deliver file could be loaded"))
    return {"sec_ftd": rows}


# --- sec-13f -----------------------------------------------------------------------------------


def quarter_ends(start: date, today: date) -> int:
    """How many quarter ends fall in [start, today] (at least 1)."""
    total = 0
    for year in range(start.year, today.year + 1):
        for month, day in ((3, 31), (6, 30), (9, 30), (12, 31)):
            if start <= date(year, month, day) <= today:
                total += 1
    return max(total, 1)


def pick_filings(filings_list: list[dict[str, Any]], limit: int) -> tuple[list[tuple[str, str]], list[str]]:
    """Newest `limit` periods: (period, complete submission URL) of the original 13F-HR each.

    Returns (picked, notes); a 13F-HR/A for a picked period is noted, not applied.
    """
    by_period: dict[str, dict[str, Any]] = {}
    amended: dict[str, str] = {}
    for item in filings_list:
        period = iso_date(item.get("report_date"))
        form = str(item.get("report_type") or "").strip().upper()
        url = str(item.get("complete_submission_url") or "")
        if period is None or not url.startswith("https://"):
            continue
        if form == "13F-HR":
            current = by_period.get(period)
            if current is None or str(item.get("filing_date")) < str(current.get("filing_date")):
                by_period[period] = item
        elif form == "13F-HR/A":
            amended[period] = iso_date(item.get("filing_date")) or "?"
    periods = sorted(by_period, reverse=True)[:limit]
    notes = [f"period {p}: 13F-HR/A filed {amended[p]} not applied (original 13F-HR used)" for p in periods if p in amended]
    return [(p, str(by_period[p]["complete_submission_url"])) for p in periods], notes


async def _parse_13f(url: str) -> list[dict[str, Any]]:
    """One 13F-HR information table, through OpenBB's parser and its Form 13F-HR data model."""
    from openbb_sec.models.form_13FHR import SecForm13FHRData
    from openbb_sec.utils.parse_13f import parse_13f_hr

    return [SecForm13FHRData.model_validate(row).model_dump() for row in await parse_13f_hr(url)]


def holdings_rows(
    filer_cik: str, filer_name: str, period: str, data: list[dict[str, Any]], universe: dict[str, str]
) -> list[dict[str, Any]]:
    """Aggregate per (cusip, option type); keep universe CUSIPs plus the filer's top 50 by value.

    `universe` maps verified CUSIP -> ticker; `symbol` is that ticker, null for top-50-only rows.
    """
    totals: dict[tuple[str, str], dict[str, Any]] = {}
    for item in data:
        cusip = str(item.get("cusip") or "").strip().upper()
        value = rounded(item.get("value"), 2)
        issuer = label(item.get("issuer"), 200)
        if len(cusip) != 9 or value is None or issuer is None:
            continue
        option = str(item.get("option_type") or "").strip().lower()
        option = option if option in ("put", "call") else ""
        # Only SH (shares) rows have a share count; PRN rows keep their value, shares stay null.
        is_shares = str(item.get("security_type") or "").strip().upper() == "SH"
        shares = count(item.get("principal_amount")) if is_shares else None
        period_end = iso_date(item.get("period_ending")) or period
        if period_end < VALUE_IN_DOLLARS_FROM:
            value = round(value * 1000, 2)  # 13F values were reported in thousands before 2023
        key = (cusip, option)
        row = totals.get(key)
        if row is None:
            totals[key] = {
                "assetClass": label(item.get("asset_class"), 40),
                "cusip": cusip,
                "filerCik": filer_cik,
                "filerName": filer_name,
                "issuer": issuer,
                "optionType": option,
                "periodEnding": period_end,
                "shares": shares,
                "symbol": universe.get(cusip),
                "value": value,
                "weight": rounded(item.get("weight"), 8),
            }
        else:
            row["value"] = round(row["value"] + value, 2)
            if shares is not None:
                row["shares"] = (row["shares"] or 0) + shares
            weight = rounded(item.get("weight"), 8)
            row["weight"] = None if row["weight"] is None or weight is None else round(row["weight"] + weight, 8)
    ranked = sorted(totals.values(), key=lambda r: (-r["value"], r["cusip"], r["optionType"]))
    top = {(r["cusip"], r["optionType"]) for r in ranked[:TOP_HOLDINGS]}
    return [r for r in ranked if r["cusip"] in universe or (r["cusip"], r["optionType"]) in top]


async def _filer_name(ctx: Context, cik: str) -> str | None:
    """EDGAR name of a CIK not in FILERS (also confirms the CIK exists)."""
    url = f"https://data.sec.gov/submissions/CIK{int(cik):010d}.json"  # json-data-ignore: SEC EDGAR HTTP endpoint fetched over the network, not a stored data file

    async def fetch() -> dict[str, Any]:
        from openbb_core.provider.utils.helpers import amake_request

        return await amake_request(url)

    try:
        data = await ctx.up.helper(f"sec:submissions:{cik}", fetch)
    except UpstreamError as exc:
        ctx.failed(f"sec 13f filer {cik}", exc)
        return None
    return label((data or {}).get("name"), 200)


async def form_13f(ctx: Context) -> dict[str, list[dict[str, Any]]]:
    """`equity/ownership/form_13f` (sec) for tracked filers -> sec_13f_holdings."""
    filers = ctx.filers if ctx.filers is not None else tuple(FILERS)
    universe_symbols = ctx.symbol_list(CORE7 + tuple(s for s in ctx.stocks if s not in CORE7))
    unknown = [s for s in universe_symbols if s not in CUSIPS]
    if unknown:
        ctx.warn(f"sec 13f: no verified CUSIP for {', '.join(unknown)}; only top holdings kept for them")
    universe = {CUSIPS[s]: s for s in universe_symbols if s in CUSIPS}
    limit = quarter_ends(ctx.start(183), ctx.today)
    rows = ctx.table("sec_13f_holdings")
    for cik in filers:
        name = FILERS.get(cik) or await _filer_name(ctx, cik)
        if name is None:
            continue
        try:
            listing = await ctx.up.fetcher("sec", "CompanyFilings", {"cik": cik, "form_type": "13F-HR", "use_cache": False})
        except UpstreamError as exc:
            ctx.failed(f"sec 13f {name}", exc)
            continue
        try:
            picked, notes = pick_filings(listing, limit)
        except Exception as exc:  # noqa: BLE001 - one filer's bad listing must not stop the others
            ctx.failed(f"sec 13f {name}", exc)
            continue
        for note in notes:
            ctx.warn(f"sec 13f {name}: {note}")
        if not picked:
            ctx.ok()
            ctx.warn(f"sec 13f {name}: no 13F-HR filings")
            continue
        for period, url in picked:
            try:
                data = await ctx.up.helper(f"sec:13f:{url}", lambda u=url: _parse_13f(u))
            except UpstreamError as exc:
                ctx.failed(f"sec 13f {name} {period}", exc)
                continue
            ctx.take(
                f"sec 13f {name} {period}", data or [],
                lambda d=data, p=period: holdings_rows(cik, name, p, d or [], universe), rows,
            )
    return {"sec_13f_holdings": rows}


def validate_filers(values: list[str]) -> tuple[str, ...]:
    out = []
    for value in values:
        if not re.fullmatch(r"\d{1,10}", value):
            raise ArgumentError(f"--filers takes numeric CIKs, not {value!r}")
        out.append(str(int(value)))
    if not out:
        raise ArgumentError("--filers is empty")
    return tuple(dict.fromkeys(out))
