"""Share booking of the Triple RSI trades: a reference ledger and NautilusTrader (research only).

Model (spec classification 7 to 10):
- One long position at a time with 100% of equity, no leverage; cash earns 0 while flat.
- Prices: the traded series of `traded_prices`: basis "total" scales open and close by adj_close / close (the
  dividend-adjusted series, total return); basis "price" uses the split-adjusted open and close. Prices are
  rounded to PRICE_PRECISION decimals before both books see them.
- Fills (`fills`): "close" buys at the close of the entry signal bar and sells at the close of the exit signal
  bar; "nextOpen" / "nextClose" fill at the open / close of the bar after each signal bar. A position still open
  after the last bar is sold at the last close (reason "end"); an entry signal on the last bar of a next-bar
  execution (or on the last bar of the close execution) is not filled.
- Each day: open fills (exits, then entries), close fills (exits, then entries), then the equity mark at the
  close. Quantity = (cash - 0.01) / (price * (1 + cost)) rounded down to SIZE_PRECISION decimals. The cost per
  side is a fraction of the traded value, booked in cents; cash is booked in cents, as the Nautilus CASH account.
- `run_nautilus` books the same fills in a NautilusTrader BacktestEngine (CASH account, one CFD instrument,
  market orders filled at the price print of the fill, the cost as commission). `book` runs both and refuses a
  relative equity gap above PARITY_REL_TOL or a different fill list.
No orders leave the process: there is no live client, broker or network.
"""
from __future__ import annotations

import importlib
import itertools
import math
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime

from strategies.qc_ports.data import Bars
from strategies.qc_ports.ledger import LedgerResult

from .rules import EXECUTIONS, SignalTrade

__all__ = ["CAPITAL", "PARITY_REL_TOL", "Fill", "Prices", "book", "fills", "run_ledger", "run_nautilus",
           "traded_prices"]

CAPITAL = 100_000.0
PRICE_PRECISION = 6
SIZE_PRECISION = 6
PARITY_REL_TOL = 1e-9
LEDGER_ID = "triple-rsi-share-ledger"
OPEN, CLOSE = "open", "close"
_RUN_COUNTER = itertools.count(1)


@dataclass(frozen=True)
class Prices:
    """The traded price series of one symbol, from bar `first` on (the run days)."""

    symbol: str
    dates: tuple[str, ...]
    open: tuple[float, ...]
    close: tuple[float, ...]


@dataclass(frozen=True)
class Fill:
    """One round trip in run-day indices: entry (day, open|close) and exit (day, open|close)."""

    entry_day: int
    entry_at: str
    exit_day: int
    exit_at: str
    reason: str


def traded_prices(bars: Bars, first: int = 0, basis: str = "total") -> Prices:
    if basis not in ("total", "price"):
        raise ValueError("basis must be total or price")
    opens, closes = [], []
    for index in range(first, len(bars)):
        factor = bars.adj_close[index] / bars.close[index] if basis == "total" else 1.0
        opens.append(round(bars.open[index] * factor, PRICE_PRECISION))
        closes.append(round(bars.close[index] * factor, PRICE_PRECISION))
    return Prices(bars.symbol, tuple(bars.dates[first:]), tuple(opens), tuple(closes))


def fills(trades: Sequence[SignalTrade], execution: str, days: int, first: int = 0) -> list[Fill]:
    """The fills of signal trades (bar indices of the full series) on the run days from bar `first`."""
    if execution not in EXECUTIONS:
        raise ValueError(f"execution must be one of {EXECUTIONS}")
    lag, at = {"close": (0, CLOSE), "nextOpen": (1, OPEN), "nextClose": (1, CLOSE)}[execution]
    out: list[Fill] = []
    last = days - 1
    for trade in trades:
        entry = trade.entry - first + lag
        if trade.entry < first or entry > last or (entry == last and at == CLOSE):
            continue
        exit_ = None if trade.exit is None else trade.exit - first + lag
        if exit_ is None or exit_ > last:
            out.append(Fill(entry, at, last, CLOSE, "end"))
        else:
            out.append(Fill(entry, at, exit_, at, "signal"))
    return out


