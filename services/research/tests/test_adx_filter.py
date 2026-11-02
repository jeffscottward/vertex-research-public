"""ADX filter study kernel: engine fills, stops, sleeve returns, filters, metrics and the decision rule."""
from __future__ import annotations

import math

import pytest

from strategies.adx_filter import (
    VARIANTS,
    Bars,
    Metrics,
    Signals,
    Trade,
    adjusted_bars,
    breakout,
    deflated_sharpe,
    emt_daily,
    expected_max_sharpe,
    filter_mask,
    metrics,
    moments,
    rsi2_dip,
    rsi14_dip,
    run_long,
    run_symbol,
    sleeve_returns,
    sma_cross,
    verdict,
)


def bars_from(close, open_=None, high=None, low=None, volume=None) -> Bars:
    n = len(close)
    open_ = open_ or list(close)
    high = high or [max(o, c) for o, c in zip(open_, close, strict=True)]
    low = low or [min(o, c) for o, c in zip(open_, close, strict=True)]
    return Bars(
        tuple(f"d{i:04d}" for i in range(n)), tuple(open_), tuple(high), tuple(low), tuple(close),
        tuple(volume or [1.0] * n),
    )


def test_adjusted_bars_scale_ohlc_and_drop_invalid_rows():
    rows = [
        {"date": "a", "open": "10", "high": "12", "low": "9", "close": "10", "adj_close": "5", "volume": "7"},
        {"date": "b", "open": "10", "high": "9", "low": "11", "close": "10", "adj_close": "5", "volume": "7"},
        {"date": "c", "open": "0", "high": "12", "low": "9", "close": "10", "adj_close": "5", "volume": "7"},
        {"date": "d", "open": "13", "high": "12", "low": "9", "close": "10", "adj_close": "5", "volume": "7"},
    ]
    bars, dropped = adjusted_bars(rows)
    assert bars.dates == ("a",) and bars.open == (5.0,) and bars.high == (6.0,) and bars.low == (4.5,)
    assert bars.close == (5.0,) and bars.volume == (7.0,)
    assert dropped == ["b", "c", "d"]
    empty, none = adjusted_bars([])
    assert empty.close == () and none == []


def test_long_engine_fills_next_open_and_closes_open_position_at_the_end():
    bars = bars_from([10, 11, 12, 13, 14, 15], open_=[10, 10.5, 11.5, 12.5, 13.5, 14.5])
    signals = Signals([False, True, False, False, False, False], [False, False, False, True, False, False])
    trades = run_long(bars, signals, [True] * 6, start=0)
    assert trades == [Trade(1, 2, 11.5, 4, 13.5, "signal")]
    # A later entry stays open and closes at the last close without an exit cost.
    signals = Signals([False, False, False, False, True, True], [False] * 6)
    assert run_long(bars, signals, [True] * 6, 0) == [Trade(1, 5, 14.5, 5, 15, "end", exit_cost=False)]
    # Entries before the window start or blocked by the filter are ignored; a signal on the last bar is not filled.
    signals = Signals([True, True, False, False, False, True], [False] * 6)
    assert run_long(bars, signals, [True, False, True, True, True, True], start=1) == []
    assert run_long(bars_from([]), Signals([], []), [], 0) == []


def test_long_engine_stop_fills_at_stop_or_gap_open():
    signals = Signals([True, False, False, False], [False] * 4, stop_pct=10.0)
    # Entry at 100 on bar 1; stop 90; bar 1 low 89 -> stop at 90 on the entry bar.
    bars = bars_from([100, 95, 95, 95], open_=[100, 100, 95, 95], low=[99, 89, 94, 94], high=[101, 101, 96, 96])
    assert run_long(bars, signals, [True] * 4, 0) == [Trade(1, 1, 100, 1, 90.0, "stop")]
    # Bar 2 gaps below the stop: fill at its open.
    bars = bars_from([100, 98, 80, 80], open_=[100, 100, 85, 80], low=[99, 95, 79, 79], high=[101, 101, 86, 81])
    assert run_long(bars, signals, [True] * 4, 0) == [Trade(1, 1, 100, 2, 85, "stop")]


def test_exit_signal_while_in_position_and_reentry_after_exit():
    bars = bars_from([1, 2, 3, 4, 5, 6, 7])
    signals = Signals([True, False, False, True, False, False, False], [False, False, True, True, False, False, False])
    trades = run_long(bars, signals, [True] * 7, 0)
    assert [(t.entry_index, t.exit_index) for t in trades] == [(1, 3), (4, 6)]


