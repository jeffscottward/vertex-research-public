"""The market intraday momentum reel study: GHLZ, ZAB and BIAS on the Core 7 futures proxies and ETF twins,
both forms (underlying and same-day debit verticals), 60/40 out-of-sample split, walk-forward, sensitivity,
cost stress, Monte Carlo, deflated Sharpe and the comparisons, assembled as one `strategy-backtest` research
study document plus a detail JSON for the report (research only; nothing creates an order).

Pre-registered design and pass rule: docs/specs/strategies/market-intraday-momentum.md (commit 3131469c).
"""
from __future__ import annotations

import json
import math
import os
import subprocess
import sys
from collections.abc import Callable, Mapping, Sequence
from concurrent.futures import ProcessPoolExecutor
from datetime import date
from pathlib import Path

from . import metrics as m
from .data import BY_KEY, ETF_TWINS, FUTURES_PROXIES, INSTRUMENTS, PRIMARY, available, daily_closes, data_hash, load_bars
from .definition import (
    BIAS_SENSITIVITY,
    GHLZ,
    GHLZ_SENSITIVITY,
    STRATEGIES,
    WALK_FORWARD_GRID,
    ZAB_SENSITIVITY,
    Params,
    params_to_json,
)
from .runner import CAPITAL, ENGINE_ID, run_job

REEL_URL = "https://www.instagram.com/reel/DffkN31PrN7/"
SLUG = "market-intraday-momentum"
SPEC_PATH = f"docs/specs/strategies/{SLUG}.md"
PRIMARY_STRATEGY = "ghlz"
# Gate thresholds (packages/api/src/autopilot-gate.ts defaults), as pre-registered.
GATE = {"oosSharpeMin": 0.5, "deflatedSharpeMin": 0.95, "monteCarloDrawdownP5Min": -0.35,
        "neighbourShareMin": 0.75, "costStressMultiple": 2.0}
MIN_TRADES = 100
LD34_STUDY_CANDIDATES = (
    Path.home() / "Documents" / "reports" / "web" / "vertex-reel-dffcosd" / "run2" / "study.json",
    Path.home() / "Documents" / "reports" / "web" / "vertex-reel-dffcosd" / "final" / "study.json",
)
STRATEGY_NAMES = {sid: name for sid, name, _ in STRATEGIES}

Log = Callable[[str], None]


