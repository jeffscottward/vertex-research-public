"""The 11 QuantConnect idea ports as DSL definitions and pre-registered runs (research only).

Each idea is written as its spec (docs/specs/strategies/qc-*.md) fixed it on
2026-11-08, before the first run. Every run is a set of legs; a leg is one
traded symbol with a strategy DSL definition (entry, exit, filters and the
`options` block), compiled by nautilus_backtest/signals.py with the series
context, and an event policy that turns the compiled signal bars into
SignalEvents for book.py:

- "roll": monthly rebalance. An entry signal at each month-end close where the
  definition enters; every spread closes at the next rebalance (its exit signal
  is the next month-end), so a member that stays selected is rolled.
- "flat": at most one open spread. While flat, an entry signal on each cadence
  bar (every bar, or month-ends) where the definition enters; the exit signal
  is the first later bar where a DSL exit condition holds (none: the options
  exits only). A spread opens again only after the last one closed.
- "window": one spread per calendar window (runs of bars where the definition
  enters): entry signal on the first bar of the window, exit signal on its last
  bar, so the one-bar delay closes the spread on the first bar after the window.

What the DSL cannot express is computed here in Python and read by the DSL
`series` filter under a research-only derived id (prefix `qc:`; the product
DSL enum does not hold them, so study.compile_signals evaluates these filters
with the DSL's own series evaluator and ANDs them into the entries, exactly as
a native `series` filter would be):

- `qc:futTrend:<ETF>`, `qc:futCarry:<ETF>`: the futures trend T and carry
  proxy C at month-ends (qc-futures-trend-carry rules 2-3).
- `qc:oilPrediction:<ETF>`: the predicted excess return of the 60-month oil
  regression at month-ends (qc-oil-predicts-equity rules 1-4).
- `qc:momentumSelected:<ETF>` / `qc:momentumEligible:<ETF>`: 1 when the member
  is in the top 2 by 12-1 momentum with momentum > 0 / eligible, else 0.
- `qc:seasonSelected:<ETF>` / `qc:seasonEligible:<ETF>`: the same for the
  same-calendar-month score.

The Fed model ratio is the DSL's own derived id `EY_TNX_RATIO` (data.py). The
10-month trend of qc-asset-class-trend is the DSL `sma` of length 10 compiled on
month-end total-return bars (frame "monthly"). Calendar windows, IV rank, the
VIX term structure and the volatility regime are native DSL filters. The
contango gate needs ratio < 1.0 strictly; the DSL bound is inclusive, so it is
written as `maxRatio` = the largest double below 1.0 (CONTANGO_MAX).
"""
from __future__ import annotations

import math
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from statistics import mean, stdev

__all__ = [
    "CALENDAR_CALL",
    "CONTANGO_MAX",
    "CORE7",
    "DERIVED_PREFIX",
    "DONCHIAN",
    "EQUITY4",
    "GATES",
    "HOST_CALL",
    "IDEAS",
    "MONTHLY_CALL",
    "MONTHLY_PUT",
    "PUT_CREDIT",
    "SMA30",
    "Idea",
    "Leg",
    "RunSpec",
    "definition",
    "family",
    "futures_trend_carry",
    "is_derived",
    "momentum_table",
    "month_end_indices",
    "oil_predictions",
    "ols",
    "season_table",
    "series_filter",
    "window_spans",
]

CORE7 = ("SPY", "QQQ", "DIA", "IWM", "GLD", "SLV", "USO")
EQUITY4 = ("SPY", "QQQ", "DIA", "IWM")
FUTURE_OF = {"SPY": "ES=F", "QQQ": "NQ=F", "DIA": "YM=F", "IWM": "RTY=F", "GLD": "GC=F", "SLV": "SI=F", "USO": "CL=F"}
DERIVED_PREFIX = "qc:"
VIX3M_START = "2006-07-17"
SPEC_DIR = "docs/specs/strategies"

# Options blocks (book.parse_options), as the specs fixed them.
MONTHLY_CALL = {"structure": "callDebitVertical", "dte": {"target": 60, "min": 45}, "longDelta": 0.5,
                "widthSigma": 1.0, "maxLossPct": 2}
