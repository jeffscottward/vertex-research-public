"""Idle budget of the funded pie: who gets the vol-premium 1% while its gate is closed? (research only)

Places no order, creates no deployment request, opens no database and no network connection. It reads
the local CSV files of --data, replays the pie of funded_pie.py and writes one JSON document to --out.

The pie has three sleeves: long index 2% (SPY and QQQ call debit verticals, 1% each), rotation 1% and
vol premium 1% (`regime-put-vrp/A`, an SPY put credit vertical behind the volatility-regime gate). While
the gate is closed the vol-premium 1% is cash. The variants:

- `cash`: the pie as it is (the baseline);
- `rotation`: the idle 1% goes to the rotation position (1% -> 2%);
- `longIndex`: the idle 1% goes to the long index (SPY and QQQ 1% -> 1.5% each);
- `split`: half each (rotation 1% -> 1.5%, SPY and QQQ 1% -> 1.25% each).

The move is decided per position on its decision day (the session before its entry bar) and only with
what is known at that close: the gate is closed on that day (the vol-premium definition without its
portfolio block, so its entry rule and its volRegime filter per daily bar) and the vol-premium sleeve
has its budget free at the entry. A position keeps its size until its own exit.

No new cap logic: the added budget is offered to `allocation.combine` as a second entry of the same
spread that belongs to the vol-premium sleeve. So the 1% sleeve budget, the 2% per underlying and the 4%
open risk of `allocation.Caps` decide, in that order of books: every position of the pie first, then the
additions. An accepted addition is then merged into its position (one spread, one size), which may not
pass the 2% per position of book.MAX_LOSS_PCT_CAP: `check_extra` refuses such a variant before any run.
An addition whose own position the caps refused is dropped. The lent budget is busy until that position
exits: a vol-premium entry in that time is refused by its sleeve cap (counted in `capRefusals`).

Windows: `strong` and `contrast` by the rules of deploy_rehearsal.py, `full-core7` added by hand
(2020-04-01 to 2020-09-30), each from no position; `full` is the whole common history of the three
sleeves. Option model: options.py (the study model) only. Every run gets the Monte Carlo of the trade
P&L (allocation.monte_carlo, MONTE_CARLO_PATHS paths); the report shows the drawdown of the worst path.
The worst of 1000 paths moves with the seed, so the full history also has the worst path of
MONTE_CARLO_SEEDS seeds, and the stress windows of funded_pie.STRESS.

Limits: the variants are new trials chosen after the study; a window has 4 to 6 monthly decisions; the
Monte Carlo draws trades one by one, so it does not keep the losses of one month together; an addition
is all or nothing (a position that cannot take all of it gets none of it).

Run (rig, venv with the Nautilus lock; this machine only):
  python research/backtests/allocation/idle_budget.py --data <qc-ports data dir> \
      --capital <account value, rounded> --out <report work dir>/idle-budget.json
"""
from __future__ import annotations

import argparse
import bisect
import dataclasses
import json
import math
import sys
import time
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parents[2] / "services" / "research"))

import funded_pie as fp  # noqa: E402
import run as base  # noqa: E402
from strategies.qc_ports import allocation as al  # noqa: E402
from strategies.qc_ports import ideas as qi  # noqa: E402
from strategies.qc_ports import portfolio as pf  # noqa: E402
from strategies.qc_ports import study  # noqa: E402
from strategies.qc_ports.book import MAX_LOSS_PCT_CAP, PricedTrade  # noqa: E402
from strategies.qc_ports.ledger import run_ledger  # noqa: E402

IDLE_KEY = "regime-put-vrp/A"
ROTATION_KEY = "momentum-rotation/A"
LONG_INDEX_KEY = "oil-predicts-equity/B"
IDLE_SUFFIX = "+idle"
OPEN = "9999-12-31"
SLACK = 1e-9
MONTE_CARLO_SEEDS = (1, 2, 3, 4, 5)
# variant -> receiving sleeve (run key) -> share of the idle budget
VARIANTS = {
    "cash": {},
    "rotation": {ROTATION_KEY: 1.0},
    "longIndex": {LONG_INDEX_KEY: 1.0},
    "split": {ROTATION_KEY: 0.5, LONG_INDEX_KEY: 0.5},
}
LABELS = {"cash": "idle stays cash (baseline)", "rotation": "idle 1% -> rotation", "longIndex": "idle 1% -> long index",
          "split": "idle 0.5% -> rotation, 0.5% -> long index"}
