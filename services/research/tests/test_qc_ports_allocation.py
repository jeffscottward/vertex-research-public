"""qc-ports allocation research: owner exit rule, account caps, statistics and weights (synthetic)."""
import dataclasses
import math

import pytest

from strategies.qc_ports import allocation as al
from strategies.qc_ports import ideas as qi
from strategies.qc_ports import portfolio as pf
from strategies.qc_ports.ledger import LedgerResult, run_ledger
from tests.qc_ports_synthetic import VIX_FOR_20, trading_days
from tests.test_qc_ports_ideas import _facts

DAYS = 80


def _data(closes) -> pf.Dataset:
    dates = list(trading_days("2024-01-02", len(closes)))
    values = [float(close) for close in closes]
    rows = {"SPY": {"dates": dates, **{key: list(values) for key in ("open", "high", "low", "close", "adjClose")}},
            "VIX": {"dates": dates, "close": [VIX_FOR_20] * len(closes)},
            "IRX": {"dates": dates, "close": [0.0] * len(closes)}}
    return pf.dataset_from_rows(rows)


def _definition(options=None) -> dict:
    return qi.definition("t", options or qi.PUT_CREDIT, book=qi.portfolio(["SPY"], "flat", cadence="daily"))


def _trade(number: int, symbol: str, entry: str, exit_: str) -> al.PricedTrade:
    return al.PricedTrade(
        trade_id=number, symbol=symbol, structure="callDebitVertical", expiry=exit_, long_strike=100.0,
        short_strike=105.0, width=5.0, entry_index=1, exit_index=2, entry_date=entry, exit_date=exit_,
        entry_price=200.0, exit_price=300.0, entry_fee=2.0, exit_fee=2.0, max_loss=204.0, max_loss_pct=2.0,
        premium=2.0, exit_reason="expiry", marks=((entry, 200.0), (exit_, 300.0)))


def test_hold_options_drops_the_time_exits_only():
    assert al.hold_options(qi.PUT_CREDIT) == {
        key: value for key, value in qi.PUT_CREDIT.items() if key not in ("profitTakePct", "exitDte")}
    assert al.hold_options(qi.MONTHLY_CALL) == qi.MONTHLY_CALL


def test_trade_pnl_is_after_both_costs():
    assert al.trade_pnl(_trade(1, "SPY", "2024-01-02", "2024-01-03")) == 96.0


def test_a_winner_runs_to_expiry_without_profit_take_or_exit_dte():
    data = _data([100 + 0.4 * day for day in range(DAYS)])
    studied = pf.run_definition(_definition(), data, start="2024-01-02").priced
    owner = al.owner_rule_trades(_definition(), data, start="2024-01-02")
    assert studied[0].exit_reason in ("profitTake", "exitDte")
    assert owner[0].exit_reason == "expiry"
    assert owner[0].exit_date == owner[0].expiry
    assert (owner[0].entry_date, owner[0].long_strike, owner[0].short_strike) == (
        studied[0].entry_date, studied[0].long_strike, studied[0].short_strike)
    assert al.trade_pnl(owner[0]) > 0
    assert [trade.trade_id for trade in owner] == list(range(1, len(owner) + 1))


def test_a_winner_at_expiry_pays_the_closing_cost_of_its_legs_in_the_money():
    data = _data([100 + 0.4 * day for day in range(DAYS)])
    options = al.hold_options(qi.MONTHLY_CALL) | {"dte": {"target": 30, "min": 21}}
    made = qi.definition("t", options, book=qi.portfolio(["SPY"], "flat", cadence="daily"))
    held = pf.run_definition(made, data, start="2024-01-02").priced[0]
    owner = al.owner_rule_trades(made, data, start="2024-01-02")[0]
    assert (held.exit_reason, held.exit_fee) == ("expiry", 0.0)
    spot = pf.market_of(data, "SPY").close[held.exit_index]
    assert spot > held.short_strike > held.long_strike  # both call legs in the money
    cap = al.worst_exit_cost("SPY", held.width)
    legs = round(sum(al.om.leg_cost("SPY", spot - strike) for strike in (held.long_strike, held.short_strike)), 2)
    assert owner.exit_fee == min(legs, cap) > 0
    assert al.trade_pnl(owner) == pytest.approx(al.trade_pnl(held) - owner.exit_fee)
    assert owner.exit_fee <= cap  # the max loss of the trade already contains this cap


