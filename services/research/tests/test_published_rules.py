"""Rule tests for the carousel strategies rebuilt from published references (hand-made fixtures)."""
from __future__ import annotations

import math

import pytest
from strategies import published_rules as pr
from strategies.published_rules import Bar


def bar(i: int, o: float, h: float, low: float, c: float, div: float = 0.0) -> Bar:
    return Bar(f"2026-01-{i + 1:02d}", o, h, low, c, div)


def flat(closes: list[float]) -> list[Bar]:
    return [bar(i, c, c, c, c) for i, c in enumerate(closes)]


class TestStatistics:
    def test_mean_std_and_sharpe(self):
        assert pr.mean([1.0, 2.0, 3.0]) == 2.0
        assert pr.sample_std([1.0, 2.0, 3.0]) == pytest.approx(1.0)
        assert pr.annual_sharpe([0.01, 0.03]) == pytest.approx(math.sqrt(252) * 0.02 / math.sqrt(2e-4))

    def test_errors_on_short_input(self):
        with pytest.raises(ValueError):
            pr.mean([])
        with pytest.raises(ValueError):
            pr.sample_std([1.0])

    def test_sharpe_is_undefined_without_dispersion(self):
        assert math.isnan(pr.annual_sharpe([0.01]))
        assert math.isnan(pr.annual_sharpe([0.0, 0.0, 0.0]))

    def test_summarize(self):
        trades = [pr.Trade(0, 1, 100, 101, 0.01), pr.Trade(1, -1, 100, 101, -0.01), pr.Trade(2, 1, 1, 1, 0.0)]
        assert pr.summarize(trades) == pr.TradeSummary(3, 0.0, pytest.approx(1 / 3))
        assert pr.summarize([]) == pr.TradeSummary(0, 0.0, 0.0)


class TestCloseToOpen:
    BARS = [bar(0, 100, 101, 99, 100), bar(1, 102, 103, 101, 101), bar(2, 100, 101, 99, 99, div=1.0)]

    def test_splits_overnight_and_intraday(self):
        split = pr.session_split(self.BARS)
        assert split.sessions == 3
        # overnight: 102/100, 100/101; intraday: 100/100, 101/102, 99/100
        assert split.overnight_total == pytest.approx(1.02 * (100 / 101) - 1)
        assert split.intraday_total == pytest.approx(1.0 * (101 / 102) * 0.99 - 1)
        assert split.overnight_mean_bps == pytest.approx((0.02 + (100 / 101 - 1)) / 2 * 1e4)
        assert split.intraday_mean_bps == pytest.approx((0 + (101 / 102 - 1) - 0.01) / 3 * 1e4)

    def test_dividend_goes_to_the_overnight_leg(self):
        split = pr.session_split(self.BARS, include_dividends=True)
        assert split.overnight_total == pytest.approx(1.02 * (101 / 101) - 1)
        assert split.intraday_total == pr.session_split(self.BARS).intraday_total

    def test_needs_two_bars(self):
        with pytest.raises(ValueError):
            pr.session_split(self.BARS[:1])


class TestPairs:
    def series(self) -> tuple[list[float], list[float]]:
        x = [10.0 + 0.1 * (i % 7) for i in range(40)]
        y = [2.0 * a + 0.05 * ((i * 3) % 5 - 2) for i, a in enumerate(x)]
        y[30] += 3.0  # spread far above the training mean: short spread
        y[33] -= 3.0  # far below: long spread
        return y, x

    def test_hedge_ratio_and_training_statistics(self):
        y, x = self.series()
        result = pr.pair_spread_backtest(y, x, train=20)
        hedge = sum(a * b for a, b in zip(y[:20], x[:20], strict=True)) / sum(b * b for b in x[:20])
        spread = [a - hedge * b for a, b in zip(y[:20], x[:20], strict=True)]
        assert result.hedge_ratio == pytest.approx(hedge)
        assert result.spread_mean == pytest.approx(pr.mean(spread))
        assert result.spread_std == pytest.approx(pr.sample_std(spread))

    def test_positions_follow_entry_exit_and_hold(self):
        # x = 1, so the hedge ratio is the training mean (10) and the training sample deviation is 1:
        # z = y - 10. Test z-scores: 2.5 (short), 1.5 (hold), 0.5 (exit), -3 (long), -1.5 (hold), -1 (exit).
        y = [11.5, 9.5, 9.5, 9.5, 12.5, 11.5, 10.5, 7.0, 8.5, 9.0]
        result = pr.pair_spread_backtest(y, [1.0] * 10, train=4)
        assert (result.hedge_ratio, result.spread_mean, result.spread_std) == (10.0, 0.0, 1.0)
        assert result.positions == [None, 0, 0, 0, -1, -1, 0, 1, 1, 0]
        assert result.pnl[5] == pytest.approx(-(11.5 / 12.5 - 1))  # short spread held into day 5
        assert result.pnl[8] == pytest.approx(8.5 / 7.0 - 1)  # long spread held into day 8

    def test_pnl_uses_the_previous_close_position(self):
        y, x = self.series()
        result = pr.pair_spread_backtest(y, x, train=20)
        expected = -1 * ((y[31] / y[30] - 1) - (x[31] / x[30] - 1))
        assert result.pnl[31] == pytest.approx(expected)
        assert result.pnl[0] is None
        assert math.isnan(result.sharpe_train)  # no signal in the training window: flat P&L
        assert math.isfinite(result.sharpe_test)

    def test_no_pnl_before_the_first_signal(self):
        # x = 1, so the hedge ratio is the training mean (10); training z-scores are 1.5, -0.5, -0.5, -0.5.
        y, x = [11.5, 9.5, 9.5, 9.5, 10.0, 10.0], [1.0] * 6
        result = pr.pair_spread_backtest(y, x, train=4)
        assert result.positions == [None, 0, 0, 0, 0, 0]
        assert result.pnl[:3] == [None, None, 0.0]
        assert math.isnan(result.sharpe_test)  # flat test P&L

    def test_bad_settings(self):
        y, x = self.series()
        with pytest.raises(ValueError):
            pr.pair_spread_backtest(y, x[:-1], train=20)
        with pytest.raises(ValueError):
            pr.pair_spread_backtest(y, x, train=40)
        with pytest.raises(ValueError):
            pr.pair_spread_backtest(y, x, train=20, entry_z=1.0, exit_z=1.0)
        with pytest.raises(ValueError):
            pr.pair_spread_backtest([2.0] * 6, [1.0] * 6, train=4)


