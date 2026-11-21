"""sec-form4: daily index, full-submission split, Form 4 XML parser, ledger state and outcomes."""

from __future__ import annotations

import io
import json
from datetime import date
from typing import Any

import pytest
from conftest import TEST_CONTACT, call, error, run, upstream_fixture

from vertex_openbb import cli
from vertex_openbb.context import ArgumentError
from vertex_openbb.jobs import form4
from vertex_openbb.upstream import UpstreamError

ENV = {"VERTEX_RESEARCH_CONTACT_EMAIL": TEST_CONTACT}
A = "0000900001-26-000001"
B = "0000900002-26-000002"
INDEX_HEAD = [
    "Description:           Daily Index of EDGAR Dissemination Feed by Form Type",
    "",
    "Form Type   Company Name                                                  CIK         Date Filed  File Name",
    "-" * 140,
]


def index_line(form: str, name: str, cik: str, accession: str, folder: str) -> str:
    return f"{form:<12}{name:<62}{cik:<12}20261105    edgar/data/{folder}/{accession}.txt"


def fixture_calls() -> dict[str, Any]:
    return {c["key"]: c for c in upstream_fixture("sec-form4")["calls"]}


def xml_of(key: str) -> str:
    return fixture_calls()[key]["result"]["xml"]


CODES = frozenset("ACDEFGHIJKLMOPSUVWXZ")


# --- index ---------------------------------------------------------------------------------------


def test_parse_index_keeps_distinct_form4_accessions() -> None:
    text = "\n".join(
        [
            *INDEX_HEAD,
            index_line("10-K", "Example Widgets Inc", "800001", "0000800001-26-000009", "800001"),
            index_line("4", "Example Widgets Inc", "800001", A, "900001"),
            index_line("4", "Doe Jane", "700001", A, "900001"),
            index_line("4/A", "Example Widgets Inc", "800001", B, "900002"),
            index_line("40-F", "Other Co", "800002", "0000800002-26-000001", "800002"),
            "not an entry line",
        ]
    )
    assert form4.parse_index(text) == [
        {"accession": A, "cik": "900001", "formType": "4"},
        {"accession": B, "cik": "900002", "formType": "4/A"},
    ]


def test_parse_index_layout_changes_give_none() -> None:
    assert form4.parse_index("no header at all") is None
    assert form4.parse_index("\n".join([*INDEX_HEAD, "garbage"])) is None
    # A valid index day with entries but no Form 4 is an empty list, not a layout change.
    only_10k = "\n".join([*INDEX_HEAD, index_line("10-K", "X", "1", "0000000001-26-000001", "1")])
    assert form4.parse_index(only_10k) == []


def test_index_url_uses_the_quarter() -> None:
    assert form4.index_url(date(2026, 11, 5)) == "https://www.sec.gov/Archives/edgar/daily-index/2026/QTR4/form.20261105.idx"
    assert form4.index_url(date(2026, 1, 2)).endswith("/2026/QTR1/form.20260102.idx")


def test_window_skips_weekends() -> None:
    ctx = cli.build_context(cli.parser().parse_args(["sec-form4", "--since", "2026-11-06", "--until", "2026-11-09"]), {}, None, date(2026, 11, 9))  # type: ignore[arg-type]
    assert form4.window_days(ctx) == [date(2026, 11, 6), date(2026, 11, 9)]
    default = cli.build_context(cli.parser().parse_args(["sec-form4"]), {}, None, date(2026, 11, 13))  # type: ignore[arg-type]
    assert form4.window_days(default)[0] == date(2026, 10, 5) and form4.window_days(default)[-1] == date(2026, 11, 13)


# --- submission and XML --------------------------------------------------------------------------


def test_submission_reads_acceptance_and_the_form4_xml() -> None:
    text = (
        "<SEC-HEADER>\n<ACCEPTANCE-DATETIME>20261105163012\n</SEC-HEADER>\n"
        "<DOCUMENT>\n<TYPE>EX-24\n<TEXT>\n<XML>\n<other/>\n</XML>\n</TEXT>\n</DOCUMENT>\n"
        "<DOCUMENT>\n<TYPE>4\n<TEXT>\n<XML>\n<?xml version='1.0'?><ownershipDocument/>\n</XML>\n</TEXT>\n</DOCUMENT>\n"
    )
    assert form4.submission(text) == {"accepted": "20261105163012", "xml": "<?xml version='1.0'?><ownershipDocument/>"}
    assert form4.submission("<DOCUMENT>\n<TYPE>4\n<TEXT>plain</TEXT></DOCUMENT>") == {"accepted": None, "xml": None}


def test_accepted_at_is_new_york_time() -> None:
    assert form4.accepted_at("20261105163012") == "2026-11-05T16:30:12-05:00"
    assert form4.accepted_at("20260701090000") == "2026-07-01T09:00:00-04:00"
    assert form4.accepted_at("2026") is None
    assert form4.accepted_at(None) is None


