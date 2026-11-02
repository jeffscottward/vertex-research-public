"""BridgingCycles short strangle: research-only strategy definition and simulator.

Authoritative rules: ``docs/specs/strategies/bridgingcycles-short-strangle.md``.
Every rule carries its basis: S = stated by the creator in the source Reel,
A = Vertex assumption (a configurable default, NOT the creator's rule).

Research only. Nothing here places, stages or routes orders, touches a broker,
or performs I/O. The simulator consumes caller-supplied daily observations and
a caller-supplied mark (pricing) callback; results are hypothetical gross P&L
with mid fills, no commissions, slippage, assignment or margin modelling.
A short strangle has UNDEFINED risk on both sides; the stop rule (spec rule 10,
assumption) is a research exit, not a loss bound.
"""

from __future__ import annotations

import math
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import Any, Literal

STRATEGY_ID = "bridgingcycles-short-strangle-v1"
STRATEGY_TYPE = "short_strangle"
SPEC_PATH = "docs/specs/strategies/bridgingcycles-short-strangle.md"

OptionRight = Literal["call", "put"]
RuleBasisCode = Literal["S", "A", "S (example)", "S (example) + A", "S (implied)"]
ExitReason = Literal[
    "profit_target",
    "stop_loss",
    "time_stop",
    "expiry",
    "open_at_end_of_data",
]


@dataclass(frozen=True)
class StrategySource:
    """Where the rules came from. Transcript figures are unverified readings."""

    creator: str = "@bridgingcycles (Instagram)"
    uploader_id: str = "77824923215"
    reel_url: str = "https://www.instagram.com/reel/DeDxRuNgP2F/"
    published_at: str = "2026-10-04T04:26:36Z"
    caption: str = "Here’s how I trade short strangles"
    knowledge_base_path: str = (
        "~/Github/knowledge-bases/trading/bridgingcycles-instagram/sources/"
        "DeDxRuNgP2F.md"
    )
    knowledge_base_commit: str = "a1637798"
    related_concepts: tuple[str, ...] = (
        "volatility-pricing-and-option-selling",
        "short-option-position-management",
    )
    transcript_basis: str = (
        "faster-whisper small.en, machine-generated and unverified"
    )
    spec_path: str = SPEC_PATH


@dataclass(frozen=True)
class RuleBasis:
    """One spec rule with its S/A basis and transcript evidence."""

    number: str
    basis: RuleBasisCode
    rule: str
    evidence: str


RULES: tuple[RuleBasis, ...] = (
    RuleBasis("1", "S", "Sell one put and one call, same underlying, same expiry, "
              "equal quantity.", '0:07 "selling a put and selling a call on the same '
              'underlying expiring on the same expiration date"'),
    RuleBasis("2", "S", "Short vega, long theta, range-bound between the short "
              "strikes.", '0:14 "short vega"; 0:21 "long theta"; 0:36 "range bound"'),
    RuleBasis("3", "S (example)", "Any underlying currently showing a variance risk "
              "premium; TLT is the worked example.", '0:41-0:46'),
    RuleBasis("4", "S", "Entry filter: VRP = IV - RV must be positive.",
              '0:50 "implied volatility is higher than the underlying has realized"; '
              "0:57 IV ~18%, RV ~10.25%"),
    RuleBasis("5", "S", "VRP gap extreme versus its own 252-trading-day history.",
              '1:15 "99.2nd percentile ... over the past 252 trading days"'),
    RuleBasis("5a", "A", "Entry threshold: VRP percentile >= 90 over 252 days.",
              "Creator gave only the 99.2 example; no threshold stated."),
    RuleBasis("5b", "A", "RV window 21 trading days; IV = ATM IV of selected expiry.",
              '"last month of trading days" interpreted as 21; IV tenor not stated.'),
    RuleBasis("6", "S (example) + A", "Nearest standard monthly expiry with 30-60 DTE.",
              '1:51 "November monthly expiration"; DTE window is an assumption.'),
    RuleBasis("7", "S", "Short strikes just outside the expiry's expected move.",
              '1:47 "right outside the expected move"; TLT 77.5, move ~$4, 73/82'),
    RuleBasis("7a", "A", "Expected move = spot * IV * sqrt(DTE/365); strike = first "
              "listed strike beyond spot -/+ move. No delta rule.",
              "Creator gave no formula or delta."),
    RuleBasis("8", "S", "Open both legs at the same time; never leg in.",
              '2:07 "selling these at the same time. I do not leg in or out"'),
    RuleBasis("9", "S", "Close both legs together once premium is adequate.",
              '2:11 "take them off at the same time"'),
    RuleBasis("9a", "A", "Profit target 50% of entry credit; time stop at 21 DTE.",
              '"Adequate premium" is undefined.'),
    RuleBasis("10", "A", "Stop: close both legs when mark reaches 2x entry credit "
              "(loss = 1x credit) or at expiry; no rolling.",
              "No stop, adjustment or rolling rule stated."),
    RuleBasis("11", "A", "Size: 1 contract per leg; margin recorded as unknown.",
              "Not stated."),
    RuleBasis("12", "S (implied)", "No trade when IV <= RV or VRP not extreme.",
              "Implied by 0:46-1:38; other exclusions would be assumptions."),
)

