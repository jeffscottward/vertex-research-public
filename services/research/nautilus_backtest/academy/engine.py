"""The Academy modelled options backtest with NautilusTrader as the ledger (research only).

Owner decision 2026-11-08 (switch plan step 6): feed the Academy's modelled Black-Scholes option
quotes to Nautilus OptionContract instruments. The rules are those of the TypeScript engine
(packages/academy/src/backtest.ts, ported in simulator.py); Nautilus matches every order and keeps
the cash and position ledger.

Model:
- One simulated venue "ACD<n>", CASH account with the run capital (cash borrowing allowed, so a
  short option books its premium as cash, as in TypeScript), netting. The account currency is the
  US dollar with 9 decimals (code "USDX"): Nautilus's built-in USD books whole cents, which would
  round every fee and cash flow.
- Instruments: the underlying as an Equity "VTX" (stock legs trade it in shares) and one
  OptionContract per kind, strike and expiry that the structure trades (multiplier 100, whole
  contracts, 9-decimal prices).
- Quotes: for every bar on which a contract is opened, held or closed, one QuoteTick with bid = ask
  = the modelled Black-Scholes price of that bar (the same number the TypeScript engine marks and
  trades at; the intrinsic value at or after expiry). The underlying quotes its close.
- Which contracts exist is found by a first pass of the same rules on the float ledger
  (simulator.run_model): the instruments and quotes must be loaded before Nautilus runs. The second
  pass decides again from the Nautilus account. If it opens a leg on another bar or contract than
  the first pass (its quotes would then be missing or the wrong ones), the run stops with an error
  instead of trading something else. A different number of units alone is not an error: it shows
  as a difference in the result.
- Each bar i is six timestamps 1 ns apart, starting at the bar time. +0: the mark quotes of the
  contracts held from earlier bars. +1: the decision (an underlying quote): the strategy runs the
  rules and sends the closing market orders, which Nautilus fills at those quotes in the same
  timestamp. +2: the entry quotes of the contracts opened on this bar. +3: the strategy sends the
  opening market orders. +4: the mark quotes of the contracts opened on this bar. +5: the mark
  (equity = account balance + net position x multiplier x quote, all read from Nautilus).
- Entry quote and mark quote differ on the opening bar when the expiry is not a bar day: TypeScript
  fills an opening leg at the price for the nominal days to expiry (the rule's dte) and marks it
  with the expiry snapped back to the last bar on or before that date. Both quotes are fed, in
  that order.
- Orders: an opening leg is a market buy (long) or sell (short); a closing leg is the opposite
  market order. Unit sizing reads the Nautilus account balance (the book is flat when it sizes).
- Costs: the fee model charges the TypeScript cost of the leg ($ per contract plus slippage of the
  premium; stock: 0.5 cent per share plus 5 bp) as commission. An expired option settles at its
  intrinsic value without a fee: the strategy closes it with a market order at the intrinsic quote
  on the settlement bar (no early assignment, no exercise into shares).
- Expiry: a contract's `expiration_ns` is its modelled expiry, or 5 ns after the bar on which the
  rules settle it when that is later (the first bar at or after the expiry). So Nautilus's own
  expiry processing never finds an open position. Nautilus timestamps end in the year 2262: a
  later expiry (a dte of tens of thousands of days) is an input error here.
- Known differences: prices, fees and cash flows have 9 decimals. That stays far inside the parity
  tolerances (docs/vertex-rebuild/nautilus-backtest-engine.md). The trade records carry the
  Nautilus fill prices and the modelled fees.
- No orders leave the process: there is no live client, broker or network.
"""
from __future__ import annotations

import importlib
import itertools
import math
from decimal import Decimal

from quantlab.nautilus_engine import NAUTILUS_VERSION, NautilusUnavailable, require

from ..bars import InputError
from .simulator import STOCK_LOT, AcademyInput, ModelBroker, OpenLeg, Simulation

__all__ = ["ACADEMY_MODEL_VERSION", "ENGINE_ID", "NautilusUnavailable", "require", "run_academy"]

