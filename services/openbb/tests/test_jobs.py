"""Every job replayed from recorded real upstream payloads; arguments, exit codes, NaN removal."""

from __future__ import annotations

import json
import subprocess
import sys
from datetime import date

import pytest
from conftest import FIXTURES, JOBS, ROOT, TEST_CONTACT, blocked, call, error, output_fixture, replay_fixture, run, upstream_fixture

from vertex_openbb import cli, rows


@pytest.mark.parametrize("job", JOBS)
def test_fixture_replay_matches_shared_fixture(job: str) -> None:
    result = replay_fixture(job)
    assert result.code == 0, result.stderr
    expected = output_fixture(job)
    got = result.document
    assert got["openbbVersion"] == expected["openbbVersion"] == cli.openbb_version()
    assert got == expected


@pytest.mark.parametrize("job", JOBS)
def test_shared_fixture_is_a_valid_batch_document(job: str) -> None:
    doc = output_fixture(job)
    assert set(doc) == {"schemaVersion", "job", "openbbVersion", "tables", "warnings"}
    assert doc["schemaVersion"] == "openbb-batch.v1" and doc["job"] == job
    assert [t["table"] for t in doc["tables"]] == list(cli.JOB_TABLES[job])
    assert sum(len(t["rows"]) for t in doc["tables"]) > 0
    assert len(doc["warnings"]) <= 500 and all(len(w) <= 2000 for w in doc["warnings"])
    for table in doc["tables"]:
        assert set(table) == {"table", "rows"}
        for row in table["rows"]:
            assert rows.row_problem(table["table"], row) is None, (table["table"], row)


def test_fixtures_hold_no_contact_address_and_no_nonfinite_numbers() -> None:
    for path in FIXTURES.rglob("*.json"):
        text = path.read_text(encoding="utf-8")
        assert "@" not in text.replace(TEST_CONTACT, "") or "upstream" in str(path)
        if path.parent == FIXTURES:
            json.loads(text, parse_constant=lambda c: (_ for _ in ()).throw(AssertionError(c)))


def test_every_job_has_fixtures() -> None:
    assert sorted(p.stem for p in (FIXTURES / "upstream").glob("*.json")) == JOBS
    corpora = {"invalid-rows", "valid-edge-rows"}
    assert sorted(p.stem for p in FIXTURES.glob("*.json") if p.stem not in corpora) == JOBS


def test_valid_edge_rows_are_accepted() -> None:
    corpus = json.loads((FIXTURES / "valid-edge-rows.json").read_text(encoding="utf-8"))
    assert len(corpus) >= 10
    for case in corpus:
        assert set(case) == {"table", "row", "why"}
        assert rows.row_problem(case["table"], case["row"]) is None, case["why"]


def test_invalid_row_corpus_is_rejected() -> None:
    corpus = json.loads((FIXTURES / "invalid-rows.json").read_text(encoding="utf-8"))
    assert len(corpus) >= 30 and {c["table"] for c in corpus} == set(rows.TABLES)
    for case in corpus:
        assert set(case) == {"table", "row", "why"}
        assert rows.row_problem(case["table"], case["row"]) is not None, case["why"]


# --- job specifics -----------------------------------------------------------------------------


def test_option_iv_rows_are_consistent() -> None:
    result = replay_fixture("cboe-option-iv")
    daily = result.table("option_iv_daily")
    term = result.table("option_iv_term")
    assert {r["underlying"] for r in daily} == {"SPY", "GLD"}
    for row in daily:
        assert 0 < row["atmIv30d"] < 2
        mine = [t for t in term if t["underlying"] == row["underlying"]]
        assert row["callOi"] == sum(t["callOi"] for t in mine)
        assert row["putVolume"] == sum(t["putVolume"] for t in mine)
    assert any("non-standard" in w or "OCC" in w for w in result.document["warnings"])


def test_sec_ftd_uses_files_listed_on_the_sec_page() -> None:
    fixture = upstream_fixture("sec-ftd")
    keys = [c["key"] for c in fixture["calls"]]
    assert keys[0].startswith("http:https://www.sec.gov/data-research/")
    assert "/files/data/other/fails-deliver-data/" in fixture["calls"][0]["result"]
    rows_ = replay_fixture("sec-ftd").table("sec_ftd")
    assert max(r["settlementDate"] for r in rows_) >= "2026-10-01"


def test_sec_ftd_falls_back_to_older_file_on_404() -> None:
    from vertex_openbb.jobs.sec import FTD_PAGE

    page = 'href="/files/data/other/fails-deliver-data/cnsfails202610a.zip" href="/files/data/fails-deliver-data/cnsfails202609b.zip"'
    calls = [
        call(f"http:{FTD_PAGE}", page),
        error("helper:sec:ftd:202610a", "not_found", "HTTP 404"),
        call("helper:sec:ftd:202609b", [
            {"date": "2026-09-30", "symbol": "SPY", "cusip": "78462F103", "quantity": 5, "price": 1.5},
            {"date": "2026-09-29", "symbol": "ZZZQ", "cusip": "98765X109", "quantity": 7, "price": 2.0},
            {"date": "2026-09-30", "symbol": "ZZZQ", "cusip": "98765X109", "quantity": 1, "price": 2.0},
            {"date": "2026-09-30", "symbol": "bad sym", "cusip": "98765X109", "quantity": 1, "price": 2.0},
        ]),
    ]
    result = run(["sec-ftd", "--symbols", "SPY", "--since", "2026-09-20"], calls, env={"VERTEX_RESEARCH_CONTACT_EMAIL": TEST_CONTACT})
    assert result.code == 0 and any("404" in w for w in result.document["warnings"])
    assert result.table("sec_ftd") == [{"cusip": "78462F103", "price": 1.5, "quantity": 5, "settlementDate": "2026-09-30", "symbol": "SPY"}]
    # The CUSIP map takes every symbol of the file, with its newest settlement date.
    assert result.table("cusip_symbols") == [
        {"cusip": "78462F103", "lastSeen": "2026-09-30", "symbol": "SPY"},
        {"cusip": "98765X109", "lastSeen": "2026-09-30", "symbol": "ZZZQ"},
    ]


