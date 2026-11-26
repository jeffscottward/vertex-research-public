"""Pure-stdlib equal-weight event-study portfolio engine and deflated Sharpe gate.

All returns are measured in excess of SPY (split/dividend adjusted), entering at the
next trading day's open after the public-at trigger date and exiting at the close of
the H-th trading day held. Reuses backtesting.optimizer.deflated_sharpe_ratio and
strategies.trend_trio.study.moments directly. Research only.
"""
from __future__ import annotations

import math
import statistics
from bisect import bisect_right
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import date

from backtesting.optimizer import DeflatedSharpe, deflated_sharpe_ratio
from strategies.trend_trio.study import moments

SESSIONS_PER_YEAR = 252
DEFAULT_MAX_SLOTS = 10
DEFAULT_COST_BPS = 10.0
MIN_OOS_SESSIONS = 490  # 24 calendar months on real NYSE holiday calendars (~250 sessions/year)
MIN_OOS_EVENTS = 100
DSR_PASS_BAR = 0.95
MIN_LIQUID_PRICE = 5.0
MIN_LIQUID_MEDIAN_DOLLAR_VOL = 10_000_000.0


@dataclass(frozen=True, slots=True)
class DailyBar:
    day: date
    open: float
    high: float
    low: float
    close: float
    adj_close: float
    volume: float
    # Close as it printed on that day (no later split applied). The vendor's open/high/low/close
    # are restated for every later split, so a price filter on ``close`` would look ahead.
    raw_close: float

    @property
    def adj_open(self) -> float:
        """Split- and dividend-adjusted open price aligned with adj_close."""
        if self.close <= 0:
            return self.open
        return self.open * (self.adj_close / self.close)


def raw_closes_from_splits(
    days: Sequence[date],
    closes: Sequence[float],
    splits: Sequence[tuple[date, float]],
) -> list[float]:
    """Undo the vendor's split restatement: the close as it printed on each day.

    ``closes`` are restated for every later split. ``splits`` holds ``(ex_day, ratio)`` with
    ``ratio`` = new shares per old share (4.0 for a 4-for-1 split, 0.1 for a 1-for-10 reverse
    split). The bar on ``ex_day`` already trades after the split, so only splits with
    ``ex_day > day`` are undone.
    """
    if len(days) != len(closes):
        raise ValueError("days and closes must have the same length")
    if any(ratio <= 0 for _day, ratio in splits):
        raise ValueError("split ratios must be > 0")
    ordered = sorted(splits)
    ex_days = [ex_day for ex_day, _ratio in ordered]
    # later_factor[i] = product of the ratios of splits i.. (all splits on or after ex_days[i]).
    later_factor = [1.0] * (len(ordered) + 1)
    for i in range(len(ordered) - 1, -1, -1):
        later_factor[i] = later_factor[i + 1] * ordered[i][1]
    return [close * later_factor[bisect_right(ex_days, day)] for day, close in zip(days, closes, strict=True)]


@dataclass(frozen=True, slots=True)
class SignalEvent:
    symbol: str
    trigger_day: date
    rank_value: float  # slots fill in descending order of this value (dollar value or net premium)


@dataclass(frozen=True, slots=True)
class PortfolioConfig:
    holding_days: int
    max_slots: int = DEFAULT_MAX_SLOTS
    cost_bps: float = DEFAULT_COST_BPS
    require_liquidity: bool = True
    min_price: float = MIN_LIQUID_PRICE
    min_median_dollar_vol: float = MIN_LIQUID_MEDIAN_DOLLAR_VOL


@dataclass(frozen=True, slots=True)
class PeriodMetrics:
    days: int
    trades: int
    cagr: float
    sharpe: float  # annualized
    per_obs_sharpe: float  # daily non-annualized (input to deflated_sharpe_ratio)
    max_drawdown: float  # negative fraction in [-1, 0]
    exposure: float  # fraction in [0, 1]
    win_rate: float  # fraction in [0, 1]
    profit_factor: float | None  # None when no losing trades


@dataclass(frozen=True, slots=True)
class PositionRecord:
    symbol: str
    trigger_day: date
    entry_day: date
    exit_day: date
    gross_excess_return: float
    net_excess_return: float
    truncated: bool


@dataclass(slots=True)
class _OpenSlot:
    """One open position; the indexes point into the SPY session list."""

    entry_idx: int
    exit_idx: int
    trigger_day: date
    truncated: bool
    last_bar_idx: int  # latest session on which the stock printed a bar
    gross: float = 1.0
    net: float = 1.0


