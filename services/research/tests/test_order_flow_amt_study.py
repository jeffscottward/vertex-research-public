"""Order flow / AMT auction study: ledger, split, verdict, forward order-flow check and the run (synthetic)."""
from __future__ import annotations

from datetime import date, timedelta

import pytest

from strategies.imom.data import is_closed, ms_at
from strategies.noise_band import Bar, Session
from strategies.order_flow_amt import rules, study
from strategies.order_flow_amt.data import FlowMinute
from strategies.order_flow_amt.rules import Trade
from strategies.qc_ports.data import Market


def trade(side=1, entry=100.0, exit_=101.0, day="2026-11-10", symbol="SPY", signal_bar=11) -> Trade:
    return Trade(symbol, day, "A", side, signal_bar, signal_bar + 1, 30, entry, exit_, 99.0, 101.0, 1.0, 1.0, "target")


def test_trade_net_charges_commission_and_basis_points_per_side():
    t = trade()
    shares = 1000.0
    assert study.trade_net(t) == pytest.approx(shares * 1.0 - shares * (0.007 + 0.0001 * 201.0))
    assert study.trade_net(t, 2.0) == pytest.approx(shares * 1.0 - 2 * shares * (0.007 + 0.0001 * 201.0))
    assert study.trade_net(trade(side=-1)) < 0


def test_split_is_sixty_twenty_twenty_with_gaps():
    days = [f"d{i:03d}" for i in range(110)]
    split = study.split_days(days)
    assert len(split.train) == 60 and len(split.validation) == 20 and len(split.test) == 20
    assert split.validation[0] == "d065" and split.test[0] == "d090" and split.out_of_sample[-1] == "d109"
    with pytest.raises(ValueError):
        study.split_days(days[:30])


def test_verdict_checks_the_underlying_row_first():
    dsr = {"probability": 0.97}
    assert study.verdict_of("A", 50, 10.0, dsr, 1.0)[0] == "needs-more-data"
    assert study.verdict_of("A", 150, -10.0, dsr, 1.0, option_trades=0)[0] == "no-edge"
    assert study.verdict_of("A", 150, 10.0, {"probability": 0.5}, 1.0)[0] == "no-edge"
    verdict, text = study.verdict_of("C", 150, 10.0, {"probability": None}, 1.0)
    assert verdict == "no-edge" and "not computable" in text


def test_verdict_needs_a_positive_option_form_and_a_confirmed_replay():
    dsr = {"probability": 0.97}
    assert study.verdict_of("A", 150, 10.0, dsr, 1.0)[0] == "edge"
    assert study.verdict_of("A", 150, 10.0, dsr, 1.0, option_trades=10)[0] == "needs-more-data"
    assert study.verdict_of("A", 150, 10.0, dsr, -1.0)[0] == "no-edge"
    assert study.verdict_of("A", 150, 10.0, dsr, None)[0] == "no-edge"
    assert study.verdict_of("A", 150, 10.0, dsr, 1.0, replay_same=False)[0] == "no-edge"
    assert study.verdict_of("A", 150, 10.0, dsr, 1.0, replay_same=None)[0] == "no-edge"


def test_usd_formats_signs():
    assert study.usd(None) == "n/a" and study.usd(-1234.4) == "$-1,234" and study.usd(5.0) == "$5"


def test_flow_at_sums_the_thirty_minutes_before_the_signal_close():
    t = trade(signal_bar=11)  # bar 11 closes at 10:30
    end = int(ms_at(t.day, 630))
    flow = {"SPY": {end - 60_000 * k: FlowMinute("SPY", end - 60_000 * k, 10.0, 100.0, 30) for k in range(1, 31)},
            "ES": {end: FlowMinute("ES", end, -5.0, 10.0, 60)}}
    out = study.flow_at(t, flow)
    assert out["SPY"]["minutes"] == 30 and out["SPY"]["delta"] == 300.0 and out["SPY"]["agrees"] is True
    assert out["SPY"]["coverage"] == pytest.approx(0.5)
    assert out["ES"] == {"minutes": 0, "coverage": 0.0, "delta": 0, "agrees": None}
    assert study.flow_at(trade(symbol="QQQ"), flow) == {}


def test_forward_check_reports_only_sessions_after_the_history():
    trades = {"SPY": {"A": [trade(day="2026-11-05"), trade(day="2026-11-10")], "C": []}}
    out = study.forward_check(trades, {})
    assert out["signals"] == 1 and out["rows"][0]["day"] == "2026-11-10"
    assert out["agreement"] == {"None": 2}


