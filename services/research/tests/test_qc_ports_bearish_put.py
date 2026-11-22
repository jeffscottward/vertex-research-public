"""Bearish put-spread definitions (strategies/qc_ports/bearish_put.py): equal to the spec JSON, and on a
synthetic QQQ history they trade a put debit vertical one session after the SMA20-proxy signal, the breadth
filter removes a heavy down-volume day, and the baseline enters on every bar."""
from __future__ import annotations

import dataclasses
import json
import math
import re
from pathlib import Path

import pytest

from strategies.qc_ports import bearish_put as bp
from strategies.qc_ports import bearish_put_study as bs
from strategies.qc_ports import options as om
from strategies.qc_ports import portfolio as pf
from tests.qc_ports_synthetic import trading_days

SPEC = Path(__file__).resolve().parents[3] / "docs" / "specs" / "strategies" / "bearish-put-spread.md"
SIZE = 300  # the exit signal reads a 200-day SMA
SIGNAL = 230  # index of the signal bar


def _spec_definitions() -> dict[str, dict]:
    text = SPEC.read_text(encoding="utf-8")
    return {name: json.loads(body) for name, body in re.findall(r"### (\w+)\n.*?```json\n(.*?)\n```", text, re.S)}


def _rows(up_pct_on_signal: float, signal: int = SIGNAL) -> dict:
    """QQQ falls 0.2 a session from 200, so the close stays below its 200-day SMA and 1.4% below the SMA20 of
    the sessions before it; only on the signal bar does the high reach that SMA20."""
    dates = list(trading_days("2024-01-02", SIZE))
    close = [200.0 - 0.2 * index for index in range(SIZE)]
    high = list(close)
    high[signal] = close[signal] + 5.0
    up_pct = [55.0] * SIZE
    up_pct[signal] = up_pct_on_signal
    flat = {"dates": dates, **{key: [100.0] * SIZE for key in ("open", "high", "low", "close", "adjClose")}}
    qqq = {"dates": dates, "open": list(close), "high": high, "low": list(close), "close": close,
           "adjClose": list(close)}
    return {
        "SPY": flat, "QQQ": qqq,
        "VXN": {"dates": dates, "close": [25.0] * SIZE},
        "IRX": {"dates": dates, "close": [4.0] * SIZE},
        "NYSE_UPVOL_PCT": {"dates": dates, "close": up_pct},
    }


def _run(definition: dict, rows: dict) -> pf.RunOutcome:
    return pf.run_definition(definition, pf.dataset_from_rows(rows), start="2024-01-02", symbol="QQQ")


def test_the_spec_holds_every_definition_exactly() -> None:
    assert _spec_definitions() == bp.DEFINITIONS
    assert set(bp.DEFINITIONS) == {"RULE_EXIT3", "RULE_EXPIRY", "PROXY_EXIT3", "BASELINE"}


def test_definitions_share_the_options_block_and_exit() -> None:
    for made in bp.DEFINITIONS.values():
        assert {**made["options"], "exitDte": 3} == {**bp.BEAR_PUT, "exitDte": 3}
        assert made["exit"] == {"any": list(bp.EXIT)}
    assert "exitDte" not in bp.RULE_EXPIRY["options"]
    assert bp.RULE_EXIT3["filters"] == [{"type": "series", "series": "NYSE_UPVOL_PCT", "condition": {
        "left": {"type": "price", "field": "close"}, "op": ">", "right": {"type": "const", "value": 20}}}]
    assert "filters" not in bp.PROXY_EXIT3
    assert bp.BASELINE["entry"]["all"][0]["op"] == ">"


def test_rule_trades_a_put_debit_vertical_one_session_after_the_signal() -> None:
    rows = _rows(55.0)
    outcome = _run(bp.RULE_EXIT3, rows)
    assert len(outcome.priced) == 1
    trade = outcome.priced[0]
    assert trade.structure == "putDebitVertical"
    assert trade.entry_date == rows["QQQ"]["dates"][SIGNAL + 1]
    assert trade.long_strike > trade.short_strike
    assert trade.exit_reason == "exitDte"
    held = _run(bp.RULE_EXPIRY, rows).priced
    assert [t.entry_date for t in held] == [trade.entry_date]
    assert held[0].exit_reason == "expiry"


def test_breadth_filter_skips_a_heavy_down_volume_day_and_the_proxy_rule_does_not() -> None:
    rows = _rows(13.1)
    assert _run(bp.RULE_EXIT3, rows).priced == ()
    assert len(_run(bp.PROXY_EXIT3, rows).priced) == 1


