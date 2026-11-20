"""Congress PTR jobs: House PDF text parser, Senate table parser, window, outcomes and network helpers."""

from __future__ import annotations

import io
import json
import zipfile
from datetime import date
from typing import Any, Self

import pytest
from conftest import TEST_CONTACT, call, error, output_fixture, run, upstream_fixture

from vertex_openbb import cli
from vertex_openbb.jobs import congress
from vertex_openbb.upstream import ReplayUpstream, UpstreamError
from vertex_openbb.values import utf16_len

ENV = {"VERTEX_RESEARCH_CONTACT_EMAIL": TEST_CONTACT}
UUID = "1a2b3c4d-0000-4000-8000-00000000000a"
HEAD = [
    "                                                                   Filing ID #20030001",
    "   Name:      Hon. Avery Example",
    "   ID    Owner Asset                Transaction Date Notification Amount Cap.",
    "                                    Type             Date               Gains >",
    "                                                                        $200?",
]
END = ["    * For the complete list of asset type abbreviations, please visit https://fd.house.gov/reference/asset-type-codes.aspx."]


def house_text(*body: str) -> str:
    return "\n".join([*HEAD, *body, *END])


def senate_table(*rows: tuple[str, ...]) -> str:
    head = "<tr><th>#</th><th>Transaction Date</th><th>Owner</th><th>Ticker</th><th>Asset Name</th><th>Asset Type</th><th>Type</th><th>Amount</th><th>Comment</th></tr>"
    body = "".join("<tr>" + "".join(f"<td>{c}</td>" for c in row) + "</tr>" for row in rows)
    return f"<table class='x'>{head}{body}</table>"


# --- shared helpers ------------------------------------------------------------------------------


def test_us_date_and_amounts() -> None:
    assert congress.us_date("12/10/2025") == "2025-12-10"
    assert congress.us_date("02/30/2025") is None
    assert congress.us_date("2025-12-10") is None
    assert congress.amount_range("$1,001 - $15,000") == (1001, 15000)
    assert congress.amount_range("Over $50,000,000") == (50000001, None)
    assert congress.amount_range("$1,000") == (1000, 1000)
    assert congress.amount_range("$1,710.99") == (1710, 1710)
    assert congress.amount_range("unknown") == (None, None)
    assert congress.ticker_or_none(" aapl ") == "AAPL"
    assert congress.ticker_or_none("--") is None
    assert congress.ticker_or_none(None) is None


def test_user_agent_uses_the_sec_contact_rule() -> None:
    assert congress.user_agent(ENV) == f"vertex-research congress (personal research; {TEST_CONTACT})"
    with pytest.raises(ValueError):
        congress.user_agent({})


class FakeResponse:
    def __init__(self, chunks: list[bytes], status: int = 200) -> None:
        self.chunks = chunks
        self.status = status
        self.closed = False

    def raise_for_status(self) -> None:
        if self.status >= 400:
            raise RuntimeError(f"{self.status} Server Error")

    def iter_content(self, _size: int) -> list[bytes]:
        return self.chunks

    def close(self) -> None:
        self.closed = True


def test_read_capped() -> None:
    assert congress.read_capped(FakeResponse([b"ab", b"cd"]), 4, "x") == b"abcd"
    big = FakeResponse([b"abc", b"de"])
    with pytest.raises(UpstreamError, match="larger than"):
        congress.read_capped(big, 4, "x")
    assert big.closed
    with pytest.raises(RuntimeError):
        congress.read_capped(FakeResponse([], 503), 4, "x")


# --- House parser --------------------------------------------------------------------------------


def test_house_row_with_wrapped_amount_owner_code_ticker_and_asset_type() -> None:
    rows, reason = congress.parse_house_ptr(house_text(
        "         SP   Example Widgets Inc. - Common Stock S 12/10/2025 12/12/2025 $15,001 -",
        "              (EXWG) [ST]                                     $50,000",
        "              F S: New",
        "              S O: Example Brokerage IRA",
        "              Example Brokerage text after the meta lines stays out",
    ))
    assert reason is None
    assert rows == [{
        "amountHigh": 50000, "amountLabel": "$15,001 - $50,000", "amountLow": 15001,
        "asset": "Example Widgets Inc. - Common Stock (EXWG) [ST]", "assetType": "ST", "holder": "spouse",
        "rowNumber": 1, "ticker": "EXWG", "transactionDate": "2025-12-10", "transactionType": "sale",
    }]