def _cents(value: float) -> float:
    return round(value, 2)


def _quantity(cash: float, price: float, cost: float) -> float:
    scale = 10 ** SIZE_PRECISION
    return round(math.floor((cash - 0.01) / (price * (1 + cost)) * scale) / scale, SIZE_PRECISION)


def _record(number: int, prices: Prices, fill: Fill, qty: float, entry_price: float, exit_price: float,
            entry_fee: float, exit_fee: float) -> dict:
    paid = _cents(qty * entry_price) + entry_fee
    got = _cents(qty * exit_price) - exit_fee
    return {"id": number, "symbol": prices.symbol, "entryDate": prices.dates[fill.entry_day],
            "exitDate": prices.dates[fill.exit_day], "entryAt": fill.entry_at, "exitAt": fill.exit_at,
            "quantity": qty, "entryPrice": entry_price, "exitPrice": exit_price, "entryFee": entry_fee,
            "exitFee": exit_fee, "pnl": _cents(got - paid), "return": got / paid - 1,
            "holdDays": fill.exit_day - fill.entry_day, "exitReason": fill.reason}


def _check(prices: Prices, plan: Sequence[Fill]) -> None:
    previous_exit = -1
    for fill in plan:
        if not (0 <= fill.entry_day <= fill.exit_day < len(prices.dates)):
            raise ValueError("Fill outside the run days")
        if fill.entry_day == fill.exit_day and not (fill.entry_at == OPEN and fill.exit_at == CLOSE):
            raise ValueError("A same-day round trip must buy at the open and sell at the close")
        if fill.entry_day <= previous_exit:
            raise ValueError("Fills overlap: one position at a time, entered after the day of the last exit")
        previous_exit = fill.exit_day


def run_ledger(prices: Prices, plan: Sequence[Fill], cost: float = 0.0, capital: float = CAPITAL) -> LedgerResult:
    """Reference ledger of the fills. `cost`: fraction of the traded value per side."""
    _check(prices, plan)
    by_day: dict[tuple[int, str, str], list[int]] = {}
    for number, fill in enumerate(plan):
        by_day.setdefault((fill.entry_day, fill.entry_at, "entry"), []).append(number)
        by_day.setdefault((fill.exit_day, fill.exit_at, "exit"), []).append(number)
    cash = _cents(capital)
    held: dict[int, tuple[float, float, float]] = {}
    equity, positions, records = [], [], []
    for day in range(len(prices.dates)):
        for at in (OPEN, CLOSE):
            price = prices.open[day] if at == OPEN else prices.close[day]
            for number in by_day.get((day, at, "exit"), ()):
                qty, entry_price, entry_fee = held.pop(number)
                fee = _cents(qty * price * cost)
                cash = _cents(cash + _cents(qty * price) - fee)
                records.append(_record(number + 1, prices, plan[number], qty, entry_price, price, entry_fee, fee))
            for number in by_day.get((day, at, "entry"), ()):
                qty = _quantity(cash, price, cost)
                fee = _cents(qty * price * cost)
                cash = _cents(cash - _cents(qty * price) - fee)
                held[number] = (qty, price, fee)
        equity.append(cash + sum(qty * prices.close[day] for qty, _, _ in held.values()))
        positions.append(len(held))
    return LedgerResult(prices.dates, tuple(equity), tuple(positions), tuple(records), (), capital=float(capital),
                        engine=LEDGER_ID)


# --------------------------------------------------------------------------- NautilusTrader

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
# Prints of one day (ns after midnight UTC of the date): the open price, the open fills, the close price, the
# close fills, the equity mark.
SLOTS = {"openPrice": 1, "openFills": 2, "closePrice": 3, "closeFills": 4, "mark": 5}
BAR_VOLUME = 10 ** 12


