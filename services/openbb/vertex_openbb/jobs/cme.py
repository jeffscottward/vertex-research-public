"""CME job: preliminary open interest of the ES and NQ futures (daily "Volume and Open Interest" workbook).

`cme-futures-oi` reads one workbook per weekday of its date range from the CME public FTP server
(`cme_ftp`), newest first, and keeps the open interest of the rows (`ES`, `F`) and (`NQ`, `F`) of the
sheet by product: the total of all contract months. Each value is one `macro_points` row of the
series `CME_ES_OI` or `CME_NQ_OI`. The figure is the preliminary one; CME publishes the final figure
the next morning in another report.

The workbook is untrusted input. The helper call returns plain cells (sheet name, trade-date text,
header row, product rows), and the checks run on those cells and fail closed: a file-level check
fails the file as one source, a product-level check fails that product only. A weekday without a
file (a `550` reply) is a day that CME did not publish, for example a holiday; it adds no warning.
"""

from __future__ import annotations

import io
import re
import zipfile
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import date, timedelta
from typing import Any

from ..cme_ftp import CmeFtp, file_name
from ..context import ArgumentError, Context
from ..upstream import UpstreamError
from .macro import point

SHEET = "CME Group Vol and OI by Product"
# Today and the 4 days before: 5 dates, so a missed day is read again on the next runs.
DEFAULT_DAYS = 4
# (until - since).days + 1 must not be larger: one year of weekdays fits in the job deadline.
MAX_RANGE_DAYS = 370
# From this many weekdays on, a range without any file is a failure (a moved directory or a renamed
# file pattern must not look like a holiday week).
MIN_WEEKDAYS_FOR_EMPTY_FAILURE = 3
MAX_UNZIPPED_BYTES = 20_000_000
MAX_OPEN_INTEREST = 50_000_000

COMMODITY = "Commodity Indicator"
DESCRIPTION = "Product Description"
FUTURE_OPTION = "Future/Option Indicator"
OPEN_INTEREST = "Open Interest"
COLUMNS = (COMMODITY, DESCRIPTION, FUTURE_OPTION, OPEN_INTEREST)
FUTURE = "F"
SATURDAY = 5

_MARKS = re.compile("[①②®]")
_TRADE_DATE = re.compile(r"^Trade Date:\s*(\d{1,2})/(\d{1,2})/(\d{4})$")


@dataclass(frozen=True)
class Product:
    # Commodity indicator of the workbook row.
    code: str
    series_id: str
    # Must be part of the product description (a reused code for another product fails the check).
    words: str


PRODUCTS = (Product("ES", "CME_ES_OI", "E-MINI S&P 500"), Product("NQ", "CME_NQ_OI", "E-MINI NASDAQ"))


def weekdays(first: date, last: date) -> list[date]:
    """Monday to Friday from `first` to `last`, newest first."""
    days = (last - timedelta(days=offset) for offset in range((last - first).days + 1))
    return [day for day in days if day.weekday() < SATURDAY]


def header_name(text: Any) -> str:
    """A header text without the footnote and trademark marks, with line breaks and repeated spaces as one space."""
    return " ".join(_MARKS.sub("", str(text)).split())


def _positions(header: list[str], name: str) -> list[int]:
    return [index for index, text in enumerate(header) if header_name(text) == name]


def _cell(row: Any, index: int) -> Any:
    """The cell at `index`; None when the row is shorter (the workbook leaves out empty cells at the end)."""
    return row[index] if isinstance(row, (list, tuple)) and index < len(row) else None


def _is_future_of(row: Any, commodity: int, kind: int, codes: tuple[str, ...]) -> bool:
    return str(_cell(row, commodity)).strip() in codes and str(_cell(row, kind)).strip() == FUTURE


def trade_date(text: Any) -> date | None:
    """The date of `Trade Date:  MM/DD/YYYY` (row 2 of the sheet), else None."""
    match = _TRADE_DATE.match(str(text).strip())
    if not match:
        return None
    try:
        return date(int(match[3]), int(match[1]), int(match[2]))
    except ValueError:
        return None


def _sheet_cells(book: Any) -> dict[str, Any]:
    if SHEET not in book.sheetnames:
        raise ValueError(f'sheet "{SHEET}" not found')
    sheet = book[SHEET]
    # The CME files declare the sheet one column too narrow (A to K); without this, read-only mode
    # cuts the open-interest column (L).
    sheet.reset_dimensions()
    rows = sheet.iter_rows(values_only=True)
    next(rows, None)
    first_cell = _cell(next(rows, None) or (), 0)
    header = ["" if cell is None else str(cell) for cell in next(rows, None) or ()]
    commodity, kind = _positions(header, COMMODITY), _positions(header, FUTURE_OPTION)
    codes = tuple(product.code for product in PRODUCTS)
    kept: list[list[Any]] = []
    # Without exactly one column of each kind no row can be matched; `file_columns` reports the header.
    if len(commodity) == 1 and len(kind) == 1:
        kept = [list(row) for row in rows if _is_future_of(row, commodity[0], kind[0], codes)]
    return {"sheet": SHEET, "tradeDate": "" if first_cell is None else str(first_cell), "header": header, "rows": kept}


