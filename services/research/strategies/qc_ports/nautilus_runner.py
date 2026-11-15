"""NautilusTrader runner of the qc-ports options trades (research only).

Runs the priced trades of book.py in a NautilusTrader BacktestEngine and gives
the result of the reference ledger (ledger.py): daily equity and trade records.
Nautilus matches every order and keeps the cash and position ledger; this
module decides when to send orders, sizes them and reads equity from the
portfolio. Parity with ledger.py is a test (1e-6 relative on equity).

Pin: nautilus-trader==1.227.0 (quantlab.nautilus_engine.require), lock
services/research/requirements-nautilus-linux-py312.lock.

Model:
- One simulated venue, CASH account in USD with the capital, netting, no cash
  borrowing (sizing caps an entry by the cash).
- One synthetic CFD instrument per slot (price = spread instrument value per
  contract in $, 2 decimals; whole contracts), fed as one LAST bar per day a
  trade is held at its mark (book.py), plus a clock instrument with three prints
  per run day after every trade bar of that day: exits, entries, equity mark. So
  exits are filled before the entries of the day are sized. A slot holds one
  trade at a time: a trade takes the first slot whose last trade had its last
  mark before the first mark of this one. The venue steps every instrument on
  every data point, so an instrument per trade made a run of n trades O(n^2)
  (30 000 trades on 1-minute bars).
- Market orders fill at the day's mark (bar execution). The fee model charges
  the per-contract costs of book.py (commissions + half-spread, 0 at
  expiration) as commission in USD.
- Sizing at entry from current equity = account balance + sum(net position *
  last mark), rounded to cents, with book.contracts_for (maxLossPct <= 2).
- A run day is a bar key (calendar.py). With bar times (intraday bars) every
  "day" above is one bar, and the clock prints come 30 seconds after the bar
  time: after the trade bars of that bar and before the next bar (bars are at
  least one minute apart).
- No orders leave the process: there is no live client, broker or network.
"""
from __future__ import annotations

import importlib
import itertools
from collections.abc import Iterable, Sequence
from datetime import UTC, datetime

from quantlab.nautilus_engine import NAUTILUS_VERSION, NautilusUnavailable, require

from .book import PricedTrade, contracts_for
from .calendar import is_bar_time
from .ledger import DEFAULT_CAPITAL, LedgerResult, timeline, trade_record

__all__ = ["ENGINE_ID", "NautilusUnavailable", "instrument_slots", "require", "run_nautilus"]

ENGINE_ID = f"nautilus-trader-{NAUTILUS_VERSION}"
PRICE_PRECISION = 2
SIZE_PRECISION = 0
# Clock prints of a day, after the trade bars: exits, entries, equity mark.
EXITS, ENTRIES, MARK = 0, 1, 2
CLOCK_OFFSET_NS = 20 * 3600 * 10 ** 9
# The same for a run on bar times: after the trade bars of the bar, before the next bar.
BAR_CLOCK_OFFSET_NS = 30 * 10 ** 9
BAR_VOLUME = 10 ** 9
_RUN_COUNTER = itertools.count(1)

_NAUTILUS_NAMES = {
    "BacktestEngine": ("nautilus_trader.backtest.engine", "BacktestEngine"),
    "BacktestEngineConfig": ("nautilus_trader.backtest.engine", "BacktestEngineConfig"),
    "FeeModel": ("nautilus_trader.backtest.models", "FeeModel"),
    "LoggingConfig": ("nautilus_trader.config", "LoggingConfig"),
    "StrategyConfig": ("nautilus_trader.config", "StrategyConfig"),
    "USD": ("nautilus_trader.model.currencies", "USD"),
    "NBar": ("nautilus_trader.model.data", "Bar"),
    "BarType": ("nautilus_trader.model.data", "BarType"),
    "AccountType": ("nautilus_trader.model.enums", "AccountType"),
    "AssetClass": ("nautilus_trader.model.enums", "AssetClass"),
    "OmsType": ("nautilus_trader.model.enums", "OmsType"),
    "OrderSide": ("nautilus_trader.model.enums", "OrderSide"),
    "InstrumentId": ("nautilus_trader.model.identifiers", "InstrumentId"),
    "Symbol": ("nautilus_trader.model.identifiers", "Symbol"),
    "Venue": ("nautilus_trader.model.identifiers", "Venue"),
    "Cfd": ("nautilus_trader.model.instruments", "Cfd"),
    "Money": ("nautilus_trader.model.objects", "Money"),
    "Price": ("nautilus_trader.model.objects", "Price"),
    "Quantity": ("nautilus_trader.model.objects", "Quantity"),
    "Strategy": ("nautilus_trader.trading.strategy", "Strategy"),
}


