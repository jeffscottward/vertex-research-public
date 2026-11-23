"""CME job: FTP adapter (fake FTP class), workbook cells, checks and job outcomes."""

from __future__ import annotations

import asyncio
import ftplib
import io
import subprocess
import sys
import zipfile
from collections.abc import Callable
from datetime import date, timedelta
from typing import Any, cast

import openpyxl
import pytest
from conftest import ROOT, call, error, replay_fixture, run, upstream_fixture

from vertex_openbb import cli, cme_ftp
from vertex_openbb.context import ArgumentError, Context
from vertex_openbb.jobs import cme, macro
from vertex_openbb.upstream import ReplayUpstream, Upstream, UpstreamError

DAY = date(2026, 11, 19)
FILE = "daily_volume_20261119.xlsx"
NEXT_FILE = "daily_volume_20261120.xlsx"
# Header texts of the real workbook (sheet by product), as read.
HEADER = [
    "Description", "Exchange Name", "Commodity Indicator", "Product Description", "Future/Option Indicator",
    "CME® \nGlobex® \nVolume", "Pit\nVolume", "ExPit\nVolume", "OTC Volume", "Total\nVolume", "MTD ADV", "Open\nInterest ②",
]
ES, NQ = cme.PRODUCTS


def product_cells(code: str, kind: str, description: str, open_interest: Any) -> list[Any]:
    return ["EQUITY INDEX", "Chicago Mercantile Exchange (STATS)", code, description, kind, 1000.0, 0, 0, 10, 1010.0, 990.5, open_interest]


ES_ROW = product_cells("ES", "F", "E-MINI S&P 500 FUTURE", 2400300.0)
NQ_ROW = product_cells("NQ", "F", "E-MINI NASDAQ 100 FUTURE", 310300)
OTHER_ROWS = [
    product_cells("SR3", "F", "THREE-MONTH SOFR FUTURES", 13000000),
    product_cells("ES", "O", "E-MINI S&P 500 PUT", 58000),
    product_cells("NQ", "O", "E-MINI NASDAQ 100 CALL", 6500),
]


def cells(day: date = DAY, **changes: Any) -> dict[str, Any]:
    """The helper result of one file (plain cells)."""
    base = {"sheet": cme.SHEET, "tradeDate": f"Trade Date:  {day:%m/%d/%Y}", "header": list(HEADER), "rows": [list(ES_ROW), list(NQ_ROW)]}
    return {**base, **changes}


def workbook(rows: list[list[Any]] | None = None, *, header: list[str] | None = None, second: bool = True) -> bytes:
    """A workbook with the layout of the CME file: title, trade date, header, data rows."""
    book = openpyxl.Workbook()
    book.active.title = "CME Group Volume and OI"
    book.active.append(["CME Group Volume and OI"])
    if second:
        sheet = book.create_sheet(cme.SHEET)
        sheet.append(["CME Group Volume and OI by Product"])
        sheet.append(["Trade Date:  11/19/2026"])
        sheet.append(HEADER if header is None else header)
        for row in [OTHER_ROWS[0], ES_ROW, NQ_ROW, *OTHER_ROWS[1:]] if rows is None else rows:
            sheet.append(row)
    out = io.BytesIO()
    book.save(out)
    return out.getvalue()


def with_changed_sheet(data: bytes, change: Callable[[bytes], bytes]) -> bytes:
    """The workbook `data` with another XML text of the sheet by product."""
    source = zipfile.ZipFile(io.BytesIO(data))
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as target:
        for member in source.infolist():
            content = source.read(member.filename)
            target.writestr(member, change(content) if member.filename == "xl/worksheets/sheet2.xml" else content)
    return out.getvalue()


# --- FTP adapter -----------------------------------------------------------------------------------


class Clock:
    def __init__(self) -> None:
        self.now = 0.0

    def __call__(self) -> float:
        return self.now


class FakeFtp:
    """Stands in for `ftplib.FTP`: logs each command and answers it from the server's script."""

    def __init__(self, server: Server, options: dict[str, Any]) -> None:
        self.server = server
        self.options = options
        self.log: list[str] = []

    def _command(self, name: str) -> None:
        self.log.append(name)
        reaction = self.server.fail.get(name)
        if isinstance(reaction, BaseException):
            raise reaction
        if reaction is not None:
            reaction()

    def connect(self, host: str) -> None:
        self._command(f"connect {host}")

    def login(self) -> None:
        self._command("login")

    def set_pasv(self, on: bool) -> None:
        self._command(f"pasv {on}")

    def cwd(self, path: str) -> None:
        self._command(f"cwd {path}")

    def retrbinary(self, command: str, callback: Callable[[bytes], None]) -> None:
        self.log.append(command)
        answer = self.server.files[command.removeprefix("RETR ")]
        if isinstance(answer, BaseException):
            raise answer
        for part in answer:
            if isinstance(part, bytes):
                callback(part)
            elif isinstance(part, float):  # the transfer stalls for this many seconds
                self.server.clock.now += part
            elif isinstance(part, BaseException):
                raise part
            else:
                part()

    def quit(self) -> None:
        self._command("quit")

    def close(self) -> None:
        self._command("close")