HAND_WINDOWS = {"full-core7": ("2020-04-01", "2020-09-30")}
FULL_STAT_KEYS = ("start", "end", "days", "cagr", "sharpe", "oosSharpe", "volatility", "worstMonth", "worstMonthReturn",
                  "winRate", "totalReturn", "timeInCash", "maxOpenRisk")


# --------------------------------------------------------------------------- the move

def variant_extra(shares: Mapping[str, float]) -> dict[str, float]:
    """Run key -> percent of equity added to each position of that sleeve, from its share of the idle budget.

    A sleeve of budget B holds B / POSITION_RISK_PCT positions, so each gets the same part of the share.
    """
    if any(key not in fp.POOL or key == IDLE_KEY for key in shares):
        raise ValueError(f"refused: the idle budget can go to a funded sleeve other than {IDLE_KEY} only")
    if any(not (math.isfinite(share) and share >= 0) for share in shares.values()) or sum(shares.values()) > 1 + SLACK:
        raise ValueError("refused: the shares of the idle budget must be 0 or more and sum to at most 1")
    idle = fp.POOL[IDLE_KEY][1]
    return {key: idle * share * fp.POSITION_RISK_PCT / fp.POOL[key][1] for key, share in shares.items()}


def check_extra(extra: Mapping[str, float], risk_pct: Mapping[str, float], caps: al.Caps) -> float:
    """The per-position cap in percent; raises when a position with its addition would pass it."""
    cap = min(MAX_LOSS_PCT_CAP, caps.name_risk_pct)
    for key, added in extra.items():
        if not (math.isfinite(added) and added >= 0):
            raise ValueError(f"refused: the addition to {key} must be 0 or more")
        total = risk_pct.get(key, 0.0) + added
        if total > cap + SLACK:
            raise ValueError(f"refused: {key} would hold {total:g}% of equity per position, above the {cap:g}% cap")
    return cap


def decision_day(calendar: Sequence[str], entry_date: str) -> str | None:
    """The session before the entry bar: the close the entry was decided on."""
    at = bisect.bisect_left(calendar, entry_date)
    return calendar[at - 1] if at > 0 else None


def _spread(trade: PricedTrade) -> tuple:
    return (trade.symbol, trade.structure, trade.entry_date, trade.exit_date, trade.expiry, trade.long_strike,
            trade.short_strike)


@dataclass(frozen=True)
class Lent:
    """The pie with the idle budget lent. `combined.refused` has the additions under `<run key>+idle`."""

    combined: al.Combined
    topped: Mapping[int, float]  # trade id -> percent of equity added to that position
    applied: tuple[str, ...]  # decision days on which at least one position got the idle budget
    offered: int  # positions decided on a closed-gate day (each was offered the addition)
    dropped: int  # additions not made because the caps refused the position itself