def test_house_rows_without_ticker_partial_sale_exchange_and_over_amount() -> None:
    rows, reason = congress.parse_house_ptr(house_text(
        "         JT   Example County Water Revenue Bonds S (partial) 12/01/2025 12/12/2025 $50,001 - $100,000",
        "              [GS]",
        "              D: Municipal bond",
        "   ID    Owner Asset                Transaction Date Notification Amount Cap.",
        "                                    Type             Date               Gains >",
        "                                                                        $200?",
        "Filing ID #20030001",
        "         DC   Example Holdings Ltd - Class B E 12/02/2025 12/12/2025 Over $50,000,000",
        "              Shares (EXHB.B) [ST]",
        "              Example Rail Corporation P  12/11/2025 12/12/2025 $1,001 - $15,000",
        "              (EXRL) [ST]",
    ))
    assert reason is None
    assert [(r["holder"], r["ticker"], r["assetType"], r["transactionType"], r["amountLow"], r["amountHigh"]) for r in rows] == [
        ("joint", None, "GS", "sale_partial", 50001, 100000),
        ("dependent", "EXHB.B", "ST", "exchange", 50000001, None),
        ("self", "EXRL", "ST", "purchase", 1001, 15000),
    ]
    assert [r["rowNumber"] for r in rows] == [1, 2, 3]


def test_house_amount_on_the_next_line_only() -> None:
    rows, reason = congress.parse_house_ptr(house_text(
        "              Example Trust Units S 12/03/2025 12/12/2025",
        "              [OT]                                            $1,001 - $15,000",
    ))
    assert reason is None and rows[0]["amountLabel"] == "$1,001 - $15,000" and rows[0]["holder"] == "self"


def test_house_exact_amount_with_cents() -> None:
    rows, reason = congress.parse_house_ptr(house_text(
        "         SP   Example Aero Inc. - Common Stock (EXAE) S 09/29/2026 10/01/2026 $710.52",
        "              [ST]",
        "              F S: New",
        "              Example Tech Inc. Common S 10/21/2026 10/21/2026 $344.99",
        "              Stock (EXTC) [ST]",
    ))
    assert reason is None
    assert [(r["amountLabel"], r["amountLow"], r["amountHigh"], r["ticker"]) for r in rows] == [
        ("$710.52", 710, 710, "EXAE"), ("$344.99", 344, 344, "EXTC"),
    ]


def test_house_owner_code_only_in_the_owner_column() -> None:
    rows, _ = congress.parse_house_ptr(house_text(
        "                      SP Example Fund S 12/03/2025 12/12/2025 $1,001 - $15,000",
    ))
    assert rows[0]["holder"] == "self" and rows[0]["asset"] == "SP Example Fund"


def test_house_no_transactions_and_unknown_layouts() -> None:
    assert congress.parse_house_ptr(house_text("   Nothing to report.")) == ([], "no_transactions")
    assert congress.parse_house_ptr("Filing ID #1\nsome other form\n") == ([], "layout_unknown")
    assert congress.parse_house_ptr("$200?\n") == ([], "no_transactions")
    # Amount never completed, or text after the amount: the filing is not guessed.
    unfinished = house_text("         SP   Example Widgets Inc. S 12/10/2025 12/12/2025 $15,001 -", "              F S: New")
    assert congress.parse_house_ptr(unfinished) == ([], "layout_unknown")
    trailing = house_text("         SP   Example Widgets Inc. S 12/10/2025 12/12/2025 $1,001 - $15,000 Yes extra")
    assert congress.parse_house_ptr(trailing) == ([], "layout_unknown")
    bad_date = house_text("         SP   Example Widgets Inc. S 13/40/2025 12/12/2025 $1,001 - $15,000")
    assert congress.parse_house_ptr(bad_date) == ([], "layout_unknown")


