"""daily-prices: the rules, the state-driven run and the live helper bodies (fake transport, no network)."""

from __future__ import annotations

import io
import json
import sys
import types
from datetime import date
from typing import Any

import pytest
from conftest import call, error, run, upstream_fixture

from vertex_openbb.context import ArgumentError
from vertex_openbb.jobs import daily_prices as dp

TODAY = date(2026, 11, 21)  # Saturday: the last session is Friday 2026-11-20


def row(day: str, close: float, **extra: Any) -> dict[str, Any]:
    base = {"date": day, "open": close - 1, "high": close + 2, "low": close - 2, "close": close,
            "adj_close": close, "volume": 10.0, "source": "yahoo"}
    return {**base, **extra}


def unit(rows: list[dict[str, Any]], **extra: Any) -> dict[str, Any]:
    return {"errors": {}, "paced": False, "rows": rows, "warnings": [], **extra}


def state(series: dict[str, tuple[str, float, float | None]], bars: dict[str, tuple[str, float]] | None = None) -> dict[str, Any]:
    return {
        "series": [{"id": k, "lastDate": d, "close": c, "adjClose": a} for k, (d, c, a) in series.items()],
        "bars": [{"symbol": k, "lastDate": d, "close": c} for k, (d, c) in (bars or {}).items()],
    }


DONE = {sid: ("2026-11-20", 100.0, None) for sid in (*dp.UNITS, dp.RATIO_ID)}
DONE_BARS = {sid: ("2026-11-20", 100.0) for sid in dp.UNITS if sid not in ("TNX", "IRX")}


def behind(sid: str, last: str = "2026-11-18", close: float = 100.0, adj: float | None = None,
           bars: tuple[str, float] | None = None) -> dict[str, Any]:
    all_bars = dict(DONE_BARS)
    if bars is not None:
        all_bars[sid] = bars
    return state({**DONE, sid: (last, close, adj)}, all_bars)


def key(sid: str, start: str, source: str = "ibkr") -> str:
    return f"helper:daily-prices:{sid}:{start}:{source}"


def test_last_session_skips_weekends_and_nyse_closures() -> None:
    assert dp.last_session(date(2026, 11, 21)) == date(2026, 11, 20)
    assert dp.last_session(date(2026, 11, 23)) == date(2026, 11, 20)
    assert dp.last_session(date(2026, 11, 27)) == date(2026, 11, 25)  # Thanksgiving 2026-11-26


def test_unit_done_needs_the_series_and_the_bar_series() -> None:
    session = date(2026, 11, 20)
    assert not dp.unit_done(None, None, session)
    assert dp.unit_done({"lastDate": "2026-11-20"}, None, session)
    assert not dp.unit_done({"lastDate": "2026-11-19"}, None, session)
    assert not dp.unit_done({"lastDate": "2026-11-20"}, {"lastDate": "2026-11-19"}, session)
    assert dp.unit_done({"lastDate": "2026-11-20"}, {"lastDate": "2026-11-20"}, session)


def test_after_seam_rules() -> None:
    fetched = [row("2026-11-18", 100.5), row("2026-11-19", 101), row("2026-11-20", 102)]
    assert dp.after_seam(fetched, None, 0.02) == (fetched, None, None)
    stored = {"lastDate": "2026-11-18", "close": 100.0}
    newer, seam, problem = dp.after_seam(fetched, stored, 0.02)
    assert [r["date"] for r in newer] == ["2026-11-19", "2026-11-20"] and seam == fetched[0] and problem is None
    assert dp.after_seam(fetched, {"lastDate": "2026-11-20", "close": 1.0}, 0.02) == ([], None, None)
    assert "no fetched close on the stored last date 2026-11-17" in str(dp.after_seam(fetched, {"lastDate": "2026-11-17", "close": 100.0}, 0.02)[2])
    assert "no fetched close" in str(dp.after_seam([row("2026-11-18", float("nan")), fetched[1]], stored, 0.02)[2])
    assert "differs from the stored 50 by more than 2%" in str(dp.after_seam(fetched, {"lastDate": "2026-11-18", "close": 50.0}, 0.02)[2])
    assert "differs" in str(dp.after_seam(fetched, {"lastDate": "2026-11-18", "close": 0.0}, 0.02)[2])
    assert dp.after_seam(fetched, {"lastDate": "2026-11-18", "close": 95.0}, 0.10)[2] is None


