"""The four tests and their pass rules (docs/specs/research/analog-regime-flags.md)."""
from __future__ import annotations

import statistics
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date

from ..sma_timing import Stats
from . import analog, liquidity, seasonal, stretched
from .events import Group, Outcome, binomial_tail, group, mean_below_p, outcome, outcomes, spearman, spearman_p

PASS, FAIL, INCONCLUSIVE = "PASS", "FAIL", "INCONCLUSIVE"
ALPHA = 0.05
MIN_EVENTS = 8  # complete events the in-sample test needs
MIN_HOLDOUT = 5
BONFERRONI = 48  # 12 start months x 4 years of the election cycle (rule D5)
HOLDOUT_POSITIVES = 4  # of the 5 holdout windows of rule D8


# Test A -----------------------------------------------------------------------------------------

@dataclass(frozen=True, slots=True)
class Episode:
    index: int
    run: float
    stretch: float
    vol: float
    outcome: Outcome | None  # None while the window is open


@dataclass(frozen=True, slots=True)
class StretchedCell:
    definition: stretched.Definition
    signal_days: int
    episodes: tuple[Episode, ...]
    result: Group | None  # the complete episodes
    base: Group | None  # the near-high days of the same high type
    p_value: float | None  # hits against the base hit rate

    @property
    def complete(self) -> int:
        return self.result.n if self.result else 0

    @property
    def above_base(self) -> bool:
        return bool(self.result and self.base and self.result.hit_rate > self.base.hit_rate)


@dataclass(frozen=True, slots=True)
class StretchedStudy:
    cells: tuple[StretchedCell, ...]  # in the order of stretched.GRID
    base_all: Group | None  # every day with all features defined

    @property
    def primary(self) -> StretchedCell:
        return next(cell for cell in self.cells if cell.definition == stretched.PRIMARY)


def stretched_study(closes: Sequence[float], last: int | None = None) -> StretchedStudy:
    """Rules A6 to A9 for events on days 0..``last``; later closes only complete the windows."""
    last = len(closes) - 1 if last is None else last
    by_high = {high_days: stretched.features(closes, high_days) for high_days in (None, stretched.YEAR)}
    bases = {high_days: group(outcomes(closes, [t for t in stretched.near_high_days(found) if t <= last]))
             for high_days, found in by_high.items()}
    cells: list[StretchedCell] = []
    for definition in stretched.GRID:
        found, base = by_high[definition.high_days], bases[definition.high_days]
        signals = [t for t in stretched.signal_days(found, definition) if t <= last]
        episodes = tuple(Episode(index=t, run=found.run[t], stretch=found.stretch[t], vol=found.vol[t],
                                 outcome=outcome(closes, t))
                         for t in stretched.episode_starts(signals))
        result = group([item.outcome for item in episodes if item.outcome is not None])
        p_value = binomial_tail(result.hits, result.n, base.hit_rate) if result and base else None
        cells.append(StretchedCell(definition=definition, signal_days=len(signals), episodes=episodes,
                                   result=result, base=base, p_value=p_value))
    record = by_high[None]
    base_all = group(outcomes(closes, [t for t in range(last + 1) if record.valid(t)]))
    return StretchedStudy(cells=tuple(cells), base_all=base_all)


def stretched_verdict(sample: StretchedStudy, holdout: StretchedStudy) -> str:
    primary = sample.primary
    if primary.complete < MIN_EVENTS:
        return INCONCLUSIVE
    assert primary.result is not None and primary.p_value is not None and sample.base_all is not None
    wide = [cell for cell in sample.cells if cell.complete >= MIN_EVENTS]
    in_sample = (primary.p_value <= ALPHA
                 and primary.result.mean_fwd < sample.base_all.mean_fwd
                 and 2 * sum(1 for cell in wide if cell.above_base) >= len(wide))
    if not in_sample:
        return FAIL
    if holdout.primary.complete < MIN_HOLDOUT:
        return INCONCLUSIVE
    return PASS if holdout.primary.above_base else FAIL


# Test B -----------------------------------------------------------------------------------------

@dataclass(frozen=True, slots=True)
class SampleDay:
    index: int
    nearest: analog.Analog
    analog_outcome: Outcome  # what followed the analog day; known on the sample day (rule B5)
    outcome: Outcome | None  # None while the window is open
    top_like: bool | None  # None while not classified (rule B8)