ENGINE_ID = f"nautilus-trader-{NAUTILUS_VERSION}"
# Bump when the order, quote or fill model of this module changes.
ACADEMY_MODEL_VERSION = 1
PRECISION = 9
NS_PER_MS = 1_000_000
# Offsets (ns) inside a bar; see the module text.
HELD_QUOTES, DECIDE, ENTRY_QUOTES, OPEN, OPENED_QUOTES, MARK = range(6)
STRIKE_SCALE = 1000
QUOTE_SIZE = 10 ** 9
# Nautilus timestamps are nanoseconds in 64 bits (signed in parts of the engine): 2262-04-11.
MAX_TIMESTAMP_NS = 2 ** 63 - 1
UNDERLYING = "VTX"
LEDGER_CURRENCY = "USDX"
# Nautilus registers cash borrowing per venue for the whole process, so each run gets a new venue.
_RUN_COUNTER = itertools.count(1)

_NAUTILUS_NAMES = {
    "BacktestEngine": ("nautilus_trader.backtest.engine", "BacktestEngine"),
    "BacktestEngineConfig": ("nautilus_trader.backtest.engine", "BacktestEngineConfig"),
    "FeeModel": ("nautilus_trader.backtest.models", "FeeModel"),
    "LoggingConfig": ("nautilus_trader.config", "LoggingConfig"),
    "StrategyConfig": ("nautilus_trader.config", "StrategyConfig"),
    "Currency": ("nautilus_trader.model.objects", "Currency"),
    "CurrencyType": ("nautilus_trader.model.enums", "CurrencyType"),
    "QuoteTick": ("nautilus_trader.model.data", "QuoteTick"),
    "AccountType": ("nautilus_trader.model.enums", "AccountType"),
    "AssetClass": ("nautilus_trader.model.enums", "AssetClass"),
    "OmsType": ("nautilus_trader.model.enums", "OmsType"),
    "OptionKind": ("nautilus_trader.model.enums", "OptionKind"),
    "OrderSide": ("nautilus_trader.model.enums", "OrderSide"),
    "InstrumentId": ("nautilus_trader.model.identifiers", "InstrumentId"),
    "Symbol": ("nautilus_trader.model.identifiers", "Symbol"),
    "Venue": ("nautilus_trader.model.identifiers", "Venue"),
    "Equity": ("nautilus_trader.model.instruments", "Equity"),
    "OptionContract": ("nautilus_trader.model.instruments", "OptionContract"),
    "Money": ("nautilus_trader.model.objects", "Money"),
    "Price": ("nautilus_trader.model.objects", "Price"),
    "Quantity": ("nautilus_trader.model.objects", "Quantity"),
    "Strategy": ("nautilus_trader.trading.strategy", "Strategy"),
}


def _nautilus() -> dict:
    require()
    return {name: getattr(importlib.import_module(module), attr) for name, (module, attr) in _NAUTILUS_NAMES.items()}


def _contract_key(leg: OpenLeg) -> tuple:
    return ("stock",) if leg.kind == "stock" else (leg.kind, leg.strike, leg.expiry)


def _plan(data: AcademyInput) -> tuple[Simulation, dict]:
    """First pass on the float ledger: every contract the rules trade, with its quotes by (bar, offset)."""
    broker = ModelBroker(data.capital)
    plan = Simulation(data, broker)
    for index in range(plan.first_index, plan.size):
        plan.decide(index)
        plan.mark(0.0)
    contracts: dict[tuple, dict] = {}
    for leg in plan.opened:
        if leg.kind == "stock":
            continue
        contract = contracts.setdefault(_contract_key(leg), {"quotes": {}, "first": leg.open_index, "settle": -1})
        quotes = contract["quotes"]
        # The plan's legs still hold the modelled prices (ModelBroker does not replace them).
        quotes[(leg.open_index, ENTRY_QUOTES)] = leg.entry
        quotes[(leg.open_index, OPENED_QUOTES)] = plan.leg_value(leg, leg.open_index)
        for index in range(leg.open_index + 1, leg.close_index + 1):
            quotes[(index, HELD_QUOTES)] = plan.leg_value(leg, index)
        contract["settle"] = max(contract["settle"], leg.close_index)
    return plan, contracts


def _openings(simulation: Simulation) -> list[tuple]:
    """Bar and contract of every leg a pass opened, in order (not the units)."""
    return [(leg.open_index, leg.role, leg.side, _contract_key(leg)) for leg in simulation.opened]