def test_treasury_and_regime_freshness_sources() -> None:
    tga_keys = [c["key"] for c in upstream_fixture("treasury-tga")["calls"]]
    assert any("treasurydirect.gov/TA_WS/securities/auctioned" in k for k in tga_keys)
    events = replay_fixture("fed-events").table("event_calendar")
    today = upstream_fixture("fed-events")["today"]
    assert any(e["kind"] == "treasury_auction" and e["date"] >= today for e in events)
    regime = replay_fixture("fed-regime").table("macro_points")
    assert max(r["date"] for r in regime if r["seriesId"] == "NFCI") >= "2026-10-01"


def test_sec_13f_keeps_full_books_with_a_ledger() -> None:
    fixture = upstream_fixture("sec-13f")
    result = replay_fixture("sec-13f")
    held = result.table("sec_13f_holdings")
    ledger = result.table("sec_13f_filings")
    # One ledger row per parsed filing; its row count is the stored book size.
    assert len(ledger) == 4
    for entry in ledger:
        book = [r for r in held if r["accessionNumber"] == entry["accessionNumber"]]
        assert len(book) == entry["rows"] > 0
        assert all(r["filerCik"] == entry["filerCik"] and r["filedOn"] == entry["filedOn"] for r in book)
    # Full book: every distinct (CUSIP, option type) of the information table is kept.
    citadel = next(c for c in fixture["calls"] if c["key"].endswith("0001104659-26-097200.txt"))["result"]
    distinct = {(str(i["cusip"]).upper(), str(i.get("option_type") or "").lower()) for i in citadel}
    assert len([r for r in held if r["accessionNumber"] == "0001104659-26-097200"]) == len(distinct)


def test_sec_13f_skips_stored_accessions_and_stops_at_the_row_budget(monkeypatch: pytest.MonkeyPatch) -> None:
    fixture = upstream_fixture("sec-13f")
    stored = "0001193125-26-352200,0001104659-26-097200"
    skipped = run([*fixture["argv"], "--skip-accessions", stored], fixture["calls"], today=date.fromisoformat(fixture["today"]), env=fixture["env"])
    assert skipped.code == 0
    assert {r["accessionNumber"] for r in skipped.table("sec_13f_filings")} == {"0001193125-26-226661", "0001104659-26-062477"}
    # Every filing stored: nothing downloaded, both filers still count as fetched.
    every = f"{stored},0001193125-26-226661,0001104659-26-062477"
    calls = [c for c in fixture["calls"] if c["key"].startswith("fetcher:")]
    done = run([*fixture["argv"], "--skip-accessions", every], calls, today=date.fromisoformat(fixture["today"]), env=fixture["env"])
    assert done.code == 0 and done.table("sec_13f_holdings") == [] and done.table("sec_13f_filings") == []
    # Caught up is the normal state: no "every table is empty" warning.
    assert not any("every table is empty" in w for w in done.document["warnings"])
    from vertex_openbb.jobs import sec as sec_job

    monkeypatch.setattr(sec_job, "ROW_BUDGET", 1)
    budget = replay_fixture("sec-13f")
    assert len(budget.table("sec_13f_filings")) == 1
    assert any("row budget of 1 rows reached; 3 filings left" in w for w in budget.document["warnings"])


def test_sec_13f_without_rows_or_accession_writes_no_ledger_row() -> None:
    listing = [
        {"report_type": "13F-HR", "report_date": "2026-09-30", "filing_date": "2026-11-14", "complete_submission_url": "https://www.sec.gov/Archives/edgar/data/1067983/0001193125-26-000001.txt"},
        {"report_type": "13F-HR", "report_date": "2026-06-30", "filing_date": "2026-08-14", "complete_submission_url": "https://www.sec.gov/x/no-accession"},
    ]
    holding = {"period_ending": "2026-06-30", "issuer": "APPLE INC", "cusip": "037833100", "security_type": "SH", "principal_amount": 5, "value": 10.0}
    calls = [
        call('fetcher:sec:CompanyFilings:{"cik":"1067983","form_type":"13F-HR","use_cache":false}', listing),
        call("helper:sec:13f:https://www.sec.gov/Archives/edgar/data/1067983/0001193125-26-000001.txt", []),
        call("helper:sec:13f:https://www.sec.gov/x/no-accession", [holding]),
    ]
    result = run(["sec-13f", "--filers", "1067983"], calls, today=date(2026, 11, 20), env={"VERTEX_RESEARCH_CONTACT_EMAIL": TEST_CONTACT})
    assert result.code == 0 and result.table("sec_13f_filings") == []
    assert len(result.table("sec_13f_holdings")) == 1
    warnings = result.document["warnings"]
    assert any("2026-09-30: 0 rows from the information table" in w for w in warnings)
    assert any("2026-06-30: no accession or filing date" in w for w in warnings)


@pytest.mark.parametrize(
    ("argv", "message"),
    [
        (["sec-13f", "--skip-accessions", "12-3"], "--skip-accessions takes accession numbers"),
        (["sec-ftd", "--skip-accessions", "0001193125-26-352200"], "--skip-accessions is only for sec-13f"),
    ],
)
def test_skip_accessions_argument_rules(argv: list[str], message: str) -> None:
    result = run(argv, env={"VERTEX_RESEARCH_CONTACT_EMAIL": TEST_CONTACT})
    assert result.code == 2 and message in result.stderr


def test_regsho_keeps_every_symbol_and_counts_unreadable_ones() -> None:
    text = "Date|Symbol|ShortVolume|ShortExemptVolume|TotalVolume|Market\n20261106|ABRpD|10|0|20|N\n20261106|AGM/A|1|0|2|N\n20261106|BAD SYM|1|0|2|N\n20261106|ZZZQ|3.5|0|9|Q\n2\n"
    result = run(["finra-short-volume", "--since", "2026-11-06"], [call("http:https://cdn.finra.org/equity/regsho/daily/CNMSshvol20261106.txt", text)], today=date(2026, 11, 7))
    assert [r["symbol"] for r in result.table("short_volume_daily")] == ["ABRpD", "AGM/A", "ZZZQ"]
    assert result.document["warnings"] == ["finra regsho: skipped 1 rows with symbols outside the FINRA symbol rule (BAD SYM)"]
    filtered = run(["finra-short-volume", "--since", "2026-11-06", "--symbols", "ZZZQ"], [call("http:https://cdn.finra.org/equity/regsho/daily/CNMSshvol20261106.txt", text)], today=date(2026, 11, 7))
    assert [r["symbol"] for r in filtered.table("short_volume_daily")] == ["ZZZQ"] and filtered.document["warnings"] == []


