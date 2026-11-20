"""Congress STOCK Act periodic transaction reports (PTRs): House Clerk PDFs and Senate eFD pages.

`congress-house` reads the House Clerk yearly filing index (`<YEAR>FD.zip`), keeps PTRs (filing type
P) filed in the window and turns each electronic PDF (document id starts with 2) into text with
pdfplumber. Scanned paper filings (other ids) get a ledger row `unparsed` / `scanned_image` and no
download. `congress-senate` opens an eFD session (the site asks the user to accept its statement of
understanding: no commercial use, no credit rating, no fundraising; Vertex is a private research
tool), searches PTRs received in the window and reads the transaction table of each electronic
report. Paper reports are ledger rows `unparsed` / `scanned_image`.

Every filing that was read gets one `congress_filings` row (parsed, or unparsed with a reason). A
filing whose download fails gets a warning and no row, so a stored parsed filing is never replaced
by a download failure. Nothing is guessed: a filing that the parser cannot read completely is
`layout_unknown` with no trade rows.
"""

from __future__ import annotations

import html as html_lib
import io
import re
import time
import zipfile
from collections.abc import Callable
from dataclasses import dataclass
from datetime import date
from typing import Any

from .. import sec_guard
from ..context import Context
from ..upstream import UpstreamError

HOUSE_BASE = "https://disclosures-clerk.house.gov/public_disc"
SENATE_BASE = "https://efdsearch.senate.gov"
HOUSE_PARSER = "house.v1"
SENATE_PARSER = "senate.v1"
DEFAULT_DAYS = 21
HOUSE_PAUSE_S = 0.5
SENATE_PAUSE_S = 1.0
ZIP_CAP = 8 * 1024 * 1024
INDEX_CAP = 32 * 1024 * 1024
PDF_CAP = 10 * 1024 * 1024
PAGE_CAP = 8 * 1024 * 1024
MAX_PDF_PAGES = 40
SEARCH_PAGE = 100
MAX_SEARCH_PAGES = 100

_TICKER = re.compile(r"^[A-Z][A-Z0-9.\-]{0,9}$")
_DATE_US = re.compile(r"^(\d{2})/(\d{2})/(\d{4})$")
_AMOUNT = re.compile(r"\$([\d,]+)")
_HOUSE_DOC = re.compile(r"^\d{1,12}$")

# --- shared helpers ----------------------------------------------------------------------------


def us_date(text: str) -> str | None:
    """MM/DD/YYYY -> YYYY-MM-DD (None when not a real date)."""
    match = _DATE_US.fullmatch(text.strip())
    if not match:
        return None
    try:
        return date(int(match[3]), int(match[1]), int(match[2])).isoformat()
    except ValueError:
        return None


def amount_range(label: str) -> tuple[int | None, int | None]:
    """'$1,001 - $15,000' -> (1001, 15000); 'Over $50,000,000' -> (50000001, None).

    An exact value with cents ('$710.52') gives whole dollars, rounded down: (710, 710).
    """
    values = [int(v.replace(",", "")) for v in _AMOUNT.findall(label)]
    if not values:
        return None, None
    if "over" in label.lower():
        return values[0] + 1, None
    if len(values) == 1:
        return values[0], values[0]
    return values[0], values[1]


def collapse(text: str) -> str:
    return " ".join(text.split())


def ticker_or_none(text: str | None) -> str | None:
    value = (text or "").strip().upper()
    return value if _TICKER.fullmatch(value) else None


def user_agent(env: Any) -> str:
    """`vertex-research congress (personal research; <contact>)` (ContactError when unset)."""
    return sec_guard.user_agent(env).replace("vertex-research openbb ", "vertex-research congress ", 1)


