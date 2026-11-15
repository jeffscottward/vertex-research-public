"""Books the rule's trades through the Nautilus engine (research only, no orders).

`rules.py` decides the trades; this module replays them in `nautilus_backtest.run_signal_backtest` (the
precomputed-signal path of the market-intraday-momentum BIAS signal), so the fills, the stop orders, the
costs and the equity curve come from NautilusTrader:
- One Nautilus run per side (the engine holds one side per run), each from 100,000 USD; the study sums the
  two legs' daily returns. The legs never hold together (one position at a time).
- Bars: Nautilus gets the 1-minute bars a trade needs (the bar before the entry to the exit bar of every
  trade of that side), not every 1-minute bar of the market. Between trades the account is flat, so the
  equity of the skipped bars is the last equity. Recorded as a deviation in the spec.
- Signals: 1 on the bar before the entry (the entry is a market order at the next open), an exit mark on the
  bar before an opposite-signal or time-stop exit, and the stop distance of the trade. The stop is a resting
  stop-market order placed by the engine at entry price -/+ distance.
- Size: riskPct 0.5 (0.5 % of the cash at the stop), notional capped at 50x (never reached).
- Costs are charged by the engine's fee model as commission, so they do not move the entry price or the
  stop: a rate on the fill value (half the spread + slippage, or the source's cost for a percent stop), a
  per-unit amount (the source's 0.63 points per side on NAS100) and, for ETFs, the IBKR Pro Fixed preset.
- `book_leg` raises when Nautilus and rules.py disagree on the number of trades or on a fill bar.
"""
from __future__ import annotations

import math
from collections.abc import Sequence
from typing import Any

import numpy as np

from nautilus_backtest.bars import Bars
from nautilus_backtest.costs import COST_PROFILE_PRESETS, ZERO_COST_PROFILE
from nautilus_backtest.engine import ENGINE_ID, run_signal_backtest, run_spec
from nautilus_backtest.signals import Compiled, RunOptions

from . import rules

CAPITAL = 100_000.0
RISK_PCT = 0.5
MAX_LEVERAGE = 50.0
SLIPPAGE_BPS = 0.25
BPS = 10_000
ETF_PRESET = "ibkr-pro-fixed-us-stock"
PRICE_TOLERANCE = 1e-6  # relative

Point = tuple[str, float]


class BookingMismatch(RuntimeError):
    """Nautilus and rules.py disagree on a trade."""


# ------------------------------------------------------------------------------------------------
# Costs


def vertex_costs(spread_bps: float, etf: bool, multiple: float = 1.0) -> rules.Costs:
    """Vertex costs per side: half the measured spread + 0.25 bp slippage (both times `multiple`); ETFs add
    the IBKR Pro Fixed commission and fees per share and the SEC fee on sales (not multiplied)."""
    rate = (spread_bps / 2 + SLIPPAGE_BPS) / BPS * multiple
    if not etf:
        return rules.Costs(rate=rate)
    preset = COST_PROFILE_PRESETS[ETF_PRESET]
    return rules.Costs(per_unit=preset["commission"]["perShare"] + preset["fees"]["perUnit"], rate=rate,
                       sale_rate=preset["fees"]["ofSaleValue"])


def profile_of(costs: rules.Costs, etf: bool, name: str) -> dict[str, Any]:
    """The Nautilus cost profile that charges `costs` as commission (no price move, so the stop stays put)."""
    if costs.stop_fraction:
        raise ValueError("A cost per stop distance has no engine profile; it is rules.py arithmetic only")
    base = COST_PROFILE_PRESETS[ETF_PRESET] if etf else ZERO_COST_PROFILE
    commission = {**base["commission"], "percentOfValue": costs.rate * 100}
    if not etf:
        commission["perShare"] = costs.per_unit
    return {**base, "commission": commission, "id": f"volspike-{name}"[:60],
            "label": f"Volume spike {name}: {costs.rate * BPS:.3f} bp of value + {costs.per_unit:g} per unit per side",
            "source": "custom"}


# ------------------------------------------------------------------------------------------------
# Leg plans (built in the parent process from the 1-minute bars; workers get only these)


