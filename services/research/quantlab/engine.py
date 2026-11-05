"""Deterministic daily backtester for single-instrument timing specs.

NautilusTrader is not installed on this host (checked 2026-10-18) and the
repository's backtesting/ package plans and verifies runs but does not simulate
fills, so this module is the execution model for Quant Lab specs.

Timing: the signal uses only adjusted closes up to and including the decision
day. The trade fills at the next session's open (or close) with commission,
half-spread and slippage charged on traded notional. Cash earns the T-bill
rate (13-week yield, forward-filled) or zero. No leverage, no shorting.
This is bar-level simulation: no queue position, partial fills, borrow or tax.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import date

from .data import Bar

TRADING_DAYS = 252


@dataclass(frozen=True)
class Costs:
    commission_bps: float
    half_spread_bps: float
    slippage_bps: float

    @property
    def per_side(self) -> float:
        return (self.commission_bps + self.half_spread_bps + self.slippage_bps) / 10_000


@dataclass
class Run:
    dates: list[str]
    returns: list[float]          # daily net strategy returns, aligned with dates
    weights: list[float]          # weight held at the close of each day
    rf: list[float]               # daily cash return
    trades: list[dict] = field(default_factory=list)
    costs_paid: float = 0.0
    warmup_end: str | None = None


def rf_series(dates: list[str], rates: list[Bar] | None) -> list[float]:
    if rates is None:
        return [0.0] * len(dates)
    by_date = {bar.date: bar.close for bar in rates}
    out, last = [], None
    for day in dates:
        last = by_date.get(day, last)
        out.append(0.0 if last is None else (last / 100.0) / TRADING_DAYS)
    return out


def _is_month_end(dates: list[str], i: int) -> bool:
    return i + 1 == len(dates) or dates[i + 1][:7] != dates[i][:7]


def signals(bars: list[Bar], signal_type: str, lookback: int, unit: str) -> list[bool | None]:
    """Decision for each day using data up to that day. None = not enough history."""
    closes = [b.adj_close for b in bars]
    dates = [b.date for b in bars]
    out: list[bool | None] = []
    month_closes: list[float] = []
    for i, price in enumerate(closes):
        if unit == "months":
            history = month_closes + [price]  # completed month ends plus today's close
            if _is_month_end(dates, i):
                month_closes.append(price)
        else:
            history = closes[: i + 1]
        if signal_type == "price_above_sma":
            if len(history) < lookback:
                out.append(None)
            else:
                window = history[-lookback:]
                out.append(price > sum(window) / lookback)
        elif signal_type == "momentum":
            if len(history) <= lookback:
                out.append(None)
            else:
                out.append(price > history[-lookback - 1])
        else:
            raise ValueError(f"unsupported signal {signal_type}")
    return out


def simulate(bars: list[Bar], rf: list[float], *, signal_type: str, lookback: int, unit: str,
             rebalance: str, execution: str, weight: float, costs: Costs) -> Run:
    dates = [b.date for b in bars]
    decisions = signals(bars, signal_type, lookback, unit)
    returns, weights = [0.0], [0.0]
    held, pending = 0.0, None
    trades: list[dict] = []
    open_trade: dict | None = None
    paid = 0.0
    warmup_end = None
    for i in range(1, len(bars)):
        prev, bar = bars[i - 1], bars[i]
        growth = 1.0
        target = held if pending is None else pending
        if execution == "next_open":
            overnight = bar.adj_open / prev.adj_close - 1
            growth *= 1 + held * overnight + (1 - held) * rf[i]
            cost = abs(target - held) * costs.per_side
            growth *= 1 - cost
            intraday = bar.adj_close / bar.adj_open - 1
            growth *= 1 + target * intraday
            fill_px = bar.adj_open
        else:  # next_close: hold old weight through the day, trade at the close
            day_return = bar.adj_close / prev.adj_close - 1
            growth *= 1 + held * day_return + (1 - held) * rf[i]
            cost = abs(target - held) * costs.per_side
            growth *= 1 - cost
            fill_px = bar.adj_close
        if target != held:
            paid += cost
            if target > 0 and open_trade is None:
                open_trade = {"entry_t": bar.date, "entry_px": fill_px, "qty": target}
            elif target == 0 and open_trade is not None:
                trades.append(_close(open_trade, bar.date, fill_px, costs))
                open_trade = None
        held, pending = target, None
        returns.append(growth - 1)
        weights.append(held)
        decision = decisions[i]
        if decision is not None and warmup_end is None:
            warmup_end = bar.date
        if decision is not None and (rebalance == "daily" or _is_month_end(dates, i)):
            wanted = weight if decision else 0.0
            if wanted != held:
                pending = wanted
    if open_trade is not None:
        trades.append({**_close(open_trade, bars[-1].date, bars[-1].adj_close, costs), "open": True})
    return Run(dates, returns, weights, rf, trades, paid, warmup_end)


def _close(trade: dict, day: str, price: float, costs: Costs) -> dict:
    gross = price / trade["entry_px"] - 1
    net = (1 - costs.per_side) * (1 + gross) * (1 - costs.per_side) - 1
    return {"entry_t": trade["entry_t"], "exit_t": day, "side": "long", "qty": round(trade["qty"], 6),
            "entry_px": round(trade["entry_px"], 4), "exit_px": round(price, 4), "pnl": round(net, 6),
            "commission": round(2 * costs.per_side, 6)}


def metrics(returns: list[float], rf: list[float], weights: list[float] | None = None) -> dict:
    n = len(returns)
    if n < 2:
        return {}
    equity, peak, max_dd = 1.0, 1.0, 0.0
    for r in returns:
        equity *= 1 + r
        peak = max(peak, equity)
        max_dd = min(max_dd, equity / peak - 1)
    years = n / TRADING_DAYS
    mean = sum(returns) / n
    var = sum((r - mean) ** 2 for r in returns) / (n - 1)
    excess = [r - f for r, f in zip(returns, rf)]
    ex_mean = sum(excess) / n
    ex_sd = math.sqrt(sum((x - ex_mean) ** 2 for x in excess) / (n - 1))
    out = {
        "total_return": round(equity - 1, 6),
        "cagr": round(equity ** (1 / years) - 1, 6) if equity > 0 else -1.0,
        "ann_vol": round(math.sqrt(var * TRADING_DAYS), 6),
        "sharpe": round(ex_mean / ex_sd * math.sqrt(TRADING_DAYS), 4) if ex_sd > 0 else 0.0,
        "max_drawdown": round(max_dd, 6),
        "years": round(years, 2),
    }
    if weights is not None:
        out["time_in_market"] = round(sum(1 for w in weights if w > 0) / n, 4)
        switches = sum(1 for a, b in zip(weights, weights[1:]) if a != b)
        out["switches_per_year"] = round(switches / years, 2)
    return out


def window(run: Run, start: str, end: str) -> tuple[list[float], list[float], list[float]]:
    idx = [i for i, d in enumerate(run.dates) if start <= d <= end]
    return [run.returns[i] for i in idx], [run.rf[i] for i in idx], [run.weights[i] for i in idx]


def add_years(day: str, years: int) -> str:
    d = date.fromisoformat(day)
    try:
        return d.replace(year=d.year + years).isoformat()
    except ValueError:
        return d.replace(year=d.year + years, day=28).isoformat()


def walk_forward(bars: list[Bar], rf: list[float], *, spec: dict, costs: Costs, start: str) -> dict:
    """Rolling walk-forward: pick lookback on each train window, apply it to the next test window."""
    signal, rebalance, sizing = spec["signal"], spec["rebalance"], spec["sizing"]
    walk = spec["validation"]["walk_forward"]
    objective = walk["objective"]
    runs = {lb: simulate(bars, rf, signal_type=signal["type"], lookback=lb, unit=signal["lookback_unit"],
                         rebalance=rebalance["frequency"], execution=rebalance["execution"],
                         weight=sizing["weight"], costs=costs)
            for lb in walk["lookback_grid"]}
    last = bars[-1].date
    folds, stitched, stitched_rf, stitched_w, stitched_dates = [], [], [], [], []
    train_start = start
    previous_weight = 0.0
    while True:
        train_end = add_years(train_start, walk["train_years"])
        test_end = min(add_years(train_end, walk["test_years"]), last)
        if train_end >= last:
            break
        scores = {}
        for lb, run in runs.items():
            r, f, w = window(run, train_start, train_end)
            m = metrics(r, f, w)
            scores[lb] = m.get(objective, float("-inf"))
        chosen = max(sorted(scores), key=lambda lb: scores[lb])  # ties -> smallest lookback
        run = runs[chosen]
        idx = [i for i, d in enumerate(run.dates) if train_end < d <= test_end]
        if not idx:
            break
        returns = [run.returns[i] for i in idx]
        entry_weight = run.weights[idx[0] - 1]
        if entry_weight != previous_weight:  # switching parameter changes the held weight at the boundary
            returns[0] = (1 + returns[0]) * (1 - abs(entry_weight - previous_weight) * costs.per_side) - 1
        previous_weight = run.weights[idx[-1]]
        stitched += returns
        stitched_rf += [run.rf[i] for i in idx]
        stitched_w += [run.weights[i] for i in idx]
        stitched_dates += [run.dates[i] for i in idx]
        test_metrics = metrics(returns, [run.rf[i] for i in idx], [run.weights[i] for i in idx])
        folds.append({"label": f"WF{len(folds) + 1} lb={chosen}", "train_start": train_start, "train_end": train_end,
                      "test_start": run.dates[idx[0]], "test_end": run.dates[idx[-1]],
                      "metrics": {"chosen_lookback": chosen, f"train_{objective}": round(scores[chosen], 4),
                                  **{k: test_metrics[k] for k in ("cagr", "sharpe", "max_drawdown", "time_in_market")}}})
        train_start = add_years(train_start, walk["test_years"])
        if test_end >= last:
            break
    return {"folds": folds, "dates": stitched_dates, "returns": stitched, "rf": stitched_rf, "weights": stitched_w,
            "metrics": metrics(stitched, stitched_rf, stitched_w)}


def buy_and_hold(bars: list[Bar], rf: list[float], costs: Costs) -> Run:
    returns = [0.0]
    for i in range(1, len(bars)):
        returns.append(bars[i].adj_close / bars[i - 1].adj_close - 1)
    returns[1] = (1 + returns[1]) * (1 - costs.per_side) - 1
    return Run([b.date for b in bars], returns, [0.0] + [1.0] * (len(bars) - 1), rf)