def test_fed_events_has_future_fomc_meeting() -> None:
    fixture = upstream_fixture("fed-events")
    events = replay_fixture("fed-events").table("event_calendar")
    assert any(e["kind"] == "fomc_meeting" and e["date"] >= fixture["today"] for e in events)


# --- arguments and exit codes ------------------------------------------------------------------


@pytest.mark.parametrize(
    "argv",
    [
        ["nope"],
        [],
        ["cboe-vx-curve", "--since", "2026-13-01"],
        ["cboe-vx-curve", "--since", "2026-12-01"],
        ["fed-rates", "--symbols", "SPY"],
        ["finra-otc", "--symbols", "bad symbol!"],
        ["sec-ftd", "--filers", "1067983"],
        ["cboe-option-iv", "--since", "2026-11-01"],
        ["cboe-vol-indices", "--symbols", "SPY"],
        ["--warm", "fed-rates"],
    ],
)
def test_bad_arguments_exit_2(argv: list[str]) -> None:
    result = run(argv)
    assert result.code == 2 and result.stdout == ""


def test_sec_jobs_need_contact_address() -> None:
    for env in ({}, {"VERTEX_RESEARCH_CONTACT_EMAIL": "not an address"}):
        result = run(["sec-filings"], env=env)
        assert result.code == 2 and result.stdout == ""
        assert "not an address" not in result.stderr


def test_sec_13f_filers_must_be_numeric() -> None:
    result = run(["sec-13f", "--filers", "abc"], env={"VERTEX_RESEARCH_CONTACT_EMAIL": TEST_CONTACT})
    assert result.code == 2


def test_bad_stock_universe_env_exits_2() -> None:
    assert run(["finra-otc"], env={"OPENBB_STOCK_UNIVERSE": "AAPL,???"}).code == 2


def test_all_sources_failed_exits_3() -> None:
    fixture = upstream_fixture("fred-keyless")
    calls = [error(c["key"]) for c in fixture["calls"]]
    result = run(fixture["argv"], calls, today=date.fromisoformat(fixture["today"]))
    assert result.code == 3 and result.stdout == ""


def test_partial_failure_is_ok_with_warning() -> None:
    fixture = upstream_fixture("fred-keyless")
    calls = [error(fixture["calls"][0]["key"], message="upstream down")] + fixture["calls"][1:]
    result = run(fixture["argv"], calls, today=date.fromisoformat(fixture["today"]))
    assert result.code == 0
    assert any("upstream down" in w for w in result.document["warnings"])


def test_nan_and_infinity_are_removed() -> None:
    params = {"symbol": "VIX", "start_date": "2026-10-29", "end_date": "2026-11-08", "interval": "1d"}
    from vertex_openbb.upstream import canonical

    key = f"fetcher:cboe:IndexHistorical:{canonical(params)}"
    data = [
        {"date": "2026-11-05", "open": "NaN", "high": "Infinity", "low": 17.0, "close": 18.0},
        {"date": "2026-11-06", "open": 1.0, "high": 2.0, "low": 0.5, "close": "NaN"},
    ]
    result = run(["cboe-vol-indices", "--symbols", "VIX"], [call(key, data)])
    assert result.code == 0
    series = result.table("daily_series")
    assert series == [{"adjClose": None, "close": 18.0, "date": "2026-11-05", "high": None, "low": 17.0, "open": None, "seriesId": "VIX"}]
    assert any("dropped 1 rows" in w for w in result.document["warnings"])


def test_unrecorded_call_is_an_internal_error_not_network() -> None:
    result = run(["oecd-cli"], [])
    assert result.code == 1 and "unrecorded upstream call" in result.stderr


def test_warm_reports_version() -> None:
    result = run(["--warm"])
    assert result.code == 0 and result.stdout == f"warm: ok {cli.openbb_version()}\n"


def test_module_entry_point_exit_code_and_clean_stdout() -> None:
    proc = subprocess.run(
        [sys.executable, "-m", "vertex_openbb", "fed-rates", "--since", "yesterday"],
        cwd=ROOT, capture_output=True, text=True, timeout=120, check=False,
    )
    assert proc.returncode == 2 and proc.stdout == "" and "--since" in proc.stderr


def test_job_deadline_prints_partial_document() -> None:
    fixture = upstream_fixture("fred-keyless")
    env = {"OPENBB_DEADLINE_S": "0.25"}
    result = run(fixture["argv"], fixture["calls"], today=date.fromisoformat(fixture["today"]), env=env, delay_s=0.1)
    assert result.code == 0
    doc = result.document
    assert any("deadline" in w for w in doc["warnings"])
    full = output_fixture("fred-keyless")["tables"][0]["rows"]
    assert 0 < len(doc["tables"][0]["rows"]) < len(full)


def test_job_deadline_with_nothing_fetched_exits_3() -> None:
    fixture = upstream_fixture("fred-keyless")
    env = {"OPENBB_DEADLINE_S": "0.05"}
    result = run(fixture["argv"], fixture["calls"], today=date.fromisoformat(fixture["today"]), env=env, delay_s=0.5)
    assert result.code == 3 and result.stdout == ""


@pytest.mark.parametrize("value", ["0", "-1", "abc", "100000"])
def test_bad_deadline_exits_2(value: str) -> None:
    assert run(["fed-rates"], env={"OPENBB_DEADLINE_S": value}).code == 2


def test_bad_payload_of_one_source_keeps_the_others() -> None:
    fixture = upstream_fixture("fred-keyless")
    calls = [dict(c) for c in fixture["calls"]]
    calls[0] = {"key": calls[0]["key"], "result": "garbage without columns\n"}
    result = run(fixture["argv"], calls, today=date.fromisoformat(fixture["today"]))
    assert result.code == 0
    assert any("could not read the upstream payload" in w for w in result.document["warnings"])
    ids = {r["seriesId"] for r in result.table("macro_points")}
    assert "HY_OAS" not in ids and len(ids) == 8


def test_format_change_warns_when_rows_vanish() -> None:
    fixture = upstream_fixture("cftc-cot")
    calls = [dict(c) for c in fixture["calls"]]
    calls[0] = {"key": calls[0]["key"], "result": [{"date": "2026-11-03", "renamed_long": 1}]}
    result = run(fixture["argv"], calls, today=date.fromisoformat(fixture["today"]))
    assert result.code == 0
    assert any("none gave a row (format change?)" in w for w in result.document["warnings"])
    assert result.table("cot_positions")