def read_capped(response: Any, cap: int, what: str) -> bytes:
    """Body of a streamed requests response; raises when it is larger than `cap` bytes."""
    response.raise_for_status()
    chunks: list[bytes] = []
    size = 0
    for chunk in response.iter_content(65536):
        size += len(chunk)
        if size > cap:
            response.close()
            raise UpstreamError("error", f"{what} is larger than {cap // (1024 * 1024)} MiB")
        chunks.append(chunk)
    return b"".join(chunks)


def filing_row(
    chamber: str, doc_id: str, member: str, state: str | None, filed: str, url: str,
    count: int, reason: str | None, parser: str, amends: bool,
) -> dict[str, Any]:
    return {
        "amends": amends,
        "chamber": chamber,
        "docId": doc_id,
        "filedOn": filed,
        "member": member,
        "parserVersion": parser,
        "reason": reason,
        "rowCount": count if reason is None else 0,
        "stateDistrict": state,
        "status": "parsed" if reason is None else "unparsed",
        "url": url,
    }


def trade_rows(chamber: str, doc_id: str, member: str, filed: str, rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [{**row, "chamber": chamber, "docId": doc_id, "filedOn": filed, "member": member} for row in rows]


def window(ctx: Context) -> tuple[str, str]:
    return ctx.start(DEFAULT_DAYS).isoformat(), ctx.end().isoformat()


# --- House ---------------------------------------------------------------------------------------

_HOUSE_TYPES = {"P": "purchase", "S": "sale", "S (partial)": "sale_partial", "E": "exchange"}
_HOUSE_HOLDERS = {"SP": "spouse", "JT": "joint", "DC": "dependent"}
# A range, an open range, or one exact value (some filings give the exact amount with cents).
_HOUSE_AMOUNT = r"(?:Over \$[\d,]+|\$[\d,]+\.\d{2}|\$[\d,]+(?:\s*-\s*(?:\$[\d,]+)?)?)"
_HOUSE_TX = re.compile(
    r"^(?P<lead>\s*)(?P<pre>\S.*?)\s+(?P<type>P|S \(partial\)|S|E)\s+(?P<tdate>\d{2}/\d{2}/\d{4})"
    r"\s+(?P<ndate>\d{2}/\d{2}/\d{4})(?:\s+(?P<amt>" + _HOUSE_AMOUNT + r"))?(?P<rest>.*)$"
)
_HOUSE_AMOUNT_PART = re.compile(_HOUSE_AMOUNT)
# Lines under a transaction: filing status, subholding of, description, comments, location.
_HOUSE_META = re.compile(r"^\s*(?:F S|S O|D|C|L)\s*:")
_HOUSE_TICKER = re.compile(r"\(([A-Z][A-Z0-9.\-]{0,9})\)\s*\[([A-Z]{2})\]")
_HOUSE_TYPE_CODE = re.compile(r"\[([A-Z]{2})\]")
_COLUMN_GAP = re.compile(r"\s{3,}")


@dataclass(frozen=True)
class HouseFiling:
    doc_id: str
    member: str
    state_district: str | None
    filed_on: str
    year: int

    @property
    def url(self) -> str:
        return f"{HOUSE_BASE}/ptr-pdfs/{self.year}/{self.doc_id}.pdf"

    @property
    def scanned(self) -> bool:
        return not self.doc_id.startswith("2")


def house_index(text: str, year: int) -> list[HouseFiling]:
    """PTR rows (FilingType P) of the tab-separated `<YEAR>FD.txt` index."""
    lines = text.splitlines()
    if not lines:
        return []
    header = [h.strip() for h in lines[0].split("\t")]
    out = []
    for line in lines[1:]:
        cells = dict(zip(header, (c.strip() for c in line.split("\t")), strict=False))
        if cells.get("FilingType") != "P":
            continue
        doc_id = cells.get("DocID", "")
        filed = us_date(cells.get("FilingDate", ""))
        if not _HOUSE_DOC.fullmatch(doc_id) or filed is None:
            continue
        name = collapse(" ".join(cells.get(k, "") for k in ("Prefix", "First", "Last", "Suffix")))
        if not name:
            continue
        state = collapse(cells.get("StateDst", ""))[:10] or None
        out.append(HouseFiling(doc_id, name[:200], state, filed, year))
    return out


def house_index_text(zip_bytes: bytes, year: int) -> str:
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as archive:
        info = archive.getinfo(f"{year}FD.txt")
        if info.file_size > INDEX_CAP:
            raise UpstreamError("error", f"{year}FD.txt is larger than {INDEX_CAP // (1024 * 1024)} MiB")
        return archive.read(info).decode("utf-8-sig", errors="replace")


def pdf_text(data: bytes) -> str:
    """Text of the first 40 pages (pdfplumber layout mode), NUL characters and line ends trimmed."""
    import pdfplumber

    with pdfplumber.open(io.BytesIO(data)) as pdf:
        pages = [(page.extract_text(layout=True) or "") for page in pdf.pages[:MAX_PDF_PAGES]]
    text = "\n".join(pages).replace("\x00", "")
    return "\n".join(line.rstrip() for line in text.splitlines())


def _house_holder(match: re.Match[str], owner_col: int) -> tuple[str, str]:
    """(holder, asset start) from the text before the transaction type."""
    pre = match["pre"]
    first, _, tail = pre.partition(" ")
    near_owner_column = owner_col < 0 or len(match["lead"]) <= owner_col + 2
    if first in _HOUSE_HOLDERS and near_owner_column and tail.strip():
        return _HOUSE_HOLDERS[first], tail
    return "self", pre


def _house_raw_rows(lines: list[str], owner_col: int) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    current: dict[str, Any] | None = None
    closed = False
    for line in lines:
        stripped = line.strip()
        if stripped.startswith("* For the complete list"):
            break
        if not stripped or stripped.startswith(("Filing ID #", "ID ", "Type ", "$200?")):
            continue
        match = _HOUSE_TX.match(line)
        if match:
            holder, asset = _house_holder(match, owner_col)
            current = {
                "holder": holder,
                "asset": collapse(asset),
                "type": match["type"],
                "transactionDate": us_date(match["tdate"]),
                "amount": collapse(match["amt"] or ""),
                "rest": match["rest"].strip(),
            }
            rows.append(current)
            closed = False
            continue
        if current is None:
            continue
        if _HOUSE_META.match(line):
            closed = True
            continue
        if closed:
            continue
        left = []
        for part in _COLUMN_GAP.split(stripped):
            pending = current["amount"] == "" or current["amount"].endswith("-")
            if pending and _HOUSE_AMOUNT_PART.fullmatch(part):
                current["amount"] = collapse(f"{current['amount']} {part}")
            else:
                left.append(part)
        if left:
            current["asset"] = collapse(f"{current['asset']} {' '.join(left)}")
    return rows


def parse_house_ptr(text: str) -> tuple[list[dict[str, Any]], str | None]:
    """Transactions of one electronic House PTR (pdfplumber layout text).

    Returns (rows, None) or ([], reason). A row starts on a line that holds the type code, the
    transaction date and the notification date; the asset name (and a wrapped amount) continue on
    the next lines until the filing-status lines. Any incomplete row makes the filing
    `layout_unknown`.
    """
    lines = text.replace("\x00", "").splitlines()
    start = next((i for i, line in enumerate(lines) if line.strip().startswith("$200?")), None)
    if start is None:
        return [], "layout_unknown"
    owner_col = lines[start - 2].find("Owner") if start >= 2 else -1
    raw = _house_raw_rows(lines[start + 1 :], owner_col)
    if not raw:
        return [], "no_transactions"
    out = []
    for number, row in enumerate(raw, start=1):
        amount = row["amount"]
        if not amount or amount.endswith("-") or row["transactionDate"] is None or row["rest"]:
            return [], "layout_unknown"
        ticker = _HOUSE_TICKER.search(row["asset"])
        code = _HOUSE_TYPE_CODE.search(row["asset"])
        low, high = amount_range(amount)
        out.append(
            {
                "amountHigh": high,
                "amountLabel": amount[:60],
                "amountLow": low,
                "asset": row["asset"][:500],
                "assetType": code[1] if code else None,
                "holder": row["holder"],
                "rowNumber": number,
                "ticker": ticker[1] if ticker else None,
                "transactionDate": row["transactionDate"],
                "transactionType": _HOUSE_TYPES[row["type"]],
            }
        )
    return out, None


def house_years(first: str, last: str) -> list[int]:
    return list(range(int(first[:4]), int(last[:4]) + 1))


def _house_fetchers(agent: str) -> tuple[Callable[[int], Callable[[], str]], Callable[[HouseFiling], Callable[[], str]]]:
    import requests

    session = requests.Session()
    session.headers["User-Agent"] = agent

    def index(year: int) -> Callable[[], str]:
        def run() -> str:
            time.sleep(HOUSE_PAUSE_S)
            response = session.get(f"{HOUSE_BASE}/financial-pdfs/{year}FD.zip", timeout=(10, 60), stream=True)
            return house_index_text(read_capped(response, ZIP_CAP, f"{year}FD.zip"), year)

        return run

    def pdf(filing: HouseFiling) -> Callable[[], str]:
        def run() -> str:
            time.sleep(HOUSE_PAUSE_S)
            response = session.get(filing.url, timeout=(10, 60), stream=True)
            return pdf_text(read_capped(response, PDF_CAP, f"{filing.doc_id}.pdf"))

        return run

    return index, pdf


async def house(ctx: Context) -> dict[str, list[dict[str, Any]]]:
    agent = user_agent(ctx.env)
    first, last = window(ctx)
    trades = ctx.table("congress_trades")
    filings = ctx.table("congress_filings")
    index_func, pdf_func = _house_fetchers(agent)
    found: dict[str, HouseFiling] = {}
    for year in house_years(first, last):
        source = f"house index {year}"
        try:
            text = await ctx.up.helper(f"congress:house-index:{year}", index_func(year))
        except UpstreamError as exc:
            if exc.kind == "not_found":
                ctx.ok()
                ctx.warn(f"{source}: not published yet")
            else:
                ctx.failed(source, exc)
            continue
        listed = ctx.take(source, [text] if text else [], lambda t=text, y=year: house_index(t, y), [], expect_rows=False)
        for filing in listed:
            if first <= filing.filed_on <= last:
                found.setdefault(filing.doc_id, filing)
    for filing in sorted(found.values(), key=lambda f: (f.filed_on, f.doc_id)):
        if filing.scanned:
            rows, reason = [], "scanned_image"
        else:
            try:
                text = await ctx.up.helper(f"congress:house-pdf:{filing.doc_id}", pdf_func(filing))
            except UpstreamError as exc:
                ctx.warn(f"house filing {filing.doc_id}: {exc.message}")
                continue
            rows, reason = parse_house_ptr(str(text or ""))
        trades.extend(trade_rows("house", filing.doc_id, filing.member, filing.filed_on, rows))
        filings.append(
            filing_row("house", filing.doc_id, filing.member, filing.state_district, filing.filed_on,
                       filing.url, len(rows), reason, HOUSE_PARSER, False)
        )
    return {"congress_trades": trades, "congress_filings": filings}


# --- Senate --------------------------------------------------------------------------------------

_SENATE_LINK = re.compile(r'href="(/search/view/(ptr|paper)/([0-9a-fA-F-]{36})/?)"[^>]*>([^<]*)<', re.IGNORECASE)
_SENATE_UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
_TAG = re.compile(r"<[^>]+>")
_ROW = re.compile(r"<tr[^>]*>(.*?)</tr>", re.DOTALL | re.IGNORECASE)
_CELL = re.compile(r"<t[dh][^>]*>(.*?)</t[dh]>", re.DOTALL | re.IGNORECASE)
_TABLE = re.compile(r"<table.*?</table>", re.DOTALL | re.IGNORECASE)
_CSRF = re.compile(r'name="csrfmiddlewaretoken"\s+value="([^"]+)"')
_SENATE_HOLDERS = {"self": "self", "spouse": "spouse", "joint": "joint", "child": "dependent", "dependent": "dependent"}
_SENATE_COLUMNS = ("transaction date", "owner", "ticker", "asset name", "asset type", "type", "amount")


def senate_type(text: str) -> str:
    value = text.strip().lower()
    if value == "purchase":
        return "purchase"
    if value.startswith("sale (full)") or value == "sale":
        return "sale"
    if value.startswith("sale (partial)"):
        return "sale_partial"
    if value.startswith("exchange"):
        return "exchange"
    return "other"


def senate_search_row(row: Any) -> dict[str, Any] | None:
    """One search-result row: [first, last, office, link html, date received]."""
    if not isinstance(row, list) or len(row) < 5 or not all(isinstance(c, str) for c in row[:5]):
        return None
    link = _SENATE_LINK.search(row[3])
    received = us_date(row[4])
    member = collapse(f"{html_lib.unescape(row[0])} {html_lib.unescape(row[1])}")[:200]
    if not link or received is None or not member:
        return None
    doc_id = link[3].lower()
    if not _SENATE_UUID.fullmatch(doc_id):
        return None
    title = html_lib.unescape(link[4])
    kind = link[2].lower()
    return {
        "amends": "amendment" in title.lower(),
        "docId": doc_id,
        "filedOn": received,
        "kind": kind,
        "member": member,
        "url": f"{SENATE_BASE}/search/view/{kind}/{doc_id}/",
    }


def first_table(page: str) -> str:
    match = _TABLE.search(page)
    return match[0] if match else ""


def _cell_text(cell: str) -> str:
    return collapse(html_lib.unescape(_TAG.sub(" ", cell)))


def parse_senate_ptr(table: str) -> tuple[list[dict[str, Any]], str | None]:
    """Transactions of one electronic Senate PTR (the transactions table HTML)."""
    rows = [[_cell_text(c) for c in _CELL.findall(r)] for r in _ROW.findall(table)]
    if not rows:
        return [], "layout_unknown"
    header = [h.lower() for h in rows[0]]
    if any(w not in header for w in _SENATE_COLUMNS):
        return [], "layout_unknown"
    index = {w: header.index(w) for w in _SENATE_COLUMNS}
    out = []
    for cells in rows[1:]:
        if len(cells) < len(header):
            return [], "layout_unknown"
        amount = cells[index["amount"]]
        low, high = amount_range(amount)
        transaction_date = us_date(cells[index["transaction date"]])
        if low is None or transaction_date is None:
            return [], "layout_unknown"
        asset_type = cells[index["asset type"]] or None
        out.append(
            {
                "amountHigh": high,
                "amountLabel": amount[:60],
                "amountLow": low,
                "asset": cells[index["asset name"]][:500],
                "assetType": asset_type[:40] if asset_type else None,
                "holder": _SENATE_HOLDERS.get(cells[index["owner"]].strip().lower()),
                "rowNumber": len(out) + 1,
                "ticker": ticker_or_none(cells[index["ticker"]]),
                "transactionDate": transaction_date,
                "transactionType": senate_type(cells[index["type"]]),
            }
        )
    if not out:
        return [], "no_transactions"
    return out, None


def senate_date(day: str) -> str:
    """YYYY-MM-DD -> 'MM/DD/YYYY 00:00:00' (eFD search form)."""
    return f"{day[5:7]}/{day[8:10]}/{day[:4]} 00:00:00"


class SenateSession:
    """One eFD session for every call of a run (home page, agreement, search, report pages)."""

    def __init__(self, agent: str) -> None:
        import requests

        self.session = requests.Session()
        self.session.headers["User-Agent"] = agent
        self.token = ""

    def _request(self, method: str, path: str, **kwargs: Any) -> bytes:
        time.sleep(SENATE_PAUSE_S)
        response = self.session.request(method, SENATE_BASE + path, timeout=(10, 60), stream=True, **kwargs)
        return read_capped(response, PAGE_CAP, path)

    def open(self) -> None:
        home = self._request("GET", "/search/home/").decode("utf-8", errors="replace")
        token = _CSRF.search(home)
        if not token:
            raise UpstreamError("error", "eFD home page has no CSRF token (layout change?)")
        self._request(
            "POST", "/search/home/",
            data={"prohibition_agreement": "1", "csrfmiddlewaretoken": token[1]},
            headers={"Referer": f"{SENATE_BASE}/search/home/"},
        )
        self.token = self.session.cookies.get("csrftoken") or token[1]

    def search(self, since: str) -> list[Any]:
        import json

        self.open()
        rows: list[Any] = []
        for page in range(MAX_SEARCH_PAGES):
            body = self._request(
                "POST", "/search/report/data/",
                data={
                    "start": str(page * SEARCH_PAGE), "length": str(SEARCH_PAGE), "report_types": "[11]",
                    "filer_types": "[]", "submitted_start_date": senate_date(since), "submitted_end_date": "",
                    "candidate_state": "", "senator_state": "", "office_id": "", "first_name": "",
                    "last_name": "", "csrfmiddlewaretoken": self.token,
                },
                headers={"X-CSRFToken": self.token, "Referer": f"{SENATE_BASE}/search/"},
            )
            data = json.loads(body).get("data")
            if not isinstance(data, list):
                raise UpstreamError("error", "eFD search answer has no data list")
            rows.extend(data)
            if len(data) < SEARCH_PAGE:
                return rows
        raise UpstreamError("error", f"eFD search has more than {MAX_SEARCH_PAGES * SEARCH_PAGE} rows")

    def ptr_table(self, doc_id: str) -> str:
        page = self._request("GET", f"/search/view/ptr/{doc_id}/").decode("utf-8", errors="replace")
        if "prohibition_agreement" in page:
            raise UpstreamError("error", "eFD session expired (agreement page returned)")
        return first_table(page)


async def senate(ctx: Context) -> dict[str, list[dict[str, Any]]]:
    agent = user_agent(ctx.env)
    first, last = window(ctx)
    trades = ctx.table("congress_trades")
    filings = ctx.table("congress_filings")
    efd = SenateSession(agent)
    source = "senate search"
    try:
        found = await ctx.up.helper(f"congress:senate-search:{first}", lambda: efd.search(first))
    except UpstreamError as exc:
        ctx.failed(source, exc)
        return {"congress_trades": trades, "congress_filings": filings}
    found = found if isinstance(found, list) else []
    listed = ctx.take(source, found, lambda: [r for r in map(senate_search_row, found) if r], [], expect_rows=False)
    kept = {r["docId"]: r for r in listed if first <= r["filedOn"] <= last}
    for item in sorted(kept.values(), key=lambda r: (r["filedOn"], r["docId"])):
        doc_id = item["docId"]
        if item["kind"] == "paper":
            rows, reason = [], "scanned_image"
        else:
            try:
                table = await ctx.up.helper(f"congress:senate-ptr:{doc_id}", lambda d=doc_id: efd.ptr_table(d))
            except UpstreamError as exc:
                ctx.warn(f"senate filing {doc_id}: {exc.message}")
                continue
            rows, reason = parse_senate_ptr(str(table or ""))
        trades.extend(trade_rows("senate", doc_id, item["member"], item["filedOn"], rows))
        filings.append(
            filing_row("senate", doc_id, item["member"], None, item["filedOn"], item["url"],
                       len(rows), reason, SENATE_PARSER, item["amends"])
        )
    return {"congress_trades": trades, "congress_filings": filings}
