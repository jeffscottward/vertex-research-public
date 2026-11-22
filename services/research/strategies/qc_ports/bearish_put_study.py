"""Event study of the bearish put-spread rule (research only; docs/specs/strategies/bearish-put-spread.md).

The stored backtest runs hold one spread at a time, which leaves too few trades to judge an edge. This
study prices EVERY signal bar as its own spread with the runner's own book (book.build_book, the same
option model, strikes, costs and exits), so trades may overlap, and compares them with the same spread
opened on every bar of the window (the baseline). Pre-registered method (design decisions D4-D6):

- Owner exit, exact: each signal is priced twice, held to expiry and with exitDte 3. A spread worth less
  than its entry price at the exitDte-3 close is closed there; any other spread keeps its hold-to-expiry
  result. An earlier exit signal (close crosses above the 200-day SMA) ends both the same way.
- Result per trade: pnl = exit price - entry price - entry fee - exit fee ($ per contract); return on
  risk (ror) = pnl / max loss per contract (book.PricedTrade.max_loss: entry price, entry fee and the
  worst-case exit cost).
- Edge statistic: mean ror of the rule minus mean ror of the baseline over the same window. 95% interval
  from a block bootstrap: the window's bars are cut into blocks of BLOCK bars (longer than the longest
  hold, about 55 sessions, so overlapping trades fall mostly in one block); a resample draws as many
  blocks with replacement and takes every rule and baseline trade whose signal bar lies in a drawn block
  (RESAMPLES resamples, fixed SEED).
- Independent signals: the owner-exit trades taken one at a time (a signal counts only after the
  previous counted spread has closed); the stored runs chain on their own exits, which can differ by
  up to 3 calendar days.
- Truncated trades: a spread still open on the last bar (book exit reason "end") has no final result;
  it is left out of every statistic and counted per window.
- Verdict (D5): "pass" only with at least MIN_SIGNALS independent signals, a positive mean difference whose
  interval lies above 0, and a positive mean difference out of sample; "not proven" below MIN_SIGNALS
  independent signals; otherwise "no edge shown".
- Sensitivity (D6): the same study with ATM IV moved by +-4 vol points (the IV index moved by 4 / ATM
  factor) and the skew slope moved by +-0.1. The skew case changes options.SKEW for the duration of the
  call (shifted_skew restores it); run the study in its own process (the CLI), never inside the worker.
- Drawdown: a Monte Carlo of the independent rule trades at 2% of equity at risk per trade.

Nothing here places an order or authorizes a trade.
"""
from __future__ import annotations

import json
import math
import random
from collections.abc import Callable, Iterator, Mapping, Sequence
from contextlib import contextmanager
from dataclasses import asdict, dataclass

from . import bearish_put as bp
from . import options as om
from . import portfolio as pf
from .book import PricedTrade, SignalEvent, build_book

__all__ = ["BLOCK", "MIN_SIGNALS", "RESAMPLES", "SEED", "WINDOWS", "EventTrade", "Window", "bootstrap_difference",
           "event_trades", "independent", "main", "monte_carlo_drawdown", "owner_exit", "run_study", "shifted_skew",
           "summary",
           "with_iv_shift"]

OWNER_EXIT_DTE = 3
# Share of equity at risk per trade in the Monte Carlo drawdown (the owner's 2% max-loss rule).
RISK_PER_TRADE = 0.02
BLOCK = 60
RESAMPLES = 10_000
SEED = 20261122
MIN_SIGNALS = 30


@dataclass(frozen=True)
class Window:
    """A study window: the rule definition, first and last signal date, and the out-of-sample start."""

    name: str
    rule: Mapping
    first: str
    last: str
    oos_from: str


@dataclass(frozen=True)
class EventTrade:
    signal_index: int
    signal_date: str
    entry_date: str
    exit_date: str
    exit_reason: str
    long_strike: float
    short_strike: float
    entry_price: float
    pnl: float
    max_loss: float
    ror: float
    cost_pct_width: float


def owner_exit(held: PricedTrade, early: PricedTrade) -> PricedTrade:
    """The owner rule from the two pricings of one signal: close a losing spread at the exitDte close."""
    return early if early.exit_reason == "exitDte" and early.exit_price < early.entry_price else held


def _price(options: Mapping, symbol: str, market, index: int, exit_index: int | None) -> PricedTrade | None:
    book = build_book([SignalEvent(symbol, index, exit_index)], options, {symbol: market})
    return book.trades[0] if book.trades else None


def _event(trade: PricedTrade, index: int, signal_date: str) -> EventTrade:
    pnl = round(trade.exit_price - trade.entry_price - trade.entry_fee - trade.exit_fee, 2)
    return EventTrade(
        signal_index=index, signal_date=signal_date, entry_date=trade.entry_date, exit_date=trade.exit_date,
        exit_reason=trade.exit_reason, long_strike=trade.long_strike, short_strike=trade.short_strike,
        entry_price=trade.entry_price, pnl=pnl, max_loss=trade.max_loss, ror=pnl / trade.max_loss,
        cost_pct_width=trade.entry_price / (trade.width * om.MULTIPLIER) * 100)


