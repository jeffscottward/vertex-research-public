"""Triple RSI study (docs/specs/strategies/triple-rsi.md): rules, fills, share ledger, DSL definition, options
stance and measures. Hand-computed cases; no data files, no NautilusTrader (test_triple_rsi_nautilus.py)."""
import math
from unittest import mock

import pytest

from strategies.qc_ports.data import Bars
from strategies.triple_rsi import document, dsl, metrics, options_form, rules, shares
from strategies.triple_rsi.rules import Params, SignalTrade

NAN = float("nan")


# --------------------------------------------------------------------------- indicators

def test_cutler_rsi_by_hand():
    # changes +1 +1 -1 0 +2; length 2: (1,1)/(0,0) -> 100; (1,0)/(0,1) -> 50; (0,0)/(1,0) -> 0; (0,2)/(0,0) -> 100
    out = rules.cutler_rsi([1, 2, 3, 2, 2, 4], 2)
    assert math.isnan(out[0]) and math.isnan(out[1])
    assert out[2:] == [100.0, 50.0, 0.0, 100.0]


def test_wilder_rsi_is_the_dsl_rsi_by_hand():
    # length 2: gains 1,1 losses 0,0 -> seed at bar 2: up 1, down 0 -> 100; bar 3 change -1: up 0.5, down 0.5 -> 50
    # bar 4 change -1: up 0.25, down 0.75 -> 100 - 100 / (1 + 1/3) = 25
    out = rules.rsi([1, 2, 3, 2, 1], 2, "wilder")
    assert math.isnan(out[1])
    assert out[2:] == pytest.approx([100.0, 50.0, 25.0])


def test_sma_includes_today():
    assert rules.sma([1, 2, 3, 4], 2)[1:] == [1.5, 2.5, 3.5]


def test_params_refuse_unknown_rsi_kind():
    with pytest.raises(ValueError):
        Params(rsi_kind="ema")
    assert rules.STATED.key() == "wilder-rsi5-in30-out50-sma200"


# --------------------------------------------------------------------------- signal bars

def _bars_with(strength, trend, close):
    with mock.patch.object(rules, "rsi", return_value=list(strength)), \
            mock.patch.object(rules, "sma", return_value=list(trend)):
        return rules.signal_bars(close, Params())


def test_entry_needs_every_condition():
    #            t0   t1   t2   t3   t4   t5   t6   t7
    strength = [NAN, 55., 45., 35., 25., 20., 60., 40.]
    close = [10.0] * 8
    trend = [9.0] * 8
    entries, exits = _bars_with(strength, trend, close)
    # t4: 25 < 30, 25 < 35 < 45 < 55, RSI(t-3) = 55 < 60, close above the average.
    # t5: 20 < 30, 20 < 25 < 35 < 45, RSI(t-3) = 45 < 60.
    assert [i for i, value in enumerate(entries) if value] == [4, 5]
    # t6: 60 > 50 and 20 before: a cross. t1 (55) follows a missing value: also a cross. t7: 40, no.
    assert [i for i, value in enumerate(exits) if value] == [1, 6]


def test_entry_refused_by_each_condition():
    strength = [60., 50., 40., 25.]  # RSI(t-3) = 60 is not below 60
    assert _bars_with(strength, [9.0] * 4, [10.0] * 4)[0] == [False] * 4
    strength = [55., 45., 46., 25.]  # not three falls in a row
    assert _bars_with(strength, [9.0] * 4, [10.0] * 4)[0] == [False] * 4
    strength = [55., 45., 35., 30.]  # 30 is not below 30
    assert _bars_with(strength, [9.0] * 4, [10.0] * 4)[0] == [False] * 4
    strength = [55., 45., 35., 25.]
    assert _bars_with(strength, [10.0] * 4, [10.0] * 4)[0] == [False] * 4  # close not above the average
    assert _bars_with(strength, [NAN] * 4, [10.0] * 4)[0] == [False] * 4  # no average yet
    assert _bars_with(strength, [9.0] * 4, [10.0] * 4)[0] == [False, False, False, True]


def test_signal_trades_one_position():
    entries = [False, True, True, False, False, True, False, True]
    exits = [False, False, True, True, False, False, False, False]
    # entry 1 (entry 2 is ignored while long), exit 2 is the first exit after 1; then entry 5, never closed.
    assert rules.signal_trades(entries, exits) == [SignalTrade(1, 2), SignalTrade(5, None)]
    assert rules.signal_trades(entries, exits, first=3) == [SignalTrade(5, None)]


