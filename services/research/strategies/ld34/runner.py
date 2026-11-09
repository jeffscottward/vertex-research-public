"""Runs one LD34 configuration on one market through the Nautilus engine (research only, no orders).

Costs: the measured median bid/ask spread of the market (data.py), a per-asset slippage in basis
points of price, and for ETFs the IBKR Pro Fixed US stock commission and regulatory fees. Starting
capital 100,000 USD. Financing of the borrowed part of a leveraged position is charged afterwards
from the trade list (metrics.financing_factors).
"""
from __future__ import annotations

from dataclasses import asdict
from typing import Any

from nautilus_backtest.bars import Bars
from nautilus_backtest.costs import COST_PROFILE_PRESETS, ZERO_COST_PROFILE
from nautilus_backtest.engine import ENGINE_ID, run_spec

from .data import BY_KEY, HourlyData, Instrument, load_hourly
from .definition import Params, definition, with_leverage
from .metrics import daily_points

CAPITAL = 100_000.0


def cost_profile(item: Instrument, spread_bps: float, multiple: float = 1.0) -> dict[str, Any]:
    base = COST_PROFILE_PRESETS["ibkr-pro-fixed-us-stock"] if item.asset_class == "etf" else ZERO_COST_PROFILE
    spread = spread_bps * multiple
    slip = item.slippage_bps * multiple
    return {
        **base,
        "id": f"ld34-{item.key.lower()}",
        "label": f"LD34 {item.key}: spread {spread:.2f} bps, slippage {slip:.2f} bps",
        "source": "custom",
        "spreadBps": spread,
        "slippage": {"kind": "bps", "bps": slip},
    }


def run_market(data: HourlyData, item: Instrument, params: Params, cost_multiple: float = 1.0) -> dict[str, Any]:
    """Nautilus run of one parameter set; returns daily equity points, trades and engine stats."""
    bars = Bars.from_columns(data.columns())
    params = with_leverage(params, item.max_leverage)
    spec = {
        "rule": {"kind": "dsl", "definition": definition(params)},
        "costBps": 0,
        "costs": {"profile": cost_profile(item, data.spread_bps, cost_multiple), "capital": CAPITAL},
        "timeframe": "1h",
    }
    result = run_spec(bars, spec)
    return {
        "key": item.key,
        "params": asdict(params),
        "costMultiple": cost_multiple,
        "engine": result.engine,
        "times": list(bars.t),
        "equity": list(result.equity),
        "points": daily_points(bars.t, result.equity),
        "trades": list(result.trades),
        "stats": result.stats,
        "spreadBps": data.spread_bps,
    }


def run_job(job: tuple[str, dict, float, str | None]) -> dict[str, Any]:
    """Worker entry (picklable): (market key, Params fields, cost multiple, data root)."""
    key, fields, cost_multiple, root = job
    fields = dict(fields)
    fields["lookbacks"] = tuple(fields["lookbacks"])
    item = BY_KEY[key]
    out = run_market(load_hourly(key, root), item, Params(**fields), cost_multiple)
    # Hourly equity is only needed for financing; keep it compact.
    return out


__all__ = ["CAPITAL", "ENGINE_ID", "cost_profile", "run_job", "run_market"]