def test_baseline_enters_on_the_first_bars() -> None:
    priced = _run(bp.BASELINE, _rows(55.0)).priced
    assert len(priced) >= 2
    assert priced[0].entry_date == trading_days("2024-01-02", 2)[1]


# --------------------------------------------------------------------------- event study (bearish_put_study.py)

def _study_window(definition: dict = bp.RULE_EXIT3, oos: int = 260) -> bs.Window:
    dates = trading_days("2024-01-02", SIZE)
    return bs.Window("fixture", definition, dates[200], dates[-1], dates[oos])


def test_owner_exit_closes_only_a_spread_that_lost_value_by_the_exit_dte_close() -> None:
    held = _run(bp.RULE_EXPIRY, _rows(55.0)).priced[0]
    early = _run(bp.RULE_EXIT3, _rows(55.0)).priced[0]
    assert bs.owner_exit(held, dataclasses.replace(early, exit_price=early.entry_price - 1)).exit_reason == "exitDte"
    assert bs.owner_exit(held, dataclasses.replace(early, exit_price=early.entry_price)) is held
    assert bs.owner_exit(held, dataclasses.replace(early, exit_reason="signal")) is held


def test_a_signal_whose_spread_expires_after_the_last_bar_is_incomplete_whatever_its_exit() -> None:
    rows = _rows(55.0, signal=SIZE - 40)
    data = pf.dataset_from_rows(rows)
    [trade] = bs.event_trades(bp.RULE_EXIT3, data, "QQQ", rows["QQQ"]["dates"][0], rows["QQQ"]["dates"][-1])
    assert not trade.complete
    [kept] = bs.event_trades(bp.RULE_EXIT3, pf.dataset_from_rows(_rows(55.0)), "QQQ", rows["QQQ"]["dates"][0],
                             rows["QQQ"]["dates"][-1])
    assert kept.complete


def test_event_trades_price_each_signal_with_the_owner_exit() -> None:
    rows = _rows(55.0)
    data = pf.dataset_from_rows(rows)
    window = _study_window()
    [trade] = bs.event_trades(bp.RULE_EXIT3, data, "QQQ", window.first, window.last)
    assert trade.signal_index == SIGNAL
    assert trade.signal_date == rows["QQQ"]["dates"][SIGNAL]
    assert trade.entry_date == rows["QQQ"]["dates"][SIGNAL + 1]
    assert trade.ror == pytest.approx(trade.pnl / trade.max_loss)
    assert 0 < trade.cost_pct_width < 100
    held = _run(bp.RULE_EXPIRY, rows).priced[0]
    early = _run(bp.RULE_EXIT3, rows).priced[0]
    chosen = bs.owner_exit(held, early)
    assert (trade.exit_date, trade.exit_reason) == (chosen.exit_date, chosen.exit_reason)
    assert trade.pnl == round(chosen.exit_price - chosen.entry_price - chosen.entry_fee - chosen.exit_fee, 2)
    assert bs.event_trades(bp.RULE_EXIT3, data, "QQQ", window.first, rows["QQQ"]["dates"][SIGNAL - 1]) == []
    base = bs.event_trades(bp.BASELINE, data, "QQQ", window.first, window.last)
    assert len(base) > 30


def test_independent_takes_one_spread_at_a_time() -> None:
    data = pf.dataset_from_rows(_rows(55.0))
    window = _study_window()
    base = bs.event_trades(bp.BASELINE, data, "QQQ", window.first, window.last)
    alone = bs.independent(base)
    assert alone[0] == base[0]
    assert all(later.signal_date >= earlier.exit_date for earlier, later in zip(alone, alone[1:]))
    assert len(alone) < len(base)
    assert bs.independent([]) == []


def test_bootstrap_is_seeded_and_needs_both_sides() -> None:
    data = pf.dataset_from_rows(_rows(55.0))
    window = _study_window()
    base = bs.event_trades(bp.BASELINE, data, "QQQ", window.first, window.last)
    rule = base[::3]
    first = base[0].signal_index
    last = base[-1].signal_index
    one = bs.bootstrap_difference(rule, base, first, last, resamples=200)
    assert one == bs.bootstrap_difference(rule, base, first, last, resamples=200)
    assert one[0] <= one[1]
    assert bs.bootstrap_difference([], base, first, last, resamples=50) == (None, None)


def test_summary_of_no_trades() -> None:
    assert bs.summary([]) == {"n": 0, "meanRor": None, "winRate": None, "meanPnl": None, "totalPnl": 0.0,
                              "meanCostPctWidth": None}


