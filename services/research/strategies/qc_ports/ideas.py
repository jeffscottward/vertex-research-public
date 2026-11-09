"""The 11 QuantConnect idea ports as strategy DSL definitions and pre-registered runs (research only).

Each idea is written as its spec (docs/specs/strategies/qc-*.md) fixed it on 2026-11-08, before the
first run. Every run is ONE strategy DSL definition (version 1) with an `options` block and a
`portfolio` block (symbols and policy), run by portfolio.run_definition from a start date. The same
definitions run in the server engines (backtest runs, the Nautilus worker); the run A definition of
each idea is stored in Postgres (strategy_definition_revisions, ids `qc-<idea>`).

Nothing here computes a signal: the trend, carry, oil regression, momentum and seasonality rules
are DSL expressions (`change`, `returnStdev`, `math`, `regression`, `seasonal`, the `$tr`, `$iv`
and `$future` series of each member) and the top-2 rankings are the portfolio `select`. The Fed
model ratio is the DSL series `EY_TNX_RATIO` (data.py). Calendar windows, IV rank, the VIX term
structure and the volatility regime are DSL filters. The contango gate needs ratio < 1.0 strictly;
the DSL bound is inclusive, so it is written as `maxRatio` = the largest double below 1.0
(CONTANGO_MAX).

Run starts are data facts (study.derive): the first IV index date of each member, the first bar
with an IV rank, and the first entry signal of each idea's eligibility definition (run B for the
monthly rolls), the same dates the spec runs started on.
"""
from __future__ import annotations

import math
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from statistics import mean

__all__ = [
    "CALENDAR_CALL",
    "CONTANGO_MAX",
    "CORE7",
    "DONCHIAN",
    "ELIGIBILITY",
    "EQUITY4",
    "GATES",
    "HOST_CALL",
    "IDEAS",
    "IV_LIVE",
    "MONTHLY_CALL",
    "MONTHLY_PUT",
    "PUT_CREDIT",
    "SMA30",
    "VIX3M_START",
    "Facts",
    "Idea",
    "RunSpec",
    "change",
    "condition",
    "const",
    "definition",
    "family",
    "indicator",
    "math_expr",
    "ols",
    "oil_predictions",
    "portfolio",
    "regression",
    "return_stdev",
    "seasonal",
    "series",
    "series_filter",
]

CORE7 = ("SPY", "QQQ", "DIA", "IWM", "GLD", "SLV", "USO")
EQUITY4 = ("SPY", "QQQ", "DIA", "IWM")
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

# --------------------------------------------------------------------------- DSL builders

CLOSE = {"type": "price", "field": "close"}
# Below every value an expression can take: `x > LOWEST` holds exactly when x is available.
LOWEST = -1e12


def const(value: float) -> dict:
    return {"type": "const", "value": value}


def indicator(name: str, length: int, source: str = "close") -> dict:
    return {"type": "indicator", "name": name, "length": length, "source": source}


def series(ref: str, offset: int | None = None) -> dict:
    out = {"type": "series", "series": ref}
    if offset is not None:
        out["offset"] = offset
    return out


def math_expr(op: str, left: Mapping, right: Mapping) -> dict:
    return {"type": "math", "op": op, "left": dict(left), "right": dict(right)}


def change(of: Mapping, length: int, offset: int | None = None) -> dict:
    out = {"type": "change", "of": dict(of), "length": length}
    if offset is not None:
        out["offset"] = offset
    return out


def return_stdev(of: Mapping, length: int) -> dict:
    return {"type": "returnStdev", "of": dict(of), "length": length}


def regression(y: Mapping, x: Mapping, length: int, lag: int) -> dict:
    return {"type": "regression", "y": dict(y), "x": dict(x), "length": length, "lag": lag}


def seasonal(of: Mapping, months_ahead: int, min_count: int) -> dict:
    return {"type": "seasonal", "of": dict(of), "monthsAhead": months_ahead, "minCount": min_count}


def condition(left: Mapping, op: str, right: Mapping) -> dict:
    return {"left": dict(left), "op": op, "right": dict(right)}


# Always true on a priced bar (closes are above 0): entries driven by filters only.
ALWAYS = condition(CLOSE, ">", const(0))


