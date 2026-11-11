"""Allocation proposal study: gates, bench, weights and the combined portfolio run (research only).

Places no orders and writes nothing to Postgres. Reads the public daily data of the qc-ports
fetch and the QuantJourney library definitions; writes one JSON document to --out (a report
work directory outside the repository; the app never reads it).

Run (rig, in the venv with services/research/requirements-nautilus-linux-py312.lock):
  python research/backtests/allocation/run.py --data <qc-ports data dir> --capital <account value, rounded> \
      --out <report work dir>/results.json

Method: research/backtests/allocation/README.md.
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path
from statistics import stdev, variance

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "services" / "research"))

from strategies.qc_ports import allocation as al  # noqa: E402
from strategies.qc_ports import ideas as qi  # noqa: E402
from strategies.qc_ports import portfolio as pf  # noqa: E402
from strategies.qc_ports import study  # noqa: E402
from strategies.qc_ports.ledger import run_ledger  # noqa: E402
from strategies.qc_ports.metrics import summarize  # noqa: E402
from strategies.qc_ports.nautilus_runner import run_nautilus  # noqa: E402

# The eligibility gate. Every threshold is an existing repository constant.
GATE = {
    "minTrades": 30,            # AUTOPILOT_GATE (packages/api/src/autopilot-gate.ts)
    "minSharpe": 0.5,           # study.PASS_SHARPE
    "minOosSharpe": 0.5,        # AUTOPILOT_GATE out-of-sample Sharpe, last 40% of the bars
    "minDeflatedSharpe": 0.95,  # AUTOPILOT_GATE, quantjourney.ts DSR_MIN_PROBABILITY
    "minMonteCarloProfit": 0.8,     # AUTOPILOT_GATE monteCarloProfitMin
    "minMonteCarloDrawdownP5": -0.35,  # AUTOPILOT_GATE monteCarloDrawdownP5Min
    "maxDrawdown": -0.25,       # study.PASS_DRAWDOWN
}
# Portfolio limits (owner rules and the Monte Carlo sizing budget of backtest-analytics.ts).
DRAWDOWN_LIMIT_PCT = 20.0
OPEN_RISK_CAP_PCT = 10.0
NAME_RISK_CAP_PCT = 2.0
POSITION_RISK_CAP_PCT = 2.0
# Risk of one bench position: the smallest size that still buys one 60-day one-sigma SPY or QQQ
# call spread at the account value of the study.
POSITION_RISK_PCT = 1.0
# Gate ideas: overlays of the put-credit host, not strategies with their own budget.
OVERLAYS = frozenset({"qc-iv-rank-gate", "qc-vix-term-gate"})
# Options form of the QuantJourney daily definitions (fixed before the first run): the monthly
# call debit vertical of the qc study on the Core 7 ETF twins, one open spread per symbol.
QJ_DAILY = ("O01", "O02", "O06", "O12", "O13", "O18", "W01", "W03")
QJ_START = "1993-01-29"
SLEEVES = {
    "qc-asset-class-trend": "trend", "qc-futures-trend-carry": "trend", "qc-momentum-rotation": "rotation",
    "qc-turn-of-the-month": "seasonality", "qc-opex-week": "seasonality", "qc-same-month-seasonality": "seasonality",
    "qc-oil-predicts-equity": "macro", "qc-gold-fed-model": "macro", "qc-regime-put-vrp": "vol premium",
    "qc-iv-rank-gate": "vol premium", "qc-vix-term-gate": "vol premium",
}
STRESS = {"2020-03": ("2020-02-19", "2020-03-31"), "2022": ("2022-01-03", "2022-12-30")}


def qj_candidates(library_path: Path) -> list[dict]:
    library = {item["id"]: item for item in json.loads(library_path.read_text())["strategies"]}
    out = []
    for code in QJ_DAILY:
        item = library[code]
        made = {key: value for key, value in item["dsl"].items() if key in ("name", "version", "entry", "exit", "filters")}
        made["options"] = {**qi.MONTHLY_CALL, "dte": dict(qi.MONTHLY_CALL["dte"])}
        made["portfolio"] = qi.portfolio(qi.CORE7, "flat", cadence="daily")
        sleeve = "mean reversion" if "meanrev" in item["styles"] else "trend"
        out.append({"key": f"qj/{code}", "slug": item["slug"], "name": item["name"], "sleeve": sleeve,
                    "definition": made, "start": QJ_START, "baseline": None, "study": None})
    return out


def qc_candidates(data: study.StudyData) -> tuple[list[dict], dict]:
    runs = qi.family(data.facts)
    out = []
    for idea in qi.IDEAS:
        primary = runs[idea.runs[0][1]]
        baseline = runs[idea.runs[-1][1]] if len(idea.runs) > 1 else None
        out.append({"key": primary.key, "slug": idea.id, "name": f"{idea.title}: {primary.name}",
                    "sleeve": SLEEVES[idea.id], "definition": primary.definition, "start": primary.start,
                    "baseline": None if baseline is None or baseline.key == primary.key else baseline.key, "study": primary.key})
    return out, runs


def nautilus_run(trades, capital: float, dates):
    """Ledger result of the trades after NautilusTrader booked the same trades (1e-6 parity)."""
    ledger = run_ledger(trades, capital, dates=dates)
    other = run_nautilus(trades, capital, dates=dates)
    gap = max((abs(a - b) / max(abs(a), abs(b)) for a, b in zip(ledger.equity, other.equity, strict=True)), default=0.0)
    same = [(t["id"], t["contracts"]) for t in ledger.trades] == [(t["id"], t["contracts"]) for t in other.trades]
    if gap > pf.PARITY_REL_TOL or not same:
        raise RuntimeError(f"Ledger and Nautilus disagree (gap {gap:.3g}, trades match {same})")
    return ledger, gap, other.engine


def run_stats(result, priced, capital: float, n_trials: int, trial_variance: float | None) -> dict:
    stats = summarize(result, n_trials=n_trials, sharpe_variance=trial_variance)
    returns = al.daily_returns(result.equity)
    split_day, oos = al.out_of_sample_sharpe(result)
    carlo = al.monte_carlo([t["pnl"] for t in result.trades], capital)
    exposure_days = sum(1 for count in result.open_positions if count > 0)
    reasons: dict[str, int] = {}
    for trade in result.trades:
        reasons[trade["exitReason"]] = reasons.get(trade["exitReason"], 0) + 1
    return {
        **{key: stats[key] for key in ("start", "end", "days", "cagr", "sharpe", "deflatedSharpe", "nTrials",
                                       "maxDrawdown", "worstMonth", "worstMonthReturn", "trades", "winRate", "totalReturn")},
        "volatility": (stdev(returns) * math.sqrt(al.TRADING_DAYS)) if len(returns) > 1 else 0.0,
        "oosStart": split_day, "oosSharpe": oos, "monteCarlo": carlo,
        "timeInCash": 1 - exposure_days / len(result.open_positions),
        "maxOpenRisk": pf.max_open_risk(result, priced), "sizeSkips": len(result.skipped), "exitReasons": reasons,
    }


def gate_checks(stats: dict, baseline_sharpe: float | None) -> list[dict]:
    carlo = stats["monteCarlo"] or {"probabilityOfProfit": 0.0, "drawdownP5": -1.0}
    deflated = stats["deflatedSharpe"]
    checks = [
        ("G3 trades >= 30", stats["trades"] >= GATE["minTrades"], stats["trades"]),
        ("G4 Sharpe >= 0.5", stats["sharpe"] >= GATE["minSharpe"], stats["sharpe"]),
        ("G4 out-of-sample Sharpe >= 0.5", stats["oosSharpe"] >= GATE["minOosSharpe"], stats["oosSharpe"]),
        ("G5 deflated Sharpe >= 0.95", deflated is not None and deflated >= GATE["minDeflatedSharpe"], deflated),
        ("G6 Monte Carlo P(profit) >= 0.80", carlo["probabilityOfProfit"] >= GATE["minMonteCarloProfit"],
         carlo["probabilityOfProfit"]),
        ("G6 Monte Carlo drawdown p5 >= -35%", carlo["drawdownP5"] >= GATE["minMonteCarloDrawdownP5"], carlo["drawdownP5"]),
        ("G7 max drawdown <= 25%", stats["maxDrawdown"] >= GATE["maxDrawdown"], stats["maxDrawdown"]),
    ]
    if baseline_sharpe is not None:
        checks.append(("G7 Sharpe above its always-on baseline", stats["sharpe"] > baseline_sharpe, baseline_sharpe))
    return [{"check": name, "pass": bool(ok), "value": value} for name, ok, value in checks]


def returns_by_day(result) -> dict[str, float]:
    return dict(zip(result.dates[1:], al.daily_returns(result.equity)))


def regime(data: study.StudyData) -> dict:
    """Today's overlay inputs from the last complete daily bar (no forecast)."""
    def closes(symbol):
        bars = data.dataset.bars[symbol]
        return list(bars.dates), list(bars.close)

    def sma(values, length):
        return sum(values[-length:]) / length

    out = {}
    for symbol in ("SPY", "QQQ"):
        dates, close = closes(symbol)
        out[symbol] = {"date": dates[-1], "close": close[-1], "vsSma50Pct": close[-1] / sma(close, 50) - 1,
                       "vsSma200Pct": close[-1] / sma(close, 200) - 1}
    series = data.dataset.series
    last = max(series["VIX"])
    vix = series["VIX"][last]
    history = [series["VIX"][day] for day in sorted(series["VIX"])][-252:]
    low, high = min(history), max(history)
    term_day = max(series["VIX3M"])
    out["vix"] = {"date": last, "close": vix, "ivRank252": (vix - low) / (high - low) * 100 if high > low else None,
                  "termRatio": series["VIX"][term_day] / series["VIX3M"][term_day], "termDate": term_day}
    return out