class Server:
    """The fake FTP class that the adapter gets: `files` maps a file name to an exception (the RETR
    reply) or to the parts of the transfer; `fail` maps a command to the exception it raises (or to
    a function that runs when the command arrives)."""

    def __init__(self, files: dict[str, Any] | None = None, fail: dict[str, Any] | None = None) -> None:
        self.files = files or {}
        self.fail = fail or {}
        self.clock = Clock()
        self.slept: list[float] = []
        self.sessions: list[FakeFtp] = []

    def __call__(self, **options: Any) -> FakeFtp:
        self.sessions.append(FakeFtp(self, options))
        return self.sessions[-1]

    def adapter(self) -> cme_ftp.CmeFtp:
        return cme_ftp.CmeFtp(cast("Callable[..., ftplib.FTP]", self), self.clock, self.slept.append)


OPENING = ["connect ftp.cmegroup.com", "login", "pasv True", "cwd /daily_volume"]


def upstream_error(action: Callable[[], Any]) -> UpstreamError:
    with pytest.raises(UpstreamError) as caught:
        action()
    assert caught.value.kind == "error" and caught.value.status is None and caught.value.host is None
    return caught.value


def test_file_name() -> None:
    assert cme_ftp.file_name(DAY) == FILE
    assert cme_ftp.file_name(date(2026, 1, 2)) == "daily_volume_20260102.xlsx"


def test_two_files_use_one_login_and_the_pause_runs_before_the_second_only() -> None:
    server = Server({FILE: [b"ab", b"cd"], NEXT_FILE: [b"ef"]})
    ftp = server.adapter()
    assert ftp.workbook(DAY) == b"abcd"
    assert server.slept == []
    assert ftp.workbook(date(2026, 11, 20)) == b"ef"
    assert server.slept == [cme_ftp.PAUSE_S]
    assert len(server.sessions) == 1 and server.sessions[0].options == {"timeout": 30.0}
    assert server.sessions[0].log == [*OPENING, f"RETR {FILE}", f"RETR {NEXT_FILE}"]
    ftp.close()
    assert server.sessions[0].log[-1] == "quit"


def test_reply_550_is_not_published_and_keeps_the_session() -> None:
    server = Server({FILE: ftplib.error_perm("550 Failed to open file."), NEXT_FILE: [b"ef"]})
    ftp = server.adapter()
    assert ftp.workbook(DAY) is None
    assert ftp.workbook(date(2026, 11, 20)) == b"ef"
    assert len(server.sessions) == 1 and "close" not in server.sessions[0].log
    # The unpublished file was a RETR too: the pause runs before the next one.
    assert server.slept == [cme_ftp.PAUSE_S]


def test_another_ftp_error_names_the_file_and_closes_the_session() -> None:
    server = Server({FILE: ftplib.error_temp("451 Requested action aborted:\r\n local error"), NEXT_FILE: [b"ef"]})
    ftp = server.adapter()
    exc = upstream_error(lambda: ftp.workbook(DAY))
    assert exc.message == f"CME FTP {FILE}: 451 Requested action aborted: local error"
    assert server.sessions[0].log[-1] == "close"
    # The next file opens a new session, and its first RETR has no pause.
    assert ftp.workbook(date(2026, 11, 20)) == b"ef"
    assert len(server.sessions) == 2 and server.sessions[1].log == [*OPENING, f"RETR {NEXT_FILE}"]
    assert server.slept == []


@pytest.mark.parametrize(
    ("failure", "text"),
    [
        (ConnectionResetError(104, "Connection reset by peer"), "ConnectionResetError: [Errno 104] Connection reset by peer"),
        (TimeoutError("timed out"), "TimeoutError: timed out"),
        (EOFError(), "EOFError"),
    ],
)
def test_reset_timeout_and_end_of_stream_name_the_host_and_close_the_session(failure: BaseException, text: str) -> None:
    server = Server({FILE: [b"ab", failure]})
    ftp = server.adapter()
    exc = upstream_error(lambda: ftp.workbook(DAY))
    assert exc.message == f"CME FTP ftp.cmegroup.com: {text}"
    assert server.sessions[0].log[-1] == "close"
    ftp.close()  # no session is left: nothing to do, and it does not raise
    assert server.sessions[0].log.count("close") == 1 and "quit" not in server.sessions[0].log


@pytest.mark.parametrize(
    ("command", "failure", "text"),
    [
        ("connect ftp.cmegroup.com", OSError("network access is blocked"), "OSError: network access is blocked"),
        ("login", ftplib.error_perm("530 Login incorrect."), "error_perm: 530 Login incorrect."),
        ("cwd /daily_volume", ftplib.error_perm("550 Failed to change directory."), "error_perm: 550 Failed to change directory."),
    ],
)
def test_connect_login_and_directory_failures_name_the_host(command: str, failure: BaseException, text: str) -> None:
    server = Server({FILE: [b"ab"]}, fail={command: failure})
    ftp = server.adapter()
    exc = upstream_error(lambda: ftp.workbook(DAY))
    # A 550 reply to CWD is a failure: only RETR can mean "not published".
    assert exc.message == f"CME FTP ftp.cmegroup.com: {text}"
    assert server.sessions[0].log[-1] == "close" and f"RETR {FILE}" not in server.sessions[0].log
    server.fail.clear()
    assert ftp.workbook(DAY) == b"ab" and len(server.sessions) == 2


