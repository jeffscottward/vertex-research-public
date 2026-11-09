"""Rule tests for the analog and seasonal regime flags (hand-computed fixtures)."""
from __future__ import annotations

import math
from dataclasses import replace
from datetime import date, timedelta

import pytest
from strategies.regime_flags import analog, events, liquidity, seasonal, stretched, study
from strategies.sma_timing import Stats

NAN = math.nan


class TestOutcome:
    def test_forward_return_and_lowest_close_of_the_window(self):
        found = events.outcome([100, 98, 90, 95, 110], 0, horizon=3)
        assert found.fwd == pytest.approx(-0.05)
        assert found.mdd == pytest.approx(-0.10)
        assert found.hit is True

    def test_no_lower_close_gives_zero_drawdown_and_no_hit(self):
        found = events.outcome([100, 101, 102, 103], 0, horizon=3)
        assert (found.fwd, found.mdd, found.hit) == (pytest.approx(0.03), 0.0, False)

    def test_a_fall_equal_to_the_bar_is_a_hit(self):
        assert events.outcome([2.0, 1.0], 0, horizon=1, bar=-0.5).hit is True

    def test_a_window_past_the_last_bar_is_open(self):
        closes = [100, 98, 90, 95, 110]
        assert events.outcome(closes, 1, horizon=3) is not None
        assert events.outcome(closes, 2, horizon=3) is None
        assert [item.index for item in events.outcomes(closes, [0, 1, 2, 3], horizon=3)] == [0, 1]

    def test_group_counts_hits_and_averages(self):
        items = [events.Outcome(0, 0.02, -0.01, False), events.Outcome(1, -0.08, -0.10, True),
                 events.Outcome(2, -0.03, -0.05, True)]
        found = events.group(items)
        assert (found.n, found.hits) == (3, 2)
        assert found.hit_rate == pytest.approx(2 / 3)
        assert found.mean_fwd == pytest.approx(-0.03)
        assert found.median_fwd == pytest.approx(-0.03)
        assert found.mean_mdd == pytest.approx(-0.16 / 3)
        assert found.smallest_drop == pytest.approx(-0.01)
        assert events.group([]) is None


class TestStatistics:
    def test_binomial_tail_is_exact(self):
        assert events.binomial_tail(10, 10, 0.5) == pytest.approx(1 / 1024)
        assert events.binomial_tail(2, 3, 0.5) == pytest.approx(0.5)
        assert events.binomial_tail(0, 5, 0.3) == pytest.approx(1.0)
        assert events.binomial_tail(3, 3, 1.0) == pytest.approx(1.0)

    def test_binomial_tail_rejects_impossible_counts(self):
        with pytest.raises(ValueError):
            events.binomial_tail(4, 3, 0.5)
        with pytest.raises(ValueError):
            events.binomial_tail(1, 3, 1.5)

    def test_spearman_uses_ranks_and_mean_ranks_for_ties(self):
        assert events.spearman([1, 2, 3], [10, 200, 3000]) == pytest.approx(1.0)
        assert events.spearman([1, 2, 3], [3, 2, 1]) == pytest.approx(-1.0)
        # ranks 1.5, 1.5, 3 against 1, 2, 3: 1.5 / sqrt(1.5 * 2)
        assert events.spearman([1, 1, 2], [1, 2, 3]) == pytest.approx(1.5 / math.sqrt(3.0))
        assert events.spearman([1, 1, 1], [1, 2, 3]) == 0.0

    def test_p_values_are_one_sided(self):
        assert events.spearman_p(0.0, 50) == pytest.approx(0.5)
        assert events.spearman_p(0.5, 50) < 0.001
        assert events.spearman_p(-0.5, 50) > 0.999
        assert events.mean_below_p([0.0, 2.0], [10.0, 12.0]) < 1e-6
        assert events.mean_below_p([10.0, 12.0], [0.0, 2.0]) > 1 - 1e-6
        assert events.mean_below_p([1.0, 3.0], [1.0, 3.0]) == pytest.approx(0.5)