def lend_idle(books: Mapping[str, Sequence[PricedTrade]], risk_pct: Mapping[str, float], caps: al.Caps,
              extra: Mapping[str, float], closed: Mapping[str, bool], calendar: Sequence[str],
              idle_key: str = IDLE_KEY) -> Lent:
    """`allocation.combine` of `books`, with `extra` percent added to the positions decided on a closed-gate day.

    `closed`: day -> the gate of `idle_key` is closed at that close. Only a day with the value True moves
    budget; a day after the decision is never read. Without `extra` the result is `combine(books)`.
    """
    cap = check_extra(extra, risk_pct, caps)
    lender = {key + IDLE_SUFFIX: key for key, added in extra.items() if added > 0}
    if lender and idle_key not in caps.sleeve_of:
        raise ValueError(f"refused: {idle_key} has no sleeve budget to lend")
    offers: dict[str, list[PricedTrade]] = {}
    for top, key in lender.items():
        if len({_spread(trade) for trade in books[key]}) != len(books[key]):
            raise ValueError(f"{key} has the same spread twice")
        offers[top] = [trade for trade in books[key] if closed.get(decision_day(calendar, trade.entry_date)) is True]
    offered = sum(len(trades) for trades in offers.values())
    limits = dataclasses.replace(caps, sleeve_of={**caps.sleeve_of, **dict.fromkeys(lender, caps.sleeve_of.get(idle_key))})
    risks = {**risk_pct, **{top: extra[key] for top, key in lender.items()}}
    dropped = 0
    while True:
        combined = al.combine({**books, **offers}, risks, limits)
        taken = {(combined.owner[trade.trade_id], _spread(trade)) for trade in combined.trades}
        # The first addition without its position: everything before it is final, so drop it and combine again.
        orphan = next((trade for trade in combined.trades if combined.owner[trade.trade_id] in lender
                       and (lender[combined.owner[trade.trade_id]], _spread(trade)) not in taken), None)
        if orphan is None:
            break
        top = combined.owner[orphan.trade_id]
        offers[top] = [trade for trade in offers[top] if _spread(trade) != _spread(orphan)]
        dropped += 1
    added = {(lender[combined.owner[trade.trade_id]], _spread(trade)): risks[combined.owner[trade.trade_id]]
             for trade in combined.trades if combined.owner[trade.trade_id] in lender}
    trades, owner, topped, days = [], {}, {}, set()
    for trade in combined.trades:
        key = combined.owner[trade.trade_id]
        if key in lender:
            continue
        number = len(trades) + 1
        more = added.get((key, _spread(trade)), 0.0)
        if trade.max_loss_pct + more > cap + SLACK:
            raise RuntimeError(f"{key} {trade.symbol} {trade.entry_date} would pass the {cap:g}% per-position cap")
        trades.append(dataclasses.replace(trade, trade_id=number, max_loss_pct=trade.max_loss_pct + more))
        owner[number] = key
        if more:
            topped[number] = more
            days.add(decision_day(calendar, trade.entry_date))
    return Lent(al.Combined(tuple(trades), owner, combined.refused), topped, tuple(sorted(days)), offered, dropped)


def budget_peaks(trades: Sequence[PricedTrade]) -> dict:
    """Largest open budget of the account, of one underlying and of one position (percent of equity at entry).

    Counted as `combine` counts: a position holds its budget from its entry until its exit date, and an
    exit frees it before the entries of that day. An independent check of the result, not the cap logic.
    """
    open_trades: list[PricedTrade] = []
    peak_open = peak_name = 0.0
    for trade in sorted(trades, key=lambda item: (item.entry_date, item.trade_id)):
        open_trades = [item for item in open_trades if item.exit_date > trade.entry_date]
        open_trades.append(trade)
        peak_open = max(peak_open, sum(item.max_loss_pct for item in open_trades))
        peak_name = max(peak_name, sum(item.max_loss_pct for item in open_trades if item.symbol == trade.symbol))
    return {"openPct": peak_open, "namePct": peak_name, "positionPct": max((trade.max_loss_pct for trade in trades), default=0.0)}


# --------------------------------------------------------------------------- data of the pie

def pie_caps() -> al.Caps:
    """The caps of funded_pie.model_run."""
    return al.Caps(open_risk_pct=fp.OPEN_RISK_CAP_PCT, name_risk_pct=fp.NAME_RISK_CAP_PCT,
                   sleeve_of={key: fp.POOL[key][0] for key in fp.POOL},
                   sleeve_risk_pct={sleeve: budget for sleeve, budget in fp.POOL.values()})


def gate_closed_days(definition: Mapping, data: pf.Dataset) -> dict[str, bool]:
    """Day -> the vol-premium sleeve would not open at that close (its entry rule and filters per daily bar).

    The definition without its portfolio block: no month-end cadence, so every SPY bar has a value. The
    gate reads VIX, VIX3M and the SPY closes up to that day (signals._vol_regime_mask).
    """
    if not any(item.get("type") == "volRegime" for item in definition.get("filters", [])):
        raise ValueError("The idle sleeve has no volRegime gate")
    symbols = definition["portfolio"]["symbols"]
    if len(symbols) != 1:
        raise ValueError("The gate is read on one symbol")
    probe = {key: value for key, value in definition.items() if key != "portfolio"}
    al.sig.normalize_definition(probe)
    _legs, flags, _selected = pf._signals(probe, data, symbols[0])
    return {day: not is_open for day, is_open in zip(data.bars[symbols[0]].dates, flags[0][0], strict=True)}