def test_every_table_empty_warns() -> None:
    from vertex_openbb.upstream import canonical

    params = {"symbol": "VIX", "start_date": "2026-10-29", "end_date": "2026-11-08", "interval": "1d"}
    key = f"fetcher:cboe:IndexHistorical:{canonical(params)}"
    result = run(["cboe-vol-indices", "--symbols", "VIX"], [error(key, "empty", "EmptyDataError: none")])
    assert result.code == 0 and result.table("daily_series") == []
    assert any("every table is empty" in w for w in result.document["warnings"])


def test_regsho_403_rules() -> None:
    from datetime import datetime
    from zoneinfo import ZoneInfo

    fixture = upstream_fixture("finra-short-volume")
    today = date.fromisoformat(fixture["today"])
    calls = [dict(c) for c in fixture["calls"]]
    ny = ZoneInfo("America/New_York")

    def refuse(index: int) -> list[dict]:
        out = [dict(c) for c in calls]
        out[index] = error(out[index]["key"], "forbidden", "HTTP 403 from https://cdn.finra.org/x")
        return out

    # A 403 on an ordinary weekday is a failure, even when later files exist.
    ordinary = next(i for i, c in enumerate(calls) if c["key"].endswith("CNMSshvol20261103.txt"))
    blocked = run(fixture["argv"], refuse(ordinary), today=today)
    assert blocked.code == 0 and any("HTTP 403" in w and "not a listed NYSE closure" in w for w in blocked.document["warnings"])
    # Newest weekday before 20:00 New York time on that day: not published yet, no warning.
    argv = [*fixture["argv"], "--since", "2026-10-29"]
    at = lambda hour: datetime(2026, 11, 6, hour, 0, tzinfo=ny)  # noqa: E731
    early = run(argv, refuse(-1), today=date(2026, 11, 6), now=at(18))
    assert early.code == 0 and not any("403" in w for w in early.document["warnings"])
    late = run(argv, refuse(-1), today=date(2026, 11, 6), now=at(21))
    assert late.code == 0 and any("HTTP 403" in w for w in late.document["warnings"])
    # Every day refused: every source failed.
    assert run(fixture["argv"], [error(c["key"], "forbidden", "HTTP 403") for c in calls], today=today).code == 3


def _regsho_calls(days: list[str]) -> list[dict]:
    text = upstream_fixture("finra-short-volume")["calls"][-1]["result"]
    url = "http:https://cdn.finra.org/equity/regsho/daily/CNMSshvol{}.txt"
    return [call(url.format(d.replace("-", "")), text.replace("20261106", d.replace("-", ""))) for d in days]


def test_regsho_skips_listed_nyse_closures_without_requesting_them() -> None:
    # 2026-11-26 (Thanksgiving) is not requested: an unrecorded call would exit 1.
    result = run(["finra-short-volume", "--since", "2026-11-25"], _regsho_calls(["2026-11-25", "2026-11-27"]),
                 today=date(2026, 11, 27))
    assert result.code == 0 and result.document["warnings"] == []
    assert {r["date"] for r in result.table("short_volume_daily")} == {"2026-11-25", "2026-11-27"}


def test_regsho_warns_once_beyond_the_closure_list() -> None:
    result = run(["finra-short-volume", "--since", "2028-12-29"], _regsho_calls(["2028-12-29", "2029-01-01", "2029-01-02"]),
                 today=date(2029, 1, 2))
    assert result.code == 0
    assert [w for w in result.document["warnings"] if "NYSE closure list" in w] == [
        "finra regsho: no NYSE closure list for 2029; holidays there count as failures"
    ]


def test_nyse_closure_list() -> None:
    from vertex_openbb.jobs.nyse_closures import CLOSURES

    def year(y: int) -> list[str]:
        return sorted(d.isoformat()[5:] for d in CLOSURES if d.year == y)

    assert year(2026) == ["01-01", "01-19", "02-16", "04-03", "05-25", "06-19", "07-03", "09-07", "11-26", "12-25"]
    assert year(2027) == ["01-01", "01-18", "02-15", "03-26", "05-31", "06-18", "07-05", "09-06", "11-25", "12-24"]
    assert "01-09" in year(2025) and len(year(2025)) == 11
    assert year(2024) == ["01-01", "01-15", "02-19", "03-29", "05-27", "06-19", "07-04", "09-02", "11-28", "12-25"]
    assert all(d.weekday() < 5 for d in CLOSURES)


def test_lone_surrogate_never_breaks_the_document() -> None:
    from vertex_openbb.upstream import canonical

    params = {"symbol": "AAPL", "start_date": "2026-10-09", "end_date": "2026-11-08", "use_cache": False}
    filing = {"filing_date": "2026-11-06", "report_type": "8-K", "accession_number": "0001140361-26-042505",
              "report_url": "https://www.sec.gov/Archives/edgar/data/320193/000114036126042505/a.htm",
              "primary_doc_description": "bad \ud800 text" + "x" * 3000}
    result = run(["sec-filings", "--symbols", "AAPL"], [call(f"fetcher:sec:Filings:{canonical(params)}", [filing])],
                 env={"VERTEX_RESEARCH_CONTACT_EMAIL": TEST_CONTACT})
    assert result.code == 0 and result.stdout.isascii()
    row = result.table("sec_filings")[0]
    assert len(row["description"].encode("utf-16-le", "surrogatepass")) // 2 <= 2000


def test_regsho_backfill_into_2024_skips_its_closures() -> None:
    # 2024-12-25 (Christmas) is not requested and 2024 is covered: no warning.
    result = run(["finra-short-volume", "--since", "2024-12-24"], _regsho_calls(["2024-12-24", "2024-12-26"]),
                 today=date(2024, 12, 26))
    assert result.code == 0 and result.document["warnings"] == []


def test_non_ascii_contact_never_printed() -> None:
    from vertex_openbb.upstream import canonical

    contact = "jos\u00e9@example.org"
    params = {"symbol": "AAPL", "start_date": "2026-10-09", "end_date": "2026-11-08", "use_cache": False}
    filing = {"filing_date": "2026-11-06", "report_type": "8-K", "accession_number": "0001140361-26-042505",
              "report_url": "https://www.sec.gov/Archives/edgar/data/320193/000114036126042505/a.htm",
              "primary_doc_description": f"contact {contact}"}
    result = run(["sec-filings", "--symbols", "AAPL"], [call(f"fetcher:sec:Filings:{canonical(params)}", [filing])],
                 env={"VERTEX_RESEARCH_CONTACT_EMAIL": contact})
    assert result.code == 1 and result.stdout == "" and "refusing" in result.stderr and contact not in result.stderr


