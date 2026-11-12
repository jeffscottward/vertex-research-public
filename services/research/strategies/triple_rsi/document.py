"""The research_studies document of the Triple RSI study (kind "strategy-backtest", research only).

Schema: StrategyBacktestStudySchema in packages/api/src/contracts/research-studies.ts (numbers are fractions,
drawdowns negative). `study_document` builds it from the results document of study.assemble plus its
provenance. Stored with `bun run vertex:research-studies:import`; the import checks the schema again.
"""
from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping

from . import rules, study

__all__ = ["SOURCE_URL", "SPEC", "STUDY_ID", "check_value", "study_document", "verdict_of"]

STUDY_ID = "triple-rsi"
SPEC = "docs/specs/strategies/triple-rsi.md"
SOURCE_URL = "https://www.quantifiedstrategies.com/triple-rsi-trading-strategy/"
EXECUTION_LABEL = {"close": "signal close", "nextOpen": "next open", "nextClose": "next close"}
COST_LABEL = {0.0: "no cost", 0.0005: "5 bp/side", 0.001: "10 bp/side"}
VARIANT_LABEL = {"call30": "30d call vertical", "call60": "60d call vertical",
                 "call30-owner-exit": "30d, owner exit only", "call30-signal-close": "30d, signal close"}


def pct(value: float | None, digits: int = 1) -> str:
    return "n/a" if value is None else f"{value * 100:.{digits}f}%"


def num(value: float | None, digits: int = 2) -> str:
    return "n/a" if value is None else f"{value:.{digits}f}"


def check_value(check: Mapping, stats: Mapping | None) -> str:
    """The shown value of a gate check; the baseline check shows the row's Sharpe next to the baseline's."""
    value = check["value"]
    if check["check"].startswith("G7 Sharpe above") and stats is not None:
        return f"row {num(stats['sharpe'], 3)}, always-on {num(value, 3)}"
    return num(value, 3) if isinstance(value, float) else str(value)


def verdict_of(results: Mapping) -> str:
    decision = results["decision"]
    if decision["passesGate"]:
        return "edge"
    deciding = _deciding(results)
    if deciding["stats"] is None or deciding["stats"]["trades"] < 30:
        return "needs-more-data"
    return "no-edge"


def _deciding(results: Mapping) -> Mapping:
    row = results["decision"]["row"]
    return next(item for item in results["options"]
                if item["symbol"] == row["symbol"] and item["variant"] == row["variant"])


def _share(results: Mapping, symbol: str, execution: str, cost: float) -> Mapping:
    return next(row for row in results["shares"] if row["symbol"] == symbol and row["execution"] == execution
                and row["costPerSide"] == cost and row["params"] == rules.STATED.key() and row["basis"] == "total")


def _run(stats: Mapping, symbol: str, market: str, hold: Mapping | None) -> dict:
    return {"buyHoldCagr": None if hold is None else hold["cagr"],
            "buyHoldSharpe": None if hold is None else hold["sharpe"],
            "cagr": stats["cagr"], "exposure": stats["exposure"], "from": stats["start"], "market": market[:60],
            "maxDrawdown": min(0.0, stats["maxDrawdown"]), "oosCagr": stats["oosCagr"], "oosSharpe": stats["oosSharpe"],
            "profitFactor": stats["profitFactor"], "sharpe": stats["sharpe"], "symbol": symbol, "to": stats["end"],
            "trades": stats["trades"], "winRate": stats["winRate"] if stats["winRate"] is not None else 0.0}


def _underlying_runs(results: Mapping) -> list[dict]:
    runs = []
    for row in results["shares"]:
        if row["params"] != rules.STATED.key() or row["basis"] != "total":
            continue
        market = f"{EXECUTION_LABEL[row['execution']]}, {COST_LABEL[row['costPerSide']]}"
        runs.append(_run(row["stats"], row["symbol"], market, row["buyHold"]))
    return runs


def _options_runs(results: Mapping) -> list[dict]:
    return [_run(row["stats"], row["symbol"], VARIANT_LABEL[row["variant"]], row["buyHold"])
            for row in results["options"] if row["stats"] is not None]


def _sensitivity(results: Mapping) -> list[dict]:
    """One parameter at a time around the stated rule (SPY shares, signal close, 5 bp/side)."""
    stated = rules.STATED
    by_key = {row["params"]: row for row in results["grid"]}
    rows = []
    axes = (("RSI length", "length", study.GRID["length"]), ("Entry below", "entry_below", study.GRID["entry_below"]),
            ("Exit above", "exit_above", study.GRID["exit_above"]),
            ("Trend average", "trend_length", study.GRID["trend_length"]), ("RSI type", "rsi_kind", study.GRID["rsi_kind"]))
    for label, field, values in axes:
        for value in values:
            params = rules.Params(**{**stated.__dict__, field: value})
            row = by_key[params.key()]
            rows.append({"cagr": row["cagr"], "maxDrawdown": min(0.0, row["maxDrawdown"]), "param": label,
                         "sharpe": row["sharpe"], "trades": row["trades"], "value": f"{value:g}" if isinstance(
                             value, float) else str(value)})
    return rows


