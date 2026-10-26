"""Noise-band intraday momentum (Zarattini, Aziz, Barbon 2024/2025, SSRN 4824172).

Research-only backtest kernel. It places no orders and imports no broker,
provider or clock API. Spec: docs/specs/strategies/noise-band-intraday-momentum.md.

Rules (paper pages refer to the 2025-09-22 version):
- Noise Area (p. 6-7): sigma(t, HH:MM) = mean over the previous 14 sessions of
  |Close(HH:MM) / Open(9:30) - 1|. UpperBound = max(Open_t, Close_{t-1}) * (1 + sigma);
  LowerBound = min(Open_t, Close_{t-1}) * (1 - sigma).
- Decisions only at HH:00 and HH:30 (p. 9). Flat at the close (p. 9).
- Stops (p. 13): long exit when price < max(UB, VWAP); short exit when price > min(LB, VWAP).
  Base model (p. 9, 11): stop at the opposite band, reverse on a cross.
- Sizing (p. 10, 15): shares = AUM_{t-1} * min(4, 0.02 / sigma_SPY) / Open_t,
  sigma_SPY = sample stdev of the previous 14 daily returns; or 100% of AUM.
"""
from __future__ import annotations

import math
import statistics
from dataclasses import dataclass, field
from datetime import date
from typing import Literal, Sequence

Stop = Literal["band_vwap", "opposite_band"]
Sizing = Literal["vol_target", "full"]


@dataclass(frozen=True)
class Bar:
    """One regular-session minute bar. minute = minutes from 09:30 ET to the bar start."""

    minute: int
    open: float
    high: float
    low: float
    close: float
    volume: float


@dataclass(frozen=True)
class Session:
    day: date
    bars: tuple[Bar, ...]
    dividend: float = 0.0  # cash dividend with ex-date on this session


@dataclass(frozen=True)
class Params:
    lookback: int = 14
    band_mult: float = 1.0
    check_every: int = 30
    stop: Stop = "band_vwap"
    sizing: Sizing = "vol_target"
    target_vol: float = 0.02
    max_leverage: float = 4.0
    vol_lookback: int = 14
    commission_per_share: float = 0.0035
    slippage_bps: float = 1.0
    slippage_per_share: float = 0.0
    aum0: float = 100_000.0


@dataclass(frozen=True)
class Trade:
    day: date
    side: int
    shares: int
    entry_minute: int
    entry_price: float
    exit_minute: int
    exit_price: float
    exit_reason: str
    gross: float
    cost: float

    @property
    def net(self) -> float:
        return self.gross - self.cost


@dataclass(frozen=True)
class DayResult:
    day: date
    aum_start: float
    aum_end: float
    leverage: float
    traded: bool

    @property
    def ret(self) -> float:
        return self.aum_end / self.aum_start - 1.0


@dataclass
class BacktestResult:
    params: Params
    days: list[DayResult] = field(default_factory=list)
    trades: list[Trade] = field(default_factory=list)


def is_check_minute(minute: int, every: int) -> bool:
    """True when the bar ends on HH:00 or HH:30 (bar start minute + 1 is a multiple of `every`)."""
    end = minute + 1
    return end >= every and end % every == 0


def session_vwap(bars: Sequence[Bar]) -> list[float]:
    out: list[float] = []
    pv = 0.0
    vol = 0.0
    for bar in bars:
        pv += (bar.high + bar.low + bar.close) / 3.0 * bar.volume
        vol += bar.volume
        out.append(pv / vol if vol > 0 else bar.close)
    return out


def noise_sigmas(sessions: Sequence[Session], lookback: int) -> list[dict[int, float]]:
    """sigma per session and minute, using only the previous `lookback` sessions that have that minute.

    Requires lookback - 1 observations (as the authors' published code does); otherwise the minute has no sigma.
    """
    history: dict[int, list[float]] = {}
    out: list[dict[int, float]] = []
    for s in sessions:
        sig: dict[int, float] = {}
        for bar in s.bars:
            past = history.get(bar.minute, [])
            window = past[-lookback:]
            if len(window) >= lookback - 1:
                sig[bar.minute] = sum(window) / len(window)
        out.append(sig)
        o = s.bars[0].open
        for bar in s.bars:
            history.setdefault(bar.minute, []).append(abs(bar.close / o - 1.0))
    return out


def daily_vol(closes: Sequence[float], i: int, n: int) -> float | None:
    """Sample stdev of the n daily close-to-close returns ending at session i-1 (no lookahead)."""
    if i - n - 1 < 0:
        return None
    rets = [closes[j] / closes[j - 1] - 1.0 for j in range(i - n, i)]
    return statistics.stdev(rets)


def _fill(price: float, side: int, p: Params) -> float:
    """Execution price for a buy (side=+1) or sell (side=-1) after slippage."""
    return price * (1.0 + side * p.slippage_bps / 10_000.0) + side * p.slippage_per_share


def _signal(stop: Stop, pos: int, close: float, ub: float, lb: float, vwap: float) -> int:
    if stop == "band_vwap":
        if close > ub and close > vwap:
            return 1
        if close < lb and close < vwap:
            return -1
        return 0
    # opposite_band: hold until a cross of the other boundary, then reverse.
    if pos == 0:
        return 1 if close > ub else (-1 if close < lb else 0)
    if pos == 1:
        return -1 if close < lb else 1
    return 1 if close > ub else -1