def test_series_rows_per_kind_and_the_adjusted_close_chain() -> None:
    newer = [row("2026-11-19", 101, adj_close=50.5), row("2026-11-20", 102, adj_close=51)]
    seam = row("2026-11-18", 100, adj_close=50)
    etf = dp.series_rows("SPY", newer, seam, {"lastDate": "2026-11-18", "close": 100.0, "adjClose": 80.0})
    assert [r["adjClose"] for r in etf] == [80.8, 81.6]
    assert etf[0] == {"adjClose": 80.8, "close": 101, "date": "2026-11-19", "high": 103, "low": 99, "open": 100, "seriesId": "SPY"}
    # No stored state (dry run): the fetched adjusted close as it is.
    assert [r["adjClose"] for r in dp.series_rows("SPY", newer, None, None)] == [50.5, 51]
    # A stored series without an adjusted close cannot be continued.
    assert dp.series_rows("SPY", newer, seam, {"lastDate": "2026-11-18", "close": 100.0, "adjClose": None}) == []
    assert dp.series_rows("SPY", newer, row("2026-11-18", 100, adj_close=None), {"lastDate": "2026-11-18", "close": 100.0, "adjClose": 80.0}) == []
    future = dp.series_rows("ES=F", newer, seam, {"lastDate": "2026-11-18", "close": 100.0, "adjClose": 100.0})
    assert [r["adjClose"] for r in future] == [101, 102] and future[0]["open"] == 100
    index = dp.series_rows("TNX", newer, seam, {"lastDate": "2026-11-18", "close": 100.0, "adjClose": None})
    assert index[1] == {"adjClose": None, "close": 102, "date": "2026-11-20", "high": None, "low": None, "open": None, "seriesId": "TNX"}
    # The first row that cannot be stored ends the unit: no hole in the series.
    holes = [row("2026-11-19", 101, open=None), row("2026-11-20", 102)]
    assert dp.series_rows("ES=F", holes, seam, None) == []
    assert dp.series_rows("TNX", [row("2026-11-19", float("nan")), newer[1]], seam, None) == []


def test_bar_rows_stop_at_the_first_invalid_bar() -> None:
    newer = [row("2026-11-19", 101, volume=None), row("2026-11-20", 102, volume=-5), row("2026-11-21", 103, high=1), row("2026-11-22", 104)]
    bars = dp.bar_rows("SPY", newer)
    assert bars == [
        {"close": 101, "date": "2026-11-19", "high": 103, "low": 99, "open": 100, "symbol": "SPY", "volume": None},
        {"close": 102, "date": "2026-11-20", "high": 104, "low": 100, "open": 101, "symbol": "SPY", "volume": None},
    ]


def test_ratio_rows_follow_the_import_formula() -> None:
    shiller = [["2026-04", 0.0, 1.0], ["2026-05", 6200.0, 255.0]]
    tnx = [row("2026-11-18", 4.5), row("2026-11-19", 5.0), row("2026-11-20", 0.0), row("2026-11-23", 5.0)]
    rows = dp.ratio_rows(tnx, shiller, "2026-11-18")
    assert rows == [{"adjClose": None, "close": 100 * 255.0 / 6200.0 / 5.0, "date": "2026-11-19", "high": None, "low": None, "open": None, "seriesId": "EY_TNX_RATIO"}]
    assert len(dp.ratio_rows(tnx[:2], shiller, None)) == 2
    assert dp.ratio_rows([row("2026-12-01", 5.0)], shiller, None) == []  # 2026-06 is not published
    assert dp.shift_month("2026-01", -6) == "2025-07" and dp.shift_month("2026-11", 2) == "2027-01"


def test_read_state() -> None:
    parsed = dp.read_state(io.StringIO(json.dumps(state({"SPY": ("2026-11-06", 1.0, 2.0)}, {"SPY": ("2026-11-03", 1.0)}))))
    assert parsed["series"]["SPY"]["adjClose"] == 2.0 and parsed["bars"]["SPY"]["lastDate"] == "2026-11-03"
    for bad in ("[]", "{}", '{"series": [{"id": "SPY", "lastDate": "x", "close": 1}], "bars": []}', "not json",
                '{"series": [{"id": "SPY", "lastDate": "2026-11-06", "close": null}], "bars": []}'):
        with pytest.raises(ArgumentError):
            dp.read_state(io.StringIO(bad))
    assert run(["daily-prices"], state=[]).code == 2
    assert run(["daily-prices", "--symbols", "SPY"]).code == 2
    assert run(["fed-rates"], state={}).code == 2


