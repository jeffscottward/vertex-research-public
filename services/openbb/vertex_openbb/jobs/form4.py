"""SEC Form 4 market-wide: every Form 4 and 4/A of each EDGAR daily index, with a resumable ledger.

Job `sec-form4` (docs/vertex-rebuild/designs/smart-money/plan-pr3.md). For each weekday of the window
it reads `form.<YYYYMMDD>.idx`, keeps the distinct Form 4 and 4/A accessions, and fetches each full
submission once (`<accession>.txt`: the SEC header with the acceptance time, and the Form 4 XML).
The tick passes the finished state on stdin (`--state-stdin`): complete days get no request and
done accessions are not fetched again, so a run that stops at the deadline resumes where it stopped.
Research only: public data in, rows out through openbb.ingest.
"""

from __future__ import annotations

import asyncio
import json
import re
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from typing import Any, TextIO
from zoneinfo import ZoneInfo

from ..context import ArgumentError, Context
from ..upstream import UpstreamError
from ..values import cut, rounded
from .congress import read_capped

# 40 days: the stock page reads 30 days and clusters read up to 40; older days need --since.
DEFAULT_DAYS = 40
PARSER_VERSION = "form4.v1"
FORMS = ("4", "4/A")
ARCHIVES = "https://www.sec.gov/Archives/edgar"
INDEX_CAP = 16 * 1024 * 1024
FILING_CAP = 4 * 1024 * 1024
WORKERS = 6
NEW_YORK = ZoneInfo("America/New_York")
# SEC Form 4 general instructions 8: OpenBB's transaction_code_map plus K (equity swap) and V
# (voluntarily reported).
EXTRA_CODES = ("K", "V")

_INDEX_LINE = re.compile(
    r"^(?P<form>\S+)\s+.*?\s(?P<cik>\d{1,10})\s+(?P<filed>\d{8})\s+"
    r"edgar/data/(?P<path_cik>\d{1,10})/(?P<accession>\d{10}-\d{2}-\d{6})\.txt\s*$"
)
_ACCEPTED = re.compile(r"<ACCEPTANCE-DATETIME>\s*(\d{14})")
_DOCUMENT = re.compile(r"<DOCUMENT>(.*?)</DOCUMENT>", re.S)
_TYPE = re.compile(r"<TYPE>\s*([^\s<]+)")
_XML = re.compile(r"<XML>\s*(.*?)\s*</XML>", re.S)
_SYMBOL = re.compile(r"^[A-Z0-9.^=-]{1,16}$")
_CIK = re.compile(r"^\d{1,10}$")


@dataclass(frozen=True)
class Entry:
    accession: str
    cik: str
    form: str


def transaction_codes() -> frozenset[str]:
    from openbb_sec.utils.form4 import transaction_code_map

    return frozenset(transaction_code_map) | frozenset(EXTRA_CODES)


# --- window and state ----------------------------------------------------------------------------


def window_days(ctx: Context) -> list[date]:
    """Weekdays from --since (default today minus DEFAULT_DAYS) to --until (default today), oldest first."""
    first, last = ctx.start(DEFAULT_DAYS), ctx.end()
    days = []
    day = first
    while day <= last:
        if day.weekday() < 5:
            days.append(day)
        day += timedelta(days=1)
    return days


@dataclass
class State:
    complete_days: frozenset[str]
    done: set[str]