class TestStretchedFeatures:
    def test_trailing_return_needs_the_full_lag(self):
        found = stretched.trailing_return([1, 2, 4, 8], lag=2)
        assert all(math.isnan(v) for v in found[:2])
        assert found[2:] == pytest.approx([3.0, 3.0])

    def test_sma_gap_includes_the_day_itself(self):
        found = stretched.sma_gap([1, 2, 3, 6], window=3)
        assert all(math.isnan(v) for v in found[:2])
        assert found[2:] == pytest.approx([3 / 2 - 1, 6 / (11 / 3) - 1])

    def test_realized_vol_is_the_sample_deviation_of_log_returns(self):
        closes = [1.0, math.e, math.e, math.e**3]  # log returns 1, 0, 2
        found = stretched.realized_vol(closes, window=2, per_year=1)
        assert all(math.isnan(v) for v in found[:2])
        assert found[2:] == pytest.approx([math.sqrt(0.5), math.sqrt(2.0)])

    def test_days_since_record_close_counts_an_equal_close_as_a_record(self):
        assert stretched.days_since_high([5, 6, 6, 4, 7]) == [0, 0, 0, 1, 0]

    def test_days_since_window_high_uses_only_the_window(self):
        found = stretched.days_since_high([5, 4, 3, 4, 2, 1], window=3)
        assert all(math.isnan(v) for v in found[:3])  # day 2 is defined only after the first window high
        assert found[3:] == [0, 1, 2]


class TestStretchedSignal:
    def test_signal_needs_every_condition(self):
        found = stretched.Features(run=(0.25, 0.25, 0.10, NAN, 0.25), stretch=(0.12, 0.12, 0.12, 0.12, 0.12),
                                   vol=(0.10, 0.20, 0.10, 0.10, 0.10), since_high=(0.0, 0.0, 0.0, 0.0, 5.0))
        assert stretched.signal_days(found) == [0]  # day 1 not calm, 2 small run, 3 undefined, 4 old high
        assert stretched.near_high_days(found) == [0, 1, 2]

    def test_thresholds_are_inclusive(self):
        found = stretched.Features(run=(0.20,), stretch=(0.10,), vol=(0.15,), since_high=(4.0,))
        assert stretched.signal_days(found) == [0]

    def test_episodes_start_at_least_thirty_days_apart(self):
        assert stretched.episode_starts([3, 4, 10, 32, 33, 40, 63, 64]) == [3, 33, 63]
        assert stretched.episode_starts([]) == []

    def test_grid_has_54_cells_and_contains_the_primary_rule(self):
        assert len(set(stretched.GRID)) == 54
        assert stretched.PRIMARY in stretched.GRID
        assert stretched.PRIMARY == stretched.Definition(run=0.20, stretch=0.10, vol=0.15, high_days=None)


class TestZigzag:
    def test_tops_alternate_with_bottoms(self):
        # 111 confirms the bottom at day 0; 99 <= 0.9 * 111 confirms the top at day 1;
        # 106 >= 1.1 * 95 confirms the bottom at day 3; 107 <= 0.9 * 120 confirms the top at day 5
        closes = [100, 111, 99, 95, 106, 120, 107, 108]
        assert analog.zigzag_tops(closes) == [analog.Top(index=1, confirmed=2), analog.Top(index=5, confirmed=6)]

    def test_first_pivot_can_be_a_top(self):
        assert analog.zigzag_tops([100, 95, 89]) == [analog.Top(index=0, confirmed=2)]

    def test_earliest_day_wins_a_tie_for_the_high(self):
        assert analog.zigzag_tops([100, 100, 89]) == [analog.Top(index=0, confirmed=2)]

    def test_a_smaller_fall_is_no_top(self):
        assert analog.zigzag_tops([100, 95, 91, 100]) == []
        assert analog.zigzag_tops([100, 95, 89], reversal=0.15) == []