def test_a_year_outside_the_closure_list_warns() -> None:
    later = {sid: ("2029-01-02", 100.0, None) for sid in (*dp.UNITS, dp.RATIO_ID)}
    result = run(["daily-prices"], today=date(2029, 1, 3), state=state(later, {k: ("2029-01-02", 1.0) for k in DONE_BARS}))
    assert result.document["warnings"] == ["daily-prices: the NYSE closure list does not cover 2029; extend jobs/nyse_closures.py"]


def test_a_run_with_every_unit_stored_is_quiet() -> None:
    result = run(["daily-prices"], today=TODAY, state=state(DONE, DONE_BARS))
    assert result.code == 0
    assert result.document["warnings"] == [] and result.table("daily_series") == [] and result.table("daily_bars") == []


def test_appends_only_the_rows_after_the_stored_last_dates() -> None:
    fetched = [row("2026-11-16", 99, adj_close=49.5), row("2026-11-18", 100, adj_close=50), row("2026-11-19", 101, adj_close=50.5),
               row("2026-11-20", 102, adj_close=51), row("2026-11-21", 103, adj_close=51.5)]
    stored = behind("SPY", adj=80.0, bars=("2026-11-16", 99.0))
    result = run(["daily-prices"], [call(key("SPY", "2026-11-09"), unit(fetched))], today=TODAY, state=stored)
    assert result.code == 0 and result.document["warnings"] == []
    assert [(r["date"], r["adjClose"]) for r in result.table("daily_series")] == [("2026-11-19", 80.8), ("2026-11-20", 81.6)]
    assert [r["date"] for r in result.table("daily_bars")] == ["2026-11-18", "2026-11-19", "2026-11-20"]


def test_seam_mismatch_and_missing_entries_write_nothing_and_warn() -> None:
    fetched = [row("2026-11-18", 100), row("2026-11-19", 101), row("2026-11-20", 102)]
    stored = behind("SPY", close=50.0, adj=40.0, bars=("2026-11-18", 100.0))
    result = run(["daily-prices"], [call(key("SPY", "2026-11-11"), unit(fetched, warnings=["seam note"]))], today=TODAY, state=stored)
    assert result.code == 0 and result.table("daily_series") == []
    assert [r["date"] for r in result.table("daily_bars")] == ["2026-11-19", "2026-11-20"]
    assert result.document["warnings"] == [
        "SPY: seam note",
        "SPY: close 100 on 2026-11-18 differs from the stored 50 by more than 2%; nothing is appended to the series",
    ]
    stored = behind("ES=F", adj=100.0, bars=("2026-11-18", 50.0))
    result = run(["daily-prices"], [call(key("ES=F", "2026-11-11"), unit(fetched))], today=TODAY, state=stored)
    assert [r["adjClose"] for r in result.table("daily_series")] == [101, 102] and result.table("daily_bars") == []
    assert result.document["warnings"] == [
        "ES=F bars: close 100 on 2026-11-18 differs from the stored 50 by more than 10%; nothing is appended to the bar series"
    ]
    # A unit without a stored series is not created; a unit without a stored bar series gets no bars.
    missing = state({k: v for k, v in DONE.items() if k != "IRX"} | {"GLD": ("2026-11-18", 100.0, 100.0)},
                    {k: v for k, v in DONE_BARS.items() if k != "GLD"})
    result = run(["daily-prices"], [call(key("GLD", "2026-11-11"), unit(fetched))], today=TODAY, state=missing)
    assert result.document["warnings"] == ["IRX: no stored series, nothing is appended"]
    assert len(result.table("daily_series")) == 2 and result.table("daily_bars") == []


