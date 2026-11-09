"""qc-ports portfolio runner: data views, run legs, policies, selection and the join rule (synthetic)."""
import itertools
import math

import pytest

from strategies.qc_ports import ideas as qi
from strategies.qc_ports import portfolio as pf
from tests.qc_ports_synthetic import VIX_FOR_20, trading_days

IV_OF = {"SPY": "VIX", "QQQ": "VXN"}


def _rows(columns: dict, start: str = "2024-01-02", ivs: dict | None = None) -> dict:
    """Series-store rows: ETF bars (o = h = l = c = adjusted close) and a flat IV index and IRX."""
    size = len(next(iter(columns.values())))
    dates = list(trading_days(start, size))
    rows = {}
    for symbol, closes in columns.items():
        values = [float(c) for c in closes]
        rows[symbol] = {"dates": dates, **{key: list(values) for key in ("open", "high", "low", "close", "adjClose")}}
        iv = (ivs or {}).get(symbol, [VIX_FOR_20] * size)
        rows[IV_OF[symbol]] = {"dates": dates, "close": iv}
    rows["IRX"] = {"dates": dates, "close": [0.0] * size}
    return rows


def _data(closes, **kwargs) -> pf.Dataset:
    return pf.dataset_from_rows(_rows({"SPY": closes}, **kwargs))


def _run(definition, data, start="2024-01-01", **kwargs):
    return pf.run_definition(definition, data, start=start, **kwargs)


def _spans(outcome):
    return [(t.entry_date, t.exit_date, t.exit_reason) for t in outcome.priced]


def test_rows_apply_the_bar_rules_and_add_total_return():
    rows = _rows({"SPY": [100.0, 101.0, 102.0]})
    rows["SPY"]["close"][1] = 0.0  # not a bar (close not above 0) but still a series value
    rows["SPY"]["adjClose"][2] = None
    rows["VIX"]["close"][0] = math.inf
    data = pf.dataset_from_rows(rows)
    assert data.bars["SPY"].dates == (rows["SPY"]["dates"][0],)
    assert data.series["SPY"] == {rows["SPY"]["dates"][0]: 100.0, rows["SPY"]["dates"][1]: 0.0,
                                  rows["SPY"]["dates"][2]: 102.0}
    assert data.series["SPY:TR"] == {rows["SPY"]["dates"][0]: 100.0}
    assert rows["VIX"]["dates"][0] not in data.series["VIX"]
    with pytest.raises(ValueError, match="calendar"):
        pf.dataset_from_rows({"VIX": rows["VIX"]})
    bad = _rows({"SPY": [1.0, 2.0]})
    bad["SPY"]["dates"] = list(reversed(bad["SPY"]["dates"]))
    with pytest.raises(ValueError, match="increasing"):
        pf.dataset_from_rows(bad)
    short = _rows({"SPY": [1.0, 2.0]})
    short["IRX"]["close"] = [0.0]
    with pytest.raises(ValueError, match="length"):
        pf.dataset_from_rows(short)


def test_run_legs_go_leg_by_leg_then_symbol():
    made = qi.definition("two legs", qi.MONTHLY_CALL, book=qi.portfolio(
        ["SPY", "QQQ"], "roll", legs=[qi.leg(qi.MONTHLY_PUT)]))
    legs = pf.run_legs(made)
    assert [(leg.order, leg.symbol, leg.definition["options"]["structure"]) for leg in legs] == [
        (0, "SPY", "callDebitVertical"), (1, "QQQ", "callDebitVertical"),
        (2, "SPY", "putDebitVertical"), (3, "QQQ", "putDebitVertical")]
    assert "portfolio" not in legs[0].definition
    single = pf.run_legs(qi.definition("one", qi.HOST_CALL), "QQQ")
    assert [(leg.symbol, leg.policy, leg.cadence) for leg in single] == [("QQQ", "flat", "daily")]
    with pytest.raises(ValueError, match="run symbol"):
        pf.run_legs(qi.definition("one", qi.HOST_CALL))
    with pytest.raises(ValueError, match="options block"):
        pf.run_legs({"name": "x", "version": 1, "entry": {"all": [qi.ALWAYS]}})


