"""Portfolio allocation research on the qc-ports options runner (research only).

Nothing here creates an order, a deployment request or a preset. The functions take priced
defined-risk verticals (book.py) and return numbers for a written proposal.

Owner exit rule (2026-11-03): a winner may run to expiry; a loser closes 3 trading days before
expiry; an open winner closes on expiry day. `owner_rule_trades` applies it to one definition:

- every leg runs with its `options` block without `profitTakePct` and `exitDte`, so a spread
  ends at its signal exit, at expiry (intrinsic value at that close) or at the end of the data;
- each trade is priced a second time with `exitDte` = OWNER_LOSER_EXIT_DTE (calendar days: a
  Friday expiry closes on Tuesday, 3 trading days before, when no holiday falls in between);
- the second version replaces the first when it closed on `exitDte` at a loss after its closing
  cost (exit reason `ownerLoserCut`). The slot of a `flat` or `window` leg still frees on the first
  version's exit date, so the later trades of the leg do not move;
- a spread that reaches expiry with a leg in the money pays the modeled closing cost (the owner
  closes it before the bell; book.py settles it without costs). A spread with both legs out of
  the money expires without a trade and without a cost.

Portfolio: `combine` puts the trades of several strategies into one account. Each strategy has
a risk per position (percent of equity, the trade's `max_loss_pct`) and belongs to a sleeve; a new
trade is refused when the open risk of the account, of its sleeve, of its underlying or the number
of open positions would pass the caps. The combined trades run in ledger.run_ledger and
nautilus_runner.run_nautilus like any run. Limits of `combine`: it is first come, first served, so
the order of the strategies decides who gets a contested slot; a refused entry is not tried again
later; a position counts with its budget even when the ledger then sizes it to 0 contracts; and
the caps are shares of the equity at each entry, not of the equity on a later day.

Statistics: out-of-sample Sharpe (last 40% of the days, the Autopilot gate split), a bootstrap
Monte Carlo of the trade P&L (the method of packages/api/src/backtest-analytics.ts), Pearson
correlation of daily returns and three weighting methods (equal risk, inverse volatility,
shrunk Sharpe).
"""
from __future__ import annotations

import dataclasses
import math
import random
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from statistics import mean, stdev

from nautilus_backtest import signals as sig

from . import portfolio as pf
from . import ideas as qi
from . import options as om
from .book import MAX_LOSS_PCT_CAP, STRUCTURES, PricedTrade, SignalEvent, build_book, worst_exit_cost
from .ledger import LedgerResult

__all__ = [
    "GATE", "HOSTS", "IN_SAMPLE_FRACTION", "MONTE_CARLO_PATHS", "OVERLAY_IDEAS", "OWNER_LOSER_EXIT_DTE", "SLEEVES",
    "TRADING_DAYS", "Caps", "Combined", "combine", "correlation", "daily_returns", "equal_risk", "expiry_close_fee",
    "gate_checks", "hold_options", "inverse_volatility", "monte_carlo", "out_of_sample_sharpe", "owner_rule_trades",
    "qc_candidates", "sharpe", "shrunk_sharpe", "trade_pnl", "window_metrics",
]

OWNER_LOSER_EXIT_DTE = 3
IN_SAMPLE_FRACTION = 0.6
MONTE_CARLO_PATHS = 1000
TRADING_DAYS = 252
OWNER_CUT_REASON = "ownerLoserCut"
TIME_EXIT_KEYS = ("profitTakePct", "exitDte")


# --------------------------------------------------------------------------- owner exit rule

def hold_options(options: Mapping) -> dict:
    """The options block without its profit-take and time exits (the trade may run to expiry)."""
    return {key: value for key, value in options.items() if key not in TIME_EXIT_KEYS}


def trade_pnl(trade: PricedTrade) -> float:
    """P&L of one contract after the entry and exit costs."""
    return trade.exit_price - trade.entry_price - trade.entry_fee - trade.exit_fee


def _same_entry(a: PricedTrade, b: PricedTrade) -> bool:
    return (a.symbol, a.entry_index, a.expiry, a.long_strike, a.short_strike, a.entry_price, a.entry_fee) == (
        b.symbol, b.entry_index, b.expiry, b.long_strike, b.short_strike, b.entry_price, b.entry_fee)


