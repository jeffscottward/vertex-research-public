"""The volume-spike-breakout replication study (YouTube XLMG6-SATRk, strategy 39-113), research only.

Pre-registered design and pass rule: docs/specs/strategies/volume-spike-breakout.md. `run_study` reads only
the rig data directories (the fetched Dukascopy files, the ETF twin files of the market-intraday-momentum
study and the qc-ports daily VXN / T-bill / QQQ files) and returns the `strategy-backtest` research study
document and the detail for the report. Nothing here creates an order.

Memory: one market's 1-minute bars are loaded at a time in this process; worker processes (spawned, at most
`workers`, default 4) get only the bars of the trades they book.
"""
from __future__ import annotations

import json
import math
import multiprocessing
import subprocess
import sys
import time
from collections.abc import Callable, Mapping, Sequence
from concurrent.futures import ProcessPoolExecutor
from dataclasses import asdict
from datetime import date, timedelta
from pathlib import Path
from typing import Any

import numpy as np

from . import data, diagnostics, rules, runner
from . import metrics as mx
from . import options as opt
from .definition import (
    AS_STATED,
    DSL_TIMEFRAME,
    MISSING_DSL_PARTS,
    NO_STOP,
    SIDES,
    WALK_FORWARD_GRID,
    dsl_definition,
    percent_stop,
    sensitivity,
)
from .source import GAPS, RULES, SOURCE_LABEL, SOURCE_URL

SLUG = "volume-spike-breakout"
SPEC_PATH = f"docs/specs/strategies/{SLUG}.md"
TITLE = "Volume spike breakout on NAS100 15-minute candles (YouTube XLMG6-SATRk, strategy 39-113)"
START_DAY = "2019-01-01"
END_DAY = "2026-11-06"
# (key, label, first day, last day): the source's windows and the time after its dashboard date.
WINDOWS: tuple[tuple[str, str, str, str], ...] = (
    ("sourceIs", "Source in-sample", "2019-01-01", "2026-03-11"),
    ("sourceOos", "Source out-of-sample (6 months)", "2026-03-12", "2026-09-11"),
    ("after", "After the dashboard date", "2026-09-12", "2026-11-06"),
)
STOP_POINTS = 15.0
# Gate thresholds (packages/api/src/autopilot-gate.ts defaults), as pre-registered.
GATE = {"oosSharpeMin": 0.5, "deflatedSharpeMin": 0.95, "monteCarloDrawdownP5Min": -0.35,
        "neighbourShareMin": 0.75, "costStressMultiple": 2.0}
MIN_TRADES = 100
CONTROL_RUNS = 500
DEFAULT_WORKERS = 4
COST_SETS = ("vertex", "source", "vertex2x")
COST_LABEL = {"vertex": "Vertex costs", "source": "source costs", "vertex2x": "doubled Vertex costs"}
# Information cost rows (not used by a gate): name -> wording in a gate result.
INFO_COST_TEXT = {"fixedPointsSpread": "the spread as fixed points", "fillMinuteSpread": "the fill-minute spread"}
INFO_COST_LABEL = {"fixedPointsSpread": "Vertex spread as fixed points", "fillMinuteSpread": "Vertex spread at the fill minutes"}
STOP_FILL_FRACTION = 0.5
ROBUSTNESS_MAX = 20
STUDY_FILE = "study.json"  # json-data-ignore: report artifact under ~/Documents, outside the repo; the app never reads it
REPORT_FILE = "report-data.json"  # json-data-ignore: report artifact under ~/Documents, outside the repo; never read by the app

Log = Callable[[str], None]
Point = tuple[str, float]


