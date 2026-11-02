"""Pure wheel research projection. Never an account ledger or reservation writer.

Gamma's option-leg identity and positive-DTE restriction are preserved; the
assignment/dividend/share lifecycle is new native logic, not claimed Gamma parity.
All changes consume explicitly supplied simulated/observed events. Expiry prices
alone never prove exercise, assignment, or release of a real reservation.
"""
from __future__ import annotations

from dataclasses import dataclass, replace
from datetime import datetime
from decimal import Decimal
from typing import Literal

from .core import (ZERO, ResearchDecision, count, deterministic, identity, instant,
                   ratio, require_decimal)


@dataclass(frozen=True)
class WheelContract:
    contract_id: str
    underlying_id: str
    right: Literal["put", "call"]
    strike: Decimal
    multiplier: int
    expiry_at: datetime
    calendar_id: str
    currency: str
    exercise_style: Literal["american", "european"]
    settlement: Literal["physical", "cash"]

    def __post_init__(self):
        for value in (self.contract_id, self.underlying_id, self.calendar_id, self.currency):
            identity(value)
        require_decimal(self.strike, positive=True)
        count(self.multiplier, positive=True)
        instant(self.expiry_at)
        if self.right not in {"put", "call"} or self.exercise_style not in {"american", "european"}:
            raise ValueError("Invalid contract")
        if self.settlement not in {"physical", "cash"}:
            raise ValueError("Unknown settlement")


@dataclass(frozen=True)
class ShortOption:
    contract: WheelContract
    contracts: int

    def __post_init__(self):
        count(self.contracts, positive=True)


@dataclass(frozen=True)
class WheelEvent:
    event_id: str
    kind: Literal["open-put", "open-call", "buy-close", "put-assignment", "call-away", "expiry", "dividend"]
    at: datetime
    source_id: str
    evidence_kind: Literal["simulation", "observed"]
    contract: WheelContract | None = None
    contracts: int = 0
    price_per_share: Decimal = ZERO
    fees: Decimal = ZERO
    settlement_confirmed: bool = False
    entitled_shares: int = 0
    entitlement_at: datetime | None = None

    def __post_init__(self):
        identity(self.event_id)
        identity(self.source_id)
        instant(self.at)
        count(self.contracts)
        count(self.entitled_shares)
        require_decimal(self.price_per_share, nonnegative=True)
        require_decimal(self.fees, nonnegative=True)
        if self.evidence_kind not in {"simulation", "observed"}:
            raise ValueError("Explicit event evidence kind required")
        if self.entitlement_at is not None:
            instant(self.entitlement_at)
        if type(self.settlement_confirmed) is not bool:
            raise ValueError("Explicit settlement confirmation required")


@dataclass(frozen=True)
class WheelState:
    underlying_id: str
    currency: str
    shares: int = 0
    share_cost: Decimal = ZERO
    option: ShortOption | None = None
    net_cash_flow: Decimal = ZERO
    option_pnl: Decimal = ZERO
    realized_share_pnl: Decimal = ZERO
    dividend_income: Decimal = ZERO
    events: tuple[WheelEvent, ...] = ()

    def __post_init__(self):
        identity(self.underlying_id)
        identity(self.currency)
        count(self.shares)
        require_decimal(self.share_cost, nonnegative=True)
        for value in (self.net_cash_flow, self.option_pnl, self.realized_share_pnl, self.dividend_income):
            require_decimal(value)
        if self.shares == 0 and self.share_cost != ZERO:
            raise ValueError("Cost cannot remain without shares")
        if self.option is not None:
            contract = self.option.contract
            if contract.underlying_id != self.underlying_id or contract.currency != self.currency:
                raise ValueError("Cross-instrument or currency state")
            if contract.right == "call" and self.option.contracts * contract.multiplier > self.shares:
                raise ValueError("Uncovered call state")

    @property
    def stage(self) -> str:
        if self.option:
            return "short-put" if self.option.contract.right == "put" else "covered-call"
        return "shares" if self.shares else "cash"


