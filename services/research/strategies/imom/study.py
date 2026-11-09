"""The market intraday momentum reel study: GHLZ, ZAB and BIAS on the Core 7 futures proxies and ETF twins,
both forms (underlying and same-day debit verticals), 60/40 out-of-sample split, walk-forward, sensitivity,
cost stress, Monte Carlo, deflated Sharpe and the comparisons, assembled as one `strategy-backtest` research
study document plus a detail JSON for the report (research only; nothing creates an order).

Data source `dukascopy` (default): Dukascopy 1-minute bid/ask, primary GHLZ on the US500 CFD. Data source `ibkr`:
IBKR 5-minute bars of the Core 7 ETF twins, primary GHLZ on SPY, options on the same SPY bars (spec section
'IBKR rerun'); same study id, gates and verdict rule; run id `imom-ibkr-<date>`.

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
from .data import (
    DEFAULT_SOURCE,
    ETF_TWINS,
    FUTURES_PROXIES,
    IBKR,
    IBKR_DATA_ENV,
    PRIMARY,
    SPREAD_MEASURED,
    available,
    check_source,
    daily_closes,
    data_hash,
    ibkr_spread,
    instrument,
    instruments,
    load_bars,
    primary_of,
)
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
CORE7_RERUN = "research/backtests/core7/rerun-results.json"  # json-data-ignore: committed research artifact (comparison source label)
STRATEGY_NAMES = {sid: name for sid, name, _ in STRATEGIES}
# Source-dependent wording of the document (the Dukascopy text is the original study's).
TEXT = {
    DEFAULT_SOURCE: {
        "primaryName": "US500 CFD",
        "equityLabel": "GHLZ on the US500 CFD (ES proxy), long and short legs summed, net of costs",
        "underlying": ("Dukascopy 5-minute bid/ask mid bars, New York session; GHLZ and ZAB as DSL definitions "
                       "(long + short legs, daily returns summed), BIAS as a research signal; Nautilus engine; "
                       "measured spread + 1 bp slippage per side, ETF commissions; market-on-close exit."),
        "volume": "Dukascopy volume is tick volume.",
    },
    IBKR: {
        "primaryName": "SPY",
        "equityLabel": "GHLZ on SPY (IBKR 5-minute bars), long and short legs summed, net of costs",
        "underlying": ("IBKR 5-minute TRADES bars (regular hours), New York session; GHLZ and ZAB as DSL definitions "
                       "(long + short legs, daily returns summed), BIAS as a research signal; Nautilus engine; "
                       "half the in-sample IBKR quoted spread + 0.25 bp slippage per side, IBKR Pro Fixed "
                       "commissions; market-on-close exit."),
        "volume": "IBKR volume is traded volume of the 5-minute bars.",
    },
}

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


def plan_jobs(keys: Sequence[str], primary: str = PRIMARY) -> tuple[list[tuple[str, Params, str, float]], dict]:
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
        runs.append((primary, params, stress))
    runs += [(key, GHLZ, stress) for key in keys if key != primary]
    for sid, name, params in STRATEGIES:
        add_config(name, params)
    for group, rows in (("GHLZ", GHLZ_SENSITIVITY), ("ZAB", ZAB_SENSITIVITY), ("BIAS", BIAS_SENSITIVITY)):
        for param, value, params in rows:
            runs.append((primary, params, 1.0))
            add_config(f"{group} {param} {value}", params)
    for params in WALK_FORWARD_GRID:
        runs.append((primary, params, 1.0))
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


def _run_all(jobs: Sequence[tuple[str, Params, str, float]], root: str | None, workers: int, log: Log,
             primary: str = PRIMARY, source: str = DEFAULT_SOURCE) -> dict:
    payload = [(key, params_to_json(params), side, mult, root, source) for key, params, side, mult in jobs]
    out: dict[tuple, dict] = {}
    # The longest markets first so the pool stays busy.
    order = sorted(range(len(jobs)), key=lambda i: (jobs[i][0] != primary, jobs[i][0]))
    with ProcessPoolExecutor(max_workers=workers) as pool:
        futures = {i: pool.submit(run_job, payload[i]) for i in order}
        for done, i in enumerate(order, start=1):
            result = futures[i].result()
            key, params, side, mult = jobs[i]
            out[leg_id(key, params, side, mult)] = result
            log(f"run {done}/{len(jobs)} {key} {params.family} {side} x{mult:g} trades={len(result['trades'])}")
    return out


def _warm_cache(keys: Sequence[str], root: str | None, workers: int, log: Log,
                source: str = DEFAULT_SOURCE) -> None:
    with ProcessPoolExecutor(max_workers=min(workers, len(keys))) as pool:
        for key, n in zip(keys, pool.map(_bar_count, [(k, root, source) for k in keys])):
            log(f"data {key}: {n} five-minute bars")


def _bar_count(job: tuple) -> int:
    key, root, *rest = job
    return len(load_bars(key, root, source=rest[0] if rest else DEFAULT_SOURCE))


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


def underlying_row(results: Results, key: str, sid: str, params: Params, bh: Sequence,
                   source: str = DEFAULT_SOURCE) -> dict:
    points = results.points(key, params)
    s = m.summary(points)
    trades = results.trades(key, params)
    ts = m.trade_stats(trades)
    bh_w = m.window(bh, points)
    bh_s = m.stats(bh_w) if len(bh_w) > 2 else None
    item = instrument(key, source)
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


def _option_job(job: tuple) -> tuple[str, str, dict | None, list]:
    """Worker entry (picklable): (strategy id, signal market, twin, [(side, entry ms)], data root[, data source])."""
    from strategies.qc_ports.data import load_market

    from .options import EtfClock, OptionEvent, book, price_events, spread_returns

    sid, key, twin, entries, root, *rest = job
    etf = EtfClock(load_bars(twin, root, source=rest[0] if rest else DEFAULT_SOURCE))
    events = [OptionEvent(key, twin, side, entry_ms) for side, entry_ms in entries]
    spreads, skipped = price_events(events, {twin: etf}, {twin: load_market(twin)})
    if not spreads:
        return sid, key, None, skipped
    first = spreads[0].day
    closes = [t for day, (t, _) in etf.close_of_day.items() if day >= first]
    booked = book(spreads, closes, CAPITAL)
    reasons: dict[str, int] = {}
    for s in skipped:
        reasons[s["reason"]] = reasons.get(s["reason"], 0) + 1
    booked.pop("clock")
    booked["spreads"] = len(spreads)
    booked["skipped"] = skipped
    booked["skipReasons"] = reasons
    booked["returns"] = spread_returns(booked["nautilus"], CAPITAL)
    return sid, key, booked, skipped


def options_form(results: Results, keys: Sequence[str], root: str | None, log: Log, workers: int = 8,
                 source: str = DEFAULT_SOURCE) -> dict:
    """Same-day debit verticals on the ETF twin of every signal market, per strategy (one book per pair)."""
    jobs = []
    for sid, _, params in STRATEGIES:
        for key in keys:
            twin = instrument(key, source).twin
            if not available(twin, root, source):
                continue
            entries = [(t["side"], t["entryMs"]) for t in results.trades(key, params)]
            jobs.append((sid, key, twin, entries, root, source))
    out: dict[tuple[str, str], dict] = {}
    with ProcessPoolExecutor(max_workers=max(1, min(workers, len(jobs)))) as pool:
        for sid, key, booked, skipped in pool.map(_option_job, jobs):
            twin = instrument(key, source).twin
            if booked is None:
                log(f"options {sid} {key}->{twin}: no priced spreads ({len(skipped)} skipped)")
                continue
            out[(sid, key)] = booked
            log(f"options {sid} {key}->{twin}: {len(booked['nautilus'].trades)} spreads, {len(skipped)} skipped, "
                f"ledger gap {booked['maxGap']:.4f}")
    return out


def option_row(sid: str, key: str, booked: dict, bh: Sequence, source: str = DEFAULT_SOURCE) -> dict:
    points = booked["points"]
    s = m.summary(points)
    trades = booked["nautilus"].trades
    pnl = [t.get("pnl", 0.0) for t in trades]
    wins = [p for p in pnl if p > 0]
    losses = [-p for p in pnl if p <= 0]
    twin = instrument(key, source).twin
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


def verdict_of(primary: dict, dsr: dict, checks: list[dict], options: dict, trades: int,
               market: str = PRIMARY) -> tuple[str, str]:
    """The pre-registered rule (spec 'Pass/fail rule'); the reason names the failed gates and the options form."""
    gates = checks[:5]
    passed = sum(1 for c in gates if c["pass"])
    failed = "; ".join(f"{c['check']}: {c['result']}" for c in gates if not c["pass"]) or "none"
    oos = primary["outOfSample"]["sharpe"]
    opt = options["outOfSample"]["sharpe"]
    tail = (f"{passed}/5 gates pass on GHLZ {market} (OOS Sharpe {oos:.2f}, deflated Sharpe probability "
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
    path = repo / CORE7_RERUN
    data = json.loads(path.read_text())
    rows = []
    for universe in data["buyAndHold"]:
        s = universe["combined"]["summary"]
        rows.append({"name": f"Buy and hold, {universe['label']} ({s['start']} to {s['end']})"[:80],
                     "kind": "buy-and-hold", "sharpe": s["sharpe"], "cagr": s["cagr"], "maxDrawdown": s["maxDrawdown"],
                     "source": CORE7_RERUN})
    for strategy in data["strategies"]:
        for universe in strategy.get("universes", []):
            if universe.get("id") != "core7-etf-twins":
                continue
            s = universe["combined"]["summary"]
            window = f"{s.get('start', '?')[:4]}-{s.get('end', '?')[:4]}"
            rows.append({"name": f"{strategy['name']} (library, ETF twins, daily, {window})"[:80], "kind": "library",
                         "sharpe": s["sharpe"], "cagr": s["cagr"], "maxDrawdown": s["maxDrawdown"],
                         "source": CORE7_RERUN})
    return rows


# ------------------------------------------------------------------------------------------------
# Study


def run_study(ran: str, *, root: str | None = None, workers: int = 8, repo: Path | None = None,
              detail_path: Path | None = None, log: Log = _log, source: str = DEFAULT_SOURCE,
              extra_comparison: Sequence[dict] = ()) -> dict:
    repo = repo or Path(__file__).resolve().parents[4]
    check_source(source)
    pk = primary_of(source)
    markets = instruments(source)
    keys = [item.key for item in markets if available(item.key, root, source)]
    missing = [item.key for item in markets if item.key not in keys]
    if pk not in keys:
        raise FileNotFoundError(f"No data for the primary market {pk}")
    if missing:
        log(f"warning: no data for {', '.join(missing)}; they are left out")
    _warm_cache(keys, root, workers, log, source)
    jobs, configs = plan_jobs(keys, pk)
    log(f"{len(jobs)} Nautilus leg runs on {workers} workers")
    results = Results(_run_all(jobs, root, workers, log, pk, source))

    bh = {key: daily_closes(load_bars(key, root, source=source)) for key in keys}
    rows, runs_detail, curves = [], [], {}
    for sid, _, params in STRATEGIES:
        for key in keys:
            rows.append(underlying_row(results, key, sid, params, bh[key], source))
            points = results.points(key, params)
            curves[(sid, key)] = points
            runs_detail.append(_run_entry("underlying", sid, key, points, len(results.trades(key, params)),
                                          {"label": instrument(key, source).label, "spreadBps": results.legs(key, params)[0]["spreadBps"],
                                           "legs": {leg["side"]: {"trades": len(leg["trades"]),
                                                                  **m.summary(leg["points"])["full"]}
                                                    for leg in results.legs(key, params)}}))

    # Primary: GHLZ on the US500 CFD (Dukascopy) or SPY (IBKR).
    primary = curves[(PRIMARY_STRATEGY, pk)]
    primary_summary = m.summary(primary)
    primary_trades = results.trades(pk, GHLZ)
    is_part, oos_part = m.split(primary, m.IS_FRACTION)

    def part_trades(first: str, last: str) -> dict:
        ts = m.trade_stats(m.trades_between(primary_trades, first, last))
        return {"trades": ts["trades"], "winRate": ts["winRate"], "profitFactor": ts["profitFactor"]}

    # Sensitivity (one at a time) on the primary market.
    sens_rows, sens_detail = [], []
    trial_sharpes: dict[str, float] = {}
    for cid, (label, params) in configs.items():
        trial_sharpes[cid] = m.stats(results.points(pk, params))["sharpePerDay"]
    positive = 0
    for group, rows_ in (("GHLZ", GHLZ_SENSITIVITY), ("ZAB", ZAB_SENSITIVITY), ("BIAS", BIAS_SENSITIVITY)):
        for param, value, params in rows_:
            points = results.points(pk, params)
            s = m.stats(points)
            n = len(results.trades(pk, params))
            sens_rows.append({"param": f"{group} {param}"[:60], "value": value[:40], "sharpe": s["sharpe"],
                              "cagr": s["cagr"], "maxDrawdown": s["maxDrawdown"], "trades": n})
            sens_detail.append({"strategy": group, "change": f"{param} = {value}", "sharpe": s["sharpe"],
                                "cagr": s["cagr"], "maxDd": s["maxDrawdown"], "trades": n,
                                "oosSharpe": m.summary(points)["outOfSample"]["sharpe"]})
            if group == "GHLZ":
                positive += s["sharpe"] > 0
    neighbour_share = positive / len(GHLZ_SENSITIVITY)

    # Walk-forward over GHLZ signal end x entry time.
    wf_candidates = [results.points(pk, params) for params in WALK_FORWARD_GRID]
    wf = m.walk_forward(wf_candidates, warmup_days=0)
    wf_stats = m.stats(wf["curve"]) if len(wf["curve"]) > 2 else m.stats(primary)
    base_on_wf = m.stats([p for p in primary if p[0] >= wf["curve"][0][0]]) if wf["curve"] else m.stats(primary)
    picks = [dict(p, signalEnd=WALK_FORWARD_GRID[p["pick"]].signal_to, entry=WALK_FORWARD_GRID[p["pick"]].entry)
             for p in wf["picks"]]

    stress_points = results.points(pk, GHLZ, GATE["costStressMultiple"])
    stress_stats = m.stats(stress_points)
    stress_all = {sid: m.stats(results.points(pk, params, GATE["costStressMultiple"]))
                  for sid, _, params in STRATEGIES}
    stress_markets = {key: m.stats(results.points(key, GHLZ, GATE["costStressMultiple"])) for key in keys}
    trade_rets = m.trade_returns(primary_trades)
    mc = m.monte_carlo(trade_rets, paths=m.MC_PATHS, seed=m.MC_SEED)
    dsr = m.deflated_sharpe(primary, len(configs), list(trial_sharpes.values()))

    log("options form")
    options = options_form(results, keys, root, log, workers, source)
    opt_rows = []
    for sid, _, _ in STRATEGIES:
        for key in keys:
            booked = options.get((sid, key))
            if booked is None or len(booked["points"]) < 3:
                continue
            twin = instrument(key, source).twin
            opt_rows.append(option_row(sid, key, booked, bh.get(twin, []), source))
            runs_detail.append(_run_entry(
                "options", sid, key, booked["points"], len(booked["nautilus"].trades),
                {"twin": twin, "skipped": len(booked["skipped"]), "skipReasons": booked["skipReasons"],
                 "ledgerNautilusMaxGap": booked["maxGap"],
                 "sizeSkipped": len(booked["nautilus"].skipped)}))
    primary_opt = options.get((PRIMARY_STRATEGY, pk))
    opt_points = primary_opt["points"] if primary_opt else []
    opt_summary = m.summary(opt_points)

    checks = checks_of(primary_summary, dsr, mc, neighbour_share, len(GHLZ_SENSITIVITY), stress_stats, wf_stats,
                       base_on_wf, opt_summary)
    verdict, reason = verdict_of(primary_summary, dsr, checks, opt_summary, len(primary_trades), pk)

    bh_primary = m.window(bh[pk], primary)
    equity_series = {
        f"GHLZ {pk} (underlying, net of costs)": m.rebase(primary),
        f"GHLZ {pk} signals as SPY debit verticals (options form)": m.rebase(opt_points),
        f"Buy and hold {TEXT[source]['primaryName']}": m.rebase(bh_primary),
    }
    if opt_points:
        equity_series["Buy and hold SPY (options window)"] = m.rebase(m.window(bh.get("SPY", []), opt_points))
    comparison = _comparison(results, keys, curves, bh, options, repo, pk, source)
    # Rows of the other data source's run (command line) follow this run's own strategy rows on the primary.
    comparison = comparison[:len(STRATEGIES)] + list(extra_comparison) + comparison[len(STRATEGIES):]
    ld_rows: list[dict] = []  # LD34 is compared in the report; this runner reads no other study files (AGENTS.md rule 13)
    commit = subprocess.run(["git", "-C", str(repo), "rev-parse", "HEAD"], check=False, capture_output=True,
                            text=True).stdout.strip()
    dhash = data_hash(keys, root, source)
    engine = next(iter(results.runs.values()))["engine"] if results.runs else ENGINE_ID
    provenance = {"commit": commit[:40] or "0000000", "engine": engine, "dataHash": dhash[:80],
                  "runId": f"imom-ibkr-{ran}" if source == IBKR else f"imom-{ran}"}
    spread_origins = {key: ibkr_spread(key, root)[1] for key in keys} if source == IBKR else {}
    fallbacks = [key for key, origin in spread_origins.items() if origin != SPREAD_MEASURED]
    if fallbacks:
        log(f"warning: no in-sample BID_ASK sample for {', '.join(fallbacks)}; they use the {pk} spread")

    detail = {
        "source": source,
        "verdict": verdict,
        "verdictReason": reason,
        "gates": [{"name": c["check"], "value": c["value"], "threshold": c["threshold"], "pass": c["pass"],
                   "result": c["result"]} for c in checks],
        "primary": {
            "market": pk, "marketLabel": instrument(pk, source).label, "strategy": "GHLZ",
            "is": _part(primary_summary["inSample"], part_trades(is_part[0][0], is_part[-1][0])),
            "oos": _part(primary_summary["outOfSample"], part_trades(oos_part[0][0], oos_part[-1][0])),
            "full": _part(primary_summary["full"], part_trades(primary[0][0], primary[-1][0])),
            "split": {"isFrom": is_part[0][0], "isTo": is_part[-1][0], "oosFrom": oos_part[0][0],
                      "oosTo": oos_part[-1][0]},
            "spreadBps": results.legs(pk, GHLZ)[0]["spreadBps"],
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
                           "scope": f"distinct configurations tried on the primary market ({pk})",
                           "configurations": [label for label, _ in configs.values()]},
        "comparison": [{"name": r["name"], "sharpe": r["sharpe"], "cagr": r["cagr"], "maxDd": r["maxDrawdown"],
                        "source": r.get("source", "this study"), "kind": r["kind"]} for r in comparison + ld_rows],
        "provenance": {**provenance, "dataHash": dhash},
        "spreads": {key: results.legs(key, GHLZ)[0]["spreadBps"] for key in keys},
        "spreadOrigins": spread_origins,
        "missingMarkets": missing,
        "config": {"capital": CAPITAL, "isFraction": m.IS_FRACTION, "gate": GATE, "minTrades": MIN_TRADES},
    }
    if detail_path is not None:
        detail_path.parent.mkdir(parents=True, exist_ok=True)
        detail_path.write_text(json.dumps(finite(detail, log=lambda _: None), allow_nan=False))  # json-data-ignore: report artifact under ~/Documents, outside the repo; the app never reads it
    return document(ran, rows, opt_rows, sens_rows, checks, verdict, reason, primary, comparison, ld_rows,
                    provenance, detail, curves, keys, source)


DUKASCOPY_SUFFIX = " (Dukascopy, CFD costs)"


def parse_compare_row(text: str) -> dict:
    """A Dukascopy headline row given on the command line, `NAME=SHARPE,CAGR,MAXDD` (fractions, e.g.
    `GHLZ US500=0.31,0.012,-0.21`), as a comparison row labelled '(Dukascopy, CFD costs)'. The IBKR run takes the
    Dukascopy numbers from the command line so it reads no other run's output file."""
    name, sep, values = text.partition("=")
    name = name.strip()
    parts = [p.strip() for p in values.split(",")]
    if not sep or not name or len(parts) != 3:
        raise ValueError(f"Comparison row {text!r}: expected NAME=SHARPE,CAGR,MAXDD")
    sharpe, cagr, max_dd = (float(p) for p in parts)
    if not all(math.isfinite(x) for x in (sharpe, cagr, max_dd)) or not -1.0 <= max_dd <= 0.0 or cagr <= -1.0:
        raise ValueError(f"Comparison row {text!r}: needs finite numbers, CAGR > -1 and -1 <= max drawdown <= 0 "
                         "(fractions, not percent)")
    full = (name + DUKASCOPY_SUFFIX)
    if len(full) > 80:
        raise ValueError(f"Comparison row name {name!r} is too long")
    return {"name": full, "kind": "strategy", "sharpe": sharpe, "cagr": cagr, "maxDrawdown": max_dd,
            "source": "Dukascopy run of this study (command line)"}