# Implementation choices required to compute the rules but not covered by any
# spec rule. They are assumptions in the same sense as the spec's "A" rules.
IMPLEMENTATION_ASSUMPTIONS: tuple[str, ...] = (
    "RV = sample stdev of daily log close-to-close returns over rv_window_days, "
    "annualized by sqrt(rv_annualization_days=252) (supports rule 5b).",
    "VRP percentile = 100 * share of the trailing vrp_lookback_days VRP values "
    "(current day included) that are <= the current VRP; requires a full window.",
    "Standard monthly expiry = third Friday of the month; exchange holidays are "
    "not modelled unless the caller supplies listed expiries.",
    "'Beyond' the expected move means put strike <= spot - move and call strike "
    ">= spot + move (nearest such listed strike).",
    "Fills and marks at mid supplied by the caller's mark function; no fees, "
    "slippage, early assignment, or margin model.",
    "One open strangle at a time; no re-entry on the exit day.",
    "Exit checks in order stop_loss, profit_target, time_stop, expiry on each "
    "daily mark; an expiring position settles at intrinsic value.",
)


@dataclass(frozen=True)
class BridgingCyclesShortStrangleParams:
    """Configurable rule parameters. Defaults marked A are Vertex assumptions."""

    rv_window_days: int = 21  # A, spec rule 5b
    rv_annualization_days: int = 252  # A, implementation (rule 5b support)
    vrp_lookback_days: int = 252  # S, spec rule 5
    vrp_entry_percentile: float = 90.0  # A, spec rule 5a
    min_dte: int = 30  # A, spec rule 6
    max_dte: int = 60  # A, spec rule 6
    monthly_expiry_only: bool = True  # S (example) + A, spec rule 6
    expected_move_day_count: int = 365  # A, spec rule 7a
    profit_target_fraction: float = 0.50  # A, spec rule 9a
    stop_loss_multiple: float = 2.0  # A, spec rule 10
    time_stop_dte: int = 21  # A, spec rule 9a
    contracts: int = 1  # A, spec rule 11
    contract_multiplier: int = 100  # standard equity/ETF option multiplier

    def __post_init__(self) -> None:
        if self.rv_window_days < 2 or self.rv_annualization_days < 1:
            raise ValueError("rv window needs at least two returns")
        if self.vrp_lookback_days < 1:
            raise ValueError("vrp lookback must be positive")
        if not 0.0 <= self.vrp_entry_percentile <= 100.0:
            raise ValueError("vrp entry percentile must be within [0, 100]")
        if not 0 < self.min_dte <= self.max_dte:
            raise ValueError("DTE window must satisfy 0 < min_dte <= max_dte")
        if self.expected_move_day_count < 1:
            raise ValueError("expected move day count must be positive")
        if not 0.0 < self.profit_target_fraction < 1.0:
            raise ValueError("profit target fraction must be within (0, 1)")
        if self.stop_loss_multiple <= 1.0:
            raise ValueError("stop loss multiple must exceed 1x credit")
        if not 0 <= self.time_stop_dte < self.min_dte:
            raise ValueError("time stop DTE must be below min_dte")
        if self.contracts < 1 or self.contract_multiplier < 1:
            raise ValueError("contracts and multiplier must be positive")