MONTHLY_PUT = {**MONTHLY_CALL, "structure": "putDebitVertical"}
CALENDAR_CALL = {"structure": "callDebitVertical", "dte": {"target": 30, "min": 21}, "longDelta": 0.5,
                 "widthSigma": 1.0, "maxLossPct": 2}
HOST_CALL = {**CALENDAR_CALL, "exitDte": 5}
PUT_CREDIT = {"structure": "putCreditVertical", "dte": {"target": 45, "min": 30}, "shortDelta": 0.25,
              "widthSigma": 0.5, "profitTakePct": 50, "exitDte": 21, "maxLossPct": 2}

CONTANGO_MAX = math.nextafter(1.0, 0.0)
GATES = {
    "ivRank": {"type": "ivRank", "length": 252, "min": 50},
    "volRegime": {"type": "volRegime", "maxVix": 25, "maxTermRatio": 1.0, "trendLength": 200},
    "vixTermStructure": {"type": "vixTermStructure", "maxRatio": CONTANGO_MAX},
}

CLOSE = {"type": "price", "field": "close"}


def const(value: float) -> dict:
    return {"type": "const", "value": value}


def indicator(name: str, length: int, source: str = "close") -> dict:
    return {"type": "indicator", "name": name, "length": length, "source": source}


def condition(left: Mapping, op: str, right: Mapping) -> dict:
    return {"left": dict(left), "op": op, "right": dict(right)}


# Always true on a priced bar (closes are above 0): entries driven by filters only.
ALWAYS = condition(CLOSE, ">", const(0))


def series_filter(series_id: str, op: str, value: float) -> dict:
    return {"type": "series", "series": series_id, "condition": condition(CLOSE, op, const(value))}


def definition(name: str, options: Mapping, *, entry: Sequence[Mapping] = (ALWAYS,), exit: Sequence[Mapping] = (),
               filters: Sequence[Mapping] = ()) -> dict:
    """A strategy DSL definition (version 1) with a defined-risk `options` block."""
    out = {"name": name, "version": 1, "entry": {"all": [dict(item) for item in entry]},
           "options": {**options, "dte": dict(options["dte"])}}
    if exit:
        out["exit"] = {"any": [dict(item) for item in exit]}
    if filters:
        out["filters"] = [dict(item) for item in filters]
    return out


def is_derived(item: Mapping) -> bool:
    """A `series` filter on a research-only derived id (evaluated by study.compile_signals)."""
    return item.get("type") == "series" and str(item.get("series", "")).startswith(DERIVED_PREFIX)


def with_filter(base: Mapping, gate: Mapping, name: str) -> dict:
    """`base` with one more entry filter (gates never touch exits)."""
    out = {**base, "name": name, "filters": [*base.get("filters", ()), dict(gate)]}
    return out


# Existing strategies for the gate before/after runs (options expression of the specs).
SMA30 = definition("sma30-market-timing", HOST_CALL, entry=[condition(CLOSE, ">", indicator("sma", 30))],
                   exit=[condition(CLOSE, "<", indicator("sma", 30))])
# STRATEGY_TEMPLATES.donchianBreakout (packages/api/src/strategy-dsl.ts), unchanged.
DONCHIAN = definition("donchianBreakout", HOST_CALL, entry=[condition(CLOSE, ">", indicator("highest", 20, "high"))],
                      exit=[condition(CLOSE, "<", indicator("lowest", 10, "low"))])


# --------------------------------------------------------------------------- derived series (pure)

def month_end_indices(dates: Sequence[str]) -> list[int]:
    """Indices of the last date of each month; the month of the last date is not complete and is left out."""
    return [index for index in range(len(dates) - 1) if dates[index][:7] != dates[index + 1][:7]]


def _sample_std(values: Sequence[float]) -> float:
    return stdev(values) if len(values) > 1 else 0.0