def expiry_close_fee(trade: PricedTrade, spot: float) -> float:
    """Cost per contract of closing `trade` at `spot` on its expiry day; 0 when both legs are out of the money.

    The same cost model as book.py: commission and half-spread per leg on the leg's intrinsic value,
    at most book.worst_exit_cost (the package-close cap the max loss already contains).
    """
    right = STRUCTURES[trade.structure][0]
    values = [max(0.0, spot - strike) if right == "call" else max(0.0, strike - spot)
              for strike in (trade.long_strike, trade.short_strike)]
    if not any(values):
        return 0.0
    cost = round(sum(om.leg_cost(trade.symbol, value) for value in values), 2)
    return min(cost, worst_exit_cost(trade.symbol, trade.width))


def _owner_exit(trade: PricedTrade, options: Mapping, market) -> PricedTrade:
    """`trade` (priced without time exits) with its expiry closing cost, or its loser cut 3 days before expiry."""
    exit_signal = trade.exit_index - 1 if trade.exit_reason == "signal" else None
    event = SignalEvent(trade.symbol, trade.entry_index - 1, exit_signal)
    again = build_book([event], options, {trade.symbol: market}).trades
    if len(again) != 1 or not _same_entry(again[0], trade) or again[0].exit_index != trade.exit_index:
        raise RuntimeError(f"Could not price {trade.symbol} {trade.entry_date} again from its signal bars")
    # No second version when the spread is entered inside the cut window (the book skips it).
    cuts = build_book([event], {**options, "exitDte": OWNER_LOSER_EXIT_DTE}, {trade.symbol: market}).trades
    if cuts and cuts[0].exit_reason == "exitDte" and trade_pnl(cuts[0]) < 0:
        return dataclasses.replace(cuts[0], trade_id=trade.trade_id, exit_reason=OWNER_CUT_REASON)
    if trade.exit_reason == "expiry":
        return dataclasses.replace(trade, exit_fee=expiry_close_fee(trade, market.close[trade.exit_index]))
    return trade


def owner_rule_trades(definition: Mapping, data: pf.Dataset, *, start: str) -> tuple[PricedTrade, ...]:
    """The priced trades of an options definition under the owner exit rule, ids 1..n by entry."""
    sig.normalize_definition(definition)
    legs, flags, selected = pf._signals(definition, data, None)
    collected = []
    for leg in legs:
        options = hold_options(leg.definition["options"])
        held = dataclasses.replace(leg, definition={**leg.definition, "options": options})
        entries, exits = flags[leg.order]
        trades, _skips, _count = pf.leg_trades(held, data, start, entries, exits,
                                               None if selected is None else selected[leg.order])
        market = pf.market_of(data, leg.symbol)
        for trade in trades:
            final = _owner_exit(trade, options, market)
            collected.append((final.entry_date, leg.order, final.entry_index, final))
    collected.sort(key=lambda item: item[:3])
    return tuple(dataclasses.replace(item[3], trade_id=number) for number, item in enumerate(collected, start=1))


# --------------------------------------------------------------------------- candidates

# Sleeve of each QuantConnect idea port.
SLEEVES = {
    "qc-asset-class-trend": "trend", "qc-futures-trend-carry": "trend", "qc-momentum-rotation": "rotation",
    "qc-turn-of-the-month": "seasonality", "qc-opex-week": "seasonality", "qc-same-month-seasonality": "seasonality",
    "qc-oil-predicts-equity": "macro", "qc-gold-fed-model": "macro", "qc-regime-put-vrp": "vol premium",
    "qc-iv-rank-gate": "vol premium", "qc-vix-term-gate": "vol premium",
}
# Gate ideas: run A is a gate on a put-credit host (its run B). A gate is an overlay; it holds no budget.
OVERLAY_IDEAS = frozenset({"qc-iv-rank-gate", "qc-vix-term-gate", "qc-regime-put-vrp"})
# The ungated hosts of the gate ideas (run key -> slug): the vol-premium candidates.
HOSTS = {"put-credit/B": "put-credit-host-spy", "iv-rank-gate/B": "put-credit-host-core7"}