@dataclass(frozen=True)
class StrikeSelection:
    spot: float
    implied_volatility: float
    dte: int
    expected_move: float
    lower_bound: float
    upper_bound: float
    put_strike: float
    call_strike: float


@dataclass(frozen=True)
class EntryDecision:
    eligible: bool
    reasons: tuple[str, ...]
    realized_volatility: float | None
    vrp: float | None
    vrp_percentile: float | None


@dataclass(frozen=True)
class DailyObservation:
    """One trading day of research input.

    ``atm_iv`` is the annualized ATM implied volatility of the target expiry
    (decimal, 0.18 = 18%). ``listed_strikes``/``listed_expiries`` are optional
    chain metadata; when absent the simulator uses ``strike_increment`` and
    computed third-Friday monthlies. ``chain_marks`` optionally maps
    ``(right, strike, expiry)`` to a mid price for :func:`chain_snapshot_marks`.
    """

    day: date
    spot: float
    atm_iv: float | None
    listed_strikes: tuple[float, ...] | None = None
    listed_expiries: tuple[date, ...] | None = None
    chain_marks: Mapping[tuple[OptionRight, float, date], float] | None = None


MarkFn = Callable[[DailyObservation, OptionRight, float, date], float | None]
"""Return the per-share mid mark of one option on that day, or None if absent."""


@dataclass(frozen=True)
class DailySignal:
    day: date
    spot: float
    atm_iv: float | None
    realized_volatility: float | None
    vrp: float | None
    vrp_percentile: float | None
    eligible: bool
    reasons: tuple[str, ...]


@dataclass(frozen=True)
class SimulatedTrade:
    """Both legs open and close together (spec rules 8 and 9)."""

    entry_day: date
    expiry: date
    entry_dte: int
    put_strike: float
    call_strike: float
    entry_spot: float
    entry_iv: float
    expected_move: float
    entry_credit: float  # per share, put mid + call mid
    entry_vrp: float
    entry_vrp_percentile: float
    exit_day: date
    exit_reason: ExitReason
    exit_debit: float  # per share, cost to close both legs
    pnl: float  # (credit - debit) * multiplier * contracts
    contracts: int
    max_loss_basis: str = "undefined_risk; stop is a research exit, not a bound"


@dataclass(frozen=True)
class SimulationResult:
    strategy_id: str
    params: BridgingCyclesShortStrangleParams
    signals: tuple[DailySignal, ...]
    trades: tuple[SimulatedTrade, ...]
    skipped_entries: tuple[tuple[date, str], ...]
    total_pnl: float
    research_only: bool = True