class TestAnalog:
    def test_path_is_the_log_close_against_the_last_day(self):
        assert analog.path([1.0, math.e, math.e**2], 2, length=3) == pytest.approx([-2.0, -1.0, 0.0])
        with pytest.raises(ValueError):
            analog.path([1.0, 2.0], 1, length=3)

    def test_distance_is_root_mean_square(self):
        assert analog.distance([0.0, 0.0], [3.0, 4.0]) == pytest.approx(math.sqrt(12.5))

    def test_candidates_need_a_confirmed_top_and_a_known_outcome(self):
        top = analog.Top(index=10, confirmed=15)
        days = lambda t: [day for day, _ in analog.candidates([top], t, length=5, max_offset=2, horizon=30)]
        assert days(42) == [10, 11, 12]
        assert days(41) == [10, 11]  # day 12 + 30 is after day 41
        assert days(39) == []
        late = analog.Top(index=10, confirmed=45)
        assert analog.candidates([late], 44, length=5, max_offset=2, horizon=30) == []

    def test_candidates_need_a_full_path(self):
        early = analog.Top(index=2, confirmed=3)
        found = analog.candidates([early], 60, length=5, max_offset=2, horizon=30)
        assert [day for day, _ in found] == [4]

    def test_nearest_first_and_the_latest_day_wins_a_tie(self):
        flat = [1.0] * 60  # every path is equal
        found = analog.ranked(flat, 50, [analog.Top(index=10, confirmed=12)], length=3, max_offset=2, horizon=30)
        assert [(item.day, item.offset, item.distance) for item in found] == [(12, 2, 0.0), (11, 1, 0.0), (10, 0, 0.0)]

    def test_nearest_is_the_most_similar_path(self):
        closes = [100.0] * 80
        closes[20:23] = [90.0, 100.0, 110.0]  # a rise into day 22
        closes[40:43] = [110.0, 100.0, 90.0]  # a fall into day 42
        closes[77:80] = [91.0, 100.0, 109.0]  # the query: a rise into day 79
        tops = [analog.Top(index=22, confirmed=23), analog.Top(index=42, confirmed=43)]
        found = analog.ranked(closes, 79, tops, length=3, max_offset=0, horizon=30)
        assert [item.day for item in found] == [22, 42]

    def test_sample_days_start_when_enough_tops_have_a_candidate(self):
        tops = [analog.Top(index=5, confirmed=8), analog.Top(index=20, confirmed=22), analog.Top(index=30, confirmed=70)]
        # ready days: max(8, 5 + 30) = 35, max(22, 20 + 30) = 50, max(70, 30 + 30) = 70
        assert analog.sample_days(100, tops, length=3, min_tops=2) == [50, 80]
        assert analog.sample_days(100, tops, length=3, min_tops=3) == [70]
        assert analog.sample_days(100, tops, length=3, min_tops=4) == []

    def test_top_like_ranks_a_day_against_earlier_days_only(self):
        # day 2: one of two earlier days is smaller (not below 50%); day 3: none; day 4: all four
        assert analog.top_like([3.0, 1.0, 2.0, 0.5, 5.0], min_history=2, share=0.5) == [None, None, False, True, False]


WEDNESDAYS = [date(2024, 1, 3) + timedelta(weeks=i) for i in range(6)]