def test_sleeve_returns_long_short_same_day_and_costs():
    bars = bars_from([10, 11, 12, 9])
    long_trade = Trade(1, 1, 10.0, 3, 9.9, "signal")
    returns = sleeve_returns(bars, [long_trade], cost=0.01)
    assert returns[0] == 0
    assert math.isclose(returns[1], 11 / 10 - 1 - 0.01)
    assert math.isclose(returns[2], 12 / 11 - 1)
    assert math.isclose(returns[3], 9.9 / 12 - 1 - 0.01)
    short_same_day = Trade(-1, 2, 12.0, 2, 11.0, "target", exit_cost=False)
    returns = sleeve_returns(bars, [short_same_day], cost=0.01)
    assert math.isclose(returns[2], -(11 / 12 - 1) - 0.01)


def test_filter_masks():
    n = 60
    close = [100 + i + (3 if i % 2 else -3) for i in range(n)]
    bars = bars_from(close, high=[c + 4 for c in close], low=[c - 4 for c in close])
    above, below, falling = (filter_mask(bars, kind) for kind in ("adx_above", "adx_below", "adx_falling"))
    assert filter_mask(bars, "none") == [True] * n
    assert above[:27] == [False] * 27 and below[:27] == [False] * 27 and falling[:32] == [False] * 32
    assert all(not (a and b) for a, b in zip(above, below, strict=True))
    with pytest.raises(ValueError, match="unknown filter"):
        filter_mask(bars, "adx_sideways")


def test_strategy_signals_by_hand():
    # SMA cross needs 50 bars; a falling then rising series crosses once.
    close = [100 - i for i in range(60)] + [40 + 3 * i for i in range(60)]
    signals = sma_cross(bars_from(close))
    crosses = [i for i, flag in enumerate(signals.entry) if flag]
    assert len(crosses) == 1 and signals.exit[crosses[0]] is False and signals.exit[59] is True
    # Breakout: bar 21 closes above the prior 20 highs; bar 22 closes below the prior 10 lows.
    close = [10.0] * 21 + [12.0, 5.0]
    signals = breakout(bars_from(close))
    assert signals.entry[21] and not signals.entry[20] and signals.exit[22] and not signals.exit[21]
    # RSI dips need SMA(200) first; nothing fires before.
    flat = bars_from([50.0 + (i % 3) for i in range(210)])
    assert not any(rsi2_dip(flat).entry[:200]) and not any(rsi14_dip(flat).entry[:200])
    assert rsi14_dip(flat).stop_pct == 8.0


def test_rsi2_dip_fires_on_a_sharp_drop_in_an_uptrend():
    close = [100 + 0.5 * i for i in range(220)] + [205, 200, 195]
    signals = rsi2_dip(bars_from(close))
    assert signals.entry[-1] and not signals.entry[-4]
    assert signals.exit[218] and not signals.exit[-1]


def _emt_setup(short: bool) -> Bars:
    """40 quiet bars, then an exhaustion bar that sweeps the 20-bar extreme on high volume."""
    n = 40
    close = [100.0] * n
    open_ = [100.0] * n
    high = [101.0] * n
    low = [99.0] * n
    volume = [1000.0] * n
    if short:
        open_ += [100.5, 105.0, 100.0]
        high += [106.0, 105.5, 100.5]
        low += [100.0, 99.0, 99.0]
        close += [100.5, 99.5, 99.8]
    else:
        open_ += [99.5, 95.0, 100.0]
        high += [100.0, 101.0, 101.0]
        low += [94.0, 94.5, 99.5]
        close += [99.5, 100.5, 100.2]
    volume += [5000.0, 1000.0, 1000.0]
    return Bars(tuple(f"d{i}" for i in range(len(close))), tuple(open_), tuple(high), tuple(low), tuple(close),
                tuple(volume))


@pytest.mark.parametrize("short", [True, False])
def test_emt_daily_takes_the_setup_and_exits_at_the_mean(short):
    bars = _emt_setup(short)
    trades = emt_daily(bars, [True] * len(bars.close), start=0)
    assert len(trades) == 1
    trade = trades[0]
    assert trade.side == (-1 if short else 1) and trade.entry_index == 41 and trade.reason == "target"
    assert emt_daily(bars, [False] * len(bars.close), start=0) == []
    assert emt_daily(bars, [True] * len(bars.close), start=41) == []