def test_qc_candidates_pair_every_idea_with_its_baseline_and_add_the_hosts():
    runs = qi.family(_facts())
    items = al.qc_candidates(runs)
    by_slug = {item["slug"]: item for item in items}
    assert len(items) == len(qi.IDEAS) + 2 and len(by_slug) == len(items)
    for idea in qi.IDEAS:
        item = by_slug[idea.id]
        assert (item["key"], item["baseline"], item["study"]) == (idea.key("A"), idea.key("B"), idea.key("A"))
        assert item["definition"] is runs[idea.key("A")].definition and item["start"] == runs[idea.key("A")].start
    # Several ideas list more runs after B (A-L, the gate tables): the baseline is still B.
    assert by_slug["qc-futures-trend-carry"]["baseline"] == "futures-trend-carry/B"
    assert {slug for slug, item in by_slug.items() if item["role"] == "overlay"} == {
        "qc-iv-rank-gate", "qc-vix-term-gate", "qc-regime-put-vrp"}
    hosts = {item["key"]: item for item in items if item["role"] == "host"}
    assert set(hosts) == {"put-credit/B", "iv-rank-gate/B"}
    assert all(item["baseline"] is None and item["sleeve"] == "vol premium" for item in hosts.values())
    # Every gate idea has its own host among the candidates.
    assert {by_slug[slug]["baseline"] for slug in al.OVERLAY_IDEAS} == set(hosts)
    assert set(al.SLEEVES) == {idea.id for idea in qi.IDEAS}


def test_qc_candidates_refuse_an_idea_without_a_baseline_b(monkeypatch):
    runs = qi.family(_facts())
    first = qi.IDEAS[0]
    broken = dataclasses.replace(first, runs=(first.runs[0], ("A-L", first.runs[1][1])))
    monkeypatch.setattr(qi, "IDEAS", (broken, *qi.IDEAS[1:]))
    with pytest.raises(ValueError, match="runs\\[1\\] the baseline B"):
        al.qc_candidates(runs)
    monkeypatch.undo()
    monkeypatch.setattr(al, "HOSTS", {"put-credit/B": "put-credit-host-spy"})
    with pytest.raises(ValueError, match="HOSTS must be the baselines of the gate ideas"):
        al.qc_candidates(runs)


def test_expiry_close_fee_is_zero_when_both_legs_are_worthless_and_never_above_the_cap():
    call = _trade(1, "SPY", "2024-01-02", "2024-01-03")
    assert al.expiry_close_fee(call, 99.0) == 0.0
    one_leg = al.expiry_close_fee(call, 103.0)
    assert one_leg == round(al.om.leg_cost("SPY", 3.0) + al.om.leg_cost("SPY", 0.0), 2)
    assert al.expiry_close_fee(call, 500.0) == al.worst_exit_cost("SPY", call.width)
    put = dataclasses.replace(call, structure="putCreditVertical", long_strike=95.0, short_strike=100.0)
    assert al.expiry_close_fee(put, 101.0) == 0.0
    assert al.expiry_close_fee(put, 98.0) == round(al.om.leg_cost("SPY", 0.0) + al.om.leg_cost("SPY", 2.0), 2)
    # A credit spread at its max loss (both puts in the money) pays for both legs, up to the cap.
    both = round(al.om.leg_cost("SPY", 5.0) + al.om.leg_cost("SPY", 10.0), 2)
    assert al.expiry_close_fee(put, 90.0) == min(both, al.worst_exit_cost("SPY", put.width)) > 0


def test_a_spread_entered_inside_the_cut_window_keeps_its_hold_version():
    data = _data([100 - 0.4 * day for day in range(DAYS)])
    market = pf.market_of(data, "SPY")
    options = {"structure": "putCreditVertical", "dte": {"target": 7, "min": 1}, "shortDelta": 0.25, "widthSigma": 0.5,
               "maxLossPct": 2}
    signal = market.dates.index("2024-01-16")  # enters on Wednesday 01-17, two days before the 01-19 expiry
    held = al.build_book([al.SignalEvent("SPY", signal)], options, {"SPY": market}).trades[0]
    assert (held.entry_date, held.expiry, held.exit_reason) == ("2024-01-17", "2024-01-19", "expiry")
    # The book refuses the second version (exitDte at entry), so the hold version stays, with its closing cost.
    final = al._owner_exit(held, options, market)
    assert (final.exit_date, final.exit_reason) == (held.exit_date, "expiry")
    assert final.exit_fee == al.expiry_close_fee(held, market.close[held.exit_index])