@dataclass(frozen=True, slots=True)
class PortfolioResult:
    first_day: date | None
    last_day: date | None
    daily_days: tuple[date, ...]
    daily_excess_returns: tuple[float, ...]
    oos_days: tuple[date, ...]
    oos_excess_returns: tuple[float, ...]
    whole: PeriodMetrics
    oos: PeriodMetrics
    monthly_equity: tuple[dict[str, float | str], ...]
    positions: tuple[PositionRecord, ...]
    skipped_overlap: int
    skipped_capacity: int
    skipped_missing_bars: int
    skipped_illiquid: int
    truncated_exits: int
    skipped_outside_window: int  # entry day before the window start or after its end


@dataclass(frozen=True, slots=True)
class TrialRecord:
    study_id: str
    variant: str
    holding_days: int
    cost_bps: float
    is_primary: bool
    oos_events: int
    oos_days: int
    oos_per_obs_sharpe: float
    oos_annual_sharpe: float
    oos_cagr: float
    whole_cagr: float
    whole_sharpe: float
    whole_max_drawdown: float
    whole_trades: int
    whole_win_rate: float


def check_point_in_time_liquidity(
    bars: Sequence[DailyBar],
    day_index: Mapping[date, int],
    as_of: date,
    *,
    min_price: float = MIN_LIQUID_PRICE,
    min_median_dollar_vol: float = MIN_LIQUID_MEDIAN_DOLLAR_VOL,
    lookback: int = 20,
) -> bool:
    """Verify liquidity using bars strictly on or before ``as_of`` (zero look-ahead)."""
    idx = day_index.get(as_of)
    if idx is None:
        # Use the most recent trading bar strictly on or before as_of.
        days = [b.day for b in bars]
        pos = bisect_right(days, as_of) - 1
        if pos < 0:
            return False
        idx = pos
    bar = bars[idx]
    if bar.raw_close < min_price or bar.close <= 0:
        return False
    start = max(0, idx - lookback + 1)
    window = bars[start : idx + 1]
    if len(window) < min(5, lookback):
        return False
    dollar_vols = [b.close * b.volume for b in window if b.close > 0 and b.volume >= 0]
    if not dollar_vols:
        return False
    return statistics.median(dollar_vols) >= min_median_dollar_vol


def _period_metrics(
    days: Sequence[date],
    daily_returns: Sequence[float],
    active_slot_counts: Sequence[int],
    trade_returns: Sequence[float],
    max_slots: int,
) -> PeriodMetrics:
    n_days = len(daily_returns)
    trades = len(trade_returns)
    if n_days == 0:
        return PeriodMetrics(0, trades, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, None)

    equity = 1.0
    peak = 1.0
    worst_dd = 0.0
    for r in daily_returns:
        equity *= max(0.0, 1.0 + r)
        if equity > peak:
            peak = equity
        dd = equity / peak - 1.0 if peak > 0 else -1.0
        if dd < worst_dd:
            worst_dd = dd

    years = max((days[-1] - days[0]).days / 365.25, 1.0 / SESSIONS_PER_YEAR)
    if equity <= 0.0:
        cagr = -1.0
    else:
        cagr = max(-1.0, equity ** (1.0 / years) - 1.0)

    mean = statistics.fmean(daily_returns)
    if n_days >= 2:
        std = statistics.stdev(daily_returns)
    else:
        std = 0.0
    if std > 0.0 and math.isfinite(mean / std):
        per_obs_sharpe = mean / std
        ann_sharpe = per_obs_sharpe * math.sqrt(SESSIONS_PER_YEAR)
    else:
        per_obs_sharpe = 0.0
        ann_sharpe = 0.0

    exposure = (
        statistics.fmean(min(1.0, c / max_slots) for c in active_slot_counts)
        if active_slot_counts and max_slots > 0
        else 0.0
    )
    if trades > 0:
        wins = [r for r in trade_returns if r > 0.0]
        losses = [-r for r in trade_returns if r < 0.0]
        win_rate = len(wins) / trades
        profit_factor = (sum(wins) / sum(losses)) if losses and sum(losses) > 0 else None
    else:
        win_rate = 0.0
        profit_factor = None

    return PeriodMetrics(
        days=n_days,
        trades=trades,
        cagr=cagr,
        sharpe=ann_sharpe,
        per_obs_sharpe=per_obs_sharpe,
        max_drawdown=max(-1.0, min(0.0, worst_dd)),
        exposure=max(0.0, min(1.0, exposure)),
        win_rate=max(0.0, min(1.0, win_rate)),
        profit_factor=profit_factor,
    )