def _nautilus() -> dict:
    require()
    return {name: getattr(importlib.import_module(module), attr) for name, (module, attr) in _NAUTILUS_NAMES.items()}


def _day_ns(day: str) -> int:
    return int(datetime.fromisoformat(day).replace(tzinfo=UTC).timestamp()) * 10 ** 9


def _first_ns(trade: PricedTrade) -> int:
    """Time of the first bar of a trade on its instrument: its entry or its first mark."""
    return min(_day_ns(day) for day in (trade.entry_date, *(day for day, _ in trade.marks[:1])))


def _last_ns(trade: PricedTrade) -> int:
    """Time of the last bar of a trade on its instrument: its exit or its last mark."""
    return max(_day_ns(day) for day in (trade.exit_date, *(day for day, _ in trade.marks[-1:])))


def instrument_slots(trades: Iterable[PricedTrade]) -> dict[int, int]:
    """Trade id -> instrument slot (0, 1, ...): the first slot whose last trade had its last bar before the first
    bar of this one, in the order of the first bars (ties by trade id)."""
    ends: list[int] = []  # time of the last bar of the last trade of each slot
    slot_of: dict[int, int] = {}
    for trade in sorted(trades, key=lambda item: (_first_ns(item), item.trade_id)):
        start = _first_ns(trade)
        slot = next((index for index, end in enumerate(ends) if end < start), len(ends))
        if slot == len(ends):
            ends.append(0)
        ends[slot] = _last_ns(trade)
        slot_of[trade.trade_id] = slot
    return slot_of