class TestNetLiquidity:
    def test_net_is_assets_less_treasury_account_less_reverse_repo(self):
        walcl = dict(zip(WEDNESDAYS, [1000.0, 1010.0, 1020.0, 1030.0, 1100.0, 900.0], strict=True))
        tga = {day: 100.0 for day in WEDNESDAYS if day != date(2024, 1, 17)}
        rrp = {date(2024, 1, 2): 0.2, date(2024, 1, 31): 0.1}  # USD billions
        weeks, dropped = liquidity.net_liquidity(walcl, tga, rrp)
        # 01-03 takes the value of the day before; 02-07 is seven days after 01-31, so it takes none
        assert [week.net for week in weeks] == pytest.approx([700.0, 910.0, 930.0, 900.0, 800.0])
        assert dropped == [date(2024, 1, 17)]
        assert [week.change for week in weeks[:4]] == [None] * 4
        assert weeks[4].change == pytest.approx(800.0 / 700.0 - 1.0)  # four observations earlier

    def test_drain_is_any_fall_or_a_fall_of_at_least_the_threshold(self):
        week = lambda change: liquidity.Week(day=WEDNESDAYS[0], net=1.0, change=change)
        assert liquidity.drain(week(-0.004)) is True
        assert liquidity.drain(week(0.0)) is False
        assert liquidity.drain(week(-0.004), threshold=-0.005) is False
        assert liquidity.drain(week(-0.005), threshold=-0.005) is True
        assert liquidity.drain(week(None)) is None


# Monday 2024-01-08 to Wednesday 2024-01-17 without the holiday on Monday 2024-01-15
TRADING = [date(2024, 1, d) for d in (8, 9, 10, 11, 12, 16, 17)]


class TestLiquidityStates:
    def test_a_week_is_known_at_the_third_trading_day_after_it(self):
        assert liquidity.known_at(TRADING, date(2024, 1, 10)) == 5  # 11, 12 and 16
        assert liquidity.known_at(TRADING, date(2024, 1, 3)) == 2
        assert liquidity.known_at(TRADING, date(2024, 1, 16)) is None

    def test_state_is_the_flag_of_the_latest_known_week(self):
        weeks = [liquidity.Week(day=date(2023, 12, 27), net=1.0, change=None),
                 liquidity.Week(day=date(2024, 1, 3), net=1.0, change=-0.01),
                 liquidity.Week(day=date(2024, 1, 10), net=1.0, change=0.01)]
        assert liquidity.daily_states(TRADING, weeks) == [None, None, True, True, True, False, False]
        assert liquidity.daily_states(TRADING, weeks, threshold=-0.02) == [None, None, False, False, False, False, False]

    def test_position_follows_the_state_of_the_day_before(self):
        first, held = liquidity.held_positions([None, None, True, True, True, False, False])
        assert (first, held) == (3, [0, 0, 0, 1])
        with pytest.raises(ValueError):
            liquidity.held_positions([None, None, True])

    def test_timing_counts_trades_and_starts_invested(self):
        asset, cash, held = [0.01, 0.02, -0.03, 0.04], [0.001] * 4, [0, 0, 0, 1]
        rule, hold = liquidity.timed(asset, cash, held, cost=0.0)
        assert rule.final_wealth == pytest.approx(1.001**3 * 1.04)
        assert hold.final_wealth == pytest.approx(1.01 * 1.02 * 0.97 * 1.04)
        assert (rule.trades, rule.fraction_out) == (2, 0.75)
        late, _ = liquidity.timed(asset, cash, held, cost=0.01, start=2)
        assert late.trades == 1  # the period starts in cash: only the re-entry is a trade
        assert late.final_wealth == pytest.approx(1.001 * 1.04 * 0.99)


SPARSE = [date(2020, 10, 29), date(2020, 10, 30), date(2020, 11, 2),
          date(2021, 10, 28), date(2021, 10, 29), date(2021, 11, 1)]


def monthly_series(first_year: int, last_year: int, factor) -> tuple[list[date], list[float]]:
    """One bar on day 28 of each month; the level grows by ``factor(year)`` from October to October."""
    days, closes, level = [], [], 100.0
    for year in range(first_year, last_year + 1):
        for month in range(1, 13):
            start_year = year if month > 10 else year - 1  # the October that opened this window
            level *= factor(start_year) ** (1 / 12)
            days.append(date(year, month, 28))
            closes.append(level)
    return days, closes