def test_roll_policy_closes_at_each_rebalance():
    data = _data([100.0 + 0.1 * k for k in range(70)])
    made = qi.definition("always", qi.MONTHLY_CALL, book=qi.portfolio(["SPY"], "roll"))
    outcome = _run(made, data, start="2024-01-31")
    assert outcome.signals == {"SPY": 3} and outcome.book_skipped == 0
    assert _spans(outcome) == [("2024-02-01", "2024-03-01", "signal"), ("2024-03-01", "2024-04-01", "signal"),
                               ("2024-04-01", data.calendar[-1], "end")]
    assert outcome.result.dates[0] == "2024-01-31"


def test_run_end_cuts_the_data():
    data = _data([100.0 + 0.1 * k for k in range(70)])
    made = qi.definition("always", qi.MONTHLY_CALL, book=qi.portfolio(["SPY"], "roll"))
    outcome = _run(made, data, start="2024-02-01", end="2024-03-28")
    assert _spans(outcome) == [("2024-03-01", "2024-03-28", "end")]
    assert outcome.result.dates[-1] == "2024-03-28"


def test_monthly_frame_reads_month_end_total_return_closes():
    closes = [100.0] * 25 + [90.0] * 20 + [120.0] * 25  # month-ends: Jan 100, Feb 90, Mar 120
    data = _data(closes)
    up = qi.definition("up", qi.MONTHLY_CALL, entry=[qi.condition(qi.CLOSE, ">", qi.indicator("sma", 2))],
                       book=qi.portfolio(["SPY"], "roll", frame="monthly"))
    outcome = _run(up, data)
    assert outcome.signals == {"SPY": 1}  # Mar: 120 > (90 + 120) / 2; Feb: 90 < 95
    assert outcome.priced[0].entry_date == "2024-04-01"
    with pytest.raises(ValueError, match="frame"):
        pf.leg_signals(dataclass_replace(pf.run_legs(up)[0], frame="weekly"), data)


def dataclass_replace(leg, **changes):
    import dataclasses

    return dataclasses.replace(leg, **changes)


def test_flat_policy_waits_for_the_close_and_uses_dsl_exits():
    closes = [100.0, 101.0, 102.0, 103.0, 104.0, 100.0, 99.0, 98.0, 99.0, 101.0, 103.0, 105.0] + [106.0] * 30
    data = _data(closes)
    sma = qi.indicator("sma", 3)
    made = qi.definition("sma3", qi.HOST_CALL, entry=[qi.condition(qi.CLOSE, ">", sma)],
                         exit=[qi.condition(qi.CLOSE, "<", sma)], book=qi.portfolio(["SPY"], "flat", cadence="daily"))
    outcome = _run(made, data)
    first, second = outcome.priced[:2]
    dates = data.calendar
    # Entry signal at bar 2 (102 > 101), trade at bar 3; exit signal at bar 5 (100 < 102.33), trade at bar 6.
    assert (first.entry_date, first.exit_date, first.exit_reason) == (dates[3], dates[6], "signal")
    # Flat from bar 6; next entry signal at bar 8 (99 > 98.67), trade at bar 9.
    assert second.entry_date == dates[9]
    for earlier, later in itertools.pairwise(outcome.priced):
        assert later.entry_index > earlier.exit_index
    assert outcome.book_skipped == 0


def test_flat_month_end_cadence_keeps_one_open_spread():
    data = _data([100.0] * 120)
    made = qi.definition("put", qi.PUT_CREDIT, book=qi.portfolio(["SPY"], "flat", cadence="monthEnd"))
    outcome = _run(made, data)
    ends = {data.calendar[i] for i in pf.month_end_indices(data.calendar)}
    assert outcome.priced
    for trade in outcome.priced:
        assert data.calendar[trade.entry_index - 1] in ends
    for earlier, later in itertools.pairwise(outcome.priced):
        assert later.entry_index - 1 >= earlier.exit_index
    with pytest.raises(ValueError, match="cadence"):
        leg = dataclass_replace(pf.run_legs(made)[0], cadence="weekly")
        pf.leg_trades(leg, data, "2024-01-01", [True] * 120, [False] * 120)
    with pytest.raises(ValueError, match="policy"):
        leg = dataclass_replace(pf.run_legs(made)[0], policy="hold")
        pf.leg_trades(leg, data, "2024-01-01", [True] * 120, [False] * 120)