def _monthly_equity(days: Sequence[date], daily_returns: Sequence[float]) -> tuple[dict[str, float | str], ...]:
    if not days:
        return ()
    equity = 1.0
    peak = 1.0
    by_month: dict[str, dict[str, float | str]] = {}
    for d, r in zip(days, daily_returns, strict=True):
        equity *= max(0.0, 1.0 + r)
        if equity > peak:
            peak = equity
        dd = equity / peak - 1.0 if peak > 0 else -1.0
        month = d.isoformat()[:7]
        by_month[month] = {
            "month": month,
            "value": round(max(-1.0, equity - 1.0), 6),
            "drawdown": round(max(-1.0, min(0.0, dd)), 6),
        }
    return tuple(by_month[m] for m in sorted(by_month))


def simulate_event_portfolio(
    events: Sequence[SignalEvent],
    bars_by_symbol: Mapping[str, Sequence[DailyBar]],
    spy_bars: Sequence[DailyBar],
    config: PortfolioConfig,
    *,
    start_day: date | None = None,
    end_day: date | None = None,
    oos_start: date | None = None,
) -> PortfolioResult:
    """Simulate an equal-weight overlapping slot portfolio in excess of SPY."""
    if config.holding_days < 1:
        raise ValueError("holding_days must be >= 1")
    if config.max_slots < 1:
        raise ValueError("max_slots must be >= 1")

    spy_sorted = sorted(spy_bars, key=lambda b: b.day)
    calendar_days = [b.day for b in spy_sorted]  # every session, before the window is cut
    if start_day is not None:
        spy_sorted = [b for b in spy_sorted if b.day >= start_day]
    if end_day is not None:
        spy_sorted = [b for b in spy_sorted if b.day <= end_day]
    if not spy_sorted:
        empty = PeriodMetrics(0, 0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, None)
        return PortfolioResult(None, None, (), (), (), (), empty, empty, (), (), 0, 0, 0, 0, 0, 0)

    spy_days = [b.day for b in spy_sorted]
    spy_index = {b.day: i for i, b in enumerate(spy_sorted)}
    spy_adj_close = [b.adj_close for b in spy_sorted]
    spy_open_close = [(b.adj_close / b.adj_open - 1.0) if b.adj_open > 0 else 0.0 for b in spy_sorted]

    # Pre-index per-symbol bars and day maps.
    sym_bars: dict[str, list[DailyBar]] = {}
    sym_index: dict[str, dict[date, int]] = {}
    for sym, seq in bars_by_symbol.items():
        ordered = sorted(seq, key=lambda b: b.day)
        sym_bars[sym] = ordered
        sym_index[sym] = {b.day: i for i, b in enumerate(ordered)}

    # Group candidate events by their entry day: the first session strictly after the trigger day.
    # The entry day comes from the full calendar, so an event that triggered before the window does
    # not enter late on the window's first session.
    candidates_by_entry: dict[int, list[SignalEvent]] = {}
    skipped_outside_window = 0
    skipped_missing_bars = 0
    skipped_illiquid = 0
    for ev in events:
        c_idx = bisect_right(calendar_days, ev.trigger_day)
        e_idx = spy_index.get(calendar_days[c_idx]) if c_idx < len(calendar_days) else None
        if e_idx is None:
            skipped_outside_window += 1
            continue
        entry_day = spy_days[e_idx]
        bars = sym_bars.get(ev.symbol)
        s_idx_map = sym_index.get(ev.symbol)
        if not bars or not s_idx_map or entry_day not in s_idx_map:
            skipped_missing_bars += 1
            continue
        if config.require_liquidity and not check_point_in_time_liquidity(
            bars,
            s_idx_map,
            ev.trigger_day,
            min_price=config.min_price,
            min_median_dollar_vol=config.min_median_dollar_vol,
        ):
            skipped_illiquid += 1
            continue
        candidates_by_entry.setdefault(e_idx, []).append(ev)

    cost_side = config.cost_bps / 10_000.0
    slot_weight = 1.0 / config.max_slots

    active: dict[str, _OpenSlot] = {}
    daily_returns: list[float] = []
    active_counts: list[int] = []
    positions: list[PositionRecord] = []
    skipped_overlap = 0
    skipped_capacity = 0
    truncated_exits = 0

    for d_idx, day in enumerate(spy_days):
        # 1. Admit new events whose next-open entry day is d_idx.
        day_candidates = candidates_by_entry.get(d_idx)
        if day_candidates:
            day_candidates.sort(key=lambda e: (-e.rank_value, e.symbol, e.trigger_day))
            for ev in day_candidates:
                if ev.symbol in active:
                    skipped_overlap += 1
                    continue
                if len(active) >= config.max_slots:
                    skipped_capacity += 1
                    continue
                # Determine exit_spy_idx = min(d_idx + H - 1, last available bar for this symbol).
                target_exit_idx = d_idx + config.holding_days - 1
                truncated = False
                if target_exit_idx >= len(spy_days):
                    target_exit_idx = len(spy_days) - 1
                    truncated = True
                # Walk back if symbol stops trading before target_exit_idx (delisting / series end).
                s_map = sym_index[ev.symbol]
                actual_exit_idx = target_exit_idx
                while actual_exit_idx > d_idx and spy_days[actual_exit_idx] not in s_map:
                    actual_exit_idx -= 1
                if actual_exit_idx < d_idx + config.holding_days - 1:
                    truncated = True
                if truncated:
                    truncated_exits += 1
                active[ev.symbol] = _OpenSlot(d_idx, actual_exit_idx, ev.trigger_day, truncated, d_idx)

        # 2. Compute daily portfolio excess return across all active slots on day d_idx.
        day_ret = 0.0
        to_close: list[str] = []
        active_counts.append(len(active))
        for sym, slot in active.items():
            s_bars = sym_bars[sym]
            s_i = sym_index[sym].get(day)
            if s_i is not None:
                bar = s_bars[s_i]
                if d_idx == slot.entry_idx:
                    ao = bar.adj_open
                    r_stock = (bar.adj_close / ao - 1.0) if ao > 0 else 0.0
                    r_spy = spy_open_close[d_idx]
                else:
                    # The stock return runs from its previous bar, which is more than one session
                    # back after a gap (halt), so the benchmark return covers the same sessions.
                    prev_close = s_bars[s_i - 1].adj_close if s_i > 0 else bar.adj_close
                    r_stock = (bar.adj_close / prev_close - 1.0) if prev_close > 0 else 0.0
                    spy_prev = spy_adj_close[slot.last_bar_idx]
                    r_spy = (spy_adj_close[d_idx] / spy_prev - 1.0) if spy_prev > 0 else 0.0
                slot.last_bar_idx = d_idx
                gross_excess = r_stock - r_spy
                cost = (cost_side if d_idx == slot.entry_idx else 0.0) + (cost_side if d_idx == slot.exit_idx else 0.0)
                net_excess = gross_excess - cost
                day_ret += slot_weight * net_excess
                slot.gross *= max(0.0, 1.0 + gross_excess)
                slot.net *= max(0.0, 1.0 + net_excess)
            if d_idx >= slot.exit_idx:
                to_close.append(sym)

        daily_returns.append(day_ret)

        for sym in to_close:
            slot = active.pop(sym)
            positions.append(
                PositionRecord(
                    symbol=sym,
                    trigger_day=slot.trigger_day,
                    entry_day=spy_days[slot.entry_idx],
                    exit_day=spy_days[slot.exit_idx],
                    gross_excess_return=slot.gross - 1.0,
                    net_excess_return=slot.net - 1.0,
                    truncated=slot.truncated,
                )
            )

    whole_trade_rets = [p.net_excess_return for p in positions]
    whole = _period_metrics(spy_days, daily_returns, active_counts, whole_trade_rets, config.max_slots)

    if oos_start is not None:
        oos_indices = [i for i, d in enumerate(spy_days) if d >= oos_start]
        oos_days_seq = tuple(spy_days[i] for i in oos_indices)
        oos_rets_seq = tuple(daily_returns[i] for i in oos_indices)
        oos_active_seq = [active_counts[i] for i in oos_indices]
        oos_trade_rets = [p.net_excess_return for p in positions if p.entry_day >= oos_start]
        oos = _period_metrics(oos_days_seq, oos_rets_seq, oos_active_seq, oos_trade_rets, config.max_slots)
    else:
        oos_days_seq = ()
        oos_rets_seq = ()
        oos = PeriodMetrics(0, 0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, None)

    monthly = _monthly_equity(spy_days, daily_returns)
    return PortfolioResult(
        first_day=spy_days[0],
        last_day=spy_days[-1],
        daily_days=tuple(spy_days),
        daily_excess_returns=tuple(daily_returns),
        oos_days=oos_days_seq,
        oos_excess_returns=oos_rets_seq,
        whole=whole,
        oos=oos,
        monthly_equity=monthly,
        positions=tuple(positions),
        skipped_overlap=skipped_overlap,
        skipped_capacity=skipped_capacity,
        skipped_missing_bars=skipped_missing_bars,
        skipped_illiquid=skipped_illiquid,
        truncated_exits=truncated_exits,
        skipped_outside_window=skipped_outside_window,
    )