def futures_trend_carry(future: Sequence[float | None], etf: Sequence[float | None], at: Sequence[int],
                        lookback: int = 252) -> dict[int, tuple[float, float]]:
    """index -> (T, C) at each index of `at` where both are defined.

    `future` and `etf` (total-return close) are aligned to one calendar (None = no value).
    T = (F_t / F_t-L - 1) / (sigma * sqrt(L)), sigma = sample std of the last L daily simple returns of F;
    C = (E_t / E_t-L - 1) - (F_t / F_t-L - 1).
    """
    out: dict[int, tuple[float, float]] = {}
    for index in at:
        start = index - lookback
        if start < 0:
            continue
        window = future[start:index + 1]
        if any(value is None for value in window) or etf[index] is None or etf[start] is None:
            continue
        returns = [window[k] / window[k - 1] - 1 for k in range(1, len(window))]
        sigma = _sample_std(returns)
        if not sigma > 0:
            continue
        future_return = window[-1] / window[0] - 1
        out[index] = (future_return / (sigma * math.sqrt(lookback)), etf[index] / etf[start] - 1 - future_return)
    return out


def ols(xs: Sequence[float], ys: Sequence[float]) -> tuple[float, float, float | None]:
    """y = a0 + a1 x by least squares: (a0, a1, t-statistic of a1 or None when undefined)."""
    n = len(xs)
    if n != len(ys) or n < 3:
        raise ValueError("ols needs at least 3 pairs of equal length")
    mx, my = mean(xs), mean(ys)
    sxx = sum((x - mx) ** 2 for x in xs)
    if sxx <= 0:
        raise ValueError("ols needs x with some variance")
    a1 = sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / sxx
    a0 = my - a1 * mx
    rss = sum((y - a0 - a1 * x) ** 2 for x, y in zip(xs, ys))
    se = math.sqrt(rss / (n - 2) / sxx)
    return a0, a1, (a1 / se if se > 0 else None)


def oil_predictions(oil: Sequence[float | None], equity: Sequence[float | None], bill: Sequence[float | None],
                    window: int = 60) -> dict[int, tuple[float, float, float | None, float]]:
    """Month index -> (a0, a1, t of a1, predicted excess return) of the oil regression.

    Inputs are month-end series on one month grid: `oil` and `equity` total-return closes,
    `bill` the IRX annual percent. x_s = oil return of month s, y_s = equity return of month s minus
    bill_{s-1} / 1200. At month t: OLS of y_s on x_{s-1} over the last `window` pairs with s <= t, all
    defined and consecutive; prediction a0 + a1 * x_t.
    """
    size = len(oil)
    x: list[float | None] = [None] * size
    y: list[float | None] = [None] * size
    for s in range(1, size):
        if oil[s] is not None and oil[s - 1] is not None:
            x[s] = oil[s] / oil[s - 1] - 1
        if equity[s] is not None and equity[s - 1] is not None and bill[s - 1] is not None:
            y[s] = equity[s] / equity[s - 1] - 1 - bill[s - 1] / 1200
    out: dict[int, tuple[float, float, float | None, float]] = {}
    for t in range(size):
        first = t - window + 1
        if first < 1 or x[t] is None:
            continue
        pairs = [(x[s - 1], y[s]) for s in range(first, t + 1)]
        if any(a is None or b is None for a, b in pairs):
            continue
        a0, a1, t_stat = ols([a for a, _ in pairs], [b for _, b in pairs])
        out[t] = (a0, a1, t_stat, a0 + a1 * x[t])
    return out


@dataclass(frozen=True)
class Pick:
    """One member at one month-end of a cross-sectional selection."""

    eligible: bool
    selected: bool
    score: float | None


def _top_positive(scored: Sequence[tuple[tuple, str]], top: int) -> set[str]:
    """The first `top` members by key (key[0] is minus the score) whose score is above 0."""
    return {symbol for key, symbol in sorted(scored)[:top] if -key[0] > 0}


def momentum_table(closes: Mapping[str, Sequence[float | None]], iv_live: Mapping[str, Sequence[bool]],
                   order: Sequence[str], top: int = 2) -> list[dict[str, Pick]]:
    """Per month-end k (month grid): 12-1 momentum = close[k-1] / close[k-12] - 1 of each member with a
    close at k-12 and its IV index live at k; the top `top` with momentum > 0 are selected. Ties:
    higher 12-month return (close[k] / close[k-12] - 1), then `order`."""
    size = len(next(iter(closes.values())))
    table: list[dict[str, Pick]] = []
    for k in range(size):
        picks: dict[str, Pick] = {}
        scored = []
        for symbol in order:
            column = closes[symbol]
            ok = (k >= 12 and column[k - 12] is not None and column[k - 1] is not None and column[k] is not None
                  and iv_live[symbol][k])
            if not ok:
                picks[symbol] = Pick(False, False, None)
                continue
            momentum = column[k - 1] / column[k - 12] - 1
            year = column[k] / column[k - 12] - 1
            picks[symbol] = Pick(True, False, momentum)
            scored.append(((-momentum, -year, order.index(symbol)), symbol))
        chosen = _top_positive(scored, top)
        table.append({symbol: Pick(pick.eligible, symbol in chosen, pick.score) for symbol, pick in picks.items()})
    return table