def test_tnx_derives_the_ratio_and_treasury_rows_are_refused() -> None:
    fetched = [row("2026-11-18", 4.5), row("2026-11-19", 5.0), row("2026-11-20", 5.0)]
    stored = state({**DONE, "TNX": ("2026-11-18", 4.5, None), "EY_TNX_RATIO": ("2026-11-19", 100 * 255.0 / 6200.0 / 5.0, None)})
    calls = [call(key("TNX", "2026-11-11"), unit(fetched)), call("helper:daily-prices:shiller", [["2026-05", 6200.0, 255.0]])]
    result = run(["daily-prices"], calls, today=TODAY, state=stored)
    assert [(r["seriesId"], r["date"]) for r in result.table("daily_series")] == [
        ("EY_TNX_RATIO", "2026-11-20"), ("TNX", "2026-11-19"), ("TNX", "2026-11-20")]
    assert result.document["warnings"] == []
    # Shiller revised the month: the appended rows use the new figures and the run says so.
    revised = state({**DONE, "TNX": ("2026-11-18", 4.5, None), "EY_TNX_RATIO": ("2026-11-19", 0.9, None)})
    assert run(["daily-prices"], calls, today=TODAY, state=revised).document["warnings"] == [
        "EY_TNX_RATIO: the Shiller figures changed since the stored rows (2026-11-19: stored 0.9000, now 0.8226); the appended rows use the new figures"
    ]
    # The ratio is up to date: the workbook is not read. A failed workbook read keeps the TNX rows.
    current = state({**DONE, "TNX": ("2026-11-18", 4.5, None), "EY_TNX_RATIO": ("2026-11-20", 1.0, None)})
    assert len(run(["daily-prices"], calls[:1], today=TODAY, state=current).table("daily_series")) == 2
    failed = run(["daily-prices"], [calls[0], error("helper:daily-prices:shiller")], today=TODAY, state=stored)
    assert failed.code == 0 and len(failed.table("daily_series")) == 2 and failed.document["warnings"] == ["shiller workbook: boom"]
    treasury = [fetched[0], {**fetched[1], "source": "treasury"}]
    result = run(["daily-prices"], [call(key("TNX", "2026-11-11"), unit(treasury))], today=TODAY, state=current)
    assert result.table("daily_series") == []
    assert result.document["warnings"] == ["TNX: the answer holds rows of the Treasury par yield fallback; nothing is appended"]
    # The ratio is derived only from TNX rows checked in this run. TNX is behind (stored 2026-11-18)
    # and the ratio is further behind (2026-11-17).
    ey = 100 * 255.0 / 6200.0 / 5.0
    behind_ratio = state({**DONE, "TNX": ("2026-11-18", 5.0, None), "EY_TNX_RATIO": ("2026-11-17", ey, None)})
    good = [row("2026-11-17", 5.0), row("2026-11-18", 5.0), row("2026-11-19", 5.0)]
    tnx_key = key("TNX", "2026-11-10")
    # No newer TNX row (and another scale): nothing is checked, so no ratio row and no workbook read.
    stale = run(["daily-prices"], [call(tnx_key, unit([row("2026-11-17", 45.0), row("2026-11-18", 45.0)]))], today=TODAY, state=behind_ratio)
    assert stale.code == 0 and stale.table("daily_series") == [] and stale.document["warnings"] == []
    # A Treasury row anywhere in the answer: no TNX row and no ratio row.
    mixed = [{**good[0], "source": "treasury"}, *good[1:]]
    refused = run(["daily-prices"], [call(tnx_key, unit(mixed)), calls[1]], today=TODAY, state=behind_ratio)
    assert refused.table("daily_series") == []
    assert refused.document["warnings"] == ["TNX: the answer holds rows of the Treasury par yield fallback; nothing is appended"]
    # Checked rows: the ratio catches up from its own last date.
    caught_up = run(["daily-prices"], [call(tnx_key, unit(good)), calls[1]], today=TODAY, state=behind_ratio)
    assert [(r["seriesId"], r["date"]) for r in caught_up.table("daily_series")] == [
        ("EY_TNX_RATIO", "2026-11-18"), ("EY_TNX_RATIO", "2026-11-19"), ("TNX", "2026-11-19")]
    assert caught_up.document["warnings"] == []
    # A missing ratio series is not created.
    no_ratio = state({k: v for k, v in DONE.items() if k != dp.RATIO_ID} | {"TNX": ("2026-11-18", 4.5, None)})
    result = run(["daily-prices"], calls[:1], today=TODAY, state=no_ratio)
    assert [r["seriesId"] for r in result.table("daily_series")] == ["TNX", "TNX"]
    assert result.document["warnings"] == ["EY_TNX_RATIO: no stored series, nothing is appended"]