def series_filter(series_id: str, op: str, value: float) -> dict:
    return {"type": "series", "series": series_id, "condition": condition(CLOSE, op, const(value))}


# The member's IV index has a value (carried at most 5 trading days): its options can be priced.
IV_LIVE = series_filter("$iv", ">", 0)


def portfolio(symbols: Sequence[str], policy: str, **extra) -> dict:
    return {"symbols": list(symbols), "policy": policy, **extra}


def definition(name: str, options: Mapping, *, entry: Sequence[Mapping] = (ALWAYS,), exit: Sequence[Mapping] = (),
               filters: Sequence[Mapping] = (), book: Mapping | None = None) -> dict:
    """A strategy DSL definition (version 1) with a defined-risk `options` block and a `portfolio` block."""
    out = {"name": name, "version": 1, "entry": {"all": [dict(item) for item in entry]},
           "options": {**options, "dte": dict(options["dte"])}}
    if exit:
        out["exit"] = {"any": [dict(item) for item in exit]}
    if filters:
        out["filters"] = [dict(item) for item in filters]
    if book is not None:
        out["portfolio"] = dict(book)
    return out


def leg(options: Mapping, *, entry: Sequence[Mapping] = (ALWAYS,), filters: Sequence[Mapping] = ()) -> dict:
    """One more portfolio leg (portfolio.legs)."""
    out = {"entry": {"all": [dict(item) for item in entry]}, "options": {**options, "dte": dict(options["dte"])}}
    if filters:
        out["filters"] = [dict(item) for item in filters]
    return out


def with_filter(base: Mapping, gate: Mapping, name: str) -> dict:
    """`base` with one more entry filter (gates never touch exits)."""
    return {**base, "name": name, "filters": [*base.get("filters", ()), dict(gate)]}


# --------------------------------------------------------------------------- the rules as expressions

LOOKBACK = 252
# qc-futures-trend-carry rule 2: T = (F_t / F_t-L - 1) / (sigma * sqrt(L)), sigma = sample std of the last L
# daily returns of the future F (the member's futures twin); rule 3: C = (E_t / E_t-L - 1) - (F_t / F_t-L - 1),
# E = the member's total-return close.
FUTURE_CHANGE = change(series("$future"), LOOKBACK)
TREND = math_expr("div", FUTURE_CHANGE, math_expr("mul", return_stdev(series("$future"), LOOKBACK),
                                                  const(math.sqrt(LOOKBACK))))
CARRY = math_expr("sub", change(series("$tr"), LOOKBACK), FUTURE_CHANGE)
# qc-oil-predicts-equity rules 1-4 (monthly frame): y_s = member total return of month s minus bill_{s-1} / 1200,
# x_s = USO total return of month s; forecast a0 + a1 * x_t from y_s on x_{s-1} over the last 60 months.
OIL_FORECAST = regression(math_expr("sub", change(CLOSE, 1), math_expr("div", series("IRX", 1), const(1200))),
                          change(series("USO:TR"), 1), 60, 1)
# qc-momentum-rotation (monthly frame): 12-1 momentum close[k-1] / close[k-12] - 1; ties by the 12-month return.
MOMENTUM = change(CLOSE, 11, 1)
YEAR_RETURN = change(CLOSE, 12)
# qc-same-month-seasonality (monthly frame): mean monthly return in the calendar month after this one, 5 years min.
SEASON = seasonal(change(CLOSE, 1), 1, 5)


def _monthly_roll(symbols: Sequence[str], **extra) -> dict:
    return portfolio(symbols, "roll", frame="monthly", **extra)


# Existing strategies for the gate before/after runs (options expression of the specs).
SMA30 = definition("sma30-market-timing", HOST_CALL, entry=[condition(CLOSE, ">", indicator("sma", 30))],
                   exit=[condition(CLOSE, "<", indicator("sma", 30))])
# STRATEGY_TEMPLATES.donchianBreakout (packages/api/src/strategy-dsl.ts), unchanged.
DONCHIAN = definition("donchianBreakout", HOST_CALL, entry=[condition(CLOSE, ">", indicator("highest", 20, "high"))],
                      exit=[condition(CLOSE, "<", indicator("lowest", 10, "low"))])

ASSET_TREND = definition("10-month SMA trend", MONTHLY_CALL, entry=[condition(CLOSE, ">", indicator("sma", 10))],
                         book=_monthly_roll(CORE7))