@dataclass(frozen=True)
class WheelObligations:
    cash_on_assignment: Decimal
    covered_shares: int
    potential_received_shares: int
    release_requires_settlement_evidence: bool
    authority: str = "research-projection-only"


@deterministic
def obligations(state: WheelState) -> WheelObligations:
    if not state.option:
        return WheelObligations(ZERO, 0, 0, False)
    option = state.option
    shares = option.contract.multiplier * option.contracts
    if option.contract.right == "put":
        # Premium is not collateral; another sleeve must not spend this obligation.
        return WheelObligations(option.contract.strike * shares, 0, shares, True)
    return WheelObligations(ZERO, shares, 0, True)


@deterministic
def apply_event(state: WheelState, event: WheelEvent) -> WheelState:
    """Replay a supplied fact; no broker operation or cash admission is performed."""
    for prior in state.events:
        if prior.event_id == event.event_id:
            if prior == event:
                return state
            raise ValueError("Event identity reused with changed content")
    if state.events and event.at < state.events[-1].at:
        raise ValueError("Out-of-order wheel event")
    changes = {"events": (*state.events, event)}
    if event.kind == "dividend":
        if event.contract is not None or event.contracts != 0:
            raise ValueError("Dividend is a share entitlement, not an option event")
        if not event.settlement_confirmed or event.entitlement_at is None or event.entitlement_at > event.at:
            raise ValueError("Dividend requires confirmed explicit record-date entitlement")
        # Entitlement may precede call-away; never infer from today's share count.
        income = event.price_per_share * event.entitled_shares - event.fees
        changes.update(dividend_income=state.dividend_income + income,
                       net_cash_flow=state.net_cash_flow + income)
        return replace(state, **changes)
    contract = event.contract
    if contract is None or event.contracts < 1:
        raise ValueError("Option event requires contract and positive contracts")
    if contract.underlying_id != state.underlying_id or contract.currency != state.currency:
        raise ValueError("Wheel event instrument/currency mismatch")
    if contract.settlement != "physical":
        raise ValueError("Cash-settled options cannot create a stock wheel")
    units = event.contracts * contract.multiplier
    premium = event.price_per_share * units
    if event.kind in {"open-put", "open-call"}:
        if state.option is not None:
            raise ValueError("Existing obligation must close before replacement")
        if event.at >= contract.expiry_at or event.at.date() >= contract.expiry_at.date():
            raise ValueError("Wheel excludes same-day contracts; no 0DTE relaxation")
        if event.kind == "open-put" and (contract.right != "put" or state.shares):
            raise ValueError("Put cycle begins without shares")
        if event.kind == "open-call" and (contract.right != "call" or units > state.shares):
            raise ValueError("Covered call requires sufficient supplied shares")
        changes.update(option=ShortOption(contract, event.contracts),
                       net_cash_flow=state.net_cash_flow + premium - event.fees,
                       option_pnl=state.option_pnl + premium - event.fees)
        return replace(state, **changes)
    option = state.option
    if option is None or option.contract != contract or event.contracts > option.contracts:
        raise ValueError("Event does not match outstanding obligation")
    remaining = option.contracts - event.contracts
    changes["option"] = ShortOption(contract, remaining) if remaining else None
    if event.kind == "buy-close":
        if event.at > contract.expiry_at:
            raise ValueError("Post-expiry close is not a valid option fill")
        changes.update(net_cash_flow=state.net_cash_flow - premium - event.fees,
                       option_pnl=state.option_pnl - premium - event.fees)
    elif event.kind in {"put-assignment", "call-away"}:
        if not event.settlement_confirmed:
            raise ValueError("Assignment/call-away requires explicit settlement evidence")
        if event.at < contract.expiry_at and contract.exercise_style != "american":
            raise ValueError("European contract cannot exercise early")
        if event.price_per_share != ZERO:
            raise ValueError("Assignment cash uses contract strike, not an override price")
        amount = contract.strike * units
        if event.kind == "put-assignment":
            if contract.right != "put":
                raise ValueError("Put assignment required")
            changes.update(shares=state.shares + units,
                           share_cost=state.share_cost + amount + event.fees,
                           net_cash_flow=state.net_cash_flow - amount - event.fees)
        else:
            if contract.right != "call" or units > state.shares:
                raise ValueError("Call-away cannot deliver unowned shares")
            cost = state.share_cost if units == state.shares else ratio(state.share_cost * units, Decimal(state.shares))
            changes.update(shares=state.shares - units, share_cost=state.share_cost - cost,
                           realized_share_pnl=state.realized_share_pnl + amount - cost - event.fees,
                           net_cash_flow=state.net_cash_flow + amount - event.fees)
    elif event.kind == "expiry":
        if event.at < contract.expiry_at or not event.settlement_confirmed:
            raise ValueError("Expiry does not release obligations before confirmed settlement")
        if event.price_per_share != ZERO:
            raise ValueError("Expiry is not a premium fill")
        changes.update(net_cash_flow=state.net_cash_flow - event.fees,
                       option_pnl=state.option_pnl - event.fees)
    else:
        raise ValueError("Unknown wheel event")
    return replace(state, **changes)