# --------------------------------------------------------------------------- fills and the share ledger

def test_fills_per_execution():
    trades = [SignalTrade(2, 4), SignalTrade(6, None)]
    assert shares.fills(trades, "close", 7, first=1) == [
        shares.Fill(1, "close", 3, "close", "signal"), shares.Fill(5, "close", 6, "close", "end")]
    assert shares.fills(trades, "nextOpen", 7, first=1) == [
        shares.Fill(2, "open", 4, "open", "signal"), shares.Fill(6, "open", 6, "close", "end")]
    assert shares.fills(trades, "nextClose", 7, first=1) == [shares.Fill(2, "close", 4, "close", "signal")]
    # an entry before the first run bar is not taken; a close entry on the last day is not filled
    assert shares.fills([SignalTrade(0, 2)], "close", 5, first=1) == []
    assert shares.fills([SignalTrade(5, None)], "close", 5, first=1) == []


def test_fills_refuse_overlap():
    prices = shares.Prices("X", ("a", "b", "c"), (1.0, 1.0, 1.0), (1.0, 1.0, 1.0))
    with pytest.raises(ValueError):
        shares.run_ledger(prices, [shares.Fill(0, "close", 1, "close", "signal"),
                                   shares.Fill(1, "close", 2, "close", "signal")])


def _bars(closes, adj=None, opens=None):
    count = len(closes)
    dates = tuple(f"2024-01-{day + 2:02d}" for day in range(count))
    return Bars("X", dates, tuple(opens or closes), tuple(closes), tuple(closes), tuple(closes),
                tuple(adj or closes))


def test_traded_prices_total_return_scales_by_adjusted_close():
    bars = _bars([10.0, 20.0], adj=[5.0, 20.0], opens=[8.0, 18.0])
    total = shares.traded_prices(bars, 0, "total")
    assert total.open == (4.0, 18.0) and total.close == (5.0, 20.0)
    price = shares.traded_prices(bars, 1, "price")
    assert price.dates == (bars.dates[1],) and price.close == (20.0,)


def test_ledger_by_hand():
    prices = shares.Prices("X", ("d0", "d1", "d2", "d3"), (10.0, 10.5, 11.0, 12.0), (10.0, 11.0, 12.0, 11.0))
    cost = 0.001
    result = shares.run_ledger(prices, [shares.Fill(0, "close", 2, "close", "signal")], cost, 100_000.0)
    qty = 9990.008991  # floor((100,000 - 0.01) / (10 x 1.001), 6 decimals)
    entry_fee = round(qty * 10.0 * cost, 2)
    cash = round(100_000.0 - round(qty * 10.0, 2) - entry_fee, 2)
    exit_fee = round(qty * 12.0 * cost, 2)
    end_cash = round(cash + round(qty * 12.0, 2) - exit_fee, 2)
    assert result.equity == pytest.approx((cash + qty * 10.0, cash + qty * 11.0, end_cash, end_cash), abs=1e-9)
    assert result.open_positions == (1, 1, 0, 0)
    [trade] = result.trades
    assert trade["holdDays"] == 2 and trade["exitReason"] == "signal"
    assert trade["pnl"] == pytest.approx(round(end_cash - 100_000.0, 2), abs=0.011)
    paid = round(qty * 10.0, 2) + entry_fee
    assert trade["return"] == pytest.approx((round(qty * 12.0, 2) - exit_fee) / paid - 1)


def test_ledger_next_open_round_trip_same_day():
    prices = shares.Prices("X", ("d0", "d1"), (10.0, 10.0), (10.0, 12.0))
    result = shares.run_ledger(prices, [shares.Fill(1, "open", 1, "close", "end")], 0.0, 1_000.0)
    qty = 99.999  # floor((1,000 - 0.01) / 10, 6 decimals)
    assert result.equity[0] == 1_000.0
    assert result.equity[1] == pytest.approx(round(1_000.0 - round(qty * 10, 2) + round(qty * 12, 2), 2))
    assert result.open_positions == (0, 0)


# --------------------------------------------------------------------------- DSL definition