ASSET_ALWAYS = definition("Always on (10 month-ends)", MONTHLY_CALL,
                          entry=[condition(indicator("sma", 10), ">", const(0))], book=_monthly_roll(CORE7))
TREND_LONG = [condition(TREND, ">", const(0)), condition(CARRY, ">", const(0))]
TREND_SHORT = [condition(TREND, "<", const(0)), condition(CARRY, "<", const(0))]
TREND_CARRY = definition("Trend and carry", MONTHLY_CALL, entry=TREND_LONG,
                         book=portfolio(CORE7, "roll", legs=[leg(MONTHLY_PUT, entry=TREND_SHORT)]))
TREND_CARRY_LONG = definition("Trend and carry long", MONTHLY_CALL, entry=TREND_LONG, book=portfolio(CORE7, "roll"))
TREND_ALWAYS = definition("Always on (trend and carry defined)", MONTHLY_CALL, entry=[
    condition(return_stdev(series("$future"), LOOKBACK), ">", const(0)),
    condition(change(series("$tr"), LOOKBACK), ">", const(-1))], book=portfolio(CORE7, "roll"))
GOLD_FED = definition("Fed model gold timing", MONTHLY_CALL, filters=[series_filter("EY_TNX_RATIO", ">", 2)],
                      book=portfolio(["GLD"], "roll"))
GOLD_ALWAYS = definition("Always on, monthly roll", MONTHLY_CALL, book=portfolio(["GLD"], "roll"))
PUT = definition("Put credit vertical", PUT_CREDIT, book=portfolio(CORE7, "flat", cadence="monthEnd"))
PUT_IV_RANK = with_filter(PUT, GATES["ivRank"], "Put credit vertical + ivRank")
# Run B of qc-iv-rank-gate: no gate, each member from its first bar with an IV rank (rank >= 0 = defined).
PUT_IV_DEFINED = with_filter(PUT, {"type": "ivRank", "length": 252, "min": 0}, "Put credit vertical")
MOMENTUM_TOP2 = definition("Momentum top 2", MONTHLY_CALL, entry=[condition(MOMENTUM, ">", const(0))],
                           filters=[IV_LIVE],
                           book=_monthly_roll(CORE7, select={"score": MOMENTUM, "tieBreak": YEAR_RETURN, "top": 2}))
MOMENTUM_ELIGIBLE = definition("Always on (eligible)", MONTHLY_CALL, entry=[condition(MOMENTUM, ">", const(LOWEST))],
                               filters=[IV_LIVE], book=_monthly_roll(CORE7))
OIL = definition("Oil regression", MONTHLY_CALL, entry=[condition(OIL_FORECAST, ">", const(0))],
                 book=_monthly_roll(["SPY", "QQQ"]))
OIL_ALWAYS = definition("Always on (forecast defined)", MONTHLY_CALL,
                        entry=[condition(OIL_FORECAST, ">", const(LOWEST))], book=_monthly_roll(["SPY", "QQQ"]))
OPEX = {"type": "calendarWindow", "window": "opexWeek"}
MONTHLY30 = definition("Always on, monthly roll", CALENDAR_CALL, book=portfolio(EQUITY4, "roll"))
SPY_PUT = definition("Put credit vertical", PUT_CREDIT, book=portfolio(["SPY"], "flat", cadence="monthEnd"))
SEASON_TOP2 = definition("Seasonality top 2", MONTHLY_CALL, entry=[condition(SEASON, ">", const(0))],
                         filters=[IV_LIVE], book=_monthly_roll(CORE7, select={"score": SEASON, "top": 2}))
SEASON_ELIGIBLE = definition("Always on (eligible)", MONTHLY_CALL, entry=[condition(SEASON, ">", const(LOWEST))],
                             filters=[IV_LIVE], book=_monthly_roll(CORE7))


def turn_of_month(from_day: int, to_day: int) -> dict:
    return {"type": "calendarWindow", "window": "turnOfMonth", "fromDay": from_day, "toDay": to_day}