def test_file_over_the_size_limit_stops_the_transfer() -> None:
    limit = cme_ftp.MAX_FILE_BYTES
    server = Server({FILE: [b"x" * (limit - 1), b"x"], NEXT_FILE: [b"x" * limit, b"x", b"never read"]})
    ftp = server.adapter()
    assert len(ftp.workbook(DAY) or b"") == limit
    exc = upstream_error(lambda: ftp.workbook(date(2026, 11, 20)))
    assert exc.message == f"CME FTP {NEXT_FILE}: larger than 2000000 bytes"
    assert server.sessions[0].log[-1] == "close"


def test_transfer_over_the_time_limit_stops_with_its_message() -> None:
    server = Server({FILE: [b"a", 60.0, b"b"], NEXT_FILE: [b"a", 60.5, b"b"]})
    ftp = server.adapter()
    assert ftp.workbook(DAY) == b"ab"
    exc = upstream_error(lambda: ftp.workbook(date(2026, 11, 20)))
    assert exc.message == f"CME FTP {NEXT_FILE}: transfer took more than 60 s"
    assert server.sessions[0].log[-1] == "close"


def test_close_never_raises() -> None:
    Server().adapter().close()  # no session was opened
    server = Server({FILE: [b"ab"]}, fail={"quit": OSError("connection lost"), "close": OSError("already closed")})
    ftp = server.adapter()
    assert ftp.workbook(DAY) == b"ab"
    ftp.close()
    assert server.sessions[0].log[-2:] == ["quit", "close"]
    ftp.close()
    assert server.sessions[0].log.count("quit") == 1
    # After a transfer error the session is closed already; `close` then has nothing to do.
    server = Server({FILE: ftplib.error_temp("421 Timeout.")}, fail={"close": OSError("already closed")})
    ftp = server.adapter()
    upstream_error(lambda: ftp.workbook(DAY))
    ftp.close()
    assert server.sessions[0].log == [*OPENING, f"RETR {FILE}", "close"]


def test_close_during_a_transfer_sends_no_quit_and_the_abandoned_call_keeps_off_the_new_session() -> None:
    # The job calls `close` after a helper timeout while the abandoned thread is still in RETR.
    server = Server()
    ftp = server.adapter()
    later = date(2026, 11, 20)

    def job_moves_on() -> None:
        ftp.close()
        assert ftp.workbook(later) == b"ef"

    server.files = {FILE: [b"ab", job_moves_on, ConnectionResetError(104, "Connection reset by peer")], NEXT_FILE: [b"ef"]}
    upstream_error(lambda: ftp.workbook(DAY))
    first, second = server.sessions
    assert first.log == [*OPENING, f"RETR {FILE}", "close", "close"]
    assert second.log == [*OPENING, f"RETR {NEXT_FILE}"]
    # The late failure of the abandoned call did not close the new session: the next file uses it.
    assert ftp.workbook(later) == b"ef" and len(server.sessions) == 2


def test_close_while_the_session_opens_sends_no_quit() -> None:
    server = Server({FILE: [b"ab"]})
    ftp = server.adapter()
    server.fail = {"login": ftp.close}
    assert ftp.workbook(DAY) == b"ab"
    assert server.sessions[0].log == ["connect ftp.cmegroup.com", "login", "close", "pasv True", "cwd /daily_volume", f"RETR {FILE}"]
    # The closed session is not kept: the next file opens its own.
    server.fail = {}
    assert ftp.workbook(DAY) == b"ab" and len(server.sessions) == 2


def test_adapter_defaults_use_the_real_ftp_class_and_the_blocked_socket() -> None:
    exc = upstream_error(lambda: cme_ftp.CmeFtp().workbook(DAY))
    assert exc.message == "CME FTP ftp.cmegroup.com: OSError: network access is blocked in vertex_openbb tests"


# --- cell extraction --------------------------------------------------------------------------------


def test_workbook_cells_returns_the_header_as_read_and_only_the_future_rows() -> None:
    got = cme.workbook_cells(workbook())
    assert got == {"sheet": cme.SHEET, "tradeDate": "Trade Date:  11/19/2026", "header": HEADER, "rows": [ES_ROW, NQ_ROW]}
    # Line breaks and the footnote mark are kept; the checks normalize them.
    assert got["header"][11] == "Open\nInterest ②" and got["header"][5] == "CME® \nGlobex® \nVolume"
    assert all(row[4] == "F" and row[2] in ("ES", "NQ") for row in got["rows"])
    assert cme.file_columns(got, DAY) == {"Commodity Indicator": 2, "Product Description": 3, "Future/Option Indicator": 4, "Open Interest": 11}