@dataclass(frozen=True)
class WheelQuote:
    contract: WheelContract
    bid: Decimal | None
    ask: Decimal | None
    observed_at: datetime
    available_at: datetime
    open_interest: int | None
    volume: int | None
    source_id: str

    def __post_init__(self):
        instant(self.observed_at)
        instant(self.available_at)
        identity(self.source_id)
        if self.available_at < self.observed_at:
            raise ValueError("Quote availability precedes observation")
        for price in (self.bid, self.ask):
            if price is not None:
                require_decimal(price, nonnegative=True)
        for value in (self.open_interest, self.volume):
            if value is not None:
                count(value)


@dataclass(frozen=True)
class WheelSelectionPolicy:
    min_days: int
    max_days: int
    maximum_spread_fraction: Decimal
    minimum_open_interest: int
    minimum_volume: int
    maximum_quote_age_seconds: int

    def __post_init__(self):
        from .core import fraction
        count(self.min_days, positive=True)
        count(self.max_days, positive=True)
        if self.max_days < self.min_days:
            raise ValueError("Invalid DTE interval")
        fraction(self.maximum_spread_fraction)
        for value in (self.minimum_open_interest, self.minimum_volume, self.maximum_quote_age_seconds):
            count(value)


@dataclass(frozen=True)
class WheelSelection:
    candidates: tuple[WheelQuote, ...]
    rejections: tuple[tuple[str, tuple[str, ...]], ...]


@deterministic
def select_contracts(state: WheelState, quotes: tuple[WheelQuote, ...], *, as_of: datetime,
                     policy: WheelSelectionPolicy, available_cash: Decimal | None) -> WheelSelection:
    instant(as_of)
    if available_cash is not None:
        require_decimal(available_cash, nonnegative=True)
    if len({quote.contract.contract_id for quote in quotes}) != len(quotes):
        raise ValueError("Duplicate contract quotes")
    accepted, rejected = [], []
    for quote in quotes:
        c = quote.contract
        reasons = []
        if state.option:
            reasons.append("existing-option-obligation")
        if c.underlying_id != state.underlying_id or c.currency != state.currency:
            reasons.append("instrument-or-currency-mismatch")
        if c.right != ("call" if state.shares else "put") or c.settlement != "physical":
            reasons.append("wrong-wheel-contract")
        days = (c.expiry_at - as_of).days
        if days < policy.min_days or days > policy.max_days:
            reasons.append("dte-outside-policy")
        if quote.available_at > as_of or quote.observed_at > as_of:
            reasons.append("future-quote")
        elif (as_of - quote.observed_at).total_seconds() > policy.maximum_quote_age_seconds:
            reasons.append("stale-quote")
        if quote.bid is None or quote.ask is None or quote.bid <= ZERO or quote.ask < quote.bid:
            reasons.append("missing-or-invalid-executable-quote")
        elif (quote.ask - quote.bid) / ((quote.ask + quote.bid) / 2) > policy.maximum_spread_fraction:
            reasons.append("spread-too-wide")
        if quote.open_interest is None or quote.volume is None:
            reasons.append("missing-liquidity")
        elif quote.open_interest < policy.minimum_open_interest or quote.volume < policy.minimum_volume:
            reasons.append("insufficient-liquidity")
        if c.right == "put":
            if available_cash is None:
                reasons.append("cash-readiness-unavailable")
            elif c.strike * c.multiplier > available_cash:
                reasons.append("assignment-obligation-exceeds-supplied-cash")
        elif c.multiplier > state.shares:
            reasons.append("insufficient-covered-shares")
        if reasons:
            rejected.append((c.contract_id, tuple(reasons)))
        else:
            accepted.append(quote)
    # Stable deterministic ordering, not expected-profit/confidence ranking.
    accepted.sort(key=lambda q: (q.contract.expiry_at, q.contract.strike, q.contract.contract_id))
    return WheelSelection(tuple(accepted), tuple(rejected))


