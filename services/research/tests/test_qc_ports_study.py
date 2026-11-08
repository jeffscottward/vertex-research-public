"""qc-ports study: DSL compile with derived series, leg policies, verdict and document pieces (synthetic)."""
import itertools
import math

import pytest

from strategies.qc_ports import ideas as qi
from strategies.qc_ports import study
from strategies.qc_ports.data import Bars
from strategies.qc_ports.ledger import LedgerResult, run_ledger
from tests.qc_ports_synthetic import market, trading_days


def _data(closes, symbol="SPY", start="2024-01-02", context=None):
    m = market(closes, symbol=symbol, start=start)
    column = tuple(float(c) for c in closes)
    bars = Bars(symbol, m.dates, column, column, column, column, column)
    return study.StudyData(m.dates, {symbol: bars}, {symbol: m}, context or {}, None, {}, "digest")


def _dsl(dates, closes):
    return study.dsl_bars(dates, closes, closes, closes, closes)


def test_derived_series_filter_ands_into_entries():
    dates = trading_days("2024-01-02", 5)
    context = {"qc:flag:SPY": {dates[0]: 1.0, dates[1]: 0.0, dates[3]: 1.0}}
    definition = qi.definition("t", qi.MONTHLY_CALL, filters=[qi.series_filter("qc:flag:SPY", ">", 0)])
    entries, exits = study.compile_signals(_dsl(dates, [100.0] * 5), definition, context, "SPY")
    # dates[2] carries dates[1] (0); dates[4] carries dates[3] (1), as a native series filter aligns.
    assert entries == [True, False, False, True, True]
    assert exits == [False] * 5
    with pytest.raises(ValueError):
        study.compile_signals(_dsl(dates, [100.0] * 5), definition, {}, "SPY")


def test_contango_gate_is_strict_and_needs_both_values():
    dates = trading_days("2024-01-02", 4)
    context = {"VIX": {dates[0]: 15.0, dates[1]: 20.0, dates[2]: 21.0},
               "VIX3M": {dates[0]: 16.0, dates[1]: 20.0, dates[2]: 20.0, dates[3]: 20.0}}
    gated = qi.definition("t", qi.PUT_CREDIT, filters=[qi.GATES["vixTermStructure"]])
    entries, _ = study.compile_signals(_dsl(dates, [100.0] * 4), gated, context, "SPY")
    assert entries == [True, False, False, False]  # 0.9375; tie 1.00; 1.05; VIX missing


def _month_dates_closes(count=70):
    closes = [100.0 + 0.1 * k for k in range(count)]
    return closes


def test_roll_policy_closes_at_each_rebalance():
    closes = _month_dates_closes()
    data = _data(closes)
    leg = qi.Leg("SPY", qi.definition("always", qi.MONTHLY_CALL), "roll", "2024-01-31")
    trades, skipped, signals = study.leg_trades(leg, data)
    assert signals == 3 and skipped == []
    assert [(t.entry_date, t.exit_date, t.exit_reason) for t in trades] == [
        ("2024-02-01", "2024-03-01", "signal"), ("2024-03-01", "2024-04-01", "signal"),
        ("2024-04-01", data.spy_dates[-1], "end")]


def test_roll_policy_respects_start_and_end():
    data = _data(_month_dates_closes())
    leg = qi.Leg("SPY", qi.definition("always", qi.MONTHLY_CALL), "roll", "2024-02-01", end="2024-02-29")
    trades, _, signals = study.leg_trades(leg, data)
    assert signals == 1 and trades[0].entry_date == "2024-03-01"