def test_parse_filing_reads_owners_rows_and_flags() -> None:
    document = form4.parse_xml(xml_of(f"helper:sec-form4:filing:{A}"))
    filing, owners, rows = form4.parse_filing(document, A, CODES)
    assert filing == {
        "issuerCik": "800001", "issuerName": "Example Widgets Inc", "issuerSymbol": "EXW",
        "periodOfReport": "2026-11-03", "plan10b51": True, "rowCount": 2,
    }
    assert [o["ownerCik"] for o in owners] == ["700001", "700002"]
    assert owners[0]["isDirector"] and owners[1]["isTenPercentOwner"] and owners[0]["officerTitle"] is None
    # Holding rows are not transactions; a footnote-only price is null; commas are removed.
    assert [(r["rowNumber"], r["shares"], r["price"], r["directIndirect"]) for r in rows] == [(1, 1000.0, 12.5, "D"), (2, 200.0, None, "I")]


def test_parse_filing_derivative_rows_come_after_non_derivative() -> None:
    document = form4.parse_xml(xml_of(f"helper:sec-form4:filing:{B}"))
    filing, owners, rows = form4.parse_filing(document, B, CODES)
    assert [(r["derivative"], r["transactionCode"]) for r in rows] == [(False, "S"), (True, "M")]
    assert owners[0]["officerTitle"] == "Chief Executive Officer" and filing["plan10b51"] is False


@pytest.mark.parametrize(
    ("xml", "why"),
    [
        ("<not-closed", "XML does not parse"),
        ("<other/>", "no ownershipDocument"),
        ("<ownershipDocument><issuer/></ownershipDocument>", "no issuer CIK"),
        ("<ownershipDocument><issuer><issuerCik>1</issuerCik></issuer></ownershipDocument>", "no reporting owner"),
        (
            "<ownershipDocument><issuer><issuerCik>1</issuerCik></issuer><reportingOwner><reportingOwnerId>"
            "<rptOwnerCik>x</rptOwnerCik></reportingOwnerId></reportingOwner></ownershipDocument>",
            "without CIK",
        ),
    ],
)
def test_parse_filing_layout_errors(xml: str, why: str) -> None:
    with pytest.raises(form4.LayoutError, match=why):
        form4.parse_filing(form4.parse_xml(xml), A, CODES)


def test_unknown_transaction_code_is_a_layout_error() -> None:
    xml = xml_of(f"helper:sec-form4:filing:{A}").replace("<transactionCode>P<", "<transactionCode>Q<", 1)
    with pytest.raises(form4.LayoutError, match="unknown transaction code"):
        form4.parse_filing(form4.parse_xml(xml), A, CODES)


def test_transaction_codes_include_k_and_v() -> None:
    codes = form4.transaction_codes()
    assert {"P", "S", "K", "V"} <= codes and codes == CODES


def test_value_helpers() -> None:
    assert form4._value({"value": {"#text": " 5 "}}) == "5"
    assert form4._value({"footnoteId": {"@id": "F1"}}) is None
    assert form4._flag("true") is True and form4._flag({"value": "0"}) is False and form4._flag(None) is None
    assert form4._day({"value": "2026-02-30"}) is None and form4._day("2026-11-03-05:00") == "2026-11-03"
    assert form4._number("$1,234.5") == 1234.5 and form4._number("n/a") is None


def test_build_outcomes() -> None:
    entry = form4.Entry(A, "900001", "4")
    day = date(2026, 11, 5)
    assert form4.build(entry, day, {"tooLarge": True}, CODES)[0]["reason"] == "too_large"
    assert form4.build(entry, day, {"notFound": True}, CODES)[0]["reason"] == "not_found"
    assert form4.build(entry, day, {"accepted": "20261105163012", "xml": None}, CODES)[0]["reason"] == "no_xml"
    ledger, owners, rows = form4.build(entry, day, {"accepted": None, "xml": xml_of(f"helper:sec-form4:filing:{A}")}, CODES)
    assert (ledger["reason"], owners, rows) == ("layout_unknown", [], [])
    with pytest.raises(form4.LayoutError):
        form4.build(entry, day, ["not", "a", "dict"], CODES)
    assert form4.filing_url(entry) == "https://www.sec.gov/Archives/edgar/data/900001/000090000126000001/0000900001-26-000001-index.htm"


# --- state ---------------------------------------------------------------------------------------


