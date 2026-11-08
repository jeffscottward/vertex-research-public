"""Runs the 32 pre-registered qc-port runs and builds one study document per idea (research only).

    python -m strategies.qc_ports study --ran 2026-11-08 [--no-nautilus] [--report]

Pipeline per run (ideas.RunSpec): each leg's DSL definition is compiled by
nautilus_backtest/signals.py on the leg's bars with the series context (data
files plus the derived `qc:` series of ideas.py), the leg policy turns signal
bars into SignalEvents, book.py prices them, ledger.py books them on the SPY
trading days from the run start to the last bar, and nautilus_runner.py books
them again; a run is accepted only when both agree on every trade and on daily
equity (1e-6 relative). Metrics use n_trials = 32 and the measured variance of
the per-day Sharpe ratio across the 32 counted runs.

Output: JSON lines on stdout, one `kind: "qc-port"` document per idea (the
ResearchStudyDocumentSchema of packages/api, for `bun run
vertex:research-studies:import`); --report prints the markdown Results of each
spec instead. Nothing is written to files.

Approximation: "one open spread per member" is decided from the priced book
(book.py exits). A spread that the ledger refuses for size (0 contracts) still
holds its member until its priced exit; such refusals are counted in `skipped`.
"""
from __future__ import annotations

import dataclasses
import hashlib
import json
import math
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import date
from statistics import median, stdev, variance

from nautilus_backtest import signals as sig
from nautilus_backtest.bars import Bars as DslBars

from . import ideas as qi
from .book import PricedTrade, SignalEvent, build_book
from .data import Bars, Market, align, data_root, load_bars, load_context, load_market
from .ledger import LedgerResult, run_ledger
from .metrics import TRADING_DAYS, max_drawdown, summarize

__all__ = [
    "N_TRIALS", "Outcome", "StudyData", "compile_signals", "documents", "dsl_bars", "equity_points", "leg_trades",
    "load_study_data", "quintile_table", "run_family", "verdict", "vix_percentile", "window_stats",
]

N_TRIALS = 32
EQUITY_POINTS_MAX = 400
NOTES_MAX = 4000
DOC_MAX_BYTES = 200 * 1024
PARITY_REL_TOL = 1e-6
DAY_MS = 86_400_000
EPOCH = date(1970, 1, 1)
PASS_SHARPE = 0.5
PASS_DEFLATED = 0.9
PASS_DRAWDOWN = -0.25
# The pass rule of the 11 specs, stored with each document (QcPortCriteriaSchema; all bounds strict).
CRITERIA = {"minSharpe": PASS_SHARPE, "minDeflatedSharpe": PASS_DEFLATED, "maxDrawdown": -PASS_DRAWDOWN,
            "beatBaseline": True}


# --------------------------------------------------------------------------- DSL compile

def dsl_bars(dates: Sequence[str], open_: Sequence[float], high: Sequence[float], low: Sequence[float],
             close: Sequence[float]) -> DslBars:
    """Daily bars for signals.py: t = UTC midnight of each date in epoch ms."""
    t = tuple(float((date.fromisoformat(day) - EPOCH).days * DAY_MS) for day in dates)
    return DslBars(t=t, o=tuple(open_), h=tuple(high), l=tuple(low), c=tuple(close))


def compile_signals(bars: DslBars, definition: Mapping, context: Mapping[str, Mapping[str, float]],
                    symbol: str) -> tuple[list[bool], list[bool]]:
    """(entry, exit) per bar of the definition, compiled by signals.compile_strategy.

    `series` filters on derived ids (ideas.DERIVED_PREFIX) are not in the product DSL enum: they are
    evaluated by the DSL's own series evaluator (signals._series_mask, the code of a native `series`
    filter) on the derived context and ANDed into the entries, as compile_strategy ANDs filters.
    """
    filters = list(definition.get("filters") or ())
    derived = [item for item in filters if qi.is_derived(item)]
    native = [item for item in filters if item not in derived]
    compiled = sig.compile_strategy(bars, {**definition, "filters": native}, None, context, symbol)
    entries = [value == 1 for value in compiled.signals]
    exits = [value == 1 for value in compiled.exits]
    if derived:
        bar_dates = [sig._utc_date(t) for t in bars.t]
        for item in derived:
            series_id = item["series"]
            if series_id not in context:
                raise ValueError(f"No derived series {series_id}")
            normalized = {"type": "series", "series": series_id,
                          "condition": sig._normalize_condition(item["condition"])}
            mask = sig._series_mask(normalized, context, bar_dates, False)
            entries = [entry and passed == 1 for entry, passed in zip(entries, mask)]
    return entries, exits


# --------------------------------------------------------------------------- data

@dataclass(frozen=True)
class StudyData:
    spy_dates: tuple[str, ...]
    bars: Mapping[str, Bars]
    markets: Mapping[str, Market]
    context: Mapping[str, Mapping[str, float]]
    facts: qi.Facts
    tables: Mapping[str, object]
    manifest: str


def _on_calendar(values_by_date: Mapping[str, float], dates: Sequence[str]) -> list[float | None]:
    return [values_by_date.get(day) for day in dates]


def _iv_live(market: Market, day: str) -> bool:
    index = _index_of(market.dates, day)
    return index is not None and market.iv_index[index] is not None


def _index_of(dates: Sequence[str], day: str) -> int | None:
    from bisect import bisect_left

    at = bisect_left(dates, day)
    return at if at < len(dates) and dates[at] == day else None