def test_dsl_definition_states_the_rule():
    definition = dsl.definition()
    conditions = definition["entry"]["all"]
    assert len(conditions) == 6
    assert conditions[0] == {"left": {"type": "indicator", "name": "rsi", "length": 5}, "op": "<",
                             "right": {"type": "const", "value": 30.0}}
    falls = [(c["left"].get("offset", 0), c["right"]["offset"]) for c in conditions[1:4]]
    assert falls == [(0, 1), (1, 2), (2, 3)]
    assert conditions[4]["left"]["offset"] == 3 and conditions[4]["right"]["value"] == 60.0
    assert conditions[5]["right"] == {"type": "indicator", "name": "sma", "length": 200}
    assert definition["exit"]["any"] == [{"left": {"type": "indicator", "name": "rsi", "length": 5},
                                          "op": "crossesAbove", "right": {"type": "const", "value": 50.0}}]
    assert definition["sizing"] == {"mode": "allIn"} and "stopLoss" not in definition


def test_dsl_has_no_cutler_form():
    with pytest.raises(ValueError):
        dsl.definition(Params(rsi_kind="cutler"))


# --------------------------------------------------------------------------- options stance

def test_stance_is_long_from_entry_to_the_bar_before_exit():
    with mock.patch.object(options_form, "signal_bars",
                           return_value=([False, True, False, False, False, True, False],
                                         [False, False, False, True, False, False, False])):
        assert options_form.stance([1.0] * 7) == [0, 1, 1, 0, 0, 1, 1]
        assert options_form.stance([1.0] * 7, signal_close=True) == [1, 1, 0, 0, 1, 1, 0]
        assert options_form.stance([1.0] * 7, first=2) == [0, 0, 0, 0, 0, 1, 1]


def test_options_forms_risk_two_percent():
    assert [variant.structure["maxLossPct"] for variant in options_form.FORMS] == [2, 2, 2, 2]
    assert options_form.CALL_30["structure"] == "callDebitVertical" and options_form.CALL_30["dte"]["target"] == 30
    assert options_form.FORMS[0].key == "call30" and not options_form.FORMS[0].entry_only


# --------------------------------------------------------------------------- measures

def test_trade_stats_by_hand():
    trades = [{"pnl": 30.0, "return": 0.03, "holdDays": 2}, {"pnl": -10.0, "return": -0.01, "holdDays": 4},
              {"pnl": 20.0, "return": 0.02, "holdDays": 3}]
    stats = metrics.trade_stats(trades)
    assert stats["trades"] == 3 and stats["winRate"] == pytest.approx(2 / 3)
    assert stats["profitFactor"] == pytest.approx(5.0)
    assert stats["averageReturn"] == pytest.approx(0.04 / 3)
    assert stats["worstTrade"] == -0.01 and stats["averageHoldDays"] == 3.0
    assert metrics.trade_stats([])["winRate"] is None
    assert metrics.trade_stats([{"pnl": 1.0, "return": 0.1, "holdDays": 1}])["profitFactor"] is None


def test_monte_carlo_returns_bounds():
    winners = metrics.monte_carlo_returns([0.01, 0.02], paths=200)
    assert winners["probabilityOfProfit"] == 1.0 and winners["drawdownP5"] == 0.0
    losers = metrics.monte_carlo_returns([-0.1], paths=10)
    assert losers["probabilityOfProfit"] == 0.0 and losers["worstDrawdown"] == pytest.approx(-0.1)
    assert metrics.monte_carlo_returns([]) is None


def test_fold_bounds_and_walk_forward_pick():
    assert metrics.fold_bounds(10, 5) == [0, 2, 4, 6, 8, 10]
    days = 20
    steady = [1.0 + 0.01 * day for day in range(days)]
    noisy = [1.0 + (0.02 if day % 2 else 0.0) + 0.001 * day for day in range(days)]
    walk = metrics.walk_forward({"steady": steady, "noisy": noisy}, "noisy", folds=4)
    assert [item["pick"] for item in walk["picks"]] == ["steady", "steady", "steady"]
    assert walk["positiveFolds"] == 3 and walk["testedFolds"] == 3
    with pytest.raises(ValueError):
        metrics.walk_forward({"a": [1.0] * 10, "b": [1.0] * 11}, "a")