def _robustness(results: Mapping) -> list[dict]:
    decision = results["decision"]
    out = []
    deciding = _deciding(results)["stats"]
    for check in decision["checks"]:
        out.append({"check": f"Options SPY: {check['check']}"[:80], "pass": bool(check["pass"]),
                    "result": check_value(check, deciding)[:300]})
    for check in decision["extras"]:
        out.append({"check": check["check"][:80], "pass": bool(check["pass"]), "result": check_value(check, None)[:300]})
    walk = results["walkForward"]
    if walk is not None:
        out.append({"check": "Walk-forward, 5 anchored folds (parameter pick)", "pass": None,
                    "result": (f"out-of-sample Sharpe of the picks {num(walk['outOfSampleSharpe'])} vs the fixed rule "
                               f"{num(walk['fixedOutOfSampleSharpe'])}; picked variant positive in "
                               f"{walk['positiveFolds']} of {walk['testedFolds']} folds")[:300]})
    stated = _share(results, "SPY", "close", 0.0)["stats"]
    out.append({"check": "90% win rate reproduces (SPY, as stated)", "pass": decision["winRateReproduces"],
                "result": f"{pct(stated['winRate'])} on {stated['trades']} trades (claim 90% on 103)"})
    dsl = results["dsl"]
    out.append({"check": "DSL definition = rule (NautilusTrader DSL engine, SPY)", "pass": bool(dsl["sameTrades"]),
                "result": (f"{dsl['trades']} trades, same entry and exit dates; equity gap {dsl['equityGap']:.1e} "
                           "to the share ledger (next open, no cost)")})
    return out[:20]


def _engine(results: Mapping) -> str:
    """The one NautilusTrader build that booked every share and options run, e.g. "nautilus_trader 1.227.0"."""
    engines = {row["engine"] for row in [*results["shares"], *results["options"]] if row.get("stats") is not None}
    if len(engines) != 1 or not next(iter(engines)).startswith("nautilus-trader-"):
        raise ValueError(f"Expected one NautilusTrader engine, got {sorted(map(str, engines))}")
    return "nautilus_trader " + next(iter(engines)).removeprefix("nautilus-trader-")