def event_trades(definition: Mapping, data: pf.Dataset, symbol: str, first: str, last: str) -> list[EventTrade]:
    """Every entry signal bar dated first..last priced as its own spread under the owner exit."""
    leg = pf.run_legs(definition, symbol)[0]
    entries, exits = pf.leg_signals(leg, data)
    market = pf.market_of(data, symbol)
    held_options = {key: value for key, value in definition["options"].items() if key != "exitDte"}
    early_options = {**held_options, "exitDte": OWNER_EXIT_DTE}
    following: list[int | None] = [None] * len(exits)
    upcoming = None
    for index in range(len(exits) - 1, -1, -1):
        following[index] = upcoming
        if exits[index]:
            upcoming = index
    trades = []
    for index, day in enumerate(market.dates):
        if not (entries[index] and first <= day <= last):
            continue
        held = _price(held_options, symbol, market, index, following[index])
        early = _price(early_options, symbol, market, index, following[index])
        if held is None or early is None:
            continue
        trades.append(_event(owner_exit(held, early), index, day))
    return trades


def summary(trades: Sequence[EventTrade]) -> dict:
    """Count, mean return on risk, win rate, mean and total pnl ($ per contract), mean cost per width."""
    if not trades:
        return {"n": 0, "meanRor": None, "winRate": None, "meanPnl": None, "totalPnl": 0.0, "meanCostPctWidth": None}
    n = len(trades)
    return {
        "n": n,
        "meanRor": sum(t.ror for t in trades) / n,
        "winRate": sum(t.pnl > 0 for t in trades) / n,
        "meanPnl": sum(t.pnl for t in trades) / n,
        "totalPnl": round(sum(t.pnl for t in trades), 2),
        "meanCostPctWidth": sum(t.cost_pct_width for t in trades) / n,
    }


def independent(trades: Sequence[EventTrade]) -> list[EventTrade]:
    """The trades taken one at a time: a signal counts only on or after the exit date of the last one taken."""
    taken: list[EventTrade] = []
    for trade in sorted(trades, key=lambda t: t.signal_index):
        if not taken or trade.signal_date >= taken[-1].exit_date:
            taken.append(trade)
    return taken


