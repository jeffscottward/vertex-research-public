"""Order flow / AMT auction study: underlying ledger, options forms, split, statistics, verdict, NautilusTrader
replay and the forward order-flow check (research only; no order, no deployment).

Spec: docs/specs/strategies/order-flow-amt-auction.md. Underlying results use 5-minute bar prices; option results
are modelled (no historical option quotes exist in Vertex sources).
"""
from __future__ import annotations

import math
from collections import Counter, defaultdict
from collections.abc import Mapping, Sequence
from dataclasses import asdict, dataclass

from strategies.flow_control import options as booking
from strategies.flow_control.study import deflated_sharpe, row_stats
from strategies.imom.data import ms_at
from strategies.noise_band import Session
from strategies.qc_ports.data import Market

from . import options, rules
from .data import FlowMinute
from .rules import BAR_MINUTES, FULL_BARS, RULES, TIME_EXIT, Trade

SCHEMA = "order-flow-amt-auction-study-v1"
NOTIONAL = 100_000.0
CAPITAL = 100_000.0
COST_BPS = 1.0  # per side
COMMISSION_PER_SHARE = 0.0035  # per side
STRESS = 2.0
HISTORY_LAST = "2026-11-06"  # last IBKR session; later sessions are the forward window
SPLIT = (0.6, 0.2, 0.2)
GAP_SESSIONS = 5
MIN_OOS_TRADES = 100
MIN_OOS_OPTION_TRADES = 30
DSR_PASS = 0.95
ROWS = tuple(f"{form}-{rule}" for form in ("U", *options.FORMS) for rule in RULES)
TRIAL_ROWS = tuple(f"{form}-{rule}" for form in ("U", "0DTE") for rule in RULES)  # weekly rows: report only
N_TRIALS = len(TRIAL_ROWS)
PARTS = ("whole", "train", "validation", "test", "outOfSample")
FLOW_WINDOW_MINUTES = 30
# Order-flow sources per traded symbol. QQQ has no tick source; NQ starts 2026-11-16, after the forward window.
FLOW_PROXY = {"SPY": ("SPY", "ES")}
LIMIT_TEXT = "Underlying fills from 5-minute bars; option prices modelled (no historical quotes)."


def usd(value: float | None) -> str:
    return "n/a" if value is None else (f"$-{abs(value):,.0f}" if value < 0 else f"${value:,.0f}")


# --- underlying ledger --------------------------------------------------------------------------------------------

def trade_net(trade: Trade, cost_multiple: float = 1.0) -> float:
    """Net USD on NOTIONAL at the entry price: points minus commission and COST_BPS per side."""
    shares = NOTIONAL / trade.entry_price
    gross = shares * trade.side * (trade.exit_price - trade.entry_price)
    costs = shares * (2 * COMMISSION_PER_SHARE + COST_BPS / 10_000 * (trade.entry_price + trade.exit_price))
    return gross - cost_multiple * costs


def daily_pnl(values: Sequence[tuple[str, float]], days: Sequence[str]) -> list[float]:
    by_day: dict[str, float] = defaultdict(float)
    for day, value in values:
        by_day[day] += value
    return [by_day.get(day, 0.0) for day in days]


# --- split --------------------------------------------------------------------------------------------------------

@dataclass(frozen=True)
class Split:
    train: tuple[str, ...]
    validation: tuple[str, ...]
    test: tuple[str, ...]

    @property
    def out_of_sample(self) -> tuple[str, ...]:
        return self.validation + self.test


def split_days(days: Sequence[str]) -> Split:
    """60/20/20 by time with GAP_SESSIONS sessions left out between the parts."""
    usable = len(days) - 2 * GAP_SESSIONS
    if usable < 30:
        raise ValueError(f"{len(days)} sessions; the split needs at least {30 + 2 * GAP_SESSIONS}")
    n_train = math.floor(SPLIT[0] * usable)
    n_validation = math.floor(SPLIT[1] * usable)
    return Split(tuple(days[:n_train]),
                 tuple(days[n_train + GAP_SESSIONS:n_train + GAP_SESSIONS + n_validation]),
                 tuple(days[n_train + 2 * GAP_SESSIONS + n_validation:]))