def test_house_index_keeps_valid_ptr_rows() -> None:
    header = "Prefix\tLast\tFirst\tSuffix\tFilingType\tStateDst\tYear\tFilingDate\tDocID"
    lines = [
        "Hon.\tExample\tAvery\t\tP\tCA99\t2025\t12/22/2025\t20030001",
        "Hon.\tExample\tAvery\t\tO\tCA99\t2025\t12/22/2025\t20030002",
        "Hon.\tExample\tAvery\t\tP\tCA99\t2025\t12/22/2025\tABC",
        "Hon.\tExample\tAvery\t\tP\tCA99\t2025\t2025-12-22\t20030003",
        "\t\t\t\tP\tCA99\t2025\t12/22/2025\t20030004",
        "\tSample\tBlake\tJr.\tP\t\t2025\t12/23/2025\t8221234",
    ]
    filings = congress.house_index("\n".join([header, *lines]), 2025)
    assert [(f.doc_id, f.member, f.state_district, f.filed_on, f.scanned) for f in filings] == [
        ("20030001", "Hon. Avery Example", "CA99", "2025-12-22", False),
        ("8221234", "Blake Sample Jr.", None, "2025-12-23", True),
    ]
    assert filings[0].url == "https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2025/20030001.pdf"
    assert congress.house_index("", 2025) == []


def test_house_index_text_reads_the_zip_and_caps_it(monkeypatch: pytest.MonkeyPatch) -> None:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("2025FD.txt", "\ufeffPrefix\tLast\n")
    assert congress.house_index_text(buffer.getvalue(), 2025) == "Prefix\tLast\n"
    monkeypatch.setattr(congress, "INDEX_CAP", 3)
    with pytest.raises(UpstreamError, match="larger than"):
        congress.house_index_text(buffer.getvalue(), 2025)


def test_pdf_text_joins_pages_and_drops_nul(monkeypatch: pytest.MonkeyPatch) -> None:
    import pdfplumber

    class Page:
        def __init__(self, text: str | None) -> None:
            self.text = text

        def extract_text(self, layout: bool) -> str | None:
            assert layout
            return self.text

    class Pdf:
        pages = [Page("F\x00\x00 S\x00: New   "), Page(None)] + [Page("x")] * 50

        def __enter__(self) -> Self:
            return self

        def __exit__(self, *_args: object) -> None:
            return None

    monkeypatch.setattr(pdfplumber, "open", lambda _f: Pdf())
    text = congress.pdf_text(b"%PDF")
    assert text.splitlines()[0] == "F S: New"
    assert text.count("x") == 38


def test_house_years() -> None:
    assert congress.house_years("2025-12-20", "2026-01-10") == [2025, 2026]
    assert congress.house_years("2026-10-28", "2026-11-18") == [2026]


# --- Senate parser -------------------------------------------------------------------------------


def test_senate_table_with_child_holder_and_missing_ticker() -> None:
    rows, reason = congress.parse_senate_ptr(senate_table(
        ("1", "11/02/2026", "Child", "--", "Example Municipal Bond", "Municipal Security", "Exchange", "$1,001 - $15,000", "--"),
        ("2", "11/01/2026", "Self", "<a href='https://example.invalid'>EXWG</a>", "Example Widgets &amp; Co", "", "Sale (Partial)", "Over $50,000,000", "--"),
        ("3", "11/01/2026", "Other", "EXRL", "Example Rail", "Stock", "Sale (Full)", "$15,001 - $50,000", "--"),
        ("4", "11/01/2026", "Spouse", "EXRL", "Example Rail", "Stock", "Gift", "$15,001 - $50,000", "--"),
    ))
    assert reason is None
    assert rows[0] == {
        "amountHigh": 15000, "amountLabel": "$1,001 - $15,000", "amountLow": 1001, "asset": "Example Municipal Bond",
        "assetType": "Municipal Security", "holder": "dependent", "rowNumber": 1, "ticker": None,
        "transactionDate": "2026-11-02", "transactionType": "exchange",
    }
    assert (rows[1]["ticker"], rows[1]["asset"], rows[1]["assetType"], rows[1]["transactionType"]) == ("EXWG", "Example Widgets & Co", None, "sale_partial")
    assert (rows[1]["amountLow"], rows[1]["amountHigh"]) == (50000001, None)
    assert (rows[2]["holder"], rows[2]["transactionType"]) == (None, "sale")
    assert rows[3]["transactionType"] == "other"


def test_senate_types() -> None:
    assert [congress.senate_type(t) for t in ("Purchase", "Sale", "Sale (Full)", "Sale (Partial)", "Exchange", "Received")] == [
        "purchase", "sale", "sale", "sale_partial", "exchange", "other",
    ]