def bootstrap_difference(rule: Sequence[EventTrade], base: Sequence[EventTrade], first_index: int, last_index: int,
                         *, block: int = BLOCK, resamples: int = RESAMPLES,
                         seed: int = SEED) -> tuple[float | None, float | None]:
    """95% interval of mean(rule ror) - mean(base ror) by a block bootstrap over bars first_index..last_index;
    (None, None) when no resample has trades on both sides."""
    count = max(1, math.ceil((last_index - first_index + 1) / block))
    by_block: list[tuple[list[float], list[float]]] = [([], []) for _ in range(count)]
    for side, trades in ((0, rule), (1, base)):
        for trade in trades:
            by_block[(trade.signal_index - first_index) // block][side].append(trade.ror)
    rng = random.Random(seed)
    diffs = []
    for _ in range(resamples):
        rule_sum = rule_n = base_sum = base_n = 0.0
        for _ in range(count):
            picked = by_block[rng.randrange(count)]
            rule_sum += sum(picked[0])
            rule_n += len(picked[0])
            base_sum += sum(picked[1])
            base_n += len(picked[1])
        if rule_n and base_n:
            diffs.append(rule_sum / rule_n - base_sum / base_n)
    if not diffs:
        return (None, None)
    diffs.sort()
    return diffs[int(0.025 * (len(diffs) - 1))], diffs[int(0.975 * (len(diffs) - 1))]


def _difference(rule: Sequence[EventTrade], base: Sequence[EventTrade]) -> float | None:
    if not rule or not base:
        return None
    return summary(rule)["meanRor"] - summary(base)["meanRor"]


def _window_result(window: Window, data: pf.Dataset, symbol: str, resamples: int) -> dict:
    rule_all = event_trades(window.rule, data, symbol, window.first, window.last)
    base_all = event_trades(bp.BASELINE, data, symbol, window.first, window.last)
    rule = [t for t in rule_all if t.exit_reason != "end"]
    base = [t for t in base_all if t.exit_reason != "end"]
    dates = pf.market_of(data, symbol).dates
    first_index = next(i for i, day in enumerate(dates) if day >= window.first)
    last_index = max(i for i, day in enumerate(dates) if day <= window.last)
    low, high = bootstrap_difference(rule, base, first_index, last_index, resamples=resamples)
    oos_rule = [t for t in rule if t.signal_date >= window.oos_from]
    oos_base = [t for t in base if t.signal_date >= window.oos_from]
    difference = _difference(rule, base)
    oos_difference = _difference(oos_rule, oos_base)
    alone = independent(rule)
    if len(alone) < MIN_SIGNALS:
        verdict = "not proven"
    elif (difference is not None and difference > 0 and low is not None and low > 0
          and oos_difference is not None and oos_difference > 0):
        verdict = "pass"
    else:
        verdict = "no edge shown"
    return {
        "window": window.name, "first": window.first, "last": window.last, "oosFrom": window.oos_from,
        "rule": summary(rule), "independent": summary(alone), "baseline": summary(base),
        "truncated": {"rule": len(rule_all) - len(rule), "baseline": len(base_all) - len(base)},
        "independentDrawdown": monte_carlo_drawdown(alone),
        "inSample": {"rule": summary([t for t in rule if t.signal_date < window.oos_from]),
                     "baseline": summary([t for t in base if t.signal_date < window.oos_from])},
        "outOfSample": {"rule": summary(oos_rule), "baseline": summary(oos_base)},
        "difference": difference, "interval95": [low, high], "oosDifference": oos_difference, "verdict": verdict,
        "trades": [asdict(t) for t in rule],
    }


def monte_carlo_drawdown(trades: Sequence[EventTrade], *, risk: float = RISK_PER_TRADE, resamples: int = 2_000,
                         seed: int = SEED) -> dict:
    """Max drawdown of equity that risks `risk` of itself on each trade (equity *= 1 + risk * ror), over
    `resamples` orderings drawn with replacement from the trades: median and 95th percentile, and the
    drawdown of the trades in their real order. Fractions of equity; zeros without trades."""
    def drawdown(rors: Sequence[float]) -> float:
        equity = peak = 1.0
        worst = 0.0
        for ror in rors:
            equity *= 1 + risk * ror
            peak = max(peak, equity)
            worst = max(worst, 1 - equity / peak)
        return worst

    rors = [t.ror for t in trades]
    if not rors:
        return {"actual": 0.0, "median": 0.0, "p95": 0.0, "risk": risk}
    rng = random.Random(seed)
    draws = sorted(drawdown([rng.choice(rors) for _ in rors]) for _ in range(resamples))
    return {"actual": drawdown(rors), "median": draws[len(draws) // 2], "p95": draws[int(0.95 * (len(draws) - 1))],
            "risk": risk}


def with_iv_shift(rows: Mapping[str, Mapping[str, Sequence]], index_id: str, points: float) -> dict:
    """Store rows with ATM IV moved by `points` vol points: the IV index moved by points / its ATM factor."""
    shift = points / om.ATM_FACTOR[index_id]
    moved = {key: dict(value) for key, value in rows.items()}
    moved[index_id]["close"] = [None if v is None else max(0.01, v + shift) for v in rows[index_id]["close"]]
    return moved


@contextmanager
def shifted_skew(symbol: str, delta: float) -> Iterator[None]:
    """The model skew slope of `symbol` moved by `delta` for the duration of the block (then restored)."""
    before = om.SKEW[symbol]
    om.SKEW[symbol] = before + delta
    try:
        yield
    finally:
        om.SKEW[symbol] = before


def run_study(rows: Mapping[str, Mapping[str, Sequence]], windows: Sequence[Window], *, symbol: str = "QQQ",
              resamples: int = RESAMPLES, sensitivity: bool = True) -> dict:
    """The study document: each window, and with `sensitivity` the verdict and difference under IV and skew moves."""
    data = pf.dataset_from_rows(rows)
    result = {"symbol": symbol, "block": BLOCK, "resamples": resamples, "seed": SEED, "minSignals": MIN_SIGNALS,
              "windows": [_window_result(window, data, symbol, resamples) for window in windows]}
    if not sensitivity:
        return result
    index_id = pf.IV_INDEX[symbol]
    cases: list[tuple[str, Callable[[], dict]]] = []
    for points in (-4.0, 4.0):
        cases.append((f"atmIv{points:+.0f}", lambda p=points: run_study(with_iv_shift(rows, index_id, p), windows,
                                                                         symbol=symbol, resamples=resamples,
                                                                         sensitivity=False)))
    for delta in (-0.1, 0.1):
        def skewed(d=delta) -> dict:
            with shifted_skew(symbol, d):
                return run_study(rows, windows, symbol=symbol, resamples=resamples, sensitivity=False)
        cases.append((f"skew{delta:+.1f}", skewed))
    result["sensitivity"] = {
        name: [{"window": w["window"], "difference": w["difference"], "interval95": w["interval95"],
                "verdict": w["verdict"], "rule": w["rule"]["meanRor"]} for w in run()["windows"]]
        for name, run in cases}
    return result


# Pre-registered windows (design D2, D3).
WINDOWS = (
    Window("A: breadth rule 2022-11-10..2026-11-20", bp.RULE_EXIT3, "2022-11-10", "2026-11-20", "2025-09-01"),
    Window("B: SMA20 proxy, no breadth, 2001-11-01..2026-11-20", bp.PROXY_EXIT3, "2001-11-01", "2026-11-20",
           "2019-01-01"),
)


def main(path: str) -> str:
    """JSON of run_study over the pre-registered windows on store rows read from `path`."""
    with open(path, encoding="utf-8") as handle:
        rows = json.load(handle)
    return json.dumps(run_study(rows, WINDOWS), sort_keys=True, allow_nan=False)
