"""Run a frozen spec on frozen data and produce a backtest_results record draft."""
from __future__ import annotations

from .data import Bar
from .engine import ENGINE_ID, Costs, buy_and_hold, metrics, rf_series, simulate, walk_forward, window

CHECKS = {
    "walk_forward_sharpe_gt_benchmark": "Stitched walk-forward Sharpe is above buy-and-hold Sharpe on the same days.",
    "walk_forward_drawdown_better": "Stitched walk-forward max drawdown is smaller than buy-and-hold on the same days.",
    "oos_sharpe_gt_benchmark": "Fixed-parameter out-of-sample Sharpe is above buy-and-hold out-of-sample Sharpe.",
    "survives_cost_stress": "Walk-forward Sharpe stays above buy-and-hold with costs multiplied by 5.",
}
EQUITY_POINTS_MAX = 5000
ENGINES = ("stdlib", "nautilus")


def select_engine(name: str):
    """(simulate function, engine id) for an engine name. Nautilus is imported only when selected."""
    if name == "stdlib":
        return simulate, ENGINE_ID
    if name == "nautilus":
        from . import nautilus_engine
        nautilus_engine.require()
        return nautilus_engine.simulate, nautilus_engine.ENGINE_ID
    raise ValueError(f"unknown engine {name!r}; expected one of {ENGINES}")


def _equity(dates: list[str], returns: list[float], step: int) -> list[dict]:
    points, equity = [], 1.0
    for i, (day, r) in enumerate(zip(dates, returns)):
        equity *= 1 + r
        if i % step == 0 or i == len(dates) - 1:
            points.append({"t": day, "equity": round(equity, 6)})
    return points


def trades_from_weights(dates: list[str], weights: list[float], bars: list[Bar], costs: Costs, execution: str,
                        symbol: str) -> list[dict]:
    """Round trips implied by the held weight; a change on day d is filled at d's open (or close).

    A size change while invested closes the old lot and opens a new one. A position still held on
    the last day is marked at that day's adjusted close and labeled "open at period end".
    """
    price = {b.date: (b.adj_open if execution == "next_open" else b.adj_close) for b in bars}
    close = {b.date: b.adj_close for b in bars}
    trades, entry, prev = [], None, 0.0
    for day, weight in zip(dates, weights):
        if weight != prev:
            if entry is not None:
                trades.append(_trade(entry, day, price[day], costs, symbol))
                entry = None
            if weight > 0:
                entry = (day, price[day], weight)
        prev = weight
    if entry is not None and dates:
        trades.append({**_trade(entry, dates[-1], close[dates[-1]], costs, symbol), "regime": "open at period end"})
    return trades


def _trade(entry: tuple[str, float, float], day: str, exit_px: float, costs: Costs, symbol: str) -> dict:
    net = (1 - costs.per_side) ** 2 * (exit_px / entry[1]) - 1
    return {"entry_t": entry[0], "exit_t": day, "side": "long", "qty": entry[2], "entry_px": round(entry[1], 4),
            "exit_px": round(exit_px, 4), "pnl": round(net, 6), "commission": round(2 * costs.per_side, 6),
            "symbol": symbol}


fold_metrics = lambda m: {k: m[k] for k in ("cagr", "ann_vol", "sharpe", "max_drawdown", "time_in_market")}