def window_books(made: Mapping[str, tuple[dict, str]], data: pf.Dataset, start: str, end: str) -> dict[str, list[PricedTrade]]:
    """The trades of each sleeve that enter in [start, end], from no position (deploy_rehearsal.trace_signals)."""
    before = [day for day in data.calendar if day < start]
    books = {}
    for key in fp.POOL:
        definition, sleeve_start = made[key]
        signal_start = max(sleeve_start, before[-1] if before else start)
        books[key] = [trade for trade in al.owner_rule_trades(definition, data, start=signal_start)
                      if start <= trade.entry_date <= end]
    return books


def full_books(made: Mapping[str, tuple[dict, str]], data: pf.Dataset) -> tuple[str, dict[str, list[PricedTrade]]]:
    """(first day all three sleeves can run, their trades from that day): the books of funded_pie.model_run."""
    start = max(made[key][1] for key in fp.POOL)
    return start, {key: [trade for trade in al.owner_rule_trades(made[key][0], data, start=made[key][1])
                         if trade.entry_date >= start] for key in fp.POOL}


def decisions_in(calendar: Sequence[str], start: str, end: str) -> list[str]:
    """Month ends whose entry bar (the next session) is in [start, end]."""
    return [calendar[index] for index in pf.month_end_indices(calendar) if start <= calendar[index + 1] <= end]


# --------------------------------------------------------------------------- one run

def _at_risk(result, trades: Sequence[PricedTrade], end: str) -> dict:
    """Average and peak percent of equity at risk on the run days up to `end` (deploy_rehearsal's count)."""
    max_loss = {trade.trade_id: trade.max_loss for trade in trades}
    budget = [(trade.entry_date, OPEN if trade.exit_reason == "end" else trade.exit_date, trade.max_loss_pct) for trade in trades]
    spans = [(record["entryDate"], OPEN if record["exitReason"] == "end" else record["exitDate"],
              record["contracts"] * max_loss[record["id"]]) for record in result.trades]
    sized, reserved = [], []
    for day, equity in zip(result.dates, result.equity):
        if day > end:
            break
        sized.append(100.0 * sum(amount for first, last, amount in spans if first <= day < last) / equity)
        reserved.append(sum(pct for first, last, pct in budget if first <= day < last))
    if not sized:
        raise ValueError(f"No session up to {end}")
    return {"averageAtRiskPct": sum(sized) / len(sized), "peakAtRiskPct": max(sized),
            "averageReservedPct": sum(reserved) / len(reserved), "peakReservedPct": max(reserved), "days": len(sized)}