def engine_id() -> str:
    from quantlab.nautilus_engine import NAUTILUS_VERSION

    return f"nautilus-trader-{NAUTILUS_VERSION}"


def _nautilus() -> dict:
    from quantlab.nautilus_engine import require

    require()
    return {name: getattr(importlib.import_module(module), attr) for name, (module, attr) in _NAUTILUS_NAMES.items()}


def _day_ns(day: str) -> int:
    return int(datetime.fromisoformat(day).replace(tzinfo=UTC).timestamp()) * 10 ** 9


def run_nautilus(prices: Prices, plan: Sequence[Fill], cost: float = 0.0, capital: float = CAPITAL) -> LedgerResult:
    """Same contract as run_ledger, matched and booked by NautilusTrader."""
    _check(prices, plan)
    nt = _nautilus()
    USD, Money, Price, Quantity, OrderSide = nt["USD"], nt["Money"], nt["Price"], nt["Quantity"], nt["OrderSide"]
    venue = nt["Venue"](f"TRSI{next(_RUN_COUNTER)}")
    volume = Quantity(BAR_VOLUME, SIZE_PRECISION)
    tick = Price(10 ** -PRICE_PRECISION, PRICE_PRECISION)
    lot = Quantity(10 ** -SIZE_PRECISION, SIZE_PRECISION)

    def instrument(name: str):
        symbol = nt["Symbol"](name)
        instrument_id = nt["InstrumentId"](symbol, venue)
        cfd = nt["Cfd"](instrument_id, symbol, nt["AssetClass"].EQUITY, USD, PRICE_PRECISION, SIZE_PRECISION,
                        tick, lot, 0, 0)
        return cfd, nt["BarType"].from_str(f"{instrument_id}-1-MINUTE-LAST-EXTERNAL")

    def bar(bar_type, price: float, ts: int):
        value = Price(price, PRICE_PRECISION)
        return nt["NBar"](bar_type, value, value, value, value, volume, ts, ts)

    asset, asset_bar = instrument("ASSET")
    clock, clock_bar = instrument("CLOCK")
    feed, clock_at = [], {}
    for day, date_text in enumerate(prices.dates):
        base = _day_ns(date_text)
        feed.append(bar(asset_bar, prices.open[day], base + SLOTS["openPrice"]))
        feed.append(bar(asset_bar, prices.close[day], base + SLOTS["closePrice"]))
        for slot, at in (("openFills", OPEN), ("closeFills", CLOSE), ("mark", None)):
            ts = base + SLOTS[slot]
            feed.append(bar(clock_bar, 1.0, ts))
            clock_at[ts] = (day, at)
    entering: dict[tuple[int, str], list[int]] = {}
    exiting: dict[tuple[int, str], list[int]] = {}
    for number, fill in enumerate(plan):
        entering.setdefault((fill.entry_day, fill.entry_at), []).append(number)
        exiting.setdefault((fill.exit_day, fill.exit_at), []).append(number)
    state: dict = {"open": {}, "equity": [], "positions": [], "records": [], "pending": {}}

    class Costs(nt["FeeModel"]):
        def get_commission(self, order, fill_qty, fill_px, instrument):
            return Money(_cents(float(fill_qty) * float(fill_px) * cost), USD)

    class Shares(nt["Strategy"]):
        def on_start(self):
            self.subscribe_bars(clock_bar)
            self.subscribe_bars(asset_bar)

        def _cash(self) -> float:
            return float(self.portfolio.account(venue).balance_total(USD))

        def _submit(self, number: int, side, qty: float) -> None:
            order = self.order_factory.market(asset.id, side, Quantity(qty, SIZE_PRECISION),
                                              reduce_only=side == OrderSide.SELL)
            state["pending"][order.client_order_id] = number
            self.submit_order(order)

        def on_bar(self, nbar):
            if nbar.bar_type != clock_bar:
                return
            day, at = clock_at[nbar.ts_init]
            if at is None:
                close = prices.close[day]
                state["equity"].append(self._cash() + sum(item["qty"] * close for item in state["open"].values()))
                state["positions"].append(len(state["open"]))
                return
            for number in exiting.get((day, at), ()):
                self._submit(number, OrderSide.SELL, state["open"][number]["qty"])
            for number in entering.get((day, at), ()):
                price = prices.open[day] if at == OPEN else prices.close[day]
                self._submit(number, OrderSide.BUY, _quantity(round(self._cash(), 2), price, cost))

        def on_order_filled(self, event):
            number = state["pending"].pop(event.client_order_id)
            qty = round(float(event.last_qty), SIZE_PRECISION)
            price, fee = float(event.last_px), float(event.commission)
            if event.order_side == OrderSide.BUY:
                state["open"][number] = {"qty": qty, "price": price, "fee": fee}
                return
            entry = state["open"].pop(number)
            if abs(qty - entry["qty"]) > 10 ** -SIZE_PRECISION / 2:
                raise RuntimeError(f"triple-rsi nautilus: partial exit of fill {number + 1}")
            state["records"].append(_record(number + 1, prices, plan[number], qty, entry["price"], price,
                                            entry["fee"], fee))

    engine = nt["BacktestEngine"](nt["BacktestEngineConfig"](
        logging=nt["LoggingConfig"](log_level="ERROR", bypass_logging=True)))
    strategy = Shares(nt["StrategyConfig"](strategy_id="TRIPLERSI-001"))
    try:
        engine.add_venue(venue, nt["OmsType"].NETTING, nt["AccountType"].CASH, [Money(capital, USD)],
                         base_currency=USD, fee_model=Costs(), bar_execution=True)
        engine.add_instrument(asset)
        engine.add_instrument(clock)
        engine.add_data(sorted(feed, key=lambda item: item.ts_init))
        engine.add_strategy(strategy)
        engine.run()
        rejected = [order for order in engine.cache.orders()
                    if not order.is_closed or order.filled_qty != order.quantity]
    finally:
        engine.dispose()
    if rejected:
        raise RuntimeError(f"triple-rsi nautilus: {len(rejected)} orders not fully filled")
    if state["open"]:
        raise RuntimeError("triple-rsi nautilus: a position is open after the last run day")
    if len(state["equity"]) != len(prices.dates):
        raise RuntimeError(f"triple-rsi nautilus marked {len(state['equity'])} of {len(prices.dates)} days")
    records = sorted(state["records"], key=lambda record: record["id"])
    return LedgerResult(prices.dates, tuple(state["equity"]), tuple(state["positions"]), tuple(records), (),
                        capital=float(capital), engine=engine_id())


def parity_gap(left: LedgerResult, right: LedgerResult) -> float:
    return max((abs(a - b) / max(abs(a), abs(b)) for a, b in zip(left.equity, right.equity, strict=True)),
               default=0.0)


def book(prices: Prices, plan: Sequence[Fill], cost: float = 0.0, capital: float = CAPITAL, *,
         nautilus: bool = True) -> tuple[LedgerResult, float | None]:
    """(ledger result, relative equity gap to NautilusTrader or None without it). Refuses a gap above the tolerance."""
    ledger = run_ledger(prices, plan, cost, capital)
    if not nautilus:
        return ledger, None
    other = run_nautilus(prices, plan, cost, capital)
    gap = parity_gap(ledger, other)
    same = [(t["id"], t["entryDate"], t["exitDate"]) for t in ledger.trades] == [
        (t["id"], t["entryDate"], t["exitDate"]) for t in other.trades]
    if gap > PARITY_REL_TOL or not same:
        raise RuntimeError(f"triple-rsi: ledger and NautilusTrader disagree (gap {gap:.3g}, fills match {same})")
    return ledger, gap