def derive(spy_dates: Sequence[str], bars: Mapping[str, Bars], markets: Mapping[str, Market],
           context: Mapping[str, Mapping[str, float]]) -> tuple[dict, qi.Facts, dict]:
    """Derived `qc:` series, the eligibility dates of the runs and the descriptive tables."""
    ends = qi.month_end_indices(spy_dates)
    end_dates = [spy_dates[index] for index in ends]
    months = [day[:7] for day in end_dates]
    adj = {symbol: dict(zip(bars[symbol].dates, bars[symbol].adj_close)) for symbol in qi.CORE7}
    adj_ends = {symbol: _on_calendar(adj[symbol], end_dates) for symbol in qi.CORE7}
    live = {symbol: [_iv_live(markets[symbol], day) for day in end_dates] for symbol in qi.CORE7}
    derived: dict[str, dict[str, float]] = {}
    starts: dict[str, dict[str, str]] = {}
    tables: dict[str, object] = {}

    iv_start = {symbol: next(day for day, value in zip(markets[symbol].dates, markets[symbol].iv_index)
                             if value is not None) for symbol in qi.CORE7}

    # Asset-class trend: 10 month-end closes of the member and its IV index live.
    starts["qc-asset-class-trend"] = {}
    for symbol in qi.CORE7:
        seen = 0
        for k, day in enumerate(end_dates):
            seen += adj_ends[symbol][k] is not None
            if seen >= 10 and live[symbol][k]:
                starts["qc-asset-class-trend"][symbol] = day
                break

    # Futures trend and carry on the SPY calendar.
    starts["qc-futures-trend-carry"] = {}
    for symbol in qi.CORE7:
        future = align(context[qi.FUTURE_OF[symbol]], spy_dates)
        etf = _on_calendar(adj[symbol], spy_dates)
        values = qi.futures_trend_carry(future, etf, ends)
        trend, carry = {}, {}
        for index, (t_value, c_value) in values.items():
            trend[spy_dates[index]] = t_value
            carry[spy_dates[index]] = c_value
        derived[f"{qi.DERIVED_PREFIX}futTrend:{symbol}"] = trend
        derived[f"{qi.DERIVED_PREFIX}futCarry:{symbol}"] = carry
        first = next((day for k, day in enumerate(end_dates) if day in trend and live[symbol][k]), None)
        if first is not None:
            starts["qc-futures-trend-carry"][symbol] = first

    # Gold Fed model: first month-end with GVZ live and an EY_TNX_RATIO value; last input month-end.
    ratio = context["EY_TNX_RATIO"]
    gold = [k for k, day in enumerate(end_dates) if live["GLD"][k] and day in ratio]
    starts["qc-gold-fed-model"] = {"GLD": end_dates[gold[0]]}
    gold_last = max(day for day in end_dates if day in ratio)
    in_gold = [ratio[end_dates[k]] > 2 for k in gold]
    tables["goldRatio"] = {
        "monthEnds": len(gold), "shareIn": sum(in_gold) / len(gold),
        "min": min(ratio[end_dates[k]] for k in gold), "max": max(ratio[end_dates[k]] for k in gold),
        "last": (gold_last, ratio[gold_last]),
        "inMonths": [end_dates[k][:7] for k, flag in zip(gold, in_gold) if flag],
    }

    # Oil regression on the month-end grid.
    starts["qc-oil-predicts-equity"] = {}
    bill = align(context["IRX"], end_dates)
    oil_table = {}
    for symbol in ("SPY", "QQQ"):
        predictions = qi.oil_predictions(adj_ends["USO"], adj_ends[symbol], bill)
        derived[f"{qi.DERIVED_PREFIX}oilPrediction:{symbol}"] = {
            end_dates[k]: value[3] for k, value in predictions.items()}
        first = next((end_dates[k] for k in sorted(predictions) if live[symbol][k]), None)
        starts["qc-oil-predicts-equity"][symbol] = first
        oil_table[symbol] = {end_dates[k]: value for k, value in predictions.items()}
    tables["oil"] = oil_table

    # Momentum and seasonality selections.
    for idea, name, table in (
            ("qc-momentum-rotation", "momentum", qi.momentum_table(adj_ends, live, qi.CORE7)),
            ("qc-same-month-seasonality", "season", qi.season_table(adj_ends, months, live, qi.CORE7))):
        starts[idea] = {}
        for symbol in qi.CORE7:
            derived[f"{qi.DERIVED_PREFIX}{name}Selected:{symbol}"] = {
                day: float(row[symbol].selected) for day, row in zip(end_dates, table)}
            derived[f"{qi.DERIVED_PREFIX}{name}Eligible:{symbol}"] = {
                day: float(row[symbol].eligible) for day, row in zip(end_dates, table)}
            first = next((day for day, row in zip(end_dates, table) if row[symbol].eligible), None)
            if first is not None:
                starts[idea][symbol] = first
        tables[name] = {"held": [(day, sorted(s for s in qi.CORE7 if row[s].selected))
                                 for day, row in zip(end_dates, table)]}

    # IV rank join: the first bar where the DSL ivRank (length 252) is defined.
    join = {}
    probe = qi.definition("ivRank defined", qi.PUT_CREDIT, filters=[{"type": "ivRank", "length": 252, "min": 0}])
    for symbol in qi.CORE7:
        bar = bars[symbol]
        entries, _ = compile_signals(dsl_bars(bar.dates, bar.open, bar.high, bar.low, bar.close), probe, context,
                                     symbol)
        join[symbol] = next(day for day, flag in zip(bar.dates, entries) if flag)
    facts = qi.Facts(iv_start=iv_start, iv_rank_join=join, starts=starts, gold_last_input=gold_last)
    return derived, facts, tables


def manifest_digest(root=None) -> str:
    path = data_root(root) / "SHA256SUMS"
    return hashlib.sha256(path.read_bytes()).hexdigest()


def load_study_data(root=None) -> StudyData:
    bars = {symbol: load_bars(symbol, root) for symbol in qi.CORE7}
    markets = {symbol: load_market(symbol, root) for symbol in qi.CORE7}
    context = load_context(root=root)
    spy_dates = bars["SPY"].dates
    derived, facts, tables = derive(spy_dates, bars, markets, context)
    return StudyData(spy_dates, bars, markets, {**context, **derived}, facts, tables, manifest_digest(root))