def read_state(stream: TextIO | None) -> State:
    """The tick's state JSON; empty without --state-stdin.

    `{completeDays, doneAccessions, layoutUnknown: [{accessionNumber, parserVersion}]}`. A
    layout_unknown filing counts as done only when this parser version wrote it, so a parser fix
    reads those filings again (a complete day is never read again; use --since for those).
    """
    if stream is None:
        return State(frozenset(), set())
    try:
        data = json.loads(stream.read())
    except ValueError as exc:
        raise ArgumentError(f"--state-stdin: stdin is not JSON ({exc})") from exc
    if not isinstance(data, dict) or set(data) != {"completeDays", "doneAccessions", "layoutUnknown"}:
        raise ArgumentError("--state-stdin: expected {completeDays, doneAccessions, layoutUnknown}")
    days, done, unknown = data["completeDays"], data["doneAccessions"], data["layoutUnknown"]
    if not (isinstance(days, list) and all(isinstance(d, str) for d in days)):
        raise ArgumentError("--state-stdin: completeDays must be a list of dates")
    if not (isinstance(done, list) and all(isinstance(a, str) for a in done)):
        raise ArgumentError("--state-stdin: doneAccessions must be a list of accessions")
    if not (isinstance(unknown, list) and all(isinstance(u, dict) and isinstance(u.get("accessionNumber"), str) for u in unknown)):
        raise ArgumentError("--state-stdin: layoutUnknown must be a list of {accessionNumber, parserVersion}")
    current = {u["accessionNumber"] for u in unknown if u.get("parserVersion") == PARSER_VERSION}
    return State(frozenset(days), set(done) | current)


# --- daily index ---------------------------------------------------------------------------------


def index_url(day: date) -> str:
    quarter = (day.month - 1) // 3 + 1
    return f"{ARCHIVES}/daily-index/{day.year}/QTR{quarter}/form.{day:%Y%m%d}.idx"


def parse_index(text: str) -> list[dict[str, str]] | None:
    """Distinct Form 4 and 4/A accessions of one daily form index, in index order.

    The index lists an accession once per filer (issuer and each reporting owner); the first line
    wins (the filer folder in the file name is the same on every line). None when the text has no
    dashed header line or no parseable entry line at all (layout change).
    """
    lines = text.splitlines()
    start = next((i for i, line in enumerate(lines) if line.startswith("-----")), None)
    if start is None:
        return None
    seen: dict[str, dict[str, str]] = {}
    parsed = 0
    for line in lines[start + 1 :]:
        match = _INDEX_LINE.match(line)
        if match is None:
            continue
        parsed += 1
        form = match["form"]
        if form in FORMS and match["accession"] not in seen:
            seen[match["accession"]] = {"accession": match["accession"], "cik": match["path_cik"], "formType": form}
    if parsed == 0:
        return None
    return list(seen.values())


def filing_url(entry: Entry) -> str:
    return f"{ARCHIVES}/data/{entry.cik}/{entry.accession.replace('-', '')}/{entry.accession}-index.htm"


def submission(text: str) -> dict[str, Any]:
    """Acceptance time and the Form 4 XML of one full submission text."""
    accepted = _ACCEPTED.search(text[:20000])
    xml = None
    for document in _DOCUMENT.finditer(text):
        body = document.group(1)
        kind = _TYPE.search(body)
        if kind and kind.group(1) in FORMS:
            found = _XML.search(body)
            if found:
                xml = found.group(1)
            break
    return {"accepted": accepted.group(1) if accepted else None, "xml": xml}


def _fetchers() -> tuple[Any, Any]:
    import requests

    session = requests.Session()  # sec_guard sets the User-Agent and the 8/s limit

    def index(day: date) -> Any:
        def run() -> Any:
            response = session.get(index_url(day), timeout=(10, 60), stream=True, allow_redirects=False)
            if response.status_code == 404:
                response.close()
                return None
            if response.status_code == 403:
                response.close()
                raise UpstreamError("forbidden", f"HTTP 403 from {index_url(day)}")
            text = read_capped(response, INDEX_CAP, f"form.{day:%Y%m%d}.idx").decode("latin-1")
            entries = parse_index(text)
            return {"layoutUnknown": True} if entries is None else entries

        return run

    def filing(entry: Entry) -> Any:
        def run() -> Any:
            url = f"{ARCHIVES}/data/{entry.cik}/{entry.accession}.txt"
            response = session.get(url, timeout=(10, 60), stream=True, allow_redirects=False)
            if response.status_code == 404:  # listed in the index but not in the archive
                response.close()
                return {"notFound": True}
            if response.status_code == 403:
                response.close()
                raise UpstreamError("forbidden", f"HTTP 403 from {url}")
            try:
                data = read_capped(response, FILING_CAP, f"{entry.accession}.txt")
            except UpstreamError as exc:
                if "larger than" in exc.message:
                    return {"tooLarge": True}
                raise
            return submission(data.decode("utf-8", errors="replace"))

        return run

    return index, filing