def test_senate_no_transactions_and_unknown_layouts() -> None:
    assert congress.parse_senate_ptr(senate_table()) == ([], "no_transactions")
    assert congress.parse_senate_ptr("") == ([], "layout_unknown")
    assert congress.parse_senate_ptr("<table><tr><th>Date</th></tr></table>") == ([], "layout_unknown")
    short = senate_table(("1", "11/02/2026"))
    assert congress.parse_senate_ptr(short) == ([], "layout_unknown")
    bad_amount = senate_table(("1", "11/02/2026", "Self", "EXWG", "Example", "Stock", "Purchase", "Unknown", "--"))
    assert congress.parse_senate_ptr(bad_amount) == ([], "layout_unknown")
    bad_date = senate_table(("1", "2026-11-02", "Self", "EXWG", "Example", "Stock", "Purchase", "$1,001 - $15,000", "--"))
    assert congress.parse_senate_ptr(bad_date) == ([], "layout_unknown")


def test_senate_search_rows() -> None:
    link = f'<a href="/search/view/ptr/{UUID.upper()}/" target="_blank">Periodic Transaction Report (Amendment)</a>'
    row = congress.senate_search_row(["Jordan", "O&#39;Example", "x", link, "11/04/2026"])
    assert row == {
        "amends": True, "docId": UUID, "filedOn": "2026-11-04", "kind": "ptr", "member": "Jordan O'Example",
        "url": f"https://efdsearch.senate.gov/search/view/ptr/{UUID}/",
    }
    paper = f'<a href="/search/view/paper/{UUID}/">Periodic Transaction Report</a>'
    assert congress.senate_search_row(["A", "B", "x", paper, "11/04/2026"])["kind"] == "paper"
    assert congress.senate_search_row(["A", "B", "x", paper]) is None
    assert congress.senate_search_row({"a": 1}) is None
    assert congress.senate_search_row(["A", "B", "x", 1, "11/04/2026"]) is None
    assert congress.senate_search_row(["A", "B", "x", "<a href='/x'>y</a>", "11/04/2026"]) is None
    assert congress.senate_search_row(["A", "B", "x", paper, "bad"]) is None
    assert congress.senate_search_row(["", " ", "x", paper, "11/04/2026"]) is None
    dashes = '<a href="/search/view/ptr/------------------------------------/">x</a>'
    assert congress.senate_search_row(["A", "B", "x", dashes, "11/04/2026"]) is None


def test_senate_helpers() -> None:
    assert congress.senate_date("2026-11-01") == "11/01/2026 00:00:00"
    assert congress.first_table("<p>a</p><TABLE x>b</TABLE><table>c</table>") == "<TABLE x>b</TABLE>"
    assert congress.first_table("<p>none</p>") == ""


# --- jobs ----------------------------------------------------------------------------------------


def test_house_fixture_outcomes() -> None:
    fixture = upstream_fixture("congress-house")
    result = run(fixture["argv"], fixture["calls"], today=date.fromisoformat(fixture["today"]), env=ENV)
    assert result.code == 0, result.stderr
    filings = {f["docId"]: f for f in result.table("congress_filings")}
    assert {k: (f["status"], f["reason"], f["rowCount"]) for k, f in filings.items()} == {
        "20030001": ("parsed", None, 4),
        "20030002": ("unparsed", "no_transactions", 0),
        "20030003": ("unparsed", "layout_unknown", 0),
        "8221234": ("unparsed", "scanned_image", 0),
    }
    # 20030004: download failed -> warning and no row; 20030009 / 20030010: outside the window.
    assert result.document["warnings"] == ["house filing 20030004: HTTPError: 503 Server Error"]
    assert {t["docId"] for t in result.table("congress_trades")} == {"20030001"}
    assert "url" not in result.table("congress_trades")[0]
    keys = [c["key"] for c in fixture["calls"]]
    assert "helper:congress:house-pdf:8221234" not in keys


def test_senate_fixture_outcomes() -> None:
    fixture = upstream_fixture("congress-senate")
    result = run(fixture["argv"], fixture["calls"], today=date.fromisoformat(fixture["today"]), env=ENV)
    assert result.code == 0, result.stderr
    filings = {f["docId"][-1]: (f["status"], f["reason"], f["amends"]) for f in result.table("congress_filings")}
    assert filings == {
        "1": ("parsed", None, False), "2": ("parsed", None, True), "3": ("unparsed", "scanned_image", False),
        "4": ("unparsed", "no_transactions", False), "6": ("unparsed", "layout_unknown", False),
    }
    child = [t for t in result.table("congress_trades") if t["docId"].endswith("2")]
    assert child[0]["holder"] == "dependent" and child[0]["ticker"] is None
    assert len(result.document["warnings"]) == 1 and "000000000005" in result.document["warnings"][0]