CORE7_SYMBOLS = ("SPY", "QQQ", "DIA", "IWM", "GLD", "SLV", "USO")
CORE7_CHAINS = [f"helper:cboe:options_chain:{symbol}" for symbol in CORE7_SYMBOLS]
YAHOO_CHAINS = [f"helper:yahoo:options_chain:{symbol}" for symbol in CORE7_SYMBOLS]


def blocked_with_yahoo_errors() -> list[dict]:
    """Every Cboe chain blocked and every Yahoo fallback failing (kind error, no host)."""
    calls = []
    for cboe_key, yahoo_key in zip(CORE7_CHAINS, YAHOO_CHAINS):
        calls += [blocked(cboe_key), error(yahoo_key, message="YFRateLimitError: Too Many Requests")]
    return calls


def test_every_source_blocked_upstream_is_exit_0_with_the_host() -> None:
    result = run(["cboe-option-iv"], blocked_with_yahoo_errors())
    assert result.code == 0
    document = result.document
    assert document["blocked"] == {"host": "cdn-api.cboe.com", "httpStatus": 403}
    assert [table["rows"] for table in document["tables"]] == [[], []]
    assert any("cboe chain SPY: ContentTypeError: 403" in w for w in document["warnings"])
    assert any("cboe chain SPY: yahoo chain: YFRateLimitError" in w for w in document["warnings"])
    assert "blocked upstream: HTTP 403 from cdn-api.cboe.com" in result.stderr


def test_blocked_sources_with_another_failure_still_exit_3() -> None:
    calls = blocked_with_yahoo_errors()
    # The last Cboe call fails with a plain error (not blocked): the run is not all-blocked.
    calls[-2] = error(CORE7_CHAINS[-1], message="timed out after 90 s")
    result = run(["cboe-option-iv"], calls)
    assert result.code == 3 and result.stdout == ""


def test_a_blocked_error_without_a_host_is_a_plain_failure() -> None:
    calls = []
    for cboe_key, yahoo_key in zip(CORE7_CHAINS, YAHOO_CHAINS):
        calls += [{"key": cboe_key, "error": {"kind": "blocked", "message": "HTTP 403", "status": 403}},
                  error(yahoo_key, message="boom")]
    assert run(["cboe-option-iv"], calls).code == 3


def test_a_working_document_has_no_blocked_key() -> None:
    assert "blocked" not in replay_fixture("cboe-vx-curve").document


CFE_HEADER = "Product,Symbol,Expiration Date,Price\r\n"
CFE_FILE = CFE_HEADER + "VX,VX/X6,2026-11-18,23.6945\r\nVX,VX45/X6,2026-11-10,23.9\r\nVX,VX/Z6,2026-12-16,22.1837\r\nVXM,VXM/X6,2026-11-18,23.6945\r\n"


def cfe(day: str) -> str:
    return f"http:https://www.cboe.com/us/futures/market_statistics/settlement/csv?dt={day}"


def vx_curve_key(day: str) -> str:
    return f'fetcher:cboe:FuturesCurve:{{"date":"{day}","symbol":"VX_EOD"}}'


def test_vx_curve_uses_the_cfe_settlement_file_when_the_cboe_curve_is_blocked() -> None:
    # 2026-11-08 is a Sunday: the files of Sunday and Saturday have only the header line.
    calls = [blocked(vx_curve_key("2026-11-08")), call(cfe("2026-11-08"), CFE_HEADER), call(cfe("2026-11-07"), None),
             call(cfe("2026-11-06"), CFE_FILE)]
    result = run(["cboe-vx-curve"], calls)
    assert result.code == 0 and "blocked" not in result.document
    assert result.table("vx_curve") == [
        {"asOf": "2026-11-06", "contractMonth": "2026-11", "price": 23.6945},
        {"asOf": "2026-11-06", "contractMonth": "2026-12", "price": 22.1837},
    ]
    # The Markets page looks for this exact text (OPENBB_CFE_FALLBACK_NOTE in the API contract).
    assert any("ContentTypeError: 403" in w and "used the CFE settlement file of 2026-11-06" in w for w in result.document["warnings"])


def test_vx_curve_stays_blocked_when_the_cfe_file_gives_no_rows() -> None:
    days = ["2026-11-08", "2026-11-07", "2026-11-06", "2026-11-05", "2026-11-04"]
    no_rows = run(["cboe-vx-curve"], [blocked(vx_curve_key(days[0]))] + [call(cfe(day), CFE_HEADER) for day in days])
    assert no_rows.code == 0 and no_rows.document["blocked"] == {"host": "cdn-api.cboe.com", "httpStatus": 403}
    assert any("no CFE settlement file with VX rows" in w for w in no_rows.document["warnings"])
    refused = run(["cboe-vx-curve"], [blocked(vx_curve_key(days[0])), error(cfe(days[0]), "forbidden", "HTTP 403 from https://www.cboe.com/x")])
    assert refused.code == 0 and refused.document["blocked"]["httpStatus"] == 403
    assert any("CFE settlement file 2026-11-08: HTTP 403" in w for w in refused.document["warnings"])


def test_vx_curve_backfill_reads_the_cfe_file_of_each_session() -> None:
    calls = [error(vx_curve_key("2026-11-05"), message="boom"), call(cfe("2026-11-05"), CFE_FILE.replace("23.6945", "24.5")),
             error(vx_curve_key("2026-11-06"), message="boom"), call(cfe("2026-11-06"), CFE_FILE)]
    result = run(["cboe-vx-curve", "--since", "2026-11-05"], calls, today=date(2026, 11, 6))
    assert result.code == 0
    assert [(row["asOf"], row["price"]) for row in result.table("vx_curve") if row["contractMonth"] == "2026-11"] == [
        ("2026-11-05", 24.5), ("2026-11-06", 23.6945)]


def test_vx_curve_with_a_plain_cboe_failure_and_no_cfe_rows_exits_3() -> None:
    calls = [error(vx_curve_key("2026-11-08"), message="boom"), error(cfe("2026-11-08"), message="connection reset")]
    assert run(["cboe-vx-curve"], calls).code == 3