def test_turn_of_month_window_trades_days_minus_two_to_plus_three():
    data = _data([100.0] * 60)
    tom = qi.definition("tom", qi.CALENDAR_CALL, filters=[qi.turn_of_month(-3, 2)],
                        book=qi.portfolio(["SPY"], "window"))
    # The Dec/Jan window is cut by the data start (not full) and is not traded.
    assert _spans(_run(tom, data))[:2] == [("2024-01-30", "2024-02-05", "signal"),
                                           ("2024-02-28", "2024-03-05", "signal")]


def test_opex_window_shift_moves_signals_one_bar_earlier():
    data = _data([100.0] * 60)
    opex = [{"type": "calendarWindow", "window": "opexWeek"}]
    literal = _run(qi.definition("opex", qi.CALENDAR_CALL, filters=opex, book=qi.portfolio(["SPY"], "window")),
                   data, start="2024-01-03")
    held = _run(qi.definition("opex", qi.CALENDAR_CALL, filters=opex, book=qi.portfolio(["SPY"], "window", shift=1)),
                data, start="2024-01-03")
    # January 2024 expiry Fri 19th: the week is Jan 16-19 (Monday 15th is a holiday); Fri 12th is before it.
    assert _spans(literal)[0][:2] == ("2024-01-16", "2024-01-22")
    assert _spans(held)[0][:2] == ("2024-01-12", "2024-01-19")


def test_select_keeps_the_top_scores_then_tie_break_then_symbol_order():
    rising = [100.0 + k for k in range(70)]
    flat = [100.0] * 70
    data = pf.dataset_from_rows(_rows({"SPY": flat, "QQQ": rising}))
    score = qi.change(qi.CLOSE, 1)
    top1 = qi.definition("top 1", qi.MONTHLY_CALL, entry=[qi.condition(score, ">", qi.const(-1))],
                         book=qi.portfolio(["SPY", "QQQ"], "roll", frame="monthly",
                                           select={"score": score, "top": 1}))
    outcome = _run(top1, data)
    assert {t.symbol for t in outcome.priced} == {"QQQ"}
    # Equal scores: the tie-break decides, then the portfolio order.
    tied = qi.definition("tie", qi.MONTHLY_CALL, book=qi.portfolio(["SPY", "QQQ"], "roll", select={
        "score": qi.const(1), "tieBreak": qi.series("$tr"), "top": 1}))
    assert {t.symbol for t in _run(tied, data).priced} == {"QQQ"}
    ordered = qi.definition("order", qi.MONTHLY_CALL, book=qi.portfolio(["QQQ", "SPY"], "roll", select={
        "score": qi.const(1), "top": 1}))
    assert {t.symbol for t in _run(ordered, data).priced} == {"QQQ"}
    # A member without a score is not ranked.
    missing = qi.definition("missing", qi.MONTHLY_CALL, book=qi.portfolio(["SPY", "QQQ"], "roll", select={
        "score": qi.change(qi.CLOSE, 1000), "top": 1}))
    assert _run(missing, data).priced == ()


