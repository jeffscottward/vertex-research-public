"""The research_studies document of the Trend Trio study (kind "strategy-backtest", research only).

Schema: StrategyBacktestStudySchema in packages/api/src/contracts/research-studies.ts (numbers are fractions,
drawdowns negative). Returns and drawdowns are fractions of a $100,000 capital basis per NQ contract (stated in
the notes; not comparable with equity studies). `study_document` builds it from the results document of
study.assemble plus its provenance (run.py). Stored with `bun run vertex:research-studies:import`; the import
checks the schema again. Outcome "reconstruction passed" maps to verdict "edge", "reconstruction failed" to
"no-edge" (or "needs-more-data" when P1 has fewer than 30 trades).
"""
from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping

from . import study

__all__ = ["SOURCE_URL", "SPEC", "STUDY_ID", "nautilus_text", "study_document", "usd", "verdict_of"]

STUDY_ID = "trend-trio"
SPEC = "docs/specs/strategies/trend-trio.md"
SOURCE_URL = "https://www.instagram.com/reel/DfuMtdWKDB7/"
SOURCE_LABEL = "Technical Trading (Instagram reel): Trend Trio, \"16 of 16 years\" on 1 NQ contract"
TITLE = "Trend Trio (Vertex reconstruction, rules guessed): SuperTrend, Ultimate MA, AlphaTrend on NQ proxies"
DATASET_SYMBOL = {"a": "NAS100 CFD 1m (a)", "b": "QQQ 5m in NDX points (b)", "c": "NQ 5m (c)",
                  "a5": "NAS100 CFD 5m (bridge)"}
MIN_TRADES = 30
PASSED = "reconstruction passed"
FAILED = "reconstruction failed"
LIMITS = "Rules guessed; this tests a reconstruction, not the paid rules."

RULES = (
    ("Signal timeframe", "5-minute buckets built from 1-minute bars; 15 minutes is a second row (P2).", "Video"),
    ("Long alignment", ("SuperTrend, Ultimate MA and AlphaTrend directions +1 and Slingshot +1 at a bucket close; "
                       "short: all -1."), "Video (indicators named) + decision record Q4"),
    ("Episode", ("Starts at a bucket close where the alignment holds and did not hold at the previous one, or at "
                "the first bucket of a session; lasts while it holds."), "Decision record Q4"),
    ("Entry", ("First 1-minute close in the episode where the 1-minute Chandelier Exit agrees; fill at the next "
              "open; one entry per episode; decisions 09:35-15:50 New York."), "Decision record Q4 + Vertex"),
    ("Exit", ("Chandelier Exit against the position (next open); an opposite entry reverses; otherwise market on "
             "close at the last regular bar. One position at a time."), "Video (Chandelier) + decision record Q2, Q5"),
    ("Defaults", ("SuperTrend 10/3; Ultimate MA SMA 20, smoothing 2; AlphaTrend 14/1 MFI; Chandelier 22/3; "
                 "Slingshot 38/62."), "Published defaults, decision record Q6"),
    ("Costs", "1 NQ = $20 per point; tick 0.25 = $5; fees $4.50 per round trip; slippage 0, 1, 2 ticks per side.",
     "Decision record Q3"),
)
GAPS = (
    ("Exact entry and exit rules (sold behind a paywall)",
     "Guessed from the video and the decision record; 33 declared rows test the guesses."),
    ("No NQ 1-minute history", ("Dukascopy NAS100 CFD mid 1-minute bars (a) and QQQ 5-minute bars in NDX points "
                                "(b); real NQ 5-minute bars 2024-2025 as a tracking check.")),
    ("Chart session", "Regular-session bars; full-session indicators as row V8."),
    ("Volume for AlphaTrend MFI", "CFD tick volume; RSI momentum as row V5."),
    ("Slippage", "Claim says none; 1 tick per side graded, 0 and 2 reported."),
    ("Capital basis", "$100,000 per contract for the fractions of this document."),
)


def usd(value: float | None) -> str:
    return "n/a" if value is None else f"${value:,.0f}"


def _row(results: Mapping, row: str) -> Mapping:
    return next(item for item in results["rows"] if item["row"] == row)


def verdict_of(results: Mapping) -> str:
    if results["outcome"] == PASSED:
        return "edge"
    p1 = _row(results, "P1")
    if p1["status"] != "ran" or p1["stats"][str(study.BASE_TICKS)]["trades"] < MIN_TRADES:
        return "needs-more-data"
    return "no-edge"