def test_workbook_cells_reads_past_a_declared_sheet_width_that_is_too_narrow() -> None:
    # The real files declare A1:K<n> for a sheet with 12 columns.
    def narrow(sheet: bytes) -> bytes:
        assert b'<dimension ref="A1:L8"' in sheet
        return sheet.replace(b'<dimension ref="A1:L8"', b'<dimension ref="A1:K8"')

    got = cme.workbook_cells(with_changed_sheet(workbook(), narrow))
    assert got["header"] == HEADER and got["rows"] == [ES_ROW, NQ_ROW]


def test_workbook_cells_keeps_duplicate_rows_and_short_rows_for_the_checks() -> None:
    got = cme.workbook_cells(workbook([ES_ROW, ES_ROW, NQ_ROW[:6], ["Total:"], []]))
    assert got["rows"] == [ES_ROW, ES_ROW, NQ_ROW[:6]]


def test_workbook_cells_without_one_column_of_each_kind_returns_no_rows() -> None:
    renamed = ["Product Code" if text == "Commodity Indicator" else text for text in HEADER]
    got = cme.workbook_cells(workbook(header=renamed))
    assert got["header"] == renamed and got["rows"] == []
    with pytest.raises(ValueError, match='^header "Commodity Indicator" found 0 times in '):
        cme.file_columns(got, DAY)
    twice = [*HEADER, "Future/Option Indicator"]
    assert cme.workbook_cells(workbook(header=twice))["rows"] == []


def test_workbook_cells_of_an_empty_sheet() -> None:
    book = openpyxl.Workbook()
    book.create_sheet(cme.SHEET)
    out = io.BytesIO()
    book.save(out)
    assert cme.workbook_cells(out.getvalue()) == {"sheet": cme.SHEET, "tradeDate": "", "header": [], "rows": []}


def test_workbook_cells_raises_without_the_sheet() -> None:
    with pytest.raises(ValueError, match='^sheet "CME Group Vol and OI by Product" not found$'):
        cme.workbook_cells(workbook(second=False))


def test_workbook_cells_raises_over_the_unzipped_limit() -> None:
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("xl/worksheets/sheet1.xml", b"\0" * cme.MAX_UNZIPPED_BYTES)
        archive.writestr("xl/workbook.xml", b"x")
    assert len(out.getvalue()) < cme_ftp.MAX_FILE_BYTES
    with pytest.raises(ValueError, match="^unzipped size is larger than 20000000 bytes$"):
        cme.workbook_cells(out.getvalue())