def test_monthly_frame_reads_month_end_closes():
    closes = [100.0] * 25 + [90.0] * 20 + [120.0] * 25  # month-ends: Jan 100, Feb 90, Mar 120
    data = _data(closes)
    up = qi.definition("up", qi.MONTHLY_CALL, entry=[qi.condition(qi.CLOSE, ">", qi.indicator("sma", 2))])
    leg = qi.Leg("SPY", up, "roll", "2024-01-01", frame="monthly")
    trades, _, signals = study.leg_trades(leg, data)
    assert signals == 1  # Mar: 120 > (90 + 120) / 2; Feb: 90 < 95
    assert trades[0].entry_date == "2024-04-01"


def test_flat_policy_waits_for_the_close_and_uses_dsl_exits():
    closes = [100.0, 101.0, 102.0, 103.0, 104.0, 100.0, 99.0, 98.0, 99.0, 101.0, 103.0, 105.0] + [106.0] * 30
    data = _data(closes)
    sma = qi.indicator("sma", 3)
    definition = qi.definition("sma3", qi.HOST_CALL, entry=[qi.condition(qi.CLOSE, ">", sma)],
                               exit=[qi.condition(qi.CLOSE, "<", sma)])
    leg = qi.Leg("SPY", definition, "flat", "2024-01-01", cadence="daily")
    trades, skipped, _ = study.leg_trades(leg, data)
    first, second = trades[:2]
    dates = data.spy_dates
    # Entry signal at bar 2 (102 > 101), trade at bar 3; exit signal at bar 5 (100 < 102.33), trade at bar 6.
    assert (first.entry_date, first.exit_date, first.exit_reason) == (dates[3], dates[6], "signal")
    # Flat from bar 6; next entry signal at bar 8 (99 > 98.67), trade at bar 9.
    assert second.entry_date == dates[9]
    for earlier, later in itertools.pairwise(trades):
        assert later.entry_index > earlier.exit_index
    assert skipped == []


def test_flat_month_end_cadence_keeps_one_open_spread():
    data = _data([100.0] * 120)
    leg = qi.Leg("SPY", qi.definition("put", qi.PUT_CREDIT), "flat", "2024-01-01")
    trades, _, _ = study.leg_trades(leg, data)
    ends = {data.spy_dates[i] for i in qi.month_end_indices(data.spy_dates)}
    for trade in trades:
        assert data.spy_dates[trade.entry_index - 1] in ends
    for earlier, later in itertools.pairwise(trades):
        assert later.entry_index - 1 >= earlier.exit_index


def test_turn_of_month_window_trades_days_minus_two_to_plus_three():
    data = _data([100.0] * 60)
    tom = qi.definition("tom", qi.CALENDAR_CALL, filters=[
        {"type": "calendarWindow", "window": "turnOfMonth", "fromDay": -3, "toDay": 2}])
    trades, _, _ = study.leg_trades(qi.Leg("SPY", tom, "window", "2024-01-01"), data)
    # The Dec/Jan window is cut by the data start (not full) and is not traded.
    assert [(t.entry_date, t.exit_date) for t in trades] == [("2024-01-30", "2024-02-05"),
                                                             ("2024-02-28", "2024-03-05")]


def test_opex_window_shift_moves_signals_one_bar_earlier():
    data = _data([100.0] * 60)
    opex = qi.definition("opex", qi.CALENDAR_CALL, filters=[{"type": "calendarWindow", "window": "opexWeek"}])
    literal, _, _ = study.leg_trades(qi.Leg("SPY", opex, "window", "2024-01-03"), data)
    held, _, _ = study.leg_trades(qi.Leg("SPY", opex, "window", "2024-01-03", shift=1), data)
    # January 2024 expiry Fri 19th: the week is Jan 16-19 (Monday 15th is a holiday); Fri 12th is before it.
    assert (literal[0].entry_date, literal[0].exit_date) == ("2024-01-16", "2024-01-22")
    assert (held[0].entry_date, held[0].exit_date) == ("2024-01-12", "2024-01-19")


