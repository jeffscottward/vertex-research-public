"""Runs one leg (long or short) of one intraday-momentum configuration on one market through the Nautilus
engine (research only, no orders).

Costs: the measured median bid/ask spread of the market (half per side, data.py), 1 bp slippage per
side, and for the ETF twins the IBKR Pro Fixed US stock commission and regulatory fees (existing preset). Source
`ibkr`: the in-sample IBKR BID_ASK median spread (half per side) and 0.25 bp slippage per side, same commission preset;
a job's slippage override replaces it (the pre-registered ZAB study runs at 1 bp, zab_study.py).
The cost stress doubles spread and slippage. Starting capital 100,000 USD per leg. No overnight financing:
every position is flat at the 16:00 close (market-on-close fill at the last regular bar's close).
"""
from __future__ import annotations

import dataclasses
from typing import Any

from nautilus_backtest.bars import Bars
from nautilus_backtest.costs import COST_PROFILE_PRESETS, ZERO_COST_PROFILE
from nautilus_backtest.engine import ENGINE_ID, run_signal_backtest
from nautilus_backtest.signals import plan_run

from . import bias as bias_signal
from .data import DUKASCOPY, Instrument, SessionBars, instrument, load_bars, local_times
from .definition import Bias, Params, definition, params_from_json, params_to_json

CAPITAL = 100_000.0
TIMEFRAME = "5m"


def cost_profile(item: Instrument, spread_bps: float, multiple: float = 1.0) -> dict[str, Any]:
    base = COST_PROFILE_PRESETS["ibkr-pro-fixed-us-stock"] if item.asset_class == "etf" else ZERO_COST_PROFILE
    spread = spread_bps * multiple
    slip = item.slippage_bps * multiple
    return {
        **base,
        "id": f"imom-{item.key.lower()}",
        "label": f"IMOM {item.key}: spread {spread:.2f} bps, slippage {slip:.2f} bps",
        "source": "custom",
        "spreadBps": spread,
        "slippage": {"kind": "bps", "bps": slip},
    }


def spec_of(item: Instrument, data: SessionBars, params: Params, side: str, cost_multiple: float) -> dict[str, Any]:
    return {
        "rule": {"kind": "dsl", "definition": definition(params, side)},
        "costBps": 0,
        "costs": {"profile": cost_profile(item, data.spread_bps, cost_multiple), "capital": CAPITAL},
        "timeframe": TIMEFRAME,
    }


def daily_last(times, values) -> list[tuple[str, float]]:
    """The value at the last bar of each New York session day."""
    out: list[tuple[str, float]] = []
    for (day, _), value in zip(local_times(times), values):
        if out and out[-1][0] == day:
            out[-1] = (day, value)
        else:
            out.append((day, value))
    return out


def run_leg(data: SessionBars, item: Instrument, params: Params, side: str, cost_multiple: float = 1.0,
            scores: dict | None = None) -> dict[str, Any]:
    """Nautilus run of one leg; returns daily unit-equity points, compact trades and engine stats."""
    bars = Bars.from_columns(data.columns())
    spec = spec_of(item, data, params, side, cost_multiple)
    compiled, options = plan_run(bars, spec)
    if isinstance(params, Bias):
        signals = bias_signal.signals(data, params.decision, params.threshold, side, scores)
        compiled = dataclasses.replace(compiled, signals=signals)
    result = run_signal_backtest(bars, compiled, options)
    equity = list(result.equity)
    trades = []
    for trade in result.trades:
        entry, exit_ = trade["entryIndex"], trade["exitIndex"]
        record = dict(trade)
        record["entryMs"] = bars.t[entry]
        record["exitMs"] = bars.t[exit_]
        record["before"] = equity[entry - 1] if entry > 0 else 1.0
        record["day"] = local_times([bars.t[entry]])[0][0]
        record["side"] = side
        trades.append(record)
    return {
        "key": item.key,
        "params": params_to_json(params),
        "side": side,
        "costMultiple": cost_multiple,
        "engine": result.engine if hasattr(result, "engine") else ENGINE_ID,
        "points": daily_last(bars.t, equity),
        "trades": trades,
        "stats": result.stats,
        "spreadBps": data.spread_bps,
        "bars": len(bars),
        "slippageBps": item.slippage_bps * cost_multiple,
    }


def run_job(job: tuple) -> dict[str, Any]:
    """Worker entry (picklable): (market key, params JSON, side, cost multiple, data root[, data source[,
    slippage bps per side]]). The slippage override replaces the market's own (the ZAB study fixes 1 bp)."""
    key, fields, side, cost_multiple, root, *rest = job
    source = rest[0] if rest else DUKASCOPY
    item = instrument(key, source)
    if len(rest) > 1 and rest[1] is not None:
        item = dataclasses.replace(item, slippage_bps=float(rest[1]))
    params = params_from_json(fields)
    return run_leg(load_bars(key, root, source=source), item, params, side, cost_multiple)


__all__ = ["CAPITAL", "ENGINE_ID", "cost_profile", "daily_last", "run_job", "run_leg", "spec_of"]