def part_days(split: Split, days: Sequence[str]) -> dict[str, tuple[str, ...]]:
    return {"whole": tuple(days), "train": split.train, "validation": split.validation, "test": split.test,
            "outOfSample": split.out_of_sample}


# --- verdict ------------------------------------------------------------------------------------------------------

def verdict_of(rule: str, oos_trades: int, oos_net: float, dsr: Mapping, option_net: float | None,
               option_trades: int = MIN_OOS_OPTION_TRADES, replay_same: bool | None = True) -> tuple[str, str]:
    """U row first (trade count, then net and deflated Sharpe); only a passing U row looks at the 0DTE row and
    the NautilusTrader replay."""
    head = f"Rule {rule}: {oos_trades} out-of-sample trades, net {usd(oos_net)} after costs"
    if oos_trades < MIN_OOS_TRADES:
        return "needs-more-data", f"Needs more data. {head} ({MIN_OOS_TRADES} needed). {LIMIT_TEXT}"
    p = dsr.get("probability")
    dsr_text = "deflated Sharpe not computable" if p is None else f"deflated Sharpe {p:.3f} (bar 0.95, N = {N_TRIALS})"
    if p is None or oos_net <= 0 or p < DSR_PASS:
        return "no-edge", f"No edge. {head}, {dsr_text}. {LIMIT_TEXT}"
    option_text = f"0DTE form out-of-sample net {usd(option_net)} over {option_trades} trades"
    if option_trades < MIN_OOS_OPTION_TRADES:
        return "needs-more-data", (f"Needs more data. {head}, {dsr_text}, {option_text} "
                                   f"({MIN_OOS_OPTION_TRADES} needed). {LIMIT_TEXT}")
    if option_net is None or option_net <= 0:
        return "no-edge", f"No edge in the option form. {head}, {dsr_text}, {option_text}. {LIMIT_TEXT}"
    if replay_same is not True:
        return "no-edge", (f"No edge: the NautilusTrader replay did not confirm the fills. {head}, {dsr_text}, "
                           f"{option_text}. {LIMIT_TEXT}")
    return "edge", f"Edge. {head}, {dsr_text}, {option_text}. {LIMIT_TEXT}"


# --- NautilusTrader replay ----------------------------------------------------------------------------------------

def engine_trades(sessions: Sequence[Session], trades: Sequence[Trade], side: int) -> list[tuple]:
    """(day, entry bar, exit bar, entry price, exit price) of one NautilusTrader run over the sessions with a trade
    of `side` (no position crosses a session, so the other sessions change nothing)."""
    from nautilus_backtest.bars import Bars
    from nautilus_backtest.engine import run_signal_backtest
    from nautilus_backtest.signals import Compiled, RunOptions

    by_day = {trade.day: trade for trade in trades if trade.side == side}
    chosen = [session for session in sessions if session.day.isoformat() in by_day]
    if not chosen:
        return []
    t, o, h, low, c, signals, stops, targets, close_at = [], [], [], [], [], [], [], [], []
    for session in chosen:
        day = session.day.isoformat()
        t += [int(ms_at(day, options.OPEN_MINUTE_OF_DAY + bar.minute)) for bar in session.bars]
        o += [bar.open for bar in session.bars]
        h += [bar.high for bar in session.bars]
        low += [bar.low for bar in session.bars]
        c += [bar.close for bar in session.bars]
        s, st, tg, ca = rules.signal_arrays(by_day[day], side)
        signals += s
        stops += st
        targets += tg
        close_at += ca
    bars = Bars.from_columns({"t": t, "o": o, "h": h, "l": low, "c": c})
    compiled = Compiled(signals=tuple(signals), exits=None, stop_distance=tuple(stops),
                        target_distance=tuple(targets), close_at=tuple(close_at))
    run_options = RunOptions(cost_bps=0, stop_loss_pct=0, take_profit_pct=0, costs=None,
                             side="short" if side < 0 else None)
    result = run_signal_backtest(bars, compiled, run_options)
    out = []
    for item in result.trades:
        s_in, entry_bar = divmod(item["entryIndex"], FULL_BARS)
        _, exit_bar = divmod(item["exitIndex"], FULL_BARS)
        out.append((chosen[s_in].day.isoformat(), entry_bar, exit_bar, item["entryPrice"], item["exitPrice"]))
    return out


