"""Runs an options strategy DSL definition on daily data (research and the Nautilus backtest worker).

A definition with an `options` block trades defined-risk option verticals on its signals. Its
optional `portfolio` block names the symbols and the policy (docs/vertex-rebuild/strategy-definitions.md,
"Portfolio block"); without it the definition trades one symbol with the flat policy on every bar.
Each (leg, symbol) pair is one run leg: leg 0 is the definition's own entry, exit, filters and
options, then `portfolio.legs` in order; run legs go leg by leg, symbol by symbol.

Signals come from nautilus_backtest/signals.py (compile_strategy) on the symbol's daily bars, or on
its month-end total-return bars with `frame: "monthly"`. The policies turn signal bars into
SignalEvents for book.py (a signal at bar i trades at the close of bar i + 1):

- roll: an entry at each month-end where the leg enters (and, with `select`, the member is
  selected); every spread closes at the next month-end.
- flat: one open spread per run leg; candidates are the cadence bars where the leg enters; the exit
  is the first later bar where a DSL exit condition holds.
- window: one spread per run of entry bars (read `shift` bars ahead), opened on the first bar and
  closed after the last.

A member joins at its first daily bar with an IV index value (the options cannot be priced before);
signals before that bar or before the run start are ignored. The ledger marks equity on the SPY
dates (the market calendar) from the run start.
"""
from __future__ import annotations

import dataclasses
import math
from bisect import bisect_left
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import date

from nautilus_backtest import signals as sig
from nautilus_backtest.bars import Bars as DslBars

from .book import PricedTrade, SignalEvent, build_book
from .data import (
    ETF_SYMBOLS,
    IV_INDEX,
    MAX_FILL_DAYS,
    Bars,
    Market,
    align,
    data_root,
    load_bars,
    load_context,
)
from .ledger import DEFAULT_CAPITAL, LedgerResult, run_ledger
from .metrics import summarize

__all__ = [
    "PARITY_REL_TOL", "Dataset", "RunLeg", "RunOutcome", "dataset_from_dir", "dataset_from_rows",
    "context_from_rows", "dsl_bars", "first_signal_dates", "market_of", "max_open_risk", "month_end_indices", "run_definition",
    "run_legs", "run_metrics", "run_spec_json", "window_spans",
]

CALENDAR_SYMBOL = "SPY"
PARITY_REL_TOL = 1e-6
DAY_MS = 86_400_000
EPOCH = date(1970, 1, 1)


# --------------------------------------------------------------------------- data

@dataclass(frozen=True)
class Dataset:
    """Daily data a run reads.

    `bars`: ETF symbol -> bars that pass the bar rules (data.load_bars). `series`: series id -> date
    -> close for every DSL series id (data.load_series), `<ETF>:TR` included (the adjusted close of
    the ETF bars). `calendar`: the SPY bar dates.
    """

    bars: Mapping[str, Bars]
    series: Mapping[str, Mapping[str, float]]

    @property
    def calendar(self) -> tuple[str, ...]:
        return self.bars[CALENDAR_SYMBOL].dates


def _with_total_return(bars: Mapping[str, Bars], series: Mapping[str, Mapping[str, float]]) -> Dataset:
    context = dict(series)
    for symbol, bar in bars.items():
        context[f"{symbol}:TR"] = dict(zip(bar.dates, bar.adj_close))
    return Dataset(dict(bars), context)


def dataset_from_dir(root=None) -> Dataset:
    """The qc-ports fetch files (data.py)."""
    root = data_root(root)
    bars = {symbol: load_bars(symbol, root) for symbol in ETF_SYMBOLS}
    return _with_total_return(bars, load_context(root=root))


def _finite(value) -> float | None:
    if value is None or isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    number = float(value)
    return number if math.isfinite(number) else None


def _rows_view(rows: Mapping[str, Mapping[str, Sequence]]) -> tuple[dict[str, Bars], dict[str, dict[str, float]]]:
    """ETF bars (data.load_bars rules) and closes (data.load_series: every finite close) of store rows."""
    series: dict[str, dict[str, float]] = {}
    bars: dict[str, Bars] = {}
    for series_id, row in rows.items():
        dates = list(row["dates"])
        closes = [_finite(value) for value in row["close"]]
        if len(closes) != len(dates):
            raise ValueError(f"{series_id}: close and dates differ in length")
        series[series_id] = {day: value for day, value in zip(dates, closes) if value is not None}
        if series_id not in ETF_SYMBOLS:
            continue
        columns = {key: [_finite(value) for value in row[key]] for key in ("open", "high", "low", "adjClose")}
        kept = [index for index, close in enumerate(closes)
                if close is not None and close > 0 and all(columns[key][index] is not None for key in columns)]
        bar = Bars(series_id, tuple(dates[k] for k in kept), *(tuple(columns[key][k] for k in kept)
                                                               for key in ("open", "high", "low")),
                   tuple(closes[k] for k in kept), tuple(columns["adjClose"][k] for k in kept))
        if any(later <= earlier for earlier, later in zip(bar.dates, bar.dates[1:])):
            raise ValueError(f"{series_id}: dates must be strictly increasing")
        bars[series_id] = bar
    return bars, series