def test_house_default_window_reads_only_this_year() -> None:
    calls = [call("helper:congress:house-index:2026", "Prefix\tLast\tFirst\tSuffix\tFilingType\tStateDst\tFilingDate\tDocID\n"
                  "Hon.\tExample\tAvery\t\tP\tCA99\t10/27/2026\t20030001\n"
                  "Hon.\tExample\tAvery\t\tP\tCA99\t10/28/2026\t8000001\n")]
    result = run(["congress-house"], calls, today=date(2026, 11, 18), env=ENV)
    assert result.code == 0, result.stderr
    assert [f["docId"] for f in result.table("congress_filings")] == ["8000001"]


def test_house_index_failures() -> None:
    since = ["congress-house", "--since", "2025-12-20"]
    failed = run(since, [error("helper:congress:house-index:2025"), error("helper:congress:house-index:2026")], today=date(2026, 1, 5), env=ENV)
    assert failed.code == 3 and failed.stdout == ""
    partial = run(since, [error("helper:congress:house-index:2025"), call("helper:congress:house-index:2026", "")], today=date(2026, 1, 5), env=ENV)
    assert partial.code == 0
    assert "house index 2025: boom" in partial.document["warnings"]
    missing = run(["congress-house", "--since", "2026-01-01"], [error("helper:congress:house-index:2026", "not_found")], today=date(2026, 1, 2), env=ENV)
    assert missing.code == 0
    assert "house index 2026: not published yet" in missing.document["warnings"]
    garbled = run(["congress-house"], [call("helper:congress:house-index:2026", 5)], today=date(2026, 11, 18), env=ENV)
    assert garbled.code == 3


def test_senate_search_failure_fails_the_source() -> None:
    result = run(["congress-senate"], [error("helper:congress:senate-search:2026-10-28")], today=date(2026, 11, 18), env=ENV)
    assert result.code == 3
    empty = run(["congress-senate"], [call("helper:congress:senate-search:2026-10-28", None)], today=date(2026, 11, 18), env=ENV)
    assert empty.code == 0 and empty.table("congress_filings") == []


def test_senate_until_limits_the_window() -> None:
    link = f'<a href="/search/view/paper/{UUID}/">Periodic Transaction Report</a>'
    calls = [call("helper:congress:senate-search:2026-11-01", [["A", "Example", "x", link, "11/12/2026"]])]
    result = run(["congress-senate", "--since", "2026-11-01", "--until", "2026-11-10"], calls, today=date(2026, 11, 18), env=ENV)
    assert result.code == 0 and result.table("congress_filings") == []


@pytest.mark.parametrize(
    "argv",
    [
        ["congress-house", "--until", "2026-13-01"],
        ["congress-house", "--until", "2026-11-19"],
        ["congress-house", "--since", "2026-11-10", "--until", "2026-11-01"],
        ["congress-house", "--symbols", "AAPL"],
        # Before the default start (today minus 21 days = 2026-10-28) when --since is absent.
        ["congress-house", "--until", "2026-10-27"],
        ["cboe-vx-curve", "--until", "2026-11-10"],
    ],
)
def test_congress_bad_arguments_exit_2(argv: list[str]) -> None:
    result = run(argv, env=ENV, today=date(2026, 11, 18))
    assert result.code == 2 and result.stdout == ""


def test_until_messages_and_default_start() -> None:
    assert "takes no --until" in run(["cboe-vx-curve", "--until", "2026-11-10"], today=date(2026, 11, 18)).stderr
    early = run(["congress-senate", "--until", "2026-10-27"], env=ENV, today=date(2026, 11, 18))
    assert "the default start 2026-10-28 is after --until 2026-10-27" in early.stderr
    calls = [call("helper:congress:senate-search:2026-10-28", [])]
    assert run(["congress-senate", "--until", "2026-10-28"], calls, env=ENV, today=date(2026, 11, 18)).code == 0


class KeyLog(ReplayUpstream):
    """Replay that keeps the order of the upstream keys."""

    def __init__(self, records: list[dict[str, Any]]) -> None:
        super().__init__(records)
        self.keys: list[str] = []

    async def _call(self, key: str, factory: Any) -> Any:
        self.keys.append(key)
        return await super()._call(key, factory)