def test_workbook_cells_raises_for_bytes_that_are_no_workbook() -> None:
    with pytest.raises(ValueError, match="^not a zip file$"):
        cme.workbook_cells(b"<html>moved</html>")
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w") as archive:
        archive.writestr("readme.txt", b"no workbook parts")
    with pytest.raises(ValueError, match=r"^not a readable workbook \(\w+\)$"):
        cme.workbook_cells(out.getvalue())
    # A sheet whose XML ends early fails while the rows are read.
    cut = with_changed_sheet(workbook(), lambda sheet: sheet[: len(sheet) // 2])
    with pytest.raises(ValueError, match=r"^not a readable workbook \(ParseError\)$"):
        cme.workbook_cells(cut)


class StubFtp:
    """Stands in for `CmeFtp` in the job: answers `workbook` from a mapping and counts `close`."""

    files: dict[date, Any] = {}
    made: list[StubFtp] = []

    def __init__(self) -> None:
        self.closed = 0
        self.asked: list[date] = []
        StubFtp.made.append(self)

    def workbook(self, day: date) -> bytes | None:
        self.asked.append(day)
        answer = StubFtp.files.get(day)
        if isinstance(answer, BaseException):
            raise answer
        return answer

    def close(self) -> None:
        self.closed += 1


@pytest.fixture
def stub_ftp(monkeypatch: pytest.MonkeyPatch) -> type[StubFtp]:
    monkeypatch.setattr(StubFtp, "files", {})
    monkeypatch.setattr(StubFtp, "made", [])
    monkeypatch.setattr(cme, "CmeFtp", StubFtp)
    return StubFtp


def test_read_cells(stub_ftp: type[StubFtp]) -> None:
    stub_ftp.files = {DAY: workbook(), date(2026, 11, 18): workbook(second=False)}
    ftp = cast("cme_ftp.CmeFtp", stub_ftp())
    assert cme.read_cells(ftp, date(2026, 11, 20)) is None
    got = cme.read_cells(ftp, DAY)
    assert got is not None and got["rows"] == [ES_ROW, NQ_ROW]
    exc = upstream_error(lambda: cme.read_cells(ftp, date(2026, 11, 18)))
    assert exc.message == 'CME daily_volume_20261118.xlsx: sheet "CME Group Vol and OI by Product" not found'


# --- checks -----------------------------------------------------------------------------------------


def test_header_name_and_trade_date() -> None:
    assert cme.header_name("Open\nInterest ②") == "Open Interest"
    assert cme.header_name("CME® \nGlobex® \nVolume") == "CME Globex Volume"
    assert cme.header_name("  Total   Volume ① ") == "Total Volume"
    assert cme.trade_date("Trade Date:  11/19/2026") == DAY
    assert cme.trade_date("Trade Date: 1/2/2026 ") == date(2026, 1, 2)
    for text in ("Trade Date:  13/19/2026", "Trade Date:  2026-11-19", "11/19/2026", "", None, 20261119):
        assert cme.trade_date(text) is None


def test_weekdays_are_monday_to_friday_newest_first() -> None:
    assert cme.weekdays(date(2026, 9, 3), date(2026, 9, 9)) == [date(2026, 9, d) for d in (9, 8, 7, 4, 3)]
    assert cme.weekdays(date(2026, 9, 5), date(2026, 9, 6)) == []
    assert cme.weekdays(DAY, DAY) == [DAY]
    assert len(cme.weekdays(date(2025, 11, 20), DAY)) == 261


def test_check_sheet_name() -> None:
    assert cme.file_columns(cells(), DAY)
    for sheet in ("CME Group Volume and OI ", None):
        with pytest.raises(ValueError, match='^sheet "CME Group Vol and OI by Product" not found$'):
            cme.file_columns(cells(sheet=sheet), DAY)


@pytest.mark.parametrize("name", ["Commodity Indicator", "Product Description", "Future/Option Indicator", "Open Interest"])
def test_check_each_header_is_there_exactly_once(name: str) -> None:
    index = cme.file_columns(cells(), DAY)[name]
    assert cme.header_name(HEADER[index]) == name
    missing = [text for position, text in enumerate(HEADER) if position != index]
    with pytest.raises(ValueError) as caught:
        cme.file_columns(cells(header=missing), DAY)
    assert str(caught.value) == f'header "{name}" found 0 times in {missing!r}'
    twice = [*HEADER, f"{name}  ②"]
    with pytest.raises(ValueError) as caught:
        cme.file_columns(cells(header=twice), DAY)
    assert str(caught.value) == f'header "{name}" found 2 times in {twice!r}'


def test_check_header_of_a_file_without_a_header_row() -> None:
    with pytest.raises(ValueError, match=r'^header "Commodity Indicator" found 0 times in \[\]$'):
        cme.file_columns({"sheet": cme.SHEET, "tradeDate": "Trade Date:  11/19/2026"}, DAY)


def test_check_trade_date_equals_the_file_name_date() -> None:
    assert cme.file_columns(cells(tradeDate="Trade Date: 11/19/2026"), DAY)
    with pytest.raises(ValueError, match='^trade date "Trade Date:  11/19/2026" is not 2026-11-18$'):
        cme.file_columns(cells(), date(2026, 11, 18))
    with pytest.raises(ValueError, match='^trade date "Trade Date:  19/11/2026" is not 2026-11-19$'):
        cme.file_columns(cells(tradeDate="Trade Date:  19/11/2026"), DAY)
    with pytest.raises(ValueError, match='^trade date "None" is not 2026-11-19$'):
        cme.file_columns(cells(tradeDate=None), DAY)


def columns() -> dict[str, int]:
    return cme.file_columns(cells(), DAY)


def test_product_row_is_a_macro_point() -> None:
    assert cme.product_row(cells(), columns(), ES) == {
        "date": "2026-11-19",
        "frequency": "daily",
        "name": "E-mini S&P 500 futures open interest, all contract months, preliminary (CME Daily Volume and Open Interest)",
        "seriesId": "CME_ES_OI",
        "source": "cme",
        "unit": "contracts",
        "value": 2400300,
    }
    row = cme.product_row(cells(), columns(), NQ)
    assert (row["seriesId"], row["value"], row["source"], row["unit"], row["frequency"]) == ("CME_NQ_OI", 310300, "cme", "contracts", "daily")
    assert row["name"] == "E-mini Nasdaq-100 futures open interest, all contract months, preliminary (CME Daily Volume and Open Interest)"
    assert isinstance(cme.product_row(cells(), columns(), ES)["value"], int)
    assert set(macro.SERIES) >= {"CME_ES_OI", "CME_NQ_OI"}


def test_check_exactly_one_row_for_the_product() -> None:
    with pytest.raises(ValueError, match="^0 rows for ES/F$"):
        cme.product_row(cells(rows=[NQ_ROW, OTHER_ROWS[1]]), columns(), ES)
    with pytest.raises(ValueError, match="^2 rows for NQ/F$"):
        cme.product_row(cells(rows=[ES_ROW, NQ_ROW, NQ_ROW]), columns(), NQ)
    with pytest.raises(ValueError, match="^0 rows for ES/F$"):
        cme.product_row({"tradeDate": "Trade Date:  11/19/2026"}, columns(), ES)
    # An option row and a row that is no list are not rows of the future.
    assert cme.product_row(cells(rows=[ES_ROW, OTHER_ROWS[1], "ES"]), columns(), ES)["value"] == 2400300


def test_check_product_description_contains_the_words() -> None:
    lower = product_cells("ES", "F", "E-mini S&P 500 Future", 5)
    assert cme.product_row(cells(rows=[lower]), columns(), ES)["value"] == 5
    other = product_cells("ES", "F", "ETHER/BITCOIN SPREAD FUTURE", 5)
    with pytest.raises(ValueError, match='^description "ETHER/BITCOIN SPREAD FUTURE" does not contain "E-MINI S&P 500"$'):
        cme.product_row(cells(rows=[other]), columns(), ES)
    with pytest.raises(ValueError, match='^description "None" does not contain "E-MINI NASDAQ"$'):
        cme.product_row(cells(rows=[["EQUITY INDEX", "CME", "NQ", None, "F"]]), columns(), NQ)


@pytest.mark.parametrize("value", [1, 2127055.0, cme.MAX_OPEN_INTEREST])
def test_check_open_interest_accepts_a_whole_number_in_range(value: Any) -> None:
    row = cme.product_row(cells(rows=[product_cells("ES", "F", "E-MINI S&P 500 FUTURE", value)]), columns(), ES)
    assert row["value"] == int(value) and isinstance(row["value"], int)


@pytest.mark.parametrize(
    ("value", "shown"),
    [
        (0, "0"), (-5, "-5"), (cme.MAX_OPEN_INTEREST + 1, "50000001"), (2127055.5, "2127055.5"), ("2127055", "2127055"),
        (None, "None"), (True, "True"), (float("nan"), "nan"), (float("inf"), "inf"), ("NaN", "NaN"), (10**400, str(10**400)),
    ],
)
def test_check_open_interest_rejects_other_values(value: Any, shown: str) -> None:
    with pytest.raises(ValueError) as caught:
        cme.product_row(cells(rows=[product_cells("ES", "F", "E-MINI S&P 500 FUTURE", value)]), columns(), ES)
    assert str(caught.value) == f"open interest {shown} is not a whole number from 1 to 50000000"


def test_check_open_interest_of_a_row_that_ends_before_the_column() -> None:
    with pytest.raises(ValueError, match="^open interest None is not a whole number from 1 to 50000000$"):
        cme.product_row(cells(rows=[ES_ROW[:11]]), columns(), ES)


# --- job --------------------------------------------------------------------------------------------


def key(day: date) -> str:
    return f"helper:cme-ftp:{cme_ftp.file_name(day)}"


def september(day: int) -> date:
    return date(2026, 9, day)


TODAY = september(10)
WEEK = ["cme-futures-oi", "--since", "2026-09-03", "--until", "2026-09-09"]


class Recorder(ReplayUpstream):
    """A replay that also keeps the order of the calls."""

    def __init__(self, records: list[dict[str, Any]]) -> None:
        super().__init__(records)
        self.keys: list[str] = []

    async def _call(self, key: str, factory: Any) -> Any:
        self.keys.append(key)
        return await super()._call(key, factory)


def test_job_is_registered() -> None:
    assert cli.JOBS["cme-futures-oi"] is cme.futures_oi
    assert cli.JOB_TABLES["cme-futures-oi"] == ("macro_points",)
    assert cli.UNTIL_JOBS["cme-futures-oi"] == cme.DEFAULT_DAYS == 4
    assert "cme-futures-oi" not in cli.SYMBOL_JOBS and not "cme-futures-oi".startswith(cli.CONTACT_JOBS)
    assert "openpyxl" in cli.PROVIDER_MODULES


def test_importing_the_cli_does_not_load_openpyxl() -> None:
    code = "import sys; from vertex_openbb import cli; sys.exit(1 if 'openpyxl' in sys.modules else 0)"
    proc = subprocess.run([sys.executable, "-c", code], cwd=ROOT, capture_output=True, text=True, timeout=120, check=False)
    assert proc.returncode == 0, proc.stderr


def test_fixture_replay_stores_both_series_and_a_holiday_adds_no_warning(stub_ftp: type[StubFtp]) -> None:
    fixture = upstream_fixture("cme-futures-oi")
    assert fixture["argv"] == WEEK and fixture["today"] == TODAY.isoformat()
    # Labor Day 2026-09-07 is inside the range: the recorded result is "not published".
    assert [c["key"] for c in fixture["calls"]] == [key(september(d)) for d in (9, 8, 7, 4, 3)]
    assert fixture["calls"][2]["result"] is None
    assert all(c["result"]["header"] == HEADER for c in fixture["calls"] if c["result"])
    result = replay_fixture("cme-futures-oi")
    assert result.code == 0, result.stderr
    assert result.document["warnings"] == []
    rows = result.table("macro_points")
    # The document sorts the rows by series and date.
    assert [(r["seriesId"], r["date"], r["value"]) for r in rows] == [
        ("CME_ES_OI", "2026-09-03", 2400000), ("CME_ES_OI", "2026-09-04", 2400100),
        ("CME_ES_OI", "2026-09-08", 2400200), ("CME_ES_OI", "2026-09-09", 2400300),
        ("CME_NQ_OI", "2026-09-03", 310000), ("CME_NQ_OI", "2026-09-04", 310100),
        ("CME_NQ_OI", "2026-09-08", 310200), ("CME_NQ_OI", "2026-09-09", 310300),
    ]
    assert {(r["source"], r["unit"], r["frequency"]) for r in rows} == {("cme", "contracts", "daily")}
    assert "macro_points=8; 0 warnings" in result.stderr
    # One adapter per run, closed once at the end (the replay never calls it).
    assert [(ftp.asked, ftp.closed) for ftp in stub_ftp.made] == [([], 1)]


def test_job_requests_the_files_newest_first_and_skips_the_weekend() -> None:
    days = [september(d) for d in (9, 8, 7, 4, 3)]
    up = Recorder([call(key(day), cells(day)) for day in days])
    out, err = io.StringIO(), io.StringIO()
    assert cli.run(WEEK, env={}, up=up, today=TODAY, stdout=out, stderr=err) == 0, err.getvalue()
    assert up.keys == [key(day) for day in days]


def test_job_default_range_is_today_and_the_four_days_before() -> None:
    # Thursday 2026-09-10: the dates 09-06 to 09-10, of which 09-06 is a Sunday.
    days = [september(d) for d in (10, 9, 8, 7)]
    up = Recorder([call(key(day), None if day == TODAY else cells(day)) for day in days])
    out, err = io.StringIO(), io.StringIO()
    assert cli.run(["cme-futures-oi"], env={}, up=up, today=TODAY, stdout=out, stderr=err) == 0, err.getvalue()
    assert up.keys == [key(day) for day in days]
    assert "macro_points=6; 0 warnings" in err.getvalue()


def test_job_three_weekdays_without_a_file_fail_the_run() -> None:
    argv = ["cme-futures-oi", "--since", "2026-09-07", "--until", "2026-09-09"]
    result = run(argv, [call(key(september(d)), None) for d in (9, 8, 7)], today=TODAY)
    assert result.code == 3 and result.stdout == ""
    assert "cme daily volume: no daily volume file from 2026-09-07 to 2026-09-09" in result.stderr
    assert "every upstream source failed" in result.stderr


def test_job_short_range_without_a_file_is_nothing_new() -> None:
    for argv, days in (
        (["cme-futures-oi", "--since", "2026-09-07", "--until", "2026-09-07"], [7]),
        (["cme-futures-oi", "--since", "2026-09-04", "--until", "2026-09-07"], [7, 4]),
        (["cme-futures-oi", "--since", "2026-09-05", "--until", "2026-09-06"], []),  # a weekend: no file is requested
    ):
        result = run(argv, [call(key(september(d)), None) for d in days], today=TODAY)
        assert result.code == 0, result.stderr
        assert result.table("macro_points") == [] and result.document["warnings"] == []


def test_job_one_failing_product_keeps_the_other_and_warns() -> None:
    day = september(9)
    argv = ["cme-futures-oi", "--since", "2026-09-09", "--until", "2026-09-09"]
    result = run(argv, [call(key(day), cells(day, rows=[ES_ROW, ES_ROW, NQ_ROW]))], today=TODAY)
    assert result.code == 0, result.stderr
    assert [(r["seriesId"], r["value"]) for r in result.table("macro_points")] == [("CME_NQ_OI", 310300)]
    assert result.document["warnings"] == ["cme daily_volume_20260909.xlsx ES: 2 rows for ES/F"]
    wrong = product_cells("NQ", "F", "E-MINI NASDAQ 100 FUTURE", 0)
    result = run(argv, [call(key(day), cells(day, rows=[ES_ROW, wrong]))], today=TODAY)
    assert [(r["seriesId"], r["value"]) for r in result.table("macro_points")] == [("CME_ES_OI", 2400300)]
    assert result.document["warnings"] == ["cme daily_volume_20260909.xlsx NQ: open interest 0 is not a whole number from 1 to 50000000"]


def context(calls: list[dict[str, Any]], since: date, until: date) -> Context:
    return Context(job="cme-futures-oi", today=TODAY, up=ReplayUpstream(calls), since=since, until=until)


def test_job_file_level_failure_counts_once(stub_ftp: type[StubFtp]) -> None:
    good, bad = september(9), september(8)
    for failing in (cells(bad, sheet="Sheet2"), cells(bad, header=HEADER[:11]), cells(good)):
        ctx = context([call(key(good), cells(good)), call(key(bad), failing)], bad, good)
        tables = asyncio.run(cme.futures_oi(ctx))
        assert (ctx.sources_ok, ctx.sources_failed, len(ctx.warnings)) == (2, 1, 1)
        assert ctx.warnings[0].startswith("cme daily_volume_20260908.xlsx: ")
        assert [r["date"] for r in tables["macro_points"]] == ["2026-09-09", "2026-09-09"]
        assert tables["macro_points"] is ctx.tables["macro_points"] and not ctx.nothing_new
    # A warning keeps one space where the text has more.
    assert ctx.warnings == ['cme daily_volume_20260908.xlsx: trade date "Trade Date: 09/09/2026" is not 2026-09-08']
    # A check failure is no FTP failure: the session stays open until the end of the run.
    assert stub_ftp.made[-1].closed == 1


def test_job_closes_the_session_after_a_helper_error_and_at_the_end(stub_ftp: type[StubFtp]) -> None:
    calls = [
        call(key(september(9)), cells(september(9))),
        error(key(september(8)), "error", "CME FTP ftp.cmegroup.com: TimeoutError: timed out"),
        error(key(september(7)), "error", "timed out after 90 s"),
    ]
    ctx = context(calls, september(7), september(9))
    asyncio.run(cme.futures_oi(ctx))
    assert ctx.warnings == [
        "cme daily_volume_20260908.xlsx: CME FTP ftp.cmegroup.com: TimeoutError: timed out",
        "cme daily_volume_20260907.xlsx: timed out after 90 s",
    ]
    assert (ctx.sources_ok, ctx.sources_failed) == (2, 2)
    assert [ftp.closed for ftp in stub_ftp.made] == [3]


def test_job_closes_the_session_when_the_run_is_cancelled(stub_ftp: type[StubFtp]) -> None:
    fixture = upstream_fixture("cme-futures-oi")
    # Wide margins for a loaded runner: the first of the 5 calls ends at 0.4 s, the deadline is at
    # 1.0 s, and the last call would end at 2.0 s.
    result = run(fixture["argv"], fixture["calls"], today=TODAY, env={"OPENBB_DEADLINE_S": "1.0"}, delay_s=0.4)
    assert result.code == 0, result.stderr
    # The rows of the newest files are kept when the job deadline stops the run.
    rows = result.table("macro_points")
    dates = {r["date"] for r in rows}
    assert 2 <= len(rows) < 8 and "2026-09-09" in dates and "2026-09-03" not in dates
    assert any("job deadline" in w for w in result.document["warnings"])
    assert [ftp.closed for ftp in stub_ftp.made] == [1]


def test_job_every_file_failing_exits_3_without_the_empty_range_message() -> None:
    argv = ["cme-futures-oi", "--since", "2026-09-07", "--until", "2026-09-09"]
    calls = [error(key(september(d)), "error", "CME FTP ftp.cmegroup.com: OSError: unreachable") for d in (9, 8, 7)]
    result = run(argv, calls, today=TODAY)
    assert result.code == 3 and result.stdout == ""
    assert result.stderr.count("CME FTP ftp.cmegroup.com: OSError: unreachable") == 3
    assert "no daily volume file" not in result.stderr


def test_job_range_limit_and_symbols_are_argument_errors() -> None:
    today = date(2026, 11, 20)
    last = date(2026, 11, 19)
    longest = last - timedelta(days=cme.MAX_RANGE_DAYS - 1)
    too_long = run(["cme-futures-oi", "--since", (longest - timedelta(days=1)).isoformat(), "--until", last.isoformat()], today=today)
    assert too_long.code == 2 and too_long.stdout == ""
    assert "cme-futures-oi reads at most 370 days per run" in too_long.stderr
    # 370 days pass the argument check: the run then reads every weekday (here none is published).
    calls = [call(key(day), None) for day in cme.weekdays(longest, last)]
    in_limit = run(["cme-futures-oi", "--since", longest.isoformat(), "--until", last.isoformat()], calls, today=today)
    assert in_limit.code == 3 and f"no daily volume file from {longest.isoformat()} to 2026-11-19" in in_limit.stderr
    symbols = run(["cme-futures-oi", "--symbols", "ES"], today=today)
    assert symbols.code == 2 and "cme-futures-oi takes no --symbols" in symbols.stderr
    with pytest.raises(ArgumentError, match="cme-futures-oi takes no --symbols"):
        asyncio.run(cme.futures_oi(Context(job="cme-futures-oi", today=today, up=ReplayUpstream([]), symbols=("ES",))))


def test_job_live_path_reads_the_workbook_through_the_helper(stub_ftp: type[StubFtp]) -> None:
    stub_ftp.files = {
        DAY: workbook(),
        date(2026, 11, 18): workbook(second=False),
        date(2026, 11, 17): UpstreamError("error", "CME FTP ftp.cmegroup.com: TimeoutError: timed out"),
    }
    out, err = io.StringIO(), io.StringIO()
    argv = ["cme-futures-oi", "--since", "2026-11-16", "--until", "2026-11-20"]
    code = cli.run(argv, env={}, up=Upstream(), today=date(2026, 11, 20), stdout=out, stderr=err)
    assert code == 0, err.getvalue()
    assert "macro_points=2; 2 warnings" in err.getvalue()
    (ftp,) = stub_ftp.made
    assert ftp.asked == [date(2026, 11, d) for d in (20, 19, 18, 17, 16)]
    # Closed after each of the two helper errors and at the end.
    assert ftp.closed == 3