def replay(books: Mapping[str, Sequence[PricedTrade]], extra: Mapping[str, float], closed: Mapping[str, bool],
           calendar: Sequence[str], capital: float, start: str, end: str, *, nautilus: bool, full: bool = False) -> dict:
    """One variant on one set of books: the caps, the sizing run and its numbers."""
    caps = pie_caps()
    lent = lend_idle(books, dict.fromkeys(fp.POOL, fp.POSITION_RISK_PCT), caps, extra, closed, calendar)
    trades, owner = lent.combined.trades, lent.combined.owner
    peaks = budget_peaks(trades)
    if (peaks["openPct"] > caps.open_risk_pct + SLACK or peaks["namePct"] > caps.name_risk_pct + SLACK
            or peaks["positionPct"] > MAX_LOSS_PCT_CAP + SLACK):
        raise RuntimeError(f"A cap does not hold: {peaks}")
    dates = [day for day in calendar if day >= start]
    if nautilus:
        result, gap, engine = base.nautilus_run(trades, capital, dates)
    else:
        result, gap, engine = run_ledger(trades, capital, dates=dates), None, "ledger only"
    per_sleeve = {key: {"trades": 0, "pnl": 0.0, "toppedTrades": 0, "toppedPnl": 0.0} for key in fp.POOL}
    for record in result.trades:
        bucket = per_sleeve[owner[record["id"]]]
        bucket["trades"] += 1
        bucket["pnl"] += record["pnl"]
        if record["id"] in lent.topped:
            bucket["toppedTrades"] += 1
            bucket["toppedPnl"] += record["pnl"]
    pnl = sum(record["pnl"] for record in result.trades)
    worst = min(result.trades, key=lambda record: record["pnl"], default=None)
    curve = al.window_metrics(result, result.dates[0], result.dates[-1])
    base_keys = {key: dict(reasons) for key, reasons in lent.combined.refused.items() if not key.endswith(IDLE_SUFFIX)}
    move_refused: dict[str, int] = {}
    for key, reasons in lent.combined.refused.items():
        if key.endswith(IDLE_SUFFIX):
            for reason, count in reasons.items():
                move_refused[reason] = move_refused.get(reason, 0) + count
    out = {
        "engine": engine, "nautilusGap": gap,
        "positionPct": {key: fp.POSITION_RISK_PCT + extra.get(key, 0.0) for key in fp.POOL},
        "trades": len(result.trades), "sizedToZero": len(result.skipped), "pnl": pnl, "pnlPct": 100.0 * pnl / capital,
        "finalEquity": result.equity[-1], "maxDrawdownPct": 100.0 * curve["maxDrawdown"] if curve else 0.0,
        **_at_risk(result, trades, end),
        "worstTrade": None if worst is None else {
            "pnl": worst["pnl"], "pnlPct": 100.0 * worst["pnl"] / capital, "sleeve": owner[worst["id"]], "symbol": worst["symbol"],
            "entryDate": worst["entryDate"], "exitDate": worst["exitDate"], "contracts": worst["contracts"],
            "topped": worst["id"] in lent.topped},
        "move": {"offeredPositions": lent.offered, "appliedPositions": len(lent.topped), "appliedDecisions": len(lent.applied),
                 "appliedDecisionDays": list(lent.applied), "refusedByCaps": move_refused,
                 "droppedWithItsPosition": lent.dropped},
        "capRefusals": {"pie": base_keys, "pieTotal": sum(sum(reasons.values()) for reasons in base_keys.values()),
                        "moveTotal": sum(move_refused.values())},
        "budgetPeaks": peaks, "perSleeve": per_sleeve,
        "monteCarlo": al.monte_carlo([record["pnl"] for record in result.trades], capital),
    }
    if full:
        stats = base.run_stats(result, trades, capital, 1, None)
        out["stats"] = {key: stats[key] for key in FULL_STAT_KEYS}
        out["stress"] = {label: al.window_metrics(result, *span) for label, span in fp.STRESS.items()}
        # The worst path of 1000 depends on the seed: the same Monte Carlo with more seeds, and the worst of all.
        worst_by_seed = {seed: al.monte_carlo([record["pnl"] for record in result.trades], capital, seed=seed)["worstDrawdown"]
                         for seed in MONTE_CARLO_SEEDS} if result.trades else {}
        out["monteCarloSeeds"] = {"worstDrawdownBySeed": worst_by_seed, "worstDrawdown": min(worst_by_seed.values(), default=None)}
        out["baselineByGate"] = _by_gate(result, owner, closed, calendar) if not extra else None
    return out


def _by_gate(result, owner: Mapping[int, str], closed: Mapping[str, bool], calendar: Sequence[str]) -> dict:
    """Per sleeve: trades decided on a closed-gate day against the others (count, P&L, wins)."""
    table = {key: {state: {"trades": 0, "pnl": 0.0, "wins": 0} for state in ("gateClosed", "gateOpen")} for key in fp.POOL}
    for record in result.trades:
        state = "gateClosed" if closed.get(decision_day(calendar, record["entryDate"])) is True else "gateOpen"
        bucket = table[owner[record["id"]]][state]
        bucket["trades"] += 1
        bucket["pnl"] += record["pnl"]
        bucket["wins"] += record["pnl"] > 0
    return table


# --------------------------------------------------------------------------- the study

def study_windows(data: pf.Dataset, made: Mapping[str, tuple[dict, str]], extra: Mapping[str, tuple[str, str]]) -> dict:
    """The windows of deploy_rehearsal.main: `strong` and `contrast` by its rules, then the ones added by hand."""
    import deploy_rehearsal as dr  # here, not at the top: it loads the exec-node order policy, which the tests do not need

    spy = data.bars["SPY"]
    first_all = max(start for _definition, start in made.values())
    year, month = int(first_all[:4]), int(first_all[5:7])
    first_month = f"{year + month // 12:04d}-{month % 12 + 1:02d}"
    windows = {"strong": dr.strong_window(spy.dates, spy.adj_close, first_month), "contrast": dr.contrast_window(data.calendar)}
    for name, (start, end) in extra.items():
        windows[name] = {"rule": "added by hand as a check, not by the rule", "start": start, "end": end}
    return {name: {"rule": window["rule"], "start": window["start"], "end": window["end"]} for name, window in windows.items()}