@dataclass(frozen=True, slots=True)
class AnalogStudy:
    length: int
    reversal: float
    tops: int
    days: tuple[SampleDay, ...]
    top_like: Group | None
    others: Group | None
    p_value: float | None  # Test 1: top-like hits against the hit rate of the other days
    rho: float | None  # Test 2: rank correlation of the analog's and the day's forward return
    rho_p: float | None

    @property
    def above_others(self) -> bool:
        return bool(self.top_like and self.others and self.top_like.hit_rate > self.others.hit_rate)


def analog_study(closes: Sequence[float], length: int = analog.PATH, reversal: float = analog.REVERSAL,
                 last: int | None = None) -> AnalogStudy:
    """Rules B5 to B10 for sample days up to ``last``; later closes only complete the windows."""
    last = len(closes) - 1 if last is None else last
    tops = analog.zigzag_tops(closes, reversal)
    indexes = analog.sample_days(last + 1, tops, length)
    nearest = [analog.ranked(closes, t, tops, length)[0] for t in indexes]
    flags = analog.top_like([item.distance for item in nearest])
    days: list[SampleDay] = []
    for t, item, flag in zip(indexes, nearest, flags, strict=True):
        past = outcome(closes, item.day)
        assert past is not None  # rule B5: the analog's window ends on or before day t
        days.append(SampleDay(index=t, nearest=item, analog_outcome=past, outcome=outcome(closes, t), top_like=flag))
    counted = [(day, day.outcome) for day in days if day.top_like is not None and day.outcome is not None]
    top_like = group([own for day, own in counted if day.top_like])
    others = group([own for day, own in counted if not day.top_like])
    p_value = binomial_tail(top_like.hits, top_like.n, others.hit_rate) if top_like and others else None
    rho = rho_p = None
    if len(counted) >= 3:
        rho = spearman([day.analog_outcome.fwd for day, _ in counted], [own.fwd for _, own in counted])
        rho_p = spearman_p(rho, len(counted))
    return AnalogStudy(length=length, reversal=reversal, tops=len(tops), days=tuple(days), top_like=top_like,
                       others=others, p_value=p_value, rho=rho, rho_p=rho_p)


def analog_verdict(primary: AnalogStudy, variants: Sequence[AnalogStudy], holdout: AnalogStudy) -> str:
    if primary.top_like is None or primary.top_like.n < MIN_EVENTS:
        return INCONCLUSIVE
    in_sample = (primary.p_value is not None and primary.p_value <= ALPHA
                 and primary.others is not None and primary.top_like.mean_fwd < primary.others.mean_fwd
                 and primary.rho is not None and primary.rho > 0.0
                 and primary.rho_p is not None and primary.rho_p <= ALPHA
                 and 2 * sum(1 for variant in variants if variant.above_others) >= len(variants))
    if not in_sample:
        return FAIL
    if holdout.top_like is None or holdout.top_like.n < MIN_HOLDOUT:
        return INCONCLUSIVE
    return PASS if holdout.above_others else FAIL


# Test C -----------------------------------------------------------------------------------------

@dataclass(frozen=True, slots=True)
class Period:
    label: str
    start: date
    end: date
    rule: Stats
    hold: Stats

    @property
    def better(self) -> bool:
        """Higher Sharpe ratio and smaller maximum drawdown than buy-and-hold."""
        return self.rule.sharpe > self.hold.sharpe and self.rule.max_drawdown > self.hold.max_drawdown


@dataclass(frozen=True, slots=True)
class LiquidityStudy:
    threshold: float
    full: Period
    halves: tuple[Period, Period]
    eras: tuple[Period, ...]
    weeks_on: int  # C10: the sampled weeks with the flag on
    weeks_off: int
    mean_on: float
    mean_off: float
    p_value: float  # one-sided: the flag-on mean is below the flag-off mean