def qc_candidates(runs: Mapping[str, qi.RunSpec]) -> list[dict]:
    """Run A of every idea with its always-on baseline B, then the put-credit hosts.

    Each item: key, slug, name, sleeve, role (strategy, overlay or host), definition, start,
    baseline (run key, None for a host) and study (the key of the same run in the 2026-11-08 study).
    """
    out = []
    for idea in qi.IDEAS:
        if [label for label, _ in idea.runs[:2]] != ["A", "B"]:
            raise ValueError(f"{idea.id}: runs[0] must be A and runs[1] the baseline B")
        primary, baseline = runs[idea.key("A")], runs[idea.key("B")]
        out.append({"key": primary.key, "slug": idea.id, "name": f"{idea.title}: {primary.name}",
                    "sleeve": SLEEVES[idea.id], "role": "overlay" if idea.id in OVERLAY_IDEAS else "strategy",
                    "definition": primary.definition, "start": primary.start, "baseline": baseline.key,
                    "study": primary.key})
    hosted = {runs[idea.key("B")].key for idea in qi.IDEAS if idea.id in OVERLAY_IDEAS}
    if hosted != set(HOSTS):
        raise ValueError(f"HOSTS must be the baselines of the gate ideas: {sorted(hosted)}")
    for key, slug in HOSTS.items():
        host = runs[key]
        out.append({"key": host.key, "slug": slug, "name": f"Put-credit host: {host.name}", "sleeve": "vol premium",
                    "role": "host", "definition": host.definition, "start": host.start, "baseline": None,
                    "study": host.key})
    return out


# --------------------------------------------------------------------------- portfolio

@dataclass(frozen=True)
class Caps:
    """Account limits in percent of equity. A position counts with its risk budget (max loss).

    `sleeve_risk_pct`: sleeve -> cap on the open risk of the strategies of that sleeve
    (`sleeve_of`: strategy -> sleeve). A strategy without a sleeve has only the account caps.
    """

    open_risk_pct: float
    name_risk_pct: float = MAX_LOSS_PCT_CAP
    max_positions: int | None = None
    sleeve_of: Mapping[str, str] = dataclasses.field(default_factory=dict)
    sleeve_risk_pct: Mapping[str, float] = dataclasses.field(default_factory=dict)


@dataclass(frozen=True)
class Combined:
    trades: tuple[PricedTrade, ...]
    owner: Mapping[int, str]
    refused: Mapping[str, Mapping[str, int]]


def _refusal(open_trades: Sequence[tuple[str, str, float, str | None]], symbol: str, sleeve: str | None, risk: float,
             caps: Caps) -> str | None:
    """The first cap a new position of `risk` would pass, or None."""
    slack = 1e-9
    if sum(item[2] for item in open_trades) + risk > caps.open_risk_pct + slack:
        return "openRisk"
    if sleeve in caps.sleeve_risk_pct and sum(
            item[2] for item in open_trades if item[3] == sleeve) + risk > caps.sleeve_risk_pct[sleeve] + slack:
        return "sleeveRisk"
    if sum(item[2] for item in open_trades if item[1] == symbol) + risk > caps.name_risk_pct + slack:
        return "nameRisk"
    if caps.max_positions is not None and len(open_trades) + 1 > caps.max_positions:
        return "maxPositions"
    return None


def combine(books: Mapping[str, Sequence[PricedTrade]], risk_pct: Mapping[str, float], caps: Caps) -> Combined:
    """One trade list for one account: per-strategy risk per position, then the caps.

    Trades enter in (entry date, strategy order of `books`, trade id) order. An exit on a day frees
    its risk before that day's entries (the ledger order). A strategy with risk 0 trades nothing.
    The open risk of a position is its budget `risk_pct`; the sized loss is never above it.
    """
    for key in books:
        risk = risk_pct.get(key, 0.0)
        if not (math.isfinite(risk) and 0 <= risk <= MAX_LOSS_PCT_CAP):
            raise ValueError(f"risk per position of {key} must be between 0 and {MAX_LOSS_PCT_CAP:g}%")
    order = {key: position for position, key in enumerate(books)}
    queue = sorted(((trade.entry_date, order[key], trade.trade_id, key, trade)
                    for key, trades in books.items() if risk_pct.get(key, 0.0) > 0 for trade in trades),
                   key=lambda item: item[:3])
    open_trades: list[tuple[str, str, float, str | None]] = []  # exit date, symbol, risk, sleeve
    accepted: list[PricedTrade] = []
    owner: dict[int, str] = {}
    refused: dict[str, dict[str, int]] = {}
    for entry_date, _order, _id, key, trade in queue:
        open_trades = [item for item in open_trades if item[0] > entry_date]
        risk = risk_pct[key]
        sleeve = caps.sleeve_of.get(key)
        reason = _refusal(open_trades, trade.symbol, sleeve, risk, caps)
        if reason is not None:
            bucket = refused.setdefault(key, {})
            bucket[reason] = bucket.get(reason, 0) + 1
            continue
        number = len(accepted) + 1
        accepted.append(dataclasses.replace(trade, trade_id=number, max_loss_pct=risk))
        owner[number] = key
        open_trades.append((trade.exit_date, trade.symbol, risk, sleeve))
    return Combined(tuple(accepted), owner, refused)