@dataclass(frozen=True)
class BridgingCyclesShortStrangleDefinition:
    """Rules 1-12 of the BridgingCycles short strangle as configurable code."""

    params: BridgingCyclesShortStrangleParams = field(
        default_factory=BridgingCyclesShortStrangleParams
    )
    source: StrategySource = field(default_factory=StrategySource)
    rules: tuple[RuleBasis, ...] = RULES
    implementation_assumptions: tuple[str, ...] = IMPLEMENTATION_ASSUMPTIONS
    strategy_id: str = STRATEGY_ID
    strategy_type: str = STRATEGY_TYPE
    research_only: bool = True

    def rule(self, number: str) -> RuleBasis:
        for item in self.rules:
            if item.number == number:
                return item
        raise KeyError(number)

    # Rules 4, 5, 5a, 5b, 12 -------------------------------------------------
    def realized_volatility(self, closes: Sequence[float]) -> float | None:
        """Annualized RV of the trailing ``rv_window_days`` returns (rule 5b, A)."""

        return realized_volatility(
            closes,
            window=self.params.rv_window_days,
            annualization_days=self.params.rv_annualization_days,
        )

    def entry_decision(
        self,
        *,
        atm_iv: float | None,
        realized_vol: float | None,
        vrp_history: Sequence[float],
    ) -> EntryDecision:
        """Apply the VRP entry filter (rules 4, 5, 5a, 12).

        ``vrp_history`` is the trailing VRP series ending with the current day.
        """

        reasons: list[str] = []
        if atm_iv is None or atm_iv <= 0:
            reasons.append("missing ATM implied volatility")
        if realized_vol is None:
            reasons.append("insufficient history for realized volatility")
        if reasons:
            return EntryDecision(False, tuple(reasons), realized_vol, None, None)
        assert atm_iv is not None and realized_vol is not None
        vrp = atm_iv - realized_vol
        percentile = vrp_percentile(vrp_history, self.params.vrp_lookback_days)
        if vrp <= 0:
            reasons.append("no variance risk premium (IV <= RV)")
        if percentile is None:
            reasons.append("insufficient VRP history for percentile")
        elif percentile < self.params.vrp_entry_percentile:
            reasons.append("VRP percentile below entry threshold")
        return EntryDecision(not reasons, tuple(reasons), realized_vol, vrp, percentile)

    # Rule 6 ----------------------------------------------------------------
    def select_expiry(
        self,
        as_of: date,
        listed_expiries: Sequence[date] | None = None,
    ) -> date | None:
        """Nearest (standard monthly) expiry within [min_dte, max_dte]."""

        candidates = (
            sorted(set(listed_expiries))
            if listed_expiries is not None
            else _monthly_expiries_after(as_of, self.params.max_dte)
        )
        for expiry in candidates:
            dte = (expiry - as_of).days
            if dte < self.params.min_dte or dte > self.params.max_dte:
                continue
            if self.params.monthly_expiry_only and not is_standard_monthly(expiry):
                continue
            return expiry
        return None

    # Rules 7, 7a -----------------------------------------------------------
    def expected_move(self, spot: float, implied_vol: float, dte: int) -> float:
        return expected_move(
            spot, implied_vol, dte, day_count=self.params.expected_move_day_count
        )

    def select_strikes(
        self,
        *,
        spot: float,
        implied_vol: float,
        dte: int,
        listed_strikes: Sequence[float],
        move: float | None = None,
    ) -> StrikeSelection | None:
        """First listed strike at or beyond spot -/+ expected move (rule 7a, A).

        ``move`` overrides the formula, e.g. with a broker-displayed expected move.
        """

        em = self.expected_move(spot, implied_vol, dte) if move is None else move
        lower, upper = spot - em, spot + em
        puts = [strike for strike in listed_strikes if strike <= lower]
        calls = [strike for strike in listed_strikes if strike >= upper]
        if not puts or not calls:
            return None
        put_strike, call_strike = max(puts), min(calls)
        if not put_strike < call_strike:
            return None
        return StrikeSelection(
            spot=spot,
            implied_volatility=implied_vol,
            dte=dte,
            expected_move=em,
            lower_bound=lower,
            upper_bound=upper,
            put_strike=put_strike,
            call_strike=call_strike,
        )

    # Rules 9a, 10 ----------------------------------------------------------
    def exit_reason(
        self,
        *,
        entry_credit: float,
        mark: float | None,
        dte: int,
    ) -> ExitReason | None:
        """Exit check on one daily mark; both legs always close together."""

        if dte <= 0:
            return "expiry"
        if mark is not None:
            if mark >= self.params.stop_loss_multiple * entry_credit:
                return "stop_loss"
            if mark <= (1.0 - self.params.profit_target_fraction) * entry_credit:
                return "profit_target"
        if dte <= self.params.time_stop_dte:
            return "time_stop" if mark is not None else None
        return None