def workbook_cells(data: bytes) -> dict[str, Any]:
    """The plain cells that the checks need: sheet name, trade-date text, header row, product rows.

    Raises ValueError for a file that is not a readable workbook, whose zip members add up to more
    than `MAX_UNZIPPED_BYTES`, or that has no sheet `SHEET`.
    """
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            unzipped = sum(member.file_size for member in archive.infolist())
    except zipfile.BadZipFile as exc:
        raise ValueError("not a zip file") from exc
    if unzipped > MAX_UNZIPPED_BYTES:
        raise ValueError(f"unzipped size is larger than {MAX_UNZIPPED_BYTES} bytes")
    # Imported here: the CLI and the replay tests must not load openpyxl.
    import openpyxl

    try:
        book = openpyxl.load_workbook(io.BytesIO(data), read_only=True, data_only=True)
        try:
            return _sheet_cells(book)
        finally:
            book.close()
    except ValueError:
        raise
    except Exception as exc:  # noqa: BLE001 - any other parser error means the file is not a usable workbook
        raise ValueError(f"not a readable workbook ({type(exc).__name__})") from exc


def read_cells(ftp: CmeFtp, day: date) -> dict[str, Any] | None:
    """Fetch and open the workbook of `day` (runs inside the upstream helper). None: not published."""
    data = ftp.workbook(day)
    if data is None:
        return None
    try:
        return workbook_cells(data)
    except ValueError as exc:
        raise UpstreamError("error", f"CME {file_name(day)}: {exc}") from exc


def file_columns(cells: Mapping[str, Any], day: date) -> dict[str, int]:
    """File-level checks; returns the column index of each header in `COLUMNS`. Raises ValueError."""
    if cells.get("sheet") != SHEET:
        raise ValueError(f'sheet "{SHEET}" not found')
    header = list(cells.get("header") or [])
    columns: dict[str, int] = {}
    for name in COLUMNS:
        found = _positions(header, name)
        if len(found) != 1:
            raise ValueError(f'header "{name}" found {len(found)} times in {header!r}')
        columns[name] = found[0]
    text = cells.get("tradeDate")
    if trade_date(text) != day:
        raise ValueError(f'trade date "{text}" is not {day.isoformat()}')
    return columns


def product_row(cells: Mapping[str, Any], columns: Mapping[str, int], product: Product) -> dict[str, Any]:
    """Product-level checks; returns the `macro_points` row of the product. Raises ValueError."""
    rows = [
        row for row in cells.get("rows") or []
        if _is_future_of(row, columns[COMMODITY], columns[FUTURE_OPTION], (product.code,))
    ]
    if len(rows) != 1:
        raise ValueError(f"{len(rows)} rows for {product.code}/{FUTURE}")
    description = _cell(rows[0], columns[DESCRIPTION])
    if product.words.upper() not in str(description).upper():
        raise ValueError(f'description "{description}" does not contain "{product.words}"')
    value = _cell(rows[0], columns[OPEN_INTEREST])
    # A float without a fraction passes: the workbook stores some whole numbers as floats.
    whole = isinstance(value, (int, float)) and not isinstance(value, bool) and value == value // 1
    if not whole or not 1 <= value <= MAX_OPEN_INTEREST:
        raise ValueError(f"open interest {value} is not a whole number from 1 to {MAX_OPEN_INTEREST}")
    return {**point(product.series_id, trade_date(cells.get("tradeDate")), value, 0), "value": int(value)}


async def futures_oi(ctx: Context) -> dict[str, list[dict[str, Any]]]:
    if ctx.symbols is not None:
        raise ArgumentError("cme-futures-oi takes no --symbols")
    first, last = ctx.start(DEFAULT_DAYS), ctx.end()
    if (last - first).days + 1 > MAX_RANGE_DAYS:
        raise ArgumentError(f"cme-futures-oi reads at most {MAX_RANGE_DAYS} days per run")
    # Rows go to the context table as they are read, so a run that reaches the job deadline keeps
    # the figures of the newest files.
    points = ctx.table("macro_points")
    days = weekdays(first, last)
    files_read = 0
    ftp = CmeFtp()
    try:
        for day in days:
            source = f"cme {file_name(day)}"
            try:
                cells = await ctx.up.helper(f"cme-ftp:{file_name(day)}", lambda d=day: read_cells(ftp, d))
            except UpstreamError as exc:
                # Also after the helper timeout: the abandoned thread must not share the session
                # with the next call.
                ftp.close()
                ctx.failed(source, exc)
                continue
            if cells is None:
                continue
            files_read += 1
            try:
                columns = file_columns(cells, day)
            except ValueError as exc:
                ctx.failed(source, UpstreamError("error", str(exc)))
                continue
            for product in PRODUCTS:
                try:
                    row = product_row(cells, columns, product)
                except ValueError as exc:
                    ctx.failed(f"{source} {product.code}", UpstreamError("error", str(exc)))
                    continue
                ctx.take(f"{source} {product.code}", [row], lambda r=row: [r], points)
    finally:
        ftp.close()
    if files_read == 0 and ctx.sources_failed == 0:
        if len(days) >= MIN_WEEKDAYS_FOR_EMPTY_FAILURE:
            message = f"no daily volume file from {first.isoformat()} to {last.isoformat()}"
            ctx.failed("cme daily volume", UpstreamError("error", message))
        else:
            ctx.nothing_new = True
    return {"macro_points": points}