class TestNr7:
    # Ranges: 5,4,6,3,5,4,2 (day 6 is NR7), 3 (no), 2 (tie with day 6 inside the window: NR7), 9
    RANGES = [5, 4, 6, 3, 5, 4, 2, 3, 2, 9]

    def bars(self) -> list[Bar]:
        return [bar(i, 100, 100 + r / 2, 100 - r / 2, 100) for i, r in enumerate(self.RANGES)]

    def test_signals_need_a_full_window_and_count_ties(self):
        signals = pr.nr7_days(self.bars())
        assert [i for i, s in enumerate(signals) if s] == [6, 8]
        assert pr.nr7_days(self.bars()[:6]) == [False] * 6

    def test_range_expansion_ratio(self):
        bars = self.bars()
        ratios = pr.range_expansion_ratios(bars, pr.nr7_days(bars), window=5)
        assert ratios == [pytest.approx(3 / pr.mean([6, 3, 5, 4, 2])), pytest.approx(9 / pr.mean([5, 4, 2, 3, 2]))]
        assert pr.range_expansion_ratios(bars, [False] * 9 + [True], window=5) == []  # no next day
        assert pr.range_expansion_ratios(flat([1.0] * 3), [True, False, False], window=1) == []  # zero base

    def test_breakout_cases(self):
        setup = bar(0, 100, 101, 99, 100)
        cases = [
            (bar(1, 102, 103, 101, 104), 1, 102, (104 - 102) / 102),  # gap up: long at the open
            (bar(1, 98, 99, 97, 96), -1, 98, -(96 - 98) / 98),  # gap down: short at the open
            (bar(1, 100, 102, 98, 101.5), 1, 101, (101.5 - 101) / 101),  # both levels traded: long first
            (bar(1, 100, 100.5, 98, 98.5), -1, 99, -(98.5 - 99) / 99),  # break of the low
        ]
        for nxt, direction, entry, ret in cases:
            (trade,) = pr.nr7_breakout_trades([setup, nxt], [True, False])
            assert (trade.direction, trade.entry) == (direction, entry)
            assert trade.gross_return == pytest.approx(ret)

    def test_no_break_and_last_bar(self):
        setup = bar(0, 100, 101, 99, 100)
        assert pr.nr7_breakout_trades([setup, bar(1, 100, 100.5, 99.5, 100)], [True, False]) == []
        assert pr.nr7_breakout_trades([setup], [True]) == []


class TestZScore:
    def test_rolling_zscore(self):
        z = pr.rolling_zscore([1.0, 2.0, 3.0, 3.0, 3.0], window=3)
        assert z[:2] == [None, None]
        assert z[2] == pytest.approx(1.0)
        assert z[4] is None  # zero standard deviation

    def test_first_pierce_only(self):
        closes = [10.0, 10.2, 9.9, 10.1, 10.0, 7.0, 6.0, 10.0, 10.1, 9.9, 10.0, 6.5]
        z = pr.rolling_zscore(closes, window=5)
        entries = pr.lower_band_entries(closes, window=5, k=1.5)
        assert entries == [t for t in range(len(closes)) if z[t] is not None and z[t] < -1.5
                           and not (t > 0 and z[t - 1] is not None and z[t - 1] < -1.5)]
        assert 5 in entries and 6 not in entries

    def test_time_exit(self):
        bars = [bar(i, 100 + i, 101 + i, 99 + i, 100.5 + i) for i in range(6)]
        trades = pr.time_exit_trades(bars, [0, 3, 5], hold=2)
        assert [(t.entry, t.exit) for t in trades] == [(101, 102.5), (104, 105.5)]  # second trade cut at the end
        assert trades[0].gross_return == pytest.approx(1.5 / 101)