# --- Form 4 XML ----------------------------------------------------------------------------------


class LayoutError(ValueError):
    """The XML does not have the Form 4 shape this parser knows."""


def _list(value: Any) -> list[Any]:
    if value is None:
        return []
    return value if isinstance(value, list) else [value]


def _value(node: Any) -> str | None:
    """`<x><value>v</value><footnoteId/></x>` or `<x>v</x>` -> 'v' (None when empty)."""
    if isinstance(node, dict):
        node = node.get("value")
        if isinstance(node, dict):  # <value> with attributes only
            node = node.get("#text")
    if node is None:
        return None
    text = " ".join(str(node).split())
    return text or None


def _flag(node: Any) -> bool | None:
    text = (_value(node) or "").lower()
    if text in ("1", "true"):
        return True
    if text in ("0", "false"):
        return False
    return None


def _day(node: Any) -> str | None:
    text = (_value(node) or "")[:10]
    try:
        return date.fromisoformat(text).isoformat() if len(text) == 10 else None
    except ValueError:
        return None


def _number(node: Any) -> float | None:
    text = (_value(node) or "").replace(",", "").replace("$", "")
    try:
        return rounded(float(text), 6) if text else None
    except ValueError:
        return None


def _label(node: Any, limit: int) -> str | None:
    text = _value(node)
    return cut(text, limit, "…") if text else None


def accepted_at(text: str | None) -> str | None:
    """`20261119163012` (America/New_York) -> ISO timestamp with offset."""
    if not text:
        return None
    try:
        local = datetime.strptime(text, "%Y%m%d%H%M%S").replace(tzinfo=NEW_YORK)
    except ValueError:
        return None
    return local.isoformat()


def parse_xml(xml: str) -> dict[str, Any]:
    from openbb_sec.utils.form4 import clean_xml
    from xmltodict import parse

    try:
        data = parse(clean_xml(xml))
    except Exception as exc:  # noqa: BLE001 - any parser error is a layout problem
        raise LayoutError(f"XML does not parse ({type(exc).__name__})") from exc
    document = data.get("ownershipDocument") if isinstance(data, dict) else None
    if not isinstance(document, dict):
        raise LayoutError("no ownershipDocument")
    return document


def _transaction(node: dict[str, Any], derivative: bool, codes: frozenset[str]) -> dict[str, Any]:
    coding = node.get("transactionCoding") or {}
    code = _value(coding.get("transactionCode")) if isinstance(coding, dict) else None
    if code is not None and code not in codes:
        raise LayoutError(f"unknown transaction code {code!r}")
    amounts = node.get("transactionAmounts") or {}
    post = node.get("postTransactionAmounts") or {}
    nature = node.get("ownershipNature") or {}
    direction = _value(amounts.get("transactionAcquiredDisposedCode"))
    direct = _value(nature.get("directOrIndirectOwnership"))
    return {
        "acquiredDisposed": direction if direction in ("A", "D") else None,
        "derivative": derivative,
        "directIndirect": direct if direct in ("D", "I") else None,
        "price": _number(amounts.get("transactionPricePerShare")),
        "securityTitle": _label(node.get("securityTitle"), 200) or "Unknown security",
        "shares": _number(amounts.get("transactionShares")),
        "sharesAfter": _number(post.get("sharesOwnedFollowingTransaction")),
        "transactionCode": code,
        "transactionDate": _day(node.get("transactionDate")),
    }