# --------------------------------------------------------------------------- events and trades

def _leg_signals(leg: qi.Leg, data: StudyData) -> tuple[list[bool], list[bool]]:
    """Entry/exit per bar of the leg's market (monthly frames are mapped back to their month-end bars)."""
    bar = data.bars[leg.symbol]
    if leg.frame == "daily":
        return compile_signals(dsl_bars(bar.dates, bar.open, bar.high, bar.low, bar.close), leg.definition,
                               data.context, leg.symbol)
    if leg.frame != "monthly":
        raise ValueError(f"Unknown frame {leg.frame}")
    ends = qi.month_end_indices(bar.dates)
    closes = [bar.adj_close[index] for index in ends]
    monthly = dsl_bars([bar.dates[index] for index in ends], closes, closes, closes, closes)
    month_entries, month_exits = compile_signals(monthly, leg.definition, data.context, leg.symbol)
    entries = [False] * len(bar.dates)
    exits = [False] * len(bar.dates)
    for position, index in enumerate(ends):
        entries[index] = month_entries[position]
        exits[index] = month_exits[position]
    return entries, exits


def _in_dates(leg: qi.Leg, day: str) -> bool:
    return day >= leg.start and (leg.end is None or day <= leg.end)


def _next_true(flags: Sequence[bool]) -> list[int | None]:
    """For each index, the first later index where flags is True."""
    out: list[int | None] = [None] * len(flags)
    following = None
    for index in range(len(flags) - 1, -1, -1):
        out[index] = following
        if flags[index]:
            following = index
    return out


def _sequential(candidates: Sequence[tuple[int, int | None]], symbol: str, leg: qi.Leg,
                market: Market) -> tuple[list[PricedTrade], list]:
    """Prices candidates in order, taking one only when the last spread has closed by its signal bar."""
    trades, skipped = [], []
    busy = -1
    for entry, exit_ in candidates:
        if entry < busy:
            continue
        book = build_book([SignalEvent(symbol, entry, exit_)], leg.definition["options"], {symbol: market})
        if book.trades:
            trades.append(book.trades[0])
            busy = book.trades[0].exit_index
        skipped.extend(book.skipped)
    return trades, skipped


def leg_trades(leg: qi.Leg, data: StudyData) -> tuple[list[PricedTrade], list, int]:
    """(priced trades, book skips, entry signals) of one leg."""
    market = data.markets[leg.symbol]
    dates = market.dates
    entries, exits = _leg_signals(leg, data)
    if leg.policy == "roll":
        ends = qi.month_end_indices(dates)
        events = []
        for position, index in enumerate(ends):
            if entries[index] and _in_dates(leg, dates[index]):
                following = ends[position + 1] if position + 1 < len(ends) else None
                events.append(SignalEvent(leg.symbol, index, following))
        book = build_book(events, leg.definition["options"], {leg.symbol: market})
        return list(book.trades), list(book.skipped), len(events)
    if leg.policy == "flat":
        if leg.cadence == "daily":
            bars = range(len(dates) - 1)
        elif leg.cadence == "monthEnd":
            bars = qi.month_end_indices(dates)
        else:
            raise ValueError(f"Unknown cadence {leg.cadence}")
        following = _next_true(exits) if leg.definition.get("exit") else [None] * len(dates)
        candidates = [(index, following[index]) for index in bars if entries[index] and _in_dates(leg, dates[index])]
        trades, skipped = _sequential(candidates, leg.symbol, leg, market)
        return trades, skipped, len(trades) + len(skipped)
    if leg.policy == "window":
        mask = entries[leg.shift:] + [False] * leg.shift
        last = len(dates) - 1
        candidates = [(first, end) for first, end in qi.window_spans(mask)
                      if first > 0 and _in_dates(leg, dates[first]) and end + 1 <= last and end > first]
        trades, skipped = _sequential(candidates, leg.symbol, leg, market)
        return trades, skipped, len(candidates)
    raise ValueError(f"Unknown policy {leg.policy}")


# --------------------------------------------------------------------------- runs

@dataclass(frozen=True)
class Outcome:
    run: qi.RunSpec
    result: LedgerResult
    book_skipped: int
    signals: Mapping[str, int]
    nautilus_gap: float | None
    priced: tuple[PricedTrade, ...] = ()


def max_open_risk(result: LedgerResult, priced: Sequence[PricedTrade]) -> float:
    """Largest share of equity at risk in open spreads at a day's close: sum of contracts * max loss per
    contract of the trades open after that day's exits and entries, over that day's equity (reported only)."""
    max_loss = {trade.trade_id: trade.max_loss for trade in priced}
    spans = [(record["entryDate"], record["exitDate"], record["contracts"] * max_loss[record["id"]])
             for record in result.trades]
    worst = 0.0
    for day, equity in zip(result.dates, result.equity):
        risk = sum(amount for entry, exit_, amount in spans if entry <= day < exit_)
        if risk and equity > 0:
            worst = max(worst, risk / equity)
    return worst


def run_trades(run: qi.RunSpec, data: StudyData) -> tuple[list[PricedTrade], int, dict[str, int]]:
    collected = []
    skipped = 0
    signals: dict[str, int] = {}
    for order, leg in enumerate(run.legs):
        trades, skips, count = leg_trades(leg, data)
        collected.extend((trade.entry_date, order, trade.entry_index, trade) for trade in trades)
        skipped += len(skips)
        signals[leg.symbol] = signals.get(leg.symbol, 0) + count
    collected.sort(key=lambda item: item[:3])
    trades = [dataclasses.replace(item[3], trade_id=number) for number, item in enumerate(collected, start=1)]
    return trades, skipped, signals


