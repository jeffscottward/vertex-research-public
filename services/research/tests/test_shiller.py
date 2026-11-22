"""shiller.py: the workbook link and the monthly rows (a fake xlrd; no network, no dependency)."""
from __future__ import annotations

import sys
import types
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import shiller  # noqa: E402


class _Sheet:
    def __init__(self, rows: list[list[object]]) -> None:
        self._rows = rows
        self.nrows = len(rows)

    def cell_value(self, row: int, column: int) -> object:
        return self._rows[row][column]


class _Book:
    def __init__(self, rows: list[list[object]]) -> None:
        self._rows = rows

    def sheet_by_name(self, name: str) -> _Sheet:
        if name != "Data":
            raise KeyError(name)
        return _Sheet(self._rows)


class ShillerTest(unittest.TestCase):
    def test_workbook_url(self) -> None:
        page = '<a href="//img1.wsimg.com/blobby/go/x/downloads/ie_data.xls?ver=1">ie_data</a>'
        self.assertEqual(shiller.workbook_url(page), "https://img1.wsimg.com/blobby/go/x/downloads/ie_data.xls?ver=1")
        self.assertEqual(shiller.workbook_url('href="https://h.invalid/ie_data.xls"'), "https://h.invalid/ie_data.xls")
        with self.assertRaisesRegex(ValueError, "ie_data.xls link not found"):
            shiller.workbook_url("<html></html>")

    def test_monthly_rows_keep_only_complete_positive_months(self) -> None:
        rows = [
            ["Date", "P", "D", "E"],          # header: not numbers
            [2026.01, 6000.12345, 70.0, 250.98765],
            [2026.1, 6100.0, 70.0, 252.5],    # 2026.1 is October
            [2026.13, 6100.0, 70.0, 252.5],   # no month 13
            [2026.02, 0.0, 70.0, 250.0],      # price must be positive
            [2026.03, 6200.0, 70.0, "NA"],    # earnings not published yet
            [2026.04, "", 70.0, 250.0],
            [2026.05, 6200.0, 70.0, 0.0],
        ]
        seen: list[bytes] = []

        def open_workbook(file_contents: bytes) -> _Book:
            seen.append(file_contents)
            return _Book(rows)

        original = sys.modules.get("xlrd")
        sys.modules["xlrd"] = types.SimpleNamespace(open_workbook=open_workbook)  # type: ignore[assignment]
        try:
            result = shiller.monthly_rows(b"workbook bytes")
        finally:
            if original is None:
                del sys.modules["xlrd"]
            else:
                sys.modules["xlrd"] = original
        self.assertEqual(seen, [b"workbook bytes"])
        self.assertEqual(result, [("2026-01", 6000.1235, 250.9877), ("2026-10", 6100.0, 252.5)])


if __name__ == "__main__":
    unittest.main()