def test_vx_curve_stops_at_a_cfe_file_it_cannot_read() -> None:
    bad = CFE_HEADER + "VX,VX/X6,soon,23.7\r\n"
    result = run(["cboe-vx-curve"], [blocked(vx_curve_key("2026-11-08")), call(cfe("2026-11-08"), bad)])
    assert result.code == 0 and result.document["blocked"]["host"] == "cdn-api.cboe.com"
    assert any("CFE settlement file 2026-11-08: ValueError: no expiration date for VX/X6" in w for w in result.document["warnings"])


def test_vx_curve_backfill_sessions_that_share_a_cfe_day_give_one_row_per_key() -> None:
    # Thursday has no settlement file content: its nearest session is Wednesday, which the backfill also reads.
    calls = [blocked(vx_curve_key("2026-11-04")), call(cfe("2026-11-04"), CFE_FILE),
             blocked(vx_curve_key("2026-11-05")), call(cfe("2026-11-05"), CFE_HEADER)]
    result = run(["cboe-vx-curve", "--since", "2026-11-04"], calls, today=date(2026, 11, 5))
    assert result.code == 0
    assert [(row["asOf"], row["contractMonth"]) for row in result.table("vx_curve")] == [("2026-11-04", "2026-11"), ("2026-11-04", "2026-12")]


def test_deadline_with_only_blocked_sources_exits_3() -> None:
    # The fallback gate skips every Yahoo call (less than the reserve left to the 0.05 s
    # deadline), so only the delayed blocked Cboe calls run and the deadline cuts them.
    result = run(["cboe-option-iv"], [blocked(key) for key in CORE7_CHAINS], env={"OPENBB_DEADLINE_S": "0.05"}, delay_s=0.02)
    assert result.code == 3 and result.stdout == "" and "deadline reached before any source was fetched" in result.stderr


# --- cboe-option-iv: the Yahoo second source ----------------------------------------------------

YAHOO_NOTE = "used the Yahoo option chain"  # YAHOO_FALLBACK_NOTE / OPENBB_YAHOO_FALLBACK_NOTE


def yahoo_payload(spot: float = 100.0, ts: int = 1795208400) -> dict:
    """A small synthetic Yahoo payload of the recorded shape (2026-11-20 16:00 ET quote)."""
    return {
        "quote": {"regularMarketPrice": spot, "regularMarketTime": ts, "trailingAnnualDividendYield": 0.01},
        "expirations": ["2026-12-18", "2027-01-15"],
        "chains": {
            "2026-12-18": {
                "calls": [{"contractSymbol": "SPY261218C00100000", "strike": 100.0, "impliedVolatility": 0.2, "openInterest": 10, "volume": 5}],
                "puts": [{"contractSymbol": "SPY261218P00100000", "strike": 100.0, "impliedVolatility": 0.22, "openInterest": 8, "volume": 3}],
            },
            "2027-01-15": {
                "calls": [{"contractSymbol": "SPY270115C00100000", "strike": 100.0, "impliedVolatility": 0.21, "openInterest": 20, "volume": 7}],
                "puts": [{"contractSymbol": "SPY270115P00100000", "strike": 100.0, "impliedVolatility": 0.23, "openInterest": 15, "volume": 4}],
            },
        },
    }


def test_option_iv_uses_yahoo_when_cboe_is_blocked() -> None:
    result = replay_fixture("cboe-option-iv")
    assert result.code == 0, result.stderr
    daily = result.table("option_iv_daily")
    assert {r["underlying"] for r in daily} == {"SPY", "GLD"}
    assert all(r["asOf"] == "2026-11-20" for r in daily)  # Friday's quote, Saturday run
    assert "blocked" not in result.document
    for symbol in ("SPY", "GLD"):
        assert any(f"cboe chain {symbol}:" in w and YAHOO_NOTE in w and "Black-Scholes" in w
                   for w in result.document["warnings"])


def test_option_iv_yahoo_failure_keeps_blocked() -> None:
    calls = [blocked("helper:cboe:options_chain:SPY"), error("helper:yahoo:options_chain:SPY", message="YFRateLimitError")]
    result = run(["cboe-option-iv", "--symbols", "SPY"], calls)
    assert result.code == 0
    assert result.document["blocked"] == {"host": "cdn-api.cboe.com", "httpStatus": 403}
    assert [t["rows"] for t in result.document["tables"]] == [[], []]
    assert any("yahoo chain: YFRateLimitError" in w for w in result.document["warnings"])
    assert any("cboe chain SPY: ContentTypeError: 403" in w for w in result.document["warnings"])


def test_option_iv_cboe_ok_never_calls_yahoo() -> None:
    # Real trimmed Cboe payloads of the 2026-11-08 recording (before the fallback existed).
    inline = json.loads((FIXTURES / "inline" / "cboe-option-iv-cboe-ok.json").read_text(encoding="utf-8"))
    result = run(["cboe-option-iv", "--symbols", "SPY,GLD"], inline, today=date(2026, 11, 8))
    assert result.code == 0, result.stderr
    assert {r["underlying"] for r in result.table("option_iv_daily")} == {"SPY", "GLD"}
    assert not any(YAHOO_NOTE in w for w in result.document["warnings"])


def test_option_iv_mixed_sources_marks_only_the_yahoo_symbol() -> None:
    inline = json.loads((FIXTURES / "inline" / "cboe-option-iv-cboe-ok.json").read_text(encoding="utf-8"))
    calls = [inline[0], blocked("helper:cboe:options_chain:GLD"),
             call("helper:yahoo:options_chain:GLD", yahoo_payload(spot=322.0))]
    result = run(["cboe-option-iv", "--symbols", "SPY,GLD"], calls, today=date(2026, 11, 21))
    assert result.code == 0, result.stderr
    assert {r["underlying"] for r in result.table("option_iv_daily")} == {"SPY", "GLD"}
    marked = [w for w in result.document["warnings"] if YAHOO_NOTE in w]
    assert len(marked) == 1 and marked[0].startswith("cboe chain GLD:")


def test_option_iv_empty_cboe_kind_does_not_fall_back() -> None:
    calls = [{"key": "helper:cboe:options_chain:SPY", "error": {"kind": "empty", "message": "no data"}}]
    result = run(["cboe-option-iv", "--symbols", "SPY"], calls)
    assert result.code == 3  # plain failure, no Yahoo call recorded (ReplayUpstream would raise)