def run_study(data: pf.Dataset, made: Mapping[str, tuple[dict, str]], windows: Mapping[str, Mapping], capital: float,
              nautilus: bool) -> dict:
    """Every variant on every window and on the full common history."""
    calendar = data.calendar
    closed = gate_closed_days(made[IDLE_KEY][0], data)
    extras = {name: variant_extra(shares) for name, shares in VARIANTS.items()}
    for extra in extras.values():
        check_extra(extra, dict.fromkeys(fp.POOL, fp.POSITION_RISK_PCT), pie_caps())
    out = {}
    full_start, everything = full_books(made, data)
    spans = {**{name: (window, False) for name, window in windows.items()},
             "full": ({"rule": "the whole common history of the three sleeves", "start": full_start, "end": calendar[-1]}, True)}
    for name, (window, full) in spans.items():
        start, end = window["start"], window["end"]
        books = everything if full else window_books(made, data, start, end)
        days = decisions_in(calendar, start, end)
        out[name] = {
            "window": dict(window), "decisions": len(days), "gateClosedDecisions": sum(1 for day in days if closed.get(day) is True),
            "offered": {key: len(trades) for key, trades in books.items()},
            "variants": {variant: replay(books, extra, closed, calendar, capital, start, end, nautilus=nautilus, full=full)
                         for variant, extra in extras.items()},
        }
    return out


def cap_probe() -> dict:
    """A variant above the per-position cap, to show the refusal in the report (it never runs)."""
    extra = {ROTATION_KEY: fp.POOL[IDLE_KEY][1] + 0.5}
    try:
        check_extra(extra, dict.fromkeys(fp.POOL, fp.POSITION_RISK_PCT), pie_caps())
    except ValueError as error:
        return {"extraPct": extra, "refused": True, "reason": str(error)}
    return {"extraPct": extra, "refused": False, "reason": None}