def test_owner_rule_on_a_monthly_roll_of_two_symbols():
    days = 130
    rows = {}
    dates = list(trading_days("2024-01-02", days))
    for symbol, index, drift in (("SPY", "VIX", 0.3), ("QQQ", "VXN", -0.3)):
        values = [100 + drift * day for day in range(days)]
        rows[symbol] = {"dates": dates, **{key: list(values) for key in ("open", "high", "low", "close", "adjClose")}}
        rows[index] = {"dates": dates, "close": [VIX_FOR_20] * days}
    rows["IRX"] = {"dates": dates, "close": [0.0] * days}
    data = pf.dataset_from_rows(rows)
    made = qi.definition("t", qi.MONTHLY_CALL, book=qi.portfolio(["SPY", "QQQ"], "roll"))
    studied = pf.run_definition(made, data, start="2024-01-02").priced
    owner = al.owner_rule_trades(made, data, start="2024-01-02")
    assert [(t.symbol, t.entry_date, t.exit_date, t.exit_reason) for t in owner] == [
        (t.symbol, t.entry_date, t.exit_date, t.exit_reason) for t in studied]  # 60-day spreads roll before the cut
    assert {t.symbol for t in owner} == {"SPY", "QQQ"} and {t.exit_reason for t in owner} <= {"signal", "end"}
    assert [t.trade_id for t in owner] == list(range(1, len(owner) + 1))


def test_gate_checks_pass_fail_and_missing_values():
    good = {"trades": 30, "sharpe": 0.5, "oosSharpe": 0.5, "deflatedSharpe": 0.95, "maxDrawdown": -0.25,
            "monteCarlo": {"probabilityOfProfit": 0.8, "drawdownP5": -0.35}}
    checks = al.gate_checks(good, 0.4)
    assert len(checks) == 8 and all(check["pass"] for check in checks)
    assert [check["check"] for check in al.gate_checks(good, None)] == [check["check"] for check in checks[:7]]
    assert not al.gate_checks(good, 0.5)[-1]["pass"]  # equal to the baseline is not above it
    for key, bad in (("trades", 29), ("sharpe", 0.49), ("oosSharpe", 0.49), ("deflatedSharpe", 0.949),
                     ("maxDrawdown", -0.26)):
        failed = [check for check in al.gate_checks({**good, key: bad}, 0.4) if not check["pass"]]
        assert len(failed) == 1 and failed[0]["value"] == bad
    for carlo in ({"probabilityOfProfit": 0.79, "drawdownP5": -0.35}, {"probabilityOfProfit": 0.8, "drawdownP5": -0.36}):
        assert sum(not check["pass"] for check in al.gate_checks({**good, "monteCarlo": carlo}, 0.4)) == 1
    empty = al.gate_checks({"trades": 0, "sharpe": None, "oosSharpe": None, "deflatedSharpe": None, "maxDrawdown": None,
                            "monteCarlo": None}, 0.1)
    assert not any(check["pass"] for check in empty)
    assert al.gate_checks({**good, "deflatedSharpe": math.nan}, None)[3]["pass"] is False


def test_a_loser_closes_three_days_before_expiry():
    data = _data([100 - 0.4 * day for day in range(DAYS)])
    held = pf.run_definition(_definition(al.hold_options(qi.PUT_CREDIT)), data, start="2024-01-02").priced
    owner = al.owner_rule_trades(_definition(), data, start="2024-01-02")
    first = owner[0]
    assert held[0].exit_reason == "expiry"
    assert first.exit_reason == "ownerLoserCut"
    assert al.trade_pnl(first) < 0
    left = (al.pf.date.fromisoformat(first.expiry) - al.pf.date.fromisoformat(first.exit_date)).days
    assert 0 < left <= al.OWNER_LOSER_EXIT_DTE
    assert first.marks[-1][0] == first.exit_date
    # The slot frees on the hold version's exit: the next trade enters as in the hold run.
    assert [trade.entry_date for trade in owner] == [trade.entry_date for trade in held]