def test_option_iv_session_guard_skips_only_marked_symbols() -> None:
    # SPY's Yahoo rows are stored for today; GLD is newly blocked and must still fetch.
    state = {"status": "partial", "startedAt": "2026-11-21T16:20:00-05:00", "rowsReceived": 2, "rowsWritten": 2,
             "warnings": [f"cboe chain SPY: ContentTypeError: 403; {YAHOO_NOTE} (IV: Yahoo column; greeks: Black-Scholes, rate 4%, trailing dividend yield)"]}
    calls = [blocked("helper:cboe:options_chain:SPY"), blocked("helper:cboe:options_chain:GLD"),
             call("helper:yahoo:options_chain:GLD", yahoo_payload(spot=322.0))]
    result = run(["cboe-option-iv", "--symbols", "SPY,GLD"], calls, today=date(2026, 11, 21), state=state)
    assert result.code == 0, result.stderr
    assert {r["underlying"] for r in result.table("option_iv_daily")} == {"GLD"}
    spy = [w for w in result.document["warnings"] if w.startswith("cboe chain SPY:") and YAHOO_NOTE in w]
    assert len(spy) == 1 and "skipped the re-fetch" in spy[0]


def test_option_iv_session_guard_survives_three_runs_with_one_fetch() -> None:
    state = None
    for attempt in range(3):
        calls = [blocked("helper:cboe:options_chain:SPY")]
        if attempt == 0:
            calls.append(call("helper:yahoo:options_chain:SPY", yahoo_payload()))
        result = run(["cboe-option-iv", "--symbols", "SPY"], calls, today=date(2026, 11, 21), state=state)
        assert result.code == 0, result.stderr
        marked = [w for w in result.document["warnings"] if YAHOO_NOTE in w]
        assert len(marked) == 1  # the marker persists, so the panel note and the next guard live
        if attempt > 0:
            assert "skipped the re-fetch" in marked[0]
            assert [t["rows"] for t in result.document["tables"]] == [[], []]
        state = {"status": "partial", "startedAt": "2026-11-21T16:20:00-05:00",
                 "rowsReceived": sum(len(t["rows"]) for t in result.document["tables"]),
                 "rowsWritten": sum(len(t["rows"]) for t in result.document["tables"]),
                 "warnings": result.document["warnings"]}


def test_option_iv_session_guard_ignores_yesterday() -> None:
    state = {"status": "partial", "startedAt": "2026-11-20T16:20:00-05:00", "rowsReceived": 2, "rowsWritten": 2,
             "warnings": [f"cboe chain SPY: 403; {YAHOO_NOTE} (IV: Yahoo column)"]}
    calls = [blocked("helper:cboe:options_chain:SPY"), call("helper:yahoo:options_chain:SPY", yahoo_payload())]
    result = run(["cboe-option-iv", "--symbols", "SPY"], calls, today=date(2026, 11, 21), state=state)
    assert result.code == 0, result.stderr
    assert len(result.table("option_iv_daily")) == 1  # fetched again for the new session


def test_option_iv_slow_yahoo_stays_blocked(monkeypatch: pytest.MonkeyPatch) -> None:
    # A tiny reserve makes the gate close after the first delayed Yahoo call: the remaining
    # symbols skip with the gate warning and the run stays blocked_upstream, never exit 3.
    monkeypatch.setattr("vertex_openbb.jobs.cboe.YAHOO_FALLBACK_RESERVE_S", 0.45)
    calls = []
    for cboe_key, yahoo_key in zip(CORE7_CHAINS, YAHOO_CHAINS):
        calls += [blocked(cboe_key), error(yahoo_key, message="slow then refused")]
    result = run(["cboe-option-iv"], calls, env={"OPENBB_DEADLINE_S": "0.5"}, delay_s=0.01)
    assert result.code == 0, result.stderr
    assert result.document["blocked"] == {"host": "cdn-api.cboe.com", "httpStatus": 403}
    assert any("skipped the Yahoo fallback" in w for w in result.document["warnings"])


def test_option_iv_slow_cboe_mixed_regression(monkeypatch: pytest.MonkeyPatch) -> None:
    # The accepted regression case (plan): symbol 1 Cboe 9 s + Yahoo 9 s (fails), symbol 2 Cboe
    # 7 s then ok, deadline 24 s, reserve 10 s. The gate lets symbol 1's fallback start (24-9=15
    # >= 10); after it 6 s remain, so symbol 2's Cboe call (7 s) misses the deadline. Without
    # the fallback symbol 2 would finish at 16 s. Outcome: the pre-existing deadline path with
    # the rows fetched so far (none here) -> exit 3. Deliberate, pinned.
    monkeypatch.setattr("vertex_openbb.jobs.cboe.YAHOO_FALLBACK_RESERVE_S", 10.0)
    from vertex_openbb.upstream import ReplayUpstream

    class Paced(ReplayUpstream):
        async def _call(self, key, factory):
            import asyncio
            delay = {"helper:cboe:options_chain:SPY": 9.0, "helper:yahoo:options_chain:SPY": 9.0,
                     "helper:cboe:options_chain:GLD": 7.0}.get(key, 0.0)
            if delay:
                await asyncio.sleep(delay)
            return await super()._call(key, factory)

    import io
    from vertex_openbb import cli

    calls = [blocked("helper:cboe:options_chain:SPY"), error("helper:yahoo:options_chain:SPY", message="slow"),
             call("helper:cboe:options_chain:GLD", {"data": {"current_price": 322.0, "options": []}})]
    out, err = io.StringIO(), io.StringIO()
    code = cli.run(["cboe-option-iv", "--symbols", "SPY,GLD"], env={"OPENBB_DEADLINE_S": "24"},
                   up=Paced(calls), today=date(2026, 11, 21), stdout=out, stderr=err)
    assert code == 3 and out.getvalue() == ""
    assert "deadline reached before any source was fetched" in err.getvalue()


def test_option_iv_weekend_run_stamps_the_quote_session() -> None:
    # Friday 2026-11-20 16:00 ET quote, run on Saturday: asOf must be Friday, not the run date.
    calls = [blocked("helper:cboe:options_chain:SPY"), call("helper:yahoo:options_chain:SPY", yahoo_payload())]
    result = run(["cboe-option-iv", "--symbols", "SPY"], calls, today=date(2026, 11, 21))
    assert result.code == 0, result.stderr
    assert result.table("option_iv_daily")[0]["asOf"] == "2026-11-20"