# --------------------------------------------------------------------------- gate

# The eligibility gate of the allocation study. Every threshold is an existing repository constant.
GATE = {
    "minTrades": 30,                   # AUTOPILOT_GATE (packages/api/src/autopilot-gate.ts)
    "minSharpe": 0.5,                  # study.PASS_SHARPE
    "minOosSharpe": 0.5,               # AUTOPILOT_GATE out-of-sample Sharpe, last 40% of the bars
    "minDeflatedSharpe": 0.95,         # AUTOPILOT_GATE, quantjourney.ts DSR_MIN_PROBABILITY
    "minMonteCarloProfit": 0.8,        # AUTOPILOT_GATE monteCarloProfitMin
    "minMonteCarloDrawdownP5": -0.35,  # AUTOPILOT_GATE monteCarloDrawdownP5Min
    "maxDrawdown": -0.25,              # study.PASS_DRAWDOWN
}


def _at_least(value: float | None, floor: float) -> bool:
    return value is not None and math.isfinite(value) and value >= floor


def gate_checks(stats: Mapping, baseline_sharpe: float | None) -> list[dict]:
    """The checks G3 to G7 of one run: [{check, pass, value}]. A missing value fails its check.

    `stats`: trades, sharpe, oosSharpe, deflatedSharpe, maxDrawdown and monteCarlo (monte_carlo's
    result or None). `baseline_sharpe`: the Sharpe of the always-on baseline under the same exit
    rule, or None for a run that is itself a baseline (the check is then left out).
    """
    carlo = stats.get("monteCarlo") or {}
    checks = [
        ("G3 trades >= 30", _at_least(stats.get("trades"), GATE["minTrades"]), stats.get("trades")),
        ("G4 Sharpe >= 0.5", _at_least(stats.get("sharpe"), GATE["minSharpe"]), stats.get("sharpe")),
        ("G4 out-of-sample Sharpe >= 0.5", _at_least(stats.get("oosSharpe"), GATE["minOosSharpe"]), stats.get("oosSharpe")),
        ("G5 deflated Sharpe >= 0.95", _at_least(stats.get("deflatedSharpe"), GATE["minDeflatedSharpe"]),
         stats.get("deflatedSharpe")),
        ("G6 Monte Carlo P(profit) >= 0.80", _at_least(carlo.get("probabilityOfProfit"), GATE["minMonteCarloProfit"]),
         carlo.get("probabilityOfProfit")),
        ("G6 Monte Carlo drawdown p5 >= -35%", _at_least(carlo.get("drawdownP5"), GATE["minMonteCarloDrawdownP5"]),
         carlo.get("drawdownP5")),
        ("G7 max drawdown <= 25%", _at_least(stats.get("maxDrawdown"), GATE["maxDrawdown"]), stats.get("maxDrawdown")),
    ]
    if baseline_sharpe is not None:
        sharpe_value = stats.get("sharpe")
        checks.append(("G7 Sharpe above its always-on baseline",
                       sharpe_value is not None and sharpe_value > baseline_sharpe, baseline_sharpe))
    return [{"check": name, "pass": bool(ok), "value": value} for name, ok, value in checks]


# --------------------------------------------------------------------------- statistics

def daily_returns(equity: Sequence[float]) -> list[float]:
    return [equity[i] / equity[i - 1] - 1 for i in range(1, len(equity))]


def sharpe(returns: Sequence[float]) -> float:
    """Annualized Sharpe of daily returns (rf 0, sample std); 0 without variation."""
    if len(returns) < 2:
        return 0.0
    spread = stdev(returns)
    return mean(returns) / spread * math.sqrt(TRADING_DAYS) if spread > 0 else 0.0


