"""Statistics and verdicts of the leveraged-ETF short-window study (research only; pure functions).

- `worst_48h_loss`: NEW metric. The most negative change of the daily equity over any 2 consecutive
  sessions, in percent of the equity at the start of those 2 sessions (the close before the first of
  them; the start capital for the first session). 0 when no 2-session change is negative.
- `row_stats`: the statistics of one booked row on New York days, from the existing functions:
  qc_ports.metrics.summarize (Sharpe, deflated Sharpe, CAGR, max drawdown), allocation
  out_of_sample_sharpe (last 40% of the days) and monte_carlo (bootstrap of the trade profits).
- `verdicts`: per form row = signal x regime x window x form:
  `gate` = allocation.gate_checks; its baseline check compares with the `etf-option` row of the same
  signal, regime and window (0 for that row itself). `lowerBar` = the owner's lower bar (the function
  is passed in: it lives in research/backtests/allocation/funded_pie.py). `leverageHelps` (only
  `lev-*` rows) = the row's Sharpe is above the Sharpe of its unleveraged twin row. It compares two
  Sharpes and nothing else: `yes` also when both rows lose (the less negative one is above). When the
  twin row has no booked trade there is nothing to compare with: `helps` is None and `reason` says so
  (no verdict). A row passes only when `gate` passes. A Sharpe that does not exist (no booked trade)
  counts as 0 in the baseline check of the gate and fails every check that needs it; a `lev-*` row
  without a booked trade does not help.
"""
from __future__ import annotations

import math
from collections.abc import Callable, Mapping, Sequence
from datetime import date
from statistics import mean, median, variance

from strategies.qc_ports import allocation as al
from strategies.qc_ports.ledger import LedgerResult
from strategies.qc_ports.metrics import max_drawdown, summarize

__all__ = ["BASELINE_FORM", "KEY_SEPARATOR", "TWIN_FORM", "daily_sharpe", "monthly_points", "row_key", "row_stats",
           "split_key", "trial_variance", "verdicts", "worst_48h_loss"]

KEY_SEPARATOR = "/"
BASELINE_FORM = "etf-option"
# The unleveraged twin a `lev-*` row is compared with.
TWIN_FORM = {"lev-option": "etf-option", "lev-vertical": "etf-vertical", "lev-shares": "etf-option"}


def row_key(signal: str, regime: str, window: str, form: str) -> str:
    return KEY_SEPARATOR.join((signal, regime, window, form))


def split_key(key: str) -> tuple[str, str, str, str]:
    parts = key.split(KEY_SEPARATOR)
    if len(parts) != 4:
        raise ValueError(f"Not a form row key: {key}")
    return parts[0], parts[1], parts[2], parts[3]


def worst_48h_loss(dates: Sequence[str], equity: Sequence[float], capital: float) -> dict | None:
    """{"pct", "from", "to"}: the most negative 2-session change of the equity in percent of the equity
    at the start of the 2 sessions, and the first and second of those sessions. `pct` is 0 (and the
    sessions None) when no 2-session change is negative. None with fewer than 2 sessions."""
    if len(dates) != len(equity):
        raise ValueError("dates and equity must have the same length")
    if not (math.isfinite(capital) and capital > 0) or not all(math.isfinite(v) and v > 0 for v in equity):
        raise ValueError("capital and equity must be finite and above 0")
    if len(equity) < 2:
        return None
    values = [capital, *equity]
    worst, at = 0.0, None
    for index in range(len(equity) - 1):
        change = values[index + 2] / values[index] - 1
        if change < worst:
            worst, at = change, index
    return {"pct": worst * 100, "from": None if at is None else dates[at], "to": None if at is None else dates[at + 1]}


def daily_sharpe(result: LedgerResult) -> float:
    """Sharpe per day (not annualized) of a run; 0 without variation. The input of the trial variance."""
    return al.sharpe(al.daily_returns(result.equity)) / math.sqrt(al.TRADING_DAYS)


def trial_variance(sharpes: Sequence[float]) -> float | None:
    """Variance of the per-day Sharpes of the trials (None under 2 trials)."""
    return variance(sharpes) if len(sharpes) >= 2 else None


def monthly_points(result: LedgerResult) -> list[dict]:
    """Month-end points of the equity: return since the start and drawdown from the running peak."""
    last: dict[str, float] = {}
    for day, value in zip(result.dates, result.equity):
        last[day[:7]] = value
    out, peak = [], result.capital
    for month, value in last.items():
        peak = max(peak, value)
        out.append({"month": month, "value": value / result.capital - 1, "drawdown": min(0.0, value / peak - 1)})
    return out


def _cagr(first: float, last: float, start: str, end: str) -> float | None:
    years = (date.fromisoformat(end) - date.fromisoformat(start)).days / 365.25
    return (last / first) ** (1 / years) - 1 if years > 0 and first > 0 and last > 0 else None