def test_a_signal_exit_before_the_cut_stays():
    closes = [100 + 0.4 * day for day in range(DAYS)]
    exit_rule = [qi.condition({"type": "price", "field": "close"}, ">", qi.const(104))]
    made = qi.definition("t", qi.PUT_CREDIT, exit=exit_rule, book=qi.portfolio(["SPY"], "flat", cadence="daily"))
    owner = al.owner_rule_trades(made, _data(closes), start="2024-01-02")
    assert owner[0].exit_reason == "signal"


def test_owner_exit_refuses_a_trade_it_cannot_price_again():
    data = _data([100 + 0.4 * day for day in range(DAYS)])
    options = al.hold_options(qi.PUT_CREDIT)
    trade = pf.run_definition(_definition(options), data, start="2024-01-02").priced[0]
    moved = dataclasses.replace(trade, long_strike=trade.long_strike + 1)
    with pytest.raises(RuntimeError, match="Could not price SPY"):
        al._owner_exit(moved, options, pf.market_of(data, "SPY"))


def test_combine_sets_the_risk_and_applies_the_caps_in_entry_order():
    books = {
        "a": [_trade(1, "SPY", "2024-01-02", "2024-01-10"), _trade(2, "QQQ", "2024-01-03", "2024-01-10")],
        "b": [_trade(1, "SPY", "2024-01-02", "2024-01-05"), _trade(2, "GLD", "2024-01-04", "2024-01-09"),
              _trade(3, "SPY", "2024-01-10", "2024-01-12")],
        "off": [_trade(1, "IWM", "2024-01-02", "2024-01-03")],
    }
    combined = al.combine(books, {"a": 1.5, "b": 1.0, "off": 0.0}, al.Caps(open_risk_pct=3.0, name_risk_pct=2.0))
    assert [(combined.owner[t.trade_id], t.symbol, t.entry_date, t.max_loss_pct) for t in combined.trades] == [
        ("a", "SPY", "2024-01-02", 1.5), ("a", "QQQ", "2024-01-03", 1.5), ("b", "SPY", "2024-01-10", 1.0)]
    # b SPY 01-02: 1.5 + 1.0 > 2 on the name. b GLD 01-04: 1.5 + 1.5 + 1.0 > 3 open. The 01-10 exits free the risk first.
    assert combined.refused == {"b": {"nameRisk": 1, "openRisk": 1}}
    assert [t.trade_id for t in combined.trades] == [1, 2, 3]


def test_combine_caps_the_number_of_positions_and_checks_the_risk():
    books = {"a": [_trade(1, "SPY", "2024-01-02", "2024-01-10"), _trade(2, "QQQ", "2024-01-02", "2024-01-10")]}
    combined = al.combine(books, {"a": 0.5}, al.Caps(open_risk_pct=10.0, max_positions=1))
    assert len(combined.trades) == 1
    assert combined.refused == {"a": {"maxPositions": 1}}
    for bad in (2.5, -0.1, math.nan):
        with pytest.raises(ValueError, match="risk per position of a"):
            al.combine(books, {"a": bad}, al.Caps(open_risk_pct=10.0))
    assert al.combine(books, {}, al.Caps(open_risk_pct=10.0)).trades == ()


def test_combine_caps_the_open_risk_of_a_sleeve():
    books = {"a": [_trade(1, "SPY", "2024-01-02", "2024-01-10")], "b": [_trade(1, "QQQ", "2024-01-03", "2024-01-10")],
             "c": [_trade(1, "GLD", "2024-01-03", "2024-01-10")]}
    caps = al.Caps(open_risk_pct=10.0, sleeve_of={"a": "trend", "b": "trend", "c": "macro"},
                   sleeve_risk_pct={"trend": 1.5})
    combined = al.combine(books, {"a": 1.0, "b": 1.0, "c": 1.0}, caps)
    assert [combined.owner[t.trade_id] for t in combined.trades] == ["a", "c"]
    assert combined.refused == {"b": {"sleeveRisk": 1}}