def _log(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


# ------------------------------------------------------------------------------------------------
# Jobs


def leg_id(key: str, params: Params, side: str, mult: float) -> tuple:
    """Identity of one Nautilus leg run: a long-only variant's long leg is the base long leg."""
    fields = params_to_json(params)
    fields.pop("sides")
    return (key, json.dumps(fields, sort_keys=True), side, float(mult))


def config_id(params: Params) -> str:
    return json.dumps(params_to_json(params), sort_keys=True)


def plan_jobs(keys: Sequence[str]) -> tuple[list[tuple[str, Params, str, float]], dict]:
    """Every distinct leg run of the study, and the configurations tried on the primary market."""
    configs: dict[str, tuple[str, Params]] = {}  # config id -> (label, params), primary market

    def add_config(label: str, params: Params) -> None:
        configs.setdefault(config_id(params), (label, params))

    runs: list[tuple[str, Params, float]] = []
    for key in keys:
        for _, _, params in STRATEGIES:
            runs.append((key, params, 1.0))
    stress = float(GATE["costStressMultiple"])
    for _, _, params in STRATEGIES:
        runs.append((PRIMARY, params, stress))
    runs += [(key, GHLZ, stress) for key in keys if key != PRIMARY]
    for sid, name, params in STRATEGIES:
        add_config(name, params)
    for group, rows in (("GHLZ", GHLZ_SENSITIVITY), ("ZAB", ZAB_SENSITIVITY), ("BIAS", BIAS_SENSITIVITY)):
        for param, value, params in rows:
            runs.append((PRIMARY, params, 1.0))
            add_config(f"{group} {param} {value}", params)
    for params in WALK_FORWARD_GRID:
        runs.append((PRIMARY, params, 1.0))
        add_config(f"GHLZ walk-forward signal end {params.signal_to}, entry {params.entry}", params)
    jobs: list[tuple[str, Params, str, float]] = []
    seen: set[tuple] = set()
    for key, params, mult in runs:
        for side in params.sides:
            ident = leg_id(key, params, side, mult)
            if ident not in seen:
                seen.add(ident)
                jobs.append((key, params, side, mult))
    return jobs, configs


def _run_all(jobs: Sequence[tuple[str, Params, str, float]], root: str | None, workers: int, log: Log) -> dict:
    payload = [(key, params_to_json(params), side, mult, root) for key, params, side, mult in jobs]
    out: dict[tuple, dict] = {}
    # The longest markets first so the pool stays busy.
    order = sorted(range(len(jobs)), key=lambda i: (jobs[i][0] != PRIMARY, jobs[i][0]))
    with ProcessPoolExecutor(max_workers=workers) as pool:
        futures = {i: pool.submit(run_job, payload[i]) for i in order}
        for done, i in enumerate(order, start=1):
            result = futures[i].result()
            key, params, side, mult = jobs[i]
            out[leg_id(key, params, side, mult)] = result
            log(f"run {done}/{len(jobs)} {key} {params.family} {side} x{mult:g} trades={len(result['trades'])}")
    return out


def _warm_cache(keys: Sequence[str], root: str | None, workers: int, log: Log) -> None:
    with ProcessPoolExecutor(max_workers=min(workers, len(keys))) as pool:
        for key, n in zip(keys, pool.map(_bar_count, [(k, root) for k in keys])):
            log(f"data {key}: {n} five-minute bars")


def _bar_count(job: tuple[str, str | None]) -> int:
    return len(load_bars(job[0], job[1]))


# ------------------------------------------------------------------------------------------------
# Results


class Results:
    """Leg runs by identity; strategy curves are the leg sum."""

    def __init__(self, runs: Mapping[tuple, dict]) -> None:
        self.runs = runs

    def legs(self, key: str, params: Params, mult: float = 1.0) -> list[dict]:
        return [self.runs[leg_id(key, params, side, mult)] for side in params.sides]

    def points(self, key: str, params: Params, mult: float = 1.0) -> list:
        return m.sum_legs([leg["points"] for leg in self.legs(key, params, mult)])

    def trades(self, key: str, params: Params, mult: float = 1.0) -> list[dict]:
        out = [t for leg in self.legs(key, params, mult) for t in leg["trades"]]
        return sorted(out, key=lambda t: t["entryMs"])


def _exposure(legs: Sequence[dict]) -> float:
    values = [float(leg["stats"].get("exposure", 0.0)) for leg in legs]
    return min(1.0, max(0.0, sum(values)))


def underlying_row(results: Results, key: str, sid: str, params: Params, bh: Sequence) -> dict:
    points = results.points(key, params)
    s = m.summary(points)
    trades = results.trades(key, params)
    ts = m.trade_stats(trades)
    bh_w = m.window(bh, points)
    bh_s = m.stats(bh_w) if len(bh_w) > 2 else None
    item = BY_KEY[key]
    return {
        "symbol": f"{STRATEGY_NAMES[sid]} {key}"[:40], "market": f"{STRATEGY_NAMES[sid]}: {item.label}"[:60],
        "from": points[0][0], "to": points[-1][0], "trades": ts["trades"],
        "cagr": s["full"]["cagr"], "sharpe": s["full"]["sharpe"], "maxDrawdown": s["full"]["maxDrawdown"],
        "profitFactor": ts["profitFactor"], "winRate": ts["winRate"],
        "exposure": _exposure(results.legs(key, params)),
        "oosSharpe": s["outOfSample"]["sharpe"], "oosCagr": s["outOfSample"]["cagr"],
        "buyHoldCagr": bh_s["cagr"] if bh_s else None, "buyHoldSharpe": bh_s["sharpe"] if bh_s else None,
    }


def _run_entry(form: str, sid: str, key: str, points: Sequence, trades: int, extra: dict | None = None) -> dict:
    s = m.summary(points)
    out = {"form": form, "strategy": STRATEGY_NAMES[sid], "strategyId": sid, "market": key,
           "start": points[0][0] if points else None, "end": points[-1][0] if points else None,
           "sharpe": s["full"]["sharpe"], "cagr": s["full"]["cagr"], "maxDd": s["full"]["maxDrawdown"],
           "trades": trades, "oosSharpe": s["outOfSample"]["sharpe"], "oosCagr": s["outOfSample"]["cagr"],
           "isSharpe": s["inSample"]["sharpe"]}
    if extra:
        out.update(extra)
    return out


# ------------------------------------------------------------------------------------------------
# Options form


def options_form(results: Results, keys: Sequence[str], root: str | None, log: Log) -> dict:
    """Same-day debit verticals on the ETF twin of every signal market, per strategy."""
    from strategies.qc_ports.data import load_market

    from .options import EtfClock, OptionEvent, book, price_events, spread_returns

    twins = sorted({BY_KEY[k].twin for k in keys if available(BY_KEY[k].twin, root)})
    etfs = {t: EtfClock(load_bars(t, root)) for t in twins}
    markets = {t: load_market(t) for t in twins}
    out: dict[tuple[str, str], dict] = {}
    for sid, _, params in STRATEGIES:
        for key in keys:
            twin = BY_KEY[key].twin
            if twin not in etfs:
                continue
            events = [OptionEvent(key, twin, t["side"], t["entryMs"]) for t in results.trades(key, params)]
            spreads, skipped = price_events(events, etfs, markets)
            if not spreads:
                log(f"options {sid} {key}->{twin}: no priced spreads ({len(skipped)} skipped)")
                continue
            first = spreads[0].day
            closes = [t for day, (t, _) in etfs[twin].close_of_day.items() if day >= first]
            booked = book(spreads, closes, CAPITAL)
            reasons: dict[str, int] = {}
            for s in skipped:
                reasons[s["reason"]] = reasons.get(s["reason"], 0) + 1
            booked["spreads"] = spreads
            booked["skipped"] = skipped
            booked["skipReasons"] = reasons
            booked["returns"] = spread_returns(booked["nautilus"], CAPITAL)
            out[(sid, key)] = booked
            log(f"options {sid} {key}->{twin}: {len(booked['nautilus'].trades)} spreads, {len(skipped)} skipped, "
                f"ledger gap {booked['maxGap']:.4f}")
    return out


def option_row(sid: str, key: str, booked: dict, bh: Sequence) -> dict:
    points = booked["points"]
    s = m.summary(points)
    trades = booked["nautilus"].trades
    pnl = [t.get("pnl", 0.0) for t in trades]
    wins = [p for p in pnl if p > 0]
    losses = [-p for p in pnl if p <= 0]
    twin = BY_KEY[key].twin
    bh_w = m.window(bh, points)
    bh_s = m.stats(bh_w) if len(bh_w) > 2 else None
    held = sum(1 for n in booked["nautilus"].open_positions if n > 0)
    return {
        "symbol": f"{STRATEGY_NAMES[sid]} {twin} opt ({key})"[:40],
        "market": f"{STRATEGY_NAMES[sid]}: {twin} debit verticals on {key} signals"[:60],
        "from": points[0][0], "to": points[-1][0], "trades": len(trades),
        "cagr": s["full"]["cagr"], "sharpe": s["full"]["sharpe"], "maxDrawdown": s["full"]["maxDrawdown"],
        "profitFactor": sum(wins) / sum(losses) if losses and sum(losses) > 0 else None,
        "winRate": len(wins) / len(pnl) if pnl else 0.0,
        "exposure": held / len(booked["nautilus"].open_positions) if booked["nautilus"].open_positions else 0.0,
        "oosSharpe": s["outOfSample"]["sharpe"], "oosCagr": s["outOfSample"]["cagr"],
        "buyHoldCagr": bh_s["cagr"] if bh_s else None, "buyHoldSharpe": bh_s["sharpe"] if bh_s else None,
    }


# ------------------------------------------------------------------------------------------------
# Gates and verdict


def checks_of(primary: dict, dsr: dict, mc: dict, neighbour_share: float, n_neighbours: int, stress: dict, wf: dict,
              base_wf: dict, options: dict) -> list[dict]:
    oos = primary["outOfSample"]
    return [
        {"check": "Out-of-sample Sharpe (last 40 %)", "value": oos["sharpe"], "threshold": GATE["oosSharpeMin"],
         "pass": oos["sharpe"] >= GATE["oosSharpeMin"],
         "result": f"OOS Sharpe {oos['sharpe']:.2f} (IS {primary['inSample']['sharpe']:.2f}); OOS CAGR {oos['cagr']:.1%}"},
        {"check": "Deflated Sharpe probability", "value": dsr["probability"], "threshold": GATE["deflatedSharpeMin"],
         "pass": dsr["probability"] >= GATE["deflatedSharpeMin"],
         "result": f"{dsr['probability']:.3f} over {dsr['trials']} configurations tried on the primary market"},
        {"check": "Monte Carlo drawdown P5", "value": mc.get("maxDrawdownP5"),
         "threshold": GATE["monteCarloDrawdownP5Min"],
         "pass": mc.get("maxDrawdownP5", -1) >= GATE["monteCarloDrawdownP5Min"],
         "result": f"P5 max drawdown {mc.get('maxDrawdownP5', 0):.1%} over {mc.get('paths', 0)} trade bootstraps; "
                   f"loss share {mc.get('lossShare', 0):.0%}"},
        {"check": "Parameter neighbours with Sharpe > 0", "value": neighbour_share, "threshold": GATE["neighbourShareMin"],
         "pass": neighbour_share >= GATE["neighbourShareMin"],
         "result": f"{neighbour_share:.0%} of {n_neighbours} one-at-a-time GHLZ changes"},
        {"check": "2x costs", "value": stress["sharpe"], "threshold": 0, "pass": stress["sharpe"] > 0,
         "result": f"Sharpe {stress['sharpe']:.2f}, CAGR {stress['cagr']:.1%} with doubled spread and slippage"},
        {"check": "Walk-forward (3 y train, 1 y test)", "value": wf["sharpe"], "threshold": None, "pass": None,
         "result": f"stitched Sharpe {wf['sharpe']:.2f} vs stated rules {base_wf['sharpe']:.2f} on the same years"},
        {"check": "Options form OOS Sharpe (SPY verticals)", "value": options["outOfSample"]["sharpe"], "threshold": 0,
         "pass": options["outOfSample"]["sharpe"] > 0,
         "result": f"OOS Sharpe {options['outOfSample']['sharpe']:.2f}, full {options['full']['sharpe']:.2f}"},
    ]


def verdict_of(primary: dict, dsr: dict, checks: list[dict], options: dict, trades: int) -> tuple[str, str]:
    """The pre-registered rule (spec 'Pass/fail rule'); the reason names the failed gates and the options form."""
    gates = checks[:5]
    passed = sum(1 for c in gates if c["pass"])
    failed = "; ".join(f"{c['check']}: {c['result']}" for c in gates if not c["pass"]) or "none"
    oos = primary["outOfSample"]["sharpe"]
    opt = options["outOfSample"]["sharpe"]
    tail = (f"{passed}/5 gates pass on GHLZ US500 (OOS Sharpe {oos:.2f}, deflated Sharpe probability "
            f"{dsr['probability']:.2f}). Failed: {failed}. Options form OOS Sharpe {opt:.2f}.")
    if oos <= 0 or dsr["probability"] < 0.5 or passed <= 2:
        return "no-edge", tail
    if trades < MIN_TRADES:
        return "needs-more-data", f"Only {trades} trades on the primary. " + tail
    if passed == len(gates) and opt > 0:
        return "edge", tail
    return "needs-more-data", tail


# ------------------------------------------------------------------------------------------------
# Comparisons


def library_rows(repo: Path) -> list[dict]:
    """Buy-and-hold and library strategy rows of the committed Core 7 re-run (research artifact)."""
    path = repo / "research" / "backtests" / "core7" / "rerun-results.json"  # json-data-ignore: committed research artifact, read for a comparison table; the app never reads it
    data = json.loads(path.read_text())
    rows = []
    for universe in data["buyAndHold"]:
        s = universe["combined"]["summary"]
        rows.append({"name": f"Buy and hold, {universe['label']} ({s['start']} to {s['end']})"[:80],
                     "kind": "buy-and-hold", "sharpe": s["sharpe"], "cagr": s["cagr"], "maxDrawdown": s["maxDrawdown"],
                     "source": "research/backtests/core7/rerun-results.json"})
    for strategy in data["strategies"]:
        for universe in strategy.get("universes", []):
            if universe.get("id") != "core7-etf-twins":
                continue
            s = universe["combined"]["summary"]
            window = f"{s.get('start', '?')[:4]}-{s.get('end', '?')[:4]}"
            rows.append({"name": f"{strategy['name']} (library, ETF twins, daily, {window})"[:80], "kind": "library",
                         "sharpe": s["sharpe"], "cagr": s["cagr"], "maxDrawdown": s["maxDrawdown"],
                         "source": "research/backtests/core7/rerun-results.json"})
    return rows


def ld34_rows() -> list[dict]:
    for path in LD34_STUDY_CANDIDATES:
        if path.exists():
            study = json.loads(path.read_text())
            rows = [dict(row, source=str(path)) for row in study.get("comparison", [])
                    if row.get("kind") == "strategy" and str(row.get("name", "")).startswith("LD34")]
            return rows[:2]
    return []


# ------------------------------------------------------------------------------------------------
# Study


def run_study(ran: str, *, root: str | None = None, workers: int = 8, repo: Path | None = None,
              detail_path: Path | None = None, log: Log = _log) -> dict:
    repo = repo or Path(__file__).resolve().parents[4]
    keys = [item.key for item in INSTRUMENTS if available(item.key, root)]
    missing = [item.key for item in INSTRUMENTS if item.key not in keys]
    if PRIMARY not in keys:
        raise FileNotFoundError(f"No data for the primary market {PRIMARY}")
    if missing:
        log(f"warning: no data for {', '.join(missing)}; they are left out")
    _warm_cache(keys, root, workers, log)
    jobs, configs = plan_jobs(keys)
    log(f"{len(jobs)} Nautilus leg runs on {workers} workers")
    results = Results(_run_all(jobs, root, workers, log))

    bh = {key: daily_closes(load_bars(key, root)) for key in keys}
    rows, runs_detail, curves = [], [], {}
    for sid, _, params in STRATEGIES:
        for key in keys:
            rows.append(underlying_row(results, key, sid, params, bh[key]))
            points = results.points(key, params)
            curves[(sid, key)] = points
            runs_detail.append(_run_entry("underlying", sid, key, points, len(results.trades(key, params)),
                                          {"label": BY_KEY[key].label, "spreadBps": results.legs(key, params)[0]["spreadBps"],
                                           "legs": {leg["side"]: {"trades": len(leg["trades"]),
                                                                  **m.summary(leg["points"])["full"]}
                                                    for leg in results.legs(key, params)}}))

    # Primary: GHLZ on the US500 CFD.
    primary = curves[(PRIMARY_STRATEGY, PRIMARY)]
    primary_summary = m.summary(primary)
    primary_trades = results.trades(PRIMARY, GHLZ)
    is_part, oos_part = m.split(primary, m.IS_FRACTION)

    def part_trades(first: str, last: str) -> dict:
        ts = m.trade_stats(m.trades_between(primary_trades, first, last))
        return {"trades": ts["trades"], "winRate": ts["winRate"], "profitFactor": ts["profitFactor"]}

    # Sensitivity (one at a time) on the primary market.
    sens_rows, sens_detail = [], []
    trial_sharpes: dict[str, float] = {}
    for cid, (label, params) in configs.items():
        trial_sharpes[cid] = m.stats(results.points(PRIMARY, params))["sharpePerDay"]
    positive = 0
    for group, rows_ in (("GHLZ", GHLZ_SENSITIVITY), ("ZAB", ZAB_SENSITIVITY), ("BIAS", BIAS_SENSITIVITY)):
        for param, value, params in rows_:
            points = results.points(PRIMARY, params)
            s = m.stats(points)
            n = len(results.trades(PRIMARY, params))
            sens_rows.append({"param": f"{group} {param}"[:60], "value": value[:40], "sharpe": s["sharpe"],
                              "cagr": s["cagr"], "maxDrawdown": s["maxDrawdown"], "trades": n})
            sens_detail.append({"strategy": group, "change": f"{param} = {value}", "sharpe": s["sharpe"],
                                "cagr": s["cagr"], "maxDd": s["maxDrawdown"], "trades": n,
                                "oosSharpe": m.summary(points)["outOfSample"]["sharpe"]})
            if group == "GHLZ":
                positive += s["sharpe"] > 0
    neighbour_share = positive / len(GHLZ_SENSITIVITY)

    # Walk-forward over GHLZ signal end x entry time.
    wf_candidates = [results.points(PRIMARY, params) for params in WALK_FORWARD_GRID]
    wf = m.walk_forward(wf_candidates, warmup_days=0)
    wf_stats = m.stats(wf["curve"]) if len(wf["curve"]) > 2 else m.stats(primary)
    base_on_wf = m.stats([p for p in primary if p[0] >= wf["curve"][0][0]]) if wf["curve"] else m.stats(primary)
    picks = [dict(p, signalEnd=WALK_FORWARD_GRID[p["pick"]].signal_to, entry=WALK_FORWARD_GRID[p["pick"]].entry)
             for p in wf["picks"]]

    stress_points = results.points(PRIMARY, GHLZ, GATE["costStressMultiple"])
    stress_stats = m.stats(stress_points)
    stress_all = {sid: m.stats(results.points(PRIMARY, params, GATE["costStressMultiple"]))
                  for sid, _, params in STRATEGIES}
    stress_markets = {key: m.stats(results.points(key, GHLZ, GATE["costStressMultiple"])) for key in keys}
    trade_rets = m.trade_returns(primary_trades)
    mc = m.monte_carlo(trade_rets, paths=m.MC_PATHS, seed=m.MC_SEED)
    dsr = m.deflated_sharpe(primary, len(configs), list(trial_sharpes.values()))

    log("options form")
    options = options_form(results, keys, root, log)
    opt_rows = []
    for sid, _, _ in STRATEGIES:
        for key in keys:
            booked = options.get((sid, key))
            if booked is None or len(booked["points"]) < 3:
                continue
            twin = BY_KEY[key].twin
            opt_rows.append(option_row(sid, key, booked, bh.get(twin, [])))
            runs_detail.append(_run_entry(
                "options", sid, key, booked["points"], len(booked["nautilus"].trades),
                {"twin": twin, "skipped": len(booked["skipped"]), "skipReasons": booked["skipReasons"],
                 "ledgerNautilusMaxGap": booked["maxGap"],
                 "sizeSkipped": len(booked["nautilus"].skipped)}))
    primary_opt = options.get((PRIMARY_STRATEGY, PRIMARY))
    opt_points = primary_opt["points"] if primary_opt else []
    opt_summary = m.summary(opt_points)

    checks = checks_of(primary_summary, dsr, mc, neighbour_share, len(GHLZ_SENSITIVITY), stress_stats, wf_stats,
                       base_on_wf, opt_summary)
    verdict, reason = verdict_of(primary_summary, dsr, checks, opt_summary, len(primary_trades))

    bh_primary = m.window(bh[PRIMARY], primary)
    equity_series = {
        "GHLZ US500 (underlying, net of costs)": m.rebase(primary),
        "GHLZ US500 signals as SPY debit verticals (options form)": m.rebase(opt_points),
        "Buy and hold US500 CFD": m.rebase(bh_primary),
    }
    if opt_points:
        equity_series["Buy and hold SPY (options window)"] = m.rebase(m.window(bh.get("SPY", []), opt_points))
    comparison = _comparison(results, keys, curves, bh, options, repo)
    ld_rows = ld34_rows()
    commit = subprocess.run(["git", "-C", str(repo), "rev-parse", "HEAD"], check=False, capture_output=True,
                            text=True).stdout.strip()
    dhash = data_hash(keys, root)
    engine = next(iter(results.runs.values()))["engine"] if results.runs else ENGINE_ID
    provenance = {"commit": commit[:40] or "0000000", "engine": engine, "dataHash": dhash[:80],
                  "runId": f"imom-{ran}"}

    detail = {
        "verdict": verdict,
        "verdictReason": reason,
        "gates": [{"name": c["check"], "value": c["value"], "threshold": c["threshold"], "pass": c["pass"],
                   "result": c["result"]} for c in checks],
        "primary": {
            "market": PRIMARY, "marketLabel": BY_KEY[PRIMARY].label, "strategy": "GHLZ",
            "is": _part(primary_summary["inSample"], part_trades(is_part[0][0], is_part[-1][0])),
            "oos": _part(primary_summary["outOfSample"], part_trades(oos_part[0][0], oos_part[-1][0])),
            "full": _part(primary_summary["full"], part_trades(primary[0][0], primary[-1][0])),
            "split": {"isFrom": is_part[0][0], "isTo": is_part[-1][0], "oosFrom": oos_part[0][0],
                      "oosTo": oos_part[-1][0]},
            "spreadBps": results.legs(PRIMARY, GHLZ)[0]["spreadBps"],
            "options": {"twin": "SPY", **({k: _part(v, {}) for k, v in opt_summary.items()}),
                        "trades": len(primary_opt["nautilus"].trades) if primary_opt else 0,
                        "ledgerNautilusMaxGap": primary_opt["maxGap"] if primary_opt else None,
                        "skipReasons": primary_opt["skipReasons"] if primary_opt else {}},
        },
        "equity": {label: [[d, v] for d, v in pts] for label, pts in equity_series.items()},
        "drawdown": {label: [[d, v] for d, v in m.drawdown_series(pts)] for label, pts in equity_series.items()},
        "runs": runs_detail,
        "walkForward": {"stats": wf_stats, "baseSameWindow": base_on_wf, "picks": picks,
                        "curve": [[d, v] for d, v in wf["curve"]],
                        "grid": [{"signalEnd": p.signal_to, "entry": p.entry,
                                  **m.summary(c)["full"]} for p, c in zip(WALK_FORWARD_GRID, wf_candidates)]},
        "sensitivity": sens_detail,
        "neighbourShare": neighbour_share,
        "costStress": {"primary": stress_stats, "strategiesOnPrimary": stress_all, "ghlzByMarket": stress_markets},
        "monteCarlo": {"p5Return": mc.get("finalP5"), "p50Return": mc.get("finalP50"),
                       "p5MaxDd": mc.get("maxDrawdownP5"), "p50MaxDd": mc.get("maxDrawdownP50"),
                       "lossShare": mc.get("lossShare"), "paths": mc.get("paths"), "trades": mc.get("trades"),
                       "seed": m.MC_SEED},
        "deflatedSharpe": {"prob": dsr["probability"], "trials": dsr["trials"], **dsr,
                           "configurations": [label for label, _ in configs.values()]},
        "comparison": [{"name": r["name"], "sharpe": r["sharpe"], "cagr": r["cagr"], "maxDd": r["maxDrawdown"],
                        "source": r.get("source", "this study"), "kind": r["kind"]} for r in comparison + ld_rows],
        "provenance": {**provenance, "dataHash": dhash},
        "spreads": {key: results.legs(key, GHLZ)[0]["spreadBps"] for key in keys},
        "missingMarkets": missing,
        "config": {"capital": CAPITAL, "isFraction": m.IS_FRACTION, "gate": GATE, "minTrades": MIN_TRADES},
    }
    if detail_path is not None:
        detail_path.parent.mkdir(parents=True, exist_ok=True)
        detail_path.write_text(json.dumps(finite(detail, log=lambda _: None), allow_nan=False))  # json-data-ignore: report artifact under ~/Documents, outside the repo; the app never reads it
    return document(ran, rows, opt_rows, sens_rows, checks, verdict, reason, primary, comparison, ld_rows,
                    provenance, detail, curves, keys)


def _part(s: dict, trades: dict) -> dict:
    return {"sharpe": s["sharpe"], "cagr": s["cagr"], "maxDd": s["maxDrawdown"], "years": s["years"],
            "days": s["days"], **trades}


def _comparison(results: Results, keys: Sequence[str], curves: Mapping, bh: Mapping, options: Mapping,
                repo: Path) -> list[dict]:
    rows = []
    for sid, name, _ in STRATEGIES:
        s = m.stats(curves[(sid, PRIMARY)])
        rows.append({"name": f"{name} on US500 (underlying)", "kind": "strategy", "sharpe": s["sharpe"],
                     "cagr": s["cagr"], "maxDrawdown": s["maxDrawdown"], "source": "this study"})
    if "SPY" in keys:
        s = m.stats(curves[("ghlz", "SPY")])
        rows.append({"name": "GHLZ on SPY (underlying)", "kind": "strategy", "sharpe": s["sharpe"], "cagr": s["cagr"],
                     "maxDrawdown": s["maxDrawdown"], "source": "this study"})
        z = m.stats(curves[("zab", "SPY")])
        rows.append({"name": "ZAB on SPY (underlying, the paper's market)", "kind": "strategy", "sharpe": z["sharpe"],
                     "cagr": z["cagr"], "maxDrawdown": z["maxDrawdown"], "source": "this study"})
    primary_opt = options.get(("ghlz", PRIMARY))
    if primary_opt:
        s = m.stats(primary_opt["points"])
        rows.append({"name": "GHLZ US500 signals as SPY debit verticals (2 % max loss)", "kind": "strategy",
                     "sharpe": s["sharpe"], "cagr": s["cagr"], "maxDrawdown": s["maxDrawdown"], "source": "this study"})
    for group, members in (("futures proxies", FUTURES_PROXIES), ("ETF twins", ETF_TWINS)):
        present = [k for k in members if k in keys]
        if not present:
            continue
        port = m.combine([curves[("ghlz", k)] for k in present])
        s = m.stats(port)
        rows.append({"name": f"GHLZ equal-weight, Core 7 {group}", "kind": "strategy", "sharpe": s["sharpe"],
                     "cagr": s["cagr"], "maxDrawdown": s["maxDrawdown"], "source": "this study"})
        bh_port = m.combine([m.window(bh[k], curves[("ghlz", k)]) for k in present])
        b = m.stats(bh_port)
        rows.append({"name": f"Buy and hold equal-weight, Core 7 {group} (same window)", "kind": "buy-and-hold",
                     "sharpe": b["sharpe"], "cagr": b["cagr"], "maxDrawdown": b["maxDrawdown"], "source": "this study"})
    b = m.stats(m.window(bh[PRIMARY], curves[("ghlz", PRIMARY)]))
    rows.append({"name": "Buy and hold US500 CFD (same window)", "kind": "buy-and-hold", "sharpe": b["sharpe"],
                 "cagr": b["cagr"], "maxDrawdown": b["maxDrawdown"], "source": "this study"})
    rows += library_rows(repo)
    return rows


def document(ran: str, rows: list, opt_rows: list, sens_rows: list, checks: list, verdict: str, reason: str,
             primary: list, comparison: list, ld_rows: list, provenance: dict, detail: dict, curves: Mapping,
             keys: Sequence[str]) -> dict:
    from .rules import GAPS, RULES

    eq = m.monthly(primary)
    if len(eq) > 400:
        eq = eq[-400:]
    comp = [{k: r[k] for k in ("name", "kind", "sharpe", "cagr", "maxDrawdown")} for r in comparison]
    comp = comp[:30 - len(ld_rows)] + [{k: r[k] for k in ("name", "kind", "sharpe", "cagr", "maxDrawdown")}
                                       for r in ld_rows]
    robustness = [{"check": c["check"], "result": c["result"][:300], "pass": c["pass"]} for c in checks]
    return {
        "kind": "strategy-backtest",
        "id": SLUG,
        "title": "Market intraday momentum: GHLZ, ZAB and the bias tracker (Instagram reel)",
        "ran": ran,
        "spec": SPEC_PATH,
        "source": {"url": REEL_URL, "label": "Instagram reel DffkN31PrN7, davidtrades_model, 2026-11-08"},
        "verdict": verdict,
        "verdictReason": reason[:1000].rstrip(),
        "rules": RULES,
        "gaps": GAPS,
        "forms": [
            {"key": "underlying", "label": "As stated (underlying, long and short legs, flat at 16:00)",
             "description": ("Dukascopy 5-minute bid/ask mid bars, New York session; GHLZ and ZAB as DSL definitions "
                             "(long + short legs, daily returns summed), BIAS as a research signal; Nautilus engine; "
                             "measured spread + 1 bp slippage per side, ETF commissions; market-on-close exit."),
             "runs": rows[:80]},
            {"key": "options", "label": "Vertex form (same-day debit verticals on the ETF twin, 2 % max loss)",
             "description": ("Each signal opens a call (long) or put (short) debit vertical on the ETF twin at the entry, "
                             "long 0.50 delta, short 1 sigma away, nearest Friday weekly with >= 1 trading day left, "
                             "closed at 16:00; Black-Scholes on the previous close's IV index; $0.65/contract + half "
                             "spread per leg; Nautilus with a ledger cross-check."),
             "runs": opt_rows[:80] or [_empty_option_row()]},
        ],
        "robustness": robustness,
        "sensitivity": sens_rows[:80],
        "comparison": comp,
        "equity": eq,
        "equityLabel": "GHLZ on the US500 CFD (ES proxy), long and short legs summed, net of costs",
        "provenance": provenance,
        "notes": notes(detail, curves, keys),
    }


def _empty_option_row() -> dict:
    return {"symbol": "-", "market": "no priced spreads", "from": "2000-01-01", "to": "2000-01-02", "trades": 0,
            "cagr": 0.0, "sharpe": 0.0, "maxDrawdown": 0.0, "profitFactor": None, "winRate": 0.0, "exposure": 0.0,
            "oosSharpe": None, "oosCagr": None, "buyHoldCagr": None, "buyHoldSharpe": None}


def notes(detail: dict, curves: Mapping, keys: Sequence[str]) -> str:
    p = detail["primary"]
    lines = [
        f"Primary GHLZ US500 {p['split']['isFrom']} to {p['split']['oosTo']}: IS Sharpe {p['is']['sharpe']:.2f}, "
        f"OOS Sharpe {p['oos']['sharpe']:.2f} (OOS from {p['split']['oosFrom']}), CAGR {p['full']['cagr']:.1%}, "
        f"max DD {p['full']['maxDd']:.1%}, {p['full']['trades']} trades.",
        f"Options form (SPY verticals on US500 signals): {p['options']['trades']} spreads, OOS Sharpe "
        f"{p['options']['outOfSample']['sharpe']:.2f}; ledger vs Nautilus max equity gap "
        f"{(p['options']['ledgerNautilusMaxGap'] or 0):.2f} USD.",
        "Legs: each strategy runs a long and a short DSL leg on 100,000 USD each; their daily returns are summed "
        "(the legs never hold together). Trades and Monte Carlo use both legs.",
        "BIAS factor definitions are our defaults (not shown in the reel); Session Delta uses 5-minute bar volume, "
        "not tick delta. Dukascopy volume is tick volume.",
        "Options are priced from a daily IV index with a fixed smile; no intraday option quotes exist here, so the "
        "options form is a model, not a replay. One spread per market and day (later ZAB re-entries ignored).",
        "The deflated Sharpe counts every distinct configuration tried on the primary market (all strategies, "
        "sensitivity rows and walk-forward grid points).",
        f"Markets: {', '.join(keys)}." + (f" Missing data: {', '.join(detail['missingMarkets'])}."
                                          if detail["missingMarkets"] else ""),
        "Full per-market tables, daily equity and drawdown: the detail JSON of the run (report artifact).",
    ]
    return "\n".join(lines)[:4000]


def finite(value, path: str = "$", log: Log = _log):
    """The document with every non-finite number replaced by 0.0 (each one reported)."""
    if isinstance(value, float) and not math.isfinite(value):
        log(f"warning: non-finite number at {path}, stored as 0")
        return 0.0
    if isinstance(value, dict):
        return {str(k): finite(v, f"{path}.{k}", log) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [finite(v, f"{path}[{i}]", log) for i, v in enumerate(value)]
    return value


def main_study(ran: str, workers: int, detail: str | None) -> int:
    date.fromisoformat(ran)
    root = os.environ.get("VERTEX_IMOM_DATA")
    doc = run_study(ran, root=root, workers=workers, detail_path=Path(detail) if detail else None)
    print(json.dumps(finite(doc), allow_nan=False))
    return 0


__all__ = ["GATE", "SLUG", "checks_of", "main_study", "plan_jobs", "run_study", "verdict_of"]