def test_lower_bar_is_the_owner_bar():
    good = {"sharpe": 0.3, "oosSharpe": 0.01, "monteCarlo": {"probabilityOfProfit": 0.8}, "maxDrawdown": -0.25,
            "trades": 30}
    assert metrics.lower_bar(good)
    assert not metrics.lower_bar({**good, "oosSharpe": 0.0})
    assert not metrics.lower_bar({**good, "trades": 29})
    assert not metrics.lower_bar({**good, "monteCarlo": None})


def test_verdict_mapping():
    results = {"decision": {"passesGate": False, "row": {"symbol": "SPY", "variant": "call30"}},
               "options": [{"symbol": "SPY", "variant": "call30", "stats": {"trades": 90}}]}
    assert document.verdict_of(results) == "no-edge"
    results["options"][0]["stats"]["trades"] = 12
    assert document.verdict_of(results) == "needs-more-data"
    results["decision"]["passesGate"] = True
    assert document.verdict_of(results) == "edge"


# --------------------------------------------------------------------------- review round 1 additions

def test_oos_cagr_by_hand():
    from strategies.qc_ports.ledger import LedgerResult

    dates = tuple(f"2024-01-{day:02d}" for day in range(1, 11))
    equity = tuple(100_000.0 * (1 + 0.01 * day) for day in range(10))
    result = LedgerResult(dates, equity, (0,) * 10, (), (), capital=100_000.0)
    stats = metrics.equity_stats(result, n_trials=1, sharpe_variance=None, carlo=None)
    # The last 40%: split = int(10 * 0.6) = 6, so out of sample runs from the close of day 6 (index 5) to day 10.
    assert stats["oosStart"] == "2024-01-07"
    years = 4 / 365.25  # 2024-01-06 to 2024-01-10
    assert stats["oosCagr"] == pytest.approx((equity[-1] / equity[5]) ** (1 / years) - 1)


def test_walk_forward_fold_returns():
    days = 20
    steady = [1.0 + 0.01 * day for day in range(days)]
    noisy = [1.0 + (0.02 if day % 2 else 0.0) + 0.001 * day for day in range(days)]
    walk = metrics.walk_forward({"steady": steady, "noisy": noisy}, "noisy", folds=4)
    first = walk["picks"][0]
    assert (first["inSampleDays"], first["outOfSampleDays"]) == (5, 5)
    assert first["outOfSampleReturn"] == pytest.approx(steady[9] / steady[4] - 1)
    assert first["fixedReturn"] == pytest.approx(noisy[9] / noisy[4] - 1)


def test_gate_fails_a_strategy_row_without_baseline():
    stats = {"trades": 40, "sharpe": 1.0, "oosSharpe": 1.0, "deflatedSharpe": 0.99, "maxDrawdown": -0.05,
             "monteCarlo": {"probabilityOfProfit": 0.99, "drawdownP5": -0.05}}
    with_baseline = metrics.gate(stats, 0.2)
    assert all(check["pass"] for check in with_baseline)
    without = metrics.gate(stats, None)
    assert [check for check in without if check["check"] == metrics.BASELINE_CHECK] == [
        {"check": metrics.BASELINE_CHECK, "pass": False, "value": None}]


def test_options_book_timing():
    """Book rule: open at the close of the bar after the signal, close at the close of the bar after the exit signal.
    Signal close: open at the signal bar's close, close at the exit bar's close."""
    from strategies.qc_ports import forms as fm
    from tests.qc_ports_synthetic import market

    closes = [400.0 + 0.5 * day for day in range(60)]
    synthetic = market(closes, symbol="SPY", start="2024-01-02")
    bars = Bars("SPY", synthetic.dates, tuple(closes), tuple(closes), tuple(closes), tuple(closes), tuple(closes))
    entries = [index == 10 for index in range(60)]
    exits = [index == 14 for index in range(60)]
    expected = {"call30": (11, 15), "call30-signal-close": (10, 14)}
    for variant in options_form.FORMS:
        if variant.key not in expected:
            continue
        with mock.patch.object(options_form, "signal_bars", return_value=(entries, exits)):
            form = options_form.form_of("SPY", variant)
            book = fm.form_book(form, fm.Inputs({"SPY": bars}, {"SPY": synthetic.iv_index}), {"SPY": synthetic},
                                start=synthetic.dates[0])
        [trade] = book.trades
        assert (trade.entry_index, trade.exit_index) == expected[variant.key], variant.key
        assert trade.exit_reason == "signal"