def test_select_ranks_members_by_calendar_month_when_a_month_end_bar_is_missing():
    # QQQ has no bar on 2024-02-29: its February month-end (2024-02-28) still competes with SPY's.
    rows = _rows({"SPY": [100.0] * 70, "QQQ": [100.0 + k for k in range(70)]})
    drop = rows["QQQ"]["dates"].index("2024-02-29")
    rows["QQQ"] = {key: values[:drop] + values[drop + 1:] for key, values in rows["QQQ"].items()}
    data = pf.dataset_from_rows(rows)
    score = qi.change(qi.CLOSE, 1)
    top1 = qi.definition("top 1", qi.MONTHLY_CALL, entry=[qi.condition(score, ">", qi.const(-1))],
                         book=qi.portfolio(["SPY", "QQQ"], "roll", frame="monthly",
                                           select={"score": score, "top": 1}))
    legs, _, selected = pf._signals(top1, data, None)
    chosen = {leg.symbol: selected[leg.order] for leg in legs}
    assert "2024-02-28" in chosen["QQQ"]
    assert not any(day.startswith("2024-02") for day in chosen["SPY"])
    assert {t.symbol for t in _run(top1, data).priced} == {"QQQ"}


def test_trade_ids_follow_entry_date_then_leg_order():
    data = pf.dataset_from_rows(_rows({"SPY": [100.0] * 70, "QQQ": [100.0] * 70}))
    made = qi.definition("two legs", qi.MONTHLY_CALL, book=qi.portfolio(
        ["SPY", "QQQ"], "roll", legs=[qi.leg(qi.MONTHLY_PUT)]))
    outcome = _run(made, data)
    first_day = [t for t in outcome.priced if t.entry_date == outcome.priced[0].entry_date]
    assert [(t.trade_id, t.symbol, t.structure) for t in first_day] == [
        (1, "SPY", "callDebitVertical"), (2, "QQQ", "callDebitVertical"),
        (3, "SPY", "putDebitVertical"), (4, "QQQ", "putDebitVertical")]


def test_members_join_at_their_first_iv_index_value():
    size = 70
    ivs = [None] * 30 + [VIX_FOR_20] * (size - 30)
    data = pf.dataset_from_rows(_rows({"SPY": [100.0] * size}, ivs={"SPY": ivs}))
    made = qi.definition("always", qi.MONTHLY_CALL, book=qi.portfolio(["SPY"], "roll"))
    outcome = _run(made, data)
    assert outcome.priced and min(t.entry_index for t in outcome.priced) > 30
    assert pf.first_signal_dates(made, data) == {"SPY": data.calendar[pf.month_end_indices(data.calendar)[1]]}
    never = pf.dataset_from_rows(_rows({"SPY": [100.0] * size}, ivs={"SPY": [None] * size}))
    assert pf.first_signal_dates(made, never) == {}


def test_first_signal_dates_honour_the_selection():
    data = pf.dataset_from_rows(_rows({"SPY": [100.0] * 70, "QQQ": [100.0 + k for k in range(70)]}))
    made = qi.definition("top 1", qi.MONTHLY_CALL, book=qi.portfolio(
        ["SPY", "QQQ"], "roll", select={"score": qi.series("$tr"), "top": 1}))
    first = pf.first_signal_dates(made, data)
    assert list(first) == ["QQQ"]


def test_market_of_needs_an_iv_index():
    with pytest.raises(ValueError, match="IV index"):
        pf.market_of(_data([100.0] * 5), "XLK")


def test_run_metrics_add_the_book_skips_and_the_open_risk():
    data = _data([100.0 + 0.1 * k for k in range(70)])
    made = qi.definition("always", qi.MONTHLY_CALL, book=qi.portfolio(["SPY"], "roll"))
    outcome = _run(made, data)
    stats = pf.run_metrics(outcome)
    assert stats["trades"] == len(outcome.result.trades)
    assert stats["skipped"] == len(outcome.result.skipped) + outcome.book_skipped
    assert 0 < stats["maxOpenRisk"] <= 0.03
    assert stats["staleIvExits"] == 0
    assert pf.max_open_risk(outcome.result, outcome.priced) == stats["maxOpenRisk"]


def test_window_spans():
    assert pf.window_spans([False, True, True, False, True]) == [(1, 2), (4, 4)]
    assert pf.window_spans([]) == []


def test_month_end_indices_skip_the_open_last_month():
    dates = ["2024-01-30", "2024-01-31", "2024-02-01", "2024-02-29", "2024-03-01"]
    assert pf.month_end_indices(dates) == [1, 3]
