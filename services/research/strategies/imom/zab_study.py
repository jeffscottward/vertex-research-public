"""The pre-registered ZAB study on IBKR ETFs (research only; docs/specs/strategies/zab-intraday-momentum.md).

    python -m strategies.imom zab --ran 2026-11-10 [--markets SPY,QQQ,IWM,DIA] [--workers 8] [--detail PATH]

Fixed by the pre-registration (2026-11-09), not by this code's caller:
- Markets SPY (reported only), QQQ, IWM, DIA (confirmation), IBKR 5-minute TRADES bars, each ETF's own BID_ASK sample.
- ZAB as published (vol target, at most 4x) is the primary form; ZAB 1x is reported.
- Costs: half the measured spread per side, 1 bp slippage per side, IBKR Pro Fixed commissions and fees.
- Per market, the five gates: OOS Sharpe >= 0.5; deflated Sharpe probability >= 0.95 with N = 80 trials;
  Monte Carlo P5 max drawdown >= -35 % (2,000 trade bootstraps, seed 31); at least 75 % of the 7 one-at-a-time
  changes (ZAB_SENSITIVITY) keep Sharpe > 0; full-period Sharpe > 0 with doubled spread and slippage (commissions
  unchanged; the OOS Sharpe at 2x costs is reported, not gated).
- Verdict: edge = at least 2 of QQQ, IWM, DIA pass all five; weak = no edge but at least 2 of them have OOS Sharpe > 0
  and Sharpe > 0 with doubled costs; no edge = anything else. SPY's gates are shown but never count.

Not fixed by the pre-registration, chosen here and reported: the variance of the trial Sharpes in the deflated Sharpe
is the variance of the per-day Sharpes of the ZAB configurations run on that market (the 2 forms and the 7 changes).

A run that leaves out a confirmation market (`--markets`) prints the per-market results with verdict
"incomplete": it is a smoke run, not the study's single run. Prints the study JSON; progress goes to stderr.
"""
from __future__ import annotations

import json
import os
from collections.abc import Callable, Mapping, Sequence
from datetime import date
from pathlib import Path

from . import metrics as m
from .data import IBKR, IBKR_DATA_ENV, SPREAD_MEASURED, data_hash, data_root, ibkr_files, ibkr_spread, load_bars
from .definition import ZAB, ZAB_1X, ZAB_SENSITIVITY, Params, params_to_json
from .runner import CAPITAL, ENGINE_ID
from .study import GATE, Results, _run_all, finite, leg_id

SPEC_PATH = "docs/specs/strategies/zab-intraday-momentum.md"
REPORTED = ("SPY",)
CONFIRMATION = ("QQQ", "IWM", "DIA")
MARKETS = REPORTED + CONFIRMATION
TRIALS = 80
SLIPPAGE_BPS = 1.0
FORMS: tuple[tuple[str, str, Params], ...] = (("zab", "ZAB", ZAB), ("zab-1x", "ZAB 1x", ZAB_1X))
EDGE_MIN = 2
Log = Callable[[str], None]


def _log(message: str) -> None:
    import sys

    print(message, file=sys.stderr, flush=True)


def plan(markets: Sequence[str]) -> list[tuple[str, Params, str, float]]:
    """Every distinct Nautilus leg run: both forms, the 7 changes, and ZAB at doubled costs, on each market."""
    stress = float(GATE["costStressMultiple"])
    runs: list[tuple[str, Params, float]] = []
    for key in markets:
        runs += [(key, params, 1.0) for _, _, params in FORMS]
        runs.append((key, ZAB, stress))
        runs += [(key, params, 1.0) for _, _, params in ZAB_SENSITIVITY]
    jobs, seen = [], set()
    for key, params, mult in runs:
        for side in params.sides:
            ident = leg_id(key, params, side, mult)
            if ident not in seen:
                seen.add(ident)
                jobs.append((key, params, side, mult))
    return jobs


def configurations() -> list[Params]:
    """The distinct ZAB configurations of one market (2 forms + 7 changes; ZAB 1x is both)."""
    out: dict[str, Params] = {}
    for params in [p for _, _, p in FORMS] + [p for _, _, p in ZAB_SENSITIVITY]:
        out.setdefault(json.dumps(params_to_json(params), sort_keys=True), params)
    return list(out.values())