def leg_plan(m: rules.Minutes, trades: Sequence[rules.Trade], side: int) -> dict[str, Any] | None:
    """The bars and signals Nautilus needs for the trades of one side; None without such trades."""
    mine = [t for t in trades if t.side == side]
    if not mine:
        return None
    index = np.unique(np.concatenate([np.arange(t.entry_index - 1, t.exit_index + 1) for t in mine]))
    if index[0] < 0:
        raise ValueError("A trade enters on the first bar: no bar carries its signal")
    signals = np.zeros(index.shape[0], dtype=np.int8)
    exits = np.zeros(index.shape[0], dtype=np.int8)
    stop = np.full(index.shape[0], np.nan)
    for t in mine:
        at = int(np.searchsorted(index, t.entry_index - 1))
        signals[at] = 1
        stop[at] = t.stop
        if t.reason in ("opposite", "time"):
            exits[int(np.searchsorted(index, t.exit_index - 1))] = 1
    return {
        "side": rules.SIDE_NAME[side], "index": index, "t": m.t[index].astype(np.float64),
        "o": rules.prices(m.o[index]), "h": rules.prices(m.h[index]), "l": rules.prices(m.l[index]),
        "c": rules.prices(m.c[index]),
        "signals": signals, "exits": exits, "stop": stop, "day": rules.session_day(m.t[index]),
        "trades": [(t.entry_index, t.exit_index, t.stop, t.reason, t.entry, t.exit, t.r_gross, t.r_net) for t in mine],
    }


def book_leg(job: dict[str, Any]) -> dict[str, Any]:
    """Worker entry (picklable): one leg plan and its cost profile through Nautilus. Returns the equity at the
    last fed bar of each session day and the trades with their R multiples."""
    plan, profile = job["plan"], job["profile"]
    index = plan["index"]
    bars = Bars(t=tuple(plan["t"].tolist()), o=tuple(plan["o"].tolist()), h=tuple(plan["h"].tolist()),
                l=tuple(plan["l"].tolist()), c=tuple(plan["c"].tolist()))
    compiled = Compiled(signals=tuple(int(x) for x in plan["signals"]), exits=tuple(int(x) for x in plan["exits"]),
                        stop_distance=tuple(plan["stop"].tolist()), target_distance=None)
    options = RunOptions(cost_bps=0, stop_loss_pct=0, take_profit_pct=0,
                         costs={"profile": profile, "capital": job.get("capital", CAPITAL)},
                         risk_pct=job.get("riskPct", RISK_PCT), max_leverage=MAX_LEVERAGE, side=plan["side"])
    result = run_signal_backtest(bars, compiled, options)
    planned = plan["trades"]
    if len(result.trades) != len(planned):
        raise BookingMismatch(f"{job.get('name', '?')} {plan['side']}: Nautilus booked {len(result.trades)} trades, "
                              f"rules.py has {len(planned)}")
    equity = result.equity
    side = rules.LONG if plan["side"] == "long" else rules.SHORT
    trades = []
    worst = 0.0
    for trade, (entry_index, exit_index, stop, reason, entry, exit_, r_gross, r_net) in zip(result.trades, planned):
        e, x = trade["entryIndex"], trade["exitIndex"]
        if int(index[e]) != entry_index or int(index[x]) != exit_index:
            raise BookingMismatch(f"{job.get('name', '?')} {plan['side']}: fill bars {int(index[e])}/{int(index[x])} "
                                  f"differ from rules.py {entry_index}/{exit_index}")
        if (abs(trade["entryPrice"] - entry) > PRICE_TOLERANCE * abs(entry)
                or abs(trade["exitPrice"] - exit_) > PRICE_TOLERANCE * abs(exit_)):
            raise BookingMismatch(f"{job.get('name', '?')} {plan['side']}: fill prices {trade['entryPrice']}/"
                                  f"{trade['exitPrice']} differ from rules.py {entry}/{exit_}")
        risk = trade["units"] * stop
        net = trade["pnl"] / risk
        gross = trade.get("grossPnl", trade["pnl"]) / risk
        worst = max(worst, abs(net - r_net))
        trades.append({
            "side": plan["side"], "entryIndex": entry_index, "exitIndex": exit_index,
            "entryMs": int(plan["t"][e]), "exitMs": int(plan["t"][x]), "entry": trade["entryPrice"],
            "exit": trade["exitPrice"], "stop": stop,
            "reason": reason if trade["exitReason"] == "signal" else trade["exitReason"], "rulesReason": reason,
            "pnl": trade["pnl"], "before": equity[e - 1] if e > 0 else 1.0, "units": trade["units"],
            "rNet": net, "rGross": gross, "rRules": r_net, "rGrossRules": r_gross,
            "day": rules.day_text(plan["day"][e]), "holdMinutes": (int(plan["t"][x]) - int(plan["t"][e])) / 60_000,
            "sideSign": side,
        })
    day = plan["day"]
    last_of_day = np.flatnonzero(np.concatenate((day[1:] != day[:-1], [True])))
    return {"name": job.get("name"), "side": plan["side"], "trades": trades, "bars": int(index.shape[0]),
            "dayEquity": [(int(day[i]), float(equity[i])) for i in last_of_day], "maxRDiff": worst,
            "engine": result.engine}