def test_paced_ends_the_run_a_failed_unit_is_counted_and_ibkr_errors_switch_to_yahoo() -> None:
    fetched = [row("2026-11-18", 100), row("2026-11-19", 101)]
    both = state({**DONE, "SPY": ("2026-11-18", 100.0, 100.0), "QQQ": ("2026-11-18", 100.0, 100.0)}, DONE_BARS)
    paced = run(["daily-prices"], [call(key("SPY", "2026-11-11"), {**unit([]), "paced": True})], today=TODAY, state=both)
    assert paced.code == 0 and paced.document["warnings"] == [] and paced.table("daily_series") == []
    switched = run(["daily-prices"], [
        call(key("SPY", "2026-11-11"), unit(fetched, errors={"ibkr": "UPSTREAM_ERROR: x"})),
        call(key("QQQ", "2026-11-11", "yahoo"), unit(fetched)),
    ], today=TODAY, state=both)
    assert [r["seriesId"] for r in switched.table("daily_series")] == ["QQQ", "SPY"]
    failed = run(["daily-prices"], [error(key("SPY", "2026-11-11")), call(key("QQQ", "2026-11-11"), unit(fetched))], today=TODAY, state=both)
    assert failed.code == 0 and failed.document["warnings"] == ["SPY: boom"]
    assert run(["daily-prices"], [error(key("SPY", "2026-11-11")), error(key("QQQ", "2026-11-11"))], today=TODAY, state=both).code == 3


def test_a_unit_that_cannot_advance_warns() -> None:
    fetched = [row("2026-11-18", 100), row("2026-11-19", 101), row("2026-11-20", 102, high=1)]
    stored = behind("SPY", adj=None, bars=("2026-11-18", 100.0))
    result = run(["daily-prices"], [call(key("SPY", "2026-11-11"), unit(fetched))], today=TODAY, state=stored)
    assert result.table("daily_series") == [] and [r["date"] for r in result.table("daily_bars")] == ["2026-11-19"]
    assert result.document["warnings"] == [
        "SPY: stopped at 2026-11-19 (the row cannot be stored: a missing or invalid price, or no adjusted close); 2 rows not appended",
        "SPY bars: stopped at 2026-11-20 (the row cannot be stored: a missing or invalid price, or no adjusted close); 1 rows not appended",
    ]