def context_from_rows(rows: Mapping[str, Mapping[str, Sequence]]) -> dict[str, dict[str, float]]:
    """The DSL series context of store rows: every id's closes plus `<ETF>:TR` of the ETF rows."""
    bars, series = _rows_view(rows)
    return dict(_with_total_return(bars, series).series)


def dataset_from_rows(rows: Mapping[str, Mapping[str, Sequence]]) -> Dataset:
    """Rows as the Postgres series store returns them: id -> {dates, open, high, low, close, adjClose}.

    ETF ids give bars with the data.load_bars rules (close above 0, open, high, low and adjusted close
    present); every id gives its closes (data.load_series: every finite close).
    """
    bars, series = _rows_view(rows)
    if CALENDAR_SYMBOL not in bars:
        raise ValueError(f"The market calendar needs {CALENDAR_SYMBOL} bars")
    return _with_total_return(bars, series)


def _slice(data: Dataset, end: str | None) -> Dataset:
    """Every bar and series value dated on or before `end` (no limit when None)."""
    if end is None:
        return data
    bars = {}
    for symbol, bar in data.bars.items():
        size = bisect_left(bar.dates, end + "\x00")
        bars[symbol] = Bars(symbol, *(column[:size] for column in (
            bar.dates, bar.open, bar.high, bar.low, bar.close, bar.adj_close)))
    series = {series_id: {day: value for day, value in values.items() if day <= end}
              for series_id, values in data.series.items()}
    return Dataset(bars, series)


def market_of(data: Dataset, symbol: str) -> Market:
    """The options book's view of one symbol (data.load_market): IV index and IRX aligned to its bars."""
    if symbol not in IV_INDEX:
        raise ValueError(f"No IV index for {symbol}")
    bar = data.bars[symbol]
    iv = align(data.series[IV_INDEX[symbol]], bar.dates, MAX_FILL_DAYS)
    rate = [None if value is None else value / 100 for value in align(data.series["IRX"], bar.dates, MAX_FILL_DAYS)]
    return Market(symbol, bar.dates, bar.close, tuple(iv), tuple(rate))


def dsl_bars(dates: Sequence[str], open_: Sequence[float], high: Sequence[float], low: Sequence[float],
             close: Sequence[float]) -> DslBars:
    """Daily bars for signals.py: t = UTC midnight of each date in epoch ms."""
    t = tuple(float((date.fromisoformat(day) - EPOCH).days * DAY_MS) for day in dates)
    return DslBars(t=t, o=tuple(open_), h=tuple(high), l=tuple(low), c=tuple(close))


def month_end_indices(dates: Sequence[str]) -> list[int]:
    """Indices of the last date of each month; the month of the last date is not complete and is left out."""
    return [index for index in range(len(dates) - 1) if dates[index][:7] != dates[index + 1][:7]]


def window_spans(mask: Sequence[bool]) -> list[tuple[int, int]]:
    """(first, last) index of every run of True."""
    spans = []
    start = None
    for index, value in enumerate(mask):
        if value and start is None:
            start = index
        elif not value and start is not None:
            spans.append((start, index - 1))
            start = None
    if start is not None:
        spans.append((start, len(mask) - 1))
    return spans


# --------------------------------------------------------------------------- legs and signals

LEG_KEYS = ("entry", "exit", "filters", "options")


@dataclass(frozen=True)
class RunLeg:
    """One (leg, symbol) pair of a run. `definition` is a plain strategy definition (no portfolio)."""

    order: int
    symbol: str
    definition: Mapping
    policy: str
    cadence: str | None
    frame: str
    shift: int


def _portfolio(definition: Mapping, symbol: str | None) -> Mapping:
    block = definition.get("portfolio")
    if block is not None:
        return block
    if symbol is None:
        raise ValueError("A definition without a portfolio block needs the run symbol")
    return {"symbols": [symbol], "policy": "flat", "cadence": "daily"}