def test_by_time_of_day_groups_by_signal_hour():
    rows = study.by_time_of_day([trade(signal_bar=0), trade(signal_bar=6), trade(signal_bar=11, exit_=99.0)])
    assert [r["hour"] for r in rows] == ["09:00", "10:00"]
    assert rows[1]["trades"] == 2 and rows[1]["winRate"] == 0.5


# --- the run on synthetic sessions ---------------------------------------------------------------------------------

def _bars(day_index: int) -> tuple[Bar, ...]:
    """Odd days: a probe below yesterday's value, then a return inside (rule A long)."""
    out = []
    for k in range(rules.FULL_BARS):
        base = 100.0
        if day_index % 2 and k == 3:
            o, h, low, c = base, base, base - 3.0, base - 2.5
        elif day_index % 2 and 3 < k < 30:
            o = h = low = c = base - 0.2 + 0.02 * (k - 3)
        else:
            o, h, low, c = base, base + 0.5, base - 0.5, base
        out.append(Bar(5 * k, o, max(h, o, c), min(low, o, c), c, 1000.0))
    return tuple(out)


def _sessions(n: int) -> list[Session]:
    out, d = [], date(2023, 1, 3)
    while len(out) < n:
        if d.weekday() < 5 and not is_closed(d):
            out.append(Session(d, _bars(len(out))))
        d += timedelta(days=1)
    return out


def _market(symbol: str, sessions) -> Market:
    days = tuple(s.day.isoformat() for s in sessions)
    return Market(symbol, days, tuple(100.0 for _ in days), tuple(18.0 for _ in days), tuple(0.04 for _ in days))


def test_run_builds_rows_verdicts_and_the_forward_check():
    sessions = {"SPY": _sessions(80), "QQQ": _sessions(80)}
    markets = {s: _market(s, sessions[s]) for s in sessions}
    out = study.run(sessions, markets, {}, nautilus=False)
    assert out["schema"] == study.SCHEMA and out["trials"] == 4
    assert set(out["rows"]) == set(study.ROWS)
    assert out["rows"]["U-A"]["base"]["whole"]["trades"] > 0
    assert out["rows"]["0DTE-A"]["priced"] > 0 and out["rows"]["weekly-A"]["priced"] > 0
    assert out["rows"]["0DTE-A"]["stressOutOfSampleNetUsd"] <= out["rows"]["0DTE-A"]["base"]["outOfSample"]["netUsd"]
    assert out["verdicts"]["A"]["verdict"] == "needs-more-data" and out["verdict"] == "needs-more-data"
    assert set(out["rows"]["U-A"]["bySymbol"]) == {"QQQ", "SPY"}
    assert out["nautilus"] is None and out["forward"]["signals"] == 0
    assert study.run(sessions, markets, None, nautilus=False)["forward"] is None
    assert out["split"]["gap"] == 5


def test_run_skips_ex_dividend_sessions():
    sessions = {"SPY": _sessions(80), "QQQ": _sessions(80)}
    markets = {s: _market(s, sessions[s]) for s in sessions}
    all_days = frozenset(s.day.isoformat() for s in sessions["SPY"])
    out = study.run(sessions, markets, {}, nautilus=False, ex_dates={"SPY": all_days, "QQQ": all_days})
    assert out["rows"]["U-A"]["base"]["whole"]["trades"] == 0


def test_booked_nets_map_records_to_their_spreads_by_id():
    from types import SimpleNamespace

    def spread(day: str, entry_ms: float, market: str) -> SimpleNamespace:
        return SimpleNamespace(day=day, event=SimpleNamespace(entry_ms=entry_ms, market=market))

    spreads = [spread("2025-01-03", 3.0, "SPY"), spread("2025-01-02", 1.0, "SPY"), spread("2025-01-02", 1.0, "QQQ")]
    # booking order: (1.0, QQQ) id 1, (1.0, SPY) id 2, (3.0, SPY) id 3; id 2 was sized to 0 contracts (no record)
    result = SimpleNamespace(trades=[{"id": 3, "pnl": -5.0}, {"id": 1, "pnl": 2.0}])
    assert study.booked_nets(spreads, result) == [("2025-01-03", -5.0), ("2025-01-02", 2.0)]