def gates(oos_sharpe: float, dsr_probability: float, mc_dd_p5: float | None, neighbour_share: float,
          stress_sharpe: float) -> list[dict]:
    """The five pre-registered gates of one market (ZAB, primary form)."""
    dd = -1.0 if mc_dd_p5 is None else mc_dd_p5
    return [
        {"gate": "oosSharpe", "label": "Out-of-sample Sharpe (last 40 %)", "value": oos_sharpe,
         "threshold": GATE["oosSharpeMin"], "pass": oos_sharpe >= GATE["oosSharpeMin"]},
        {"gate": "deflatedSharpe", "label": f"Deflated Sharpe probability (N = {TRIALS})", "value": dsr_probability,
         "threshold": GATE["deflatedSharpeMin"], "pass": dsr_probability >= GATE["deflatedSharpeMin"]},
        {"gate": "monteCarloDrawdown", "label": "Monte Carlo P5 max drawdown", "value": mc_dd_p5,
         "threshold": GATE["monteCarloDrawdownP5Min"], "pass": dd >= GATE["monteCarloDrawdownP5Min"]},
        {"gate": "neighbours", "label": "One-at-a-time changes with Sharpe > 0", "value": neighbour_share,
         "threshold": GATE["neighbourShareMin"], "pass": neighbour_share >= GATE["neighbourShareMin"]},
        {"gate": "costStress", "label": "Sharpe with doubled spread and slippage", "value": stress_sharpe,
         "threshold": 0.0, "pass": stress_sharpe > 0},
    ]


def verdict(rows: Sequence[Mapping]) -> dict:
    """The pre-registered verdict from the per-market rows (SPY never counts)."""
    by_key = {row["key"]: row for row in rows}
    missing = [key for key in CONFIRMATION if key not in by_key]
    if missing:
        return {"verdict": "incomplete", "missing": missing,
                "reason": f"not the study run: {', '.join(missing)} left out, so no verdict"}
    conf = [by_key[key] for key in CONFIRMATION]
    passed = [row["key"] for row in conf if row["passAll"]]
    weak = [row["key"] for row in conf
            if row["outOfSample"]["sharpe"] > 0 and row["stress"]["sharpe"] > 0]
    if len(passed) >= EDGE_MIN:
        result, why = "edge", f"{len(passed)} of 3 confirmation markets pass all five gates ({', '.join(passed)})"
    elif len(weak) >= EDGE_MIN:
        result = "weak"
        why = (f"{len(passed)} of 3 pass all five gates; {len(weak)} of 3 have OOS Sharpe > 0 and Sharpe > 0 with "
               f"doubled costs ({', '.join(weak)})")
    else:
        result = "no edge"
        why = (f"{len(passed)} of 3 pass all five gates and {len(weak)} of 3 have OOS Sharpe > 0 with doubled costs "
               f"still positive; at least {EDGE_MIN} needed")
    return {"verdict": result, "reason": why, "passAll": passed, "weakPass": weak}


def check_slippage(results: Results, key: str) -> None:
    """Every leg of the market ran at the pre-registered slippage (doubled on the cost-stress legs)."""
    for (leg_key, _, side, mult), leg in results.runs.items():
        if leg_key == key and abs(leg.get("slippageBps", -1.0) - SLIPPAGE_BPS * mult) > 1e-9:
            raise RuntimeError(f"{key} {side} x{mult:g}: slippage {leg.get('slippageBps')} bps, "
                               f"expected {SLIPPAGE_BPS * mult:g}")


def market_row(results: Results, key: str, spread_bps: float) -> tuple[dict, dict]:
    """Per-market results and gates; the second value is the chart detail (daily curves)."""
    check_slippage(results, key)
    primary = results.points(key, ZAB)
    if len(primary) < 3:
        raise RuntimeError(f"{key}: ZAB produced {len(primary)} daily points")
    summary = m.summary(primary)
    trades = results.trades(key, ZAB)
    one_x = m.summary(results.points(key, ZAB_1X))
    stress_points = results.points(key, ZAB, GATE["costStressMultiple"])
    # The gate is the full-period Sharpe (pre-registration); the OOS Sharpe at 2x costs is reported only.
    stress = {**m.stats(stress_points), "oosSharpe": m.summary(stress_points)["outOfSample"]["sharpe"]}
    mc = m.monte_carlo(m.trade_returns(trades), paths=m.MC_PATHS, seed=m.MC_SEED)
    trial_sharpes = [m.stats(results.points(key, params))["sharpePerDay"] for params in configurations()]
    dsr = m.deflated_sharpe(primary, TRIALS, trial_sharpes)
    sens = []
    for param, value, params in ZAB_SENSITIVITY:
        points = results.points(key, params)
        s = m.stats(points)
        sens.append({"param": param, "value": value, "sharpe": s["sharpe"], "cagr": s["cagr"],
                     "maxDrawdown": s["maxDrawdown"], "oosSharpe": m.summary(points)["outOfSample"]["sharpe"],
                     "trades": len(results.trades(key, params))})
    positive = sum(1 for row in sens if row["sharpe"] > 0)
    share = positive / len(ZAB_SENSITIVITY)
    checks = gates(summary["outOfSample"]["sharpe"], dsr["probability"], mc.get("maxDrawdownP5"), share,
                   stress["sharpe"])
    row = {
        "key": key, "role": "reported" if key in REPORTED else "confirmation",
        "first": primary[0][0] if primary else None, "last": primary[-1][0] if primary else None,
        "spreadBps": spread_bps, "trades": len(trades),
        "full": summary["full"], "inSample": summary["inSample"], "outOfSample": summary["outOfSample"],
        "oneX": one_x, "stress": stress, "monteCarlo": mc, "deflatedSharpe": dsr,
        "sensitivity": sens, "neighbourShare": share, "neighboursPositive": positive,
        "gates": checks, "passAll": all(check["pass"] for check in checks),
    }
    detail = {"key": key, "zab": primary, "zab1x": results.points(key, ZAB_1X),
              "drawdown": m.drawdown_series(primary)}
    return row, detail