# Each roll idea starts at the first entry of its eligibility definition (its run B).
ELIGIBILITY = {
    "qc-asset-class-trend": ASSET_ALWAYS,
    "qc-futures-trend-carry": TREND_ALWAYS,
    "qc-gold-fed-model": GOLD_ALWAYS,
    "qc-momentum-rotation": MOMENTUM_ELIGIBLE,
    "qc-oil-predicts-equity": OIL_ALWAYS,
    "qc-same-month-seasonality": SEASON_ELIGIBLE,
}


# --------------------------------------------------------------------------- runs

@dataclass(frozen=True)
class RunSpec:
    """One pre-registered run: a definition run from `start` to the last bar."""

    key: str
    name: str
    definition: Mapping
    start: str
    counted: bool = True

    @property
    def symbols(self) -> tuple[str, ...]:
        return tuple(self.definition["portfolio"]["symbols"])


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
    runs: tuple[tuple[str, str], ...]  # (label in the spec, run key); A first, then the baseline B
    gates: tuple[Gate, ...] = ()

    @property
    def spec(self) -> str:
        return f"{SPEC_DIR}/{self.id}.md"

    def key(self, label: str) -> str:
        return dict(self.runs)[label]


@dataclass(frozen=True)
class Facts:
    """Data-dependent dates the runs need (study.derive measures them)."""

    iv_start: Mapping[str, str]  # first date of each member with its IV index value
    iv_rank_join: Mapping[str, str]  # first date with 252 IV index values (ivRank defined)
    starts: Mapping[str, Mapping[str, str]]  # idea id -> member -> first entry of its ELIGIBILITY definition
    gold_last_input: str  # last month-end with an EY_TNX_RATIO value (reported)


def _host_runs(facts: Facts) -> dict[str, RunSpec]:
    """S/D runs: the existing strategies with and without each gate. Counted ones start where the gate
    can first pass; "@" keys are the ungated hosts on the gated dates (same rule, not new trials)."""
    runs: dict[str, RunSpec] = {}

    def host(key: str, base: Mapping, members: Sequence[str], start: str, gate: str | None, counted: bool) -> None:
        name = base["name"] if gate is None else f"{base['name']} + {gate}"
        made = base if gate is None else with_filter(base, GATES[gate], name)
        runs[key] = RunSpec(key, name, {**made, "portfolio": portfolio(members, "flat", cadence="daily")}, start,
                            counted)

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

    def add(key: str, name: str, made: Mapping, start: str, counted: bool = True) -> None:
        runs[key] = RunSpec(key, name, made, start, counted)

    def first(idea: str) -> str:
        return min(facts.starts[idea].values())

    add("asset-class-trend/A", "10-month SMA trend, call debit verticals", ASSET_TREND, first("qc-asset-class-trend"))
    add("asset-class-trend/B", "Always-on monthly call debit verticals", ASSET_ALWAYS, first("qc-asset-class-trend"))
    start = first("qc-futures-trend-carry")
    add("futures-trend-carry/A", "Trend and carry, long and short debit verticals", TREND_CARRY, start)
    add("futures-trend-carry/A-L", "Trend and carry, long side only", TREND_CARRY_LONG, start)
    add("futures-trend-carry/B", "Always-on monthly call debit verticals", TREND_ALWAYS, start)
    start = first("qc-gold-fed-model")
    add("gold-fed-model/A", "Fed-model gold timing, GLD call debit vertical", GOLD_FED, start)
    add("gold-fed-model/B", "Always-on monthly GLD call debit vertical", GOLD_ALWAYS, start)
    start = min(facts.iv_rank_join.values())
    add("iv-rank-gate/A", "Core 7 put credit verticals, IV rank >= 50", PUT_IV_RANK, start)
    add("iv-rank-gate/B", "Core 7 put credit verticals, no gate", PUT_IV_DEFINED, start)
    start = first("qc-momentum-rotation")
    add("momentum-rotation/A", "Top 2 by 12-1 momentum, momentum > 0", MOMENTUM_TOP2, start)
    add("momentum-rotation/B", "Always-on monthly call debit verticals", MOMENTUM_ELIGIBLE, start)
    start = first("qc-oil-predicts-equity")
    add("oil-predicts-equity/A", "Oil-regression timing on SPY and QQQ", OIL, start)
    add("oil-predicts-equity/B", "Always-on monthly SPY and QQQ call debit verticals", OIL_ALWAYS, start)
    start = min(facts.iv_start[symbol] for symbol in EQUITY4)
    add("opex-week/A", "OpEx week held as in the source",
        definition("OpEx week", CALENDAR_CALL, filters=[OPEX], book=portfolio(EQUITY4, "window", shift=1)), start)
    add("opex-week/A-L", "Literal opexWeek filter on signal bars",
        definition("OpEx week", CALENDAR_CALL, filters=[OPEX], book=portfolio(EQUITY4, "window")), start)
    add("opex-week/B", "Always-on monthly call debit verticals", MONTHLY30, start)
    add("regime-put-vrp/A", "SPY put credit vertical, volRegime gate",
        with_filter(SPY_PUT, GATES["volRegime"], "Put credit vertical + volRegime"), VIX3M_START)
    add("put-credit/B", "SPY put credit vertical, no gate", SPY_PUT, VIX3M_START)
    add("vix-term-gate/A", "SPY put credit vertical, contango gate",
        with_filter(SPY_PUT, GATES["vixTermStructure"], "Put credit vertical + vixTermStructure"), VIX3M_START)
    start = first("qc-same-month-seasonality")
    add("same-month-seasonality/A", "Top 2 by same-month average return, score > 0", SEASON_TOP2, start)
    add("same-month-seasonality/B", "Always-on monthly call debit verticals", SEASON_ELIGIBLE, start)
    start = min(facts.iv_start[symbol] for symbol in EQUITY4)
    add("turn-of-the-month/A", "Turn-of-month window -2..+3 as trade dates",
        definition("Turn of month -3..2", CALENDAR_CALL, filters=[turn_of_month(-3, 2)],
                   book=portfolio(EQUITY4, "window")), start)
    add("turn-of-the-month/A-L", "Literal filter -2..+3 on signal bars",
        definition("Turn of month -2..3", CALENDAR_CALL, filters=[turn_of_month(-2, 3)],
                   book=portfolio(EQUITY4, "window")), start)
    add("turn-of-the-month/B", "Always-on monthly call debit verticals", MONTHLY30, start)
    return runs


