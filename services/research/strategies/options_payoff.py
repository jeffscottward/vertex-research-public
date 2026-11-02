"""Independent, internal four-leg credit-condor intrinsic-expiry mathematics.

Requirement evidence (not source code copied): consolidation report items
S-3c7b67438a982e / S-071d8915845d48; Queue A of the private report reconciliation.
Original relative root: AI-Cornell-bots/roth-bot/apps/python-trader/.
- src/roth_bot/strategies/iron_condors.py:31-107,155-215, SHA256
  d1ef2ee3c96fcb2f97175555eb93711e414532ca0f44433a31efc0a2d08c2a9b
- src/roth_bot/data/options.py:59-83, SHA256
  ff345bcf3ed317ffc3a5e2afcaedfc72a981e5c283e3a11bcbaed82ecf0c51df
- pyproject.toml:6,8, SHA256
  be36ada79a8a88add9b4245539047616d0ca690339e0ce92fcb94e16fe86fc98
The package declares MIT / Roth Bot Team; no complete notice or broader rights
are inferred. No original class, price fallback, market client or code is reused.

Supported input: four explicit contract/premium receipts, a single underlying,
currency, standard underlying-only deliverable, multiplier, whole quantity and
common expiry. "standard-underlying" declares exactly multiplier units of that
underlying per contract, without cash components, baskets or adjusted terms.
Receipts bind supplied evidence, not independently authenticated contract facts.
Prices and premiums are currency per underlying unit; multiplier is underlying
units per contract; quantity is contracts. Callers can use core.exact at their
input boundary. No float conversion or premium default is available here.

Results are gross hypothetical expiry economics, excluding fees and slippage.
They are neither current value, executable quotes, a trading recommendation,
physical settlement, margin, assignment/early-exercise modeling, realized P&L,
nor probability of profit. No claim of Gamma condor-constructor parity is made.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal, DecimalException, Inexact, localcontext
from typing import Literal

from .core import (ZERO, ResearchDecision, count, deterministic, digest_text,
                   identity, instant, require_decimal)

MAX_EXPIRY_SCENARIOS = 256


@dataclass(frozen=True)
class PayoffSource:
    source_id: str
    content_sha256: str
    observed_at: datetime
    available_at: datetime

    def __post_init__(self):
        identity(self.source_id)
        digest_text(self.content_sha256)
        object.__setattr__(self, "observed_at", instant(self.observed_at))
        object.__setattr__(self, "available_at", instant(self.available_at))
        if self.available_at < self.observed_at:
            raise ValueError("Evidence cannot be available before observation")


@dataclass(frozen=True)
class CondorLeg:
    contract_id: str
    underlying_id: str
    right: Literal["put", "call"]
    side: Literal["long", "short"]
    strike: Decimal
    expiry_at: datetime
    currency: str
    deliverable_id: str
    deliverable_kind: Literal["standard-underlying", "adjusted", "mixed"]
    multiplier: Decimal
    quantity: int
    premium_per_unit: Decimal
    premium_basis: str
    price_unit: Literal["currency-per-underlying-unit"]
    multiplier_unit: Literal["underlying-units-per-contract"]
    quantity_unit: Literal["contracts"]
    contract_source: PayoffSource
    premium_source: PayoffSource

    def __post_init__(self):
        for value in (self.contract_id, self.underlying_id, self.currency,
                      self.deliverable_id, self.premium_basis):
            identity(value)
        if len(self.currency) != 3 or not self.currency.isascii() or not self.currency.isupper() or not self.currency.isalpha():
            raise ValueError("Explicit three-uppercase-letter currency required")
        if self.right not in {"put", "call"} or self.side not in {"long", "short"}:
            raise ValueError("Explicit option right and position side required")
        if self.deliverable_kind not in {"standard-underlying", "adjusted", "mixed"}:
            raise ValueError("Explicit deliverable classification required")
        if (self.price_unit != "currency-per-underlying-unit"
                or self.multiplier_unit != "underlying-units-per-contract"
                or self.quantity_unit != "contracts"):
            raise ValueError("Unsupported or missing option units")
        require_decimal(self.strike, positive=True)
        require_decimal(self.multiplier, positive=True)
        require_decimal(self.premium_per_unit, nonnegative=True)
        count(self.quantity, positive=True)
        object.__setattr__(self, "expiry_at", instant(self.expiry_at))
        if type(self.contract_source) is not PayoffSource or type(self.premium_source) is not PayoffSource:
            raise TypeError("Frozen contract and premium source bindings required")


@dataclass(frozen=True)
class CreditCondorInput:
    long_put: CondorLeg
    short_put: CondorLeg
    short_call: CondorLeg
    long_call: CondorLeg
    evaluation_cutoff: datetime
    hypothetical_expiry_prices: tuple[Decimal, ...]
    scenario_price_unit: Literal["currency-per-underlying-unit"]

    def __post_init__(self):
        if any(type(leg) is not CondorLeg for leg in self.legs):
            raise TypeError("Exactly four frozen option legs required")
        object.__setattr__(self, "evaluation_cutoff", instant(self.evaluation_cutoff))
        if type(self.hypothetical_expiry_prices) is not tuple or not 1 <= len(self.hypothetical_expiry_prices) <= MAX_EXPIRY_SCENARIOS:
            raise ValueError("Supply an immutable tuple of 1-256 hypothetical prices")
        if self.scenario_price_unit != "currency-per-underlying-unit":
            raise ValueError("Explicit hypothetical underlying price units required")
        for price in self.hypothetical_expiry_prices:
            require_decimal(price, nonnegative=True)

    @property
    def legs(self) -> tuple[CondorLeg, ...]:
        return (self.long_put, self.short_put, self.short_call, self.long_call)


@dataclass(frozen=True)
class ExpiryPayoff:
    underlying_price_per_unit: Decimal
    gross_intrinsic_cash: Decimal
    gross_profit_cash: Decimal


@dataclass(frozen=True)
class CreditCondorPayoff:
    inputs: CreditCondorInput
    decision: ResearchDecision
    credit_per_unit: Decimal | None = None
    gross_credit_cash: Decimal | None = None
    gross_max_profit_cash: Decimal | None = None
    gross_max_loss_cash: Decimal | None = None
    lower_breakeven_per_unit: Decimal | None = None
    upper_breakeven_per_unit: Decimal | None = None
    scenarios: tuple[ExpiryPayoff, ...] = ()

    @property
    def executable(self) -> bool:
        return False

    @property
    def authority(self) -> str:
        return "research-proposal-only"

    @property
    def cost_basis(self) -> str:
        return "gross-fees-and-slippage-excluded"


def _source_ids(inputs: CreditCondorInput) -> tuple[str, ...]:
    return tuple(dict.fromkeys(source.source_id for leg in inputs.legs
                               for source in (leg.contract_source, leg.premium_source)))


def _unavailable(inputs: CreditCondorInput, reason: str) -> CreditCondorPayoff:
    return CreditCondorPayoff(inputs, ResearchDecision(
        "unavailable", (reason, "intrinsic-expiry-only", "gross-fees-and-slippage-excluded"),
        evidence_ids=_source_ids(inputs)))


@deterministic
def credit_condor_expiry(inputs: CreditCondorInput) -> CreditCondorPayoff:
    """Return gross scenarios, or unavailable without substituting zero risk.

    Invalid primitive fields raise at construction. Cross-leg incompatibility,
    unavailable-at-cutoff evidence, nonconventional credit and arithmetic outside
    the exact bounded domain return unavailable with the original frozen inputs.
    Scenarios retain supplied order and duplicates; they are hypotheses, not
    observed prices or a fetched/generated market-price grid.
    """
    if type(inputs) is not CreditCondorInput:
        raise TypeError("Frozen CreditCondorInput required")
    legs = inputs.legs
    lp, sp, sc, lc = legs
    if tuple((leg.right, leg.side) for leg in legs) != (
            ("put", "long"), ("put", "short"), ("call", "short"), ("call", "long")):
        return _unavailable(inputs, "leg-role-mismatch")
    if len({leg.contract_id for leg in legs}) != 4:
        return _unavailable(inputs, "duplicate-contract-identity")
    if any(leg.deliverable_kind != "standard-underlying" for leg in legs):
        return _unavailable(inputs, "unsupported-adjusted-or-mixed-deliverable")
    common = lambda leg: (leg.underlying_id, leg.currency, leg.deliverable_id,
                          leg.multiplier, leg.quantity, leg.expiry_at)
    if any(common(leg) != common(lp) for leg in legs[1:]):
        return _unavailable(inputs, "incompatible-underlying-currency-deliverable-scale-or-expiry")
    if not lp.strike < sp.strike < sc.strike < lc.strike:
        return _unavailable(inputs, "strikes-not-strictly-ordered")
    # One source ID cannot describe conflicting immutable content. Reuse of the
    # same exact receipt is allowed (for example, a single supplied chain file).
    receipts: dict[str, PayoffSource] = {}
    for leg in legs:
        for source in (leg.contract_source, leg.premium_source):
            if source.source_id in receipts and receipts[source.source_id] != source:
                return _unavailable(inputs, "conflicting-source-binding")
            receipts[source.source_id] = source
            if source.observed_at > inputs.evaluation_cutoff or source.available_at > inputs.evaluation_cutoff:
                return _unavailable(inputs, "evidence-after-evaluation-cutoff")
        if leg.premium_source.observed_at > leg.expiry_at:
            return _unavailable(inputs, "premium-observed-after-expiry")
    try:
        # Preserve core's deterministic context; never silently round an exact
        # payoff when extreme but individually valid inputs exceed its precision.
        with localcontext() as context:
            context.traps[Inexact] = True
            put_width = sp.strike - lp.strike
            call_width = lc.strike - sc.strike
            credit = sp.premium_per_unit + sc.premium_per_unit - lp.premium_per_unit - lc.premium_per_unit
            if not ZERO < credit < min(put_width, call_width):
                return _unavailable(inputs, "credit-not-positive-below-narrower-wing")
            scale = lp.multiplier * lp.quantity
            credit_cash = credit * scale
            maximum_loss = (max(put_width, call_width) - credit) * scale
            lower = sp.strike - credit
            upper = sc.strike + credit
            for value in (credit, scale, credit_cash, maximum_loss, lower, upper):
                require_decimal(value, positive=True)
            scenarios = []
            for price in inputs.hypothetical_expiry_prices:
                intrinsic = (max(lp.strike - price, ZERO) - max(sp.strike - price, ZERO)
                             - max(price - sc.strike, ZERO) + max(price - lc.strike, ZERO))
                intrinsic_cash = intrinsic * scale
                profit_cash = (credit + intrinsic) * scale
                require_decimal(intrinsic_cash)
                require_decimal(profit_cash)
                scenarios.append(ExpiryPayoff(price, intrinsic_cash, profit_cash))
    except (DecimalException, ValueError):
        return _unavailable(inputs, "arithmetic-outside-exact-bounded-domain")
    decision = ResearchDecision(
        "proposal", ("hypothetical-intrinsic-at-common-expiry", "gross-fees-and-slippage-excluded",
                     "not-current-valuation-or-trading-recommendation"),
        metrics=(("gross-credit-cash", credit_cash), ("gross-max-profit-cash", credit_cash),
                 ("gross-max-loss-cash", maximum_loss), ("lower-breakeven-per-unit", lower),
                 ("upper-breakeven-per-unit", upper)),
        evidence_ids=_source_ids(inputs))
    return CreditCondorPayoff(inputs, decision, credit, credit_cash, credit_cash,
                             maximum_loss, lower, upper, tuple(scenarios))