def run_legs(definition: Mapping, symbol: str | None = None) -> list[RunLeg]:
    """The run legs of an options definition, leg by leg, symbol by symbol."""
    if definition.get("options") is None:
        raise ValueError("The options runner needs an options block")
    block = _portfolio(definition, symbol)
    own = {key: definition[key] for key in LEG_KEYS if definition.get(key) is not None}
    parts = [own, *(block.get("legs") or ())]
    legs = []
    for part in parts:
        leg_definition = {"name": definition["name"], "version": definition.get("version", 1),
                          **{key: part[key] for key in LEG_KEYS if part.get(key) is not None}}
        for member in block["symbols"]:
            legs.append(RunLeg(len(legs), member, leg_definition, block["policy"], block.get("cadence"),
                               block.get("frame", "daily"), int(block.get("shift", 0))))
    return legs


def _frame(leg: RunLeg, data: Dataset) -> tuple[DslBars, list[int] | None]:
    """The bars the leg compiles on, and the daily index of each frame bar (None = the daily bars)."""
    bar = data.bars[leg.symbol]
    if leg.frame == "daily":
        return dsl_bars(bar.dates, bar.open, bar.high, bar.low, bar.close), None
    if leg.frame != "monthly":
        raise ValueError(f"Unknown frame {leg.frame}")
    ends = month_end_indices(bar.dates)
    closes = [bar.adj_close[index] for index in ends]
    return dsl_bars([bar.dates[index] for index in ends], closes, closes, closes, closes), ends


def _to_daily(values: Sequence, ends: list[int] | None, size: int, empty):
    if ends is None:
        return list(values)
    out = [empty] * size
    for position, index in enumerate(ends):
        out[index] = values[position]
    return out


def leg_signals(leg: RunLeg, data: Dataset) -> tuple[list[bool], list[bool]]:
    """Entry and exit flags per daily bar of the leg's symbol (monthly frames map to their month-end bars)."""
    frame, ends = _frame(leg, data)
    bar = data.bars[leg.symbol]
    compiled = sig.compile_strategy(frame, leg.definition, None, data.series, leg.symbol,
                                    calendar=None if ends is None else bar.dates)
    entries = [value == 1 for value in compiled.signals]
    exits = [value == 1 for value in compiled.exits]
    size = len(bar.dates)
    return _to_daily(entries, ends, size, False), _to_daily(exits, ends, size, False)


def leg_values(leg: RunLeg, data: Dataset, expr: Mapping) -> list[float]:
    """An expression per daily bar of the leg's symbol (NaN where not available or off the frame)."""
    frame, ends = _frame(leg, data)
    bar = data.bars[leg.symbol]
    values = sig.expression_values(frame, expr, data.series, leg.symbol,
                                   calendar=None if ends is None else bar.dates)
    return _to_daily(values, ends, len(bar.dates), math.nan)


def _join_index(market: Market) -> int:
    """First bar with an IV index value (len(dates) when there is none)."""
    return next((index for index, value in enumerate(market.iv_index) if value is not None), len(market.dates))


def _next_true(flags: Sequence[bool]) -> list[int | None]:
    """For each index, the first later index where flags is True."""
    out: list[int | None] = [None] * len(flags)
    following = None
    for index in range(len(flags) - 1, -1, -1):
        out[index] = following
        if flags[index]:
            following = index
    return out


def _sequential(candidates: Sequence[tuple[int, int | None]], leg: RunLeg,
                market: Market) -> tuple[list[PricedTrade], list]:
    """Prices candidates in order, taking one only when the last spread has closed by its signal bar."""
    trades, skipped = [], []
    busy = -1
    for entry, exit_ in candidates:
        if entry < busy:
            continue
        book = build_book([SignalEvent(leg.symbol, entry, exit_)], leg.definition["options"], {leg.symbol: market})
        if book.trades:
            trades.append(book.trades[0])
            busy = book.trades[0].exit_index
        skipped.extend(book.skipped)
    return trades, skipped