def _run(row: Mapping, tick: int) -> dict:
    stats = row["stats"][str(tick)]
    return {"buyHoldCagr": None, "buyHoldSharpe": None, "cagr": stats["cagr"],
            "exposure": min(1.0, stats["timeInMarket"]),
            "from": row["from"], "market": f"{row['row']}, {tick} tick/side, fees $4.50"[:60],
            "maxDrawdown": min(0.0, stats["maxDrawdown"]), "oosCagr": None, "oosSharpe": None,
            "profitFactor": stats["profitFactor"], "sharpe": stats["sharpe"],
            "symbol": DATASET_SYMBOL[row["dataset"]][:40], "to": row["to"], "trades": stats["trades"],
            "winRate": stats["winRate"]}


def _runs(results: Mapping) -> list[dict]:
    runs = []
    for row, ticks in (("P1", study.SLIPPAGE_TICKS), ("P2", (study.BASE_TICKS,)), ("P3", study.SLIPPAGE_TICKS)):
        item = _row(results, row)
        if item["status"] == "ran":
            runs += [_run(item, tick) for tick in ticks]
    return runs


def _sensitivity(results: Mapping) -> list[dict]:
    rows = []
    for item in results["rows"]:
        if item["row"][0] not in "VS" or item["status"] != "ran":
            continue
        stats = item["stats"][str(study.BASE_TICKS)]
        rows.append({"cagr": stats["cagr"], "maxDrawdown": min(0.0, stats["maxDrawdown"]),
                     "param": f"{item['row']} {item['change']}"[:60], "sharpe": stats["sharpe"],
                     "trades": stats["trades"], "value": f"net {usd(stats['netUsd'])}"[:40]})
    return rows[:80]


def _years_text(row: Mapping, tick: int = study.BASE_TICKS) -> str:
    per = row["stats"][str(tick)]["perYear"]
    return ", ".join(f"{year} {usd(value)}" for year, value in sorted(per.items()))


def _claim_text(results: Mapping) -> str:
    claim = results["claim"]
    parts = []
    for row, label in (("P1", "(a)"), ("P3", "(b)")):
        if row in claim:
            zero, one = claim[row]["0"], claim[row][str(study.BASE_TICKS)]
            parts.append(f"{label} {row}: {zero[0]}/{zero[1]} full years profitable at 0 tick, "
                         f"{one[0]}/{one[1]} at 1 tick")
    if "P3window" in claim:
        window = claim["P3window"][str(study.BASE_TICKS)]
        parts.append(f"P3 in 2010-2025: {window[0]}/{window[1]} at 1 tick")
    return "; ".join(parts) if parts else "no graded row ran"


def _robustness(results: Mapping) -> list[dict]:
    out = [{"check": f"{test['id']} {test['name']}"[:80], "pass": test["pass"], "result": test["value"][:300]}
           for test in results["tests"]]
    diag = results["diagnostics"]
    wf = results["walkForward"]
    picks = ", ".join(f"{fold['year']} {fold['pick']}" for fold in wf["folds"]) or "no test year"
    out.append({"check": "Walk-forward picks (anchored, 2016-2025)", "pass": None,
                "result": f"stitched net {usd(wf['stitchedNet'])}; picks {picks}"[:300]})
    for row, label in (("LA", "Look-ahead row (diagnostic)"), ("BR", "Bridge row: (b) rules on (a) at 5 minutes")):
        item = diag["rows"][row]
        result = (f"net {usd(item['stats'][str(study.BASE_TICKS)]['netUsd'])} on "
                  f"{item['stats'][str(study.BASE_TICKS)]['trades']} trades" if item["status"] == "ran"
                  else item["status"])
        out.append({"check": label, "pass": None, "result": result[:300]})
    tracking = diag["tracking"]["nqVsP3"]
    corr = tracking["correlation"]
    out.append({"check": "NQ tracking: P3 rules on NQ vs QQQ (per session)", "pass": None,
                "result": (f"{tracking['sessions']} sessions, correlation "
                           f"{'n/a' if corr is None else f'{corr:.2f}'}, NQ {usd(tracking['left'])} vs "
                           f"QQQ {usd(tracking['right'])}")[:300]})
    nautilus = diag["nautilus"]
    same = [row for row, item in nautilus.items() if _nautilus_state(item) == "same"]
    out.append({"check": "NautilusTrader fill check (P1-P3)", "pass": len(same) == len(nautilus),
                "result": nautilus_text(results)[:300]})
    out.append({"check": "Claim 16/16 years vs reconstruction", "pass": None, "result": _claim_text(results)[:300]})
    return out[:20]


def _nautilus_state(item: Mapping | None) -> str:
    """"same", "NOT the same" or "not run" for one row's NautilusTrader check."""
    if not item or item.get("status") != "ran":
        return "not run"
    return "same" if item.get("same") else "NOT the same"


