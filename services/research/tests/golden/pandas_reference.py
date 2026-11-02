"""Independent pandas reference for the golden backtest battery.

This module is a second code path. It shares no code with the Vertex engine
(packages/api/src/instant-backtest-engine.ts) or the Vertex indicator library.
The engine walks bars in a loop and holds cash and units; this module builds a
target-position column with vectorized pandas operations and compounds per-bar
growth factors. Agreement between the two paths is the evidence.

Shared conventions (stated in docs/golden-battery/README.md, not shared code):

- Bars are total-return bars: open, high, low and close are scaled by adj_close/close.
- A signal uses data up to the close of bar i. The fill is at the open of bar i + 1.
- Long only, fully invested or flat. Cost is charged in basis points of the traded
  value on entry and on exit. A position still open after the last bar is closed
  at the last close.
- Statistics: simple per-bar returns, risk-free rate 0, annualized with the observed
  number of bars per elapsed calendar year (365.25 days).

Research use only. Nothing here creates or routes orders.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pandas as pd

YEAR_DAYS = 365.25


@dataclass(frozen=True)
class SmaCross:
    fast: int
    slow: int
    kind: str = "smaCross"


@dataclass(frozen=True)
class RsiReversion:
    period: int
    oversold: float
    overbought: float
    kind: str = "rsiReversion"


Rule = SmaCross | RsiReversion


def load_bars(path: Path) -> pd.DataFrame:
    """Read the fixture CSV and return total-return OHLC bars with a UTC date index."""
    raw = pd.read_csv(path, dtype={"date": str})
    factor = raw["adj_close"] / raw["close"]
    bars = pd.DataFrame(
        {
            "open": raw["open"] * factor,
            "high": raw["high"] * factor,
            "low": raw["low"] * factor,
            "close": raw["close"] * factor,
        }
    )
    bars.index = pd.to_datetime(raw["date"], utc=True)
    return bars


def wilder_rsi(close: pd.Series, period: int) -> pd.Series:
    """Wilder RSI: averages seeded with the plain mean of the first `period` changes."""
    change = close.diff()
    gain = change.clip(lower=0.0)
    loss = (-change).clip(lower=0.0)

    def smoothed(values: pd.Series) -> pd.Series:
        seeded = values.copy()
        seeded.iloc[:period] = np.nan
        seeded.iloc[period] = values.iloc[1 : period + 1].mean()
        tail = seeded.iloc[period:].ewm(alpha=1.0 / period, adjust=False).mean()
        return tail.reindex(values.index)

    average_gain = smoothed(gain)
    average_loss = smoothed(loss)
    total = average_gain + average_loss
    rsi = 100.0 * average_gain / total
    return rsi.where(total != 0, 50.0)


def smma(values: pd.Series, period: int) -> pd.Series:
    """Wilder smoothing (RMA): SMA seed, then alpha 1/period."""
    seeded = values.copy()
    seeded.iloc[: period - 1] = np.nan
    seeded.iloc[period - 1] = values.iloc[:period].mean()
    tail = seeded.iloc[period - 1 :].ewm(alpha=1.0 / period, adjust=False).mean()
    return tail.reindex(values.index)


def target_state(bars: pd.DataFrame, rule: Rule) -> pd.Series:
    """1 when the rule wants to be long after the close of the bar, else 0."""
    close = bars["close"]
    if isinstance(rule, SmaCross):
        fast = close.rolling(rule.fast).mean()
        slow = close.rolling(rule.slow).mean()
        return (fast > slow).astype(float)
    rsi = wilder_rsi(close, rule.period)
    wanted = pd.Series(np.nan, index=close.index)
    wanted[rsi < rule.oversold] = 1.0
    wanted[rsi > rule.overbought] = 0.0
    return wanted.ffill().fillna(0.0)


def backtest(bars: pd.DataFrame, rule: Rule, cost_bps: float) -> dict:
    cost = cost_bps / 10_000.0
    opens = bars["open"].to_numpy()
    closes = bars["close"].to_numpy()
    held = target_state(bars, rule).shift(1, fill_value=0.0).to_numpy()
    before = np.concatenate(([0.0], held[:-1]))
    previous_close = np.concatenate(([np.nan], closes[:-1]))
    entered = (held == 1) & (before == 0)
    kept = (held == 1) & (before == 1)
    left = (held == 0) & (before == 1)
    growth = np.ones(len(bars))
    growth[entered] = (1 - cost) * closes[entered] / opens[entered]
    growth[kept] = closes[kept] / previous_close[kept]
    growth[left] = (1 - cost) * opens[left] / previous_close[left]
    if held[-1] == 1:
        growth[-1] *= 1 - cost
    equity = pd.Series(np.cumprod(growth), index=bars.index)
    trades = _trades(held, equity.to_numpy(), opens, closes)
    return {"trades": trades, "stats": _stats(bars, equity, held, trades)}


def _trades(held: np.ndarray, equity: np.ndarray, opens: np.ndarray, closes: np.ndarray) -> list[dict]:
    flags = pd.Series(held)
    starts = flags.index[(flags == 1) & (flags.shift(1, fill_value=0) == 0)]
    ends = flags.index[(flags == 1) & (flags.shift(-1, fill_value=0) == 0)]
    last = len(held) - 1
    trades = []
    for entry, final in zip(starts, ends, strict=True):
        at_end = final == last
        exit_index = int(final if at_end else final + 1)
        before = equity[entry - 1]
        trades.append(
            {
                "entryIndex": int(entry),
                "exitIndex": exit_index,
                "entryPrice": float(opens[entry]),
                "exitPrice": float(closes[last] if at_end else opens[exit_index]),
                "netReturn": float(equity[exit_index] / before - 1),
                "pnl": float(equity[exit_index] - before),
                "exitReason": "end" if at_end else "signal",
            }
        )
    return trades


def _drawdown(series: pd.Series) -> float:
    return float((series / series.cummax() - 1).min())


def _stats(bars: pd.DataFrame, equity: pd.Series, held: np.ndarray, trades: list[dict]) -> dict:
    years = (bars.index[-1] - bars.index[0]).total_seconds() / (YEAR_DAYS * 86_400)
    returns = equity.pct_change().iloc[1:]
    scale = math.sqrt(len(returns) / years)
    deviation = returns.std(ddof=1)
    downside = math.sqrt(float((returns.clip(upper=0.0) ** 2).mean()))
    pnl = pd.Series([trade["pnl"] for trade in trades], dtype=float)
    gross_win = float(pnl[pnl > 0].sum())
    gross_loss = float(-pnl[pnl <= 0].sum())
    total = float(equity.iloc[-1] / equity.iloc[0])
    return {
        "bars": len(bars),
        "finalEquity": float(equity.iloc[-1]),
        "totalReturn": total - 1,
        "cagr": total ** (1 / years) - 1,
        "maxDrawdown": _drawdown(equity),
        "sharpe": float(returns.mean() / deviation * scale) if deviation > 0 else None,
        "sortino": float(returns.mean() / downside * scale) if downside > 0 else None,
        "trades": len(trades),
        "winRate": float((pnl > 0).mean()) if len(trades) else None,
        "profitFactor": gross_win / gross_loss if gross_loss > 0 else None,
        "exposure": float(held.sum() / len(held)),
        "buyHoldReturn": float(bars["close"].iloc[-1] / bars["close"].iloc[0] - 1),
        "buyHoldMaxDrawdown": _drawdown(bars["close"]),
    }
