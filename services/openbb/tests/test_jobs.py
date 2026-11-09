"""Every job replayed from recorded real upstream payloads; arguments, exit codes, NaN removal."""

from __future__ import annotations

import json
import subprocess
import sys
from datetime import date

import pytest
from conftest import FIXTURES, JOBS, ROOT, TEST_CONTACT, call, error, output_fixture, replay_fixture, run, upstream_fixture

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
    syms = ",".join(("SPY",))
    calls = [
        call(f"http:{FTD_PAGE}", page),
        error(f"helper:sec:ftd:202610a:{syms}", "not_found", "HTTP 404"),
        call(f"helper:sec:ftd:202609b:{syms}", [{"date": "2026-09-30", "symbol": "SPY", "cusip": "78462F103", "quantity": 5, "price": 1.5}]),
    ]
    result = run(["sec-ftd", "--symbols", "SPY", "--since", "2026-09-20"], calls, env={"VERTEX_RESEARCH_CONTACT_EMAIL": TEST_CONTACT})
    assert result.code == 0 and any("404" in w for w in result.document["warnings"])
    assert result.table("sec_ftd")[0]["quantity"] == 5


def test_treasury_and_regime_freshness_sources() -> None:
    tga_keys = [c["key"] for c in upstream_fixture("treasury-tga")["calls"]]
    assert any("treasurydirect.gov/TA_WS/securities/auctioned" in k for k in tga_keys)
    events = replay_fixture("fed-events").table("event_calendar")
    today = upstream_fixture("fed-events")["today"]
    assert any(e["kind"] == "treasury_auction" and e["date"] >= today for e in events)
    regime = replay_fixture("fed-regime").table("macro_points")
    assert max(r["date"] for r in regime if r["seriesId"] == "NFCI") >= "2026-10-01"


def test_sec_13f_keeps_universe_and_top_holdings() -> None:
    from vertex_openbb.jobs.sec import CUSIPS, TOP_HOLDINGS

    held = replay_fixture("sec-13f").table("sec_13f_holdings")
    universe = set(CUSIPS.values())
    for (cik, period) in {(r["filerCik"], r["periodEnding"]) for r in held}:
        mine = [r for r in held if r["filerCik"] == cik and r["periodEnding"] == period]
        assert len([r for r in mine if r["cusip"] not in universe]) <= TOP_HOLDINGS


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
    assert series == [{"close": 18.0, "date": "2026-11-05", "high": None, "low": 17.0, "open": None, "seriesId": "VIX"}]
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
    blocked = run(fixture["argv"], refuse(0), today=today)
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