def nautilus_check(sessions: Mapping[str, Sequence[Session]], trades: Mapping[str, Mapping[str, Sequence[Trade]]],
                   tolerance: float = 1e-6) -> dict:
    from nautilus_backtest import engine

    try:
        engine.require()
    except engine.NautilusUnavailable as error:
        return {"status": "not run", "reason": str(error)[:200]}
    mismatches: list[dict] = []
    booked = total = 0
    for symbol, symbol_sessions in sessions.items():
        for rule in RULES:
            for side in (1, -1):
                ours = sorted((t for t in trades[symbol][rule] if t.side == side), key=lambda t: t.day)
                theirs = engine_trades(symbol_sessions, ours, side)
                booked += len(theirs)
                total += len(ours)
                for index in range(max(len(ours), len(theirs))):
                    a = ours[index] if index < len(ours) else None
                    b = theirs[index] if index < len(theirs) else None
                    same = (a is not None and b is not None and a.day == b[0] and a.entry_bar == b[1]
                            and a.exit_bar == b[2]
                            and math.isclose(a.entry_price, b[3], rel_tol=0.0, abs_tol=tolerance)
                            and math.isclose(a.exit_price, b[4], rel_tol=0.0, abs_tol=tolerance))
                    if not same:
                        mismatches.append({"symbol": symbol, "rule": rule, "side": side,
                                           "study": None if a is None else [a.day, a.entry_bar, a.exit_bar,
                                                                            a.entry_price, a.exit_price,
                                                                            a.exit_reason],
                                           "engine": None if b is None else list(b)})
    return {"status": "ran", "engine": engine.ENGINE_ID, "trades": total, "booked": booked,
            "same": not mismatches and booked == total, "mismatchCount": len(mismatches),
            "mismatches": mismatches[:20]}


# --- forward order-flow check -------------------------------------------------------------------------------------

def flow_at(trade: Trade, flow: Mapping[str, Mapping[int, FlowMinute]]) -> dict:
    """True delta over the FLOW_WINDOW_MINUTES before the signal bar's close, per order-flow symbol."""
    end = int(ms_at(trade.day, options.OPEN_MINUTE_OF_DAY + BAR_MINUTES * (trade.signal_bar + 1)))
    out = {}
    for source in FLOW_PROXY.get(trade.symbol, ()):
        minutes = flow.get(source, {})
        rows = [minutes[m] for m in range(end - FLOW_WINDOW_MINUTES * 60_000, end, 60_000) if m in minutes]
        delta = sum(row.delta for row in rows)
        covered = sum(row.covered_seconds for row in rows)
        out[source] = {"minutes": len(rows), "coverage": covered / (FLOW_WINDOW_MINUTES * 60), "delta": delta,
                       "agrees": None if not rows or delta == 0 else (delta > 0) == (trade.side > 0)}
    return out


def forward_check(trades: Mapping[str, Mapping[str, Sequence[Trade]]],
                  flow: Mapping[str, Mapping[int, FlowMinute]]) -> dict:
    rows = []
    for symbol in sorted(trades):
        for rule in RULES:
            for trade in trades[symbol][rule]:
                if trade.day > HISTORY_LAST:
                    rows.append({"symbol": symbol, "rule": rule, "day": trade.day, "side": trade.side,
                                 "signalBar": trade.signal_bar, "exitReason": trade.exit_reason,
                                 "netUsd": trade_net(trade), "flow": flow_at(trade, flow)})
    agree = Counter(str(v["agrees"]) for row in rows for v in row["flow"].values())
    return {"window": f"after {HISTORY_LAST}", "signals": len(rows), "agreement": dict(agree), "rows": rows,
            "note": "Description only: true delta is not a filter in this study (decision record Q2)."}


# --- the run ------------------------------------------------------------------------------------------------------

def _held(trades: Sequence[Trade]) -> float:
    return sum(BAR_MINUTES * (t.exit_bar - t.entry_bar + 1) for t in trades)