def liquidity_study(days: Sequence[date], closes: Sequence[float], adjusted: Sequence[float],
                    cash: Sequence[float], weeks: Sequence[liquidity.Week], threshold: float = 0.0,
                    eras: Sequence[tuple[str, date, date]] = ()) -> LiquidityStudy:
    """Rules C4 to C11. ``cash[d]`` is the cash return of day d (rule C6)."""
    first, held = liquidity.held_positions(liquidity.daily_states(days, weeks, threshold))
    asset = [adjusted[d] / adjusted[d - 1] - 1.0 for d in range(first, len(days))]
    window_days, window_cash = days[first:], list(cash[first:])

    def period(label: str, start: int, end: int) -> Period:
        rule, hold = liquidity.timed(asset, window_cash, held, liquidity.COST, start, end)
        return Period(label=label, start=window_days[start], end=window_days[end - 1], rule=rule, hold=hold)

    half = (len(asset) + 1) // 2
    found_eras = []
    for label, start_day, end_day in eras:
        inside = [i for i, day in enumerate(window_days) if start_day <= day <= end_day]
        if len(inside) >= 2:
            found_eras.append(period(label, inside[0], inside[-1] + 1))
    on: list[float] = []
    off: list[float] = []
    for i in range(liquidity.WEEKS, len(weeks) - liquidity.WEEKS, liquidity.WEEKS):
        flag = liquidity.drain(weeks[i], threshold)
        start = liquidity.known_at(days, weeks[i].day)
        end = liquidity.known_at(days, weeks[i + liquidity.WEEKS].day)
        if flag is not None and start is not None and end is not None:
            (on if flag else off).append(closes[end] / closes[start] - 1.0)
    return LiquidityStudy(threshold=threshold, full=period("full", 0, len(asset)),
                          halves=(period("first half", 0, half), period("second half", half, len(asset))),
                          eras=tuple(found_eras), weeks_on=len(on), weeks_off=len(off),
                          mean_on=statistics.fmean(on), mean_off=statistics.fmean(off), p_value=mean_below_p(on, off))


def liquidity_verdict(study: LiquidityStudy) -> str:
    passed = (all(half.better for half in study.halves)
              and study.mean_on < study.mean_off and study.p_value <= ALPHA)
    return PASS if passed else FAIL


# Test D -----------------------------------------------------------------------------------------

@dataclass(frozen=True, slots=True)
class SeasonalStudy:
    month: int
    midterm: tuple[seasonal.Window, ...]
    others: tuple[seasonal.Window, ...]
    base_rate: float  # share of positive non-midterm windows (rule D4)
    p_value: float
    adjusted_p: float  # rule D5
    halves: tuple[tuple[str, float, float], ...]  # label, midterm mean, non-midterm mean (rule D7)
    holdout: tuple[seasonal.Window, ...]
    cells: tuple[seasonal.Cell, ...]

    @property
    def positives(self) -> int:
        return sum(1 for item in self.midterm if item.change > 0.0)


def seasonal_study(days: Sequence[date], closes: Sequence[float], month: int = 10, first_year: int = 1950,
                   last_year: int = 2025, split_year: int = 1986,
                   holdout_years: Sequence[int] = (1930, 1934, 1938, 1942, 1946)) -> SeasonalStudy:
    years = range(first_year, last_year + 1)
    midterm = seasonal.windows(days, closes, [y for y in years if y % 4 == seasonal.MIDTERM], month)
    others = seasonal.windows(days, closes, [y for y in years if y % 4 != seasonal.MIDTERM], month)
    base_rate = sum(1 for item in others if item.change > 0.0) / len(others)
    positives = sum(1 for item in midterm if item.change > 0.0)
    p_value = binomial_tail(positives, len(midterm), base_rate)
    halves = []
    for label, low, high in ((f"{first_year}-{split_year}", first_year, split_year),
                             (f"{split_year + 1}-{last_year}", split_year + 1, last_year)):
        halves.append((label,
                       statistics.fmean(item.change for item in midterm if low <= item.year <= high),
                       statistics.fmean(item.change for item in others if low <= item.year <= high)))
    return SeasonalStudy(month=month, midterm=tuple(midterm), others=tuple(others), base_rate=base_rate,
                         p_value=p_value, adjusted_p=min(1.0, p_value * BONFERRONI), halves=tuple(halves),
                         holdout=tuple(seasonal.windows(days, closes, holdout_years, month)),
                         cells=tuple(seasonal.scan(days, closes, first_year, last_year)))


def seasonal_verdict(study: SeasonalStudy) -> str:
    passed = (study.positives == len(study.midterm)
              and study.adjusted_p <= ALPHA
              and all(midterm > other for _, midterm, other in study.halves)
              and sum(1 for item in study.holdout if item.change > 0.0) >= HOLDOUT_POSITIVES)
    return PASS if passed else FAIL