def _gates(gate: str, number: int) -> tuple[Gate, ...]:
    after_start = "" if number == 1 else f"@{VIX3M_START}"
    return (Gate(gate, "sma30-market-timing (SPY)", f"S0{after_start}", f"S{number}"),
            Gate(gate, "donchianBreakout (Core 7)", f"D0{after_start}", f"D{number}"))


IDEAS: tuple[Idea, ...] = (
    Idea("qc-asset-class-trend", "Asset-Class Trend Following (QuantConnect port)",
         (("A", "asset-class-trend/A"), ("B", "asset-class-trend/B"))),
    Idea("qc-futures-trend-carry", "Futures Trend and Carry (QuantConnect port)",
         (("A", "futures-trend-carry/A"), ("B", "futures-trend-carry/B"), ("A-L", "futures-trend-carry/A-L"))),
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
         (("A", "opex-week/A"), ("B", "opex-week/B"), ("A-L", "opex-week/A-L"))),
    Idea("qc-regime-put-vrp", "Regime-Gated Put Premium (QuantConnect port)",
         (("A", "regime-put-vrp/A"), ("B", "put-credit/B"), ("S0", "S0"), ("S2", "S2"), ("D0", "D0"),
          ("D2", "D2")), _gates("volRegime", 2)),
    Idea("qc-same-month-seasonality", "Same-Month Seasonality (QuantConnect port)",
         (("A", "same-month-seasonality/A"), ("B", "same-month-seasonality/B"))),
    Idea("qc-turn-of-the-month", "Turn of the Month (QuantConnect port)",
         (("A", "turn-of-the-month/A"), ("B", "turn-of-the-month/B"), ("A-L", "turn-of-the-month/A-L"))),
    Idea("qc-vix-term-gate", "VIX Term-Structure Gate (QuantConnect port)",
         (("A", "vix-term-gate/A"), ("B", "put-credit/B"), ("S0", "S0"), ("S3", "S3"), ("D0", "D0"),
          ("D3", "D3")), _gates("vixTermStructure < 1 (contango)", 3)),
)


# --------------------------------------------------------------------------- descriptive (reports only)

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
    """Month index -> (a0, a1, t of a1, predicted excess return) of the oil regression, for the report's
    coefficient table (the run's signal is the DSL `regression` expression of OIL_FORECAST).

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