def run_academy(data: AcademyInput) -> dict:
    """Runs the Academy backtest in a Nautilus BacktestEngine. Same result JSON as simulator.run_model."""
    plan, contracts = _plan(data)
    nt = _nautilus()
    money, price_of, quantity = nt["Money"], nt["Price"], nt["Quantity"]
    # US dollars with 9 decimals: the built-in USD books whole cents, and a fee of $1.325 per fill
    # would then drift from the TypeScript ledger by half a cent on every fill.
    usd = nt["Currency"](LEDGER_CURRENCY, PRECISION, 0, "US dollar (9 decimals, research ledger)",
                         nt["CurrencyType"].FIAT)
    buy, sell = nt["OrderSide"].BUY, nt["OrderSide"].SELL
    times = data.t
    stamps = [int(round(time)) * NS_PER_MS for time in times]
    if any(later <= earlier for earlier, later in itertools.pairwise(stamps)):
        raise InputError("Bar times must be strictly increasing")

    venue = nt["Venue"](f"ACD{next(_RUN_COUNTER)}")
    tick = price_of(10 ** -PRECISION, PRECISION)
    one = quantity.from_int(1)
    stock_symbol = nt["Symbol"](UNDERLYING)
    stock_id = nt["InstrumentId"](stock_symbol, venue)
    stock = nt["Equity"](instrument_id=stock_id, raw_symbol=stock_symbol, currency=usd, price_precision=PRECISION,
                         price_increment=tick, lot_size=one, ts_event=0, ts_init=0)
    size = quantity.from_int(QUOTE_SIZE)

    def quote(instrument_id, value: float, ts: int):
        price = price_of(round(value, PRECISION), PRECISION)
        return nt["QuoteTick"](instrument_id, price, price, size, size, ts, ts)

    instruments = {("stock",): stock}
    multipliers = {stock_id: 1}
    feed = []
    for number, (key, contract) in enumerate(contracts.items(), start=1):
        kind, strike, expiry = key
        expiry_ns = int(round(expiry)) * NS_PER_MS
        if expiry_ns > MAX_TIMESTAMP_NS:
            raise InputError("An option expiry after the year 2262 cannot run on Nautilus")
        # Settled by the rules on a bar at or after the expiry: the contract lives until that fill.
        expiration_ns = max(expiry_ns, stamps[contract["settle"]] + MARK)
        symbol = nt["Symbol"](f"{UNDERLYING}-{number}-{'C' if kind == 'call' else 'P'}"
                              f"{int(round(strike * STRIKE_SCALE))}")
        instrument = nt["OptionContract"](
            instrument_id=nt["InstrumentId"](symbol, venue), raw_symbol=symbol, asset_class=nt["AssetClass"].EQUITY,
            currency=usd, price_precision=PRECISION, price_increment=tick, multiplier=quantity.from_int(100),
            lot_size=one, underlying=UNDERLYING,
            option_kind=nt["OptionKind"].CALL if kind == "call" else nt["OptionKind"].PUT,
            strike_price=price_of(strike, PRECISION), activation_ns=stamps[contract["first"]], expiration_ns=expiration_ns,
            ts_event=0, ts_init=0, margin_init=Decimal(0), margin_maint=Decimal(0))
        instruments[key] = instrument
        multipliers[instrument.id] = 100
        for (index, offset), value in contract["quotes"].items():
            feed.append(quote(instrument.id, value, stamps[index] + offset))
    phase_of: dict[int, tuple[int, int]] = {}
    for index in range(plan.first_index, plan.size):
        base = stamps[index]
        for phase in (DECIDE, OPEN, MARK):
            feed.append(quote(stock_id, data.c[index], base + phase))
            phase_of[base + phase] = (index, phase)
    feed.sort(key=lambda item: item.ts_init)

    charges: dict = {}
    problems: list[str] = []

    class AcademyFees(nt["FeeModel"]):
        """Charges the modelled cost of the leg (simulator.Simulation.cost) as commission."""

        def get_commission(self, order, fill_qty, fill_px, instrument):
            leg, opening = charges[order.client_order_id]
            return money(leg.entry_fee if opening else leg.exit_fee, usd)

    class NautilusBroker:
        """The broker of the rules: market orders in, account balance out."""

        def __init__(self, strategy):
            self.strategy = strategy
            self.opening: list[OpenLeg] = []

        def cash(self) -> float:
            return float(self.strategy.portfolio.account(venue).balance_total(usd))

        def _send(self, leg: OpenLeg, opening: bool) -> None:
            instrument = instruments.get(_contract_key(leg))
            if instrument is None:
                raise RuntimeError(f"the Nautilus run left the modelled plan: no instrument for {leg.label}")
            shares = leg.qty * (STOCK_LOT if leg.kind == "stock" else 1)
            long_side = leg.side == "long"
            side = buy if long_side == opening else sell
            order = self.strategy.order_factory.market(instrument.id, side, quantity.from_int(shares))
            charges[order.client_order_id] = (leg, opening)
            self.strategy.submit_order(order)

        def open(self, leg: OpenLeg) -> None:
            # Sent at the OPEN offset of this bar, when the entry quotes are in.
            self.opening.append(leg)

        def send_opening(self) -> None:
            for leg in self.opening:
                self._send(leg, True)
            self.opening = []

        def close(self, leg: OpenLeg) -> None:
            self._send(leg, False)

    class AcademyStrategy(nt["Strategy"]):
        def on_start(self):
            self.broker = NautilusBroker(self)
            self.simulation = Simulation(data, self.broker)
            self.filled = 0
            self.subscribe_quote_ticks(stock_id)

        def on_quote_tick(self, tick_):
            index, phase = phase_of[tick_.ts_init]
            if phase == DECIDE:
                self.simulation.decide(index)
            elif phase == OPEN:
                self.broker.send_opening()
            elif phase == MARK:
                self.simulation.mark(self._equity())

        def _equity(self) -> float:
            value = float(self.portfolio.account(venue).balance_total(usd))
            book = self.simulation.book
            # Leg order (a dict keeps it), so the float sum is the same in every run.
            held = dict.fromkeys(instruments[_contract_key(leg)].id for leg in book.legs) if book is not None else {}
            for instrument_id in held:
                net = float(self.portfolio.net_position(instrument_id))
                mark = float(self.cache.quote_tick(instrument_id).ask_price)
                value += net * multipliers[instrument_id] * mark
            return value

        def on_order_filled(self, event):
            leg, opening = charges[event.client_order_id]
            shares = leg.qty * (STOCK_LOT if leg.kind == "stock" else 1)
            # int(): float(Quantity) is not exact for every whole number.
            if int(event.last_qty) != shares:
                problems.append(f"{leg.label}: filled {event.last_qty} of {shares}")
            self.filled += 1
            # The trade record reports what Nautilus filled.
            if opening:
                leg.entry = float(event.last_px)
            else:
                leg.exit = float(event.last_px)

        def on_order_rejected(self, event):
            problems.append(f"order rejected: {event.reason}")

        def on_order_denied(self, event):
            problems.append(f"order denied: {event.reason}")

        def on_order_canceled(self, event):
            problems.append(f"order cancelled: {event.client_order_id}")

    engine = nt["BacktestEngine"](nt["BacktestEngineConfig"](
        logging=nt["LoggingConfig"](log_level="ERROR", bypass_logging=True)))
    strategy = AcademyStrategy(nt["StrategyConfig"](strategy_id="ACADEMY-001"))
    try:
        engine.add_venue(venue, nt["OmsType"].NETTING, nt["AccountType"].CASH, [money(data.capital, usd)],
                         base_currency=usd, fee_model=AcademyFees(), allow_cash_borrowing=True)
        for instrument in instruments.values():
            engine.add_instrument(instrument)
        engine.add_data(feed)
        engine.add_strategy(strategy)
        engine.run()
        open_positions = [str(instrument.id) for instrument in instruments.values()
                          if float(engine.portfolio.net_position(instrument.id)) != 0]
    finally:
        engine.dispose()
    simulation: Simulation = strategy.simulation
    if problems:
        raise RuntimeError(f"nautilus academy backtest: {problems[0]}")
    if _openings(simulation) != _openings(plan):
        # The quotes were built for the plan's openings: another bar or contract fills at a quote
        # that is missing or not the entry quote.
        raise RuntimeError("the Nautilus run left the modelled plan: a leg opened on another bar or contract")
    if open_positions or simulation.book is not None:
        raise RuntimeError("nautilus academy backtest ended with an open position")
    if strategy.filled != len(charges):
        raise RuntimeError(f"nautilus academy backtest filled {strategy.filled} of {len(charges)} orders")
    result = simulation.result()
    if not all(math.isfinite(value) for value in result["equity"]):
        raise RuntimeError("nautilus academy backtest produced a non-finite equity")
    return {**result, "engine": ENGINE_ID, "modelVersion": ACADEMY_MODEL_VERSION}