def row_stats(result: LedgerResult, trade_returns: Sequence[float], n_trials: int,
              sharpe_variance: float | None) -> dict:
    """Statistics of one booked row. `result` is on New York days (forms.daily_result); `trade_returns`
    = profit of each booked trade over the equity before its entry (fractions)."""
    stats = summarize(result, n_trials=n_trials, sharpe_variance=sharpe_variance)
    pnls = [trade["pnl"] for trade in result.trades]
    split_day, oos = al.out_of_sample_sharpe(result)
    split = result.dates.index(split_day)
    oos_base = result.equity[split - 1] if split > 0 else result.capital
    entries = sorted(trade["entryDate"] for trade in result.trades)
    gains = sum(pnl for pnl in pnls if pnl > 0)
    losses = -sum(pnl for pnl in pnls if pnl < 0)
    percent = [value * 100 for value in trade_returns]
    return {
        "start": stats["start"], "end": stats["end"], "days": stats["days"],
        "firstTrade": entries[0] if entries else None, "lastTrade": entries[-1] if entries else None,
        "trades": stats["trades"], "refused": len(result.skipped), "winRate": stats["winRate"],
        "meanTradePct": mean(percent) if percent else None, "medianTradePct": median(percent) if percent else None,
        "worstTradePct": min(percent) if percent else None,
        "sharpe": stats["sharpe"], "oosStart": split_day, "oosSharpe": oos if stats["sharpe"] is not None else None,
        "oosCagr": _cagr(oos_base, result.equity[-1], split_day, result.dates[-1]),
        "deflatedSharpe": stats["deflatedSharpe"], "expectedMaxSharpe": stats["expectedMaxSharpe"],
        "nTrials": n_trials, "maxDrawdown": stats["maxDrawdown"], "cagr": stats["cagr"],
        "totalReturn": stats["totalReturn"], "finalEquity": stats["finalEquity"], "exposure": stats["exposure"],
        "profitFactor": gains / losses if losses > 0 else None,
        "monteCarlo": al.monte_carlo(pnls, result.capital),
        "worst48hLoss": worst_48h_loss(result.dates, result.equity, result.capital),
        "oosMaxDrawdown": max_drawdown([oos_base, *result.equity[split:]]),
    }


def _number(value) -> float:
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) else 0.0


def _text(value) -> str:
    return "none" if value is None else f"{value:.2f}"


def verdicts(rows: Mapping[str, Mapping], gate_checks: Callable[[Mapping, float | None], list[dict]],
             lower_bar: Callable[[Mapping], bool]) -> dict[str, dict]:
    """Verdicts per form row key (row_key) from the row statistics: `gate`, `lowerBar`, `leverageHelps`
    (None for an `etf-*` row; its `helps` is None, with a `reason`, when the twin row has no booked
    trade) and `passes` (= gate passes). Each verdict has `text`, its words."""
    out: dict[str, dict] = {}
    for key, stats in rows.items():
        signal, regime, window, form = split_key(key)
        sharpe = stats.get("sharpe")
        if form == BASELINE_FORM:
            baseline, named = 0.0, "0 (this row is the baseline)"
        else:
            baseline_key = row_key(signal, regime, window, BASELINE_FORM)
            if baseline_key not in rows:
                raise ValueError(f"{key}: its baseline row {baseline_key} is missing")
            baseline = _number(rows[baseline_key].get("sharpe"))
            named = f"{baseline:.2f} of {BASELINE_FORM}"
        checks = gate_checks(stats, baseline)
        failed = [check["check"] for check in checks if not check["pass"]]
        gate = {"pass": not failed, "failed": failed, "baselineSharpe": baseline, "checks": checks,
                "text": "pass: every check of the allocation gate holds" if not failed
                else f"fail: {'; '.join(failed)} (baseline Sharpe {named})"}
        bar_ok = sharpe is not None and bool(lower_bar(stats))
        bar = {"pass": bar_ok, "text": "pass: the owner's lower bar holds" if bar_ok
               else "fail: the owner's lower bar does not hold"}
        helps = None
        if form in TWIN_FORM:
            twin_key = row_key(signal, regime, window, TWIN_FORM[form])
            if twin_key not in rows:
                raise ValueError(f"{key}: its twin row {twin_key} is missing")
            twin = rows[twin_key].get("sharpe")
            if twin is None or not rows[twin_key].get("trades"):
                reason = f"the twin row {TWIN_FORM[form]} has no booked trade"
                helps = {"helps": None, "sharpe": sharpe, "twin": TWIN_FORM[form], "twinSharpe": twin,
                         "reason": reason, "text": f"no verdict: {reason}"}
            else:
                yes = sharpe is not None and sharpe > _number(twin)
                helps = {"helps": yes, "sharpe": sharpe, "twin": TWIN_FORM[form], "twinSharpe": twin, "reason": None,
                         "text": f"{'yes' if yes else 'no'}: Sharpe {_text(sharpe)} against {_text(twin)} of "
                                 f"{TWIN_FORM[form]}"}
        out[key] = {"gate": gate, "lowerBar": bar, "leverageHelps": helps, "passes": gate["pass"]}
    return out