def out_of_sample_sharpe(result: LedgerResult, fraction: float = IN_SAMPLE_FRACTION) -> tuple[str, float]:
    """(first out-of-sample day, Sharpe of the days after the first `fraction` of the run)."""
    split = int(len(result.equity) * fraction)
    return result.dates[split], sharpe(daily_returns(result.equity[split - 1:] if split > 0 else result.equity))


def window_metrics(result: LedgerResult, start: str, end: str) -> dict | None:
    """Return, max drawdown and worst day of the run days in [start, end]; None without two days."""
    picked = [(day, value) for day, value in zip(result.dates, result.equity) if start <= day <= end]
    if len(picked) < 2:
        return None
    first = result.dates.index(picked[0][0])
    base = result.equity[first - 1] if first > 0 else result.capital
    values = [base] + [value for _, value in picked]
    peak, worst = values[0], 0.0
    for value in values:
        peak = max(peak, value)
        worst = min(worst, value / peak - 1)
    return {"start": picked[0][0], "end": picked[-1][0], "return": values[-1] / values[0] - 1,
            "maxDrawdown": worst, "worstDay": min(daily_returns(values))}


def _percentile(ordered: Sequence[float], q: float) -> float:
    position = (len(ordered) - 1) * q
    low = math.floor(position)
    high = min(low + 1, len(ordered) - 1)
    return ordered[low] + (ordered[high] - ordered[low]) * (position - low)


def monte_carlo(pnls: Sequence[float], capital: float, *, paths: int = MONTE_CARLO_PATHS, seed: int = 1) -> dict | None:
    """Bootstrap of the trade P&L (sampling with replacement, the same number of trades per path).

    Returns the share of profitable paths, the 5th percentile and the worst of the path max
    drawdowns (negative numbers), or None without trades.
    """
    if not pnls:
        return None
    rng = random.Random(seed)
    count = len(pnls)
    profitable = 0
    drawdowns = []
    for _ in range(paths):
        equity = peak = capital
        worst = 0.0
        for _step in range(count):
            equity += pnls[rng.randrange(count)]
            peak = max(peak, equity)
            worst = min(worst, equity / peak - 1 if peak > 0 else -1.0)
        profitable += equity > capital
        drawdowns.append(worst)
    drawdowns.sort()
    return {"paths": paths, "probabilityOfProfit": profitable / paths,
            "drawdownP5": _percentile(drawdowns, 0.05), "worstDrawdown": drawdowns[0]}


def correlation(a: Mapping[str, float], b: Mapping[str, float]) -> float | None:
    """Pearson correlation of two daily-return maps on their common days; None under 3 days or flat."""
    days = sorted(set(a) & set(b))
    if len(days) < 3:
        return None
    xs, ys = [a[day] for day in days], [b[day] for day in days]
    mx, my = mean(xs), mean(ys)
    sxx = sum((x - mx) ** 2 for x in xs)
    syy = sum((y - my) ** 2 for y in ys)
    if sxx <= 0 or syy <= 0:
        return None
    return sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / math.sqrt(sxx * syy)


# --------------------------------------------------------------------------- weights

def _normalized(raw: Mapping[str, float]) -> dict[str, float]:
    total = sum(raw.values())
    return {key: (value / total if total > 0 else 0.0) for key, value in raw.items()}


def equal_risk(keys: Sequence[str]) -> dict[str, float]:
    """The same share of the risk budget for every strategy."""
    return _normalized(dict.fromkeys(keys, 1.0))


def inverse_volatility(volatility: Mapping[str, float]) -> dict[str, float]:
    """Shares in proportion to 1 / volatility (naive risk parity); a flat strategy gets 0."""
    return _normalized({key: (1 / value if value > 0 else 0.0) for key, value in volatility.items()})


def shrunk_sharpe(sharpes: Mapping[str, float], years: Mapping[str, float], prior_years: float = 10.0) -> dict[str, float]:
    """Shares in proportion to the Sharpe shrunk toward 0: SR * years / (years + prior_years), floored at 0.

    `prior_years` is the weight of the zero prior in years of data: with 10, a 10-year record keeps
    half of its Sharpe. A negative Sharpe gets no risk.
    """
    return _normalized({key: max(0.0, value * years[key] / (years[key] + prior_years))
                        for key, value in sharpes.items()})