def open_today(priced, last_day: str) -> list[dict]:
    return [{"symbol": t.symbol, "structure": t.structure, "expiry": t.expiry, "longStrike": t.long_strike,
             "shortStrike": t.short_strike, "entryDate": t.entry_date, "maxLossPerContract": t.max_loss}
            for t in priced if t.exit_reason == "end" and t.exit_date == last_day]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--capital", type=float, required=True, help="account value for sizing (rounded)")
    parser.add_argument("--library", type=Path, default=ROOT / "research/backtests/quantjourney/library.json")
    args = parser.parse_args()

    data = study.load_study_data(args.data)
    dataset = data.dataset
    last_day = dataset.calendar[-1]
    log = lambda text: print(text, file=sys.stderr, flush=True)  # noqa: E731

    # 1. The pre-registered family as the study ran it (its own exits, 100,000 capital): the stored evidence.
    outcomes, family_metrics, family_variance = study.run_family(data, nautilus=True, progress=lambda key: log(f"family {key}"))
    family_daily = {key: study.daily_sharpe(outcome.result) for key, outcome in outcomes.items() if outcome.run.counted}

    # 2. Every candidate under the owner exit rule, on Nautilus, at the account capital.
    qc, _runs = qc_candidates(data)
    candidates = qc + qj_candidates(args.library)
    owner: dict[str, dict] = {}
    for item in candidates:
        priced = al.owner_rule_trades(item["definition"], dataset, start=item["start"])
        dates = [day for day in dataset.calendar if day >= item["start"]]
        result, gap, engine = nautilus_run(priced, args.capital, dates)
        owner[item["key"]] = {"priced": priced, "result": result, "gap": gap, "engine": engine}
        log(f"owner-rule {item['key']} trades {len(result.trades)} gap {gap:.2g}")
    owner_daily = {key: study.daily_sharpe(value["result"]) for key, value in owner.items()}
    n_trials = len(family_daily) + len(owner_daily)
    trial_variance = variance([*family_daily.values(), *owner_daily.values()])

    rows = []
    for item in candidates:
        run = owner[item["key"]]
        stats = run_stats(run["result"], run["priced"], args.capital, n_trials, trial_variance)
        baseline = family_metrics[item["baseline"]]["sharpe"] if item["baseline"] else None
        checks = gate_checks(stats, baseline)
        as_studied = None
        if item["study"]:
            metrics = family_metrics[item["study"]]
            as_studied = {key: metrics[key] for key in ("sharpe", "deflatedSharpe", "cagr", "maxDrawdown", "trades", "start")}
        rows.append({"key": item["key"], "slug": item["slug"], "name": item["name"], "sleeve": item["sleeve"],
                     "start": item["start"], "ownerRule": stats, "asStudied": as_studied, "baselineKey": item["baseline"],
                     "baselineSharpe": baseline, "checks": checks, "eligible": all(check["pass"] for check in checks),
                     "nautilusGap": run["gap"], "openToday": open_today(run["priced"], last_day),
                     "symbols": sorted({t.symbol for t in run["priced"]})})

    # 3. Bench: not eligible, but the least bad (positive Sharpe after costs under the owner rule).
    # A gate idea is an overlay of the put-credit host, and a run with the same daily equity as an
    # earlier one is the same trades (its stop or bracket has no options form): neither holds a budget.
    by_key = {row["key"]: row for row in rows}
    seen: dict[tuple, str] = {}
    for row in rows:
        row["role"] = "overlay" if row["slug"] in OVERLAYS else "strategy"
        row["duplicateOf"] = seen.setdefault(owner[row["key"]]["result"].equity, row["key"])
        if row["duplicateOf"] == row["key"]:
            row["duplicateOf"] = None
    holders = [row for row in rows if row["role"] == "strategy" and row["duplicateOf"] is None]
    eligible = [row["key"] for row in rows if row["eligible"]]
    bench = [row["key"] for row in holders if not row["eligible"] and row["ownerRule"]["sharpe"] > 0]
    pool = [row["key"] for row in holders if row["eligible"]] or bench
    start = max(by_key[key]["start"] for key in pool) if pool else last_day
    dates = [day for day in dataset.calendar if day >= start]
    daily = {key: {day: value for day, value in returns_by_day(owner[key]["result"]).items() if day >= start} for key in pool}
    matrix = {a: {b: al.correlation(daily[a], daily[b]) for b in pool} for a in pool}
    members: dict[str, list[str]] = {}
    for key in pool:
        members.setdefault(by_key[key]["sleeve"], []).append(key)
    sleeve_daily = {name: {day: sum(daily[key].get(day, 0.0) for key in keys) / len(keys) for day in dates[1:]}
                    for name, keys in members.items()}
    sleeve_stats = {name: {"members": members[name], "sharpe": al.sharpe(list(series.values())),
                           "volatility": stdev(series.values()) * math.sqrt(al.TRADING_DAYS)}
                    for name, series in sleeve_daily.items()}
    sleeve_matrix = {a: {b: al.correlation(sleeve_daily[a], sleeve_daily[b]) for b in members} for a in members}
    years = dict.fromkeys(members, len(dates) / al.TRADING_DAYS)
    methods = {
        "equalRisk": al.equal_risk(list(members)),
        "inverseVolatility": al.inverse_volatility({name: sleeve_stats[name]["volatility"] for name in members}),
        "shrunkSharpe": al.shrunk_sharpe({name: sleeve_stats[name]["sharpe"] for name in members}, years),
    }

    # 4. One account. A sleeve's budget is its share of the open-risk cap (the worst-case loss of
    # everything open at once); its strategies share that budget; a position risks POSITION_RISK_PCT
    # (or the whole sleeve budget when that is smaller).
    recent = (dataset.calendar[-63], last_day)
    portfolios = {}
    for method, shares in methods.items():
        budget = {name: shares[name] * OPEN_RISK_CAP_PCT for name in members}
        risk = {key: min(POSITION_RISK_PCT, budget[by_key[key]["sleeve"]]) for key in pool}
        caps = al.Caps(open_risk_pct=OPEN_RISK_CAP_PCT, name_risk_pct=NAME_RISK_CAP_PCT,
                       sleeve_of={key: by_key[key]["sleeve"] for key in pool}, sleeve_risk_pct=budget)
        books = {key: [t for t in owner[key]["priced"] if t.entry_date >= start] for key in pool}
        combined = al.combine(books, risk, caps)
        result, gap, engine = nautilus_run(combined.trades, args.capital, dates)
        stats = run_stats(result, combined.trades, args.capital, n_trials, trial_variance)
        cost_of = {t.trade_id: t.max_loss for t in combined.trades}
        per_strategy: dict[str, dict] = {key: {"trades": 0, "pnl": 0.0} for key in pool}
        for trade in result.trades:
            bucket = per_strategy[combined.owner[trade["id"]]]
            bucket["trades"] += 1
            bucket["pnl"] += trade["pnl"]
        portfolios[method] = {
            "sleeveShare": shares, "sleeveBudgetPct": budget, "riskPerPositionPct": risk,
            "cashPct": 100 - sum(budget.values()),
            "stats": stats, "nautilusGap": gap, "engine": engine, "refused": combined.refused, "perStrategy": per_strategy,
            "premium": _open_premium(result, combined.trades),
            "openToday": [{"strategy": combined.owner[t["id"]], "symbol": t["symbol"], "structure": t["structure"],
                           "expiry": t["expiry"], "longStrike": t["longStrike"], "shortStrike": t["shortStrike"],
                           "entryDate": t["entryDate"], "maxLossPerContract": cost_of[t["id"]],
                           "riskPct": risk[combined.owner[t["id"]]]}
                          for t in result.trades if t["exitReason"] == "end"],
            "stress": {**{name: al.window_metrics(result, *window) for name, window in STRESS.items()},
                       "last3Months": al.window_metrics(result, *recent)},
            "equity": [{"t": day, "v": round(value, 2)} for day, value in zip(result.dates, result.equity)],
        }
        log(f"portfolio {method} sharpe {stats['sharpe']:.3f} gap {gap:.2g}")

    document = {
        "generatedFor": last_day, "capital": args.capital, "engine": next(iter(owner.values()))["engine"],
        "nautilusTrader": study.provenance("", data, True, "")["engine"], "dataSha256": data.manifest,
        "gate": GATE, "limits": {"drawdownLimitPct": DRAWDOWN_LIMIT_PCT, "openRiskCapPct": OPEN_RISK_CAP_PCT,
                                 "nameRiskCapPct": NAME_RISK_CAP_PCT, "positionRiskPct": POSITION_RISK_PCT,
                                 "positionRiskCapPct": POSITION_RISK_CAP_PCT},
        "trials": {"count": n_trials, "family": len(family_daily), "ownerRule": len(owner_daily), "dailySharpeVariance": trial_variance},
        "familyAsStudied": {key: {name: metrics[name] for name in ("sharpe", "deflatedSharpe", "cagr", "maxDrawdown", "trades")}
                            for key, metrics in family_metrics.items()},
        "candidates": rows, "eligible": eligible, "bench": bench, "portfolioStart": start,
        "correlation": matrix, "sleeves": sleeve_stats, "sleeveCorrelation": sleeve_matrix,
        "portfolios": portfolios, "regime": regime(data),
        "stressWindows": {**{name: list(window) for name, window in STRESS.items()}, "last3Months": list(recent)},
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(document, indent=1))
    log(f"wrote {args.out}: {len(eligible)} eligible, {len(bench)} bench, {n_trials} trials")


def _open_premium(result, priced) -> dict:
    """Average and peak cost of the open positions (entry value plus entry costs) in percent of equity."""
    cost = {trade.trade_id: trade.entry_price + trade.entry_fee for trade in priced}
    spans = [(t["entryDate"], t["exitDate"], t["contracts"] * cost[t["id"]]) for t in result.trades]
    shares = []
    for day, equity in zip(result.dates, result.equity):
        held = sum(value for entry, exit_, value in spans if entry <= day < exit_)
        shares.append(held / equity)
    return {"averagePct": 100 * sum(shares) / len(shares), "peakPct": 100 * max(shares)} if shares else {"averagePct": 0.0, "peakPct": 0.0}


if __name__ == "__main__":
    main()