def execute(run: qi.RunSpec, data: StudyData, nautilus: bool = True) -> Outcome:
    trades, book_skipped, signals = run_trades(run, data)
    dates = [day for day in data.spy_dates if day >= run.start]
    result = run_ledger(trades, dates=dates)
    gap = None
    if nautilus:
        from .nautilus_runner import run_nautilus

        other = run_nautilus(trades, dates=dates)
        gap = max((abs(a - b) / max(abs(a), abs(b)) for a, b in zip(result.equity, other.equity, strict=True)),
                  default=0.0)
        same = [(t["id"], t["contracts"]) for t in result.trades] == [(t["id"], t["contracts"]) for t in other.trades]
        if gap > PARITY_REL_TOL or not same:
            raise RuntimeError(f"{run.key}: ledger and Nautilus disagree (gap {gap:.3g}, trades match {same})")
    return Outcome(run, result, book_skipped, signals, gap, tuple(trades))


def daily_sharpe(result: LedgerResult) -> float:
    equity = result.equity
    returns = [equity[i] / equity[i - 1] - 1 for i in range(1, len(equity))]
    if len(returns) < 2:
        return 0.0
    spread = stdev(returns)
    return sum(returns) / len(returns) / spread if spread > 0 else 0.0


def run_family(data: StudyData, nautilus: bool = True, progress=None) -> tuple[dict[str, Outcome], dict[str, dict],
                                                                               float]:
    """Every run of the family; metrics with n_trials = 32 and the across-trial per-day Sharpe variance."""
    runs = qi.family(data.facts)
    counted = [key for key, run in runs.items() if run.counted]
    if len(counted) != N_TRIALS:
        raise RuntimeError(f"Expected {N_TRIALS} counted runs, found {len(counted)}")
    outcomes = {}
    for key, run in runs.items():
        outcomes[key] = execute(run, data, nautilus)
        if progress is not None:
            progress(key)
    trial_variance = variance([daily_sharpe(outcomes[key].result) for key in counted])
    metrics = {}
    for key, outcome in outcomes.items():
        stats = summarize(outcome.result, N_TRIALS, trial_variance)
        stats["skipped"] = stats["skipped"] + outcome.book_skipped
        stats["maxOpenRisk"] = max_open_risk(outcome.result, outcome.priced)
        stats["staleIvExits"] = sum(1 for trade in outcome.result.trades if trade["exitReason"] == "stale-iv")
        metrics[key] = stats
    return outcomes, metrics, trial_variance


# --------------------------------------------------------------------------- documents

def verdict(primary: Mapping, baseline: Mapping) -> tuple[str, list[tuple[str, bool]]]:
    """The common pass/fail rule of the 11 specs on run A against run B."""
    sharpe, base = primary.get("sharpe"), baseline.get("sharpe")
    deflated = primary.get("deflatedSharpe")
    checks = [
        (f"Sharpe above {PASS_SHARPE}", sharpe is not None and sharpe > PASS_SHARPE),
        (f"deflated Sharpe above {PASS_DEFLATED} (n_trials {N_TRIALS})", deflated is not None and deflated > PASS_DEFLATED),
        ("max drawdown smaller than 25%", primary["maxDrawdown"] > PASS_DRAWDOWN),
        ("Sharpe above run B", sharpe is not None and (base is None or sharpe > base)),
    ]
    return ("PASS" if all(ok for _, ok in checks) else "FAIL"), checks


def equity_points(result: LedgerResult, limit: int = EQUITY_POINTS_MAX) -> list[dict]:
    """Month-end equity (the last day of each month, the final partial month included), at most `limit`
    points: beyond that, `limit` months evenly spaced from the first to the last are kept."""
    by_month: dict[str, float] = {}
    for day, value in zip(result.dates, result.equity):
        by_month[day[:7]] = value
    points = [{"t": month, "v": round(value, 2)} for month, value in by_month.items()]
    if len(points) > limit:
        last = len(points) - 1
        keep = sorted({round(k * last / (limit - 1)) for k in range(limit)})
        points = [points[k] for k in keep]
    return points


def run_entry(label: str, outcome: Outcome, stats: Mapping) -> dict:
    month = stats["worstMonth"]
    return {
        "name": f"{label}: {outcome.run.name}"[:120], "symbols": list(outcome.run.symbols),
        "cagr": stats["cagr"], "sharpe": stats["sharpe"], "deflatedSharpe": stats["deflatedSharpe"],
        "maxDrawdown": stats["maxDrawdown"],
        "worstMonth": None if month is None else {"month": month, "ret": stats["worstMonthReturn"]},
        "trades": stats["trades"], "winRate": stats["winRate"], "exposure": stats["exposure"],
        "skipped": stats["skipped"],
    }


def _fmt(value, digits: int = 2, pct: bool = False) -> str:
    if value is None:
        return "n/a"
    return f"{value * 100:.{digits - 1}f}%" if pct else f"{value:.{digits}f}"


def idea_notes(idea: qi.Idea, outcomes: Mapping[str, Outcome], metrics: Mapping[str, dict], variance_: float,
               checks: Sequence[tuple[str, bool]], data: StudyData, nautilus: bool) -> str:
    lines = [
        "Research only. Option prices are modeled (Black-Scholes on CBOE volatility indices), not quoted.",
        "Verdict checks on run A: " + "; ".join(f"{name}: {'yes' if ok else 'no'}" for name, ok in checks) + ".",
        f"Deflated Sharpe: n_trials {N_TRIALS}, variance of the per-day Sharpe across the 32 runs {variance_:.3g}.",
        "Engines: ledger and NautilusTrader agree on every trade and daily equity (1e-6)." if nautilus
        else "Engines: reference ledger only (Nautilus parity not run).",
        f"Data manifest: sha256(SHA256SUMS) {data.manifest}.",
    ]
    for label, key in idea.runs:
        outcome = outcomes[key]
        lines.append(f"{label} from {outcome.run.start}: signals {sum(outcome.signals.values())}, "
                     f"trades {metrics[key]['trades']}, skipped {metrics[key]['skipped']}, max open risk "
                     f"{metrics[key]['maxOpenRisk']:.1%}, stale-IV exits {metrics[key]['staleIvExits']}.")
    text = " ".join(lines)
    return text[:NOTES_MAX]