def parse_filing(document: dict[str, Any], accession: str, codes: frozenset[str]) -> tuple[dict[str, Any], list[dict[str, Any]], list[dict[str, Any]]]:
    """Filing fields, owner rows and transaction rows of one ownershipDocument (LayoutError when unusable)."""
    issuer = document.get("issuer")
    if not isinstance(issuer, dict) or not _CIK.fullmatch(str(_value(issuer.get("issuerCik")) or "")):
        raise LayoutError("no issuer CIK")
    owners = []
    for owner in _list(document.get("reportingOwner")):
        if not isinstance(owner, dict):
            raise LayoutError("reporting owner is not an element")
        ident = owner.get("reportingOwnerId") or {}
        cik = _value(ident.get("rptOwnerCik"))
        name = _label(ident.get("rptOwnerName"), 200)
        if cik is None or not _CIK.fullmatch(cik) or name is None:
            raise LayoutError("reporting owner without CIK or name")
        role = owner.get("reportingOwnerRelationship") or {}
        owners.append(
            {
                "accessionNumber": accession,
                "isDirector": _flag(role.get("isDirector")) is True,
                "isOfficer": _flag(role.get("isOfficer")) is True,
                "isOther": _flag(role.get("isOther")) is True,
                "isTenPercentOwner": _flag(role.get("isTenPercentOwner")) is True,
                "officerTitle": _label(role.get("officerTitle"), 200),
                "ownerCik": cik.lstrip("0") or "0",
                "ownerName": name,
            }
        )
    if not owners:
        raise LayoutError("no reporting owner")
    owners = list({o["ownerCik"]: o for o in owners}.values())
    transactions = []
    for table, key, derivative in (
        ("nonDerivativeTable", "nonDerivativeTransaction", False),
        ("derivativeTable", "derivativeTransaction", True),
    ):
        holder = document.get(table)
        nodes = _list(holder.get(key)) if isinstance(holder, dict) else []
        for node in nodes:
            if not isinstance(node, dict):
                raise LayoutError(f"{key} is not an element")
            transactions.append(_transaction(node, derivative, codes))
    for number, row in enumerate(transactions, start=1):
        row["accessionNumber"] = accession
        row["rowNumber"] = number
    symbol = (_value(issuer.get("issuerTradingSymbol")) or "").upper()
    filing = {
        "issuerCik": str(_value(issuer.get("issuerCik"))).lstrip("0") or "0",
        "issuerName": _label(issuer.get("issuerName"), 200),
        "issuerSymbol": symbol if _SYMBOL.fullmatch(symbol) else None,
        "periodOfReport": _day(document.get("periodOfReport")),
        "plan10b51": _flag(document.get("aff10b5One")),
        "rowCount": len(transactions),
    }
    return filing, owners, transactions


def ledger_row(entry: Entry, day: date, **fields: Any) -> dict[str, Any]:
    row = {
        "acceptedAt": None,
        "accessionNumber": entry.accession,
        "formType": entry.form,
        "indexDay": day.isoformat(),
        "issuerCik": None,
        "issuerName": None,
        "issuerSymbol": None,
        "parserVersion": PARSER_VERSION,
        "periodOfReport": None,
        "plan10b51": None,
        "reason": None,
        "rowCount": 0,
        "status": "parsed",
        "url": filing_url(entry),
    }
    row.update(fields)
    return row


def unparsed(entry: Entry, day: date, reason: str, accepted: str | None = None) -> dict[str, Any]:
    return ledger_row(entry, day, acceptedAt=accepted, reason=reason, status="unparsed")


def build(entry: Entry, day: date, result: Any, codes: frozenset[str]) -> tuple[dict[str, Any], list[dict[str, Any]], list[dict[str, Any]]]:
    """Ledger row, owners and transactions for one downloaded submission."""
    if not isinstance(result, dict):
        raise LayoutError("unexpected filing payload")
    if result.get("tooLarge"):
        return unparsed(entry, day, "too_large"), [], []
    if result.get("notFound"):
        return unparsed(entry, day, "not_found"), [], []
    accepted = accepted_at(result.get("accepted"))
    xml = result.get("xml")
    if not xml:
        return unparsed(entry, day, "no_xml", accepted), [], []
    try:
        if accepted is None:
            raise LayoutError("no acceptance time")
        filing, owners, transactions = parse_filing(parse_xml(xml), entry.accession, codes)
    except LayoutError:
        return unparsed(entry, day, "layout_unknown", accepted), [], []
    return ledger_row(entry, day, acceptedAt=accepted, **filing), owners, transactions