class TestSeasonal:
    def test_anchor_is_the_last_bar_on_or_before_the_month_end(self):
        assert seasonal.anchor(SPARSE, 2020, 10) == 1  # 2020-10-31 is a Saturday
        assert seasonal.anchor(SPARSE, 2021, 10) == 4

    def test_anchor_needs_a_bar_in_the_month_and_a_later_bar(self):
        assert seasonal.anchor(SPARSE, 2019, 10) is None
        assert seasonal.anchor(SPARSE, 2020, 12) is None  # no bar in that month
        assert seasonal.anchor(SPARSE, 2021, 11) is None  # the month may not be complete

    def test_window_return_and_largest_fall_inside_it(self):
        found = seasonal.window(SPARSE, [100, 110, 120, 99, 121, 130], 2020, 10)
        assert (found.start, found.end) == (date(2020, 10, 30), date(2021, 10, 29))
        assert found.change == pytest.approx(0.10)
        assert found.drawdown == pytest.approx(99 / 120 - 1)
        assert seasonal.window(SPARSE, [100, 110, 120, 99, 121, 130], 2021, 10) is None

    def test_scan_counts_complete_windows_per_month_and_cycle_year(self):
        days, closes = monthly_series(2000, 2006, lambda year: 1.01**12)
        cells = {(cell.month, cell.phase): cell for cell in seasonal.scan(days, closes, 2000, 2006)}
        assert len(cells) == 48
        assert (cells[(10, 2)].n, cells[(10, 2)].positives) == (1, 1)  # start year 2002
        assert cells[(10, 2)].mean == pytest.approx(1.01**12 - 1)
        assert cells[(10, 0)].n == 2  # 2000 and 2004
        assert cells[(12, 1)].n == 1  # 2005-12 to 2006-12 is not complete: no bar after 2006-12


def a_group(n: int, hits: int, mean_fwd: float = 0.0) -> events.Group:
    return events.Group(n=n, hits=hits, hit_rate=hits / n, mean_fwd=mean_fwd, median_fwd=mean_fwd,
                        mean_mdd=-0.05, smallest_drop=-0.01)


def a_stretched(n: int, hits: int, mean_fwd: float, base_rate: float = 0.4, base_fwd: float = 0.01,
                grid_above: bool = True) -> study.StretchedStudy:
    """A study whose primary cell has ``n`` complete episodes; the other cells sit above or below the base."""
    base = a_group(100, round(100 * base_rate))
    cells = []
    for definition in stretched.GRID:
        primary = definition == stretched.PRIMARY
        result = (a_group(n, hits, mean_fwd) if primary else a_group(10, 10 if grid_above else 0)) if n else None
        p_value = events.binomial_tail(result.hits, result.n, base.hit_rate) if result else None
        cells.append(study.StretchedCell(definition=definition, signal_days=n, episodes=(), result=result,
                                         base=base, p_value=p_value))
    return study.StretchedStudy(cells=tuple(cells), base_all=a_group(1000, 400, base_fwd))


class TestStretchedVerdict:
    def test_few_episodes_are_inconclusive(self):
        assert study.stretched_verdict(a_stretched(7, 7, -0.05), a_stretched(6, 6, -0.05)) == study.INCONCLUSIVE

    def test_pass_needs_the_holdout_above_its_base_rate(self):
        sample = a_stretched(10, 10, -0.05)
        assert study.stretched_verdict(sample, a_stretched(6, 4, -0.02)) == study.PASS
        assert study.stretched_verdict(sample, a_stretched(6, 2, -0.02)) == study.FAIL
        assert study.stretched_verdict(sample, a_stretched(4, 4, -0.02)) == study.INCONCLUSIVE
        assert study.stretched_verdict(sample, a_stretched(0, 0, 0.0)) == study.INCONCLUSIVE

    def test_fail_without_a_significant_hit_rate(self):
        # 5 of 10 against a base rate of 0.4: p is about 0.37
        assert study.stretched_verdict(a_stretched(10, 5, -0.05), a_stretched(6, 6, -0.05)) == study.FAIL

    def test_fail_when_the_forward_return_is_not_below_all_days(self):
        assert study.stretched_verdict(a_stretched(10, 10, 0.02), a_stretched(6, 6, -0.05)) == study.FAIL

    def test_fail_when_most_grid_cells_are_not_above_their_base_rate(self):
        sample = a_stretched(10, 10, -0.05, grid_above=False)
        assert study.stretched_verdict(sample, a_stretched(6, 6, -0.05)) == study.FAIL