def require_inputs(markets: Sequence[str], root: str | None) -> None:
    """Every market needs its bars and its own BID_ASK sample (the pre-registration allows no SPY fallback)."""
    missing = [str(path) for key in markets for path in ibkr_files(key, root) if not path.exists()]
    if missing:
        raise FileNotFoundError("missing IBKR input: " + ", ".join(missing))


def require_own_spread(key: str, root: str | None) -> float:
    """The market's own measured in-sample spread; a SPY fallback is refused."""
    spread, origin = ibkr_spread(key, root)
    if origin != SPREAD_MEASURED:
        raise FileNotFoundError(f"{key}: no own BID_ASK sample before the in-sample cut ({origin})")
    return spread


def run(ran: str, markets: Sequence[str] = MARKETS, *, root: str | None = None, workers: int = 8,
        detail_path: Path | None = None, log: Log = _log) -> dict:
    date.fromisoformat(ran)
    unknown = [key for key in markets if key not in MARKETS]
    if unknown or not markets:
        raise ValueError(f"markets must be among {', '.join(MARKETS)}")
    markets = [key for key in MARKETS if key in markets]
    require_inputs(markets, root)
    spreads = {}
    for key in markets:
        spreads[key] = require_own_spread(key, root)
        bars = load_bars(key, root, source=IBKR)
        if abs(bars.spread_bps - spreads[key]) > 1e-9:
            raise RuntimeError(f"{key}: loaded spread {bars.spread_bps} differs from the measured {spreads[key]}")
        log(f"data {key}: {len(bars.t)} five-minute bars, spread {bars.spread_bps:.3f} bps (own sample)")
    jobs = plan(markets)
    log(f"{len(jobs)} Nautilus leg runs on {workers} workers")
    results = Results(_run_all(jobs, root, workers, log, markets[0], IBKR, slippage_bps=SLIPPAGE_BPS))
    rows, details = [], []
    for key in markets:
        row, detail = market_row(results, key, spreads[key])
        rows.append(row)
        details.append(detail)
    engine = next(iter(results.runs.values()))["engine"] if results.runs else ENGINE_ID
    doc = {
        "kind": "zab-preregistered-study", "ran": ran, "spec": SPEC_PATH, "engine": engine,
        "source": IBKR, "dataRoot": str(data_root(root, IBKR)), "dataHash": data_hash(markets, root, IBKR),
        "config": {"capital": CAPITAL, "isFraction": m.IS_FRACTION, "gate": GATE, "trials": TRIALS,
                   "slippageBps": SLIPPAGE_BPS, "monteCarloPaths": m.MC_PATHS, "monteCarloSeed": m.MC_SEED,
                   "legRuns": len(jobs),
                   "trialVariance": "per-day Sharpes of the ZAB configurations run on the same market"},
        "markets": rows, "verdict": verdict(rows),
    }
    if detail_path:
        detail_path.write_text(json.dumps(finite({"markets": details}), allow_nan=False))
    return doc


def main(ran: str, markets: str | None, workers: int, detail: str | None) -> int:
    keys = [key.strip().upper() for key in markets.split(",")] if markets else list(MARKETS)
    doc = run(ran, keys, root=os.environ.get(IBKR_DATA_ENV), workers=workers,
              detail_path=Path(detail) if detail else None)
    print(json.dumps(finite(doc), allow_nan=False))
    return 0


__all__ = ["CONFIRMATION", "MARKETS", "SLIPPAGE_BPS", "TRIALS", "gates", "main", "plan", "run", "verdict"]