def markdown(document: Mapping) -> str:
    head = ("| Window | Variant | Trades | P&L $ | P&L % | vs cash $ | Max DD % | Avg at risk % | Peak at risk % | Peak budget % "
            "| Worst trade $ | Move applied: decisions (positions) / closed-gate decisions / decisions | Cap refusals: pie / move |")
    lines = [head, "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |"]
    for name, window in document["windows"].items():
        cash = window["variants"]["cash"]["pnl"]
        for variant, run in window["variants"].items():
            move = run["move"]
            worst = run["worstTrade"]["pnl"] if run["worstTrade"] else 0.0
            lines.append(
                f"| {name} {window['window']['start']}..{window['window']['end']} | {variant} | {run['trades']} | {run['pnl']:+,.0f} "
                f"| {run['pnlPct']:+.2f} | {run['pnl'] - cash:+,.0f} | {run['maxDrawdownPct']:.2f} | {run['averageAtRiskPct']:.2f} "
                f"| {run['peakAtRiskPct']:.2f} | {run['budgetPeaks']['openPct']:.2f} | {worst:+,.0f} "
                f"| {move['appliedDecisions']} ({move['appliedPositions']}) / "
                f"{window['gateClosedDecisions']} / {window['decisions']} | {run['capRefusals']['pieTotal']} / "
                f"{run['capRefusals']['moveTotal']} |")
    head = ("| Full history | Annual return % | Sharpe | Out-of-sample Sharpe | Max DD % | Monte Carlo worst run DD % "
            f"| Worst run of {len(MONTE_CARLO_SEEDS)} seeds DD % | Monte Carlo DD p5 % | Monte Carlo P(profit) "
            + "".join(f"| {label}: return % / max DD % " for label in fp.STRESS) + "| Vol-premium trades |")
    lines += ["", head, "| --- " + "| ---: " * (head.count("|") - 2) + "|"]
    for variant, run in document["windows"]["full"]["variants"].items():
        stats, carlo = run["stats"], run["monteCarlo"] or {}
        stress = "".join(f"| {100 * item['return']:+.2f} / {100 * item['maxDrawdown']:.2f} " if item else "| - "
                         for item in (run["stress"][label] for label in fp.STRESS))
        lines.append(
            f"| {variant} | {100 * stats['cagr']:+.2f} | {stats['sharpe']:+.2f} | {stats['oosSharpe']:+.2f} | {run['maxDrawdownPct']:.2f} "
            f"| {100 * carlo.get('worstDrawdown', 0.0):.2f} | {100 * (run['monteCarloSeeds']['worstDrawdown'] or 0.0):.2f} "
            f"| {100 * carlo.get('drawdownP5', 0.0):.2f} | {carlo.get('probabilityOfProfit', 0.0):.3f} {stress}"
            f"| {run['perSleeve'][IDLE_KEY]['trades']} |")
    limits = document["limits"]
    head = (f"Percent of equity per position while the gate is closed (pie figure {limits['positionRiskPct']:g}%, "
            f"owner gate {limits['positionRiskCapPct']:g}%):")
    lines += ["", head]
    for variant, item in document["variants"].items():
        sizes = ", ".join(f"{fp.POOL[key][0]} {value:g}%" for key, value in item["positionPct"].items() if key != IDLE_KEY)
        lines.append(f"- {variant}: {sizes}" + (" (above the pie's figure, within the owner gate)" if item["aboveThePieFigure"] else ""))
    engines = sorted({run["engine"] for window in document["windows"].values() for run in window["variants"].values()})
    note = (f"Engine: {', '.join(engines)}. Peak at risk is against the equity of that day; peak budget is against the equity "
            "at each entry, which is what the caps limit.")
    return "\n".join([*lines, "", note])


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--data", required=True)
    parser.add_argument("--capital", type=float, required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--ledger-only", action="store_true", help="skip the NautilusTrader parity run")
    parser.add_argument("--extra-window", action="append", default=[], metavar="NAME=START:END", help="one more window")
    args = parser.parse_args()
    loaded = study.load_study_data(str(Path(args.data).expanduser()))
    data = loaded.dataset
    made = fp.sleeve_definitions(qi.family(loaded.facts), loaded.facts)
    hand = dict(HAND_WINDOWS)
    for item in args.extra_window:
        name, span = item.split("=", 1)
        hand[name] = (span.split(":")[0], span.split(":")[1])
    windows = study_windows(data, made, hand)
    caps = pie_caps()
    variants = {}
    for name, shares in VARIANTS.items():
        extra = variant_extra(shares)
        sizes = {key: fp.POSITION_RISK_PCT + extra.get(key, 0.0) for key in fp.POOL}
        variants[name] = {"label": LABELS[name], "shareOfIdle": dict(shares), "extraPctPerPosition": extra, "positionPct": sizes,
                          "aboveThePieFigure": max(sizes.values()) > fp.POSITION_RISK_PCT + SLACK,
                          "withinTheOwnerGate": max(sizes.values()) <= MAX_LOSS_PCT_CAP + SLACK}
    document = {
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "capital": args.capital, "dataEnd": data.calendar[-1],
        "optionModel": "study (options.py)", "monteCarloPaths": al.MONTE_CARLO_PATHS,
        "pool": {key: {"sleeve": sleeve, "budgetPct": budget} for key, (sleeve, budget) in fp.POOL.items()},
        "limits": {"positionRiskPct": fp.POSITION_RISK_PCT, "positionRiskCapPct": MAX_LOSS_PCT_CAP,
                   "openRiskCapPct": caps.open_risk_pct, "nameRiskCapPct": caps.name_risk_pct},
        "idleSleeve": IDLE_KEY, "gate": [item for item in made[IDLE_KEY][0].get("filters", []) if item.get("type") == "volRegime"],
        "variants": variants, "capProbe": cap_probe(),
        "windows": run_study(data, made, windows, args.capital, not args.ledger_only),
        # True by construction: this file has no call that sends an order, opens a database or a network connection.
        "safety": {"ordersSent": 0, "rowsWritten": 0, "networkCalls": 0},
    }
    out = Path(args.out).expanduser()
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(document, indent=1))
    print(markdown(document))


if __name__ == "__main__":
    main()