def run_spec(spec: dict, bars: list[Bar], rates: list[Bar] | None, *, data_label: str, start: str | None = None,
             engine: str = "stdlib") -> dict:
    """Backtest record draft. The benchmark (buy and hold) is closed-form for both engines."""
    simulator, engine_id = select_engine(engine)
    if start:
        bars = [b for b in bars if b.date >= start]
    rf = rf_series([b.date for b in bars], rates)
    c = spec["costs"]
    costs = Costs(c["commission_bps"], c["half_spread_bps"], c["slippage_bps"])
    stress = Costs(c["commission_bps"] * 5, c["half_spread_bps"] * 5, c["slippage_bps"] * 5)
    signal, rebalance, sizing = spec["signal"], spec["rebalance"], spec["sizing"]

    def sim(cost: Costs, lookback: int):
        return simulator(bars, rf, signal_type=signal["type"], lookback=lookback, unit=signal["lookback_unit"],
                         rebalance=rebalance["frequency"], execution=rebalance["execution"],
                         weight=sizing["weight"], costs=cost)

    base = sim(costs, signal["lookback"])
    bench = buy_and_hold(bars, rf, costs)
    first = base.warmup_end or bars[0].date
    last = bars[-1].date
    split = spec["validation"]["in_sample_end"]

    def seg(run, a, b):
        r, f, w = window(run, a, b)
        return metrics(r, f, w)

    is_m, oos_m = seg(base, first, split), seg(base, split + "~", last)
    bh_is, bh_oos = seg(bench, first, split), seg(bench, split + "~", last)
    wf = walk_forward(bars, rf, spec=spec, costs=costs, start=first, simulator=simulator)
    wf_stress = walk_forward(bars, rf, spec=spec, costs=stress, start=first, simulator=simulator)
    wf_days = set(wf["dates"])
    bh_wf_idx = [i for i, d in enumerate(bench.dates) if d in wf_days]
    bh_wf = metrics([bench.returns[i] for i in bh_wf_idx], [bench.rf[i] for i in bh_wf_idx], [1.0] * len(bh_wf_idx))

    results = {
        "walk_forward_sharpe_gt_benchmark": wf["metrics"]["sharpe"] > bh_wf["sharpe"],
        "walk_forward_drawdown_better": wf["metrics"]["max_drawdown"] > bh_wf["max_drawdown"],
        "oos_sharpe_gt_benchmark": oos_m["sharpe"] > bh_oos["sharpe"],
        "survives_cost_stress": wf_stress["metrics"]["sharpe"] > bh_wf["sharpe"],
    }
    criteria = [{"check": item["check"], "description": CHECKS[item["check"]], "passed": results[item["check"]]}
                for item in spec["validation"]["rejection_criteria"]]
    passed = sum(1 for item in criteria if item["passed"])
    verdict = "promising" if passed == len(criteria) else "rejected" if passed == 0 else "inconclusive"

    # Equity shown on the backtests page is the stitched walk-forward (out-of-sample) curve.
    step = max(1, -(-len(wf["dates"]) // EQUITY_POINTS_MAX))
    equity = _equity(wf["dates"], wf["returns"], step)
    bh_points = _equity(wf["dates"], [bench.returns[i] for i in bh_wf_idx], step)
    trades = trades_from_weights(wf["dates"], wf["weights"], bars, costs, rebalance["execution"],
                                 spec["universe"]["instruments"][0])[-2000:]
    # `engine` is a top-level key (the recorder's result schema strips unknown keys and the stored
    # runConfig is a closed contract), so a non-default engine is also named in the strategy label.
    label = "walk-forward" if engine_id == ENGINE_ID else f"walk-forward, {engine_id}"
    return {
        "engine": engine_id,
        "strategy": f"{spec['name']} ({label})",
        "instruments": ", ".join(spec["universe"]["instruments"]),
        "periodStart": wf["dates"][0],
        "periodEnd": wf["dates"][-1],
        "dataSource": data_label[:300],
        "isSplit": {"in_sample": {"start": first, "end": split, "metrics": {**fold_metrics(is_m), "lookback": signal["lookback"], "bh_sharpe": bh_is["sharpe"], "bh_cagr": bh_is["cagr"]}},
                    "out_of_sample": {"start": min(d for d in base.dates if d > split), "end": last, "metrics": {**fold_metrics(oos_m), "lookback": signal["lookback"], "bh_sharpe": bh_oos["sharpe"], "bh_cagr": bh_oos["cagr"]}}},
        "metrics": {
            # sharpe/cagr are the keys the Backtests page lists; they are the walk-forward values.
            "sharpe": wf["metrics"]["sharpe"], "cagr": wf["metrics"]["cagr"],
            "wf_cagr": wf["metrics"]["cagr"], "wf_sharpe": wf["metrics"]["sharpe"], "wf_ann_vol": wf["metrics"]["ann_vol"],
            "wf_max_drawdown": wf["metrics"]["max_drawdown"], "wf_time_in_market": wf["metrics"]["time_in_market"],
            "wf_switches_per_year": wf["metrics"]["switches_per_year"],
            "bh_cagr": bh_wf["cagr"], "bh_sharpe": bh_wf["sharpe"], "bh_max_drawdown": bh_wf["max_drawdown"],
            "stress5x_wf_sharpe": wf_stress["metrics"]["sharpe"], "stress5x_wf_cagr": wf_stress["metrics"]["cagr"],
            "full_fixed_cagr": seg(base, first, last)["cagr"], "full_fixed_sharpe": seg(base, first, last)["sharpe"],
            "cost_per_side_bps": round(costs.per_side * 10_000, 3), "costs_paid_full": round(base.costs_paid, 6),
            "criteria_passed": passed, "criteria_total": len(criteria),
        },
        "equity": equity,
        "trades": trades,
        "folds": wf["folds"][:100],
        "runConfig": {"initialCapital": 1, "commissionPercent": c["commission_bps"] / 100,
                      "slippagePercent": (c["half_spread_bps"] + c["slippage_bps"]) / 100, "timeframe": "1d",
                      "fillModel": "bar", "leverage": sizing["weight"]},
        "benchmark": {"label": f"Buy and hold {spec['universe']['instruments'][0]}", "points": bh_points},
        "criteria": criteria,
        "verdict": verdict,
    }