def compute_study_dsr(
    primary_oos_returns: Sequence[float],
    all_trial_per_obs_sharpes: Sequence[float],
    n_trials: int,
) -> DeflatedSharpe | None:
    """Compute Bailey & Lopez de Prado (2014) DSR via backtesting.optimizer.deflated_sharpe_ratio.

    Expects per-observation daily OOS returns and per-observation daily OOS Sharpes.
    Returns None when n_trials < 2 or observations < 2 (for example Signal 3 needs-more-data).
    """
    n_obs = len(primary_oos_returns)
    if n_trials < 2 or n_obs < 2:
        return None
    mean = statistics.fmean(primary_oos_returns)
    std = statistics.stdev(primary_oos_returns)
    if std <= 0.0 or not math.isfinite(mean / std):
        return None
    per_obs_sharpe = mean / std
    skew, raw_kurtosis = moments(primary_oos_returns)
    finite_sharpes = [s for s in all_trial_per_obs_sharpes if math.isfinite(s)]
    if len(finite_sharpes) >= 2:
        sharpe_variance = statistics.variance(finite_sharpes)
    else:
        sharpe_variance = 1.0 / (n_obs - 1)
    if sharpe_variance <= 0.0:
        sharpe_variance = 1.0 / (n_obs - 1)
    try:
        return deflated_sharpe_ratio(
            sharpe=per_obs_sharpe,
            n_trials=n_trials,
            sharpe_variance=sharpe_variance,
            n_observations=n_obs,
            skew=skew,
            kurtosis=raw_kurtosis,
        )
    except ValueError:
        return None