def test_verdict_rule():
    good = {"sharpe": 0.8, "deflatedSharpe": 0.95, "maxDrawdown": -0.2}
    assert study.verdict(good, {"sharpe": 0.4})[0] == "PASS"
    assert study.verdict(good, {"sharpe": 0.9})[0] == "FAIL"
    assert study.verdict({**good, "maxDrawdown": -0.25}, {"sharpe": 0.4})[0] == "FAIL"
    assert study.verdict({**good, "deflatedSharpe": 0.9}, {"sharpe": 0.4})[0] == "FAIL"
    assert study.verdict({**good, "sharpe": 0.5}, {"sharpe": 0.4})[0] == "FAIL"
    assert study.verdict({**good, "sharpe": None}, {"sharpe": 0.4})[0] == "FAIL"


def _result(dates, equity):
    return LedgerResult(tuple(dates), tuple(equity), (0,) * len(dates), (), ())


def test_equity_points_are_month_ends_and_capped():
    dates, equity = [], []
    for k in range(450):
        year, month = 1990 + k // 12, k % 12 + 1
        dates += [f"{year}-{month:02d}-02", f"{year}-{month:02d}-27"]
        equity += [100.0 + k, 100.5 + k]
    points = study.equity_points(_result(dates, equity))
    assert len(points) == 400
    assert points[0] == {"t": "1990-01", "v": 100.5}
    assert points[-1] == {"t": "2027-06", "v": 549.5}
    assert all(a["t"] < b["t"] for a, b in itertools.pairwise(points))
    small = study.equity_points(_result(dates[:6], equity[:6]))
    assert [p["t"] for p in small] == ["1990-01", "1990-02", "1990-03"]


def test_window_stats_start_from_the_previous_close():
    dates = trading_days("2024-01-02", 6)
    result = _result(dates, [100.0, 110.0, 99.0, 99.0, 108.9, 108.9])
    stats = study.window_stats(result, dates[2])
    assert stats["start"] == dates[2]
    assert stats["totalReturn"] == pytest.approx(108.9 / 110 - 1)
    assert stats["maxDrawdown"] == pytest.approx(-0.1)
    assert study.window_stats(result, dates[5]) is None


def test_vix_percentile_and_quintile_edges():
    history = [10.0, 20.0, 20.0, 30.0, 40.0]
    assert study.vix_percentile(history, 20.0) == 20.0  # ties are not below
    assert study.vix_percentile(history, 50.0) == 100.0
    assert [study.quintile_of(p) for p in (0, 19.99, 20, 39.99, 40, 60, 80, 100)] == [1, 1, 2, 2, 3, 4, 5, 5]


def test_quintile_table_and_welch_t():
    table = study.quintile_table({1: [0.01, 0.03], 5: [0.02, 0.04, 0.06]})
    assert table["rows"][1]["n"] == 2 and table["rows"][3]["n"] == 0
    assert table["rows"][5]["mean"] == pytest.approx(0.04)
    assert table["q5MinusQ1"] == pytest.approx(0.02)
    se = math.sqrt(0.0004 / 3 + 0.0002 / 2)
    assert table["welchT"] == pytest.approx(0.02 / se)
    assert study.welch_t([0.1], [0.2, 0.3]) is None


def test_run_entry_matches_the_study_schema_fields():
    dates = trading_days("2024-01-02", 45)
    result = run_ledger([], dates=dates)
    run = qi.RunSpec("k", "name", (qi.Leg("SPY", qi.definition("x", qi.MONTHLY_CALL), "roll", dates[0]),), dates[0])
    outcome = study.Outcome(run, result, 2, {"SPY": 0}, None)
    stats = {"cagr": 0.0, "sharpe": None, "deflatedSharpe": None, "maxDrawdown": 0.0, "worstMonth": "2024-01",
             "worstMonthReturn": 0.0, "trades": 0, "winRate": None, "exposure": 0.0, "skipped": 2}
    entry = study.run_entry("A", outcome, stats)
    assert set(entry) == {"name", "symbols", "cagr", "sharpe", "deflatedSharpe", "maxDrawdown", "worstMonth",
                          "trades", "winRate", "exposure", "skipped"}
    assert entry["worstMonth"] == {"month": "2024-01", "ret": 0.0}
    assert entry["name"] == "A: name" and entry["symbols"] == ["SPY"]