def test_a_missing_research_folder_is_a_configuration_error(tmp_path: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delitem(sys.modules, "vertex_research_ibkr_history", raising=False)
    result = run(["daily-prices"], today=TODAY, state=state(DONE, DONE_BARS), env={dp.RESEARCH_DIR_ENV: str(tmp_path)})
    assert result.code == 2 and "ibkr_history.py not found" in result.stderr


def test_since_moves_the_start_back_and_the_deadline_gate_starts_no_unit() -> None:
    stored = behind("SPY", adj=100.0)
    fetched = [row("2026-11-18", 100), row("2026-11-19", 101)]
    result = run(["daily-prices", "--since", "2026-10-01"], [call(key("SPY", "2026-10-01"), unit(fetched))], today=TODAY, state=stored)
    assert len(result.table("daily_series")) == 1
    late = run(["daily-prices", "--since", "2026-11-17"], [call(key("SPY", "2026-11-11"), unit(fetched))], today=TODAY, state=stored)
    assert len(late.table("daily_series")) == 1
    gated = run(["daily-prices"], [], today=TODAY, state=stored, env={"OPENBB_DEADLINE_S": "50"})
    assert gated.code == 0 and gated.document["warnings"] == [] and gated.table("daily_series") == []


def test_dry_run_fixture_switches_to_yahoo_after_the_first_ibkr_error() -> None:
    keys = [item["key"] for item in upstream_fixture("daily-prices")["calls"]]
    assert keys[0].endswith(":ibkr") and keys[1] == "helper:daily-prices:shiller"
    assert all(k.endswith(":yahoo") for k in keys[2:]) and len(keys) == len(dp.UNITS) + 1


# --- live helper bodies ---------------------------------------------------------------------------

ENV = {"VERTEX_HISTORY_URL": "https://history.invalid/vertex-history/v1", "VERTEX_DEPLOY_STATUS_TOKEN": "t0ken"}
DAY = 86_400


def history(bars: list[tuple[str, float]]) -> bytes:
    epoch = date(1970, 1, 1).toordinal()
    rows = [{"t": (date.fromisoformat(d).toordinal() - epoch) * DAY, "o": c, "h": c + 1, "l": c - 1, "c": c, "v": 5.0} for d, c in bars]
    return json.dumps({"schema": "vertex-history-bars-v2", "bars": rows, "count": len(rows), "request": {}, "volume_unit": "shares"}).encode()


def transport_of(ih: Any, answers: list[Any]) -> Any:
    seen: list[str] = []

    def transport(url: str, _headers: Any, _timeout: float, _max: int) -> Any:
        seen.append(url)
        answer = answers.pop(0)
        if isinstance(answer, int):
            return ih.HttpResponse(answer, {"content-type": "application/json"}, b'{"retry_after_seconds": 30}')
        return ih.HttpResponse(200, {"content-type": "application/json"}, answer)

    transport.seen = seen  # type: ignore[attr-defined]
    return transport


def no_yahoo(_symbol: str, _start: str) -> list[dict[str, Any]]:
    raise AssertionError("Yahoo must not be called")


def test_fetch_unit_reads_ibkr_first_and_joins_the_adjusted_close() -> None:
    ih = dp.research_module("ibkr_history", {})
    assert dp.research_module("ibkr_history", {}) is ih
    bars = [("2026-11-18", 100.0), ("2026-11-19", 101.0)]
    transport = transport_of(ih, [history([(d, c / 2) for d, c in bars]), history(bars)])
    result = dp.fetch_unit("SPY", "2026-11-18", ENV, True, no_yahoo, transport)
    assert result["paced"] is False and result["errors"] == {}
    assert result["rows"][1] == {"date": "2026-11-19", "open": 101.0, "high": 102.0, "low": 100.0, "close": 101.0,
                                 "adj_close": 50.5, "volume": 5.0, "source": "ibkr"}
    assert len(transport.seen) == 2 and "ADJUSTED_LAST" in transport.seen[0]
    # A day missing from ADJUSTED_LAST gets a carried adjusted close from the client: it is dropped.
    carried = dp.fetch_unit("SPY", "2026-11-18", ENV, True, no_yahoo, transport_of(ih, [history(bars[:1]), history(bars)]))
    assert [r["adj_close"] for r in carried["rows"]] == [100.0, None]
    future = dp.fetch_unit("ES=F", "2026-11-18", ENV, True, no_yahoo, transport_of(ih, [history(bars)]))
    assert future["rows"][0]["adj_close"] == 100.0
    index = dp.fetch_unit("TNX", "2026-11-18", ENV, True, no_yahoo, transport_of(ih, [history([(d, 45.0) for d, _ in bars])]))
    assert [r["close"] for r in index["rows"]] == [4.5, 4.5]


def test_fetch_unit_falls_to_yahoo_but_not_when_ibkr_paced() -> None:
    ih = dp.research_module("ibkr_history", {})
    yahoo_calls: list[tuple[str, str]] = []

    def yahoo(symbol: str, start: str) -> list[dict[str, Any]]:
        yahoo_calls.append((symbol, start))
        return [row("2026-11-18", 4.5), row("2026-11-19", 4.6)]

    failed = dp.fetch_unit("IRX", "2026-11-18", ENV, True, yahoo, transport_of(ih, [500]))
    assert failed["errors"] == {"ibkr": "UPSTREAM_ERROR: History endpoint returned HTTP 500"}
    assert [r["source"] for r in failed["rows"]] == ["yahoo", "yahoo"] and yahoo_calls == [("^IRX", "2026-11-18")]
    for use_ibkr, env in ((False, ENV), (True, {})):
        off = dp.fetch_unit("SPY", "2026-11-18", env, use_ibkr, yahoo, transport_of(ih, []))
        assert off["errors"]["ibkr"].startswith("NOT_CONFIGURED") and len(off["rows"]) == 2
    yahoo_calls.clear()
    paced = dp.fetch_unit("ES=F", "2026-11-18", ENV, True, yahoo, transport_of(ih, [429]))
    assert paced == {"errors": {}, "paced": True, "rows": [], "warnings": []} and yahoo_calls == []
    # An index unit has a third source (Treasury) that answers after a paced IBKR: still paced.
    treasury = "Date,3 Mo,10 Yr\n11/18/2026,4.2,4.9\n11/19/2026,4.2,4.9\n".encode()
    original = ih.public_get
    ih.public_get = lambda _url: treasury
    try:
        for index in ("TNX", "IRX"):
            assert dp.fetch_unit(index, "2026-11-18", ENV, True, yahoo, transport_of(ih, [429]))["paced"] is True
        # The Treasury download fails after the paced answer: the unit is still paced, not failed.
        ih.public_get = lambda _url: (_ for _ in ()).throw(OSError("treasury down"))
        assert dp.fetch_unit("TNX", "2026-11-18", ENV, True, yahoo, transport_of(ih, [429]))["paced"] is True
    finally:
        ih.public_get = original
    assert yahoo_calls == []

    def broken(_symbol: str, _start: str) -> list[dict[str, Any]]:
        raise RuntimeError("yahoo down")

    with pytest.raises(RuntimeError):
        dp.fetch_unit("ES=F", "2026-11-18", {}, True, broken)
    with pytest.raises(ih.IbkrHistoryError):
        dp.fetch_unit("ES=F", "2026-11-18", ENV, True, lambda *_: (_ for _ in ()).throw(ih.IbkrHistoryError("NOT_FOUND", "x")), transport_of(ih, [500]))


def test_yahoo_rows_and_the_shiller_helper(monkeypatch: pytest.MonkeyPatch) -> None:
    class Stamp:
        def strftime(self, _format: str) -> str:
            return "2026-11-20"

    class Frame:
        def iterrows(self) -> Any:
            return iter([(Stamp(), {"Open": 1, "High": 3, "Low": 0.5, "Close": 2, "Adj Close": 1.9, "Volume": 7})])

    class Ticker:
        def __init__(self, symbol: str) -> None:
            self.symbol = symbol

        def history(self, **options: Any) -> Frame:
            assert options == {"start": "2026-11-18", "interval": "1d", "auto_adjust": False} and self.symbol == "^TNX"
            return Frame()

    monkeypatch.setitem(sys.modules, "yfinance", types.SimpleNamespace(Ticker=Ticker))
    assert dp.yahoo_rows("^TNX", "2026-11-18") == [
        {"date": "2026-11-20", "open": 1.0, "high": 3.0, "low": 0.5, "close": 2.0, "adj_close": 1.9, "volume": 7.0}]
    ih = dp.research_module("ibkr_history", {})
    shiller = dp.research_module("shiller", {})
    pages = {shiller.PAGE_URL: b'<a href="//files.invalid/ie_data.xls">data</a>', "https://files.invalid/ie_data.xls": b"workbook"}
    monkeypatch.setattr(ih, "public_get", lambda url: pages[url])
    monkeypatch.setattr(shiller, "monthly_rows", lambda content: [("2026-05", 6200.0, 255.0)] if content == b"workbook" else [])
    assert dp.fetch_shiller({}) == [["2026-05", 6200.0, 255.0]]


def test_research_module_reports_a_missing_folder(tmp_path: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delitem(sys.modules, "vertex_research_shiller", raising=False)
    with pytest.raises(ArgumentError, match="shiller.py not found"):
        dp.research_module("shiller", {dp.RESEARCH_DIR_ENV: str(tmp_path)})
    assert "vertex_research_shiller" not in sys.modules
    monkeypatch.setattr(dp.importlib.util, "spec_from_file_location", lambda *_: None)
    with pytest.raises(ArgumentError, match="cannot load"):
        dp.research_module("shiller", {})


def test_the_history_url_and_token_never_reach_the_output() -> None:
    assert dp.SECRET_ENV == ("VERTEX_HISTORY_URL", "VERTEX_DEPLOY_STATUS_TOKEN")
    stored = behind("SPY", adj=100.0)
    leaked = unit([row("2026-11-18", 100), row("2026-11-19", 101)], warnings=[f"token {ENV['VERTEX_DEPLOY_STATUS_TOKEN']}"])
    result = run(["daily-prices"], [call(key("SPY", "2026-11-11"), leaked)], today=TODAY, state=stored, env=ENV)
    assert result.code == 1 and result.stdout == "" and "refusing to print" in result.stderr