def test_read_state() -> None:
    assert form4.read_state(None).done == set()
    state = form4.read_state(io.StringIO(json.dumps({"completeDays": ["2026-11-04"], "doneAccessions": [A], "layoutUnknown": [{"accessionNumber": B, "parserVersion": "form4.v1"}, {"accessionNumber": "0000000001-26-000001", "parserVersion": "form4.v0"}]})))
    assert state.complete_days == frozenset({"2026-11-04"}) and state.done == {A, B}
    for bad in (
        "nope", "[]", '{"completeDays": [1], "doneAccessions": [], "layoutUnknown": []}',
        '{"completeDays": [], "doneAccessions": "x", "layoutUnknown": []}', '{"completeDays": [], "doneAccessions": [], "layoutUnknown": [1]}',
    ):
        with pytest.raises(ArgumentError):
            form4.read_state(io.StringIO(bad))


def run_with_state(state: dict[str, Any], calls: list[dict[str, Any]], argv: list[str] | None = None) -> Any:
    out, err = io.StringIO(), io.StringIO()
    from vertex_openbb.upstream import ReplayUpstream

    code = cli.run(
        argv or ["sec-form4", "--since", "2026-11-04", "--until", "2026-11-05", "--state-stdin"],
        env=ENV, up=ReplayUpstream(calls), today=date(2026, 11, 8), stdout=out, stderr=err,
        stdin=io.StringIO(json.dumps(state)),
    )
    return code, out.getvalue(), err.getvalue()


def test_state_skips_complete_days_and_done_accessions() -> None:
    calls = [
        call("helper:sec-form4:index:2026-11-05", [{"accession": A, "cik": "900001", "formType": "4"}, {"accession": B, "cik": "900002", "formType": "4/A"}]),
        fixture_calls()[f"helper:sec-form4:filing:{B}"],
    ]
    code, out, err = run_with_state({"completeDays": ["2026-11-04"], "doneAccessions": [A], "layoutUnknown": []}, calls)
    assert code == 0, err
    doc = json.loads(out)
    tables = {t["table"]: t["rows"] for t in doc["tables"]}
    assert tables["sec_form4_index_days"] == [{"complete": True, "entriesDone": 2, "entriesListed": 2, "indexDay": "2026-11-05"}]
    assert [f["accessionNumber"] for f in tables["sec_form4_filings"]] == [B]


def test_state_stdin_is_only_for_sec_form4() -> None:
    assert run(["sec-filings", "--state-stdin"], env=ENV).code == 2
    assert run(["--warm", "--state-stdin"]).code == 2
    code, _, err = run_with_state({"completeDays": []}, [])
    assert code == 2 and "--state-stdin" in err


def test_index_failures_and_layout() -> None:
    calls = [
        error("helper:sec-form4:index:2026-11-04", "error", "HTTP 500"),
        call("helper:sec-form4:index:2026-11-05", {"layoutUnknown": True}),
    ]
    code, out, err = run_with_state({"completeDays": [], "doneAccessions": [], "layoutUnknown": []}, calls)
    assert code == 0, err
    warnings = json.loads(out)["warnings"]
    assert any("form.20261104.idx: HTTP 500" in w for w in warnings)
    assert any("layout_unknown" in w for w in warnings)


def test_forbidden_stops_the_job() -> None:
    calls = [
        call("helper:sec-form4:index:2026-11-04", [{"accession": A, "cik": "900001", "formType": "4"}]),
        error(f"helper:sec-form4:filing:{A}", "forbidden", "HTTP 403"),
    ]
    code, out, err = run_with_state({"completeDays": [], "doneAccessions": [], "layoutUnknown": []}, calls)
    assert code == 0, err
    doc = json.loads(out)
    assert any("filings: HTTP 403" in w for w in doc["warnings"])
    assert {t["table"]: t["rows"] for t in doc["tables"]}["sec_form4_index_days"][0]["complete"] is False


def test_rows_failing_the_schema_make_the_filing_unparsed() -> None:
    xml = xml_of(f"helper:sec-form4:filing:{A}").replace("<value>Common Stock</value>", "<value>" + "x" * 300 + "</value>", 1)
    xml = xml.replace("Doe Jane", " ", 1)
    calls = [
        call("helper:sec-form4:index:2026-11-04", [{"accession": A, "cik": "900001", "formType": "4"}]),
        call(f"helper:sec-form4:filing:{A}", {"accepted": "20261105163012", "xml": xml}),
        call("helper:sec-form4:index:2026-11-05", None),
    ]
    code, out, err = run_with_state({"completeDays": [], "doneAccessions": [], "layoutUnknown": []}, calls)
    assert code == 0, err
    tables = {t["table"]: t["rows"] for t in json.loads(out)["tables"]}
    assert tables["sec_form4_filings"][0]["reason"] == "layout_unknown" and tables["sec_form4_owners"] == []


# --- network helpers -----------------------------------------------------------------------------


class FakeResponse:
    def __init__(self, status: int, body: bytes = b"") -> None:
        self.status_code = status
        self.body = body

    def close(self) -> None:
        pass

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")

    def iter_content(self, _size: int) -> list[bytes]:
        return [self.body]