class TestStretchedStudy:
    # 0.2% a day for 400 days, then 10% down over 10 days, then flat
    CLOSES = ([1.002**t for t in range(400)]
              + [1.002**399 * 0.9 ** (k / 10) for k in range(1, 11)]
              + [1.002**399 * 0.9] * 60)

    def test_a_steady_run_at_a_record_signals_every_thirty_days(self):
        found = study.stretched_study(self.CLOSES).primary
        assert [item.index for item in found.episodes] == [199, 229, 259, 289, 319, 349, 379]
        assert found.signal_days == 205  # days 199 to 403: the high of day 399 is at most 4 days old
        assert (found.result.n, found.result.hits) == (7, 1)  # only the window of day 379 holds the fall
        assert found.episodes[-1].outcome.mdd == pytest.approx(1.002**20 * 0.9 - 1)
        assert found.episodes[0].run == pytest.approx(1.002**126 - 1)

    def test_last_limits_the_event_days_but_not_the_windows(self):
        found = study.stretched_study(self.CLOSES, last=379).primary
        assert [item.index for item in found.episodes] == [199, 229, 259, 289, 319, 349, 379]
        assert found.episodes[-1].outcome is not None
        cut = study.stretched_study(self.CLOSES[:381]).primary
        assert cut.episodes[-1].outcome is None  # open at the cut
        assert cut.result.n == 6


def a_sawtooth(cycles: int) -> list[float]:
    """Up 20% over 40 days, down 15% over 20 days, with a cycle that grows a little each time."""
    closes, level = [], 100.0
    for cycle in range(cycles):
        up, down = 1.20 + 0.002 * (cycle % 7), 0.85 - 0.003 * (cycle % 5)
        for _ in range(40):
            level *= up ** (1 / 40)
            closes.append(level)
        for _ in range(20):
            level *= down ** (1 / 20)
            closes.append(level)
    return closes


class TestAnalogStudy:
    CLOSES = a_sawtooth(40)

    def test_sample_days_use_only_what_is_known_on_the_day(self):
        found = study.analog_study(self.CLOSES)
        assert found.tops == 40
        tops = {top.index: top for top in analog.zigzag_tops(self.CLOSES)}
        for day in found.days:
            assert tops[day.nearest.top].confirmed <= day.index
            assert day.nearest.day + events.HORIZON <= day.index
            assert 0 <= day.nearest.offset <= analog.MAX_OFFSET
        assert [b.index - a.index for a, b in zip(found.days, found.days[1:], strict=False)] == [30] * (len(found.days) - 1)

    def test_the_first_twenty_sample_days_are_not_classified(self):
        found = study.analog_study(self.CLOSES)
        assert [day.top_like for day in found.days[:20]] == [None] * 20
        assert all(day.top_like is not None for day in found.days[20:])
        counted = [day for day in found.days[20:] if day.outcome is not None]
        assert found.top_like.n + found.others.n == len(counted)
        assert -1.0 <= found.rho <= 1.0

    def test_later_bars_do_not_change_an_earlier_sample_day(self):
        cut = 1500
        full = study.analog_study(self.CLOSES, last=cut - 1)
        short = study.analog_study(self.CLOSES[:cut])
        assert [(day.index, day.nearest, day.top_like) for day in full.days] == \
               [(day.index, day.nearest, day.top_like) for day in short.days]
        assert full.days[-1].outcome is not None and short.days[-1].outcome is None