def season_table(closes: Mapping[str, Sequence[float | None]], months: Sequence[str],
                 iv_live: Mapping[str, Sequence[bool]], order: Sequence[str], top: int = 2,
                 minimum: int = 5) -> list[dict[str, Pick]]:
    """Per month-end k: score = mean of the member's monthly returns (close[j] / close[j-1] - 1, j <= k) in
    the calendar month of k + 1; eligible with at least `minimum` of them and the IV index live at k. The
    top `top` with score > 0 are selected; ties: `order`. `months` holds the YYYY-MM of each month-end."""
    returns: dict[str, dict[int, list[float]]] = {symbol: {} for symbol in order}
    table: list[dict[str, Pick]] = []
    for k in range(len(months)):
        for symbol in order:
            column = closes[symbol]
            if k >= 1 and column[k] is not None and column[k - 1] is not None:
                returns[symbol].setdefault(int(months[k][5:7]), []).append(column[k] / column[k - 1] - 1)
        target = int(months[k][5:7]) % 12 + 1
        picks: dict[str, Pick] = {}
        scored = []
        for symbol in order:
            history = returns[symbol].get(target, [])
            if len(history) < minimum or not iv_live[symbol][k]:
                picks[symbol] = Pick(False, False, None)
                continue
            score = sum(history) / len(history)
            picks[symbol] = Pick(True, False, score)
            scored.append(((-score, order.index(symbol)), symbol))
        chosen = _top_positive(scored, top)
        table.append({symbol: Pick(pick.eligible, symbol in chosen, pick.score) for symbol, pick in picks.items()})
    return table


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


# --------------------------------------------------------------------------- runs

@dataclass(frozen=True)
class Leg:
    """One traded symbol of a run.

    policy: "roll" | "flat" | "window" (module doc). cadence ("flat" only): "daily" or "monthEnd".
    frame: "daily" (the symbol's bars) or "monthly" (month-end total-return bars, adj_close).
    shift: "window" only; 1 evaluates the window one bar ahead (signals one bar earlier), which the
    calendar allows because trading days are known in advance.
    start / end: first and last signal date (inclusive; end None = no limit).
    """

    symbol: str
    definition: Mapping
    policy: str
    start: str
    cadence: str = "monthEnd"
    frame: str = "daily"
    shift: int = 0
    end: str | None = None


@dataclass(frozen=True)
class RunSpec:
    key: str
    name: str
    legs: tuple[Leg, ...]
    start: str
    counted: bool = True

    @property
    def symbols(self) -> tuple[str, ...]:
        return tuple(dict.fromkeys(leg.symbol for leg in self.legs))


@dataclass(frozen=True)
class Gate:
    gate: str
    host: str
    before: str
    after: str


@dataclass(frozen=True)
class Idea:
    id: str
    title: str
    runs: tuple[tuple[str, str], ...]  # (label in the spec, run key)
    gates: tuple[Gate, ...] = ()

    @property
    def spec(self) -> str:
        return f"{SPEC_DIR}/{self.id}.md"

    def key(self, label: str) -> str:
        return dict(self.runs)[label]


@dataclass(frozen=True)
class Facts:
    """Data-dependent dates the runs need (study.py measures them)."""

    iv_start: Mapping[str, str]  # first date of each member with its IV index value
    iv_rank_join: Mapping[str, str]  # first date with 252 IV index values (ivRank defined)
    starts: Mapping[str, Mapping[str, str]]  # idea id -> member -> first eligible month-end
    gold_last_input: str  # last month-end with an EY_TNX_RATIO value
    member_order: Sequence[str] = field(default=CORE7)


def _roll(idea: str, facts: Facts, members: Sequence[str], make) -> tuple[Leg, ...]:
    starts = facts.starts[idea]
    return tuple(Leg(symbol, make(symbol), "roll", starts[symbol]) for symbol in members if symbol in starts)


