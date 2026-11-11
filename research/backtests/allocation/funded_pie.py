"""The lower-bar pie the owner picked on 2026-11-11, as a proposal (research only).

Places no orders, creates no deployment request and changes no engine setting. It runs three
sleeves in one account on NautilusTrader (ledger parity) and writes one JSON document to --out
(a report work directory):

- long index: always-on monthly SPY and QQQ call debit verticals (`oil-predicts-equity/B`);
- rotation: top 2 of the Core 7 by 12-1 momentum, call debit verticals (`momentum-rotation/A`);
- vol premium: SPY put credit verticals with the volatility-regime gate (`regime-put-vrp/A`).

Limits (owner pick): 1% of equity at risk per position, at most 4% open at one time, at most 2%
in one underlying. Sleeve budgets: long index 2%, rotation 1%, vol premium 1%; the rest is cash.

Each sleeve and the pie run twice, each in its own process: with the option model of options.py
(the study model) and with the model measured in a chain snapshot (sensitivity.measured_model).
The lower bar is an owner decision, not a repository gate: Sharpe >= 0.3, positive out of sample,
Monte Carlo profit >= 80%, max drawdown <= 25%, at least 30 trades.

Run (rig, venv with the Nautilus lock):
  python research/backtests/allocation/funded_pie.py --data <qc-ports data dir> \
      --capital <account value, rounded> --trials <count> --trial-variance <dailySharpeVariance of run.py> \
      --chain <work dir>/chain/summary.json --out <report work dir>/funded_pie.json
"""
from __future__ import annotations

import argparse
import json
import multiprocessing
import sys
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parents[2] / "services" / "research"))

import run as base  # noqa: E402
import sensitivity  # noqa: E402
from strategies.qc_ports import allocation as al  # noqa: E402
from strategies.qc_ports import ideas as qi  # noqa: E402
from strategies.qc_ports import study  # noqa: E402

# run key -> (sleeve, budget in percent of equity)
POOL = {"oil-predicts-equity/B": ("long index", 2.0), "momentum-rotation/A": ("rotation", 1.0),
        "regime-put-vrp/A": ("vol premium", 1.0)}
POSITION_RISK_PCT = 1.0
OPEN_RISK_CAP_PCT = 4.0
NAME_RISK_CAP_PCT = 2.0
LOWER_BAR = {"minSharpe": 0.3, "minOosSharpe": 0.0, "minMonteCarloProfit": 0.8, "maxDrawdown": -0.25, "minTrades": 30}
MODELS = {"study": {}, "measured": {"costs": "measured"}}
STAT_KEYS = ("start", "end", "cagr", "sharpe", "oosSharpe", "deflatedSharpe", "maxDrawdown", "worstMonth", "worstMonthReturn",
             "trades", "winRate", "monteCarlo", "timeInCash", "maxOpenRisk")


def lower_bar(stats: dict) -> bool:
    carlo = stats["monteCarlo"] or {}
    return (stats["sharpe"] >= LOWER_BAR["minSharpe"] and stats["oosSharpe"] > LOWER_BAR["minOosSharpe"]
            and (carlo.get("probabilityOfProfit") or 0.0) >= LOWER_BAR["minMonteCarloProfit"]
            and stats["maxDrawdown"] >= LOWER_BAR["maxDrawdown"] and stats["trades"] >= LOWER_BAR["minTrades"])