def test_study_gives_not_proven_below_the_signal_minimum_and_restores_the_skew(tmp_path) -> None:
    rows = _rows(55.0)
    skew = om.SKEW["QQQ"]
    result = bs.run_study(rows, [_study_window()], resamples=50)
    [window] = result["windows"]
    assert window["rule"]["n"] == 1
    assert window["independent"]["n"] == 1
    assert window["verdict"] == "not proven"
    assert window["baseline"]["n"] > 30
    assert set(result["sensitivity"]) == {"atmIv-4", "atmIv+4", "skew-0.1", "skew+0.1"}
    for case in ("atmIv-4", "atmIv+4", "skew-0.1", "skew+0.1"):
        assert result["sensitivity"][case][0]["rule"] != window["rule"]["meanRor"]
    assert om.SKEW["QQQ"] == skew
    with pytest.raises(RuntimeError), bs.shifted_skew("QQQ", 0.1):
        assert om.SKEW["QQQ"] == pytest.approx(skew + 0.1)
        raise RuntimeError("inside")
    assert om.SKEW["QQQ"] == skew
    assert window["truncated"] == {"rule": 0, "baseline": window["truncated"]["baseline"]}
    assert window["truncated"]["baseline"] > 0
    path = tmp_path / "rows.json"
    path.write_text(json.dumps(rows), encoding="utf-8")
    assert json.loads(bs.main(str(path)))["symbol"] == "QQQ"


def test_verdicts_from_the_pre_registered_gates(monkeypatch) -> None:
    rows = _rows(55.0)
    # Out of sample from bar 220: the signals after about bar 245 are still open on the last bar.
    window = _study_window(bp.BASELINE, oos=220)
    monkeypatch.setattr(bs, "MIN_SIGNALS", 1)
    passed = bs.run_study(rows, [window], resamples=50, sensitivity=False)["windows"][0]
    assert passed["difference"] == 0.0
    assert passed["verdict"] == "no edge shown"
    monkeypatch.setattr(bs, "_difference", lambda rule, base: 0.5 if rule else None)
    monkeypatch.setattr(bs, "bootstrap_difference", lambda *args, **kwargs: (0.1, 0.9))
    assert bs.run_study(rows, [window], resamples=50, sensitivity=False)["windows"][0]["verdict"] == "pass"


def test_iv_shift_moves_the_index_by_points_over_its_atm_factor() -> None:
    rows = {"VXN": {"dates": ["2024-01-02", "2024-01-03"], "close": [20.0, None]}}
    moved = bs.with_iv_shift(rows, "VXN", 4.0)
    assert moved["VXN"]["close"] == [pytest.approx(20.0 + 4.0 / 0.9), None]
    assert rows["VXN"]["close"] == [20.0, None]
    assert bs.with_iv_shift(rows, "VXN", -40.0)["VXN"]["close"][0] == 0.01


def test_monte_carlo_drawdown_of_two_percent_risk_per_trade() -> None:
    def trade(ror: float) -> bs.EventTrade:
        return bs.EventTrade(0, "2024-01-02", "2024-01-03", "2024-02-16", "expiry", 100.0, 95.0, 100.0,
                             ror * 100, 100.0, ror, 25.0)

    assert bs.monte_carlo_drawdown([]) == {"actual": 0.0, "median": 0.0, "p95": 0.0, "risk": 0.02}
    losses = bs.monte_carlo_drawdown([trade(-1.0), trade(-1.0)])
    assert losses["actual"] == pytest.approx(1 - 0.98 * 0.98)
    assert losses["p95"] == pytest.approx(1 - 0.98 * 0.98)
    mixed = bs.monte_carlo_drawdown([trade(-1.0), trade(2.0), trade(-0.5)], resamples=200)
    assert 0 < mixed["median"] <= mixed["p95"] <= 1 - 0.98 ** 3
    assert mixed == bs.monte_carlo_drawdown([trade(-1.0), trade(2.0), trade(-0.5)], resamples=200)


def test_a_spread_open_on_the_last_bar_is_left_out_and_counted() -> None:
    rows = _rows(55.0, signal=SIZE - 5)
    [window] = bs.run_study(rows, [_study_window()], resamples=20, sensitivity=False)["windows"]
    assert window["rule"]["n"] == 0
    assert window["truncated"]["rule"] == 1
    assert window["interval95"] == [None, None]
    assert window["verdict"] == "not proven"
    assert window["trades"] == []