def _earliest(legs: Sequence[Leg]) -> str:
    return min(leg.start for leg in legs)


def _host_runs(facts: Facts) -> dict[str, RunSpec]:
    """S/D runs: the existing strategies with and without each gate. Counted ones start where the gate
    can first pass; "@" keys are the ungated hosts on the gated dates (same rule, not new trials)."""
    runs: dict[str, RunSpec] = {}

    def host(key: str, base: Mapping, members: Sequence[str], start: str, gate: str | None, counted: bool) -> None:
        name = base["name"] if gate is None else f"{base['name']} + {gate}"
        made = base if gate is None else with_filter(base, GATES[gate], name)
        legs = tuple(Leg(symbol, made, "flat", max(facts.iv_start[symbol], start), cadence="daily")
                     for symbol in members)
        runs[key] = RunSpec(key, name, legs, start, counted)

    for prefix, base, members in (("S", SMA30, ("SPY",)), ("D", DONCHIAN, CORE7)):
        first = facts.iv_start["SPY"]
        host(f"{prefix}0", base, members, first, None, True)
        host(f"{prefix}1", base, members, first, "ivRank", True)
        host(f"{prefix}2", base, members, VIX3M_START, "volRegime", True)
        host(f"{prefix}3", base, members, VIX3M_START, "vixTermStructure", True)
        host(f"{prefix}0@{VIX3M_START}", base, members, VIX3M_START, None, False)
    return runs