def an_analog(top: events.Group | None, others: events.Group | None, rho: float = 0.3, rho_p: float = 0.01) -> study.AnalogStudy:
    p_value = events.binomial_tail(top.hits, top.n, others.hit_rate) if top and others else None
    return study.AnalogStudy(length=63, reversal=0.10, tops=30, days=(), top_like=top, others=others,
                             p_value=p_value, rho=rho, rho_p=rho_p)


class TestAnalogVerdict:
    GOOD = an_analog(a_group(20, 16, -0.03), a_group(80, 32, 0.01))
    WEAK = an_analog(a_group(20, 6, -0.03), a_group(80, 32, 0.01))

    def test_pass_needs_every_in_sample_check_and_the_holdout(self):
        holdout = an_analog(a_group(6, 4), a_group(30, 12))
        assert study.analog_verdict(self.GOOD, [self.GOOD] * 6, holdout) == study.PASS
        assert study.analog_verdict(self.GOOD, [self.GOOD] * 6, an_analog(a_group(6, 2), a_group(30, 12))) == study.FAIL
        assert study.analog_verdict(self.GOOD, [self.GOOD] * 6, an_analog(a_group(4, 4), a_group(30, 12))) == study.INCONCLUSIVE

    def test_few_top_like_days_are_inconclusive(self):
        few = an_analog(a_group(7, 7, -0.03), a_group(80, 32, 0.01))
        assert study.analog_verdict(few, [few], self.GOOD) == study.INCONCLUSIVE
        assert study.analog_verdict(an_analog(None, None), [], self.GOOD) == study.INCONCLUSIVE

    def test_fail_on_any_missing_in_sample_check(self):
        holdout = an_analog(a_group(6, 4), a_group(30, 12))
        assert study.analog_verdict(self.WEAK, [self.GOOD] * 6, holdout) == study.FAIL  # hit rate not above
        no_rank = replace(self.GOOD, rho=-0.1, rho_p=0.9)
        assert study.analog_verdict(no_rank, [self.GOOD] * 6, holdout) == study.FAIL
        better_return = an_analog(a_group(20, 16, 0.02), a_group(80, 32, 0.01))
        assert study.analog_verdict(better_return, [self.GOOD] * 6, holdout) == study.FAIL
        assert study.analog_verdict(self.GOOD, [self.GOOD] * 2 + [self.WEAK] * 4, holdout) == study.FAIL


def weekdays(first: date, count: int) -> list[date]:
    days, day = [], first
    while len(days) < count:
        if day.weekday() < 5:
            days.append(day)
        day += timedelta(days=1)
    return days