def code_revision(cwd=None) -> tuple[str, bool]:
    """(HEAD commit sha, whether the qc-ports code differs from it)."""
    import subprocess
    from pathlib import Path

    here = cwd or Path(__file__).resolve().parent
    sha = subprocess.run(["git", "rev-parse", "HEAD"], cwd=here, check=True, capture_output=True,
                         text=True).stdout.strip()
    dirty = subprocess.run(["git", "status", "--porcelain", "--", "."], cwd=here, check=True, capture_output=True,
                           text=True).stdout.strip() != ""
    return sha, dirty


def provenance(ran: str, data: StudyData, nautilus: bool, revision: str) -> dict:
    """QcPortProvenanceSchema: the code, engine, data manifest and run id of this study."""
    if nautilus:
        from quantlab.nautilus_engine import NAUTILUS_VERSION

        engine = f"qc-ports ledger + nautilus_trader {NAUTILUS_VERSION} (parity checked)"
    else:
        engine = "qc-ports ledger (reference, no Nautilus parity run)"
    return {"codeRevision": revision, "engine": engine, "dataSha256": data.manifest,
            "runId": f"qc-ports-{ran}-{revision[:12]}"}


def document(idea: qi.Idea, outcomes: Mapping[str, Outcome], metrics: Mapping[str, dict], variance_: float,
             ran: str, data: StudyData, nautilus: bool, revision: str = "0" * 40) -> dict:
    if [label for label, _ in idea.runs[:2]] != ["A", "B"]:
        raise ValueError(f"{idea.id}: runs[0] must be A and runs[1] the baseline B")
    primary, baseline = metrics[idea.key("A")], metrics[idea.key("B")]
    result, checks = verdict(primary, baseline)
    doc = {
        "kind": "qc-port", "id": idea.id, "spec": idea.spec, "title": idea.title, "ran": ran, "verdict": result,
        "criteria": dict(CRITERIA), "provenance": provenance(ran, data, nautilus, revision),
        "runs": [run_entry(label, outcomes[key], metrics[key]) for label, key in idea.runs],
        "equity": equity_points(outcomes[idea.key("A")].result),
        "notes": idea_notes(idea, outcomes, metrics, variance_, checks, data, nautilus),
    }
    if idea.gates:
        doc["gates"] = [{
            "gate": gate.gate, "host": gate.host,
            "before": _gate_metrics(metrics[gate.before]), "after": _gate_metrics(metrics[gate.after]),
        } for gate in idea.gates]
    size = len(json.dumps(doc, separators=(",", ":")).encode())
    if size >= DOC_MAX_BYTES:
        raise RuntimeError(f"{idea.id}: document is {size} bytes")
    return doc


def _gate_metrics(stats: Mapping) -> dict:
    return {"sharpe": stats["sharpe"], "maxDrawdown": stats["maxDrawdown"], "trades": stats["trades"]}


def documents(data: StudyData, ran: str, nautilus: bool = True, progress=None, revision: str | None = None):
    """(documents, outcomes, metrics, variance). `revision` defaults to the git HEAD of this code."""
    date.fromisoformat(ran)
    if revision is None:
        revision, dirty = code_revision()
        if dirty:
            import sys

            print("warning: the qc-ports code differs from HEAD; provenance.codeRevision is HEAD", file=sys.stderr)
    outcomes, metrics, variance_ = run_family(data, nautilus, progress)
    docs = [document(idea, outcomes, metrics, variance_, ran, data, nautilus, revision) for idea in qi.IDEAS]
    return docs, outcomes, metrics, variance_


# --------------------------------------------------------------------------- descriptive statistics

def window_stats(result: LedgerResult, start: str, end: str | None = None) -> dict | None:
    """Sharpe, CAGR and max drawdown of the run's own equity between `start` and `end` (inclusive)."""
    indices = [i for i, day in enumerate(result.dates) if day >= start and (end is None or day <= end)]
    if len(indices) < 3:
        return None
    first = indices[0]
    base = result.equity[first - 1] if first > 0 else result.capital
    base_day = result.dates[first - 1] if first > 0 else result.dates[first]
    series = [base, *(result.equity[i] for i in indices)]
    returns = [series[i] / series[i - 1] - 1 for i in range(1, len(series))]
    spread = stdev(returns)
    years = (date.fromisoformat(result.dates[indices[-1]]) - date.fromisoformat(base_day)).days / 365.25
    return {
        "start": result.dates[first], "end": result.dates[indices[-1]],
        "sharpe": sum(returns) / len(returns) / spread * math.sqrt(TRADING_DAYS) if spread > 0 else None,
        "cagr": (series[-1] / base) ** (1 / years) - 1 if years > 0 else None,
        "maxDrawdown": max_drawdown(series), "totalReturn": series[-1] / base - 1,
    }


def attribution(result: LedgerResult) -> dict[str, dict]:
    out: dict[str, dict] = {}
    for trade in result.trades:
        row = out.setdefault(trade["symbol"], {"trades": 0, "pnl": 0.0, "wins": 0})
        row["trades"] += 1
        row["pnl"] += trade["pnl"]
        row["wins"] += trade["pnl"] > 0
    return out


def vix_percentile(history: Sequence[float], value: float) -> float:
    """100 * (number of `history` values below `value`) / len(history)."""
    return 100 * sum(1 for item in history if item < value) / len(history)