# --- job -----------------------------------------------------------------------------------------


async def run_job(ctx: Context, state: State) -> dict[str, list[dict[str, Any]]]:
    from .. import rows as row_rules

    codes = transaction_codes()
    transactions = ctx.table("sec_form4_transactions")
    owners = ctx.table("sec_form4_owners")
    filings = ctx.table("sec_form4_filings")
    index_days = ctx.table("sec_form4_index_days")
    index_func, filing_func = _fetchers()
    done = state.done
    for day in window_days(ctx):
        key = day.isoformat()
        if key in state.complete_days:
            continue
        source = f"form.{day:%Y%m%d}.idx"
        try:
            listed = await ctx.up.helper(f"sec-form4:index:{key}", index_func(day))
        except UpstreamError as exc:
            ctx.failed(source, exc)
            if exc.kind == "forbidden":  # SEC fair access: stop at once
                break
            continue
        ctx.ok()
        if listed is None:  # not published (holiday, or today before about 22:00 ET)
            continue
        if isinstance(listed, dict):
            ctx.warn(f"{source}: layout_unknown (no parseable entry line)")
            continue
        entries = [Entry(e["accession"], e["cik"], e["formType"]) for e in listed]
        day_row = {"complete": False, "entriesDone": 0, "entriesListed": len(entries), "indexDay": key}

        def refresh(row: dict[str, Any] = day_row, items: list[Entry] = entries) -> None:
            row["entriesDone"] = sum(1 for e in items if e.accession in done)
            row["complete"] = row["entriesDone"] == row["entriesListed"]

        refresh()
        index_days.append(day_row)
        todo = [e for e in entries if e.accession not in done]
        queue: asyncio.Queue[Entry] = asyncio.Queue()
        for entry in todo:
            queue.put_nowait(entry)

        async def worker(day: date = day, refresh: Any = refresh) -> None:
            while not queue.empty():
                entry = queue.get_nowait()
                try:
                    result = await ctx.up.helper(f"sec-form4:filing:{entry.accession}", filing_func(entry))
                except UpstreamError as exc:
                    ctx.warn(f"filing {entry.accession}: {exc.message}")
                    if exc.kind == "forbidden":
                        raise
                    continue
                try:
                    ledger, owner_rows, rows = build(entry, day, result, codes)
                except Exception:  # noqa: BLE001 - any unexpected shape is one unusable filing, never a crashed run
                    ledger, owner_rows, rows = unparsed(entry, day, "layout_unknown"), [], []
                if ledger["status"] == "parsed" and any(
                    row_rules.row_problem(t, r) for t, group in (("sec_form4_owners", owner_rows), ("sec_form4_transactions", rows)) for r in group
                ):
                    ledger, owner_rows, rows = unparsed(entry, day, "layout_unknown", ledger["acceptedAt"]), [], []
                owners.extend(owner_rows)
                transactions.extend(rows)
                filings.append(ledger)
                done.add(entry.accession)
                refresh()

        try:
            await asyncio.gather(*(worker() for _ in range(min(WORKERS, len(todo)))))
        except UpstreamError as exc:  # HTTP 403: stop at once (SEC fair access)
            ctx.failed(f"{source} filings", exc)
            break
    if not any(ctx.tables.values()):
        ctx.nothing_new = True  # every day in the window is complete or not published yet
    return dict(ctx.tables)


async def form4(ctx: Context) -> dict[str, list[dict[str, Any]]]:
    return await run_job(ctx, ctx.form4_state or State(frozenset(), set()))