def fake_session(monkeypatch: pytest.MonkeyPatch, responses: dict[str, FakeResponse]) -> None:
    import requests

    class Session:
        def get(self, url: str, **_kwargs: Any) -> FakeResponse:
            return responses[url]

    monkeypatch.setattr(requests, "Session", Session)


def test_fetchers(monkeypatch: pytest.MonkeyPatch) -> None:
    day = date(2026, 11, 5)
    entry = form4.Entry(A, "900001", "4")
    filing_url = f"https://www.sec.gov/Archives/edgar/data/900001/{A}.txt"
    index_text = "\n".join([*INDEX_HEAD, index_line("4", "X", "1", A, "900001")]).encode()
    fake_session(monkeypatch, {form4.index_url(day): FakeResponse(200, index_text), filing_url: FakeResponse(200, b"<ACCEPTANCE-DATETIME>20261105163012")})
    index, filing = form4._fetchers()
    assert index(day)() == [{"accession": A, "cik": "900001", "formType": "4"}]
    assert filing(entry)() == {"accepted": "20261105163012", "xml": None}

    fake_session(monkeypatch, {form4.index_url(day): FakeResponse(200, b"nothing"), filing_url: FakeResponse(200, b"x" * 10)})
    monkeypatch.setattr(form4, "FILING_CAP", 5)
    index, filing = form4._fetchers()
    assert index(day)() == {"layoutUnknown": True}
    assert filing(entry)() == {"tooLarge": True}

    fake_session(monkeypatch, {form4.index_url(day): FakeResponse(404), filing_url: FakeResponse(404)})
    index, filing = form4._fetchers()
    assert index(day)() is None
    assert filing(entry)() == {"notFound": True}

    fake_session(monkeypatch, {form4.index_url(day): FakeResponse(404), filing_url: FakeResponse(403)})
    index, filing = form4._fetchers()
    with pytest.raises(UpstreamError, match="403"):
        filing(entry)()

    fake_session(monkeypatch, {form4.index_url(day): FakeResponse(403), filing_url: FakeResponse(302)})
    index, filing = form4._fetchers()
    with pytest.raises(UpstreamError, match="403"):
        index(day)()
    with pytest.raises(UpstreamError, match="redirect"):
        filing(entry)()


def test_idle_run_has_no_warning() -> None:
    state = {"completeDays": ["2026-11-04", "2026-11-05"], "doneAccessions": [], "layoutUnknown": []}
    code, out, err = run_with_state(state, [])
    assert code == 0, err
    doc = json.loads(out)
    assert doc["warnings"] == [] and all(t["rows"] == [] for t in doc["tables"])


def test_index_403_stops_and_bad_shape_is_layout_unknown() -> None:
    calls = [error("helper:sec-form4:index:2026-11-04", "forbidden", "HTTP 403")]
    code, out, err = run_with_state({"completeDays": [], "doneAccessions": [], "layoutUnknown": []}, calls)
    assert code == 3, err
    xml = "<ownershipDocument><issuer><issuerCik>1</issuerCik></issuer><reportingOwner>plain</reportingOwner></ownershipDocument>"
    calls = [
        call("helper:sec-form4:index:2026-11-04", [{"accession": A, "cik": "900001", "formType": "4"}]),
        call(f"helper:sec-form4:filing:{A}", {"accepted": "20261105163012", "xml": xml}),
        call("helper:sec-form4:index:2026-11-05", None),
    ]
    code, out, err = run_with_state({"completeDays": [], "doneAccessions": [], "layoutUnknown": []}, calls)
    assert code == 0, err
    filings = {t["table"]: t["rows"] for t in json.loads(out)["tables"]}["sec_form4_filings"]
    assert filings[0]["reason"] == "layout_unknown"


S3_MISSING = b'<?xml version="1.0" encoding="UTF-8"?>\n<Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>'


def test_missing_object_403_is_not_a_block(monkeypatch: pytest.MonkeyPatch) -> None:
    day = date(2026, 10, 12)
    entry = form4.Entry(A, "900001", "4")
    filing_url = f"https://www.sec.gov/Archives/edgar/data/900001/{A}.txt"
    fake_session(monkeypatch, {form4.index_url(day): FakeResponse(403, S3_MISSING), filing_url: FakeResponse(403, S3_MISSING)})
    index, filing = form4._fetchers()
    assert index(day)() is None
    assert filing(entry)() == {"notFound": True}
    fake_session(monkeypatch, {form4.index_url(day): FakeResponse(403, b"<html>Request Rate Threshold Exceeded</html>"), filing_url: FakeResponse(403, b"")})
    index, filing = form4._fetchers()
    with pytest.raises(UpstreamError, match="403"):
        index(day)()
    with pytest.raises(UpstreamError, match="403"):
        filing(entry)()
