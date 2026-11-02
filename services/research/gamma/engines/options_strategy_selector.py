"""Rules-first options strategy selection from QuantData option chains."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import asdict, dataclass
from datetime import UTC, date, datetime, timedelta
from typing import Any, Literal

from gamma.schemas import (
    OptionLeg,
    OptionsStrategyIntent,
    QuoteProvenance,
    RejectedTrade,
    SchemaModel,
    TradeSetup,
    artifact_hash,
)
from gamma.engines.bridgingcycles_short_strangle import (
    BridgingCyclesShortStrangleDefinition,
)
from gamma.schemas.options import StrategyType

OptionRight = Literal["call", "put"]
PROVIDER_BACKED_QUOTE_SOURCES = {
    "provider_nbbo",
    "nbbo",
    "quantdata",
    "quantdata_option_chain",
}
SYNTHETIC_QUOTE_SOURCES = {"last_trade_synthetic_spread"}
OFFLINE_QUOTE_SOURCES = {
    "offline_replay",
    "offline_replay_quote",
    "offline_fixture",
    "offline_fixtures",
}
MISSING_QUOTE_PROVENANCE = "missing_quote_provenance"
QUOTE_MAX_AGE = timedelta(minutes=20)
QUOTE_MAX_FUTURE_SKEW = timedelta(minutes=2)
OBSERVED_QUOTE_TIMESTAMP_KEYS = (
    "quote_observed_at",
    "observed_at",
    "as_of",
    "timestamp",
)
FETCHED_QUOTE_TIMESTAMP_KEYS = ("quote_fetched_at", "fetched_at")
QUOTE_ENDPOINT_KEYS = (
    "provider_endpoint",
    "quote_provider_endpoint",
    "endpoint",
)
QUOTE_TRACE_KEYS = ("trace_id", "provider_trace_id", "quote_trace_id")



@dataclass(frozen=True)
class StrategySelectionConstraints:
    """Contract selection limits for rules-first strategy construction."""

    min_dte: int = 21
    max_dte: int = 75
    call_delta_target: float = 0.45
    put_delta_target: float = -0.45
    max_delta_deviation: float = 0.25
    max_bid_ask_spread_pct: float = 0.20
    min_open_interest: int = 100
    min_volume: int = 10
    max_premium: float = 500.0
    max_loss: float = 500.0


@dataclass(frozen=True)
class OptionChainContract:
    """Normalized option-chain row sourced from QuantData."""

    expiry: date
    strike: float
    right: OptionRight
    bid: float
    ask: float
    volume: int
    open_interest: int
    delta: float
    gamma: float | None = None
    theta: float | None = None
    vega: float | None = None
    implied_volatility: float | None = None
    raw: dict[str, Any] | None = None

    @property
    def mid(self) -> float:
        return (self.bid + self.ask) / 2

    @property
    def spread_pct(self) -> float:
        return (self.ask - self.bid) / self.mid if self.mid else 1.0


class StrategySelectionResult(SchemaModel):
    """Selected strategy intent plus deterministic rejection trail."""

    setup: TradeSetup
    strategy_intent: OptionsStrategyIntent | None = None
    rejected_trades: list[RejectedTrade]
    selected_strategy_type: StrategyType | None = None
    financial_datasets_context_used: bool = False


class OptionsStrategySelector:
    """Select an options expression from a setup and real option chain."""

    def __init__(
        self,
        *,
        constraints: StrategySelectionConstraints | None = None,
        short_strangle_definition: BridgingCyclesShortStrangleDefinition | None = None,
    ) -> None:
        self._constraints = constraints or StrategySelectionConstraints()
        self._short_strangle_definition = short_strangle_definition

    def select(
        self,
        *,
        setup: TradeSetup,
        option_chain: Sequence[Mapping[str, Any]],
        as_of: datetime | None = None,
        financial_datasets_context: Mapping[str, Any] | None = None,
    ) -> StrategySelectionResult:
        """Return a selected intent or a rejection trail without fabricating legs."""

        rejected: list[RejectedTrade] = []
        selection_time = _selection_time(setup, as_of)
        if setup.rejection_reasons:
            return self._result(
                setup=setup,
                rejected_trades=[
                    _rejected(
                        setup,
                        "setup rejected before strategy selection",
                        {"setup_rejection_reasons": setup.rejection_reasons},
                    )
                ],
                financial_datasets_context=financial_datasets_context,
            )
        if not option_chain:
            return self._result(
                setup=setup,
                rejected_trades=[_rejected(setup, "missing option chain")],
                financial_datasets_context=financial_datasets_context,
            )

        contracts, parse_rejections = _normalize_contracts(option_chain, setup)
        rejected.extend(parse_rejections)
        eligible, constraint_rejections = _eligible_contracts(
            contracts,
            as_of=selection_time,
            constraints=self._constraints,
            setup=setup,
        )
        rejected.extend(constraint_rejections)
        if not eligible:
            rejected.append(
                _rejected(
                    setup,
                    "no contracts satisfied constraints",
                    {"constraints": asdict(self._constraints)},
                )
            )
            return self._result(
                setup=setup,
                rejected_trades=rejected,
                financial_datasets_context=financial_datasets_context,
            )

        for strategy_type in _strategy_order(setup):
            intent = _build_strategy_intent(
                setup=setup,
                strategy_type=strategy_type,
                contracts=eligible,
                as_of=selection_time,
                constraints=self._constraints,
                short_strangle_definition=self._short_strangle_definition,
            )
            if intent is not None:
                return self._result(
                    setup=setup,
                    strategy_intent=intent,
                    selected_strategy_type=strategy_type,
                    rejected_trades=rejected,
                    financial_datasets_context=financial_datasets_context,
                )
            rejected.append(
                _rejected(
                    setup,
                    f"{strategy_type} rejected by deterministic constraints",
                    {"strategy_type": strategy_type},
                )
            )

        return self._result(
            setup=setup,
            rejected_trades=rejected,
            financial_datasets_context=financial_datasets_context,
        )

    def _result(
        self,
        *,
        setup: TradeSetup,
        rejected_trades: list[RejectedTrade],
        financial_datasets_context: Mapping[str, Any] | None,
        strategy_intent: OptionsStrategyIntent | None = None,
        selected_strategy_type: StrategyType | None = None,
    ) -> StrategySelectionResult:
        return StrategySelectionResult(
            setup=setup,
            strategy_intent=strategy_intent,
            rejected_trades=rejected_trades,
            selected_strategy_type=selected_strategy_type,
            financial_datasets_context_used=bool(financial_datasets_context),
        )


def _normalize_contracts(
    option_chain: Sequence[Mapping[str, Any]],
    setup: TradeSetup,
) -> tuple[list[OptionChainContract], list[RejectedTrade]]:
    contracts: list[OptionChainContract] = []
    rejected: list[RejectedTrade] = []
    for index, row in enumerate(option_chain):
        try:
            contracts.append(_contract_from_row(row))
        except ValueError as exc:
            rejected.append(
                _rejected(
                    setup,
                    "invalid option-chain row",
                    {"row_index": index, "error": str(exc)},
                )
            )
    return contracts, rejected


def _contract_from_row(row: Mapping[str, Any]) -> OptionChainContract:
    expiry = _date_value(row, "expiry", "expiration", "expirationDate", "expiryDate")
    strike = _float_value(row, "strike", "strikePrice", "strike_price")
    right = _right_value(row, "right", "contractType", "optionType", "putCall")
    bid = _float_value(row, "bid", "bidPrice", "bid_price")
    ask = _float_value(row, "ask", "askPrice", "ask_price")
    delta = _float_value(row, "delta")
    if bid < 0 or ask <= 0 or ask < bid:
        raise ValueError("bid/ask values are invalid")
    return OptionChainContract(
        expiry=expiry,
        strike=strike,
        right=right,
        bid=bid,
        ask=ask,
        volume=_int_value(row, "volume", "option_volume", default=0),
        open_interest=_int_value(row, "open_interest", "openInterest", "oi", default=0),
        delta=delta,
        gamma=_optional_float_value(row, "gamma"),
        theta=_optional_float_value(row, "theta"),
        vega=_optional_float_value(row, "vega"),
        implied_volatility=_optional_float_value(
            row,
            "implied_volatility",
            "impliedVolatility",
            "iv",
        ),
        raw=dict(row),
    )


def _eligible_contracts(
    contracts: Sequence[OptionChainContract],
    *,
    as_of: datetime,
    constraints: StrategySelectionConstraints,
    setup: TradeSetup,
) -> tuple[list[OptionChainContract], list[RejectedTrade]]:
    eligible: list[OptionChainContract] = []
    rejected: list[RejectedTrade] = []
    for contract in contracts:
        reason = _contract_rejection_reason(contract, as_of, constraints)
        if reason is None:
            eligible.append(contract)
        else:
            rejected.append(
                _rejected(
                    setup,
                    reason,
                    {
                        "expiry": contract.expiry.isoformat(),
                        "strike": contract.strike,
                        "right": contract.right,
                    },
                )
            )
    return eligible, rejected


def _contract_rejection_reason(
    contract: OptionChainContract,
    as_of: datetime,
    constraints: StrategySelectionConstraints,
) -> str | None:
    dte = (contract.expiry - as_of.date()).days
    if dte < constraints.min_dte or dte > constraints.max_dte:
        return "contract outside DTE bounds"
    if contract.spread_pct > constraints.max_bid_ask_spread_pct:
        return "contract bid/ask spread too wide"
    target_delta = (
        constraints.call_delta_target
        if contract.right == "call"
        else constraints.put_delta_target
    )
    if _delta_distance(contract, target_delta) > constraints.max_delta_deviation:
        return "contract delta outside target range"
    if contract.open_interest < constraints.min_open_interest:
        return "contract open interest below minimum"
    if contract.volume < constraints.min_volume:
        return "contract volume below minimum"
    if contract.ask * 100 > constraints.max_premium:
        return "contract premium above maximum"
    return None


def _strategy_order(setup: TradeSetup) -> list[StrategyType]:
    iv_rank = _iv_rank(setup)
    high_iv = iv_rank is not None and iv_rank >= 0.60
    if setup.direction == "bullish":
        return ["call_debit_spread", "put_credit_spread"] if high_iv else [
            "long_call",
            "call_debit_spread",
        ]
    if setup.direction == "bearish":
        return ["put_debit_spread", "call_credit_spread"] if high_iv else [
            "long_put",
            "put_debit_spread",
        ]
    if setup.direction == "vol_expansion":
        return ["straddle", "strangle"]
    if setup.direction == "vol_contraction":
        order: list[StrategyType] = [
            "put_credit_spread",
            "call_credit_spread",
            "iron_condor",
        ]
        # Opt-in only: short_strangle is tried solely when the setup names it,
        # so existing vol_contraction selection is unchanged.
        if "short_strangle" in setup.preferred_strategy_types:
            order.append("short_strangle")
        return order
    return list(setup.preferred_strategy_types) or ["calendar", "iron_condor"]


def _build_strategy_intent(
    *,
    setup: TradeSetup,
    strategy_type: StrategyType,
    contracts: Sequence[OptionChainContract],
    as_of: datetime,
    constraints: StrategySelectionConstraints,
    short_strangle_definition: BridgingCyclesShortStrangleDefinition | None = None,
) -> OptionsStrategyIntent | None:
    if strategy_type == "long_call":
        return _build_long_strategy(setup, "call", contracts, as_of, constraints)
    if strategy_type == "long_put":
        return _build_long_strategy(setup, "put", contracts, as_of, constraints)
    if strategy_type == "call_debit_spread":
        return _build_debit_spread(setup, "call", contracts, as_of, constraints)
    if strategy_type == "put_debit_spread":
        return _build_debit_spread(setup, "put", contracts, as_of, constraints)
    if strategy_type == "put_credit_spread":
        return _build_credit_spread(setup, "put", contracts, as_of, constraints)
    if strategy_type == "call_credit_spread":
        return _build_credit_spread(setup, "call", contracts, as_of, constraints)
    if strategy_type == "straddle":
        return _build_straddle(setup, contracts, as_of, constraints)
    if strategy_type == "strangle":
        return _build_strangle(setup, contracts, as_of, constraints)
    if strategy_type == "short_strangle":
        return _build_short_strangle(
            setup,
            contracts,
            as_of,
            constraints,
            short_strangle_definition or BridgingCyclesShortStrangleDefinition(),
        )
    return None


def _build_long_strategy(
    setup: TradeSetup,
    right: OptionRight,
    contracts: Sequence[OptionChainContract],
    as_of: datetime,
    constraints: StrategySelectionConstraints,
) -> OptionsStrategyIntent | None:
    target_delta = (
        constraints.call_delta_target
        if right == "call"
        else constraints.put_delta_target
    )
    contract = _best_contract(
        [contract for contract in contracts if contract.right == right],
        target_delta=target_delta,
    )
    if contract is None:
        return None
    max_loss = round(contract.ask * 100, 2)
    if max_loss > constraints.max_loss:
        return None
    leg = OptionLeg(
        side="buy",
        right=right,
        expiry=contract.expiry,
        strike=contract.strike,
        quantity=1,
        limit_price=contract.ask,
    )
    strategy_type: StrategyType = "long_call" if right == "call" else "long_put"
    breakeven = (
        contract.strike + contract.ask
        if right == "call"
        else contract.strike - contract.ask
    )
    return _intent(
        setup=setup,
        strategy_type=strategy_type,
        legs=[leg],
        contracts=[contract],
        max_loss=max_loss,
        max_profit=None,
        net_debit_or_credit=-max_loss,
        breakevens=[round(breakeven, 4)],
        dte=_dte(contract, as_of),
        as_of=as_of,
        constraints=constraints,
    )


def _build_debit_spread(
    setup: TradeSetup,
    right: OptionRight,
    contracts: Sequence[OptionChainContract],
    as_of: datetime,
    constraints: StrategySelectionConstraints,
) -> OptionsStrategyIntent | None:
    pairs = _same_expiry_pairs(
        [contract for contract in contracts if contract.right == right],
        right=right,
        spread_kind="debit",
        constraints=constraints,
    )
    if not pairs:
        return None
    buy, sell = pairs[0]
    debit = buy.ask - sell.bid
    max_loss = round(debit * 100, 2)
    width = abs(sell.strike - buy.strike)
    max_profit = round(width * 100 - max_loss, 2)
    if (
        debit <= 0
        or max_loss <= 0
        or max_loss > constraints.max_loss
        or max_profit <= 0
    ):
        return None
    strategy_type: StrategyType = (
        "call_debit_spread" if right == "call" else "put_debit_spread"
    )
    breakeven = buy.strike + debit if right == "call" else buy.strike - debit
    return _intent(
        setup=setup,
        strategy_type=strategy_type,
        legs=[
            _leg("buy", buy),
            _leg("sell", sell),
        ],
        contracts=[buy, sell],
        max_loss=max_loss,
        max_profit=max_profit,
        net_debit_or_credit=-max_loss,
        breakevens=[round(breakeven, 4)],
        dte=_dte(buy, as_of),
        as_of=as_of,
        constraints=constraints,
    )


def _build_credit_spread(
    setup: TradeSetup,
    right: OptionRight,
    contracts: Sequence[OptionChainContract],
    as_of: datetime,
    constraints: StrategySelectionConstraints,
) -> OptionsStrategyIntent | None:
    pairs = _same_expiry_pairs(
        [contract for contract in contracts if contract.right == right],
        right=right,
        spread_kind="credit",
        constraints=constraints,
    )
    if not pairs:
        return None
    buy, sell = pairs[0]
    credit = sell.bid - buy.ask
    width = abs(sell.strike - buy.strike)
    max_profit = round(credit * 100, 2)
    max_loss = round(width * 100 - max_profit, 2)
    if credit <= 0 or max_loss <= 0 or max_loss > constraints.max_loss:
        return None
    strategy_type: StrategyType = (
        "call_credit_spread" if right == "call" else "put_credit_spread"
    )
    return _intent(
        setup=setup,
        strategy_type=strategy_type,
        legs=[
            _leg("buy", buy),
            _leg("sell", sell),
        ],
        contracts=[buy, sell],
        max_loss=max_loss,
        max_profit=max_profit,
        net_debit_or_credit=max_profit,
        breakevens=[_credit_breakeven(right, buy, sell, credit)],
        dte=_dte(buy, as_of),
        as_of=as_of,
        constraints=constraints,
    )


def _same_expiry_pairs(
    contracts: Sequence[OptionChainContract],
    *,
    right: OptionRight,
    spread_kind: Literal["debit", "credit"],
    constraints: StrategySelectionConstraints,
) -> list[tuple[OptionChainContract, OptionChainContract]]:
    pairs: list[tuple[OptionChainContract, OptionChainContract]] = []
    ordered = sorted(contracts, key=lambda contract: (contract.expiry, contract.strike))
    for first in ordered:
        for second in ordered:
            if first.expiry != second.expiry or first.strike == second.strike:
                continue
            buy, sell = _spread_buy_sell(first, second, right, spread_kind)
            if buy is None or sell is None:
                continue
            if buy.ask * 100 > constraints.max_premium:
                continue
            pairs.append((buy, sell))
    return sorted(
        pairs,
        key=lambda pair: (
            _delta_distance(
                pair[0],
                constraints.call_delta_target
                if right == "call"
                else constraints.put_delta_target,
            ),
            abs(pair[1].strike - pair[0].strike),
        ),
    )


def _spread_buy_sell(
    first: OptionChainContract,
    second: OptionChainContract,
    right: OptionRight,
    spread_kind: Literal["debit", "credit"],
) -> tuple[OptionChainContract | None, OptionChainContract | None]:
    lower, higher = sorted((first, second), key=lambda contract: contract.strike)
    if spread_kind == "debit" and right == "call":
        return lower, higher
    if spread_kind == "debit" and right == "put":
        return higher, lower
    if spread_kind == "credit" and right == "call":
        return higher, lower
    if spread_kind == "credit" and right == "put":
        return lower, higher
    return None, None


def _build_straddle(
    setup: TradeSetup,
    contracts: Sequence[OptionChainContract],
    as_of: datetime,
    constraints: StrategySelectionConstraints,
) -> OptionsStrategyIntent | None:
    calls = [contract for contract in contracts if contract.right == "call"]
    puts = [contract for contract in contracts if contract.right == "put"]
    pairs = [
        (call, put)
        for call in calls
        for put in puts
        if call.expiry == put.expiry and call.strike == put.strike
    ]
    return _build_long_volatility_intent(
        setup,
        "straddle",
        pairs,
        as_of,
        constraints,
    )


def _build_strangle(
    setup: TradeSetup,
    contracts: Sequence[OptionChainContract],
    as_of: datetime,
    constraints: StrategySelectionConstraints,
) -> OptionsStrategyIntent | None:
    calls = [contract for contract in contracts if contract.right == "call"]
    puts = [contract for contract in contracts if contract.right == "put"]
    pairs = [
        (call, put)
        for call in calls
        for put in puts
        if call.expiry == put.expiry and call.strike != put.strike
    ]
    return _build_long_volatility_intent(
        setup,
        "strangle",
        pairs,
        as_of,
        constraints,
    )


def _build_long_volatility_intent(
    setup: TradeSetup,
    strategy_type: StrategyType,
    pairs: Sequence[tuple[OptionChainContract, OptionChainContract]],
    as_of: datetime,
    constraints: StrategySelectionConstraints,
) -> OptionsStrategyIntent | None:
    if not pairs:
        return None
    call, put = min(pairs, key=lambda pair: pair[0].ask + pair[1].ask)
    max_loss = round((call.ask + put.ask) * 100, 2)
    if max_loss > constraints.max_loss:
        return None
    strikes = sorted([call.strike, put.strike])
    return _intent(
        setup=setup,
        strategy_type=strategy_type,
        legs=[_leg("buy", call), _leg("buy", put)],
        contracts=[call, put],
        max_loss=max_loss,
        max_profit=None,
        net_debit_or_credit=-max_loss,
        breakevens=[round(strikes[0] - put.ask, 4), round(strikes[1] + call.ask, 4)],
        dte=_dte(call, as_of),
        as_of=as_of,
        constraints=constraints,
    )


def _build_short_strangle(
    setup: TradeSetup,
    contracts: Sequence[OptionChainContract],
    as_of: datetime,
    constraints: StrategySelectionConstraints,
    definition: BridgingCyclesShortStrangleDefinition,
) -> OptionsStrategyIntent | None:
    """Sell a put and a call just outside the expected move (spec rules 1, 6-7a).

    Builds legs only. The VRP entry filter (rules 4-5a, 12) needs a time series
    and lives in ``bridgingcycles_short_strangle``; it is not applied here.
    Requires an underlying spot price on the chain rows or setup snapshots and
    an ATM implied volatility; without them no legs are fabricated. Strikes are
    chosen among the contracts that already passed the selector's generic
    eligibility constraints (DTE, spread, delta, open interest, volume).
    """

    spot = _underlying_spot(setup, contracts)
    if spot is None:
        return None
    params = definition.params
    expiry = definition.select_expiry(
        as_of.date(), sorted({contract.expiry for contract in contracts})
    )
    if expiry is None:
        return None
    at_expiry = [contract for contract in contracts if contract.expiry == expiry]
    atm_iv = _atm_implied_volatility(setup, at_expiry, spot)
    if atm_iv is None:
        return None
    dte = (expiry - as_of.date()).days
    move = definition.expected_move(spot, atm_iv, dte)
    puts = [c for c in at_expiry if c.right == "put" and c.strike <= spot - move]
    calls = [c for c in at_expiry if c.right == "call" and c.strike >= spot + move]
    if not puts or not calls:
        return None
    put = max(puts, key=lambda contract: contract.strike)
    call = min(calls, key=lambda contract: contract.strike)
    if not put.strike < call.strike:
        return None
    credit = put.bid + call.bid
    if credit <= 0:
        return None
    quantity = params.contracts
    max_profit = round(credit * 100 * quantity, 2)
    # Undefined-risk structure: max_loss carries the planned stop loss of
    # (stop_loss_multiple - 1) x credit (spec rule 10, assumption), not a bound.
    max_loss = round((params.stop_loss_multiple - 1.0) * max_profit, 2)
    if max_loss <= 0 or max_loss > constraints.max_loss:
        return None
    legs = [_leg("sell", put), _leg("sell", call)]
    if quantity != 1:
        legs = [leg.model_copy(update={"quantity": quantity}) for leg in legs]
    return _intent(
        setup=setup,
        strategy_type="short_strangle",
        legs=legs,
        contracts=[put, call],
        max_loss=max_loss,
        max_profit=max_profit,
        net_debit_or_credit=max_profit,
        breakevens=[round(put.strike - credit, 4), round(call.strike + credit, 4)],
        dte=dte,
        as_of=as_of,
        constraints=constraints,
        target_profit_pct=params.profit_target_fraction,
        stop_loss_pct=round(params.stop_loss_multiple - 1.0, 4),
        extra_checks={
            "risk_profile": "undefined_risk",
            "max_loss_basis": "planned_stop_loss_spec_rule_10_assumption",
            "strategy_definition": definition.strategy_id,
            "underlying_spot": round(spot, 4),
            "atm_implied_volatility": round(atm_iv, 6),
            "expected_move": round(move, 4),
        },
    )


UNDERLYING_SPOT_KEYS = (
    "underlying_price",
    "underlyingPrice",
    "spot",
    "underlying_last",
    "underlyingLast",
)


def _underlying_spot(
    setup: TradeSetup,
    contracts: Sequence[OptionChainContract],
) -> float | None:
    raws: list[Mapping[str, Any]] = [contract.raw or {} for contract in contracts]
    raws.extend(
        snapshot.raw or {}
        for snapshot in (setup.market_structure, setup.volatility)
        if snapshot is not None
    )
    for raw in raws:
        for key in UNDERLYING_SPOT_KEYS:
            try:
                value = float(raw[key])
            except (KeyError, TypeError, ValueError):
                continue
            if value > 0:
                return value
    return None


def _atm_implied_volatility(
    setup: TradeSetup,
    contracts: Sequence[OptionChainContract],
    spot: float,
) -> float | None:
    """Mean IV of the strike(s) nearest spot in the expiry (spec rule 5b, A)."""

    with_iv = [
        contract
        for contract in contracts
        if contract.implied_volatility is not None and contract.implied_volatility > 0
    ]
    if with_iv:
        nearest = min(abs(contract.strike - spot) for contract in with_iv)
        values = [
            float(contract.implied_volatility)
            for contract in with_iv
            if abs(contract.strike - spot) == nearest
            and contract.implied_volatility is not None
        ]
        return sum(values) / len(values)
    if setup.volatility is not None and setup.volatility.front_iv:
        return float(setup.volatility.front_iv)
    return None



def _intent(
    *,
    setup: TradeSetup,
    strategy_type: StrategyType,
    legs: list[OptionLeg],
    contracts: Sequence[OptionChainContract],
    max_loss: float,
    max_profit: float | None,
    net_debit_or_credit: float,
    breakevens: list[float],
    dte: int,
    as_of: datetime,
    constraints: StrategySelectionConstraints,
    target_profit_pct: float = 0.50,
    stop_loss_pct: float = 0.35,
    extra_checks: Mapping[str, Any] | None = None,
) -> OptionsStrategyIntent:
    liquidity_checks = _liquidity_checks(contracts, constraints, as_of)
    if extra_checks:
        liquidity_checks.update(extra_checks)
    return OptionsStrategyIntent(
        intent_id=_intent_id(setup, strategy_type, legs, max_loss),
        ticker=setup.ticker,
        strategy_type=strategy_type,
        direction=setup.direction,
        legs=legs,
        max_loss=round(max_loss, 2),
        max_profit=round(max_profit, 2) if max_profit is not None else None,
        net_debit_or_credit=round(net_debit_or_credit, 2),
        breakevens=breakevens,
        target_profit_pct=target_profit_pct,
        stop_loss_pct=stop_loss_pct,
        dte=dte,
        greeks=_aggregate_greeks(legs, contracts),
        liquidity_checks=liquidity_checks,
        thesis=setup.thesis,
        invalidation=setup.invalidation,
        confidence=setup.confidence,
    )


def _intent_id(
    setup: TradeSetup,
    strategy_type: StrategyType,
    legs: list[OptionLeg],
    max_loss: float,
) -> str:
    payload = {
        "setup_id": setup.setup_id,
        "strategy_type": strategy_type,
        "legs": [leg.to_json_dict() for leg in legs],
        "max_loss": round(max_loss, 2),
    }
    return f"intent-{setup.ticker.lower()}-{artifact_hash(payload)[:12]}"


def _leg(side: Literal["buy", "sell"], contract: OptionChainContract) -> OptionLeg:
    return OptionLeg(
        side=side,
        right=contract.right,
        expiry=contract.expiry,
        strike=contract.strike,
        quantity=1,
        limit_price=contract.ask if side == "buy" else contract.bid,
    )


def _best_contract(
    contracts: Sequence[OptionChainContract],
    *,
    target_delta: float,
) -> OptionChainContract | None:
    if not contracts:
        return None
    return min(contracts, key=lambda contract: _delta_distance(contract, target_delta))


def _delta_distance(contract: OptionChainContract, target_delta: float) -> float:
    return abs(contract.delta - target_delta)


def _credit_breakeven(
    right: OptionRight,
    buy: OptionChainContract,
    sell: OptionChainContract,
    credit: float,
) -> float:
    if right == "call":
        return round(sell.strike + credit, 4)
    return round(sell.strike - credit, 4)


def _dte(contract: OptionChainContract, as_of: datetime) -> int:
    return (contract.expiry - as_of.date()).days


def _aggregate_greeks(
    legs: Sequence[OptionLeg],
    contracts: Sequence[OptionChainContract],
) -> dict[str, float]:
    totals = {"delta": 0.0, "gamma": 0.0, "theta": 0.0, "vega": 0.0}
    for leg, contract in zip(legs, contracts, strict=True):
        sign = 1.0 if leg.side == "buy" else -1.0
        totals["delta"] += sign * contract.delta
        totals["gamma"] += sign * (contract.gamma or 0.0)
        totals["theta"] += sign * (contract.theta or 0.0)
        totals["vega"] += sign * (contract.vega or 0.0)
    return {key: round(value, 4) for key, value in totals.items()}


def _liquidity_checks(
    contracts: Sequence[OptionChainContract],
    constraints: StrategySelectionConstraints,
    as_of: datetime,
) -> dict[str, Any]:
    checks = {
        "source": "quantdata_option_chain",
        "price_sources": _price_sources(contracts),
        "bid_ask_spread_ok": all(
            contract.spread_pct <= constraints.max_bid_ask_spread_pct
            for contract in contracts
        ),
        "open_interest": [contract.open_interest for contract in contracts],
        "volume": [contract.volume for contract in contracts],
        "spread_pct": [round(contract.spread_pct, 4) for contract in contracts],
    }
    checks.update(_quote_timestamp_checks(contracts))
    checks.update(_quote_provenance_checks(contracts, as_of))
    return checks



def _quote_provenance_checks(
    contracts: Sequence[OptionChainContract],
    as_of: datetime,
) -> dict[str, Any]:
    provenance = [
        _contract_quote_provenance(contract, as_of).to_json_dict()
        for contract in contracts
    ]
    return {
        "quote_provenance": provenance,
        "quote_readiness": (
            "review_ready"
            if provenance
            and all(item["readiness"] == "review_ready" for item in provenance)
            else "not_ready"
        ),
        "quote_trust_classes": _dedupe_strings(
            str(item["trust_class"]) for item in provenance
        ),
    }


def _contract_quote_provenance(
    contract: OptionChainContract,
    as_of: datetime,
) -> QuoteProvenance:
    raw = contract.raw or {}
    source = _contract_price_source(contract) or MISSING_QUOTE_PROVENANCE
    observed_at = _raw_datetime_value(raw, OBSERVED_QUOTE_TIMESTAMP_KEYS)
    fetched_at = _raw_datetime_value(raw, FETCHED_QUOTE_TIMESTAMP_KEYS)
    timestamp = observed_at or fetched_at
    age_seconds = _quote_age_seconds(timestamp, as_of) if timestamp else None
    provider_endpoint = _optional_string_value(raw, QUOTE_ENDPOINT_KEYS)
    trace_id = _optional_string_value(raw, QUOTE_TRACE_KEYS)
    trust_class = _quote_trust_class(source)
    readiness = _quote_readiness(
        trust_class,
        timestamp,
        as_of,
        provider_endpoint=provider_endpoint,
        trace_id=trace_id,
    )
    return QuoteProvenance(
        source=source,
        observed_at=observed_at,
        fetched_at=fetched_at,
        age_seconds=age_seconds,
        provider_endpoint=provider_endpoint,
        trace_id=trace_id,
        trust_class=trust_class,
        readiness=readiness,
    )


def _quote_trust_class(source: str) -> str:
    normalized = source.strip().lower()
    if not normalized or normalized in {"missing", MISSING_QUOTE_PROVENANCE}:
        return "missing"
    if normalized in SYNTHETIC_QUOTE_SOURCES:
        return "synthetic"
    if normalized in OFFLINE_QUOTE_SOURCES:
        return "offline"
    if normalized in PROVIDER_BACKED_QUOTE_SOURCES:
        return "provider_backed"
    return "untrusted"


def _quote_readiness(
    trust_class: str,
    timestamp: datetime | None,
    as_of: datetime,
    *,
    provider_endpoint: str | None,
    trace_id: str | None,
) -> str:
    if (
        trust_class != "provider_backed"
        or timestamp is None
        or not provider_endpoint
        or not trace_id
    ):
        return "not_ready"
    observed = _as_utc(timestamp)
    reference = _as_utc(as_of)
    if observed > reference + QUOTE_MAX_FUTURE_SKEW:
        return "not_ready"
    if reference - observed > QUOTE_MAX_AGE:
        return "not_ready"
    return "review_ready"


def _quote_age_seconds(timestamp: datetime, as_of: datetime) -> float:
    return round((_as_utc(as_of) - _as_utc(timestamp)).total_seconds(), 3)


def _raw_datetime_value(
    raw: Mapping[str, Any],
    keys: Sequence[str],
) -> datetime | None:
    for key in keys:
        parsed = _datetime_value(raw.get(key))
        if parsed is not None:
            return parsed
    return None


def _datetime_value(value: Any) -> datetime | None:
    if isinstance(value, datetime):
        return value
    if isinstance(value, str):
        try:
            return datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
    return None


def _optional_string_value(raw: Mapping[str, Any], keys: Sequence[str]) -> str | None:
    for key in keys:
        value = raw.get(key)
        if value:
            return str(value)
    return None


def _dedupe_strings(values: Sequence[str] | Any) -> list[str]:
    out: list[str] = []
    seen: set[str] = set()
    for value in values:
        normalized = str(value)
        if normalized not in seen:
            seen.add(normalized)
            out.append(normalized)
    return out


def _as_utc(value: datetime) -> datetime:
    return value.astimezone(UTC) if value.tzinfo else value.replace(tzinfo=UTC)

def _quote_timestamp_checks(
    contracts: Sequence[OptionChainContract],
) -> dict[str, list[str]]:
    checks: dict[str, list[str]] = {}
    for contract in contracts:
        raw = contract.raw or {}
        for key in (
            "quote_observed_at",
            "quote_fetched_at",
            "observed_at",
            "fetched_at",
            "as_of",
            "timestamp",
        ):
            value = raw.get(key)
            if value:
                checks.setdefault(key, []).append(str(value))
    return checks


def _price_sources(contracts: Sequence[OptionChainContract]) -> list[str]:
    sources: list[str] = []
    seen: set[str] = set()
    for contract in contracts:
        source = _contract_price_source(contract)
        if source and source not in seen:
            seen.add(source)
            sources.append(source)
    return sources


def _contract_price_source(contract: OptionChainContract) -> str | None:
    raw = contract.raw or {}
    for key in (
        "price_source",
        "quote_source",
        "bid_ask_source",
        "nbbo_source",
    ):
        source = raw.get(key)
        if source:
            return str(source)
    return None


def _selection_time(setup: TradeSetup, as_of: datetime | None) -> datetime:
    if as_of is not None:
        return as_of if as_of.tzinfo else as_of.replace(tzinfo=UTC)
    timestamps = [
        snapshot.as_of
        for snapshot in (
            setup.flow_snapshot,
            setup.market_structure,
            setup.volatility,
        )
        if snapshot is not None
    ]
    if not timestamps:
        raise ValueError(
            "strategy selection requires as_of or timestamped setup inputs"
        )
    return max(
        value if value.tzinfo else value.replace(tzinfo=UTC)
        for value in timestamps
    )


def _iv_rank(setup: TradeSetup) -> float | None:
    if setup.volatility is None:
        return None
    value = (
        setup.volatility.iv_rank
        if setup.volatility.iv_rank is not None
        else setup.volatility.iv_percentile
    )
    if value is None:
        return None
    normalized = float(value)
    if normalized > 1:
        normalized = normalized / 100
    return max(0.0, min(normalized, 1.0))


def _rejected(
    setup: TradeSetup,
    reason: str,
    details: dict[str, Any] | None = None,
) -> RejectedTrade:
    return RejectedTrade(
        ticker=setup.ticker,
        reason=reason,
        stage="strategy_selection",
        setup=setup,
        strategy_intent=None,
        details=details,
    )


def _date_value(row: Mapping[str, Any], *keys: str) -> date:
    value = _value(row, *keys)
    if isinstance(value, date):
        return value
    if isinstance(value, str):
        try:
            return date.fromisoformat(value[:10])
        except ValueError as exc:
            raise ValueError(f"invalid date field {keys[0]}") from exc
    raise ValueError(f"missing date field {keys[0]}")


def _right_value(row: Mapping[str, Any], *keys: str) -> OptionRight:
    value = str(_value(row, *keys)).strip().lower()
    if value in {"call", "c"}:
        return "call"
    if value in {"put", "p"}:
        return "put"
    raise ValueError("option right must be call or put")


def _float_value(row: Mapping[str, Any], *keys: str) -> float:
    value = _value(row, *keys)
    try:
        return float(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"invalid numeric field {keys[0]}") from exc


def _optional_float_value(row: Mapping[str, Any], *keys: str) -> float | None:
    try:
        return _float_value(row, *keys)
    except ValueError:
        return None


def _int_value(row: Mapping[str, Any], *keys: str, default: int) -> int:
    try:
        return max(int(float(_value(row, *keys))), 0)
    except ValueError:
        return default


def _value(row: Mapping[str, Any], *keys: str) -> Any:
    for key in keys:
        value = row.get(key)
        if value not in (None, ""):
            return value
    raise ValueError(f"missing field {keys[0]}")


__all__ = [
    "OptionChainContract",
    "OptionsStrategySelector",
    "StrategySelectionConstraints",
    "StrategySelectionResult",
]