@pytest.mark.parametrize("job", ["congress-house", "congress-senate"])
def test_filings_are_read_newest_first(job: str) -> None:
    fixture = upstream_fixture(job)
    up = KeyLog(fixture["calls"])
    code = cli.run(fixture["argv"], env=ENV, up=up, today=date.fromisoformat(fixture["today"]), stdout=io.StringIO(), stderr=io.StringIO())
    assert code == 0
    filed = {f["docId"]: f["filedOn"] for f in output_fixture(job)["tables"][1]["rows"]}
    read = [k.rsplit(":", 1)[1] for k in up.keys if ("-pdf:" in k or "-ptr:" in k)]
    dates = [filed[d] for d in read if d in filed]
    assert len(dates) >= 3 and dates == sorted(dates, reverse=True)


def test_rows_that_fail_the_row_rules_make_the_filing_layout_unknown() -> None:
    huge = "$99,999,999,999,999,999 - $99,999,999,999,999,999"
    rows, reason = congress.parse_house_ptr(house_text(
        "         SP   Example Widgets Inc. (EXWG) [ST] S 12/10/2025 12/12/2025 $1,001 - $15,000",
        f"              Example Rail Corp (EXRL) [ST] P 12/11/2025 12/12/2025 {huge}",
    ))
    assert reason is None and len(rows) == 2
    assert congress.trade_rows("house", "20030001", "Hon. Avery Example", "2025-12-12", rows, None) == ([], "layout_unknown")
    good = rows[:1]
    out, reason = congress.trade_rows("house", "20030001", "Hon. Avery Example", "2025-12-12", good, None)
    assert reason is None and out[0]["chamber"] == "house" and out[0]["member"] == "Hon. Avery Example"
    # In a job run: the Senate filing becomes an unparsed ledger row with no trades.
    link = f'<a href="/search/view/ptr/{UUID}/">Periodic Transaction Report</a>'
    calls = [
        call("helper:congress:senate-search:2026-11-01", [["A", "Example", "x", link, "11/04/2026"]]),
        call(f"helper:congress:senate-ptr:{UUID}", senate_table(
            ("1", "11/02/2026", "Self", "EXWG", "Example", "Stock", "Purchase", "$1,001 - $15,000", "--"),
            ("2", "11/02/2026", "Self", "EXRL", "Example", "Stock", "Purchase", huge, "--"),
        )),
    ]
    result = run(["congress-senate", "--since", "2026-11-01"], calls, env=ENV, today=date(2026, 11, 18))
    assert result.code == 0 and result.table("congress_trades") == []
    assert [(f["status"], f["reason"], f["rowCount"]) for f in result.table("congress_filings")] == [("unparsed", "layout_unknown", 0)]
    assert result.document["warnings"] == []


def test_cuts_count_utf16_units() -> None:
    wide = "\U0001f600" * 300  # 600 UTF-16 units
    rows, reason = congress.parse_senate_ptr(senate_table(
        ("1", "11/02/2026", "Self", "EXWG", wide, wide, "Purchase", "$1,001 - $15,000", "--"),
    ))
    assert reason is None
    assert utf16_len(rows[0]["asset"]) == 500 and utf16_len(rows[0]["assetType"]) == 40
    link = f'<a href="/search/view/ptr/{UUID}/">Periodic Transaction Report</a>'
    member = congress.senate_search_row([wide, "Example", "x", link, "11/04/2026"])["member"]
    assert utf16_len(member) == 200
    out, reason = congress.trade_rows("senate", UUID, member, "2026-11-04", rows, None)
    assert reason is None and len(out) == 1
    header = "Prefix\tLast\tFirst\tSuffix\tFilingType\tStateDst\tYear\tFilingDate\tDocID"
    filing = congress.house_index(f"{header}\nHon.\t{wide}\tA\t\tP\t{wide}\t2025\t12/22/2025\t20030001", 2025)[0]
    assert utf16_len(filing.member) <= 200 and utf16_len(filing.state_district or "") == 10


def test_congress_jobs_need_contact_address() -> None:
    for job in ("congress-house", "congress-senate"):
        result = run([job], env={})
        assert result.code == 2 and "VERTEX_RESEARCH_CONTACT_EMAIL" in result.stderr


def test_job_tables_order() -> None:
    assert cli.JOB_TABLES["congress-house"] == cli.JOB_TABLES["congress-senate"] == ("congress_trades", "congress_filings")


# --- network helpers (fake sessions; the sockets stay blocked) ------------------------------------