def model_run(name: str, data_dir: str, chain_path: str, capital: float, trials: int, trial_variance: float) -> dict:
    sensitivity.apply_model(MODELS[name], chain_path)
    data = study.load_study_data(data_dir)
    dataset = data.dataset
    runs = qi.family(data.facts)
    last_day = dataset.calendar[-1]
    priced = {key: al.owner_rule_trades(runs[key].definition, dataset, start=runs[key].start) for key in POOL}
    sleeves = {}
    for key, trades in priced.items():
        dates = [day for day in dataset.calendar if day >= runs[key].start]
        result, gap, _engine = base.nautilus_run(trades, capital, dates)
        stats = base.run_stats(result, trades, capital, trials, trial_variance)
        sleeves[key] = {"sleeve": POOL[key][0], "budgetPct": POOL[key][1], "nautilusGap": gap,
                        **{field: stats[field] for field in STAT_KEYS}, "lowerBar": lower_bar(stats)}
    start = max(runs[key].start for key in POOL)
    dates = [day for day in dataset.calendar if day >= start]
    caps = al.Caps(open_risk_pct=OPEN_RISK_CAP_PCT, name_risk_pct=NAME_RISK_CAP_PCT,
                   sleeve_of={key: POOL[key][0] for key in POOL}, sleeve_risk_pct={sleeve: budget for sleeve, budget in POOL.values()})
    books = {key: [trade for trade in trades if trade.entry_date >= start] for key, trades in priced.items()}
    combined = al.combine(books, dict.fromkeys(POOL, POSITION_RISK_PCT), caps)
    result, gap, engine = base.nautilus_run(combined.trades, capital, dates)
    stats = base.run_stats(result, combined.trades, capital, trials, trial_variance)
    cost_of = {trade.trade_id: trade.max_loss for trade in combined.trades}
    per_sleeve = {key: {"trades": 0, "pnl": 0.0} for key in POOL}
    for trade in result.trades:
        bucket = per_sleeve[combined.owner[trade["id"]]]
        bucket["trades"] += 1
        bucket["pnl"] += trade["pnl"]
    recent = (dataset.calendar[-63], last_day)
    return {
        "sleeves": sleeves, "portfolioStart": start, "engine": engine, "nautilusGap": gap,
        "stats": {field: stats[field] for field in STAT_KEYS}, "lowerBar": lower_bar(stats),
        "premium": base._open_premium(result, combined.trades), "refused": combined.refused, "perSleeve": per_sleeve,
        "stress": {**{label: al.window_metrics(result, *window) for label, window in base.STRESS.items()},
                   "last3Months": al.window_metrics(result, *recent)},
        "openToday": [{"strategy": combined.owner[t["id"]], "symbol": t["symbol"], "structure": t["structure"], "expiry": t["expiry"],
                       "longStrike": t["longStrike"], "shortStrike": t["shortStrike"], "entryDate": t["entryDate"],
                       "maxLossPerContract": cost_of[t["id"]]} for t in result.trades if t["exitReason"] == "end"],
        "equity": [{"t": day, "v": round(value, 2)} for day, value in zip(result.dates, result.equity)],
        "lastDay": last_day,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--capital", type=float, required=True)
    parser.add_argument("--trials", type=int, required=True)
    parser.add_argument("--trial-variance", type=float, required=True)
    parser.add_argument("--chain", type=Path, required=True)
    args = parser.parse_args()
    document = {"pool": {key: {"sleeve": sleeve, "budgetPct": budget} for key, (sleeve, budget) in POOL.items()},
                "limits": {"positionRiskPct": POSITION_RISK_PCT, "openRiskCapPct": OPEN_RISK_CAP_PCT, "nameRiskCapPct": NAME_RISK_CAP_PCT,
                           "cashPct": 100 - sum(budget for _sleeve, budget in POOL.values())},
                "lowerBar": LOWER_BAR, "trials": args.trials, "capital": args.capital, "models": {}}
    with ProcessPoolExecutor(max_workers=len(MODELS), mp_context=multiprocessing.get_context("spawn"), max_tasks_per_child=1) as pool:
        jobs = {name: pool.submit(model_run, name, str(args.data), str(args.chain), args.capital, args.trials, args.trial_variance)
                for name in MODELS}
        for name, job in jobs.items():
            document["models"][name] = job.result()
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(document, indent=1))
    for name, model in document["models"].items():
        stats = model["stats"]
        print(f"{name}: cagr {stats['cagr']:.4f} sharpe {stats['sharpe']:.3f} maxDD {stats['maxDrawdown']:.3f} lowerBar {model['lowerBar']}",
              file=sys.stderr)


if __name__ == "__main__":
    main()
