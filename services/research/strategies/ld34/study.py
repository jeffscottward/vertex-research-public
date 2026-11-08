"""The LD34 reel study: both forms, out-of-sample split, walk-forward, sensitivity, cost stress,
Monte Carlo, deflated Sharpe and the comparisons, assembled as one `strategy-backtest` research
study document (research only; nothing creates an order).

Pre-registered rules: docs/specs/strategies/ld34-nested-donchian-breakout.md.
"""
from __future__ import annotations

import json
import os
import sys
from collections.abc import Callable, Mapping, Sequence
from concurrent.futures import ProcessPoolExecutor
from dataclasses import asdict
from datetime import date
from pathlib import Path

from .data import BY_KEY, CORE7, ETF_TWINS, INSTRUMENTS, REEL_SHEET, load_hourly
from .definition import BASE, SENSITIVITY, WALK_FORWARD_GRID, Params
from .metrics import (
    apply_charges,
    combine,
    daily_points,
    deflated_sharpe,
    financing_factors,
    monte_carlo,
    monthly,
    split,
    stats,
    trade_stats,
    walk_forward,
)
from .runner import CAPITAL, run_job

REEL_URL = "https://www.instagram.com/reel/DffCOSDBMoC/"
SLUG = "ld34-nested-donchian-breakout"
SPEC_PATH = f"docs/specs/strategies/{SLUG}.md"
REEL_RESULTS = ("USDJPY", "GBPJPY", "AUDJPY", "CHFJPY", "EURJPY", "XAUUSD")
IS_FRACTION = 0.6
# Gate thresholds (packages/api/src/autopilot-gate.ts defaults).
GATE = {"oosSharpeMin": 0.5, "deflatedSharpeMin": 0.95, "monteCarloDrawdownP5Min": -0.35,
        "neighbourShareMin": 0.75, "costStressMultiple": 2}
OPTIONS_BLOCK = {"structure": "callDebitVertical", "dte": {"target": 45, "min": 30}, "longDelta": 0.5,
                 "widthSigma": 1.0, "exitDte": 7, "maxLossPct": 2}

Log = Callable[[str], None]