def evaluate_verdict(
    *,
    oos_sessions: int,
    oos_events: int,
    oos_sharpe: float,
    dsr_probability: float | None,
    stress_oos_sharpe: float | None,
    n_trials: int,
    min_oos_sessions: int = MIN_OOS_SESSIONS,
    min_oos_events: int = MIN_OOS_EVENTS,
    dsr_pass: float = DSR_PASS_BAR,
) -> tuple[str, str]:
    """Deterministic zero-dead-zone verdict gate matching plan-pr7.md section 1.2."""
    if oos_sessions < min_oos_sessions:
        return (
            "needs-more-data",
            f"Observed history has {oos_sessions} OOS sessions (< {min_oos_sessions} required for 24-month holdout). "
            f"Rule is frozen (N = {n_trials}) for forward out-of-sample collection.",
        )

    # Every bar is written as "not (value passes)", so a NaN input fails its bar.
    dsr_val = 0.0 if dsr_probability is None else dsr_probability
    reasons: list[str] = []
    if not oos_events >= min_oos_events:
        reasons.append(f"OOS events {oos_events} < {min_oos_events}")
    if not oos_sharpe > 0.0:
        reasons.append(f"OOS annualized excess Sharpe {oos_sharpe:.3f} <= 0")
    if not dsr_val >= dsr_pass:
        reasons.append(f"DSR {dsr_val:.3f} < {dsr_pass:.2f} (N = {n_trials})")
    if stress_oos_sharpe is None:
        reasons.append("20 bps stress OOS Sharpe was not computed")
    elif not stress_oos_sharpe > 0.0:
        reasons.append(f"20 bps stress OOS Sharpe {stress_oos_sharpe:.3f} <= 0")

    if stress_oos_sharpe is not None and not reasons:
        return (
            "edge",
            f"Passed pre-registered gate over {oos_sessions} OOS sessions: {oos_events} OOS events, "
            f"OOS excess Sharpe {oos_sharpe:.3f} at 10 bps/side (20 bps stress {stress_oos_sharpe:.3f}), "
            f"DSR {dsr_val:.3f} >= {dsr_pass:.2f} (N = {n_trials}). Research only.",
        )

    return (
        "no-edge",
        f"Failed pre-registered gate over {oos_sessions} OOS sessions: {'; '.join(reasons)}. "
        f"Primary OOS excess Sharpe {oos_sharpe:.3f}, DSR {dsr_val:.3f} (N = {n_trials}). Research only.",
    )