# ---------------------------------------------------------------------------
# Pure helpers
# ---------------------------------------------------------------------------


def realized_volatility(
    closes: Sequence[float],
    *,
    window: int = 21,
    annualization_days: int = 252,
) -> float | None:
    """Annualized sample stdev of the last ``window`` daily log returns."""

    if len(closes) < window + 1:
        return None
    tail = closes[-(window + 1):]
    if any(value <= 0 for value in tail):
        raise ValueError("closes must be positive")
    returns = [math.log(tail[i + 1] / tail[i]) for i in range(window)]
    mean = sum(returns) / window
    variance = sum((item - mean) ** 2 for item in returns) / (window - 1)
    return math.sqrt(variance) * math.sqrt(annualization_days)


def vrp_percentile(history: Sequence[float], lookback: int = 252) -> float | None:
    """Percentile rank (0-100) of the last value within the trailing window."""

    if len(history) < lookback:
        return None
    window = history[-lookback:]
    current = window[-1]
    return 100.0 * sum(1 for value in window if value <= current) / lookback


def expected_move(
    spot: float,
    implied_vol: float,
    dte: int,
    *,
    day_count: int = 365,
) -> float:
    """spot * IV * sqrt(DTE / day_count) (spec rule 7a, assumption)."""

    if spot <= 0 or implied_vol < 0 or dte < 0:
        raise ValueError("expected move requires positive spot, IV >= 0, DTE >= 0")
    return spot * implied_vol * math.sqrt(dte / day_count)


def third_friday(year: int, month: int) -> date:
    first = date(year, month, 1)
    offset = (4 - first.weekday()) % 7
    return first + timedelta(days=offset + 14)


def is_standard_monthly(expiry: date) -> bool:
    return expiry == third_friday(expiry.year, expiry.month)


def _monthly_expiries_after(as_of: date, max_dte: int) -> list[date]:
    out: list[date] = []
    year, month = as_of.year, as_of.month
    horizon = as_of + timedelta(days=max_dte)
    while True:
        expiry = third_friday(year, month)
        if expiry > horizon:
            return out
        if expiry > as_of:
            out.append(expiry)
        year, month = (year + 1, 1) if month == 12 else (year, month + 1)


def _strike_grid(spot: float, increment: float, width_fraction: float = 0.5) -> list[float]:
    low = math.floor(spot * (1 - width_fraction) / increment) * increment
    high = math.ceil(spot * (1 + width_fraction) / increment) * increment
    steps = int(round((high - low) / increment))
    return [round(low + i * increment, 10) for i in range(steps + 1)]


def chain_snapshot_marks(
    observation: DailyObservation,
    right: OptionRight,
    strike: float,
    expiry: date,
) -> float | None:
    """MarkFn reading ``DailyObservation.chain_marks`` snapshots."""

    if observation.chain_marks is None:
        return None
    return observation.chain_marks.get((right, strike, expiry))


def black_scholes_marks(rate: float = 0.0) -> MarkFn:
    """Synthetic MarkFn: Black-Scholes at the day's ATM IV (flat vol, A).

    For research fixtures only; it ignores skew and uses ACT/365 time.
    """

    def mark(
        observation: DailyObservation,
        right: OptionRight,
        strike: float,
        expiry: date,
    ) -> float | None:
        if observation.atm_iv is None:
            return None
        dte = (expiry - observation.day).days
        return black_scholes_price(
            right, observation.spot, strike, dte / 365, observation.atm_iv, rate
        )

    return mark


def black_scholes_price(
    right: OptionRight,
    spot: float,
    strike: float,
    years: float,
    vol: float,
    rate: float = 0.0,
) -> float:
    intrinsic = max(spot - strike, 0.0) if right == "call" else max(strike - spot, 0.0)
    if years <= 0 or vol <= 0:
        return intrinsic
    sqrt_t = math.sqrt(years)
    d1 = (math.log(spot / strike) + (rate + 0.5 * vol * vol) * years) / (vol * sqrt_t)
    d2 = d1 - vol * sqrt_t
    discount = math.exp(-rate * years)
    if right == "call":
        return spot * _norm_cdf(d1) - strike * discount * _norm_cdf(d2)
    return strike * discount * _norm_cdf(-d2) - spot * _norm_cdf(-d1)