def _selection(legs: Sequence[RunLeg], data: Dataset, select: Mapping,
               entries: Mapping[int, list[bool]]) -> dict[int, set[str]]:
    """Per run leg order: the month-end dates where the member is selected.

    Each calendar month, among the members of the same leg whose entry holds on their month-end bar and
    whose score (and tie-break, when given) is available there: highest score first, then highest
    tie-break, then the portfolio symbol order; the first `top` are selected. Members are grouped by
    month, so a member whose last bar of the month falls a day early still competes with the others.
    """
    top = int(select["top"])
    chosen: dict[int, set[str]] = {leg.order: set() for leg in legs}
    groups: dict[int, list[RunLeg]] = {}
    for leg in legs:
        groups.setdefault(id(leg.definition), []).append(leg)
    for members in groups.values():
        ranked: dict[str, list[tuple[tuple, int, str]]] = {}
        for rank, leg in enumerate(members):
            dates = data.bars[leg.symbol].dates
            scores = leg_values(leg, data, select["score"])
            ties = leg_values(leg, data, select["tieBreak"]) if select.get("tieBreak") is not None else None
            for index in month_end_indices(dates):
                score = scores[index]
                tie = 0.0 if ties is None else ties[index]
                if not entries[leg.order][index] or math.isnan(score) or math.isnan(tie):
                    continue
                ranked.setdefault(dates[index][:7], []).append(((-score, -tie, rank), leg.order, dates[index]))
        for items in ranked.values():
            for _, order, day in sorted(items)[:top]:
                chosen[order].add(day)
    return chosen


def leg_trades(leg: RunLeg, data: Dataset, start: str, entries: list[bool], exits: list[bool],
               selected: set[str] | None = None) -> tuple[list[PricedTrade], list, int]:
    """(priced trades, book skips, entry signals) of one run leg."""
    market = market_of(data, leg.symbol)
    dates = market.dates
    join = _join_index(market)

    def live(index: int) -> bool:
        return index >= join and dates[index] >= start

    if leg.policy == "roll":
        ends = month_end_indices(dates)
        events = []
        for position, index in enumerate(ends):
            if entries[index] and live(index) and (selected is None or dates[index] in selected):
                following = ends[position + 1] if position + 1 < len(ends) else None
                events.append(SignalEvent(leg.symbol, index, following))
        book = build_book(events, leg.definition["options"], {leg.symbol: market})
        return list(book.trades), list(book.skipped), len(events)
    if leg.policy == "flat":
        if leg.cadence == "daily":
            bars = range(len(dates) - 1)
        elif leg.cadence == "monthEnd":
            bars = month_end_indices(dates)
        else:
            raise ValueError(f"Unknown cadence {leg.cadence}")
        following = _next_true(exits) if (leg.definition.get("exit") or {}).get("any") else [None] * len(dates)
        candidates = [(index, following[index]) for index in bars if entries[index] and live(index)]
        trades, skipped = _sequential(candidates, leg, market)
        return trades, skipped, len(trades) + len(skipped)
    if leg.policy == "window":
        mask = entries[leg.shift:] + [False] * leg.shift
        last = len(dates) - 1
        candidates = [(first, end) for first, end in window_spans(mask)
                      if first > 0 and live(first) and end + 1 <= last and end > first]
        trades, skipped = _sequential(candidates, leg, market)
        return trades, skipped, len(candidates)
    raise ValueError(f"Unknown policy {leg.policy}")


# --------------------------------------------------------------------------- runs

@dataclass(frozen=True)
class RunOutcome:
    result: LedgerResult
    priced: tuple[PricedTrade, ...]
    book_skipped: int
    signals: Mapping[str, int]
    nautilus_gap: float | None


def _signals(definition: Mapping, data: Dataset, symbol: str | None):
    legs = run_legs(definition, symbol)
    flags = {leg.order: leg_signals(leg, data) for leg in legs}
    block = _portfolio(definition, symbol)
    selected = None
    if block.get("select") is not None:
        selected = _selection(legs, data, block["select"], {order: pair[0] for order, pair in flags.items()})
    return legs, flags, selected


def run_definition(definition: Mapping, data: Dataset, *, start: str, end: str | None = None,
                   capital: float = DEFAULT_CAPITAL, symbol: str | None = None, nautilus: bool = False) -> RunOutcome:
    """Runs an options definition from `start` to `end` (inclusive; None = the last bar).

    With `nautilus`, the trades are booked again in NautilusTrader and the run fails when the daily
    equity differs by more than PARITY_REL_TOL or the trades differ; the result stays the ledger's
    (study.execute).
    """
    sig.normalize_definition(definition)
    data = _slice(data, end)
    legs, flags, selected = _signals(definition, data, symbol)
    collected = []
    skipped = 0
    counts: dict[str, int] = {}
    for leg in legs:
        entries, exits = flags[leg.order]
        trades, skips, count = leg_trades(leg, data, start, entries, exits,
                                          None if selected is None else selected[leg.order])
        collected.extend((trade.entry_date, leg.order, trade.entry_index, trade) for trade in trades)
        skipped += len(skips)
        counts[leg.symbol] = counts.get(leg.symbol, 0) + count
    collected.sort(key=lambda item: item[:3])
    trades = [dataclasses.replace(item[3], trade_id=number) for number, item in enumerate(collected, start=1)]
    dates = [day for day in data.calendar if day >= start]
    result = run_ledger(trades, capital, dates=dates)
    gap = None
    if nautilus:
        from .nautilus_runner import run_nautilus

        other = run_nautilus(trades, capital, dates=dates)
        gap = max((abs(a - b) / max(abs(a), abs(b)) for a, b in zip(result.equity, other.equity, strict=True)),
                  default=0.0)
        same = [(t["id"], t["contracts"]) for t in result.trades] == [(t["id"], t["contracts"]) for t in other.trades]
        if gap > PARITY_REL_TOL or not same:
            raise RuntimeError(f"Ledger and Nautilus disagree (gap {gap:.3g}, trades match {same})")
    return RunOutcome(result, tuple(trades), skipped, counts, gap)


