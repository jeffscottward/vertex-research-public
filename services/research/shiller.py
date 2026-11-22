"""Robert Shiller's monthly S&P composite data (shillerdata.com, workbook ie_data.xls).

Shared by research/backtests/qc-ports/fetch_data.py (SHILLER.csv) and the OpenBB fetcher job
`daily-prices` (the derived series EY_TNX_RATIO). Parsing only: the caller downloads the page and the
workbook. Values are rounded to 4 decimals, the precision of SHILLER.csv, so both users derive the same
numbers. Research only: public data, no orders.
"""
from __future__ import annotations

import re

PAGE_URL = "https://shillerdata.com/"
_LINK = re.compile(r'href="([^"]*ie_data\.xls[^"]*)"')
_DATE_COLUMN, _PRICE_COLUMN, _EARNINGS_COLUMN = 0, 1, 3


def workbook_url(page: str) -> str:
    """The ie_data.xls link of the shillerdata.com page; ValueError when the page has none."""
    match = _LINK.search(page)
    if match is None:
        raise ValueError("ie_data.xls link not found on shillerdata.com")
    url = match.group(1)
    return "https:" + url if url.startswith("//") else url


def monthly_rows(content: bytes) -> list[tuple[str, float, float]]:
    """(month `YYYY-MM`, price, trailing 12-month earnings) of the workbook's Data sheet, in sheet order.

    A row is kept when its date cell is a number `YYYY.MM` with a month from 1 to 12 and price and
    earnings are positive numbers. xlrd is imported here, so importing this module needs no dependency.
    """
    import xlrd

    sheet = xlrd.open_workbook(file_contents=content).sheet_by_name("Data")
    rows: list[tuple[str, float, float]] = []
    for index in range(sheet.nrows):
        date_cell = sheet.cell_value(index, _DATE_COLUMN)
        price = sheet.cell_value(index, _PRICE_COLUMN)
        earnings = sheet.cell_value(index, _EARNINGS_COLUMN)
        if not isinstance(date_cell, float) or not isinstance(price, float) or not isinstance(earnings, float):
            continue
        year = int(date_cell)
        month = int(round((date_cell - year) * 100))
        if 1 <= month <= 12 and price > 0 and earnings > 0:
            rows.append((f"{year:04d}-{month:02d}", round(price, 4), round(earnings, 4)))
    return rows