def _norm_cdf(value: float) -> float:
    return 0.5 * (1.0 + math.erf(value / math.sqrt(2.0)))


# ---------------------------------------------------------------------------
# Research backtest hookup
# ---------------------------------------------------------------------------


def simulate_bridgingcycles_short_strangle(
    observations: Sequence[DailyObservation],
    mark: MarkFn,
    *,
    definition: BridgingCyclesShortStrangleDefinition | None = None,
    strike_increment: float = 1.0,
) -> SimulationResult:
    """Daily entry signals plus a simulated lifecycle of each strangle.

    Pure: no clock, storage, network or broker. ``observations`` must be in
    strictly increasing date order (trading days only). Entry and exit fills are
    the ``mark`` mids of both legs on the same day (rules 8 and 9).
    """

    definition = definition or BridgingCyclesShortStrangleDefinition()
    params = definition.params
    _require_ordered(observations)

    closes: list[float] = []
    vrps: list[float] = []
    signals: list[DailySignal] = []
    trades: list[SimulatedTrade] = []
    skipped: list[tuple[date, str]] = []
    open_trade: dict[str, Any] | None = None

    for observation in observations:
        closes.append(observation.spot)
        rv = definition.realized_volatility(closes)
        if rv is not None and observation.atm_iv is not None:
            vrps.append(observation.atm_iv - rv)
            history: Sequence[float] = vrps
        else:
            history = ()
        decision = definition.entry_decision(
            atm_iv=observation.atm_iv, realized_vol=rv, vrp_history=history
        )
        signals.append(
            DailySignal(
                day=observation.day,
                spot=observation.spot,
                atm_iv=observation.atm_iv,
                realized_volatility=decision.realized_volatility,
                vrp=decision.vrp,
                vrp_percentile=decision.vrp_percentile,
                eligible=decision.eligible,
                reasons=decision.reasons,
            )
        )

        if open_trade is not None:
            closed = _evaluate_open_trade(definition, open_trade, observation, mark)
            if closed is not None:
                trades.append(closed)
                open_trade = None
            continue  # one position at a time; no re-entry on the exit day

        if not decision.eligible:
            continue
        opened, reason = _open_trade(
            definition, observation, decision, mark, strike_increment
        )
        if opened is None:
            skipped.append((observation.day, reason))
        else:
            open_trade = opened

    if open_trade is not None and observations:
        last = observations[-1]
        debit = _strangle_mark(open_trade, last, mark)
        if debit is None:
            debit = open_trade["last_mark"]
        trades.append(_close(open_trade, last.day, "open_at_end_of_data", debit, params))

    return SimulationResult(
        strategy_id=definition.strategy_id,
        params=params,
        signals=tuple(signals),
        trades=tuple(trades),
        skipped_entries=tuple(skipped),
        total_pnl=round(sum(trade.pnl for trade in trades), 6),
    )


def _open_trade(
    definition: BridgingCyclesShortStrangleDefinition,
    observation: DailyObservation,
    decision: EntryDecision,
    mark: MarkFn,
    strike_increment: float,
) -> tuple[dict[str, Any] | None, str]:
    expiry = definition.select_expiry(observation.day, observation.listed_expiries)
    if expiry is None:
        return None, "no monthly expiry within DTE window"
    assert observation.atm_iv is not None
    dte = (expiry - observation.day).days
    strikes = (
        observation.listed_strikes
        if observation.listed_strikes is not None
        else _strike_grid(observation.spot, strike_increment)
    )
    selection = definition.select_strikes(
        spot=observation.spot,
        implied_vol=observation.atm_iv,
        dte=dte,
        listed_strikes=strikes,
    )
    if selection is None:
        return None, "no listed strikes beyond expected move"
    put_mid = mark(observation, "put", selection.put_strike, expiry)
    call_mid = mark(observation, "call", selection.call_strike, expiry)
    if put_mid is None or call_mid is None:
        return None, "missing entry mark for a leg"
    credit = put_mid + call_mid
    if credit <= 0:
        return None, "non-positive entry credit"
    assert decision.vrp is not None and decision.vrp_percentile is not None
    return {
        "entry_day": observation.day,
        "expiry": expiry,
        "entry_dte": dte,
        "selection": selection,
        "entry_credit": credit,
        "entry_vrp": decision.vrp,
        "entry_vrp_percentile": decision.vrp_percentile,
        "last_mark": credit,
    }, ""