def quintile_of(percentile: float) -> int:
    """1 below 20, 2 for 20 to below 40, ..., 5 at 80 and above."""
    return min(5, int(percentile // 20) + 1)


def _describe(values: Sequence[float]) -> dict:
    n = len(values)
    avg = sum(values) / n if n else None
    spread = stdev(values) if n > 1 else None
    return {"n": n, "mean": avg, "median": median(values) if n else None,
            "positive": sum(1 for v in values if v > 0) / n if n else None, "std": spread,
            "t": avg / (spread / math.sqrt(n)) if spread else None}


def welch_t(a: Sequence[float], b: Sequence[float]) -> float | None:
    if len(a) < 2 or len(b) < 2:
        return None
    se = math.sqrt(variance(a) / len(a) + variance(b) / len(b))
    return (sum(a) / len(a) - sum(b) / len(b)) / se if se > 0 else None


def quintile_table(groups: Mapping[int, Sequence[float]]) -> dict:
    rows = {q: _describe(groups.get(q, [])) for q in range(1, 6)}
    high, low = groups.get(5, []), groups.get(1, [])
    diff = (sum(high) / len(high) - sum(low) / len(low)) if high and low else None
    return {"rows": rows, "q5MinusQ1": diff, "welchT": welch_t(high, low)}


def vix_tables(data: StudyData, last_month_end: str = "2026-09-30") -> dict:
    """Descriptive VIX tables of qc-vix-term-gate (not runs)."""
    vix = data.context["VIX"]
    vix_dates = sorted(vix)
    vix_values = [vix[day] for day in vix_dates]
    spy_adj = dict(zip(data.bars["SPY"].dates, data.bars["SPY"].adj_close))
    ends = [data.spy_dates[i] for i in qi.month_end_indices(data.spy_dates)]
    observations = []
    for position in range(len(ends) - 1):
        day, following = ends[position], ends[position + 1]
        if day > last_month_end or day not in vix:
            continue
        at = vix_dates.index(day)
        if at < 503:
            continue
        percentile = vix_percentile(vix_values[at - 503:at], vix[day])
        observations.append((day, vix[day], percentile, spy_adj[following] / spy_adj[day] - 1))
    by_percentile: dict[int, list[float]] = {}
    for _, _, percentile, ret in observations:
        by_percentile.setdefault(quintile_of(percentile), []).append(ret)
    levels = sorted(level for _, level, _, _ in observations)
    cuts = [levels[int(len(levels) * q / 5)] for q in range(1, 5)]
    by_level: dict[int, list[float]] = {}
    for _, level, _, ret in observations:
        by_level.setdefault(1 + sum(level >= cut for cut in cuts), []).append(ret)
    term = {}
    v3m = data.context["VIX3M"]
    for day, level, _, ret in observations:
        if day >= "2006-07-31" and day in v3m:
            term.setdefault("contango" if level / v3m[day] < 1 else "not contango", []).append(ret)
    ratios = [vix[day] / v3m[day] for day in v3m if day in vix and v3m[day] > 0]
    return {
        "observations": len(observations), "first": observations[0][0], "last": observations[-1][0],
        "percentile": quintile_table(by_percentile), "level": quintile_table(by_level),
        "levelCuts": cuts, "term": {name: _describe(values) for name, values in term.items()},
        "tieDays": sum(1 for ratio in ratios if ratio == 1.0), "ratioDays": len(ratios),
    }


def gate_overlap(data: StudyData) -> dict:
    """Month-ends from 2006-07-31 where the contango gate and the volRegime gate pass (SPY)."""
    bar = data.bars["SPY"]
    dsl = dsl_bars(bar.dates, bar.open, bar.high, bar.low, bar.close)
    masks = {}
    for name in ("vixTermStructure", "volRegime"):
        made = qi.definition(name, qi.PUT_CREDIT, filters=[qi.GATES[name]])
        masks[name], _ = compile_signals(dsl, made, data.context, "SPY")
    ends = [i for i in qi.month_end_indices(bar.dates) if bar.dates[i] >= "2006-07-31"]
    both = sum(1 for i in ends if masks["vixTermStructure"][i] and masks["volRegime"][i])
    only_term = sum(1 for i in ends if masks["vixTermStructure"][i] and not masks["volRegime"][i])
    only_regime = sum(1 for i in ends if masks["volRegime"][i] and not masks["vixTermStructure"][i])
    return {"monthEnds": len(ends), "both": both, "onlyContango": only_term, "onlyVolRegime": only_regime,
            "neither": len(ends) - both - only_term - only_regime}


def year_drawdowns(result: LedgerResult, years: Sequence[int]) -> dict[int, float | None]:
    out = {}
    for year in years:
        stats = window_stats(result, f"{year}-01-01", f"{year}-12-31")
        out[year] = None if stats is None else stats["maxDrawdown"]
    return out


# --------------------------------------------------------------------------- report (markdown)

def _metrics_table(idea: qi.Idea, metrics: Mapping[str, dict], outcomes: Mapping[str, Outcome]) -> list[str]:
    lines = [("|Run|From|CAGR|Sharpe|Deflated Sharpe|Max drawdown|Worst month|Trades|Win rate|Exposure|Skipped|"
             "Max open risk|Stale-IV exits|"),
             "|---|---|---|---|---|---|---|---|---|---|---|---|---|"]
    for label, key in idea.runs:
        m = metrics[key]
        worst = "n/a" if m["worstMonth"] is None else f"{m['worstMonth']} {_fmt(m['worstMonthReturn'], 2, True)}"
        lines.append(f"|{label}|{outcomes[key].run.start}|{_fmt(m['cagr'], 2, True)}|{_fmt(m['sharpe'])}|"
                     f"{_fmt(m['deflatedSharpe'], 3)}|{_fmt(m['maxDrawdown'], 2, True)}|{worst}|{m['trades']}|"
                     f"{_fmt(m['winRate'], 2, True)}|{_fmt(m['exposure'], 2, True)}|{m['skipped']}|"
                     f"{_fmt(m['maxOpenRisk'], 2, True)}|{m['staleIvExits']}|")
    return lines


def _window_line(name: str, stats: dict | None) -> str:
    if stats is None:
        return f"- {name}: no data."
    return (f"- {name} ({stats['start']} to {stats['end']}): Sharpe {_fmt(stats['sharpe'])}, CAGR "
            f"{_fmt(stats['cagr'], 2, True)}, max drawdown {_fmt(stats['maxDrawdown'], 2, True)}.")


def _attribution_lines(label: str, result: LedgerResult) -> list[str]:
    rows = attribution(result)
    parts = [f"{symbol} {row['trades']} trades, P&L USD {row['pnl']:,.0f}, win {row['wins'] / row['trades']:.0%}"
             for symbol, row in sorted(rows.items(), key=lambda item: qi.CORE7.index(item[0]))]
    return [f"- Per-member attribution, run {label}: " + ("; ".join(parts) if parts else "no trades") + "."]


def report(idea: qi.Idea, doc: Mapping, outcomes: Mapping[str, Outcome], metrics: Mapping[str, dict],
           variance_: float, data: StudyData, nautilus: bool) -> str:
    primary = metrics[idea.key("A")]
    _, checks = verdict(primary, metrics[idea.key("B")])
    lines = [
        f"Run {doc['ran']} with `python -m strategies.qc_ports study --ran {doc['ran']}` (services/research), "
        f"data manifest sha256(SHA256SUMS) `{data.manifest}`, data to {data.spy_dates[-1]}. "
        f"The JSON document of the same command (without --report) goes to Postgres `research_studies` (id `{idea.id}`) through `bun run vertex:research-studies:import`. Deflated Sharpe: n_trials {N_TRIALS}, "
        f"variance of the per-day Sharpe across the 32 runs {variance_:.3g}. "
        + ("Ledger and NautilusTrader agreed on every trade and on daily equity (1e-6 relative)."
           if nautilus else "Reference ledger only."),
        "",
        *_metrics_table(idea, metrics, outcomes),
        "",
    ]
    if idea.gates:
        lines += [("|Gate|Host|Before Sharpe|After Sharpe|Before max DD|After max DD|Before CAGR|After CAGR|"
                  "Before trades|After trades|Before exposure|After exposure|Helps|"),
                  "|---|---|---|---|---|---|---|---|---|---|---|---|---|"]
        for gate in idea.gates:
            b, f = metrics[gate.before], metrics[gate.after]
            helps = (f["sharpe"] or -math.inf) > (b["sharpe"] or -math.inf) and f["maxDrawdown"] >= b["maxDrawdown"]
            lines.append(f"|{gate.gate}|{gate.host} from {outcomes[gate.after].run.start}|{_fmt(b['sharpe'])}|"
                         f"{_fmt(f['sharpe'])}|{_fmt(b['maxDrawdown'], 2, True)}|{_fmt(f['maxDrawdown'], 2, True)}|"
                         f"{_fmt(b['cagr'], 2, True)}|{_fmt(f['cagr'], 2, True)}|{b['trades']}|{f['trades']}|"
                         f"{_fmt(b['exposure'], 2, True)}|{_fmt(f['exposure'], 2, True)}|{'yes' if helps else 'no'}|")
        lines.append("")
    lines += _extras(idea, outcomes, data)
    lines += ["", "### Verdict", "",
              f"**{doc['verdict']}**. Run A: " + "; ".join(f"{name}: {'yes' if ok else 'no'}" for name, ok in checks)
              + f" (A Sharpe {_fmt(primary['sharpe'])}, B Sharpe {_fmt(metrics[idea.key('B')]['sharpe'])}, "
              f"deflated {_fmt(primary['deflatedSharpe'], 3)}, max drawdown {_fmt(primary['maxDrawdown'], 2, True)})."]
    return "\n".join(lines)


def _extras(idea: qi.Idea, outcomes: Mapping[str, Outcome], data: StudyData) -> list[str]:
    result = {label: outcomes[key].result for label, key in idea.runs}
    signals = {label: outcomes[key].signals for label, key in idea.runs}
    lines: list[str] = []
    if idea.id == "qc-asset-class-trend":
        lines += _attribution_lines("A", result["A"])
        lines.append(_window_line("All 7 live, run A", window_stats(result["A"], "2011-03-31")))
        lines.append(_window_line("All 7 live, run B", window_stats(result["B"], "2011-03-31")))
        lines.append(f"- Months in (signals), A vs B: {sum(signals['A'].values())} of {sum(signals['B'].values())}.")
    elif idea.id == "qc-futures-trend-carry":
        lines += _attribution_lines("A", result["A"])
        legs: dict[str, list[float]] = {}
        for trade in result["A"].trades:
            legs.setdefault("long" if trade["structure"] == "callDebitVertical" else "short", []).append(trade["pnl"])
        lines.append("- Run A legs: " + "; ".join(
            f"{name} {len(pnls)} trades, P&L USD {sum(pnls):,.0f}, win {sum(p > 0 for p in pnls) / len(pnls):.0%}"
            for name, pnls in sorted(legs.items())) + ".")
        for label in ("A", "A-L", "B"):
            lines.append(_window_line(f"All 7 live, run {label}", window_stats(result[label], "2018-07-31")))
        lines.append("- First eligible month-ends: " + ", ".join(
            f"{s} {d}" for s, d in data.facts.starts["qc-futures-trend-carry"].items()) + ".")
    elif idea.id == "qc-gold-fed-model":
        table = data.tables["goldRatio"]
        lines.append(f"- EY_TNX_RATIO at {table['monthEnds']} month-ends with input: share in (> 2) "
                     f"{table['shareIn']:.1%}, min {table['min']:.2f}, max {table['max']:.2f}, last "
                     f"{table['last'][1]:.2f} ({table['last'][0]}); "
                     + ("every month-end of the sample has an input (6-month lag)."
                        if data.facts.gold_last_input == data.spy_dates[qi.month_end_indices(data.spy_dates)[-1]]
                        else f"no input after {data.facts.gold_last_input}."))
        months = table["inMonths"]
        lines.append(f"- Months in: {len(months)}" + (f", {months[0]} to {months[-1]}" if months else "") + ".")
    elif idea.id == "qc-iv-rank-gate":
        lines += _attribution_lines("A", result["A"])
        lines += _attribution_lines("B", result["B"])
        lines.append(_window_line("All 7 live, run A", window_stats(result["A"], "2012-03-14")))
        lines.append(_window_line("All 7 live, run B", window_stats(result["B"], "2012-03-14")))
        lines.append("- Member join (252 IV index values): " + ", ".join(
            f"{s} {d}" for s, d in data.facts.iv_rank_join.items()) + ".")
    elif idea.id == "qc-momentum-rotation":
        lines.append(_window_line("All 7 eligible, run A", window_stats(result["A"], "2011-03-31")))
        lines.append(_window_line("All 7 eligible, run B", window_stats(result["B"], "2011-03-31")))
        lines += _attribution_lines("A", result["A"])
    elif idea.id == "qc-oil-predicts-equity":
        for symbol, table in data.tables["oil"].items():
            rows = [row for day, row in sorted(table.items())]
            t_values = [row[2] for row in rows if row[2] is not None]
            lines.append(f"- {symbol}: {len(rows)} regressions, months in {sum(row[3] > 0 for row in rows) / len(rows):.1%}, "
                         f"mean a1 {sum(row[1] for row in rows) / len(rows):.3f}, |t(a1)| > 2 in "
                         f"{sum(abs(t) > 2 for t in t_values) / len(t_values):.1%}, last a1 {rows[-1][1]:.3f} "
                         f"(t {rows[-1][2]:.2f}).")
        lines += _attribution_lines("A", result["A"])
    elif idea.id in ("qc-opex-week", "qc-turn-of-the-month"):
        lines += _attribution_lines("A", result["A"])
        for label in ("A", "A-L", "B"):
            lines.append(_window_line(f"All four live, run {label}", window_stats(result[label], "2009-09-16")))
        if idea.id == "qc-opex-week":
            for label in ("A", "B"):
                lines.append(_window_line(f"Source window, run {label}",
                                          window_stats(result[label], "2007-01-01", "2018-08-01")))
        lines.append("- Runs B of qc-opex-week and qc-turn-of-the-month are the same definition and dates (both "
                     "pre-registered and counted).")
    elif idea.id == "qc-regime-put-vrp":
        for label in ("A", "B"):
            drawdowns = year_drawdowns(result[label], (2008, 2020, 2022))
            lines.append(f"- Run {label} drawdown within " + ", ".join(
                f"{year} {_fmt(value, 2, True)}" for year, value in drawdowns.items()) + ".")
        overlap = gate_overlap(data)
        lines.append(f"- Month-ends from 2006-07-31: {overlap['monthEnds']}; volRegime passes at "
                     f"{overlap['both'] + overlap['onlyVolRegime']}.")
    elif idea.id == "qc-vix-term-gate":
        overlap = gate_overlap(data)
        tables = vix_tables(data)
        lines.append(f"- Gate overlap at {overlap['monthEnds']} month-ends from 2006-07-31: both pass "
                     f"{overlap['both']}, only contango {overlap['onlyContango']}, only volRegime "
                     f"{overlap['onlyVolRegime']}, neither {overlap['neither']}.")
        lines.append(f"- VIX/VIX3M tie days (exactly 1.00): {tables['tieDays']} of {tables['ratioDays']}.")
        lines += _quintile_lines(tables)
    elif idea.id == "qc-same-month-seasonality":
        lines.append(_window_line("All 7 eligible, run A", window_stats(result["A"], "2011-04-29")))
        lines.append(_window_line("All 7 eligible, run B", window_stats(result["B"], "2011-04-29")))
        lines += _attribution_lines("A", result["A"])
        lines.append("- First eligible month-ends: " + ", ".join(
            f"{s} {d}" for s, d in data.facts.starts["qc-same-month-seasonality"].items()) + ".")
    return lines


def _quintile_lines(tables: dict) -> list[str]:
    lines = ["", (f"VIX predicts index returns (descriptive, not a run): {tables['observations']} month-ends "
             f"{tables['first']} to {tables['last']}, next-month SPY total return."), ""]
    for name, title in (("percentile", "Two-year VIX percentile (504-value window)"),
                        ("level", "Full-sample VIX level quintiles (uses future data)")):
        table = tables[name]
        lines += [f"{title}:", "", "|Quintile|Count|Mean|Median|Share positive|Std|t|", "|---|---|---|---|---|---|---|"]
        for q, row in table["rows"].items():
            lines.append(f"|Q{q}|{row['n']}|{_fmt(row['mean'], 3, True)}|{_fmt(row['median'], 3, True)}|"
                         f"{_fmt(row['positive'], 2, True)}|{_fmt(row['std'], 3, True)}|{_fmt(row['t'])}|")
        lines += ["", f"Q5 − Q1: {_fmt(table['q5MinusQ1'], 3, True)} (Welch t {_fmt(table['welchT'])}).", ""]
    lines.append("By term structure from 2006-07-31: " + "; ".join(
        f"{name} n {row['n']}, mean {_fmt(row['mean'], 3, True)}, t {_fmt(row['t'])}"
        for name, row in sorted(tables["term"].items())) + ".")
    return lines