def run_nautilus(trades: Sequence[PricedTrade], capital: float = DEFAULT_CAPITAL,
                 dates: Iterable[str] | None = None) -> LedgerResult:
    """Same contract as ledger.run_ledger, matched and booked by NautilusTrader."""
    if not capital > 0:
        raise ValueError("capital must be above 0")
    days = timeline(trades, dates)
    if not days:
        raise ValueError("Nothing to run: no dates")
    nt = _nautilus()
    USD, Money, Price, Quantity, OrderSide = nt["USD"], nt["Money"], nt["Price"], nt["Quantity"], nt["OrderSide"]
    venue = nt["Venue"](f"QCP{next(_RUN_COUNTER)}")
    volume = Quantity(BAR_VOLUME, SIZE_PRECISION)
    tick = Price(10 ** -PRICE_PRECISION, PRICE_PRECISION)
    one = Quantity(1, SIZE_PRECISION)

    def instrument(name: str):
        symbol = nt["Symbol"](name)
        instrument_id = nt["InstrumentId"](symbol, venue)
        cfd = nt["Cfd"](instrument_id, symbol, nt["AssetClass"].EQUITY, USD, PRICE_PRECISION, SIZE_PRECISION,
                        tick, one, 0, 0)
        return cfd, nt["BarType"].from_str(f"{instrument_id}-1-MINUTE-LAST-EXTERNAL")

    def bar(bar_type, price: float, ts: int):
        value = Price(round(price, PRICE_PRECISION), PRICE_PRECISION)
        return nt["NBar"](bar_type, value, value, value, value, volume, ts, ts)

    ordered = sorted(trades, key=lambda item: item.trade_id)
    for trade in ordered:
        # The entry fills at the bar of its own instrument; on a shared instrument a missing entry mark would
        # fill at the last mark of the trade before.
        if not trade.marks or trade.marks[0][0] != trade.entry_date:
            raise ValueError(f"qc-ports nautilus: trade {trade.trade_id} has no mark on its entry day")
    clock, clock_bar = instrument("CLOCK")
    slot_of = instrument_slots(ordered)
    instruments = [instrument(f"S{slot + 1}") for slot in range(max(slot_of.values(), default=-1) + 1)]
    legs = {trade.trade_id: instruments[slot_of[trade.trade_id]] for trade in ordered}
    feed = []
    for trade in ordered:
        for day, mark in trade.marks:
            feed.append(bar(legs[trade.trade_id][1], mark, _day_ns(day) + 1 + slot_of[trade.trade_id]))
    offset = BAR_CLOCK_OFFSET_NS if is_bar_time(days[0]) else CLOCK_OFFSET_NS
    clock_at: dict[int, tuple[str, int]] = {}
    for day in days:
        for part in (EXITS, ENTRIES, MARK):
            ts = _day_ns(day) + offset + part
            feed.append(bar(clock_bar, 1.0, ts))
            clock_at[ts] = (day, part)
    entering: dict[str, list[PricedTrade]] = {}
    exiting: dict[str, list[PricedTrade]] = {}
    for trade in ordered:
        entering.setdefault(trade.entry_date, []).append(trade)
        exiting.setdefault(trade.exit_date, []).append(trade)

    state = {"fees": {}, "trade_of": {}, "open": {}, "equity": [], "positions": [], "records": [], "skipped": []}

    class OptionFees(nt["FeeModel"]):
        """Charges the per-contract spread costs of book.py for the filled contracts."""

        def get_commission(self, order, fill_qty, fill_px, instrument):
            per_contract = state["fees"][order.client_order_id]
            return Money(round(float(fill_qty) * per_contract, 2), USD)

    class OptionsStrategy(nt["Strategy"]):
        def on_start(self):
            self.subscribe_bars(clock_bar)
            for _, bar_type in instruments:
                self.subscribe_bars(bar_type)

        def _cash(self) -> float:
            return float(self.portfolio.account(venue).balance_total(USD))

        def _held_value(self) -> float:
            total = 0.0
            for trade_id in state["open"]:
                instrument_id, bar_type = legs[trade_id][0].id, legs[trade_id][1]
                total += float(self.portfolio.net_position(instrument_id)) * float(self.cache.bar(bar_type).close)
            return total

        def _submit(self, trade: PricedTrade, side, contracts: int, fee: float) -> None:
            order = self.order_factory.market(legs[trade.trade_id][0].id, side, Quantity(contracts, SIZE_PRECISION),
                                              reduce_only=side == OrderSide.SELL)
            state["fees"][order.client_order_id] = fee
            state["trade_of"][order.client_order_id] = trade
            self.submit_order(order)

        def on_bar(self, nbar):
            if nbar.bar_type != clock_bar:
                return
            day, part = clock_at[nbar.ts_init]
            if part == EXITS:
                for trade in exiting.get(day, ()):
                    if trade.trade_id in state["open"]:
                        self._submit(trade, OrderSide.SELL, state["open"][trade.trade_id]["contracts"],
                                     trade.exit_fee)
            elif part == ENTRIES:
                cash = round(self._cash(), 2)
                sizing = round(cash + self._held_value(), 2)
                for trade in entering.get(day, ()):
                    contracts = contracts_for(sizing, cash, trade.max_loss_pct, trade.max_loss,
                                              trade.entry_price + trade.entry_fee)
                    if contracts == 0:
                        state["skipped"].append({"id": trade.trade_id, "symbol": trade.symbol, "entryDate": day,
                                                 "reason": "size"})
                        continue
                    cash = round(cash - contracts * trade.entry_price - round(contracts * trade.entry_fee, 2), 2)
                    self._submit(trade, OrderSide.BUY, contracts, trade.entry_fee)
            else:
                state["equity"].append(self._cash() + self._held_value())
                state["positions"].append(len(state["open"]))

        def on_order_filled(self, event):
            trade = state["trade_of"][event.client_order_id]
            contracts = int(event.last_qty)
            price = float(event.last_px)
            fee = float(event.commission)
            if event.order_side == OrderSide.BUY:
                state["open"][trade.trade_id] = {"contracts": contracts, "price": price, "fee": fee}
                return
            entry = state["open"].pop(trade.trade_id)
            if contracts != entry["contracts"]:
                raise RuntimeError(f"qc-ports nautilus: partial exit of trade {trade.trade_id}")
            state["records"].append(trade_record(trade, contracts, entry["price"], price, entry["fee"], fee))

    engine = nt["BacktestEngine"](nt["BacktestEngineConfig"](
        logging=nt["LoggingConfig"](log_level="ERROR", bypass_logging=True)))
    strategy = OptionsStrategy(nt["StrategyConfig"](strategy_id="QCPORTS-001"))
    try:
        engine.add_venue(venue, nt["OmsType"].NETTING, nt["AccountType"].CASH, [Money(capital, USD)],
                         base_currency=USD, fee_model=OptionFees(), bar_execution=True)
        engine.add_instrument(clock)
        for cfd, _ in instruments:
            engine.add_instrument(cfd)
        engine.add_data(sorted(feed, key=lambda item: item.ts_init))
        engine.add_strategy(strategy)
        engine.run()
        rejected = [order for order in engine.cache.orders()
                    if not order.is_closed or order.filled_qty != order.quantity]
    finally:
        engine.dispose()
    if rejected:
        raise RuntimeError(f"qc-ports nautilus: {len(rejected)} orders not fully filled")
    if state["open"]:
        raise RuntimeError("qc-ports nautilus: trades open after the last run day")
    if len(state["equity"]) != len(days):
        raise RuntimeError(f"qc-ports nautilus marked {len(state['equity'])} of {len(days)} days")
    records = sorted(state["records"], key=lambda record: (record["exitDate"], record["id"]))
    return LedgerResult(days, tuple(state["equity"]), tuple(state["positions"]), tuple(records),
                        tuple(state["skipped"]), capital=float(capital), engine=ENGINE_ID)