def test_emt_daily_stop_time_and_end_exits():
    bars = _emt_setup(short=True)
    stopped = Bars(bars.dates, bars.open, bars.high[:41] + (107.0, 100.5), bars.low, bars.close, bars.volume)
    assert emt_daily(stopped, [True] * 43, 0)[0].reason == "stop"
    # Never reaching the mean: a time stop after 10 bars, or the end of data.
    tail = 12
    drift = Bars(
        bars.dates[:41] + tuple(f"t{i}" for i in range(tail)),
        bars.open[:41] + (105.0,) * tail,
        bars.high[:41] + (105.5,) * tail,
        bars.low[:41] + (105.1,) * tail,
        bars.close[:41] + (105.2,) * tail,
        bars.volume[:41] + (1000.0,) * tail,
    )
    trades = emt_daily(drift, [True] * len(drift.close), 0)
    assert trades[0].reason == "time" and trades[0].exit_index - 40 == 10
    short_tail = Bars(*(column[:45] for column in (drift.dates, drift.open, drift.high, drift.low, drift.close, drift.volume)))
    end = emt_daily(short_tail, [True] * 45, 0)
    assert end == [Trade(-1, 41, 105.0, 44, 105.2, "end", exit_cost=False)]
    assert emt_daily(bars_from([]), [], 0) == []


def test_emt_rejects_low_reward_and_quiet_bars():
    bars = _emt_setup(short=True)
    weak = Bars(bars.dates, bars.open, bars.high[:40] + (101.5,) + bars.high[41:], bars.low, bars.close, bars.volume)
    assert emt_daily(weak, [True] * 43, 0) == []
    quiet = Bars(bars.dates, bars.open, bars.high, bars.low, bars.close, bars.volume[:40] + (1000.0,) + bars.volume[41:])
    assert emt_daily(quiet, [True] * 43, 0) == []
    far_entry = Bars(bars.dates, bars.open[:41] + (106.5,) + bars.open[42:], bars.high[:41] + (106.6,) + bars.high[42:],
                     bars.low, bars.close, bars.volume)
    assert emt_daily(far_entry, [True] * 43, 0) == []


def test_metrics_and_moments():
    result = metrics([0.1, -0.5, 0.2], trades=3)
    assert math.isclose(result.max_drawdown, 0.5) and result.trades == 3 and result.days == 3
    assert math.isclose(result.cagr, (1.1 * 0.5 * 1.2) ** (252 / 3) - 1)
    mean = (0.1 - 0.5 + 0.2) / 3
    std = math.sqrt(((0.1 - mean) ** 2 + (-0.5 - mean) ** 2 + (0.2 - mean) ** 2) / 2)
    assert math.isclose(result.sharpe, mean / std * math.sqrt(252))
    assert metrics([0.0, 0.0], 0).sharpe is None and metrics([0.01], 1).sharpe is None
    assert metrics([], 0) == Metrics(None, 0.0, 0.0, 0, 0)
    sharpe, skew, kurtosis = moments([1.0, 2.0, 3.0, 10.0])
    assert skew > 0 and kurtosis > 1 and sharpe > 0
    assert moments([0.0, 0.0, 0.0]) is None and moments([1.0]) is None


def test_deflated_sharpe_matches_the_published_example():
    # Same case as packages/api/src/quant-multiple-testing.test.ts: DSR about 0.9004.
    probability = deflated_sharpe(2.5 / math.sqrt(250), 100, 0.5 / 250, 1250, -3, 10)
    assert probability == pytest.approx(0.9004, abs=1e-4)
    assert expected_max_sharpe(1, 1.0) == 0.0
    assert deflated_sharpe(0.1, 2, 0.01, 1, 0, 3) is None
    assert deflated_sharpe(1.0, 2, 0.01, 100, 5, 3) is None


def test_verdict_rule():
    def m(sharpe):
        return Metrics(sharpe, 0.0, 0.0, 0, 1)

    base = [m(0.5), m(0.5)]
    assert verdict(base, [m(0.6), m(0.6)], 40, 20, 0.99).startswith("DROP (trade floor: the unfiltered")
    assert verdict(base, [m(0.6), m(0.6)], 20, 40, 0.99) == "DROP (trade floor)"
    assert verdict(base, [m(0.6), m(0.4)], 40, 40, 0.99) == "DROP (Sharpe not higher in both halves)"
    assert verdict(base, [m(None), m(0.6)], 40, 40, 0.99) == "DROP (Sharpe not higher in both halves)"
    assert verdict([m(None), m(0.5)], [m(0.1), m(0.6)], 40, 40, 0.99) == "KEEP"
    assert verdict(base, [m(0.6), m(0.6)], 40, 40, 0.5) == "KEEP (kept, not significant after deflation)"
    assert verdict(base, [m(0.6), m(0.6)], 40, 40, None) == "KEEP (kept, not significant after deflation)"


def test_variants_and_dispatch():
    assert len(VARIANTS) == 13
    bars = _emt_setup(short=True)
    emt = next(v for v in VARIANTS if v.strategy == "emt_daily" and v.filter == "none")
    assert len(run_symbol(bars, emt, 0)) == 1
    trend = next(v for v in VARIANTS if v.strategy == "breakout_20" and v.filter == "none")
    assert isinstance(run_symbol(bars, trend, 0), list)