def test_combined_trades_run_in_the_ledger_at_their_risk():
    data = _data([100 + 0.4 * day for day in range(DAYS)])
    owner = al.owner_rule_trades(_definition(), data, start="2024-01-02")
    combined = al.combine({"a": owner}, {"a": 1.0}, al.Caps(open_risk_pct=1.0))
    result = run_ledger(combined.trades, 100_000.0, dates=data.calendar)
    first = result.trades[0]
    assert first["contracts"] == math.floor(1000 / owner[0].max_loss)
    assert len(result.trades) == len(owner)


def _result(equity) -> LedgerResult:
    dates = trading_days("2024-01-02", len(equity))
    return LedgerResult(dates, tuple(equity), tuple([0] * len(equity)), (), (), capital=100.0)


def test_returns_and_sharpe():
    assert al.daily_returns([100, 110, 99]) == pytest.approx([0.1, -0.1])
    assert al.sharpe([0.01]) == 0.0
    assert al.sharpe([0.01, 0.01, 0.01]) == 0.0
    assert al.sharpe([0.01, 0.03]) == pytest.approx(0.02 / math.sqrt(0.0002) * math.sqrt(252))


def test_out_of_sample_sharpe_uses_the_days_after_the_split():
    equity = [100, 100, 100, 100, 100, 100, 101, 103, 104, 106]
    day, value = al.out_of_sample_sharpe(_result(equity))
    assert day == trading_days("2024-01-02", 10)[6]
    assert value == pytest.approx(al.sharpe(al.daily_returns(equity[5:])))
    assert al.out_of_sample_sharpe(_result([100, 101, 103]), fraction=0.0)[1] == pytest.approx(
        al.sharpe(al.daily_returns([100, 101, 103])))


def test_window_metrics():
    result = _result([100, 110, 99, 120])
    dates = result.dates
    assert al.window_metrics(result, dates[3], dates[3]) is None
    inside = al.window_metrics(result, dates[1], dates[2])
    assert inside == {"start": dates[1], "end": dates[2], "return": pytest.approx(-0.01),
                      "maxDrawdown": pytest.approx(-0.1), "worstDay": pytest.approx(-0.1)}
    whole = al.window_metrics(result, dates[0], dates[3])
    assert whole["return"] == pytest.approx(0.2)  # the first day counts from the capital


def test_monte_carlo():
    assert al.monte_carlo([], 1000.0) is None
    wins = al.monte_carlo([10.0, 20.0], 1000.0, paths=50)
    assert wins == {"paths": 50, "probabilityOfProfit": 1.0, "drawdownP5": 0.0, "worstDrawdown": 0.0}
    mixed = al.monte_carlo([100.0, -120.0, 40.0], 1000.0, paths=200, seed=7)
    assert mixed == al.monte_carlo([100.0, -120.0, 40.0], 1000.0, paths=200, seed=7)
    assert 0 < mixed["probabilityOfProfit"] < 1
    assert mixed["worstDrawdown"] <= mixed["drawdownP5"] < 0
    assert al.monte_carlo([-600.0, -600.0], 1000.0, paths=5)["worstDrawdown"] == pytest.approx(-1.2)


def test_correlation():
    a = {"d1": 0.01, "d2": -0.02, "d3": 0.03, "d4": 0.0}
    assert al.correlation(a, {day: 2 * value for day, value in a.items()}) == pytest.approx(1.0)
    assert al.correlation(a, {day: -value for day, value in a.items()}) == pytest.approx(-1.0)
    assert al.correlation(a, {"d1": 0.1, "d2": 0.1}) is None
    assert al.correlation(a, dict.fromkeys(a, 0.5)) is None


def test_weights():
    assert al.equal_risk(["a", "b"]) == {"a": 0.5, "b": 0.5}
    assert al.equal_risk([]) == {}
    assert al.inverse_volatility({"a": 0.1, "b": 0.3, "flat": 0.0}) == {
        "a": pytest.approx(0.75), "b": pytest.approx(0.25), "flat": 0.0}
    shares = al.shrunk_sharpe({"a": 0.4, "b": 0.4, "c": -0.3}, {"a": 10.0, "b": 30.0, "c": 20.0})
    assert shares == {"a": pytest.approx(0.4), "b": pytest.approx(0.6), "c": 0.0}
    assert al.shrunk_sharpe({"a": -0.1}, {"a": 5.0}) == {"a": 0.0}