def family(facts: Facts) -> dict[str, RunSpec]:
    """Every pre-registered run (32 counted) plus the uncounted same-rule windows of the gate tables."""
    runs = _host_runs(facts)

    def add(key: str, name: str, legs: Sequence[Leg], start: str | None = None, counted: bool = True) -> None:
        runs[key] = RunSpec(key, name, tuple(legs), start or _earliest(legs), counted)

    # qc-asset-class-trend: 10-month SMA of month-end total return (DSL sma on monthly bars).
    trend = definition("10-month SMA trend", MONTHLY_CALL, entry=[condition(CLOSE, ">", indicator("sma", 10))])
    legs = [replace_frame(leg, "monthly") for leg in _roll("qc-asset-class-trend", facts, CORE7, lambda s: trend)]
    add("asset-class-trend/A", "10-month SMA trend, call debit verticals", legs)
    always = definition("Always on, monthly roll", MONTHLY_CALL)
    add("asset-class-trend/B", "Always-on monthly call debit verticals",
        _roll("qc-asset-class-trend", facts, CORE7, lambda s: always), runs["asset-class-trend/A"].start)

    # qc-futures-trend-carry.
    def long_leg(symbol: str) -> dict:
        return definition("Trend and carry long", MONTHLY_CALL, filters=[
            series_filter(f"{DERIVED_PREFIX}futTrend:{symbol}", ">", 0),
            series_filter(f"{DERIVED_PREFIX}futCarry:{symbol}", ">", 0)])

    def short_leg(symbol: str) -> dict:
        return definition("Trend and carry short", MONTHLY_PUT, filters=[
            series_filter(f"{DERIVED_PREFIX}futTrend:{symbol}", "<", 0),
            series_filter(f"{DERIVED_PREFIX}futCarry:{symbol}", "<", 0)])

    longs = _roll("qc-futures-trend-carry", facts, CORE7, long_leg)
    shorts = _roll("qc-futures-trend-carry", facts, CORE7, short_leg)
    add("futures-trend-carry/A", "Trend and carry, long and short debit verticals", [*longs, *shorts])
    add("futures-trend-carry/A-L", "Trend and carry, long side only", longs)
    add("futures-trend-carry/B", "Always-on monthly call debit verticals",
        _roll("qc-futures-trend-carry", facts, CORE7, lambda s: always))

    # qc-gold-fed-model: DSL series filter on EY_TNX_RATIO; no entry after the last Shiller input.
    fed = definition("Fed model gold timing", MONTHLY_CALL, filters=[series_filter("EY_TNX_RATIO", ">", 2)])
    gold_start = facts.starts["qc-gold-fed-model"]["GLD"]
    add("gold-fed-model/A", "Fed-model gold timing, GLD call debit vertical",
        [Leg("GLD", fed, "roll", gold_start, end=facts.gold_last_input)])
    add("gold-fed-model/B", "Always-on monthly GLD call debit vertical", [Leg("GLD", always, "roll", gold_start)])

    # qc-iv-rank-gate: Core 7 put credit verticals, month-end cadence, one open spread per member.
    put = definition("Put credit vertical", PUT_CREDIT)
    gated = with_filter(put, GATES["ivRank"], "Put credit vertical + ivRank")
    add("iv-rank-gate/A", "Core 7 put credit verticals, IV rank >= 50",
        [Leg(symbol, gated, "flat", facts.iv_rank_join[symbol]) for symbol in CORE7])
    add("iv-rank-gate/B", "Core 7 put credit verticals, no gate",
        [Leg(symbol, put, "flat", facts.iv_rank_join[symbol]) for symbol in CORE7])

    # qc-momentum-rotation.
    add("momentum-rotation/A", "Top 2 by 12-1 momentum, momentum > 0", _roll(
        "qc-momentum-rotation", facts, CORE7, lambda s: definition("Momentum top 2", MONTHLY_CALL, filters=[
            series_filter(f"{DERIVED_PREFIX}momentumSelected:{s}", ">", 0)])))
    add("momentum-rotation/B", "Always-on monthly call debit verticals", _roll(
        "qc-momentum-rotation", facts, CORE7, lambda s: definition("Always on (eligible)", MONTHLY_CALL, filters=[
            series_filter(f"{DERIVED_PREFIX}momentumEligible:{s}", ">", 0)])))

    # qc-oil-predicts-equity.
    add("oil-predicts-equity/A", "Oil-regression timing on SPY and QQQ", _roll(
        "qc-oil-predicts-equity", facts, ("SPY", "QQQ"), lambda s: definition("Oil regression", MONTHLY_CALL, filters=[
            series_filter(f"{DERIVED_PREFIX}oilPrediction:{s}", ">", 0)])))
    add("oil-predicts-equity/B", "Always-on monthly SPY and QQQ call debit verticals",
        _roll("qc-oil-predicts-equity", facts, ("SPY", "QQQ"), lambda s: always))

    # qc-opex-week.
    opex = definition("OpEx week", CALENDAR_CALL, filters=[{"type": "calendarWindow", "window": "opexWeek"}])
    add("opex-week/A", "OpEx week held as in the source",
        [Leg(symbol, opex, "window", facts.iv_start[symbol], shift=1) for symbol in EQUITY4])
    add("opex-week/A-L", "Literal opexWeek filter on signal bars",
        [Leg(symbol, opex, "window", facts.iv_start[symbol]) for symbol in EQUITY4])
    monthly30 = definition("Always on, monthly roll", CALENDAR_CALL)
    add("opex-week/B", "Always-on monthly call debit verticals",
        [Leg(symbol, monthly30, "roll", facts.iv_start[symbol]) for symbol in EQUITY4])

    # qc-regime-put-vrp and qc-vix-term-gate: SPY put credit vertical, month-end cadence.
    add("regime-put-vrp/A", "SPY put credit vertical, volRegime gate",
        [Leg("SPY", with_filter(put, GATES["volRegime"], "Put credit vertical + volRegime"), "flat", VIX3M_START)])
    add("put-credit/B", "SPY put credit vertical, no gate", [Leg("SPY", put, "flat", VIX3M_START)])
    add("vix-term-gate/A", "SPY put credit vertical, contango gate",
        [Leg("SPY", with_filter(put, GATES["vixTermStructure"], "Put credit vertical + vixTermStructure"), "flat",
             VIX3M_START)])

    # qc-same-month-seasonality.
    add("same-month-seasonality/A", "Top 2 by same-month average return, score > 0", _roll(
        "qc-same-month-seasonality", facts, CORE7, lambda s: definition("Seasonality top 2", MONTHLY_CALL, filters=[
            series_filter(f"{DERIVED_PREFIX}seasonSelected:{s}", ">", 0)])))
    add("same-month-seasonality/B", "Always-on monthly call debit verticals", _roll(
        "qc-same-month-seasonality", facts, CORE7, lambda s: definition("Always on (eligible)", MONTHLY_CALL, filters=[
            series_filter(f"{DERIVED_PREFIX}seasonEligible:{s}", ">", 0)])))

    # qc-turn-of-the-month.
    def tom(from_day: int, to_day: int) -> dict:
        return definition(f"Turn of month {from_day}..{to_day}", CALENDAR_CALL, filters=[
            {"type": "calendarWindow", "window": "turnOfMonth", "fromDay": from_day, "toDay": to_day}])

    add("turn-of-the-month/A", "Turn-of-month window -2..+3 as trade dates",
        [Leg(symbol, tom(-3, 2), "window", facts.iv_start[symbol]) for symbol in EQUITY4])
    add("turn-of-the-month/A-L", "Literal filter -2..+3 on signal bars",
        [Leg(symbol, tom(-2, 3), "window", facts.iv_start[symbol]) for symbol in EQUITY4])
    add("turn-of-the-month/B", "Always-on monthly call debit verticals",
        [Leg(symbol, monthly30, "roll", facts.iv_start[symbol]) for symbol in EQUITY4])
    return runs