def _evaluate_open_trade(
    definition: BridgingCyclesShortStrangleDefinition,
    trade: dict[str, Any],
    observation: DailyObservation,
    mark: MarkFn,
) -> SimulatedTrade | None:
    dte = (trade["expiry"] - observation.day).days
    if dte <= 0:
        selection: StrikeSelection = trade["selection"]
        intrinsic = max(selection.put_strike - observation.spot, 0.0) + max(
            observation.spot - selection.call_strike, 0.0
        )
        return _close(trade, observation.day, "expiry", intrinsic, definition.params)
    current = _strangle_mark(trade, observation, mark)
    if current is not None:
        trade["last_mark"] = current
    reason = definition.exit_reason(
        entry_credit=trade["entry_credit"], mark=current, dte=dte
    )
    if reason is None or current is None:
        return None
    return _close(trade, observation.day, reason, current, definition.params)


def _strangle_mark(
    trade: dict[str, Any],
    observation: DailyObservation,
    mark: MarkFn,
) -> float | None:
    selection: StrikeSelection = trade["selection"]
    put_mid = mark(observation, "put", selection.put_strike, trade["expiry"])
    call_mid = mark(observation, "call", selection.call_strike, trade["expiry"])
    if put_mid is None or call_mid is None:
        return None
    return put_mid + call_mid


def _close(
    trade: dict[str, Any],
    day: date,
    reason: ExitReason,
    debit: float,
    params: BridgingCyclesShortStrangleParams,
) -> SimulatedTrade:
    selection: StrikeSelection = trade["selection"]
    credit = trade["entry_credit"]
    pnl = (credit - debit) * params.contract_multiplier * params.contracts
    return SimulatedTrade(
        entry_day=trade["entry_day"],
        expiry=trade["expiry"],
        entry_dte=trade["entry_dte"],
        put_strike=selection.put_strike,
        call_strike=selection.call_strike,
        entry_spot=selection.spot,
        entry_iv=selection.implied_volatility,
        expected_move=selection.expected_move,
        entry_credit=credit,
        entry_vrp=trade["entry_vrp"],
        entry_vrp_percentile=trade["entry_vrp_percentile"],
        exit_day=day,
        exit_reason=reason,
        exit_debit=debit,
        pnl=round(pnl, 6),
        contracts=params.contracts,
    )


def _require_ordered(observations: Sequence[DailyObservation]) -> None:
    for previous, current in zip(observations, observations[1:]):
        if current.day <= previous.day:
            raise ValueError("observations must be in strictly increasing date order")


__all__ = [
    "BridgingCyclesShortStrangleDefinition",
    "BridgingCyclesShortStrangleParams",
    "DailyObservation",
    "DailySignal",
    "EntryDecision",
    "IMPLEMENTATION_ASSUMPTIONS",
    "MarkFn",
    "RULES",
    "RuleBasis",
    "STRATEGY_ID",
    "STRATEGY_TYPE",
    "SimulatedTrade",
    "SimulationResult",
    "StrategySource",
    "StrikeSelection",
    "black_scholes_marks",
    "black_scholes_price",
    "chain_snapshot_marks",
    "expected_move",
    "is_standard_monthly",
    "realized_volatility",
    "simulate_bridgingcycles_short_strangle",
    "third_friday",
    "vrp_percentile",
]