def test_option_iv_missing_quote_time_fails_the_symbol() -> None:
    payload = yahoo_payload()
    payload["quote"]["regularMarketTime"] = None
    calls = [blocked("helper:cboe:options_chain:SPY"), call("helper:yahoo:options_chain:SPY", payload)]
    result = run(["cboe-option-iv", "--symbols", "SPY"], calls)
    assert result.code == 0
    assert result.document["blocked"]["httpStatus"] == 403  # the Cboe error keeps the block
    assert any("no quote time" in w for w in result.document["warnings"])



def test_option_iv_failed_ingest_does_not_guard_the_next_run() -> None:
    # The tick records the document warnings even when every ingest chunk failed (rowsWritten
    # 0, status failed). The first-use marker must not guard the next run: Yahoo fetches again.
    state = {"status": "failed", "startedAt": "2026-11-21T16:20:00-05:00", "rowsReceived": 12, "rowsWritten": 0,
             "warnings": [f"cboe chain SPY: ContentTypeError: 403; {YAHOO_NOTE} (IV: Yahoo column; greeks: Black-Scholes, rate 4%, trailing dividend yield)"]}
    calls = [blocked("helper:cboe:options_chain:SPY"), call("helper:yahoo:options_chain:SPY", yahoo_payload())]
    result = run(["cboe-option-iv", "--symbols", "SPY"], calls, today=date(2026, 11, 21), state=state)
    assert result.code == 0, result.stderr
    assert len(result.table("option_iv_daily")) == 1  # fetched again after the failed write
    # The carry-forward warning alone (a skip run, rowsWritten 0) keeps the guard alive.
    skip_state = {"status": "partial", "startedAt": "2026-11-21T17:20:00-05:00", "rowsWritten": 0,
                  "warnings": [f"cboe chain SPY: {YAHOO_NOTE} earlier this session; skipped the re-fetch"]}
    again = run(["cboe-option-iv", "--symbols", "SPY"], [blocked("helper:cboe:options_chain:SPY")],
                today=date(2026, 11, 21), state=skip_state)
    assert again.code == 0, again.stderr
    assert [t["rows"] for t in again.document["tables"]] == [[], []]
    assert any("skipped the re-fetch" in w for w in again.document["warnings"])


def test_option_iv_partial_ingest_does_not_guard_the_next_run() -> None:
    # postTables can write one chunk and fail another (rowsWritten < rowsReceived, status
    # partial). The first-use marker must not guard: missing rows need the next fetch.
    marker = f"cboe chain SPY: ContentTypeError: 403; {YAHOO_NOTE} (IV: Yahoo column; greeks: Black-Scholes, rate 4%, trailing dividend yield)"
    state = {"status": "partial", "startedAt": "2026-11-21T16:20:00-05:00",
             "rowsReceived": 12, "rowsWritten": 5, "warnings": [marker]}
    calls = [blocked("helper:cboe:options_chain:SPY"), call("helper:yahoo:options_chain:SPY", yahoo_payload())]
    result = run(["cboe-option-iv", "--symbols", "SPY"], calls, today=date(2026, 11, 21), state=state)
    assert result.code == 0, result.stderr
    assert len(result.table("option_iv_daily")) == 1  # fetched again after the partial write
    # A complete write (rowsWritten == rowsReceived) guards.
    full = {**state, "rowsWritten": 12}
    guarded = run(["cboe-option-iv", "--symbols", "SPY"], [blocked("helper:cboe:options_chain:SPY")],
                  today=date(2026, 11, 21), state=full)
    assert guarded.code == 0, guarded.stderr
    assert [t["rows"] for t in guarded.document["tables"]] == [[], []]
    assert any("skipped the re-fetch" in w for w in guarded.document["warnings"])


def test_option_iv_state_guard_edge_shapes() -> None:
    from vertex_openbb.context import Context
    from vertex_openbb.jobs.cboe import _yahoo_stored_symbols
    from vertex_openbb.upstream import ReplayUpstream

    ctx = Context(job="cboe-option-iv", today=date(2026, 11, 21), up=ReplayUpstream([]))
    marker = f"cboe chain SPY: 403; {YAHOO_NOTE} (IV: Yahoo column)"
    base = {"status": "partial", "startedAt": "2026-11-21T16:20:00-05:00", "rowsReceived": 2, "rowsWritten": 2}
    # An unparseable start time guards nothing.
    ctx.option_iv_state = {**base, "startedAt": "soon", "warnings": [marker]}
    assert _yahoo_stored_symbols(ctx) == frozenset()
    # A marker warning without the per-symbol prefix guards nothing.
    ctx.option_iv_state = {**base, "warnings": [f"other: {YAHOO_NOTE}"]}
    assert _yahoo_stored_symbols(ctx) == frozenset()
    # A non-dict state guards nothing.
    ctx.option_iv_state = ["not", "a", "dict"]
    assert _yahoo_stored_symbols(ctx) == frozenset()


def test_option_iv_gate_open_without_deadline() -> None:
    from vertex_openbb.context import Context
    from vertex_openbb.jobs.cboe import _gate_open
    from vertex_openbb.upstream import ReplayUpstream

    ctx = Context(job="cboe-option-iv", today=date(2026, 11, 21), up=ReplayUpstream([]))
    assert ctx.deadline_at is None and _gate_open(ctx) is True


def test_option_iv_yahoo_payload_without_contracts_or_with_gaps_warns() -> None:
    # All contracts expired: the payload builds no row; the source fails with the Cboe error.
    payload = yahoo_payload()
    payload["chains"] = {"2026-11-20": payload["chains"]["2026-12-18"]}
    payload["expirations"] = ["2026-11-20", "2027-01-15"]  # one listed expiration has no chain
    calls = [blocked("helper:cboe:options_chain:SPY"), call("helper:yahoo:options_chain:SPY", payload)]
    result = run(["cboe-option-iv", "--symbols", "SPY"], calls, today=date(2026, 11, 21))
    assert result.code == 0
    assert result.document["blocked"]["httpStatus"] == 403
    assert any("1 Yahoo expirations returned no chain" in w for w in result.document["warnings"])
    assert any("no unexpired contracts" in w for w in result.document["warnings"])


def test_option_iv_out_of_range_quote_time_keeps_blocked() -> None:
    payload = yahoo_payload()
    payload["quote"]["regularMarketTime"] = 1e20
    calls = [blocked("helper:cboe:options_chain:SPY"), call("helper:yahoo:options_chain:SPY", payload)]
    result = run(["cboe-option-iv", "--symbols", "SPY"], calls)
    assert result.code == 0
    assert result.document["blocked"]["httpStatus"] == 403
    assert any("out of range" in w for w in result.document["warnings"])