def _stats(sharpe, deflated, drawdown):
    return {"cagr": 0.01, "sharpe": sharpe, "deflatedSharpe": deflated, "maxDrawdown": drawdown,
            "worstMonth": None, "worstMonthReturn": None, "trades": 0, "winRate": None, "exposure": 0.0,
            "skipped": 0, "maxOpenRisk": 0.0, "staleIvExits": 0}


def _qc_verdict(doc):
    """packages/api qcPortVerdict, the check the importer runs."""
    primary, baseline = doc["runs"][0], doc["runs"][1]
    c = doc["criteria"]
    ok = (primary["sharpe"] is not None and primary["sharpe"] > c["minSharpe"]
          and primary["deflatedSharpe"] is not None and primary["deflatedSharpe"] > c["minDeflatedSharpe"]
          and abs(primary["maxDrawdown"]) < c["maxDrawdown"]
          and (not c["beatBaseline"] or baseline["sharpe"] is None or primary["sharpe"] > baseline["sharpe"]))
    return "PASS" if ok else "FAIL"


@pytest.mark.parametrize("a, b, expected", [
    ((0.8, 0.95, -0.1), (0.3, 0.1, -0.2), "PASS"),
    ((0.8, 0.95, -0.1), (0.9, 0.1, -0.2), "FAIL"),
    ((0.8, 0.95, -0.25), (0.3, 0.1, -0.2), "FAIL"),
    ((0.8, 0.9, -0.1), (None, None, 0.0), "FAIL"),
    ((0.8, 0.95, -0.1), (None, None, 0.0), "PASS"),
])
def test_document_criteria_provenance_and_verdict(a, b, expected):
    data = _data([100.0] * 45)
    data = study.StudyData(data.spy_dates, data.bars, data.markets, {}, None, {}, "f" * 64)
    run = qi.RunSpec("k", "name", (qi.Leg("SPY", qi.definition("x", qi.MONTHLY_CALL), "roll", data.spy_dates[0]),),
                     data.spy_dates[0])
    outcome = study.Outcome(run, run_ledger([], dates=data.spy_dates), 0, {"SPY": 0}, None)
    idea = qi.Idea("qc-test-idea", "Test", (("A", "a"), ("B", "b"), ("A-L", "c")))
    metrics = {"a": _stats(*a), "b": _stats(*b), "c": _stats(1.0, 1.0, 0.0)}
    outcomes = {"a": outcome, "b": outcome, "c": outcome}
    doc = study.document(idea, outcomes, metrics, 0.0002, "2026-11-08", data, False, "a" * 40)
    assert doc["verdict"] == expected == _qc_verdict(doc)
    assert doc["criteria"] == {"minSharpe": 0.5, "minDeflatedSharpe": 0.9, "maxDrawdown": 0.25, "beatBaseline": True}
    assert doc["provenance"] == {"codeRevision": "a" * 40, "dataSha256": "f" * 64,
                                 "engine": "qc-ports ledger (reference, no Nautilus parity run)",
                                 "runId": "qc-ports-2026-11-08-aaaaaaaaaaaa"}
    assert [run["name"][:2] for run in doc["runs"]] == ["A:", "B:", "A-"]
    swapped = qi.Idea("qc-test-idea", "Test", (("A", "a"), ("A-L", "c"), ("B", "b")))
    with pytest.raises(ValueError, match="runs\\[0\\]"):
        study.document(swapped, outcomes, metrics, 0.0002, "2026-11-08", data, False, "a" * 40)


def test_every_idea_lists_a_then_b():
    assert all([label for label, _ in idea.runs[:2]] == ["A", "B"] for idea in qi.IDEAS)