def _log(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


def _fields(params: Params) -> dict:
    return asdict(params)


def _run_all(jobs: Sequence[tuple[str, Params, float]], root: str | None, workers: int, log: Log) -> list[dict]:
    payload = [(key, _fields(params), mult, root) for key, params, mult in jobs]
    results: list[dict] = []
    with ProcessPoolExecutor(max_workers=workers) as pool:
        for index, result in enumerate(pool.map(run_job, payload)):
            results.append(result)
            log(f"run {index + 1}/{len(payload)} {result['key']} trades={len(result['trades'])}")
    return results


def _net_points(run: Mapping, irx: Mapping[str, float]) -> list:
    charges = financing_factors(run["trades"], run["times"], run["equity"], irx)
    return apply_charges(run["points"], charges)


def _row(item_key: str, run: Mapping, points: list, bh: list) -> dict:
    full = stats(points)
    _, oos = split(points, IS_FRACTION)
    oos_stats = stats(oos)
    bh_full = stats(bh) if len(bh) > 2 else None
    ts = trade_stats(run["trades"])
    item = BY_KEY[item_key]
    return {
        "symbol": item_key, "market": item.label, "from": points[0][0], "to": points[-1][0],
        "trades": ts["trades"], "cagr": full["cagr"], "sharpe": full["sharpe"], "maxDrawdown": full["maxDrawdown"],
        "profitFactor": ts["profitFactor"], "winRate": ts["winRate"], "exposure": float(run["stats"]["exposure"]),
        "oosSharpe": oos_stats["sharpe"], "oosCagr": oos_stats["cagr"],
        "buyHoldCagr": bh_full["cagr"] if bh_full else None, "buyHoldSharpe": bh_full["sharpe"] if bh_full else None,
    }


def _trade_returns(run: Mapping) -> list[float]:
    out = []
    for trade in run["trades"]:
        entry = trade["entryIndex"]
        before = run["equity"][entry - 1] if entry > 0 else run["equity"][0]
        if before > 0:
            out.append(trade["pnl"] / before)
    return out


def _hold_days(run: Mapping) -> list[float]:
    return [(run["times"][t["exitIndex"]] - run["times"][t["entryIndex"]]) / 86_400_000 for t in run["trades"]]


def _summary(points: list) -> dict:
    full = stats(points)
    is_part, oos = split(points, IS_FRACTION)
    return {"full": full, "inSample": stats(is_part), "outOfSample": stats(oos)}


def _options_form(base_runs: Mapping[str, dict], log: Log) -> dict:
    """Call debit verticals on the Core 7 ETF twins, opened on the close of the signal day and closed on
    the close of the underlying exit day (one day later when both fall on the same day), sized so the
    max loss is 2 % of equity. Black-Scholes with IV-index proxies (qc_ports.options); Nautilus books it."""
    from strategies.qc_ports.book import SignalEvent, build_book
    from strategies.qc_ports.data import load_market
    from strategies.qc_ports.ledger import run_ledger
    from strategies.qc_ports.nautilus_runner import run_nautilus

    markets, events_by_symbol = {}, {}
    for key in CORE7:
        twin = BY_KEY[key].twin
        run = base_runs.get(key)
        if twin is None or run is None:
            continue
        market = load_market(twin)
        index = {day: i for i, day in enumerate(market.dates)}
        days = list(market.dates)
        events = []
        for trade in run["trades"]:
            entry_day = _session(run["times"][trade["entryIndex"]])
            exit_day = _session(run["times"][trade["exitIndex"]])
            e = _index_on_or_after(days, entry_day)
            x = _index_on_or_after(days, exit_day)
            if e is None or e == 0:
                continue
            entry_signal = e - 1
            exit_signal = max((x if x is not None else len(days) - 1) - 1, entry_signal + 1)
            if exit_signal >= len(days) - 1:
                exit_signal = None
            if events and events[-1].exit_index is not None and entry_signal <= events[-1].exit_index:
                continue  # one spread at a time per symbol
            events.append(SignalEvent(twin, entry_signal, exit_signal))
        markets[twin] = market
        events_by_symbol[twin] = events
        del index
    per_symbol = {}
    for twin, events in events_by_symbol.items():
        book = build_book(events, OPTIONS_BLOCK, {twin: markets[twin]})
        ledger = run_ledger(book.trades, CAPITAL)
        naut = run_nautilus(book.trades, CAPITAL)
        per_symbol[twin] = {"ledger": ledger, "nautilus": naut, "book": book}
        log(f"options {twin}: {len(book.trades)} spreads, {len(book.skipped)} skipped")
    all_events = [ev for evs in events_by_symbol.values() for ev in evs]
    all_events.sort(key=lambda ev: markets[ev.symbol].dates[ev.entry_index])
    book = build_book(all_events, OPTIONS_BLOCK, markets)
    combined = {"ledger": run_ledger(book.trades, CAPITAL), "nautilus": run_nautilus(book.trades, CAPITAL),
                "book": book}
    return {"perSymbol": per_symbol, "combined": combined}


def _session(t_ms: float) -> str:
    from .metrics import session_day
    return session_day(t_ms)


def _index_on_or_after(days: Sequence[str], day: str) -> int | None:
    lo, hi = 0, len(days)
    while lo < hi:
        mid = (lo + hi) // 2
        if days[mid] < day:
            lo = mid + 1
        else:
            hi = mid
    return lo if lo < len(days) else None


def _ledger_points(result) -> list:
    return list(zip(result.dates, result.equity))


def _library_rows(repo: Path) -> list[dict]:
    path = repo / "research" / "backtests" / "core7" / "rerun-results.json"
    data = json.loads(path.read_text())
    rows = []
    for universe in data["buyAndHold"]:
        s = universe["combined"]["summary"]
        rows.append({"name": f"Buy and hold, {universe['label']} ({s['start']} to {s['end']})", "kind": "buy-and-hold",
                     "sharpe": s["sharpe"], "cagr": s["cagr"], "maxDrawdown": s["maxDrawdown"]})
    for strategy in data["strategies"]:
        for universe in strategy.get("universes", []):
            if universe.get("id") != "core7-etf-twins":
                continue
            s = universe["combined"]["summary"]
            rows.append({"name": f"{strategy['name']} (library, Core 7 ETF twins, daily)", "kind": "library",
                         "sharpe": s["sharpe"], "cagr": s["cagr"], "maxDrawdown": s["maxDrawdown"]})
    return rows


def run_study(ran: str, *, root: str | None = None, workers: int = 8, repo: Path | None = None,
              out_dir: Path | None = None, log: Log = _log) -> dict:
    from strategies.qc_ports.data import load_series

    repo = repo or Path(__file__).resolve().parents[4]
    irx = load_series("IRX")
    keys = [item.key for item in INSTRUMENTS]
    jobs: list[tuple[str, Params, float]] = [(key, BASE, 1.0) for key in keys]
    stress_keys = list(dict.fromkeys(REEL_SHEET + CORE7))
    jobs += [(key, BASE, float(GATE["costStressMultiple"])) for key in stress_keys]
    jobs += [(key, params, 1.0) for _, _, params in SENSITIVITY for key in REEL_SHEET]
    wf_extra = [p for p in WALK_FORWARD_GRID if p != BASE]
    jobs += [(key, params, 1.0) for params in wf_extra for key in REEL_SHEET]
    log(f"{len(jobs)} Nautilus runs on {workers} workers")
    results = _run_all(jobs, root, workers, log)

    def find(key: str, params: Params, mult: float = 1.0) -> dict:
        target = dict(_fields(params))
        target.pop("max_leverage")
        target["lookbacks"] = tuple(target["lookbacks"])
        for r in results:
            r_params = dict(r["params"])
            r_params.pop("max_leverage")
            r_params["lookbacks"] = tuple(r_params["lookbacks"])
            if r["key"] == key and r["costMultiple"] == mult and r_params == target:
                return r
        raise KeyError((key, params, mult))

    base_runs = {key: find(key, BASE) for key in keys}
    net = {key: _net_points(run, irx) for key, run in base_runs.items()}
    bh = {}
    for key in keys:
        data = load_hourly(key, root)
        bh[key] = daily_points(data.t, data.c)
    rows = [_row(key, base_runs[key], net[key], window(bh[key], net[key])) for key in keys]

    groups = {
        "Reel sheet (SPX500, NAS100, BTCUSD)": list(REEL_SHEET),
        "Reel results (JPY crosses, gold)": list(REEL_RESULTS),
        "Core 7 (CFD proxies of the futures)": list(CORE7),
        "Core 7 ETF twins": list(ETF_TWINS),
    }
    portfolios = {name: combine([net[k] for k in members]) for name, members in groups.items()}
    bh_portfolios = {name: combine([window(bh[k], net[k]) for k in members]) for name, members in groups.items()}
    primary_name = "Reel sheet (SPX500, NAS100, BTCUSD)"
    primary = portfolios[primary_name]

    # Sensitivity and walk-forward on the reel-sheet portfolio.
    sens_rows, trial_sharpes = [], [stats(primary)["sharpePerDay"]]
    positive = 0
    for param, value, params in SENSITIVITY:
        port = combine([_net_points(find(k, params), irx) for k in REEL_SHEET])
        s = stats(port)
        trades = sum(len(find(k, params)["trades"]) for k in REEL_SHEET)
        sens_rows.append({"param": param, "value": value, "sharpe": s["sharpe"], "cagr": s["cagr"],
                          "maxDrawdown": s["maxDrawdown"], "trades": trades})
        trial_sharpes.append(s["sharpePerDay"])
        positive += s["sharpe"] > 0
    neighbour_share = positive / len(SENSITIVITY)
    wf_candidates = []
    for params in WALK_FORWARD_GRID:
        port = combine([_net_points(find(k, params), irx) for k in REEL_SHEET])
        wf_candidates.append(port)
        if params != BASE:
            trial_sharpes.append(stats(port)["sharpePerDay"])
    wf = walk_forward(wf_candidates)
    wf_stats = stats(wf["curve"]) if len(wf["curve"]) > 2 else stats(primary)
    base_on_wf = stats([p for p in primary if p[0] >= wf["curve"][0][0]]) if wf["curve"] else stats(primary)

    stress = combine([_net_points(find(k, BASE, float(GATE["costStressMultiple"])), irx) for k in REEL_SHEET])
    stress_stats = stats(stress)
    # Each sleeve holds 1/len of the portfolio, so a trade moves portfolio equity by its sleeve return / len.
    trade_rets = [r / len(REEL_SHEET) for k in REEL_SHEET for r in _trade_returns(base_runs[k])]
    mc = monte_carlo(trade_rets)
    n_trials = 1 + len(SENSITIVITY) + len(wf_extra)
    dsr = deflated_sharpe(primary, n_trials, trial_sharpes)
    primary_summary = _summary(primary)

    log("options form")
    options = _options_form(base_runs, log)
    opt_rows = []
    for twin, res in options["perSymbol"].items():
        points = _ledger_points(res["nautilus"])
        if len(points) < 3:
            continue
        full = stats(points)
        _, oos = split(points, IS_FRACTION)
        trades = res["nautilus"].trades
        pnl = [t.get("pnl", 0.0) for t in trades]
        wins = [p for p in pnl if p > 0]
        losses = [-p for p in pnl if p <= 0]
        from strategies.qc_ports.data import load_market
        market = load_market(twin)
        twin_bh = [(d, c) for d, c in zip(market.dates, market.close) if points[0][0] <= d <= points[-1][0]]
        bh_s = stats(twin_bh) if len(twin_bh) > 2 else None
        opt_rows.append({
            "symbol": twin, "market": f"{twin} call debit vertical (signals: {_cfd_of(twin)})",
            "from": points[0][0], "to": points[-1][0], "trades": len(trades),
            "cagr": full["cagr"], "sharpe": full["sharpe"], "maxDrawdown": full["maxDrawdown"],
            "profitFactor": sum(wins) / sum(losses) if losses and sum(losses) > 0 else None,
            "winRate": len(wins) / len(pnl) if pnl else 0.0,
            "exposure": _exposure(res["nautilus"]),
            "oosSharpe": stats(oos)["sharpe"], "oosCagr": stats(oos)["cagr"],
            "buyHoldCagr": bh_s["cagr"] if bh_s else None, "buyHoldSharpe": bh_s["sharpe"] if bh_s else None,
        })
    opt_points = _ledger_points(options["combined"]["nautilus"])
    opt_summary = _summary(opt_points)
    ledger_gap = max((abs(a - b) for a, b in zip(options["combined"]["ledger"].equity,
                                                 options["combined"]["nautilus"].equity)), default=0.0)

    checks = _checks(primary_summary, dsr, mc, neighbour_share, stress_stats, wf_stats, base_on_wf, opt_summary)
    verdict, reason = _verdict(primary_summary, dsr, checks, opt_summary,
                               sum(len(base_runs[k]["trades"]) for k in REEL_SHEET))
    holds = sorted(d for k in REEL_SHEET for d in _hold_days(base_runs[k]))
    detail = {
        "rows": rows, "optionRows": opt_rows, "portfolios": {n: _summary(p) for n, p in portfolios.items()},
        "bhPortfolios": {n: _summary(p) for n, p in bh_portfolios.items()},
        "walkForward": {"stats": wf_stats, "baseSameWindow": base_on_wf, "picks": wf["picks"]},
        "costStress": stress_stats, "monteCarlo": mc, "deflatedSharpe": dsr, "neighbourShare": neighbour_share,
        "sensitivity": sens_rows, "options": {"summary": opt_summary, "ledgerNautilusMaxGap": ledger_gap,
                                              "trades": len(options["combined"]["nautilus"].trades),
                                              "skipped": len(options["combined"]["book"].skipped)},
        "medianHoldDays": holds[len(holds) // 2] if holds else None, "spreads": {k: base_runs[k]["spreadBps"] for k in keys},
        "checks": checks, "verdict": verdict, "verdictReason": reason,
    }
    if out_dir is not None:
        _write_artifacts(out_dir, detail, portfolios, bh_portfolios, opt_points, net, wf["curve"])
    document = _document(ran, rows, opt_rows, detail, primary, sens_rows, repo, results, verdict, reason, checks,
                         bh_portfolios, portfolios, opt_summary)
    return document


def window(bh: list, points: list) -> list:
    return [p for p in bh if points[0][0] <= p[0] <= points[-1][0]]


def _cfd_of(twin: str) -> str:
    for key in CORE7:
        if BY_KEY[key].twin == twin:
            return key
    return "?"


def _exposure(result) -> float:
    if not result.open_positions:
        return 0.0
    return sum(1 for n in result.open_positions if n > 0) / len(result.open_positions)


def _checks(primary: dict, dsr: dict, mc: dict, neighbour_share: float, stress: dict, wf: dict, base_wf: dict,
            options: dict) -> list[dict]:
    oos = primary["outOfSample"]
    return [
        {"check": "Out-of-sample Sharpe (last 40 %)", "value": oos["sharpe"], "threshold": GATE["oosSharpeMin"],
         "pass": oos["sharpe"] >= GATE["oosSharpeMin"],
         "result": f"OOS Sharpe {oos['sharpe']:.2f} (IS {primary['inSample']['sharpe']:.2f}); OOS CAGR {oos['cagr']:.1%}"},
        {"check": "Deflated Sharpe probability", "value": dsr["probability"], "threshold": GATE["deflatedSharpeMin"],
         "pass": dsr["probability"] >= GATE["deflatedSharpeMin"],
         "result": f"{dsr['probability']:.3f} over {dsr['trials']} configurations"},
        {"check": "Monte Carlo drawdown P5", "value": mc.get("maxDrawdownP5"), "threshold": GATE["monteCarloDrawdownP5Min"],
         "pass": mc.get("maxDrawdownP5", -1) >= GATE["monteCarloDrawdownP5Min"],
         "result": f"P5 max drawdown {mc.get('maxDrawdownP5', 0):.1%} over {mc.get('paths', 0)} trade bootstraps; "
                   f"loss share {mc.get('lossShare', 0):.0%}"},
        {"check": "Parameter neighbours with Sharpe > 0", "value": neighbour_share, "threshold": GATE["neighbourShareMin"],
         "pass": neighbour_share >= GATE["neighbourShareMin"], "result": f"{neighbour_share:.0%} of {len(SENSITIVITY)} one-at-a-time changes"},
        {"check": "2x costs", "value": stress["sharpe"], "threshold": 0, "pass": stress["sharpe"] > 0,
         "result": f"Sharpe {stress['sharpe']:.2f}, CAGR {stress['cagr']:.1%} with doubled spread and slippage"},
        {"check": "Walk-forward (3 y train, 1 y test)", "value": wf["sharpe"], "threshold": None, "pass": None,
         "result": f"stitched Sharpe {wf['sharpe']:.2f} vs stated rules {base_wf['sharpe']:.2f} on the same years"},
        {"check": "Options form OOS Sharpe", "value": options["outOfSample"]["sharpe"], "threshold": 0,
         "pass": options["outOfSample"]["sharpe"] > 0,
         "result": f"OOS Sharpe {options['outOfSample']['sharpe']:.2f}, full {options['full']['sharpe']:.2f}"},
    ]


def _verdict(primary: dict, dsr: dict, checks: list[dict], options: dict, trades: int) -> tuple[str, str]:
    gates = [c for c in checks[:5]]
    passed = sum(1 for c in gates if c["pass"])
    oos = primary["outOfSample"]["sharpe"]
    if all(c["pass"] for c in gates) and options["outOfSample"]["sharpe"] > 0:
        return "edge", f"All 5 gates pass on the reel-sheet portfolio and the options form is positive out of sample ({passed}/5)."
    if oos <= 0 or dsr["probability"] < 0.5:
        return "no-edge", (f"Out-of-sample Sharpe {oos:.2f} and deflated Sharpe probability {dsr['probability']:.2f}: "
                           f"{passed}/5 gates pass.")
    if trades < 100:
        return "needs-more-data", f"Only {trades} trades on the reel-sheet markets; {passed}/5 gates pass."
    return "no-edge" if passed <= 2 else "needs-more-data", f"{passed}/5 gates pass; OOS Sharpe {oos:.2f}."


def _document(ran, rows, opt_rows, detail, primary, sens_rows, repo, results, verdict, reason, checks,
              bh_portfolios, portfolios, opt_summary) -> dict:
    import hashlib
    import subprocess

    commit = subprocess.run(["git", "-C", str(repo), "rev-parse", "HEAD"], check=False, capture_output=True, text=True).stdout.strip()
    digest = hashlib.sha256()
    for r in results:
        if r["costMultiple"] == 1.0:
            digest.update(f"{r['key']}:{len(r['times'])}:{r['times'][0]}:{r['times'][-1]}".encode())
    eq = monthly(primary)
    if len(eq) > 400:
        eq = eq[-400:]
    comparison = [{"name": f"LD34 {name}", "kind": "strategy", "sharpe": s["full"]["sharpe"], "cagr": s["full"]["cagr"],
                   "maxDrawdown": s["full"]["maxDrawdown"]} for name, s in detail["portfolios"].items()]
    comparison += [{"name": f"Buy and hold, {name}", "kind": "buy-and-hold", "sharpe": s["full"]["sharpe"],
                    "cagr": s["full"]["cagr"], "maxDrawdown": s["full"]["maxDrawdown"]}
                   for name, s in detail["bhPortfolios"].items()]
    comparison.append({"name": "LD34 options form (Core 7 ETF twins, 2 % max loss)", "kind": "strategy",
                       "sharpe": opt_summary["full"]["sharpe"], "cagr": opt_summary["full"]["cagr"],
                       "maxDrawdown": opt_summary["full"]["maxDrawdown"]})
    comparison += _library_rows(repo)
    robustness = [{"check": c["check"], "result": c["result"], "pass": c["pass"]} for c in checks]
    from .rules import GAPS, RULES
    return {
        "kind": "strategy-backtest",
        "title": "LD34 nested Donchian long-only breakout (Instagram reel)",
        "ran": ran,
        "spec": SPEC_PATH,
        "source": {"url": REEL_URL, "label": "Instagram reel DffCOSDBMoC, hooper.algo.fxx, 2026-11-08"},
        "verdict": verdict,
        "verdictReason": reason,
        "rules": RULES,
        "gaps": GAPS,
        "forms": [
            {"key": "underlying", "label": "As stated (underlying, 1 % risk)",
             "description": ("Hourly Dukascopy bid/ask mid bars; the stated rules in the DSL; Nautilus engine; "
                             "measured spread + slippage, ETF commissions, margin financing on the borrowed part."),
             "runs": rows[:40]},
            {"key": "options", "label": "Vertex form (call debit verticals, 2 % max loss)",
             "description": ("Core 7 CFD signals expressed as 45-DTE call debit verticals (long 0.50 delta, 1 sigma wide) "
                             "on the ETF twin, opened on the signal day's close, closed on the underlying exit day "
                             "or at 7 DTE; Black-Scholes with IV-index proxies; $0.65/contract + half spread; Nautilus."),
             "runs": opt_rows or [_empty_option_row()]},
        ],
        "robustness": robustness,
        "sensitivity": sens_rows,
        "comparison": comparison[:30],
        "equity": eq,
        "equityLabel": "Reel-sheet portfolio (SPX500, NAS100, BTCUSD; equal capital, daily rebalanced), net of costs and financing",
        "provenance": {"commit": commit[:40] or "0000000", "engine": results[0]["engine"],
                       "dataHash": digest.hexdigest()[:16], "runId": f"ld34-{ran}"},
        "notes": _notes(detail),
    }


def _empty_option_row() -> dict:
    return {"symbol": "-", "market": "no priced spreads", "from": "2000-01-01", "to": "2000-01-02", "trades": 0,
            "cagr": 0.0, "sharpe": 0.0, "maxDrawdown": 0.0, "profitFactor": None, "winRate": 0.0, "exposure": 0.0,
            "oosSharpe": None, "oosCagr": None, "buyHoldCagr": None, "buyHoldSharpe": None}


def _notes(detail: dict) -> str:
    p = detail["portfolios"]
    lines = [f"{name}: Sharpe {s['full']['sharpe']:.2f}, CAGR {s['full']['cagr']:.1%}, max DD {s['full']['maxDrawdown']:.1%}, "
             f"OOS Sharpe {s['outOfSample']['sharpe']:.2f}." for name, s in p.items()]
    lines.append(f"Median holding time on the reel-sheet markets: {detail['medianHoldDays']:.1f} days." if detail["medianHoldDays"] else "")
    lines.append(f"Options form: {detail['options']['trades']} spreads, {detail['options']['skipped']} signals skipped; "
                 f"ledger vs Nautilus max equity gap {detail['options']['ledgerNautilusMaxGap']:.2f} USD.")
    lines.append("BTCUSD has no options form (no listed BTC ETF options history long enough); FX crosses are replication only.")
    return "\n".join(line for line in lines if line)[:4000]


def _write_artifacts(out_dir: Path, detail: dict, portfolios: dict, bh_portfolios: dict, opt_points: list,
                     net: dict, wf_curve: list) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    payload = {"detail": detail, "portfolios": portfolios, "bhPortfolios": bh_portfolios, "options": opt_points,
               "markets": net, "walkForward": wf_curve}
    (out_dir / "ld34-study-detail.json").write_text(json.dumps(payload, default=str))


def main_study(ran: str, workers: int, out_dir: str | None) -> int:
    date.fromisoformat(ran)
    root = os.environ.get("VERTEX_LD34_DATA")
    doc = run_study(ran, root=root, workers=workers, out_dir=Path(out_dir) if out_dir else None)
    print(json.dumps({"id": SLUG, "summary": doc}, allow_nan=False))
    return 0


__all__ = ["OPTIONS_BLOCK", "SLUG", "main_study", "run_study"]