def first_signal_dates(definition: Mapping, data: Dataset, symbol: str | None = None) -> dict[str, str]:
    """Symbol -> first entry signal date (after the member joins) of an options definition, over all data."""
    legs, flags, selected = _signals(definition, data, symbol)
    first: dict[str, str] = {}
    for leg in legs:
        market = market_of(data, leg.symbol)
        join = _join_index(market)
        entries = flags[leg.order][0]
        ends = set(month_end_indices(market.dates)) if leg.policy == "roll" or leg.cadence == "monthEnd" else None
        for index in range(join, len(market.dates)):
            day = market.dates[index]
            if not entries[index] or (ends is not None and index not in ends):
                continue
            if selected is not None and day not in selected[leg.order]:
                continue
            if leg.symbol not in first or day < first[leg.symbol]:
                first[leg.symbol] = day
            break
    return first


def max_open_risk(result: LedgerResult, priced: Sequence[PricedTrade]) -> float:
    """Largest share of equity at risk in open spreads at a day's close: sum of contracts * max loss per
    contract of the trades open after that day's exits and entries, over that day's equity."""
    max_loss = {trade.trade_id: trade.max_loss for trade in priced}
    spans = [(record["entryDate"], record["exitDate"], record["contracts"] * max_loss[record["id"]])
             for record in result.trades]
    worst = 0.0
    for day, equity in zip(result.dates, result.equity):
        risk = sum(amount for entry, exit_, amount in spans if entry <= day < exit_)
        if risk and equity > 0:
            worst = max(worst, risk / equity)
    return worst


def run_metrics(outcome: RunOutcome, n_trials: int = 1, sharpe_variance: float | None = None) -> dict:
    """metrics.summarize plus the book skips, the largest open risk and the stale-IV exits."""
    stats = summarize(outcome.result, n_trials, sharpe_variance)
    stats["skipped"] = stats["skipped"] + outcome.book_skipped
    stats["maxOpenRisk"] = max_open_risk(outcome.result, outcome.priced)
    stats["staleIvExits"] = sum(1 for trade in outcome.result.trades if trade["exitReason"] == "stale-iv")
    return stats


def run_spec_json(spec: Mapping, rows: Mapping[str, Mapping[str, Sequence]], nautilus: bool = True) -> dict:
    """One backtest-run spec (packages/api BacktestRunSpec, rule kind dsl with an options block) on store
    rows: the ledger result, its trades (each with its max loss per contract, so the API can recompute
    maxOpenRisk) and skips, and run_metrics, as JSON for the Nautilus worker."""
    rule = spec["rule"]
    if rule.get("kind") != "dsl" or rule["definition"].get("options") is None:
        raise ValueError("The options runner runs dsl rules with an options block")
    outcome = run_definition(rule["definition"], dataset_from_rows(rows), start=spec["from"], end=spec["to"],
                             capital=float(spec.get("initialCapital") or DEFAULT_CAPITAL), symbol=spec["symbol"],
                             nautilus=nautilus)
    result = outcome.result
    max_loss = {trade.trade_id: trade.max_loss for trade in outcome.priced}
    return {
        "kind": "options", "capital": result.capital, "dates": list(result.dates), "equity": list(result.equity),
        "openPositions": list(result.open_positions),
        "trades": [{**record, "maxLoss": max_loss[record["id"]]} for record in result.trades],
        "skipped": list(result.skipped), "bookSkipped": outcome.book_skipped, "signals": dict(outcome.signals),
        "metrics": run_metrics(outcome), "nautilusGap": outcome.nautilus_gap,
    }