def _job_result(dates, values, trades=()):
    return {"dates": list(dates), "equity": list(values), "positions": [1] * len(values), "trades": list(trades),
            "capital": 100_000.0, "engine": "nautilus-trader-1.227.0"}


def test_assemble_counts_trials_once_and_decides_on_the_options_row():
    from strategies.triple_rsi import study

    dates = [f"2020-{1 + day // 28:02d}-{1 + day % 28:02d}" for day in range(120)]
    def curve(step, wobble):
        return [100_000.0 * (1 + step * day + wobble * ((day * 7) % 5 - 2)) for day in range(120)]
    trade = {"pnl": 10.0, "return": 0.01, "holdDays": 3}
    loss = {"pnl": -5.0, "return": -0.005, "holdDays": 2}
    shares_runs = []
    for symbol in study.SYMBOLS:
        for execution in rules.EXECUTIONS:
            for cost in study.COSTS.values():
                shares_runs.append({"symbol": symbol, "params": rules.STATED.key(), "execution": execution,
                                    "cost": cost, "basis": "total", "nautilusGap": 0.0,
                                    "engine": "nautilus-trader-1.227.0",
                                    "result": _job_result(dates, curve(0.0004, 0.0005), [trade, loss] * 20)})
    stated_spy = dict(shares_runs[0], execution="close", cost=study.COSTS["base"])  # a duplicate key of the grid
    grid = [{**stated_spy, "params": params.key()} for params in study.grid_params()[:3]]
    grid.append({**stated_spy})
    holds = [{"symbol": symbol, "result": _job_result(dates, curve(0.0003, 0.002))} for symbol in study.SYMBOLS]
    options = []
    for symbol in study.SYMBOLS:
        for variant in options_form.FORMS:
            late = 20 if (symbol, variant.key) == ("SLV", "call60") else 0
            row_trades = [{"pnl": 10.0, "returnOnRisk": 0.1, "id": 1, "entryDate": dates[late + 1],
                           "exitDate": dates[late + 3]}]
            rows = [{**row_trades[0], "return": 0.1, "holdDays": 2}]
            options.append({"symbol": symbol, "variant": variant.key, "baselineDelay": None, "refused": {},
                            "nautilusGap": 0.0, "engine": "nautilus-trader-1.227.0",
                            "result": _job_result(dates[late:], curve(0.00001, 0.001)[late:], row_trades * 30),
                            "tradeRows": rows * 30})
            for delay in (0, 21):
                if symbol == "QQQ":
                    continue  # no baseline: G7 must fail on QQQ
                options.append({"symbol": symbol, "variant": variant.key, "baselineDelay": delay, "refused": {},
                                "nautilusGap": 0.0, "result": _job_result(dates, curve(-0.0001, 0.001))})
    with mock.patch.object(metrics, "MONTE_CARLO_PATHS", 50):
        results = study.assemble(shares_runs, grid, options, holds, {"sameTrades": True})
    # 63 share runs + 3 new grid variants (the 4th grid run repeats a share run) + 28 options rows
    assert results["trials"]["n"] == 63 + 3 + 28
    decision = results["decision"]
    assert decision["row"] == {"symbol": "SPY", "variant": "call30"}
    assert any(check["check"] == metrics.BASELINE_CHECK for check in decision["checks"])
    assert decision["passesGate"] is False  # the options Sharpe is far below 0.5
    slv = next(row for row in results["options"] if (row["symbol"], row["variant"]) == ("SLV", "call60"))
    # SLV call60 starts 20 days after the buy-and-hold run: its buy-and-hold is bought at that close and rescaled.
    assert slv["buyHold"]["start"] == dates[20]
    hold_values = curve(0.0003, 0.002)
    assert slv["buyHold"]["finalEquity"] == pytest.approx(100_000.0 * hold_values[-1] / hold_values[20])
    qqq = next(row for row in results["options"] if (row["symbol"], row["variant"]) == ("QQQ", "call30"))
    assert qqq["baselineSharpe"] is None
    assert [check["pass"] for check in qqq["checks"] if check["check"] == metrics.BASELINE_CHECK] == [False]
    assert qqq["buyHold"]["start"] == dates[0]
    assert len(results["curves"]["statedSpy"]) >= 2