def leg_points(calendar: Sequence[int], day_equity: Sequence[tuple[int, float]]) -> list[Point]:
    """Daily equity of one leg on the session days of `calendar` (the first day is the base, 1.0): the equity
    of the last fed bar of a day, else the last known equity (the account is flat between trades)."""
    known = dict(day_equity)
    value = 1.0
    out: list[Point] = []
    for position, day in enumerate(calendar):
        if position > 0 and day in known:
            value = known[day]
        out.append((rules.day_text(day), value))
    return out


def calendar_of(m: rules.Minutes, start_ms: int, end_ms: int) -> list[int]:
    """Session day numbers of the bars in [start_ms, end_ms), preceded by the last session day before it (the
    base of the equity curve)."""
    first = int(np.searchsorted(m.t, start_ms, side="left"))
    last = int(np.searchsorted(m.t, end_ms, side="left"))
    days = np.unique(rules.session_day(m.t[first:last]))
    if days.shape[0] == 0:
        return []
    base = int(rules.session_day(m.t[first - 1:first])[0]) if first > 0 else int(days[0]) - 1
    if base >= int(days[0]):
        base = int(days[0]) - 1
    return [base, *(int(d) for d in days)]


def daily_closes(m: rules.Minutes, calendar: Sequence[int]) -> list[Point]:
    """(session day, last close) on the calendar days (buy and hold of the market)."""
    if not calendar:
        return []
    day = rules.session_day(m.t)
    last_of_day = np.flatnonzero(np.concatenate((day[1:] != day[:-1], [True])))
    close = {int(day[i]): float(m.c[i]) for i in last_of_day}
    wanted = set(calendar)
    out: list[Point] = []
    previous = None
    for d in sorted(close):
        if d in wanted:
            out.append((rules.day_text(d), close[d]))
        elif d < calendar[0]:
            previous = close[d]
    if out and out[0][0] != rules.day_text(calendar[0]) and previous is not None:
        out.insert(0, (rules.day_text(calendar[0]), previous))
    return out


# ------------------------------------------------------------------------------------------------
# DSL form


def regular_session_bars(m: rules.Minutes, minutes: int = rules.SIGNAL_MINUTES) -> dict[str, list[float]]:
    """Candles of the New York regular session (09:30 to 16:00, weekdays) as engine columns."""
    cd = rules.build_candles(m, minutes)
    keep = (cd.open_minute >= 9 * 60 + 30) & (cd.open_minute < 16 * 60) & (cd.weekday < 5)
    return {"t": cd.start[keep].astype(np.float64).tolist(), "o": cd.o[keep].tolist(), "h": cd.h[keep].tolist(),
            "l": cd.l[keep].tolist(), "c": cd.c[keep].tolist(), "v": cd.v[keep].tolist()}


def run_dsl_leg(job: dict[str, Any]) -> dict[str, Any]:
    """Worker entry: one DSL leg (definition.py) through `run_spec` on 15-minute regular-session bars."""
    bars = Bars.from_columns(job["columns"])
    spec = {"rule": {"kind": "dsl", "definition": job["definition"]}, "costBps": 0,
            "costs": {"profile": job["profile"], "capital": job.get("capital", CAPITAL)}, "timeframe": "15m"}
    result = run_spec(bars, spec)
    local = rules.ny_local_ms(np.asarray(bars.t, dtype=np.int64))
    day = local // rules.DAY_MS
    last_of_day = np.flatnonzero(np.concatenate((day[1:] != day[:-1], [True])))
    equity = result.equity
    trades = []
    for trade in result.trades:
        e, x = trade["entryIndex"], trade["exitIndex"]
        trades.append({"side": job["side"], "entryMs": int(bars.t[e]), "exitMs": int(bars.t[x]),
                       "entry": trade["entryPrice"], "exit": trade["exitPrice"], "reason": trade["exitReason"],
                       "pnl": trade["pnl"], "before": equity[e - 1] if e > 0 else 1.0,
                       "day": rules.day_text(day[e]),
                       "holdMinutes": (bars.t[x] - bars.t[e]) / 60_000})
    return {"name": job.get("name"), "side": job["side"], "trades": trades, "bars": len(bars),
            "dayEquity": [(int(day[i]), float(equity[i])) for i in last_of_day],
            "exposure": float(result.stats.get("exposure") or 0.0), "engine": result.engine}


def finite(value: float, default: float = 0.0) -> float:
    return value if isinstance(value, (int, float)) and math.isfinite(value) else default


__all__ = [
    "CAPITAL", "ENGINE_ID", "MAX_LEVERAGE", "RISK_PCT", "SLIPPAGE_BPS", "BookingMismatch", "book_leg",
    "calendar_of", "daily_closes", "finite", "leg_plan", "leg_points", "profile_of", "regular_session_bars",
    "run_dsl_leg", "vertex_costs",
]