def study_document(results: Mapping) -> dict:
    provenance = results["provenance"]
    if provenance.get("dirtyFiles"):
        raise ValueError("The study ran with uncommitted code; its document names a commit without that code")
    stated = _share(results, "SPY", "close", 0.0)
    base = _share(results, "SPY", "close", study.COSTS["base"])
    deciding = _deciding(results)
    hold = results["buyHold"]["SPY"]
    data_hash = hashlib.sha256(json.dumps(provenance["dataFiles"], sort_keys=True).encode()).hexdigest()
    verdict = verdict_of(results)
    decision = results["decision"]
    failed = [check["check"] for check in [*decision["checks"], *decision["extras"]] if not check["pass"]]
    ds = deciding["stats"]
    reason = (f"Strict gate {'passed' if decision['passesGate'] else 'failed'} on the Vertex form (SPY 30-day call "
              f"debit vertical, 2% risk): Sharpe {num(ds['sharpe'])}, out-of-sample {num(ds['oosSharpe'])}, deflated "
              f"Sharpe {num(ds['deflatedSharpe'])} at N={results['trials']['n']}, max drawdown {pct(ds['maxDrawdown'])}. "
              f"Lower bar {'passed' if decision['passesLowerBar'] else 'failed'}. "
              + (f"Failed: {'; '.join(failed)}. " if failed else "")
              + f"Shares as stated: {pct(stated['stats']['winRate'])} wins on {stated['stats']['trades']} trades.")
    notes = (
        f"Claim (QuantifiedStrategies, SPY since 1993): 103 trades, 90% wins, +1.2% per trade, profit factor 4. "
        f"Ours (SPY {stated['stats']['start']} to {stated['stats']['end']}, signal close, no cost): "
        f"{stated['stats']['trades']} trades, {pct(stated['stats']['winRate'])} wins, "
        f"{pct(stated['stats']['averageReturn'], 2)} per trade, profit factor {num(stated['stats']['profitFactor'])}, "
        f"CAGR {pct(stated['stats']['cagr'])}, max drawdown {pct(stated['stats']['maxDrawdown'])}, in the market "
        f"{pct(stated['stats']['exposure'])} of days. With 5 bp per side: CAGR {pct(base['stats']['cagr'])}, Sharpe "
        f"{num(base['stats']['sharpe'])}. Buy-and-hold SPY: CAGR {pct(hold['cagr'])}, Sharpe {num(hold['sharpe'])}, "
        f"max drawdown {pct(hold['maxDrawdown'])}. Research only: no order, no deployment, Nautilus disarmed."
    )[:4000]
    comparison = [
        {"cagr": hold["cagr"], "kind": "buy-and-hold", "maxDrawdown": min(0.0, hold["maxDrawdown"]),
         "name": "Buy-and-hold SPY (total return)", "sharpe": hold["sharpe"]},
        {"cagr": stated["stats"]["cagr"], "kind": "strategy", "maxDrawdown": min(0.0, stated["stats"]["maxDrawdown"]),
         "name": "Triple RSI SPY shares, as stated", "sharpe": stated["stats"]["sharpe"]},
        {"cagr": base["stats"]["cagr"], "kind": "strategy", "maxDrawdown": min(0.0, base["stats"]["maxDrawdown"]),
         "name": "Triple RSI SPY shares, 5 bp/side", "sharpe": base["stats"]["sharpe"]},
        {"cagr": ds["cagr"], "kind": "strategy", "maxDrawdown": min(0.0, ds["maxDrawdown"]),
         "name": "Triple RSI SPY options (Vertex form)", "sharpe": ds["sharpe"]},
        # docs/specs/research/adx-filter.md S4 baseline (other sample and cost model; for orientation only).
        {"cagr": 0.026, "kind": "library", "maxDrawdown": -0.086, "name": "RSI(2) dip, Connors form (ADX study S4)",
         "sharpe": 0.59},
    ]
    return {
        "comparison": comparison,
        "equity": [{"drawdown": point["drawdown"], "month": point["month"], "value": point["value"]}
                   for point in results["curves"]["statedSpy"]][-400:],
        "equityLabel": "Triple RSI on SPY shares as stated (signal close, no cost), month-end return since the start",
        "forms": [
            {"description": ("The rule as stated on the ETF: 100% of equity at the close, total return, cash earns 0. "
                             "Rows per execution (signal close, next open, next close) and cost per side."),
             "key": "underlying", "label": "Shares (as stated)", "runs": _underlying_runs(results)[:80]},
            {"description": ("Vertex form: call debit vertical while the rule is long, 2% of equity at risk per spread, "
                             "Black-Scholes on the IV index (qc-ports option book), booked in NautilusTrader."),
             "key": "options", "label": "Options, defined risk (Vertex form)", "runs": _options_runs(results)[:80]},
        ],
        "gaps": [
            {"gap": "Instrument not in the post", "choice": "SPY (the article's title), then the Core 7 ETF twins."},
            {"gap": "RSI smoothing not stated", "choice": "Wilder (the DSL rsi); Cutler RSI as a variant."},
            {"gap": "Fallen three days in a row", "choice": "RSI(t) < RSI(t-1) < RSI(t-2) < RSI(t-3)."},
            {"gap": "Sizing and cash", "choice": "100% of equity, one position, cash earns 0."},
            {"gap": "Costs not stated", "choice": "None as stated; 5 bp per side base, 10 bp stress."},
            {"gap": "Dividends", "choice": "Total return (dividend-adjusted close) for the trade results."},
            {"gap": "Buying at the close needs the close", "choice": "Next open and next close reported as variants."},
        ],
        "id": STUDY_ID,
        "kind": "strategy-backtest",
        "notes": notes,
        "provenance": {"commit": provenance["commit"][:40], "dataHash": f"sha256:{data_hash}",
                       "engine": _engine(results),
                       "runId": f"triple-rsi-{provenance['ran']}-{provenance['commit'][:8]}"},
        "ran": provenance["ran"],
        "robustness": _robustness(results),
        "rules": [
            {"item": "Entry 1", "rule": "5-day RSI below 30.", "source": "QuantifiedStrategies post"},
            {"item": "Entry 2", "rule": "5-day RSI has fallen three days in a row.", "source": "QuantifiedStrategies post"},
            {"item": "Entry 3", "rule": "5-day RSI was below 60 three trading days ago.",
             "source": "QuantifiedStrategies post"},
            {"item": "Entry 4", "rule": "Close above the 200-day simple moving average.",
             "source": "QuantifiedStrategies post"},
            {"item": "Entry", "rule": "Buy at the close when all four hold.", "source": "QuantifiedStrategies post"},
            {"item": "Exit", "rule": "Sell at the close when the 5-day RSI crosses above 50.",
             "source": "QuantifiedStrategies post"},
        ],
        "sensitivity": _sensitivity(results),
        "source": {"label": "QuantifiedStrategies: Triple RSI Trading Strategy (90% win rate)", "url": SOURCE_URL},
        "spec": SPEC,
        "title": "Triple RSI (QuantifiedStrategies, \"90% win rate\"): SPY and Core 7, shares and options",
        "verdict": verdict,
        "verdictReason": reason[:1000],
    }
