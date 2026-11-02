"""Rule tests for moving average market timing (hand-computed fixtures)."""
from __future__ import annotations

import math

import pytest
from strategies import sma_timing as st


class TestSignal:
    def test_total_return_index_compounds(self):
        assert st.total_return_index([0.1, -0.5, 1.0]) == pytest.approx([1.1, 0.55, 1.1])

    def test_states_start_in_and_follow_close_versus_average(self):
        # window 3; averages from day 2: (1+2+3)/3=2, (2+3+1)/3=2, (3+1+1)/3=1.67, (1+1+4)/3=2
        assert st.sma_states([1, 2, 3, 1, 1, 4], 3) == [1, 1, 1, 0, 0, 1]

    def test_an_exact_tie_keeps_the_previous_state(self):
        # day 2: 1 < 1.33 -> out; day 3: average (1+1+1)/3 = 1 equals the close -> stays out
        assert st.sma_states([2, 1, 1, 1], 3) == [1, 1, 0, 0]
        assert st.sma_states([2, 2, 2], 3) == [1, 1, 1]

    def test_window_must_be_positive(self):
        with pytest.raises(ValueError):
            st.sma_states([1.0], 0)

    def test_positions_shift_by_the_lag_and_start_invested(self):
        assert st.positions([0, 1, 0], 0) == [0, 1, 0]
        assert st.positions([0, 1, 0], 1) == [1, 0, 1]
        assert st.positions([0, 1, 0], 2) == [1, 1, 0]
        assert st.positions([0], 3) == [1]
        assert st.positions([0, 0], 3) == [1, 1]
        assert st.positions([0, 0, 0], 4) == [1, 1, 1]
        with pytest.raises(ValueError):
            st.positions([1], -1)


class TestReturns:
    def test_cash_when_out_and_cost_on_each_switch(self):
        returns, trades = st.strategy_returns([0.02, 0.03, -0.05], [0.001, 0.001, 0.001], [1, 0, 1], cost=0.01)
        assert trades == 2
        assert returns == pytest.approx([0.02, 1.001 * 0.99 - 1, 0.95 * 0.99 - 1])

    def test_previous_position_counts_a_switch_on_day_zero(self):
        _, trades = st.strategy_returns([0.0], [0.0], [0], cost=0.0, previous=1)
        assert trades == 1
        _, trades = st.strategy_returns([0.0], [0.0], [0], cost=0.0, previous=0)
        assert trades == 0

    def test_lengths_must_match(self):
        with pytest.raises(ValueError):
            st.strategy_returns([0.0], [0.0, 0.0], [1], cost=0.0)
        with pytest.raises(ValueError):
            st.next_open_returns([0.0], [0.0], [0.0], [1, 1], cost=0.0)

    def test_next_open_splits_the_switch_day(self):
        # day 0: in -> in; day 1: exit at the open (overnight 1% kept, cash 0.1% for the day);
        # day 2: enter at the open (overnight -2% missed, intraday +3% earned)
        overnight, intraday, cash = [0.01, 0.01, -0.02], [0.02, -0.04, 0.03], [0.001, 0.001, 0.001]
        returns, trades = st.next_open_returns(overnight, intraday, cash, [1, 0, 1], cost=0.0)
        assert trades == 2
        assert returns == pytest.approx([1.01 * 1.02 - 1, 1.01 * 1.001 - 1, 0.03])

    def test_next_open_costs_and_staying_out(self):
        # out -> out earns only cash (no overnight market leg); the entry day pays the cost
        overnight, intraday, cash = [0.05, -0.02], [0.01, 0.03], [0.001, 0.001]
        returns, trades = st.next_open_returns(overnight, intraday, cash, [0, 1], cost=0.01, previous=0)
        assert trades == 1
        assert returns == pytest.approx([0.001, 1.03 * 0.99 - 1])

    def test_max_drawdown(self):
        assert st.max_drawdown([0.1, -0.5, 0.2, -0.1]) == pytest.approx(-0.5)
        assert st.max_drawdown([0.1, 0.1]) == 0.0


class TestStats:
    def test_stats_values(self):
        returns, cash = [0.01, 0.03], [0.0, 0.0]
        s = st.stats(returns, cash, trades=1, held=[1, 0], per_year=2)
        assert s.final_wealth == pytest.approx(1.01 * 1.03)
        assert s.cagr == pytest.approx(1.01 * 1.03 - 1)  # two days at two days per year = one year
        assert s.volatility == pytest.approx(math.sqrt(2e-4) * math.sqrt(2))
        assert s.sharpe == pytest.approx(0.02 / math.sqrt(2e-4) * math.sqrt(2))
        assert (s.trades, s.fraction_out, s.max_drawdown) == (1, 0.5, 0.0)

    def test_constant_excess_has_zero_sharpe(self):
        assert st.stats([0.001, 0.001], [0.001, 0.001]).sharpe == 0.0

    def test_stats_rejects_bad_input(self):
        with pytest.raises(ValueError):
            st.stats([], [])


class TestRun:
    def test_run_matches_a_hand_simulation(self):
        # levels: 1.1, 0.99, 1.089, 1.1979 (window 2 averages from day 1: 1.045, 1.0395, 1.14345)
        # states at the close: 1, 0, 1, 1; lag 1 positions: 1, 1, 0, 1
        asset, cash = [0.1, -0.1, 0.1, 0.1], [0.0] * 4
        timed, held = st.run(asset, cash, window=2, lag=1, cost=0.0)
        assert timed.final_wealth == pytest.approx(1.1 * 0.9 * 1.0 * 1.1)
        assert timed.trades == 2
        assert timed.fraction_out == 0.25
        assert held.final_wealth == pytest.approx(1.1 * 0.9 * 1.1 * 1.1)

    def test_lag_zero_uses_the_same_close_and_looks_ahead(self):
        asset, cash = [0.1, -0.1, 0.1, 0.1], [0.0] * 4
        timed, _ = st.run(asset, cash, window=2, lag=0, cost=0.0)
        assert timed.final_wealth == pytest.approx(1.1 * 1.0 * 1.1 * 1.1)  # the down day is skipped

    def test_sub_period_keeps_the_real_entry_state(self):
        asset, cash = [0.1, -0.1, 0.1, 0.1], [0.0] * 4
        timed, held = st.run(asset, cash, window=2, lag=1, cost=0.01, start=2)
        # positions on days 2..3 are 0, 1; the position before day 2 was 1, so both days switch
        assert timed.trades == 2
        assert timed.final_wealth == pytest.approx(0.99 * (1.1 * 0.99))
        assert held.final_wealth == pytest.approx(1.1 * 1.1)