@dataclass(frozen=True)
class RollProposal:
    close_contract_id: str
    replacement_contract_id: str
    contracts: int
    close_cost: Decimal
    opening_credit: Decimal
    prospective_cash_obligation: Decimal
    prospective_share_obligation: int
    sequencing: str = "confirm-close-then-reassess-replacement"
    executable: bool = False


@deterministic
def plan_roll(state: WheelState, replacement: WheelContract, *, contracts: int,
              close_ask: Decimal, opening_bid: Decimal, as_of: datetime) -> RollProposal:
    count(contracts, positive=True)
    require_decimal(close_ask, nonnegative=True)
    require_decimal(opening_bid, nonnegative=True)
    instant(as_of)
    prior = state.option
    if prior is None or contracts != prior.contracts:
        raise ValueError("Explicit full outstanding leg required for this roll plan")
    old = prior.contract
    if replacement.underlying_id != old.underlying_id or replacement.currency != old.currency:
        raise ValueError("Roll instrument/currency mismatch")
    if replacement.right != old.right or replacement.multiplier != old.multiplier or replacement.settlement != "physical":
        raise ValueError("Roll cannot silently change deliverable")
    if replacement.contract_id == old.contract_id or replacement.expiry_at <= old.expiry_at or as_of >= old.expiry_at:
        raise ValueError("Roll requires distinct later expiry and unexpired old leg")
    units = contracts * replacement.multiplier
    return RollProposal(old.contract_id, replacement.contract_id, contracts,
                        close_ask * units, opening_bid * units,
                        replacement.strike * units if replacement.right == "put" else ZERO,
                        units if replacement.right == "call" else 0)


@deterministic
def early_exercise_review(state: WheelState, *, as_of: datetime, underlying_price: Decimal | None,
                          option_ask: Decimal | None, dividend_per_share: Decimal | None,
                          ex_dividend_at: datetime | None) -> ResearchDecision:
    instant(as_of)
    if not state.option or state.option.contract.exercise_style != "american":
        return ResearchDecision("hold", ("no-american-short-option",))
    c = state.option.contract
    if as_of >= c.expiry_at:
        return ResearchDecision("review", ("expiry-settlement-unresolved",))
    if underlying_price is None or option_ask is None:
        return ResearchDecision("unavailable", ("exercise-risk-quotes-missing",))
    require_decimal(underlying_price, positive=True)
    require_decimal(option_ask, nonnegative=True)
    intrinsic = max(ZERO, underlying_price - c.strike if c.right == "call" else c.strike - underlying_price)
    extrinsic = max(ZERO, option_ask - intrinsic)
    reasons = ["american-assignment-possible-at-any-time"]
    if c.right == "call":
        if dividend_per_share is None or ex_dividend_at is None:
            return ResearchDecision("unavailable", ("dividend-calendar-or-amount-missing",))
        require_decimal(dividend_per_share, nonnegative=True)
        instant(ex_dividend_at)
        if as_of < ex_dividend_at <= c.expiry_at and intrinsic > ZERO and dividend_per_share > extrinsic:
            reasons.append("dividend-exceeds-extrinsic-review-before-ex-date")
    elif intrinsic > ZERO and extrinsic == ZERO:
        reasons.append("deep-itm-put-carry-and-early-assignment-review")
    return ResearchDecision("review", tuple(reasons), (("extrinsic", extrinsic),))