def replace_frame(leg: Leg, frame: str) -> Leg:
    return Leg(leg.symbol, leg.definition, leg.policy, leg.start, leg.cadence, frame, leg.shift, leg.end)


def _gates(gate: str, number: int) -> tuple[Gate, ...]:
    after_start = "" if number == 1 else f"@{VIX3M_START}"
    return (Gate(gate, "sma30-market-timing (SPY)", f"S0{after_start}", f"S{number}"),
            Gate(gate, "donchianBreakout (Core 7)", f"D0{after_start}", f"D{number}"))


IDEAS: tuple[Idea, ...] = (
    Idea("qc-asset-class-trend", "Asset-Class Trend Following (QuantConnect port)",
         (("A", "asset-class-trend/A"), ("B", "asset-class-trend/B"))),
    Idea("qc-futures-trend-carry", "Futures Trend and Carry (QuantConnect port)",
         (("A", "futures-trend-carry/A"), ("A-L", "futures-trend-carry/A-L"), ("B", "futures-trend-carry/B"))),
    Idea("qc-gold-fed-model", "Gold Timing with the Fed Model (QuantConnect port)",
         (("A", "gold-fed-model/A"), ("B", "gold-fed-model/B"))),
    Idea("qc-iv-rank-gate", "IV Rank Entry Gate (QuantConnect port)",
         (("A", "iv-rank-gate/A"), ("B", "iv-rank-gate/B"), ("S0", "S0"), ("S1", "S1"), ("D0", "D0"),
          ("D1", "D1")), _gates("ivRank >= 50", 1)),
    Idea("qc-momentum-rotation", "Momentum Rotation (QuantConnect port)",
         (("A", "momentum-rotation/A"), ("B", "momentum-rotation/B"))),
    Idea("qc-oil-predicts-equity", "Oil Predicts Equity (QuantConnect port)",
         (("A", "oil-predicts-equity/A"), ("B", "oil-predicts-equity/B"))),
    Idea("qc-opex-week", "Option Expiration Week (QuantConnect port)",
         (("A", "opex-week/A"), ("A-L", "opex-week/A-L"), ("B", "opex-week/B"))),
    Idea("qc-regime-put-vrp", "Regime-Gated Put Premium (QuantConnect port)",
         (("A", "regime-put-vrp/A"), ("B", "put-credit/B"), ("S0", "S0"), ("S2", "S2"), ("D0", "D0"),
          ("D2", "D2")), _gates("volRegime", 2)),
    Idea("qc-same-month-seasonality", "Same-Month Seasonality (QuantConnect port)",
         (("A", "same-month-seasonality/A"), ("B", "same-month-seasonality/B"))),
    Idea("qc-turn-of-the-month", "Turn of the Month (QuantConnect port)",
         (("A", "turn-of-the-month/A"), ("A-L", "turn-of-the-month/A-L"), ("B", "turn-of-the-month/B"))),
    Idea("qc-vix-term-gate", "VIX Term-Structure Gate (QuantConnect port)",
         (("A", "vix-term-gate/A"), ("B", "put-credit/B"), ("S0", "S0"), ("S3", "S3"), ("D0", "D0"),
          ("D3", "D3")), _gates("vixTermStructure < 1 (contango)", 3)),
)