def run_backtest(sessions: Sequence[Session], params: Params = Params()) -> BacktestResult:
    """Run the frozen rules over consecutive sessions. Sessions before warm-up are skipped (no trades)."""
    p = params
    result = BacktestResult(params=p)
    sigmas = noise_sigmas(sessions, p.lookback)
    closes = [s.bars[-1].close for s in sessions]
    aum = p.aum0
    for i, s in enumerate(sessions):
        if i < max(p.lookback, p.vol_lookback + 1):
            continue
        bars = s.bars
        open_ = bars[0].open
        prev_close = sessions[i - 1].bars[-1].close - s.dividend
        if p.sizing == "vol_target":
            vol = daily_vol(closes, i, p.vol_lookback)
            lev = p.max_leverage if not vol else min(p.max_leverage, p.target_vol / vol)
        else:
            lev = 1.0
        shares = round(aum * lev / open_)
        hi_ref = max(open_, prev_close)
        lo_ref = min(open_, prev_close)
        vwaps = session_vwap(bars)
        pos = 0
        entry: tuple[int, float] | None = None  # (minute, fill price)
        day_trades: list[Trade] = []

        def close_pos(exit_minute: int, raw_price: float, reason: str) -> None:
            nonlocal pos, entry
            assert entry is not None
            px = _fill(raw_price, -pos, p)
            gross = pos * shares * (px - entry[1])
            cost = 2 * shares * p.commission_per_share
            day_trades.append(Trade(s.day, pos, shares, entry[0], entry[1], exit_minute, px, reason, gross, cost))
            pos = 0
            entry = None

        last = len(bars) - 1
        for k, bar in enumerate(bars):
            if k == last or not is_check_minute(bar.minute, p.check_every):
                continue
            sigma = sigmas[i].get(bar.minute)
            if sigma is None or shares <= 0:
                continue
            band = p.band_mult * sigma
            ub = hi_ref * (1.0 + band)
            lb = lo_ref * (1.0 - band)
            target = _signal(p.stop, pos, bar.close, ub, lb, vwaps[k])
            if target == pos:
                continue
            nxt = bars[k + 1]
            if pos != 0:
                close_pos(nxt.minute, nxt.open, "reverse" if target else "stop")
            if target != 0:
                pos = target
                entry = (nxt.minute, _fill(nxt.open, target, p))
        if pos != 0:
            close_pos(bars[last].minute + 1, bars[last].close, "close")
        pnl = sum(t.net for t in day_trades)
        result.days.append(DayResult(s.day, aum, aum + pnl, lev, bool(day_trades)))
        result.trades.extend(day_trades)
        aum += pnl
    return result


@dataclass(frozen=True)
class Metrics:
    days: int
    trades: int
    total_return: float
    cagr: float
    vol: float
    sharpe: float
    max_drawdown: float
    daily_hit: float
    trade_hit: float
    avg_trades_per_day: float


def max_drawdown(equity: Sequence[float]) -> float:
    peak = -math.inf
    mdd = 0.0
    for e in equity:
        peak = max(peak, e)
        mdd = max(mdd, 1.0 - e / peak)
    return mdd


def metrics_from_returns(rets: Sequence[float], trades: Sequence[Trade] = (), traded_days: int | None = None,
                         positive_days: int | None = None) -> Metrics:
    n = len(rets)
    equity = [1.0]
    for r in rets:
        equity.append(equity[-1] * (1.0 + r))
    total = equity[-1] - 1.0
    cagr = equity[-1] ** (252.0 / n) - 1.0 if n else 0.0
    sd = statistics.stdev(rets) if n > 1 else 0.0
    mean = sum(rets) / n if n else 0.0
    sharpe = mean / sd * math.sqrt(252.0) if sd > 0 else 0.0
    td = traded_days if traded_days is not None else sum(1 for r in rets if r != 0)
    pdays = positive_days if positive_days is not None else sum(1 for r in rets if r > 0)
    wins = sum(1 for t in trades if t.net > 0)
    return Metrics(
        days=n,
        trades=len(trades),
        total_return=total,
        cagr=cagr,
        vol=sd * math.sqrt(252.0),
        sharpe=sharpe,
        max_drawdown=max_drawdown(equity),
        daily_hit=pdays / td if td else 0.0,
        trade_hit=wins / len(trades) if trades else 0.0,
        avg_trades_per_day=len(trades) / td if td else 0.0,
    )


def metrics(result: BacktestResult, days: Sequence[DayResult] | None = None) -> Metrics:
    ds = list(days if days is not None else result.days)
    keep = {d.day for d in ds}
    trades = [t for t in result.trades if t.day in keep]
    traded = [d for d in ds if d.traded]
    return metrics_from_returns([d.ret for d in ds], trades, len(traded), sum(1 for d in traded if d.ret > 0))


def halves(result: BacktestResult) -> tuple[list[DayResult], list[DayResult]]:
    """Split evaluated sessions into two equal-count halves by date."""
    mid = len(result.days) // 2
    return result.days[:mid], result.days[mid:]


def verdict(result: BacktestResult, min_trades: int = 300, min_sharpe: float = 0.5) -> str:
    """Pre-set rule: PASS only with >= min_trades and net Sharpe > min_sharpe in both halves."""
    if len(result.trades) < min_trades:
        return "inconclusive"
    first, second = halves(result)
    ok = all(metrics(result, h).sharpe > min_sharpe for h in (first, second))
    return "pass" if ok else "fail"