class TestLiquidityStudy:
    DAYS = weekdays(date(2020, 1, 1), 520)

    def build(self, harmful: bool):
        """Net liquidity falls for 16 weeks, then rises for 16 weeks. When ``harmful`` the asset falls
        while the flag is on."""
        level, walcl = 1000.0, {}
        wednesdays = [day for day in self.DAYS if day.weekday() == 2]
        for i, day in enumerate(wednesdays):
            level *= 0.99 if (i // 16) % 2 == 0 else 1.012
            walcl[day] = level
        weeks, _ = liquidity.net_liquidity(walcl, {day: 0.0 for day in walcl}, {})
        states = liquidity.daily_states(self.DAYS, weeks)
        closes = [100.0]
        for d in range(1, len(self.DAYS)):
            on = bool(states[d - 1])
            closes.append(closes[-1] * (0.998 if on == harmful else 1.003))
        return study.liquidity_study(self.DAYS, closes, closes, [0.0001] * len(self.DAYS), weeks,
                                     eras=(("2020", date(2020, 1, 1), date(2020, 12, 31)),
                                           ("1990s", date(1990, 1, 1), date(1999, 12, 31))))

    def test_a_flag_that_marks_the_falls_passes(self):
        found = self.build(harmful=True)
        assert all(half.better for half in found.halves)
        assert found.mean_on < 0 < found.mean_off
        assert found.weeks_on > 5 and found.weeks_off > 5
        assert study.liquidity_verdict(found) == study.PASS
        assert found.full.rule.trades > 4
        assert found.halves[0].end < found.halves[1].start
        assert [era.label for era in found.eras] == ["2020"]  # an era without days is left out

    def test_a_flag_that_marks_the_rises_fails(self):
        found = self.build(harmful=False)
        assert found.mean_on > found.mean_off
        assert study.liquidity_verdict(found) == study.FAIL

    def test_verdict_needs_both_halves_and_the_event_comparison(self):
        found = self.build(harmful=True)
        worse = replace(found.halves[1], rule=replace(found.halves[1].rule, sharpe=found.halves[1].hold.sharpe - 0.1))
        assert study.liquidity_verdict(replace(found, halves=(found.halves[0], worse))) == study.FAIL
        assert study.liquidity_verdict(replace(found, p_value=0.2)) == study.FAIL

    def test_better_needs_sharpe_and_drawdown(self):
        stats = lambda sharpe, drawdown: Stats(days=10, final_wealth=1.0, cagr=0.0, volatility=0.1, sharpe=sharpe,
                                               max_drawdown=drawdown, trades=0, fraction_out=0.0)
        period = lambda rule, hold: study.Period("p", date(2020, 1, 1), date(2020, 2, 1), rule, hold)
        assert period(stats(1.0, -0.1), stats(0.5, -0.2)).better is True
        assert period(stats(1.0, -0.3), stats(0.5, -0.2)).better is False
        assert period(stats(0.4, -0.1), stats(0.5, -0.2)).better is False


class TestSeasonalStudy:
    # midterm windows gain 10%; other even start years gain 2%; odd start years lose 3%
    DAYS, CLOSES = monthly_series(1929, 2026, lambda year: 1.10 if year % 4 == 2 else 1.02 if year % 2 == 0 else 0.97)

    def test_claim_base_rate_and_halves(self):
        found = study.seasonal_study(self.DAYS, self.CLOSES)
        assert (len(found.midterm), found.positives) == (19, 19)
        assert [item.year for item in found.midterm][:2] == [1950, 1954]
        assert len(found.others) == 57
        assert found.base_rate == pytest.approx(19 / 57)
        assert found.p_value == pytest.approx((19 / 57) ** 19)
        assert found.adjusted_p == pytest.approx(48 * (19 / 57) ** 19)
        assert [label for label, _, _ in found.halves] == ["1950-1986", "1987-2025"]
        assert all(midterm == pytest.approx(0.10) and other < 0 for _, midterm, other in found.halves)
        assert [item.year for item in found.holdout] == [1930, 1934, 1938, 1942, 1946]
        assert len(found.cells) == 48
        assert study.seasonal_verdict(found) == study.PASS

    def test_verdict_fails_on_one_negative_midterm_window_or_a_weak_holdout(self):
        found = study.seasonal_study(self.DAYS, self.CLOSES)
        lost = replace(found.midterm[0], change=-0.01)
        assert study.seasonal_verdict(replace(found, midterm=(lost, *found.midterm[1:]))) == study.FAIL
        weak = tuple(replace(item, change=-0.05) for item in found.holdout[:2]) + found.holdout[2:]
        assert study.seasonal_verdict(replace(found, holdout=weak)) == study.FAIL
        assert study.seasonal_verdict(replace(found, adjusted_p=0.2)) == study.FAIL
        flat = tuple((label, 0.01, 0.02) for label, _, _ in found.halves)
        assert study.seasonal_verdict(replace(found, halves=flat)) == study.FAIL