def _part(s: dict, trades: dict) -> dict:
    return {"sharpe": s["sharpe"], "cagr": s["cagr"], "maxDd": s["maxDrawdown"], "years": s["years"],
            "days": s["days"], **trades}


def _comparison(results: Results, keys: Sequence[str], curves: Mapping, bh: Mapping, options: Mapping,
                repo: Path, primary: str = PRIMARY, source: str = DEFAULT_SOURCE) -> list[dict]:
    rows = []
    for sid, name, _ in STRATEGIES:
        s = m.stats(curves[(sid, primary)])
        rows.append({"name": f"{name} on {primary} (underlying)", "kind": "strategy", "sharpe": s["sharpe"],
                     "cagr": s["cagr"], "maxDrawdown": s["maxDrawdown"], "source": "this study"})
    if "SPY" in keys and primary != "SPY":
        s = m.stats(curves[("ghlz", "SPY")])
        rows.append({"name": "GHLZ on SPY (underlying)", "kind": "strategy", "sharpe": s["sharpe"], "cagr": s["cagr"],
                     "maxDrawdown": s["maxDrawdown"], "source": "this study"})
        z = m.stats(curves[("zab", "SPY")])
        rows.append({"name": "ZAB on SPY (underlying, the paper's market)", "kind": "strategy", "sharpe": z["sharpe"],
                     "cagr": z["cagr"], "maxDrawdown": z["maxDrawdown"], "source": "this study"})
    primary_opt = options.get(("ghlz", primary))
    if primary_opt:
        s = m.stats(primary_opt["points"])
        rows.append({"name": f"GHLZ {primary} signals as SPY debit verticals (2 % max loss)", "kind": "strategy",
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
    b = m.stats(m.window(bh[primary], curves[("ghlz", primary)]))
    rows.append({"name": f"Buy and hold {TEXT[source]['primaryName']} (same window)", "kind": "buy-and-hold",
                 "sharpe": b["sharpe"],
                 "cagr": b["cagr"], "maxDrawdown": b["maxDrawdown"], "source": "this study"})
    rows += library_rows(repo)
    return rows


def document(ran: str, rows: list, opt_rows: list, sens_rows: list, checks: list, verdict: str, reason: str,
             primary: list, comparison: list, ld_rows: list, provenance: dict, detail: dict, curves: Mapping,
             keys: Sequence[str], source: str = DEFAULT_SOURCE) -> dict:
    from .rules import GAPS, RULES

    text = TEXT[check_source(source)]
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
             "description": text["underlying"],
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
        "equityLabel": text["equityLabel"],
        "provenance": provenance,
        "notes": notes(detail, curves, keys, source),
    }


def _empty_option_row() -> dict:
    return {"symbol": "-", "market": "no priced spreads", "from": "2000-01-01", "to": "2000-01-02", "trades": 0,
            "cagr": 0.0, "sharpe": 0.0, "maxDrawdown": 0.0, "profitFactor": None, "winRate": 0.0, "exposure": 0.0,
            "oosSharpe": None, "oosCagr": None, "buyHoldCagr": None, "buyHoldSharpe": None}


def notes(detail: dict, curves: Mapping, keys: Sequence[str], source: str = DEFAULT_SOURCE) -> str:
    p = detail["primary"]
    pk = p.get("market", PRIMARY)
    lines = [
        f"Primary GHLZ {pk} {p['split']['isFrom']} to {p['split']['oosTo']}: IS Sharpe {p['is']['sharpe']:.2f}, "
        f"OOS Sharpe {p['oos']['sharpe']:.2f} (OOS from {p['split']['oosFrom']}), CAGR {p['full']['cagr']:.1%}, "
        f"max DD {p['full']['maxDd']:.1%}, {p['full']['trades']} trades.",
        f"Options form (SPY verticals on {pk} signals): {p['options']['trades']} spreads, OOS Sharpe "
        f"{p['options']['outOfSample']['sharpe']:.2f}; ledger vs Nautilus max equity gap "
        f"{(p['options']['ledgerNautilusMaxGap'] or 0):.2f} USD.",
        "Legs: each strategy runs a long and a short DSL leg on 100,000 USD each; their daily returns are summed "
        "(the legs never hold together). Trades and Monte Carlo use both legs.",
        "BIAS factor definitions are our defaults (not shown in the reel); Session Delta uses 5-minute bar volume, "
        "not tick delta. " + TEXT[source]["volume"],
        "Options are priced from a daily IV index with a fixed smile; no intraday option quotes exist here, so the "
        "options form is a model, not a replay. One spread per market and day (later ZAB re-entries ignored).",
        "The deflated Sharpe trial count covers the primary market's configurations only (all strategies, "
        f"sensitivity rows and walk-forward grid points on {pk}); runs on other markets are not counted.",
        "Spread costs use the median spread of the in-sample part only. Option exits reuse the previous close's IV; "
        "expiry is the nearest Friday weekly (deviation from 'nearest expiry'). Sessions opening > 30 % from the "
        "previous close are dropped (USO split).",
        f"Markets: {', '.join(keys)}." + (f" Missing data: {', '.join(detail['missingMarkets'])}."
                                          if detail["missingMarkets"] else ""),
        "Full per-market tables, daily equity and drawdown: the detail JSON of the run (report artifact).",
    ]
    if source == IBKR:
        origins = detail.get("spreadOrigins", {})
        fallback = [key for key, origin in origins.items() if origin != SPREAD_MEASURED]
        lines.insert(0, "Data source: IBKR 5-minute TRADES bars (regular hours), Core 7 ETF twins, primary GHLZ on SPY; "
                        "spread = median IBKR BID_ASK sample spread in the in-sample part of the SPY window (half per "
                        "side), 0.25 bp slippage per side, IBKR Pro Fixed commissions. The Dukascopy run is the "
                        "default source of the same study." + (f" Spread from SPY (no own sample): {', '.join(fallback)}."
                                                                if fallback else ""))
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


def main_study(ran: str, workers: int, detail: str | None, source: str = DEFAULT_SOURCE,
               compare_rows: Sequence[str] = ()) -> int:
    date.fromisoformat(ran)
    extra = [parse_compare_row(row) for row in compare_rows]
    root = os.environ.get(IBKR_DATA_ENV if check_source(source) == IBKR else "VERTEX_IMOM_DATA")
    doc = run_study(ran, root=root, workers=workers, detail_path=Path(detail) if detail else None, source=source,
                    extra_comparison=extra)
    print(json.dumps(finite(doc), allow_nan=False))
    return 0


__all__ = ["GATE", "SLUG", "checks_of", "main_study", "parse_compare_row", "plan_jobs", "run_study", "verdict_of"]