def nautilus_text(results: Mapping) -> str:
    """Per row: did NautilusTrader book the same entry/exit bars and fill prices as the rule module?"""
    states = ", ".join(f"{row} {_nautilus_state(item)}" for row, item in results["diagnostics"]["nautilus"].items())
    return f"NautilusTrader entry/exit bars and fill prices vs the rule module: {states or 'not run'}."


def _engine(results: Mapping) -> str:
    engines = {item["engine"] for item in results["diagnostics"]["nautilus"].values() if item and item.get("engine")}
    if len(engines) != 1 or not next(iter(engines)).startswith("nautilus-trader-"):
        raise ValueError(f"Expected one NautilusTrader engine, got {sorted(map(str, engines))}")
    return "nautilus_trader " + next(iter(engines)).removeprefix("nautilus-trader-")


def _notes(results: Mapping) -> str:
    p1, p3 = _row(results, "P1"), _row(results, "P3")
    parts = [f"Claim: 1 NQ contract profitable in each of the last 16 years, fees included, no slippage. "
             f"Ours: {_claim_text(results)}. Outcome: {results['outcome']}"
             + (f" (first failing test {results['decidingTest']})." if results["decidingTest"] else ".")]
    for row, label in ((p1, "P1 (a) net per year at 1 tick/side"), (p3, "P3 (b) net per year at 1 tick/side")):
        if row["status"] == "ran":
            parts.append(f"{label}: {_years_text(row)}.")
    parts.append("Returns and drawdowns are fractions of a $100,000 capital basis per contract (no compounding); "
                 f"not comparable with equity studies. Booked by the dollar ledger. {nautilus_text(results)} "
                 f"{LIMITS} Research only: no order, no deployment.")
    return " ".join(parts)[:4000]


def _comparison(results: Mapping) -> list[dict]:
    out = []
    for row in ("P1", "P2", "P3"):
        item = _row(results, row)
        if item["status"] == "ran":
            stats = item["stats"][str(study.BASE_TICKS)]
            out.append({"cagr": stats["cagr"], "kind": "strategy", "maxDrawdown": min(0.0, stats["maxDrawdown"]),
                        "name": f"Trend Trio {row} ({item['dataset']}), 1 tick/side"[:80], "sharpe": stats["sharpe"]})
    return out


def study_document(results: Mapping) -> dict:
    provenance = results["provenance"]
    if provenance.get("dirtyFiles"):
        raise ValueError("The study ran with uncommitted code; its document names a commit without that code")
    if results.get("blocked") or results["outcome"] not in (PASSED, FAILED):
        raise ValueError(f"The study has no outcome ({results['outcome']}); a blocked study has no document")
    files = results["data"].get("files", [])
    data_hash = hashlib.sha256(json.dumps(files, sort_keys=True).encode()).hexdigest()
    tests = results["tests"]
    failed = [f"{test['id']} ({test['value']})" for test in tests if test["pass"] is not True]
    reason = (f"{results['outcome'].capitalize()}: "
              + ("T1-T7 all pass. " if not failed else f"not passed {'; '.join(failed)}. ")
              + f"Claim 16/16 years; {_claim_text(results)}. {LIMITS}")
    return {
        "comparison": _comparison(results),
        "equity": [{"drawdown": point["drawdown"], "month": point["month"], "value": point["value"]}
                   for point in results["curve"]][-400:],
        "equityLabel": "Trend Trio P1 on the NAS100 CFD (a), 1 tick/side and fees, on $100,000 per contract",
        "forms": [{"description": ("1 NQ contract in index points, booked by the dollar ledger ($20 per point, $4.50 "
                                   "fees, slippage per side) from the rule module's trades. "
                                   f"{nautilus_text(results)} Fractions of $100,000 per contract."),
                   "key": "underlying", "label": "1 NQ contract (proxies (a) and (b))", "runs": _runs(results)[:80]}],
        "gaps": [{"choice": choice, "gap": gap} for gap, choice in GAPS],
        "id": STUDY_ID,
        "kind": "strategy-backtest",
        "notes": _notes(results),
        "provenance": {"commit": provenance["commit"][:40], "dataHash": f"sha256:{data_hash}",
                       "engine": _engine(results),
                       "runId": f"trend-trio-{provenance['ran']}-{provenance['commit'][:8]}"},
        "ran": provenance["ran"],
        "robustness": _robustness(results),
        "rules": [{"item": item, "rule": rule, "source": source} for item, rule, source in RULES],
        "sensitivity": _sensitivity(results),
        "source": {"label": SOURCE_LABEL, "url": SOURCE_URL},
        "spec": SPEC,
        "title": TITLE,
        "verdict": verdict_of(results),
        "verdictReason": reason[:1000],
    }