def _log(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


def _fmt(value: float | None, spec: str = ".2f", missing: str = "n/a") -> str:
    return missing if value is None or not math.isfinite(value) else format(value, spec)


def next_day(day: str) -> str:
    return (date.fromisoformat(day) + timedelta(days=1)).isoformat()


def config_id(params: rules.Params) -> str:
    return json.dumps(asdict(params), sort_keys=True)


def finite(value: Any, path: str = "$", log: Log | None = None) -> Any:
    """The value with every non-finite number replaced by 0.0 (each one reported)."""
    if isinstance(value, float) and not math.isfinite(value):
        if log is not None:
            log(f"warning: non-finite number at {path}, stored as 0")
        return 0.0
    if isinstance(value, dict):
        return {str(k): finite(v, f"{path}.{k}", log) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [finite(v, f"{path}[{i}]", log) for i, v in enumerate(value)]
    if isinstance(value, np.generic):
        return finite(value.item(), path, log)
    return value


# ------------------------------------------------------------------------------------------------
# Workers


class Pool:
    """At most `workers` spawned processes (none of them inherits the parent's bars); 0 runs inline."""

    def __init__(self, workers: int) -> None:
        self.pool = (ProcessPoolExecutor(max_workers=workers, mp_context=multiprocessing.get_context("spawn"))
                     if workers > 0 else None)

    def run(self, fn: Callable[[dict], dict], jobs: Sequence[dict]) -> list[dict]:
        if self.pool is None:
            return [fn(job) for job in jobs]
        return list(self.pool.map(fn, jobs))

    def close(self) -> None:
        if self.pool is not None:
            self.pool.shutdown()


def _dates_of(ms: Sequence[int]) -> list[str]:
    if not ms:
        return []
    local = rules.ny_local_ms(np.asarray(ms, dtype=np.int64)) // rules.DAY_MS
    return [rules.day_text(d) for d in local]


def assemble(calendar: Sequence[int], legs: Sequence[dict], window_bars: int) -> dict:
    """One booked configuration: the leg-summed daily equity (base 1.0 on the first calendar day), the trades
    of both legs in entry order and the share of 1-minute bars held."""
    days = [rules.day_text(d) for d in calendar]
    curves = [runner.leg_points(calendar, leg["dayEquity"]) for leg in legs]
    points = mx.sum_legs(curves) if curves else mx.flat(days)
    trades = sorted((t for leg in legs for t in leg["trades"]), key=lambda t: t["entryMs"])
    for trade, entry, exit_ in zip(trades, _dates_of([t["entryMs"] for t in trades]),
                                   _dates_of([t["exitMs"] for t in trades])):
        trade["entryDate"] = entry
        trade["exitDate"] = exit_
    held = sum(t["exitIndex"] - t["entryIndex"] + 1 for t in trades if "exitIndex" in t)
    return {"points": points, "trades": trades,
            "exposure": min(1.0, held / window_bars) if window_bars > 0 else 0.0,
            "maxRDiff": max((leg.get("maxRDiff", 0.0) for leg in legs), default=0.0),
            "bars": sum(leg["bars"] for leg in legs),
            "engine": legs[0]["engine"] if legs else runner.ENGINE_ID}


def book_all(pool: Pool, m: rules.Minutes, calendar: Sequence[int], window_bars: int,
             entries: Sequence[tuple[str, Sequence[rules.Trade], rules.Costs, bool]]) -> dict[str, dict]:
    """Books every (name, trades, costs, etf) entry: one Nautilus run per side with trades."""
    jobs, owner = [], []
    for name, trades, costs, etf in entries:
        for side in (rules.LONG, rules.SHORT):
            plan = runner.leg_plan(m, trades, side)
            if plan is not None:
                jobs.append({"name": name, "plan": plan, "profile": runner.profile_of(costs, etf, name[:40])})
                owner.append(name)
    legs: dict[str, list[dict]] = {name: [] for name, *_ in entries}
    for name, result in zip(owner, pool.run(runner.book_leg, jobs)):
        legs[name].append(result)
    return {name: assemble(calendar, legs[name], window_bars) for name in legs}


# ------------------------------------------------------------------------------------------------
# Rows and parts


def in_window(trades: Sequence[Mapping], first: str, last: str) -> list[Mapping]:
    return [t for t in trades if first <= t["entryDate"] <= last]


def part_of(points: Sequence[Point], trades: Sequence[Mapping], first: str, last: str) -> dict:
    """Statistics of one window of a booked run; a window without trades or days gives zeros and None."""
    pts = mx.window_base(points, first, last)
    s = mx.stats(pts)
    inside = in_window(trades, first, last)
    gross = [t["rGross"] for t in inside if "rGross" in t]
    return {
        "from": first, "to": last, "days": max(0, len(pts) - 1), "sharpe": s["sharpe"], "cagr": s["cagr"],
        "maxDrawdown": s["maxDrawdown"], "totalReturn": pts[-1][1] / pts[0][1] - 1 if len(pts) > 1 else 0.0,
        **mx.trade_summary(inside), "r": mx.r_stats([t["rNet"] for t in inside if "rNet" in t]),
        "grossR": sum(gross) / len(gross) if gross else None, "noTrades": not inside,
    }


def run_row(symbol: str, market: str, booked: Mapping, buy_hold: Sequence[Point], first: str, last: str, *,
            with_oos: bool = True) -> dict | None:
    """One runs-table row of the study document for the window [first, last]; None without days in it."""
    points = mx.window_base(booked["points"], first, last)
    inside = [p for p in points if first <= p[0] <= last]
    if not inside:
        return None
    s = mx.split_summary(points)
    trades = in_window(booked["trades"], first, last)
    ts = mx.trade_summary(trades)
    bh = mx.window_base(buy_hold, first, last)
    bh_s = mx.stats(bh) if len(bh) > 2 else None
    oos = with_oos and s["split"] is not None
    return {
        "symbol": symbol[:40].strip(), "market": market[:60].strip(), "from": inside[0][0], "to": inside[-1][0],
        "trades": ts["trades"], "cagr": max(-1.0, s["full"]["cagr"]), "sharpe": s["full"]["sharpe"],
        "maxDrawdown": s["full"]["maxDrawdown"], "profitFactor": ts["profitFactor"], "winRate": ts["winRate"],
        "exposure": float(booked.get("exposure", 0.0)),
        "oosSharpe": s["outOfSample"]["sharpe"] if oos else None,
        "oosCagr": max(-1.0, s["outOfSample"]["cagr"]) if oos else None,
        "buyHoldCagr": max(-1.0, bh_s["cagr"]) if bh_s else None, "buyHoldSharpe": bh_s["sharpe"] if bh_s else None,
    }


def breakdown(trades: Sequence[Mapping], first: str, last: str) -> dict:
    """Exit reasons, longs against shorts and hold time of the trades (R net of the run's costs)."""
    total = len(trades)
    reasons: dict[str, dict] = {}
    for reason in sorted({t["reason"] for t in trades}):
        rs = [t["rNet"] for t in trades if t["reason"] == reason]
        reasons[reason] = {"trades": len(rs), "share": len(rs) / total if total else None,
                           "meanR": sum(rs) / len(rs) if rs else None, "totalR": sum(rs)}
    sides = {side: mx.r_stats([t["rNet"] for t in trades if t["side"] == side]) for side in SIDES}
    hold = sorted(t["holdMinutes"] for t in trades)
    weeks = max(1.0, ((date.fromisoformat(last) - date.fromisoformat(first)).days + 1) / 7)
    traded_weeks = len({mx.week_start(t["entryDate"]) for t in trades})
    return {
        "trades": total, "exitReasons": reasons, "sides": sides,
        "holdMinutes": {"mean": sum(hold) / total if total else None,
                        "median": hold[total // 2] if total else None,
                        "p90": hold[min(total - 1, int(0.9 * total))] if total else None},
        "tradesPerWeek": total / weeks, "weeksWithTrade": min(1.0, traded_weeks / weeks),
    }


def by_year(runs: Mapping[str, Mapping]) -> list[dict]:
    """Expectancy by entry year: trades, win rate and mean R gross and net of each cost set."""
    years = sorted({t["entryDate"][:4] for run in runs.values() for t in run["trades"]})
    rows = []
    for year in years:
        row: dict[str, Any] = {"year": int(year)}
        for name, run in runs.items():
            inside = [t for t in run["trades"] if t["entryDate"][:4] == year]
            r = mx.r_stats([t["rNet"] for t in inside])
            row[name] = {"trades": r["trades"], "winRate": r["winRate"], "meanR": r["meanR"], "totalR": r["totalR"]}
            if name == "vertex":
                gross = [t["rGross"] for t in inside]
                row["trades"] = len(inside)
                row["grossR"] = sum(gross) / len(gross) if gross else None
        rows.append(row)
    return rows


def weekly(trades: Sequence[Mapping], first: str, last: str) -> list[list]:
    """Cumulative net R by week of the exit, for the trades entered in [first, last]."""
    inside = sorted(in_window(trades, first, last), key=lambda t: t["exitMs"])
    return mx.weekly_r([(t["exitDate"], t["rNet"]) for t in inside])


# ------------------------------------------------------------------------------------------------
# Gates and verdict (the pre-registered rule; never chosen by hand)


def _info_text(info: Mapping[str, Mapping] | None, field: str, spec: str = ".2f") -> str:
    """'; information: X with the spread as fixed points, Y with the fill-minute spread' for a gate result."""
    if not info:
        return ""
    parts = [f"{_fmt(values.get(field), spec)} with {INFO_COST_TEXT[name]}" for name, values in info.items()
             if name in INFO_COST_TEXT]
    return "; information, not the gate: " + ", ".join(parts) if parts else ""


def checks_of(primary: Mapping, deflated: Mapping, monte_carlo: Mapping, neighbour_share: float, neighbours: int,
              stress: Mapping, info: Mapping[str, Mapping] | None = None) -> list[dict]:
    """The five gates on the primary with Vertex costs (the pre-registered all-minutes spread). `info` holds the
    same numbers for the information cost rows; they are shown in the result text and decide nothing."""
    oos = primary["outOfSample"]
    p5 = monte_carlo.get("maxDrawdownP5")
    checks = _checks(primary, deflated, monte_carlo, neighbour_share, neighbours, stress, oos, p5)
    for check, field, spec in ((checks[0], "oosSharpe", ".2f"), (checks[1], "deflatedN10000", ".3f"),
                               (checks[4], "stressSharpe", ".2f")):
        check["result"] = (check["result"] + _info_text(info, field, spec))[:300].rstrip()
    return checks


def _checks(primary: Mapping, deflated: Mapping, monte_carlo: Mapping, neighbour_share: float, neighbours: int,
            stress: Mapping, oos: Mapping, p5: float | None) -> list[dict]:
    return [
        {"check": "Out-of-sample Sharpe (last 40 % of the time)", "value": oos["sharpe"],
         "threshold": GATE["oosSharpeMin"], "pass": oos["sharpe"] >= GATE["oosSharpeMin"],
         "short": f"OOS Sharpe {oos['sharpe']:.2f} (needs >= {GATE['oosSharpeMin']})",
         "result": f"OOS Sharpe {oos['sharpe']:.2f} (in-sample {primary['inSample']['sharpe']:.2f}); "
                   f"OOS CAGR {oos['cagr']:.1%}"},
        {"check": "Deflated Sharpe probability, N = 10,000 trials", "value": deflated["probability"],
         "threshold": GATE["deflatedSharpeMin"], "pass": deflated["probability"] >= GATE["deflatedSharpeMin"],
         "short": f"deflated Sharpe probability {deflated['probability']:.3f} (needs >= {GATE['deflatedSharpeMin']})",
         "result": f"{deflated['probability']:.3f} with N = {deflated['trials']:,} (the source's count), trial "
                   "variance from our own configurations"},
        {"check": "Monte Carlo drawdown P5", "value": p5, "threshold": GATE["monteCarloDrawdownP5Min"],
         "pass": p5 is not None and p5 >= GATE["monteCarloDrawdownP5Min"],
         "short": f"Monte Carlo P5 max drawdown {_fmt(p5, '.1%')} (needs >= {GATE['monteCarloDrawdownP5Min']:.0%})",
         "result": (f"P5 max drawdown {p5:.1%} over {monte_carlo.get('paths', 0)} trade bootstraps; loss share "
                    f"{monte_carlo.get('lossShare', 0):.0%}") if p5 is not None else "too few trades to bootstrap"},
        {"check": "Parameter changes with Sharpe > 0", "value": neighbour_share,
         "threshold": GATE["neighbourShareMin"], "pass": neighbour_share >= GATE["neighbourShareMin"],
         "short": f"{neighbour_share:.0%} of parameter changes keep Sharpe > 0 (needs >= "
                  f"{GATE['neighbourShareMin']:.0%})",
         "result": f"{neighbour_share:.0%} of {neighbours} one-at-a-time changes keep Sharpe > 0"},
        {"check": "Doubled Vertex costs", "value": stress["sharpe"], "threshold": 0, "pass": stress["sharpe"] > 0,
         "short": f"Sharpe {stress['sharpe']:.2f} with doubled costs (needs > 0)",
         "result": f"Sharpe {stress['sharpe']:.2f}, CAGR {stress['cagr']:.1%} with doubled spread and slippage"},
    ]


def verdict_rule(*, oos_sharpe: float, deflated_probability: float, gates_passed: int, gates_total: int,
                 reproduced: bool, options_oos_sharpes: Sequence[float | None], trades: int) -> str:
    """The pre-registered rule (spec 'Pass/fail rule'), in the order of the market-intraday-momentum study:
    no edge first, then too few trades, then edge, else needs more data."""
    if oos_sharpe <= 0 or deflated_probability < 0.5 or gates_passed <= 2:
        return "no-edge"
    if trades < MIN_TRADES:
        return "needs-more-data"
    options_ok = any(value is not None and value > 0 for value in options_oos_sharpes)
    if gates_passed == gates_total and reproduced and options_ok:
        return "edge"
    return "needs-more-data"


def verdict_of(gates: Sequence[Mapping], oos_sharpe: float, deflated_probability: float, reproduced: bool,
               options_oos: Mapping[str, float | None], trades: int) -> tuple[str, str]:
    passed = sum(1 for gate in gates if gate["pass"])
    verdict = verdict_rule(oos_sharpe=oos_sharpe, deflated_probability=deflated_probability, gates_passed=passed,
                           gates_total=len(gates), reproduced=reproduced,
                           options_oos_sharpes=list(options_oos.values()), trades=trades)
    failed = "; ".join(gate.get("short", gate["check"]) for gate in gates if not gate["pass"]) or "none"
    options_text = ", ".join(f"{name} {_fmt(value)}" for name, value in options_oos.items()) or "not priced"
    reason = (f"{passed}/{len(gates)} gates pass on the NAS100 primary with Vertex costs (OOS Sharpe {oos_sharpe:.2f}, "
              f"deflated Sharpe probability with N = 10,000 {deflated_probability:.3f}, {trades} trades). The source's "
              f"claim is {'reproduced' if reproduced else 'not reproduced'} with the source's costs. Options form OOS "
              f"Sharpe: {options_text}. Failed gates: {failed}.")
    return verdict, reason[:1000].rstrip()


# ------------------------------------------------------------------------------------------------
# Random-entry control


def control_runs(fr: rules.Frame, params: rules.Params, start_ms: int, end_ms: int, count: int, runs: int,
                 cost_sets: Mapping[str, rules.Costs], seed: int = mx.CONTROL_SEED) -> list[dict]:
    """`runs` random-entry runs (rules.random_control), each with its own seeded generator; R of each cost set."""
    out = []
    for number in range(runs):
        trades = rules.random_control(fr, params, start_ms, end_ms, count, np.random.default_rng([seed, number]))
        row: dict[str, Any] = {"run": number, "trades": len(trades), "short": len(trades) < count,
                               "longShare": sum(1 for t in trades if t.side == rules.LONG) / len(trades)
                               if trades else None,
                               "stopShare": sum(1 for t in trades if t.reason == "stop") / len(trades)
                               if trades else None}
        for name, costs in cost_sets.items():
            r = mx.r_stats([t.r_net for t in rules.reprice(trades, costs)])
            row[name] = {"meanR": r["meanR"], "totalR": r["totalR"], "winRate": r["winRate"],
                         "sharpePerTrade": r["sharpePerTrade"], "maxDrawdownR": r["maxDrawdownR"]}
        out.append(row)
    return out


def control_summary(runs: Sequence[Mapping], ours: Mapping[str, Mapping], count: int) -> dict:
    """Quantiles of the control runs and the share of runs at or above our result, per cost set."""
    out: dict[str, Any] = {"runs": len(runs), "entriesWanted": count,
                           "entries": mx.quantiles([float(r["trades"]) for r in runs], (0.0, 0.5, 1.0)),
                           # Runs that could not take the wanted number of entries (reported, never hidden).
                           "runsShort": sum(1 for r in runs if r["trades"] < count),
                           "runsOver": sum(1 for r in runs if r["trades"] > count)}
    for name, mine in ours.items():
        means = [r[name]["meanR"] for r in runs if r[name]["meanR"] is not None]
        totals = [r[name]["totalR"] for r in runs if r[name]["meanR"] is not None]
        sharpes = [r[name]["sharpePerTrade"] for r in runs if r[name]["sharpePerTrade"] is not None]
        out[name] = {
            "meanR": mx.quantiles(means), "totalR": mx.quantiles(totals), "sharpePerTrade": mx.quantiles(sharpes),
            "meanOfMeanR": sum(means) / len(means) if means else None,
            "positiveShare": sum(1 for v in totals if v > 0) / len(totals) if totals else None,
            "ours": {"meanR": mine.get("meanR"), "totalR": mine.get("totalR"),
                     "sharpePerTrade": mine.get("sharpePerTrade")},
            "shareAtOrAboveOursMeanR": mx.share_at_least(means, mine.get("meanR")),
            "shareAtOrAboveOursTotalR": mx.share_at_least(totals, mine.get("totalR")),
            "shareAtOrAboveOursSharpe": mx.share_at_least(sharpes, mine.get("sharpePerTrade")),
        }
    return out


# ------------------------------------------------------------------------------------------------
# Claim against ours


def claim_table(source: Mapping[str, Mapping], vertex: Mapping[str, Mapping], check: Mapping) -> list[dict]:
    """Rows metric / claim / ours with the source's costs / ours with Vertex costs. `source` and `vertex` hold
    the parts `sourceIs` and `sourceOos` and the breakdown `sourceIsBreakdown`."""
    passes = {part["metric"]: part["pass"] for part in check["parts"]}
    claim = mx.CLAIM

    def row(metric: str, claimed: Any, pick: Callable[[Mapping], Any], key: str | None = None) -> dict:
        return {"metric": metric, "claim": claimed, "oursSourceCosts": pick(source), "oursVertexCosts": pick(vertex),
                "pass": passes.get(key) if key else None}

    def stop_share(run: Mapping) -> float | None:
        return (run["sourceIsBreakdown"]["exitReasons"].get("stop") or {}).get("share")

    return [
        row("Trades (source in-sample window)", claim["trades"], lambda r: r["sourceIs"]["r"]["trades"], "trades"),
        row("Win rate", claim["winRate"], lambda r: r["sourceIs"]["r"]["winRate"], "winRate"),
        row("Average reward : risk", claim["rewardRisk"], lambda r: r["sourceIs"]["r"]["rewardRisk"]),
        row("Net R per trade", claim["netR"], lambda r: r["sourceIs"]["r"]["meanR"], "netR"),
        row("Gross R per trade", claim["grossR"], lambda r: r["sourceIs"]["grossR"]),
        row("Total net R", claim["totalR"], lambda r: r["sourceIs"]["r"]["totalR"]),
        row("Max drawdown (R)", claim["maxDrawdownR"], lambda r: r["sourceIs"]["r"]["maxDrawdownR"]),
        row("Losses in a row", claim["maxLosingStreak"], lambda r: r["sourceIs"]["r"]["maxLosingStreak"]),
        row("Share of stop exits", claim["stopShare"], stop_share),
        row("Net R per trade, longs", claim["longR"], lambda r: r["sourceIsBreakdown"]["sides"]["long"]["meanR"]),
        row("Net R per trade, shorts", claim["shortR"], lambda r: r["sourceIsBreakdown"]["sides"]["short"]["meanR"]),
        row("Average hold (minutes)", claim["holdMinutes"], lambda r: r["sourceIsBreakdown"]["holdMinutes"]["mean"]),
        row("Trades per week", claim["tradesPerWeek"], lambda r: r["sourceIsBreakdown"]["tradesPerWeek"]),
        row("OOS 6 months: net R per trade", claim["oosNetR"], lambda r: r["sourceOos"]["r"]["meanR"]),
        row("OOS 6 months: trades", claim["oosTrades"], lambda r: r["sourceOos"]["r"]["trades"]),
        row("OOS 6 months: total net R", claim["oosTotalR"], lambda r: r["sourceOos"]["r"]["totalR"]),
    ]


# ------------------------------------------------------------------------------------------------
# Options form


def options_form(signals: Mapping[str, Sequence[opt.Signal]], twin_bars: data.MarketBars, market, first: str,
                 last: str, log: Log, *, nautilus: bool = True) -> dict[str, dict]:
    """Books each row's signals as QQQ debit verticals; a row without a priced spread is absent."""
    twin = opt.TwinClock(twin_bars.minutes)
    before = [ms for day, ms in zip(twin.days, twin.close_ms) if day < first]
    closes = before[-1:] + [ms for day, ms in zip(twin.days, twin.close_ms) if first <= day <= last]
    out: dict[str, dict] = {}
    for name, wanted in signals.items():
        spreads, skipped = opt.price_signals(wanted, twin, market)
        log(f"options {name}: {len(wanted)} signals, {len(spreads)} spreads, skipped {skipped or 'none'}")
        if not spreads:
            continue
        booked = opt.book(spreads, closes, runner.CAPITAL, nautilus=nautilus)
        result = booked["result"]
        pnl = [t.get("pnl", 0.0) for t in result.trades]
        wins = [p for p in pnl if p > 0]
        losses = [-p for p in pnl if p <= 0]
        held = sum(1 for n in result.open_positions if n > 0)
        out[name] = {
            "points": booked["points"], "signals": len(wanted), "spreads": len(spreads), "skipped": skipped,
            "booked": len(result.trades), "sizeSkipped": len(result.skipped), "ledgerNautilusMaxGap": booked["maxGap"],
            "winRate": len(wins) / len(pnl) if pnl else 0.0,
            "profitFactor": sum(wins) / sum(losses) if losses and sum(losses) > 0 else None,
            "exposure": held / len(result.open_positions) if result.open_positions else 0.0,
            "returns": booked["returns"], "expiryExits": sum(1 for s in spreads if s.exit_reason == "expiry"),
            "meanReturnOnRisk": (sum(t["returnOnRisk"] for t in result.trades) / len(result.trades)
                                 if result.trades else None),
            "engine": result.engine,
        }
    return out


def option_row(name: str, label: str, booked: Mapping, buy_hold: Sequence[Point]) -> dict:
    points = booked["points"]
    s = mx.split_summary(points)
    bh = mx.window(buy_hold, points)
    bh_s = mx.stats(bh) if len(bh) > 2 else None
    return {
        "symbol": f"{name} QQQ debit verticals"[:40], "market": label[:60].strip(), "from": points[0][0],
        "to": points[-1][0], "trades": booked["booked"], "cagr": max(-1.0, s["full"]["cagr"]),
        "sharpe": s["full"]["sharpe"], "maxDrawdown": s["full"]["maxDrawdown"],
        "profitFactor": booked["profitFactor"], "winRate": booked["winRate"], "exposure": booked["exposure"],
        "oosSharpe": s["outOfSample"]["sharpe"] if s["split"] else None,
        "oosCagr": max(-1.0, s["outOfSample"]["cagr"]) if s["split"] else None,
        "buyHoldCagr": max(-1.0, bh_s["cagr"]) if bh_s else None, "buyHoldSharpe": bh_s["sharpe"] if bh_s else None,
    }


def _empty_option_row() -> dict:
    return {"symbol": "-", "market": "no priced spreads", "from": START_DAY, "to": END_DAY, "trades": 0,
            "cagr": 0.0, "sharpe": 0.0, "maxDrawdown": 0.0, "profitFactor": None, "winRate": 0.0, "exposure": 0.0,
            "oosSharpe": None, "oosCagr": None, "buyHoldCagr": None, "buyHoldSharpe": None}


# ------------------------------------------------------------------------------------------------
# Study


def _cost_view(costs: rules.Costs, price: float | None, stop: float | None) -> dict:
    """A cost set in numbers: per side, and per round trip in points and in R at `price` with stop distance `stop`."""
    trip = costs.round_trip(rules.LONG, price, price, stop or 0.0) if price else None
    return {"perUnitPerSide": costs.per_unit, "ratePerSideBps": costs.rate * 1e4, "saleRateBps": costs.sale_rate * 1e4,
            "stopFractionPerSide": costs.stop_fraction,
            "roundTripAtMedianClose": trip, "roundTripR": trip / stop if trip is not None and stop else None}


def _stat_view(points: Sequence[Point]) -> dict:
    s = mx.split_summary(points)
    return {"full": s["full"], "inSample": s["inSample"], "outOfSample": s["outOfSample"], "split": s["split"]}


def run_study(ran: str, *, root: str | None = None, twin_root: str | None = None, workers: int = DEFAULT_WORKERS,
              repo: Path | None = None, log: Log = _log, controls: int = CONTROL_RUNS,
              markets: Sequence[str] | None = None, start: str = START_DAY, end: str = END_DAY,
              windows: Sequence[tuple[str, str, str, str]] = WINDOWS, option_market=None,
              nautilus_options: bool = True, ibkr_root: str | None = None, ibkr_from: str = data.IBKR_FROM
              ) -> tuple[dict, dict]:
    """Runs the whole study. Returns (study document, detail for the report)."""
    date.fromisoformat(ran)
    started = time.time()
    repo = repo or Path(__file__).resolve().parents[4]
    primary_key = data.PRIMARY
    wanted = list(markets) if markets is not None else list(data.ALL_MARKETS)
    keys = [key for key in wanted if data.available(key, root, twin_root)]
    missing = [key for key in wanted if key not in keys]
    if primary_key not in keys:
        raise FileNotFoundError(f"No data for the primary market {primary_key}")
    if missing:
        log(f"warning: no data for {', '.join(missing)}; they are left out")
    start_ms, end_ms = rules.ny_ms(start), rules.ny_ms(next_day(end))
    is_key, _, is_first, is_last = windows[0]
    is_ms = (rules.ny_ms(is_first), rules.ny_ms(next_day(is_last)))
    pool = Pool(workers)
    try:
        primary = _primary(pool, primary_key, root, twin_root, start, end, start_ms, end_ms, is_ms, windows,
                           controls, log)
        stop_fraction = primary["stopFraction"]
        others, etf_info, ibkr = {}, {}, {}
        for key in keys:
            if key == primary_key:
                continue
            if data.is_etf(key):
                # The Dukascopy ETF-CFD twins: trade counts and spread only (their tick volume is no test).
                etf_info[key] = _market(pool, key, root, twin_root, start, end, start_ms, end_ms, is_ms, windows,
                                        stop_fraction, log, book=False)
            else:
                others[key] = _market(pool, key, root, twin_root, start, end, start_ms, end_ms, is_ms, windows,
                                      stop_fraction, log)
        etf_keys = [key for key in data.ETF_TWINS if key in wanted]
        for key in etf_keys:
            ibkr[key] = _ibkr(pool, key, ibkr_root, ibkr_from, start_ms, end_ms, is_ms, stop_fraction,
                              etf_info[key]["spread"] if key in etf_info else None, log)
    finally:
        pool.close()

    # Options form (c): QQQ debit verticals on the NAS100 signals.
    options: dict[str, dict] = {}
    twin_closes: list[Point] = []
    if data.available(data.OPTIONS_TWIN, root, twin_root):
        if option_market is None:
            from strategies.qc_ports.data import load_market as load_option_market

            option_market = load_option_market(data.OPTIONS_TWIN)
        twin_bars = data.load_market(data.OPTIONS_TWIN, root, twin_root)
        twin_closes = runner.daily_closes(twin_bars.minutes, runner.calendar_of(twin_bars.minutes, start_ms, end_ms))
        options = options_form(primary.pop("optionSignals"), twin_bars, option_market, start, end, log,
                               nautilus=nautilus_options)
        del twin_bars
    else:
        primary.pop("optionSignals")
        log(f"warning: no {data.OPTIONS_TWIN} minute data; the options form is not priced")

    detail = _detail(ran, repo, root, primary, others, options, twin_closes, keys, missing, start, end, windows,
                     controls, workers, log, etf_info, ibkr, etf_keys)
    detail["runtimeSeconds"] = round(time.time() - started, 1)
    doc = document(ran, detail)
    problems = validate_document(finite(doc))
    if problems:
        raise ValueError("The study document breaks the research-studies contract: " + "; ".join(problems[:8]))
    return doc, detail


def _load(key: str, root: str | None, twin_root: str | None, start_ms: int, end_ms: int, is_ms: tuple[int, int],
          log: Log) -> dict:
    bars = data.load_market(key, root, twin_root)
    m = bars.minutes
    fr = rules.frame(m)
    calendar = runner.calendar_of(m, start_ms, end_ms)
    part = data.window_slice(m.t, start_ms, end_ms)
    spread = data.spread_stats(bars, *is_ms)
    log(f"data {key}: {len(m):,} one-minute bars {data.summary_of(bars)['firstBar']} to "
        f"{data.summary_of(bars)['lastBar']}, {len(fr.cd):,} 15-minute candles, in-sample median spread "
        f"{_fmt(spread['bps'], '.3f')} bp ({_fmt(spread['points'], '.4g')} price units)")
    return {"bars": bars, "m": m, "fr": fr, "calendar": calendar, "windowBars": part.stop - part.start,
            "spread": spread, "closes": runner.daily_closes(m, calendar)}


def _primary(pool: Pool, key: str, root: str | None, twin_root: str | None, start: str, end: str, start_ms: int,
             end_ms: int, is_ms: tuple[int, int], windows: Sequence[tuple[str, str, str, str]], controls: int,
             log: Log) -> dict:
    loaded = _load(key, root, twin_root, start_ms, end_ms, is_ms, log)
    bars, m, fr, calendar = loaded["bars"], loaded["m"], loaded["fr"], loaded["calendar"]
    etf = data.is_etf(key)
    spread_bps = loaded["spread"]["bps"] or 0.0
    median_is = diagnostics.median_close(m, *is_ms)
    if not median_is:
        raise ValueError(f"No {key} bars in the source's in-sample window")
    stop_fraction = STOP_POINTS / median_is
    cost_sets = {"vertex": runner.vertex_costs(spread_bps, etf), "source": rules.source_costs(AS_STATED),
                 "vertex2x": runner.vertex_costs(spread_bps, etf, GATE["costStressMultiple"])}
    vertex = cost_sets["vertex"]

    # Every distinct configuration tried on the primary: the stated rule, the one-at-a-time changes and the
    # walk-forward grid.
    sens = sensitivity(stop_fraction)
    configs: dict[str, tuple[str, rules.Params]] = {config_id(AS_STATED): ("as stated", AS_STATED)}
    for param, value, params in sens:
        configs.setdefault(config_id(params), (f"{param} = {value}", params))
    for params in WALK_FORWARD_GRID:
        configs.setdefault(config_id(params), (f"walk-forward vol_mult {params.vol_mult:g}, k {params.k}, stop "
                                               f"{params.stop:g}", params))
    trades_of = {cid: rules.run_rule(fr, params, start_ms, end_ms, vertex) for cid, (_, params) in configs.items()}
    base_id = config_id(AS_STATED)
    base_trades = trades_of[base_id]
    log(f"{key}: {len(configs)} configurations, stated rule {len(base_trades)} trades")
    entries = [(cid, trades_of[cid], vertex, etf) for cid in configs]
    entries += [(f"{name}|{base_id}", rules.reprice(base_trades, cost_sets[name]), cost_sets[name], etf)
                for name in ("source", "vertex2x")]
    # Information only (not used by a gate), each also doubled: the same median spread taken as a fixed number
    # of points instead of basis points of the price; and the median spread at the fill minutes of the in-sample
    # trades. Half per side, plus the same slippage.
    is_trades = [t for t in base_trades if is_ms[0] <= t.entry_ms < is_ms[1]]
    spread_at_fills = diagnostics.fill_spread(bars, is_trades)
    slip = runner.SLIPPAGE_BPS / runner.BPS
    info_costs = {
        "fixedPointsSpread": rules.Costs(per_unit=(loaded["spread"]["points"] or 0.0) / 2, rate=slip),
        "fillMinuteSpread": rules.Costs(rate=(spread_at_fills["bps"] or 0.0) / 2 / runner.BPS + slip),
    }
    for name, costs in info_costs.items():
        for tag, multiple in (("", 1.0), ("2x", GATE["costStressMultiple"])):
            scaled = costs.times(multiple)
            entries.append((f"{name}{tag}|{base_id}", rules.reprice(base_trades, scaled), scaled, etf))
    booked = book_all(pool, m, calendar, loaded["windowBars"], entries)
    runs = {"vertex": booked[base_id], "source": booked[f"source|{base_id}"],
            "vertex2x": booked[f"vertex2x|{base_id}"]}
    log(f"{key}: booked {len(entries)} runs in Nautilus; stated rule {len(runs['vertex']['trades'])} trades, "
        f"max |R Nautilus - R rules.py| {max(b['maxRDiff'] for b in booked.values()):.2e}")

    # DSL form: the nearest definition, on 15-minute regular-session bars, through run_spec.
    columns = runner.regular_session_bars(m)
    dsl = None
    if len(columns["t"]) >= 2:
        legs = pool.run(runner.run_dsl_leg, [
            {"name": f"dsl-{side}", "side": side, "columns": columns, "definition": dsl_definition(side),
             "profile": runner.profile_of(vertex, etf, "dsl")} for side in SIDES])
        days = sorted({d for leg in legs for d, _ in leg["dayEquity"]})
        dsl = assemble(days, legs, 0)
        dsl["exposure"] = min(1.0, sum(leg["exposure"] for leg in legs))
        dsl["barsFed"] = len(columns["t"])
        log(f"{key}: DSL form {len(in_window(dsl['trades'], start, end))} trades in the window")
    del columns

    # Random-entry control: the same number of entries, session, stop and exits.
    control = control_runs(fr, AS_STATED, start_ms, end_ms, len(base_trades), controls,
                           {"vertex": vertex, "source": cost_sets["source"], "gross": rules.Costs()})
    log(f"{key}: random-entry control {len(control)} runs")

    option_signals = {"c1": opt.signals_of(base_trades),
                      "c2": opt.signals_of(rules.run_rule(fr, NO_STOP, start_ms, end_ms))}
    rules_view = {name: mx.r_stats([t.r_net for t in rules.reprice(base_trades, costs)])
                  for name, costs in cost_sets.items()}
    rules_view["gross"] = mx.r_stats([t.r_gross for t in base_trades])
    info_view = {name: {"label": f"{INFO_COST_LABEL[name]} (information only, not used by a gate)",
                        **_cost_view(costs, median_is, STOP_POINTS), "run": booked[f"{name}|{base_id}"],
                        "run2x": booked[f"{name}2x|{base_id}"]}
                 for name, costs in info_costs.items()}
    # Information only (rules.py arithmetic, not booked): every stop filled half-way from the modelled fill to
    # the extreme of its bar. The trades are the same; only the stop exits are worse.
    days = [rules.day_text(d) for d in calendar]

    def dated(trades: Sequence[rules.Trade]) -> list[tuple[str, float]]:
        exit_days = rules.session_day(np.array([t.exit_ms for t in trades], dtype=np.int64)) if trades else []
        return [(rules.day_text(d), t.r_net) for d, t in zip(exit_days, trades)]

    worse = {name: rules.worse_stop_fills(m, base_trades, STOP_FILL_FRACTION, cost_sets[name])
             for name in ("vertex", "source")}
    stop_fill = {
        "fraction": STOP_FILL_FRACTION, "days": days, "dated": dated(worse["vertex"]),
        "datedModel": dated(rules.reprice(base_trades, vertex)),
        "r": {name: mx.r_stats([t.r_net for t in trades]) for name, trades in worse.items()},
        "grossR": mx.r_stats([t.r_gross for t in worse["vertex"]])["meanR"],
        "stops": sum(1 for t in base_trades if t.reason == "stop"),
        "meanExtraLossPerStopR": (sum(a.r_gross - b.r_gross for a, b in zip(base_trades, worse["vertex"]))
                                  / max(1, sum(1 for t in base_trades if t.reason == "stop"))),
    }
    out = {
        "key": key, "label": data.instrument(key).label, "calendar": [rules.day_text(d) for d in calendar],
        "closes": loaded["closes"], "spread": loaded["spread"], "medianCloseIs": median_is,
        "stopFraction": stop_fraction, "costSets": cost_sets, "configs": configs, "sensitivity": sens,
        "booked": booked, "runs": runs, "baseId": base_id, "dsl": dsl, "control": control,
        "optionSignals": option_signals, "rulesR": rules_view, "infoCosts": info_view, "stopFill": stop_fill,
        "spreadByYear": diagnostics.spread_by_year(bars), "summary": data.summary_of(bars),
        "spreadSession": diagnostics.session_spread(bars, AS_STATED, *is_ms),
        "spreadAtFills": spread_at_fills,
        "volume": diagnostics.volume_regime(fr, AS_STATED),
        "spikeTimes": diagnostics.spike_times(fr, AS_STATED, *is_ms),
        "medianCloseByYear": diagnostics.median_close_by_year(m, STOP_POINTS),
        "candles": len(fr.cd), "splits": list(bars.splits), "windowBars": loaded["windowBars"],
    }
    return out


def _market(pool: Pool, key: str, root: str | None, twin_root: str | None, start: str, end: str, start_ms: int,
            end_ms: int, is_ms: tuple[int, int], windows: Sequence[tuple[str, str, str, str]], stop_fraction: float,
            log: Log, *, book: bool = True) -> dict:
    """The stated rule on another market with the percent stop and Vertex costs. `book=False` (the Dukascopy
    ETF-CFD twins, whose tick volume is no test of the rule): the trades are only counted, as information."""
    loaded = _load(key, root, twin_root, start_ms, end_ms, is_ms, log)
    bars, m, fr, calendar = loaded["bars"], loaded["m"], loaded["fr"], loaded["calendar"]
    etf = data.is_etf(key)
    params = percent_stop(AS_STATED, stop_fraction)
    vertex = runner.vertex_costs(loaded["spread"]["bps"] or 0.0, etf)
    trades = rules.run_rule(fr, params, start_ms, end_ms, vertex)
    source_r = mx.r_stats([t.r_net for t in rules.reprice(trades, rules.source_costs(params))])
    median_is = diagnostics.median_close(m, *is_ms)
    if book:
        booked = book_all(pool, m, calendar, loaded["windowBars"], [(key, trades, vertex, etf)])[key]
        log(f"{key}: {len(trades)} trades, net R per trade "
            f"{_fmt(mx.r_stats([t['rNet'] for t in booked['trades']])['meanR'], '.3f')} (Vertex costs), "
            f"{_fmt(source_r['meanR'], '.3f')} (source costs)")
    else:
        booked = None
        log(f"{key}: {len(trades)} trades on the Dukascopy ETF-CFD tick volume (information only, not booked)")
    return {
        "trades": len(trades),
        "key": key, "label": data.instrument(key).label, "calendar": [rules.day_text(d) for d in calendar],
        "closes": loaded["closes"], "spread": loaded["spread"], "medianCloseIs": median_is, "booked": booked,
        "costs": vertex, "sourceCostR": source_r, "summary": data.summary_of(bars),
        "spreadSession": diagnostics.session_spread(bars, params, *is_ms),
        "volume": diagnostics.volume_regime(fr, params), "spikeTimes": diagnostics.spike_times(fr, params, *is_ms),
        "candles": len(fr.cd), "splits": list(bars.splits), "etf": etf,
    }


def _ibkr(pool: Pool, key: str, ibkr_root: str | None, ibkr_from: str, start_ms: int, end_ms: int,
          is_ms: tuple[int, int], stop_fraction: float, fallback_spread: Mapping | None, log: Log) -> dict:
    """The stated rule on an ETF twin's IBKR 5-minute bars (real exchange volume): 15-minute signal candles
    and 4-hour candles built from the 5-minute bars, fills and the stop resolved on the 5-minute bars, the
    percent stop, the ETF Vertex costs. Returns the booked run, or the reason the twin is not testable."""
    loaded = data.load_ibkr(key, ibkr_root, end_ms, ibkr_from)
    file_info = {"rowsInFile": loaded.rows_in_file, "firstInFile": loaded.first_in_file,
                 "lastInFile": loaded.last_in_file, "sha256OfBarsUsed": loaded.sha256}
    if not loaded.available:
        log(f"{key} IBKR: not testable ({loaded.reason})")
        return {"key": key, "status": data.ETF_UNTESTED, "reason": loaded.reason, "file": file_info}
    spread = data.ibkr_quoted_spread(key, ibkr_root, *is_ms)
    origin = "IBKR BID_ASK sample, source in-sample window"
    if spread["bps"] is None:
        spread, origin = dict(fallback_spread or {"bps": None}), "Dukascopy ETF-CFD quotes, source in-sample window"
    if spread.get("bps") is None:
        log(f"{key} IBKR: not testable ({data.ETF_NO_SPREAD})")
        return {"key": key, "status": data.ETF_UNTESTED, "reason": data.ETF_NO_SPREAD, "file": file_info}
    m = loaded.minutes
    fr = rules.frame(m)
    calendar = runner.calendar_of(m, start_ms, end_ms)
    part = data.window_slice(m.t, start_ms, end_ms)
    params = percent_stop(AS_STATED, stop_fraction)
    vertex = runner.vertex_costs(spread["bps"], True)
    trades = rules.run_rule(fr, params, start_ms, end_ms, vertex)
    name = f"{key}-ibkr"
    booked = book_all(pool, m, calendar, part.stop - part.start, [(name, trades, vertex, True)])[name]
    source_r = mx.r_stats([t.r_net for t in rules.reprice(trades, rules.source_costs(params))])
    log(f"{key} IBKR 5-minute: {len(m):,} bars, {len(fr.cd):,} 15-minute candles, spread {spread['bps']:.3f} bp "
        f"({origin}); {len(trades)} trades, net R per trade "
        f"{_fmt(mx.r_stats([t['rNet'] for t in booked['trades']])['meanR'], '.3f')} (Vertex costs), "
        f"{_fmt(source_r['meanR'], '.3f')} (source costs)")
    first = str(np.datetime64(int(m.t[0]), "ms").astype("datetime64[m]")) + "Z"
    last = str(np.datetime64(int(m.t[-1]), "ms").astype("datetime64[m]")) + "Z"
    return {
        "key": key, "status": data.ETF_TESTED, "reason": None, "label": data.instrument(key).label, "booked": booked,
        "closes": runner.daily_closes(m, calendar), "costs": vertex, "spread": {**spread, "origin": origin},
        "sourceCostR": source_r, "medianCloseIs": diagnostics.median_close(m, *is_ms), "file": file_info,
        "summary": {"rows": len(m), "firstBar": first, "lastBar": last}, "candles": len(fr.cd),
        "volume": diagnostics.volume_regime(fr, params), "spikeTimes": diagnostics.spike_times(fr, params, *is_ms),
        "sessionSpikesByYear": diagnostics.session_spikes_by_year(fr, params), "splits": list(loaded.splits),
    }


def etf_twin_rows(keys: Sequence[str], ibkr: Mapping[str, Mapping], dukascopy_trades: Mapping[str, int | None],
                  stats: Mapping[str, Mapping]) -> list[dict]:
    """One row per ETF twin: `tested-ibkr` with its result (IBKR 5-minute bars, exchange volume), or
    `not-testable` with the reason. `dukascopyTrades` is the trade count on the Dukascopy ETF-CFD tick volume
    (information only; never a result)."""
    rows = []
    for key in keys:
        item = ibkr.get(key) or {}
        tested = item.get("status") == data.ETF_TESTED
        row = {"market": key, "status": data.ETF_TESTED if tested else data.ETF_UNTESTED,
               "reason": None if tested else (item.get("reason") or data.ETF_NOT_TESTABLE),
               "data": "IBKR 5-minute, exchange volume" if tested else None,
               "dukascopyTrades": dukascopy_trades.get(key)}
        if tested:
            row.update(stats.get(key, {}))
        rows.append(row)
    return rows


def _row_label(key: str) -> tuple[str, str]:
    """(symbol, market) of a CFD market's row in the runs table, with the form it belongs to."""
    label = data.instrument(key).label
    form = "(a)+(b)" if key in data.SOURCE_MARKETS else "(b)"
    return f"{form} {key}", f"{label}, percent stop"


def _detail(ran: str, repo: Path, root: str | None, primary: dict, others: Mapping[str, dict],
            options: Mapping[str, dict], twin_closes: Sequence[Point], keys: Sequence[str], missing: Sequence[str],
            start: str, end: str, windows: Sequence[tuple[str, str, str, str]], controls: int, workers: int,
            log: Log, etf_info: Mapping[str, dict], ibkr: Mapping[str, dict], etf_keys: Sequence[str]) -> dict:
    key = primary["key"]
    runs = primary["runs"]
    booked = primary["booked"]
    configs = primary["configs"]
    base = runs["vertex"]
    points = base["points"]
    closes = primary["closes"]
    is_key, is_label, is_first, is_last = windows[0]
    oos_window = windows[1] if len(windows) > 1 else None

    # Primary: the source's windows and our 60/40 split, per cost set.
    summary = {name: _stat_view(run["points"]) for name, run in runs.items()}
    split = summary["vertex"]["split"]
    window_parts = []
    for wkey, wlabel, first, last in windows:
        row = {"key": wkey, "label": wlabel, "from": first, "to": last}
        for name, run in runs.items():
            row[name] = part_of(run["points"], run["trades"], first, last)
        window_parts.append(row)
    split_parts = {}
    if split is not None:
        for part, (first, last) in (("inSample", (split["isFrom"], split["isTo"])),
                                    ("outOfSample", (next_day(split["isTo"]), split["oosTo"]))):
            split_parts[part] = {name: part_of(run["points"], run["trades"], first, last)
                                 for name, run in runs.items()}
    full_parts = {name: part_of(run["points"], run["trades"], start, end) for name, run in runs.items()}

    # Claim against ours (source in-sample window; the check uses the source's costs).
    views = {}
    for name in ("source", "vertex"):
        run = runs[name]
        views[name] = {
            "sourceIs": part_of(run["points"], run["trades"], is_first, is_last),
            "sourceOos": (part_of(run["points"], run["trades"], oos_window[2], oos_window[3]) if oos_window
                          else part_of(run["points"], [], is_first, is_last)),
            "sourceIsBreakdown": breakdown(in_window(run["trades"], is_first, is_last), is_first, is_last),
        }
    claimed = views["source"]["sourceIs"]["r"]
    check = mx.replication_check(claimed["trades"], claimed["winRate"], claimed["meanR"])
    claim_rows = claim_table(views["source"], views["vertex"], check)

    # Sensitivity (one at a time) and the cost sets.
    sens_rows, sens_detail = [], []
    positive = 0
    for param, value, params in primary["sensitivity"]:
        run = booked[config_id(params)]
        s = mx.split_summary(run["points"])
        r = mx.r_stats([t["rNet"] for t in run["trades"]])
        sens_rows.append({"param": param[:60], "value": value[:40], "sharpe": s["full"]["sharpe"],
                          "cagr": max(-1.0, s["full"]["cagr"]), "maxDrawdown": s["full"]["maxDrawdown"],
                          "trades": len(run["trades"])})
        sens_detail.append({"param": param, "value": value, "sharpe": s["full"]["sharpe"], "cagr": s["full"]["cagr"],
                            "maxDrawdown": s["full"]["maxDrawdown"], "trades": len(run["trades"]),
                            "oosSharpe": s["outOfSample"]["sharpe"], "meanR": r["meanR"], "totalR": r["totalR"],
                            "winRate": r["winRate"], "maxDrawdownR": r["maxDrawdownR"]})
        positive += s["full"]["sharpe"] > 0
    neighbours = len(primary["sensitivity"])
    neighbour_share = positive / neighbours if neighbours else 0.0
    cost_rows = []
    for name in COST_SETS:
        run = runs[name]
        s = summary[name]
        r = mx.r_stats([t["rNet"] for t in run["trades"]])
        view = _cost_view(primary["costSets"][name], primary["medianCloseIs"], STOP_POINTS)
        cost_rows.append({"costs": name, "label": COST_LABEL[name], **view, "sharpe": s["full"]["sharpe"],
                          "oosSharpe": s["outOfSample"]["sharpe"], "cagr": s["full"]["cagr"],
                          "maxDrawdown": s["full"]["maxDrawdown"], "trades": r["trades"], "meanR": r["meanR"],
                          "totalR": r["totalR"], "maxDrawdownR": r["maxDrawdownR"]})
    for row in cost_rows[1:]:
        sens_rows.append({"param": "costs", "value": row["label"][:40], "sharpe": row["sharpe"],
                          "cagr": max(-1.0, row["cagr"]), "maxDrawdown": row["maxDrawdown"], "trades": row["trades"]})
    # Information only (see the spec, 'Deviations'): the Vertex spread as fixed points and at the fill minutes.
    info_rows: dict[str, dict] = {}
    info_runs: dict[str, dict] = {}
    for name, view in primary["infoCosts"].items():
        row = dict(view)
        run, run2x = row.pop("run"), row.pop("run2x")
        stats = _stat_view(run["points"])
        r = mx.r_stats([t["rNet"] for t in run["trades"]])
        row.update({
            "sharpe": stats["full"]["sharpe"], "oosSharpe": stats["outOfSample"]["sharpe"],
            "inSampleSharpe": stats["inSample"]["sharpe"], "cagr": stats["full"]["cagr"],
            "maxDrawdown": stats["full"]["maxDrawdown"], "trades": r["trades"], "meanR": r["meanR"],
            "totalR": r["totalR"], "maxDrawdownR": r["maxDrawdownR"],
            "stressSharpe": mx.stats(run2x["points"])["sharpe"],
            "windows": [{"key": wkey, "label": wlabel, **part_of(run["points"], run["trades"], first, last)}
                        for wkey, wlabel, first, last in windows],
            "splitParts": ({part: part_of(run["points"], run["trades"], first, last)
                            for part, (first, last) in (("inSample", (split["isFrom"], split["isTo"])),
                                                        ("outOfSample", (next_day(split["isTo"]), split["oosTo"])))}
                           if split is not None else {}),
        })
        info_rows[name], info_runs[name] = row, run
        sens_rows.append({"param": "costs", "value": INFO_COST_LABEL[name][:40], "sharpe": row["sharpe"],
                          "cagr": max(-1.0, row["cagr"]), "maxDrawdown": row["maxDrawdown"], "trades": row["trades"]})
    # Information only: stops filled half-way to the bar extreme (rules.py arithmetic on an R curve).
    fill = dict(primary["stopFill"])
    fill_days, fill_dated, model_dated = fill.pop("days"), fill.pop("dated"), fill.pop("datedModel")
    fill_stats = mx.split_summary(mx.r_curve(fill_days, fill_dated, runner.RISK_PCT / 100))
    model_stats = mx.split_summary(mx.r_curve(fill_days, model_dated, runner.RISK_PCT / 100))
    fill.update({
        "label": "stops filled half-way from the modelled fill to the bar extreme (information only, rules.py)",
        "sharpe": fill_stats["full"]["sharpe"], "oosSharpe": fill_stats["outOfSample"]["sharpe"],
        "cagr": fill_stats["full"]["cagr"], "maxDrawdown": fill_stats["full"]["maxDrawdown"],
        "trades": fill["r"]["vertex"]["trades"], "meanR": fill["r"]["vertex"]["meanR"],
        "meanRSourceCosts": fill["r"]["source"]["meanR"], "totalR": fill["r"]["vertex"]["totalR"],
        "sameMethodModelSharpe": model_stats["full"]["sharpe"], "nautilusModelSharpe": summary["vertex"]["full"]["sharpe"],
    })
    sens_rows.append({"param": "stop fill (information)", "value": "half-way to the bar extreme",
                      "sharpe": fill["sharpe"], "cagr": max(-1.0, fill["cagr"]), "maxDrawdown": fill["maxDrawdown"],
                      "trades": fill["trades"]})

    # Walk-forward over the grid.
    candidates = [booked[config_id(params)]["points"] for params in WALK_FORWARD_GRID]
    wf = mx.walk_forward(candidates, warmup_days=0) if len(points) > 3 else {"curve": [], "picks": []}
    has_wf = len(wf["curve"]) > 2
    wf_stats = mx.stats(wf["curve"]) if has_wf else None
    base_on_wf = mx.stats([p for p in points if p[0] >= wf["curve"][0][0]]) if has_wf else None
    picks = [dict(p, volMult=WALK_FORWARD_GRID[p["pick"]].vol_mult, k=WALK_FORWARD_GRID[p["pick"]].k,
                  stop=WALK_FORWARD_GRID[p["pick"]].stop) for p in wf["picks"]]

    # Monte Carlo, deflated Sharpe, gates.
    monte_carlo = mx.monte_carlo(mx.trade_returns(base["trades"]), paths=mx.MC_PATHS, seed=mx.MC_SEED)
    dsl = primary["dsl"]
    dsl_points = mx.window_base(dsl["points"], start, end) if dsl else []
    trial_sharpes = {cid: mx.stats(booked[cid]["points"])["sharpePerDay"] for cid in configs}
    if dsl:
        trial_sharpes["dsl"] = mx.stats(dsl_points)["sharpePerDay"]
    trials = list(trial_sharpes.values())
    per_trade = [s for s in (mx.r_stats([t["rNet"] for t in booked[cid]["trades"]])["sharpePerTrade"]
                             for cid in configs) if s is not None]
    trade_variance = mx.variance_of(per_trade)
    null_variance = 1 / (mx.CLAIM["trades"] - 1)
    deflated = {
        "own": mx.deflated(points, len(trials), trials),
        "n10000": mx.deflated(points, mx.SOURCE_TRIALS, trials),
        "n10500": mx.deflated(points, mx.SOURCE_TRIALS_WITH_CONTROLS, trials),
        "sourceCostsN10000": mx.deflated(runs["source"]["points"], mx.SOURCE_TRIALS, trials),
        "claim": {
            "ownVarianceN10000": mx.claim_deflated(mx.SOURCE_TRIALS, trade_variance),
            "ownVarianceN10500": mx.claim_deflated(mx.SOURCE_TRIALS_WITH_CONTROLS, trade_variance),
            "nullVarianceN10000": mx.claim_deflated(mx.SOURCE_TRIALS, null_variance),
            "nullVarianceN10500": mx.claim_deflated(mx.SOURCE_TRIALS_WITH_CONTROLS, null_variance),
        },
        "trialSharpesPerDay": {configs[cid][0] if cid in configs else "DSL form": value
                               for cid, value in trial_sharpes.items()},
        "trialSharpesPerTrade": per_trade, "perTradeVariance": trade_variance, "nullPerTradeVariance": null_variance,
        "configurations": [label for label, _ in configs.values()] + (["DSL form"] if dsl else []),
    }
    for name, row in info_rows.items():
        row["deflatedN10000"] = mx.deflated(info_runs[name]["points"], mx.SOURCE_TRIALS, trials)["probability"]
    gates = checks_of(summary["vertex"], deflated["n10000"], monte_carlo, neighbour_share, neighbours,
                      summary["vertex2x"]["full"], info_rows)

    # Options rows and verdict.
    option_summary = {name: mx.split_summary(item["points"]) for name, item in options.items()}
    options_oos = {name: (s["outOfSample"]["sharpe"] if s["split"] else None) for name, s in option_summary.items()}
    verdict, reason = verdict_of(gates, summary["vertex"]["outOfSample"]["sharpe"], deflated["n10000"]["probability"],
                                 check["reproduced"], options_oos, len(base["trades"]))

    # Random-entry control.
    ours = {name: {**primary["rulesR"][name]} for name in ("vertex", "source", "gross")}
    control = control_summary(primary["control"], ours, len(base["trades"]))

    # Runs tables.
    rows = []
    stated = run_row(f"{key} as stated (primary)", f"{primary['label']}, 15-point stop, Vertex costs", base, closes,
                     start, end)
    if stated:
        rows.append(stated)
    for wkey, wlabel, first, last in windows:
        row = run_row(f"{key} {wlabel}"[:40], f"{key} as stated, {first} to {last}"
                      + (" (no trades)" if not in_window(base["trades"], first, last) else ""), base, closes, first,
                      last, with_oos=False)
        if row:
            rows.append(row)
    pct = booked.get(config_id(percent_stop(AS_STATED, primary["stopFraction"])))
    if pct:
        row = run_row(f"(b) {key} percent stop", f"{primary['label']}, stop {primary['stopFraction']:.3%} of price",
                      pct, closes, start, end)
        if row:
            rows.append(row)
    def market_row(mkey: str, label: str, form: str, etf: bool, run: Mapping, buy_hold: Sequence[Point],
                   source_r: float | None, spread: Mapping, median_close: float | None, costs: rules.Costs,
                   stop: float | None, stop_text: str) -> dict:
        r = mx.r_stats([t["rNet"] for t in run["trades"]])
        s = mx.split_summary(mx.window_base(run["points"], start, end))
        bh = mx.stats(mx.window_base(buy_hold, start, end))
        inside = [p for p in run["points"] if start <= p[0] <= end]
        return {
            "market": mkey, "label": label, "form": form, "etf": etf, "stop": stop_text,
            "from": inside[0][0] if inside else None, "to": inside[-1][0] if inside else None,
            "trades": r["trades"], "winRate": r["winRate"], "rewardRisk": r["rewardRisk"], "meanR": r["meanR"],
            "totalR": r["totalR"], "maxDrawdownR": r["maxDrawdownR"], "meanRSourceCosts": source_r,
            "sharpe": s["full"]["sharpe"], "oosSharpe": s["outOfSample"]["sharpe"], "cagr": s["full"]["cagr"],
            "maxDrawdown": s["full"]["maxDrawdown"], "buyHoldSharpe": bh["sharpe"], "buyHoldCagr": bh["cagr"],
            "spreadBps": spread["bps"], "spreadPoints": spread["points"], "medianCloseIs": median_close,
            "costRoundTripR": _cost_view(costs, median_close, stop)["roundTripR"] if median_close else None,
            "maxRDiff": run["maxRDiff"],
        }

    pct_params = percent_stop(AS_STATED, primary["stopFraction"])
    pct_stop = primary["stopFraction"] * primary["medianCloseIs"]
    market_rows = [market_row(key, primary["label"], "primary", False, base, closes,
                              primary["rulesR"]["source"]["meanR"], primary["spread"], primary["medianCloseIs"],
                              primary["costSets"]["vertex"], STOP_POINTS, f"{STOP_POINTS:g} points")]
    if pct:
        pct_source = mx.r_stats([t["rGross"] - rules.SOURCE_COST_R for t in pct["trades"]])["meanR"]
        market_rows.append(market_row(key, primary["label"], "(b)", False, pct, closes, pct_source, primary["spread"],
                                      primary["medianCloseIs"], primary["costSets"]["vertex"], pct_stop,
                                      f"{pct_params.stop:.4%} of price"))
    for mkey in keys:
        if mkey not in others:
            continue
        item = others[mkey]
        symbol, label = _row_label(mkey)
        row = run_row(symbol, label, item["booked"], item["closes"], start, end)
        if row:
            rows.append(row)
        market_rows.append(market_row(
            mkey, item["label"], symbol.split(" ")[0], item["etf"], item["booked"], item["closes"],
            item["sourceCostR"]["meanR"], item["spread"], item["medianCloseIs"], item["costs"],
            primary["stopFraction"] * item["medianCloseIs"] if item["medianCloseIs"] else None,
            f"{pct_params.stop:.4%} of price"))
    # Form (b), ETF twins: results only on IBKR 5-minute bars (real exchange volume); the rest is a status list.
    etf_stats: dict[str, dict] = {}
    for mkey in etf_keys:
        item = ibkr.get(mkey) or {}
        if item.get("status") != data.ETF_TESTED:
            continue
        row = run_row(f"(b) {mkey} IBKR 5-minute", f"{mkey} ETF, IBKR 5-minute, exchange volume, percent stop",
                      item["booked"], item["closes"], start, end)
        if row:
            rows.append(row)
        table = market_row(mkey, item["label"], "(b) IBKR", True, item["booked"], item["closes"],
                           item["sourceCostR"]["meanR"], item["spread"], item["medianCloseIs"], item["costs"],
                           primary["stopFraction"] * item["medianCloseIs"] if item["medianCloseIs"] else None,
                           f"{pct_params.stop:.4%} of price")
        table["data"] = "IBKR 5-minute, exchange volume"
        market_rows.append(table)
        etf_stats[mkey] = {
            **{k: table[k] for k in ("from", "to", "trades", "winRate", "rewardRisk", "meanR", "meanRSourceCosts",
                                     "totalR", "maxDrawdownR", "sharpe", "oosSharpe", "cagr", "maxDrawdown",
                                     "buyHoldSharpe", "buyHoldCagr", "spreadBps", "costRoundTripR", "maxRDiff")},
            "spreadOrigin": item["spread"]["origin"], "bars": item["summary"], "candles": item["candles"],
            "file": item["file"], "exposure": item["booked"]["exposure"],
            "breakdown": breakdown(in_window(item["booked"]["trades"], start, end), start, end),
            "sessionSpikesByYear": item["sessionSpikesByYear"], "spikeTimes": item["spikeTimes"],
            "volumeMonths": item["volume"]["months"], "lastSessionSpike": item["volume"]["lastSessionSpike"],
            "fills": "5-minute bars (signal candles: 15 minutes, built from them)",
        }
    etf_twins = etf_twin_rows(etf_keys, ibkr, {k: v["trades"] for k, v in etf_info.items()}, etf_stats)
    for row in etf_twins:
        if row["status"] != data.ETF_TESTED and "file" not in row:
            row["file"] = (ibkr.get(row["market"]) or {}).get("file")
    dsl_row = None
    if dsl:
        dsl_view = {"points": dsl_points, "trades": dsl["trades"], "exposure": dsl["exposure"]}
        dsl_row = run_row(f"DSL form {key}", f"{key} CFD 15-minute regular session, rvol(50), 1 x ATR(14) stop",
                          dsl_view, closes, start, end)
        if dsl_row:
            rows.append(dsl_row)
    option_labels = {"c1": "c1: every exit of the rule (stop included)",
                     "c2": "c2: no 15-point stop (opposite signal, time stop)"}
    option_rows = [option_row(name, option_labels.get(name, name), item, twin_closes)
                   for name, item in options.items() if len(item["points"]) >= 3]

    # Comparison.
    bh_full = mx.stats(mx.window_base(closes, start, end))
    comparison = []

    def compare(name: str, kind: str, s: Mapping) -> None:
        comparison.append({"name": name[:80].strip(), "kind": kind, "sharpe": s["sharpe"], "cagr": max(-1.0, s["cagr"]),
                           "maxDrawdown": s["maxDrawdown"]})

    for name in COST_SETS:
        compare(f"{key} as stated, {COST_LABEL[name]}", "strategy", summary[name]["full"])
    if pct:
        compare(f"{key} with the percent stop, Vertex costs", "strategy", mx.stats(pct["points"]))
    if dsl:
        compare(f"DSL form on {key} (15-minute regular session)", "strategy", mx.stats(dsl_points))
    for name, item in options.items():
        compare(f"Options form {name}: QQQ debit verticals, 2 % max loss", "strategy", mx.stats(item["points"]))
    if has_wf:
        compare("Walk-forward (3 y train, 1 y test) on the grid", "strategy", wf_stats)
    compare(f"Buy and hold {key} CFD (same window)", "buy-and-hold", bh_full)
    if twin_closes:
        compare("Buy and hold QQQ (same window)", "buy-and-hold", mx.stats(mx.window_base(twin_closes, start, end)))
    for group, members in (("Core 7 futures proxies", data.CORE7_PROXIES),):
        curves = []
        holds = []
        for mkey in members:
            item = primary if mkey == key else others.get(mkey)
            if item is None:
                continue
            curve = (pct or base)["points"] if mkey == key else item["booked"]["points"]
            curves.append(mx.window_base(curve, start, end))
            holds.append(mx.window_base(item["closes"], start, end))
        if len(curves) > 1 and all(len(c) > 2 for c in curves) and all(len(h) > 2 for h in holds):
            compare(f"Rule equal-weight, {group} (percent stop)", "strategy", mx.stats(mx.combine(curves)))
            compare(f"Buy and hold equal-weight, {group}", "buy-and-hold", mx.stats(mx.combine(holds)))

    commit = subprocess.run(["git", "-C", str(repo), "rev-parse", "HEAD"], check=False, capture_output=True,
                            text=True).stdout.strip()
    data_hash, file_hashes = data.data_hash(root)
    provenance = {"commit": commit[:40] or "0000000", "engine": base["engine"], "dataHash": data_hash[:80],
                  "runId": f"volspike-{ran}"}
    spreads = {key: {"allBars": primary["spread"], "signalSession": primary["spreadSession"],
                     "atFillMinutes": primary["spreadAtFills"]}}
    dukascopy = {**others, **etf_info}  # every Dukascopy market but the primary (the ETF-CFD twins: information)
    for mkey, item in dukascopy.items():
        spreads[mkey] = {"allBars": item["spread"], "signalSession": item["spreadSession"]}
    volume = {key: primary["volume"], **{mkey: item["volume"] for mkey, item in dukascopy.items()}}
    is_bh = mx.stats(mx.window_base(closes, is_first, is_last))
    detail = {
        "kind": "volume-spike-breakout-report-data", "ran": ran, "provenance": provenance,
        "config": {"capital": runner.CAPITAL, "riskPct": runner.RISK_PCT, "stopPoints": STOP_POINTS,
                   "stopFraction": primary["stopFraction"], "medianCloseSourceIs": primary["medianCloseIs"],
                   "slippageBps": runner.SLIPPAGE_BPS, "isFraction": mx.IS_FRACTION, "gate": GATE,
                   "minTrades": MIN_TRADES, "controlRuns": controls, "workers": workers, "start": start, "end": end,
                   "windows": [{"key": k, "label": lab, "from": a, "to": b} for k, lab, a, b in windows],
                   "params": asdict(AS_STATED), "monteCarlo": {"paths": mx.MC_PATHS, "seed": mx.MC_SEED},
                   "controlSeed": mx.CONTROL_SEED},
        "verdict": verdict, "verdictReason": reason,
        "gates": [{"name": g["check"], "value": g["value"], "threshold": g["threshold"], "pass": g["pass"],
                   "result": g["result"]} for g in gates],
        "gatesPassed": sum(1 for g in gates if g["pass"]),
        "primary": {
            "market": key, "label": primary["label"], "from": start, "to": end,
            "summary": summary, "full": full_parts, "windows": window_parts, "split": split, "splitParts": split_parts,
            "exposure": base["exposure"], "breakdown": {name: breakdown(run["trades"], start, end)
                                                        for name, run in runs.items()},
            "byYear": by_year(runs),
            "weeklyR": {name: {"full": weekly(run["trades"], start, end),
                               **{wkey: weekly(run["trades"], first, last) for wkey, _, first, last in windows}}
                        for name, run in runs.items()},
            "equityDaily": [[d, v] for d, v in points],
            "booking": {"maxRDiffNautilusVsRules": max(b["maxRDiff"] for b in booked.values()),
                        "runs": len(booked), "barsFedToNautilus": {name: run["bars"] for name, run in runs.items()},
                        "oneMinuteBarsInWindow": primary["windowBars"], "rulesR": primary["rulesR"]},
        },
        "claim": {"claim": mx.CLAIM, "tolerance": mx.TOLERANCE, "check": check, "rows": claim_rows,
                  "window": {"from": is_first, "to": is_last}},
        "sensitivity": sens_detail, "neighbourShare": neighbour_share, "costs": cost_rows,
        "costsInfo": {**info_rows, "spreadByYear": primary["spreadByYear"]}, "stopFill": fill,
        "walkForward": {"stats": wf_stats, "baseSameWindow": base_on_wf, "picks": picks,
                        "curve": [[d, v] for d, v in wf["curve"]],
                        "grid": [{"volMult": p.vol_mult, "k": p.k, "stop": p.stop,
                                  **mx.split_summary(c)["full"], "oosSharpe": mx.split_summary(c)["outOfSample"]["sharpe"]}
                                 for p, c in zip(WALK_FORWARD_GRID, candidates)]},
        "monteCarlo": {**monte_carlo, "seed": mx.MC_SEED,
                       "tradeReturnQuantiles": mx.quantiles(mx.trade_returns(base["trades"]))},
        "randomControl": {**control, "runsDetail": primary["control"],
                          "design": "random signal candles of the same session and weekdays, random direction, the "
                                    "same stop, time stop, entry limit and opposite-signal exits; rules.py, not Nautilus"},
        "deflatedSharpe": deflated,
        "markets": market_rows,
        "etfTwins": etf_twins,
        "options": {name: {k: v for k, v in item.items() if k not in ("points", "returns")}
                    | {"summary": option_summary[name], "equityDaily": [[d, v] for d, v in item["points"]],
                       "monteCarlo": mx.monte_carlo(item["returns"], paths=mx.MC_PATHS, seed=mx.MC_SEED)}
                    for name, item in options.items()},
        "optionsOosSharpe": options_oos,
        "dsl": ({"definition": {side: dsl_definition(side) for side in SIDES}, "timeframe": DSL_TIMEFRAME,
                 "missingParts": list(MISSING_DSL_PARTS), "summary": mx.split_summary(dsl_points),
                 **mx.trade_summary(in_window(dsl["trades"], start, end)), "exposure": dsl["exposure"],
                 "barsFed": dsl["barsFed"], "tradesBeforeWindow": len([t for t in dsl["trades"]
                                                                       if t["entryDate"] < start]),
                 "tradeDates": [t["entryDate"] for t in dsl["trades"]][:200]} if dsl else None),
        "buyHold": {"market": key, "full": bh_full, "sourceIs": is_bh,
                    "qqq": mx.stats(mx.window_base(twin_closes, start, end)) if twin_closes else None},
        "data": {
            "hash": data_hash, "files": file_hashes,
            "markets": {key: primary["summary"], **{mkey: item["summary"] for mkey, item in dukascopy.items()}},
            "candles": {key: primary["candles"], **{mkey: item["candles"] for mkey, item in dukascopy.items()}},
            "splitsAdjusted": {mkey: item["splits"] for mkey, item in dukascopy.items() if item["splits"]},
            "ibkr": {mkey: {"status": item["status"], "reason": item.get("reason"), "file": item.get("file"),
                            "barsUsed": item.get("summary"), "spread": item.get("spread")}
                     for mkey, item in ibkr.items()},
            "spreads": spreads, "medianCloseByYear": primary["medianCloseByYear"], "volume": volume,
            "spikeTimes": {key: primary["spikeTimes"],
                           **{mkey: item["spikeTimes"] for mkey, item in dukascopy.items()}},
            "missingMarkets": list(missing),
        },
        "document": {"rows": rows, "optionRows": option_rows, "sensitivity": sens_rows, "comparison": comparison,
                     "equity": mx.monthly(points) if len(points) > 1 else [],
                     "walkForward": {"stats": wf_stats, "base": base_on_wf}},
    }
    return detail


# ------------------------------------------------------------------------------------------------
# Document


def robustness_of(detail: Mapping) -> list[dict]:
    """The robustness rows: the five gates, the replication check, the options form and the informational rows."""
    p = detail["primary"]
    key = p["market"]
    rows = [{"check": g["name"], "result": g["result"], "pass": g["pass"]} for g in detail["gates"]]
    check = detail["claim"]["check"]
    parts = {part["metric"]: part for part in check["parts"]}
    rows.append({
        "check": "Replication of the source's claim (its window and costs)", "pass": check["reproduced"],
        "result": (f"Trades {parts['trades']['ours']} vs 657 (within 25 %: {'yes' if parts['trades']['pass'] else 'no'}); "
                   f"win rate {_fmt(parts['winRate']['ours'], '.1%')} vs 14 % (within 5 points: "
                   f"{'yes' if parts['winRate']['pass'] else 'no'}); net {_fmt(parts['netR']['ours'], '+.3f')}R vs "
                   f"+0.457R per trade (within 0.15R: {'yes' if parts['netR']['pass'] else 'no'})")})
    oos = detail["optionsOosSharpe"]
    rows.append({
        "check": "Options form OOS Sharpe (QQQ debit verticals, c1 or c2)",
        "pass": any(v is not None and v > 0 for v in oos.values()),
        "result": "; ".join(f"{name} OOS Sharpe {_fmt(value)}, full "
                            f"{_fmt(detail['options'][name]['summary']['full']['sharpe'])}, "
                            f"{detail['options'][name]['booked']} spreads" for name, value in oos.items())
                  or "no spread could be priced"})
    for window in p["windows"]:
        v, s = window["vertex"], window["source"]
        text = (f"no trades from {window['from']} to {window['to']}" if v["noTrades"] else
                f"{v['r']['trades']} trades; net {_fmt(v['r']['meanR'], '+.3f')}R per trade and Sharpe {v['sharpe']:.2f} "
                f"with Vertex costs; {_fmt(s['r']['meanR'], '+.3f')}R and Sharpe {s['sharpe']:.2f} with the source's costs")
        rows.append({"check": f"{window['label']} ({window['from']} to {window['to']})"[:80], "pass": None,
                     "result": text})
    costs = {row["costs"]: row for row in detail["costs"]}
    rows.append({
        "check": "Source costs vs Vertex costs vs doubled Vertex costs", "pass": None,
        "result": "; ".join(f"{COST_LABEL[name]} ({_fmt(costs[name]['roundTripR'], '.3f')}R a round trip): "
                            f"{_fmt(costs[name]['meanR'], '+.3f')}R per trade, Sharpe {costs[name]['sharpe']:.2f}"
                            for name in COST_SETS if name in costs) + ". Cost in R at the median in-sample price"})
    wf = detail["walkForward"]
    rows.append({
        "check": "Walk-forward (3 years train, 1 year test, 18 grid points)", "pass": None,
        "result": (f"stitched Sharpe {wf['stats']['sharpe']:.2f} vs the stated rule {wf['baseSameWindow']['sharpe']:.2f} "
                   f"on the same years ({len(wf['picks'])} test years)") if wf["stats"] else "window too short"})
    d = detail["deflatedSharpe"]
    rows.append({"check": "Deflated Sharpe, own trial count and N = 10,500 trials", "pass": None,
                 "result": f"{d['own']['probability']:.3f} over the {d['own']['trials']} distinct configurations this "
                           f"study ran on {key}; {d['n10500']['probability']:.3f} with N = 10,500 (10,000 strategies plus "
                           f"the source's 500 random controls); with the source's costs and N = 10,000: "
                           f"{d['sourceCostsN10000']['probability']:.3f}"})
    twins = detail.get("etfTwins", [])
    tested = [t for t in twins if t["status"] == data.ETF_TESTED]
    untested = [t["market"] for t in twins if t["status"] != data.ETF_TESTED]
    rows.append({
        "check": "Form (b) ETF twins: IBKR 5-minute bars, exchange volume", "pass": None,
        "result": ("; ".join(f"{t['market']} {t['trades']} trades, {_fmt(t['meanR'], '+.2f')}R per trade, Sharpe "
                             f"{_fmt(t['sharpe'])}" for t in tested) or "no twin has IBKR history")
                  + (f". Not testable on this data (no exchange-volume intraday history): {', '.join(untested)}"
                     if untested else "")})
    claim = d["claim"]
    rows.append({
        "check": "Deflated Sharpe of the source's claimed result", "pass": None,
        "result": (f"{claim['ownVarianceN10000']['probability']:.3f} with N = 10,000 and the trial variance of our "
                   f"configurations; {claim['nullVarianceN10000']['probability']:.3f} with the variance of unskilled "
                   f"657-trade strategies (per-trade Sharpe {claim['ownVarianceN10000']['sharpePerTrade']:.3f}, "
                   f"t = {claim['ownVarianceN10000']['tStatistic']:.2f})")})
    mc = detail["monteCarlo"]
    control = detail["randomControl"]
    cv, cs, cg = control.get("vertex", {}), control.get("source", {}), control.get("gross", {})
    rows.append({
        "check": f"Random-entry control ({control['runs']} runs)"[:80], "pass": None,
        "result": (f"random entries average {_fmt(cg.get('meanOfMeanR'), '+.3f')}R gross, "
                   f"{_fmt(cs.get('meanOfMeanR'), '+.3f')}R with the source's costs, "
                   f"{_fmt(cv.get('meanOfMeanR'), '+.3f')}R with Vertex costs per trade; "
                   f"{_fmt(cv.get('shareAtOrAboveOursMeanR'), '.1%')} of runs at or above the rule (Vertex costs), "
                   f"{_fmt(cs.get('shareAtOrAboveOursMeanR'), '.1%')} (source costs); "
                   f"{control.get('runsShort', 0)} runs short of {control['entriesWanted']} entries")})
    dsl = detail["dsl"]
    rows.append({
        "check": "DSL form (nearest definition the DSL can state)", "pass": None,
        "result": ((f"Sharpe {dsl['summary']['full']['sharpe']:.2f}, OOS {dsl['summary']['outOfSample']['sharpe']:.2f}, "
                    f"{dsl['trades']} trades" if dsl["trades"] else
                    "no trades in the window: session volume never reaches 3 x its 50-session mean on a 5-bar "
                    "breakout between 09:45 and 12:00")
                   + "; seven parts of the rule are missing in the DSL") if dsl else "not run"})
    bh = detail["buyHold"]
    rows.append({"check": f"Buy and hold {key} CFD, same window", "pass": None,
                 "result": f"Sharpe {bh['full']['sharpe']:.2f}, CAGR {bh['full']['cagr']:.1%}, max drawdown "
                           f"{bh['full']['maxDrawdown']:.1%}"})
    volume = detail["data"]["volume"].get(key, {})
    rows.append({
        "check": "Data finding: Dukascopy tick volume regime", "pass": None,
        "result": (f"the last candle of the signal session that passes the 3x volume test is on "
                   f"{volume.get('lastSessionSpike') or 'no day'}; none in the "
                   f"{volume.get('sessionDaysAfterLastSessionSpike', 0)} trading days after it to "
                   f"{volume.get('lastDay') or 'the end'} (the intraday volume profile of the feed changes), so the "
                   "rule has no signal there")})
    rows.append({
        "check": "Nautilus booking against rules.py", "pass": None,
        "result": f"{p['booking']['runs']} runs; the same trades in both; largest difference "
                  f"{p['booking']['maxRDiffNautilusVsRules']:.1e} R per trade; Monte Carlo P50 max drawdown "
                  f"{_fmt(mc.get('maxDrawdownP50'), '.1%')}"})
    if len(rows) > ROBUSTNESS_MAX:
        raise ValueError(f"{len(rows)} robustness rows do not fit the contract's {ROBUSTNESS_MAX}: merge rows, do not "
                         "drop them")
    return [{"check": row["check"][:80].strip(), "result": row["result"][:300].strip(), "pass": row["pass"]}
            for row in rows]


def notes(detail: Mapping) -> str:
    p = detail["primary"]
    key = p["market"]
    full = p["full"]
    config = detail["config"]
    split = p["split"]
    lines = [
        f"Primary {key} {p['from']} to {p['to']} with Vertex costs: Sharpe {full['vertex']['sharpe']:.2f}, CAGR "
        f"{full['vertex']['cagr']:.1%}, max drawdown {full['vertex']['maxDrawdown']:.1%}, {full['vertex']['trades']} "
        f"trades, {_fmt(full['vertex']['r']['meanR'], '+.3f')}R net per trade ({_fmt(full['vertex']['grossR'], '+.3f')}R "
        f"gross); with the source's costs {_fmt(full['source']['r']['meanR'], '+.3f')}R and Sharpe "
        f"{full['source']['sharpe']:.2f}."
        + (f" 60/40 split: in-sample to {split['isTo']}, out-of-sample after." if split else ""),
        "Booking: rules.py decides the trades on 1-minute mid bars; Nautilus replays them (one run per side from "
        "100,000 USD, daily returns summed) on the 1-minute bars each trade needs, not on every bar; trade count, "
        "fill bars and prices must agree or the run stops.",
        "Costs are charged as commission next to the fill, so they do not move the entry or the 15-point stop and "
        "every cost set has the same trades. Vertex costs: half the median quoted spread of all 1-minute bars of "
        f"the source's in-sample window per side, as basis points of the price, plus {config['slippageBps']} bp "
        "slippage per side. No financing cost. Information rows, not gates: the same median as fixed points (Sharpe "
        f"{detail['costsInfo']['fixedPointsSpread']['sharpe']:.2f}, OOS "
        f"{detail['costsInfo']['fixedPointsSpread']['oosSharpe']:.2f}); the median spread at the fill minutes (Sharpe "
        f"{detail['costsInfo']['fillMinuteSpread']['sharpe']:.2f}, OOS "
        f"{detail['costsInfo']['fillMinuteSpread']['oosSharpe']:.2f}); stops filled half-way to the bar extreme "
        f"(Sharpe {detail['stopFill']['sharpe']:.2f}, {_fmt(detail['stopFill']['meanR'], '+.3f')}R per trade).",
        f"Size: {config['riskPct']} % of equity at the stop per trade; R = P&L over that risk. The percent stop of the "
        f"other markets is {config['stopFraction']:.4%} of price (15 points over the median NAS100 close "
        f"{config['medianCloseSourceIs']:,.0f}).",
        "The out-of-sample gate uses the last 40 % of the time. The replication check uses the source's in-sample "
        "window and costs. The deflated Sharpe trial variance is the spread of the per-day Sharpe ratios of our own "
        "configurations (the stated rule, the one-at-a-time changes, the walk-forward grid, the DSL form).",
        "Random-entry control: random signal candles of the same session and weekdays, random direction, the same "
        "stop, time stop, entry limit and opposite-signal exits; run in rules.py (R per trade), not in Nautilus.",
        "Options are priced with Black-Scholes on the previous close of VXN with a fixed smile; there are no "
        "intraday option quotes here, so form (c) is a model, not a replay.",
        "Dukascopy volume is one broker's tick volume. Its intraday profile changes in 2026 (see the data finding "
        "row); the rule was not changed because of it.",
        "ETF twins: the Dukascopy ETF-CFD files hold regular-hours tick volume only, so the volume test is no test "
        "there. Twins with IBKR 5-minute TRADES bars (real exchange volume) are run on those: 15-minute candles from "
        "the 5-minute bars, fills and stop on the 5-minute bars, the same percent stop and ETF costs. "
        + "; ".join(f"{t['market']}: {'tested on IBKR' if t['status'] == data.ETF_TESTED else 'not testable'}"
                    f" (Dukascopy tick-volume trades: {t['dukascopyTrades'] if t['dukascopyTrades'] is not None else 'n/a'})"
                    for t in detail.get("etfTwins", [])) + ".",
        f"Markets: {', '.join(dict.fromkeys([key, *[row['market'] for row in detail['markets']]]))}."
        + (f" Missing data: {', '.join(detail['data']['missingMarkets'])}." if detail["data"]["missingMarkets"] else ""),
        "Weekly equity in R, expectancy by year, the control distribution, per-market tables and the volume and "
        "spread diagnostics: the report data of the run (outside the repository).",
    ]
    return "\n".join(lines)[:4000]


def document(ran: str, detail: Mapping) -> dict:
    """The `strategy-backtest` research study document of the run."""
    parts = detail["document"]
    key = detail["primary"]["market"]
    equity = list(parts["equity"])[-400:]
    return {
        "kind": "strategy-backtest",
        "id": SLUG,
        "title": TITLE,
        "ran": ran,
        "spec": SPEC_PATH,
        "source": {"url": SOURCE_URL, "label": SOURCE_LABEL},
        "verdict": detail["verdict"],
        "verdictReason": detail["verdictReason"][:1000].strip(),
        "rules": RULES,
        "gaps": GAPS,
        "forms": [
            {"key": "underlying",
             "label": "As stated on NAS100 (primary), forms (a) and (b) on the other markets, and the DSL form",
             "description": ("Dukascopy 1-minute bid/ask mid bars, full session; 15-minute signal candles on the New "
                             "York clock; rules.py trades booked by Nautilus, long and short legs summed; 0.5 % of "
                             "equity at risk per trade; Vertex costs (half the median in-sample spread + 0.25 bp "
                             "slippage per side). Other markets use the 15-point stop as a percent of price. ETF twins: "
                             "IBKR 5-minute bars with exchange volume, fills on 5-minute bars, IBKR Pro Fixed fees; twins "
                             "without such history are not testable. OOS = last 40 % of the time."),
             "runs": parts["rows"][:80]},
            {"key": "options",
             "label": "Vertex form (c): QQQ debit verticals on the NAS100 signals, 2 % max loss",
             "description": ("Each NAS100 signal opens a call (long) or put (short) debit vertical on QQQ at the first "
                             "regular minute at or after the entry: long 0.50 delta, short 1 sigma away, nearest Friday "
                             "weekly with >= 2 trading days left; closed at the first regular minute at or after the "
                             "rule's exit. Black-Scholes on the previous VXN close; 0.65 USD per contract + half the "
                             "spread per leg; Nautilus with a ledger cross-check."),
             "runs": parts["optionRows"][:80] or [_empty_option_row()]},
        ],
        "robustness": robustness_of(detail),
        "sensitivity": parts["sensitivity"][:80],
        "comparison": parts["comparison"][:30],
        "equity": equity,
        "equityLabel": f"Volume spike breakout as stated on the {key} CFD, long and short legs summed, Vertex costs",
        "provenance": detail["provenance"],
        "notes": notes(detail),
    }


# ------------------------------------------------------------------------------------------------
# Contract check (a Python mirror of packages/api/src/contracts/research-studies.ts)

_RUN_KEYS = {"buyHoldCagr", "buyHoldSharpe", "cagr", "exposure", "from", "market", "maxDrawdown", "oosCagr",
             "oosSharpe", "profitFactor", "sharpe", "symbol", "to", "trades", "winRate"}
_DOC_KEYS = {"comparison", "equity", "equityLabel", "forms", "gaps", "id", "kind", "notes", "provenance", "ran",
             "robustness", "rules", "sensitivity", "source", "spec", "title", "verdict", "verdictReason"}
IMPORT_CAP_BYTES = 256 * 1024


def _is_date(text: Any) -> bool:
    try:
        return isinstance(text, str) and len(text) == 10 and date.fromisoformat(text).isoformat() == text
    except ValueError:
        return False


def validate_document(doc: Mapping) -> list[str]:
    """Problems of a strategy-backtest study document against the contract limits; empty when it fits."""
    import re

    problems: list[str] = []

    def number(value: Any, where: str, low: float | None = None, high: float | None = None, *,
               nullable: bool = False) -> None:
        if value is None and nullable:
            return
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
            problems.append(f"{where}: not a finite number")
        elif (low is not None and value < low) or (high is not None and value > high):
            problems.append(f"{where}: {value} outside [{low}, {high}]")

    def text(value: Any, where: str, limit: int) -> None:
        if not isinstance(value, str) or not value or value.strip() != value or len(value) > limit:
            problems.append(f"{where}: needs 1 to {limit} characters without outer whitespace")

    def keys(item: Any, expected: set[str], where: str) -> bool:
        if not isinstance(item, Mapping) or set(item) != expected:
            problems.append(f"{where}: keys {sorted(item) if isinstance(item, Mapping) else item} != {sorted(expected)}")
            return False
        return True

    if not keys(doc, _DOC_KEYS, "document"):
        return problems
    if doc["kind"] != "strategy-backtest":
        problems.append("kind: must be strategy-backtest")
    match = re.fullmatch(r"docs/specs/strategies/([a-z0-9-]+)\.md", str(doc["spec"]))
    if match is None or len(doc["spec"]) > 300 or match.group(1) != doc["id"]:
        problems.append("spec/id: the spec path must be docs/specs/strategies/<id>.md")
    if not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", str(doc["id"])) or len(doc["id"]) > 64:
        problems.append("id: not a lowercase slug of at most 64 characters")
    if not _is_date(doc["ran"]):
        problems.append("ran: not a calendar date")
    text(doc["title"], "title", 200)
    text(doc["equityLabel"], "equityLabel", 200)
    text(doc["verdictReason"], "verdictReason", 1000)
    if doc["verdict"] not in ("edge", "no-edge", "needs-more-data"):
        problems.append("verdict: unknown value")
    if not isinstance(doc["notes"], str) or len(doc["notes"]) > 4000:
        problems.append("notes: more than 4000 characters")
    if keys(doc["source"], {"label", "url"}, "source"):
        text(doc["source"]["label"], "source.label", 200)
        if not str(doc["source"]["url"]).startswith("https://") or len(doc["source"]["url"]) > 300:
            problems.append("source.url: needs an https URL of at most 300 characters")
    if keys(doc["provenance"], {"commit", "dataHash", "engine", "runId"}, "provenance"):
        if not re.fullmatch(r"[0-9a-f]{7,40}", str(doc["provenance"]["commit"])):
            problems.append("provenance.commit: needs 7 to 40 lowercase hex characters")
        for name in ("dataHash", "engine", "runId"):
            text(doc["provenance"][name], f"provenance.{name}", 80)
    if not 1 <= len(doc["rules"]) <= 30:
        problems.append("rules: needs 1 to 30 rows")
    for i, rule in enumerate(doc["rules"]):
        if keys(rule, {"item", "rule", "source"}, f"rules[{i}]"):
            text(rule["item"], f"rules[{i}].item", 60)
            text(rule["rule"], f"rules[{i}].rule", 400)
            text(rule["source"], f"rules[{i}].source", 200)
    if len(doc["gaps"]) > 30:
        problems.append("gaps: more than 30 rows")
    for i, gap in enumerate(doc["gaps"]):
        if keys(gap, {"choice", "gap"}, f"gaps[{i}]"):
            text(gap["gap"], f"gaps[{i}].gap", 300)
            text(gap["choice"], f"gaps[{i}].choice", 400)
    forms = doc["forms"]
    if not 1 <= len(forms) <= 4 or len({form.get("key") for form in forms}) != len(forms):
        problems.append("forms: needs 1 to 4 forms with distinct keys")
    for f, form in enumerate(forms):
        if not keys(form, {"description", "key", "label", "runs"}, f"forms[{f}]"):
            continue
        if form["key"] not in ("underlying", "options"):
            problems.append(f"forms[{f}].key: must be underlying or options")
        text(form["label"], f"forms[{f}].label", 120)
        text(form["description"], f"forms[{f}].description", 600)
        if not 1 <= len(form["runs"]) <= 80:
            problems.append(f"forms[{f}].runs: needs 1 to 80 runs")
        for r, run in enumerate(form["runs"]):
            where = f"forms[{f}].runs[{r}]"
            if not keys(run, _RUN_KEYS, where):
                continue
            text(run["symbol"], f"{where}.symbol", 40)
            text(run["market"], f"{where}.market", 60)
            if not (_is_date(run["from"]) and _is_date(run["to"]) and run["from"] <= run["to"]):
                problems.append(f"{where}: from/to are not ordered calendar dates")
            if isinstance(run["trades"], bool) or not isinstance(run["trades"], int) or run["trades"] < 0:
                problems.append(f"{where}.trades: not a whole number >= 0")
            number(run["cagr"], f"{where}.cagr", -1)
            number(run["sharpe"], f"{where}.sharpe")
            number(run["maxDrawdown"], f"{where}.maxDrawdown", -1, 0)
            number(run["profitFactor"], f"{where}.profitFactor", 0, nullable=True)
            number(run["winRate"], f"{where}.winRate", 0, 1)
            number(run["exposure"], f"{where}.exposure", 0, 1)
            number(run["oosSharpe"], f"{where}.oosSharpe", nullable=True)
            number(run["oosCagr"], f"{where}.oosCagr", -1, nullable=True)
            number(run["buyHoldCagr"], f"{where}.buyHoldCagr", -1, nullable=True)
            number(run["buyHoldSharpe"], f"{where}.buyHoldSharpe", nullable=True)
    if len(doc["robustness"]) > 20:
        problems.append("robustness: more than 20 rows")
    for i, row in enumerate(doc["robustness"]):
        if keys(row, {"check", "pass", "result"}, f"robustness[{i}]"):
            text(row["check"], f"robustness[{i}].check", 80)
            text(row["result"], f"robustness[{i}].result", 300)
            if row["pass"] not in (True, False, None):
                problems.append(f"robustness[{i}].pass: must be true, false or null")
    if len(doc["sensitivity"]) > 80:
        problems.append("sensitivity: more than 80 rows")
    for i, row in enumerate(doc["sensitivity"]):
        if keys(row, {"cagr", "maxDrawdown", "param", "sharpe", "trades", "value"}, f"sensitivity[{i}]"):
            text(row["param"], f"sensitivity[{i}].param", 60)
            text(row["value"], f"sensitivity[{i}].value", 40)
            number(row["cagr"], f"sensitivity[{i}].cagr", -1)
            number(row["sharpe"], f"sensitivity[{i}].sharpe")
            number(row["maxDrawdown"], f"sensitivity[{i}].maxDrawdown", -1, 0)
            if isinstance(row["trades"], bool) or not isinstance(row["trades"], int) or row["trades"] < 0:
                problems.append(f"sensitivity[{i}].trades: not a whole number >= 0")
    if len(doc["comparison"]) > 30:
        problems.append("comparison: more than 30 rows")
    for i, row in enumerate(doc["comparison"]):
        if keys(row, {"cagr", "kind", "maxDrawdown", "name", "sharpe"}, f"comparison[{i}]"):
            text(row["name"], f"comparison[{i}].name", 80)
            if row["kind"] not in ("buy-and-hold", "library", "strategy"):
                problems.append(f"comparison[{i}].kind: unknown value")
            number(row["cagr"], f"comparison[{i}].cagr", -1)
            number(row["sharpe"], f"comparison[{i}].sharpe")
            number(row["maxDrawdown"], f"comparison[{i}].maxDrawdown", -1, 0)
    equity = doc["equity"]
    if not 2 <= len(equity) <= 400:
        problems.append("equity: needs 2 to 400 monthly points")
    previous = ""
    for i, point in enumerate(equity):
        if not keys(point, {"drawdown", "month", "value"}, f"equity[{i}]"):
            continue
        if not re.fullmatch(r"\d{4}-(?:0[1-9]|1[0-2])", str(point["month"])) or point["month"] <= previous:
            problems.append(f"equity[{i}].month: not an increasing YYYY-MM month")
        previous = str(point["month"])
        number(point["value"], f"equity[{i}].value", -1)
        number(point["drawdown"], f"equity[{i}].drawdown", -1, 0)
    size = len(json.dumps(doc, allow_nan=True).encode())
    if size > IMPORT_CAP_BYTES:
        problems.append(f"document: {size} bytes is over the import cap of {IMPORT_CAP_BYTES}")
    return problems


# ------------------------------------------------------------------------------------------------
# Commands


def main_study(ran: str, workers: int = DEFAULT_WORKERS) -> int:
    doc, _ = run_study(ran, workers=workers)
    print(json.dumps(finite(doc, log=_log), allow_nan=False))
    return 0


def main_report(ran: str, out: Path, workers: int = DEFAULT_WORKERS) -> int:
    """Runs the study and writes the report data and the exact study document (REPORT_FILE, STUDY_FILE) to `out`,
    a folder outside the repository. They are report artifacts; the app never reads them."""
    out = out.expanduser()
    out.mkdir(parents=True, exist_ok=True)
    doc, detail = run_study(ran, workers=workers)
    for name, value in ((STUDY_FILE, finite(doc, log=_log)), (REPORT_FILE, finite(detail))):
        tmp = out / (name + ".tmp")
        tmp.write_text(json.dumps(value, allow_nan=False))
        tmp.replace(out / name)
    _log(f"verdict: {detail['verdict']} ({detail['gatesPassed']}/5 gates); wrote {out / STUDY_FILE} and "
         f"{out / REPORT_FILE} in {detail['runtimeSeconds']} s")
    return 0


__all__ = ["CONTROL_RUNS", "DEFAULT_WORKERS", "GATE", "MIN_TRADES", "SLUG", "SPEC_PATH", "WINDOWS", "assemble",
           "checks_of", "claim_table", "config_id", "control_runs", "control_summary", "document", "finite",
           "main_report", "main_study", "part_of", "robustness_of", "run_row", "run_study", "validate_document",
           "verdict_of", "verdict_rule"]