def _stats(nets: Sequence[float], pnl_by_day: Mapping[str, float], days: Sequence[str], held: float) -> dict:
    pnl = [pnl_by_day.get(day, 0.0) for day in days]
    return row_stats(nets, pnl, days, CAPITAL, held, 2)


def _part_trades(trades: Sequence[Trade], days: Sequence[str]) -> list[Trade]:
    chosen = set(days)
    return [t for t in trades if t.day in chosen]


def by_time_of_day(trades: Sequence[Trade]) -> list[dict]:
    """Out-of-sample trades by the New York hour of the signal close (reported after the run; no trial)."""
    groups: dict[int, list[Trade]] = defaultdict(list)
    for trade in trades:
        minute = 570 + BAR_MINUTES * (trade.signal_bar + 1)
        groups[minute // 60].append(trade)
    return [{"hour": f"{hour:02d}:00", "trades": len(group), "netUsd": sum(trade_net(t) for t in group),
             "winRate": sum(trade_net(t) > 0 for t in group) / len(group)} for hour, group in sorted(groups.items())]


def run(sessions: Mapping[str, Sequence[Session]], markets: Mapping[str, Market],
        flow: Mapping[str, Mapping[int, FlowMinute]] | None, *, nautilus: bool = True,
        ex_dates: Mapping[str, frozenset[str]] | None = None) -> dict:
    ex_dates = ex_dates or {}
    trades = {symbol: rules.trades(symbol, symbol_sessions, ex_dates=ex_dates.get(symbol, frozenset()))
              for symbol, symbol_sessions in sessions.items()}
    days = sorted({s.day.isoformat() for symbol_sessions in sessions.values() for s in symbol_sessions
                   if rules.tradable(s) and s.day.isoformat() <= HISTORY_LAST})
    split = split_days(days)
    parts = part_days(split, days)
    history = {rule: [t for symbol in trades for t in trades[symbol][rule] if t.day <= HISTORY_LAST]
               for rule in RULES}

    rows: dict[str, dict] = {}
    oos_series: dict[str, list[float]] = {}
    for rule in RULES:
        row_trades = history[rule]
        for multiple, key in ((1.0, "base"), (STRESS, "stress")):
            nets = {id(t): trade_net(t, multiple) for t in row_trades}
            pnl_by_day: dict[str, float] = defaultdict(float)
            for t in row_trades:
                pnl_by_day[t.day] += nets[id(t)]
            stats = {}
            for part, part_list in parts.items():
                chosen = _part_trades(row_trades, part_list)
                stats[part] = _stats([nets[id(t)] for t in chosen], pnl_by_day, part_list, _held(chosen))
            rows.setdefault(f"U-{rule}", {})[key] = stats
            if key == "base":
                oos_series[f"U-{rule}"] = [pnl_by_day.get(day, 0.0) for day in split.out_of_sample]
        rows[f"U-{rule}"]["exits"] = dict(Counter(t.exit_reason for t in row_trades))
        rows[f"U-{rule}"]["bySymbol"] = {}
        for symbol in sorted(trades):
            mine = _part_trades([t for t in row_trades if t.symbol == symbol], split.out_of_sample)
            mine_by_day: dict[str, float] = defaultdict(float)
            for t in mine:
                mine_by_day[t.day] += trade_net(t)
            rows[f"U-{rule}"]["bySymbol"][symbol] = _stats([trade_net(t) for t in mine], mine_by_day,
                                                           split.out_of_sample, _held(mine))
        rows[f"U-{rule}"]["byTimeOfDay"] = by_time_of_day(_part_trades(row_trades, split.out_of_sample))

    option_books: dict[str, dict] = {}
    for form in options.FORMS:
        for rule in RULES:
            key = f"{form}-{rule}"
            spreads, skipped = [], []
            for symbol in trades:
                priced, missed = options.price_trades(form, [t for t in trades[symbol][rule] if t.day <= HISTORY_LAST],
                                                      markets[symbol])
                spreads += priced
                skipped += missed
            spreads.sort(key=lambda s: s.event.entry_ms)
            eligible = [d for d in days if d >= options.FIRST_DAY[form]]
            booked = booking.book_form(spreads, eligible, nautilus=nautilus) if spreads else None
            pnl = booking.session_pnl_from_equity(booked["points"], eligible, CAPITAL) if booked else [0.0] * len(eligible)
            pnl_by_day = dict(zip(eligible, pnl))
            nets_by_day: dict[str, list[float]] = defaultdict(list)
            if booked:
                for spread, net in zip(spreads, booking.trade_nets(booked["result"])):
                    nets_by_day[spread.day].append(net)
            stats = {}
            for part, part_list in parts.items():
                chosen = [d for d in part_list if d in pnl_by_day]
                nets = [n for d in chosen for n in nets_by_day.get(d, [])]
                stats[part] = _stats(nets, pnl_by_day, chosen, 0.0) if chosen else None
            stressed = [booking.stress_costs(spread) for spread in spreads]
            stress_book = booking.book_form(stressed, eligible, nautilus=False) if stressed else None
            stress_pnl = (dict(zip(eligible, booking.session_pnl_from_equity(stress_book["points"], eligible, CAPITAL)))
                          if stress_book else {})
            stress_oos = [d for d in split.out_of_sample if d in pnl_by_day]
            rows[key] = {"base": stats, "priced": len(spreads),
                         "stressOutOfSampleNetUsd": sum(stress_pnl.get(d, 0.0) for d in stress_oos),
                         "skipped": dict(Counter(item["reason"] for item in skipped)),
                         "firstDay": eligible[0] if eligible else None,
                         "nautilusMaxGap": None if booked is None else booked["maxGap"]}
            oos_series[key] = [pnl_by_day[d] for d in split.out_of_sample if d in pnl_by_day]
            option_books[key] = {"spreads": len(spreads)}

    history_trades = {s: {r: [t for t in trades[s][r] if t.day <= HISTORY_LAST] for r in RULES} for s in trades}
    replay = nautilus_check(sessions, history_trades) if nautilus else None
    replay_same = None if replay is None else replay.get("same")
    verdicts = {}
    for rule in RULES:
        dsr = deflated_sharpe({row: oos_series[row] for row in TRIAL_ROWS}, primary=f"U-{rule}", n_trials=N_TRIALS)
        oos = rows[f"U-{rule}"]["base"]["outOfSample"]
        option_oos = (rows[f"0DTE-{rule}"]["base"] or {}).get("outOfSample")
        option_net = None if option_oos is None else option_oos["netUsd"]
        option_trades = 0 if option_oos is None else option_oos["trades"]
        verdict, text = verdict_of(rule, oos["trades"], oos["netUsd"], dsr, option_net, option_trades, replay_same)
        verdicts[rule] = {"verdict": verdict, "text": text, "deflatedSharpe": dsr}

    passed = [rule for rule in RULES if verdicts[rule]["verdict"] == "edge"]
    if passed:
        overall = "passed"
    elif all(verdicts[rule]["verdict"] == "needs-more-data" for rule in RULES):
        overall = "needs-more-data"
    else:
        overall = "failed"
    return {
        "schema": SCHEMA,
        "spec": {"path": "docs/specs/strategies/order-flow-amt-auction.md", "sha256": rules.SPEC_SHA256},
        "days": {"first": days[0], "last": days[-1], "count": len(days)},
        "split": {"train": [split.train[0], split.train[-1], len(split.train)],
                  "validation": [split.validation[0], split.validation[-1], len(split.validation)],
                  "test": [split.test[0], split.test[-1], len(split.test)], "gap": GAP_SESSIONS},
        "costs": {"underlying": {"bpsPerSide": COST_BPS, "commissionPerShare": COMMISSION_PER_SHARE,
                                 "notional": NOTIONAL, "stress": STRESS}},
        "trials": N_TRIALS,
        "rows": rows,
        "verdicts": verdicts,
        "verdict": overall,
        "passedRules": passed,
        "nautilus": replay,
        "forward": forward_check(trades, flow) if flow is not None else None,
        "sampleTrades": [asdict(t) for t in (history["A"][-3:] + history["C"][-3:])],
        "limits": LIMIT_TEXT,
        "timeExit": f"bar {TIME_EXIT} close (15:45 New York)",
    }