class FakeSession:
    def __init__(self, answers: list[bytes]) -> None:
        self.answers = answers
        self.sent: list[tuple[str, str, dict[str, Any]]] = []
        self.headers: dict[str, str] = {}
        self.cookies: dict[str, str] = {}

    def request(self, method: str, url: str, **kwargs: Any) -> FakeResponse:
        self.sent.append((method, url, kwargs))
        if method == "POST" and url.endswith("/search/home/"):
            self.cookies["csrftoken"] = "cookie-token"
        return FakeResponse([self.answers.pop(0)])

    def get(self, url: str, **kwargs: Any) -> FakeResponse:
        return self.request("GET", url, **kwargs)


@pytest.fixture
def no_sleep(monkeypatch: pytest.MonkeyPatch) -> list[float]:
    slept: list[float] = []
    monkeypatch.setattr(congress.time, "sleep", slept.append)
    return slept


def test_senate_session_search_and_report(monkeypatch: pytest.MonkeyPatch, no_sleep: list[float]) -> None:
    monkeypatch.setattr(congress, "SEARCH_PAGE", 2)
    home = b'<form><input type="hidden" name="csrfmiddlewaretoken" value="form-token"></form>'
    pages = [json.dumps({"data": [["a"], ["b"]]}).encode(), json.dumps({"data": [["c"]]}).encode()]
    efd = congress.SenateSession("agent")
    fake = FakeSession([home, b"ok", *pages, b"<p>x</p><table>t</table>", b"prohibition_agreement"])
    efd.session = fake  # type: ignore[assignment]
    assert efd.search("2026-11-01") == [["a"], ["b"], ["c"]]
    agreement = fake.sent[1][2]
    assert agreement["data"] == {"prohibition_agreement": "1", "csrfmiddlewaretoken": "form-token"}
    search = fake.sent[2][2]
    assert search["data"]["report_types"] == "[11]" and search["data"]["submitted_start_date"] == "11/01/2026 00:00:00"
    assert search["headers"]["X-CSRFToken"] == "cookie-token" and fake.sent[3][2]["data"]["start"] == "2"
    assert efd.ptr_table(UUID) == "<table>t</table>"
    assert fake.sent[-1][1].endswith(f"/search/view/ptr/{UUID}/")
    with pytest.raises(UpstreamError, match="expired"):
        efd.ptr_table(UUID)
    assert no_sleep == [congress.SENATE_PAUSE_S] * 6


def test_senate_session_errors(monkeypatch: pytest.MonkeyPatch, no_sleep: list[float]) -> None:
    efd = congress.SenateSession("agent")
    efd.session = FakeSession([b"<p>no token</p>"])  # type: ignore[assignment]
    with pytest.raises(UpstreamError, match="CSRF"):
        efd.search("2026-11-01")
    home = b'name="csrfmiddlewaretoken" value="t"'
    efd.session = FakeSession([home, b"ok", b'{"data": 1}'])  # type: ignore[assignment]
    with pytest.raises(UpstreamError, match="no data list"):
        efd.search("2026-11-01")
    monkeypatch.setattr(congress, "MAX_SEARCH_PAGES", 1)
    monkeypatch.setattr(congress, "SEARCH_PAGE", 1)
    efd.session = FakeSession([home, b"ok", b'{"data": [["a"]]}'])  # type: ignore[assignment]
    with pytest.raises(UpstreamError, match="more than 1 rows"):
        efd.search("2026-11-01")


def test_house_fetchers(monkeypatch: pytest.MonkeyPatch, no_sleep: list[float]) -> None:
    import requests

    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("2026FD.txt", "Prefix\n")
    fake = FakeSession([buffer.getvalue(), b"%PDF"])
    monkeypatch.setattr(requests, "Session", lambda: fake)
    monkeypatch.setattr(congress, "pdf_text", lambda data: data.decode())
    index, pdf = congress._house_fetchers("agent")
    assert fake.headers["User-Agent"] == "agent"
    assert index(2026)() == "Prefix\n"
    filing = congress.HouseFiling("20030001", "Hon. Avery Example", None, "2026-11-02", 2026)
    assert pdf(filing)() == "%PDF"
    assert [s[1] for s in fake.sent] == [
        "https://disclosures-clerk.house.gov/public_disc/financial-pdfs/2026FD.zip",
        "https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2026/20030001.pdf",
    ]
    assert no_sleep == [congress.HOUSE_PAUSE_S] * 2
