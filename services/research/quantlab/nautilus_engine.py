"""NautilusTrader execution engine for Quant Lab specs (research only).

Select it with `python -m quantlab backtest --engine nautilus ...`. The default
engine stays the standard-library simulator in engine.py. This module gives the
same `Run` (daily returns, weights, trades) for the same frozen spec and frozen
bars, so backtest.py builds the same result record from either engine.

Pin: nautilus-trader==1.227.0, the version of the Vertex Quant node. It is a
lazy import: the quantlab package imports without it, and `simulate` raises
`NautilusUnavailable` with an install hint when it is missing or a different
version. Install it from services/research/requirements-nautilus-linux-py312.lock.

Model (BacktestEngine, one simulated venue "QLAB", CASH account in USD, netting):
- Each session is fed as three one-minute LAST bars with open = high = low =
  close: the opening print (adjusted open, 14:30 UTC), the closing print
  (adjusted close, 20:59 UTC) and an end-of-day mark at the same close price
  (21:00 UTC). Bar-based execution fills a market order at the price of the
  print where it is submitted. Clock times only order the prints; the bars
  carry no intraday information.
- Decisions: the shared `engine.signals` function on adjusted closes up to the
  decision day, read at the end-of-day mark. Month-end detection is the same as
  in engine.py. The strategy submits the order at the next session's opening
  print (`next_open`) or closing print (`next_close`), so fills match the
  standard-library timing.
- Costs: commission + half-spread + slippage per side are the instrument
  maker/taker fee (fraction of traded notional). The fill price is the print
  price; the spread and slippage are charged as fee, not as a worse price.
- Cash interest: a simulation module credits the daily T-bill rate on the cash
  balance before the first print of each session (the cash held since the
  previous close).
- Sizing: whole shares from a 100,000,000 USD start. An entry buys
  floor(weight * equity / (1 + weight * fee) / price) shares; an exit sells the
  whole position. Between rebalances the share count is fixed, so a weight
  below 1 drifts with the price (the standard-library engine keeps the weight
  constant). With weight 1 the two engines agree up to share rounding.
- No orders leave the process: there is no live client, broker or network.
"""
from __future__ import annotations

import importlib
import math
from datetime import datetime, timezone
from decimal import Decimal

from .data import Bar
from .engine import Costs, Run, _is_month_end, signals

NAUTILUS_VERSION = "1.227.0"
ENGINE_ID = f"nautilus-trader-{NAUTILUS_VERSION}"
START_CAPITAL = 100_000_000
PRICE_PRECISION = 8
INSTALL_HINT = ("install the pinned lock: python -m pip install --no-deps --require-hashes --only-binary=:all: "
                "-r services/research/requirements-nautilus-linux-py312.lock")

# One session = three prints (UTC clock time used only for ordering).
OPEN_PRINT, CLOSE_PRINT, EOD_MARK = (14, 30), (20, 59), (21, 0)

# Name used here -> (module, attribute). Imported only when the engine runs.
_NAUTILUS_NAMES = {
    "SimulationModuleConfig": ("nautilus_trader.backtest.config", "SimulationModuleConfig"),
    "BacktestEngine": ("nautilus_trader.backtest.engine", "BacktestEngine"),
    "BacktestEngineConfig": ("nautilus_trader.backtest.engine", "BacktestEngineConfig"),
    "SimulationModule": ("nautilus_trader.backtest.modules", "SimulationModule"),
    "LoggingConfig": ("nautilus_trader.config", "LoggingConfig"),
    "StrategyConfig": ("nautilus_trader.config", "StrategyConfig"),
    "USD": ("nautilus_trader.model.currencies", "USD"),
    "NBar": ("nautilus_trader.model.data", "Bar"),
    "BarType": ("nautilus_trader.model.data", "BarType"),
    "AccountType": ("nautilus_trader.model.enums", "AccountType"),
    "OmsType": ("nautilus_trader.model.enums", "OmsType"),
    "OrderSide": ("nautilus_trader.model.enums", "OrderSide"),
    "InstrumentId": ("nautilus_trader.model.identifiers", "InstrumentId"),
    "Symbol": ("nautilus_trader.model.identifiers", "Symbol"),
    "Venue": ("nautilus_trader.model.identifiers", "Venue"),
    "Equity": ("nautilus_trader.model.instruments", "Equity"),
    "Money": ("nautilus_trader.model.objects", "Money"),
    "Price": ("nautilus_trader.model.objects", "Price"),
    "Quantity": ("nautilus_trader.model.objects", "Quantity"),
    "Strategy": ("nautilus_trader.trading.strategy", "Strategy"),
}


class NautilusUnavailable(RuntimeError):
    """nautilus-trader is missing or not the pinned version."""


def require() -> None:
    """Raise NautilusUnavailable unless the pinned nautilus-trader is importable."""
    try:
        import nautilus_trader
    except ImportError as error:
        raise NautilusUnavailable(f"nautilus-trader=={NAUTILUS_VERSION} is not installed; {INSTALL_HINT}") from error
    version = getattr(nautilus_trader, "__version__", "unknown")
    if version != NAUTILUS_VERSION:
        raise NautilusUnavailable(f"nautilus-trader {version} found, {NAUTILUS_VERSION} is pinned; {INSTALL_HINT}")


def _nautilus() -> dict:
    require()
    return {name: getattr(importlib.import_module(module), attr) for name, (module, attr) in _NAUTILUS_NAMES.items()}


def _ns(day: str, hm: tuple[int, int]) -> int:
    stamp = datetime.fromisoformat(day).replace(hour=hm[0], minute=hm[1], tzinfo=timezone.utc)
    if stamp.year < 1971:
        raise ValueError(f"nautilus engine needs sessions after 1970 (UNIX nanoseconds), got {day}")
    return int(stamp.timestamp()) * 1_000_000_000


def simulate(bars: list[Bar], rf: list[float], *, signal_type: str, lookback: int, unit: str,
             rebalance: str, execution: str, weight: float, costs: Costs) -> Run:
    """Same contract as engine.simulate, executed by a NautilusTrader BacktestEngine."""
    nt = _nautilus()
    USD, Money, Price, Quantity = nt["USD"], nt["Money"], nt["Price"], nt["Quantity"]
    dates = [b.date for b in bars]
    decisions = signals(bars, signal_type, lookback, unit)
    venue = nt["Venue"]("QLAB")
    symbol = nt["Symbol"]("QLAB")
    instrument_id = nt["InstrumentId"](symbol, venue)
    fee = Decimal(repr(costs.per_side))
    instrument = nt["Equity"](instrument_id, symbol, USD, PRICE_PRECISION,
                              Price.from_str("0." + "0" * (PRICE_PRECISION - 1) + "1"), Quantity.from_int(1), 0, 0,
                              maker_fee=fee, taker_fee=fee)
    bar_type = nt["BarType"].from_str("QLAB.QLAB-1-MINUTE-LAST-EXTERNAL")
    volume = Quantity.from_int(10**12)
    open_ts = {_ns(d, OPEN_PRINT): i for i, d in enumerate(dates)}
    trade_hm = OPEN_PRINT if execution == "next_open" else CLOSE_PRINT
    feed = []
    for bar in bars:
        for hm, value in ((OPEN_PRINT, bar.adj_open), (CLOSE_PRINT, bar.adj_close), (EOD_MARK, bar.adj_close)):
            px = Price(round(value, PRICE_PRECISION), PRICE_PRECISION)
            ts = _ns(bar.date, hm)
            feed.append(nt["NBar"](bar_type, px, px, px, px, volume, ts, ts))

    class CashInterest(nt["SimulationModule"]):
        """Credits the session's daily cash rate on the cash balance before its first print."""

        def pre_process(self, data):
            i = open_ts.get(data.ts_init)
            if i is None or i == 0 or rf[i] == 0:
                return
            cash = float(self.exchange.get_account().balance_total(USD))
            credit = round(cash * rf[i], 2)
            if cash > 0 and credit != 0:
                self.exchange.adjust_account(Money(credit, USD))

        def process(self, ts_now):
            pass

        def log_diagnostics(self, logger):
            pass

        def reset(self):
            pass

    state = {"session": -1, "pending": None, "held": 0.0, "returns": [], "weights": [], "equity": None,
             "trades": [], "open_trade": None, "paid": 0.0, "warmup_end": None}

    class SpecStrategy(nt["Strategy"]):
        def on_start(self):
            self.subscribe_bars(bar_type)

        def _equity(self, price: float) -> float:
            cash = float(self.portfolio.account(venue).balance_total(USD))
            return cash + float(self.portfolio.net_position(instrument_id)) * price

        def on_bar(self, nbar):
            ts, price = nbar.ts_init, float(nbar.close)
            day = datetime.fromtimestamp(ts / 1e9, tz=timezone.utc)
            hm = (day.hour, day.minute)
            if hm == OPEN_PRINT:
                state["session"] += 1
            i = state["session"]
            if hm == trade_hm and state["pending"] is not None:
                self._trade(state["pending"], price, dates[i])
                state["pending"] = None
            if hm == EOD_MARK:
                self._mark(i, price)

        def _trade(self, target: float, price: float, day: str):
            net = float(self.portfolio.net_position(instrument_id))
            if target > 0 and net == 0:
                equity = self._equity(price)
                qty = math.floor(target * equity / (1 + target * costs.per_side) / price)
                if qty > 0:
                    self.submit_order(self.order_factory.market(instrument_id, nt["OrderSide"].BUY,
                                                                Quantity.from_int(qty)))
                    state["open_trade"] = {"entry_t": day, "qty": target, "equity": equity}
            elif target == 0 and net > 0:
                state["open_trade"]["exit_t"] = day
                state["open_trade"]["exit_equity"] = self._equity(price)
                self.submit_order(self.order_factory.market(instrument_id, nt["OrderSide"].SELL,
                                                            Quantity.from_int(int(net))))
            state["held"] = target

        def on_order_filled(self, event):
            trade = state["open_trade"]
            px, qty, fee_paid = float(event.last_px), float(event.last_qty), float(event.commission)
            if event.order_side == nt["OrderSide"].BUY:
                trade.update(entry_px=px, shares=qty, entry_fee=fee_paid)
                state["paid"] += fee_paid / trade["equity"]
            else:
                state["paid"] += fee_paid / trade["exit_equity"]
                state["trades"].append(_trade_record(trade, trade["exit_t"], px, fee_paid))
                state["open_trade"] = None

        def _mark(self, i: int, price: float):
            equity = self._equity(price)
            prev = state["equity"]
            state["returns"].append(0.0 if prev is None else equity / prev - 1)
            state["weights"].append(state["held"])
            state["equity"] = equity
            decision = decisions[i]
            if decision is not None and state["warmup_end"] is None and i > 0:
                state["warmup_end"] = dates[i]
            if i > 0 and decision is not None and (rebalance == "daily" or _is_month_end(dates, i)):
                wanted = weight if decision else 0.0
                if wanted != state["held"]:
                    state["pending"] = wanted

    engine = nt["BacktestEngine"](nt["BacktestEngineConfig"](
        logging=nt["LoggingConfig"](log_level="ERROR", bypass_logging=True)))
    try:
        engine.add_venue(venue, nt["OmsType"].NETTING, nt["AccountType"].CASH, [Money(START_CAPITAL, USD)],
                         base_currency=USD, modules=[CashInterest(nt["SimulationModuleConfig"]())],
                         bar_execution=True)
        engine.add_instrument(instrument)
        engine.add_data(feed)
        engine.add_strategy(SpecStrategy(nt["StrategyConfig"](strategy_id="QLAB-001")))
        engine.run()
    finally:
        engine.dispose()
    if len(state["returns"]) != len(bars):
        raise RuntimeError(f"nautilus run marked {len(state['returns'])} of {len(bars)} sessions")
    trades = state["trades"]
    if state["open_trade"] is not None:  # marked at the last close, exit cost charged like engine.py
        trade = state["open_trade"]
        exit_fee = trade["shares"] * bars[-1].adj_close * costs.per_side
        trades.append({**_trade_record(trade, dates[-1], bars[-1].adj_close, exit_fee), "open": True})
    return Run(dates, state["returns"], state["weights"], rf, trades, state["paid"], state["warmup_end"])


def _trade_record(trade: dict, day: str, exit_px: float, exit_fee: float) -> dict:
    entry_notional, exit_notional = trade["shares"] * trade["entry_px"], trade["shares"] * exit_px
    net = (exit_notional - exit_fee) / (entry_notional + trade["entry_fee"]) - 1
    return {"entry_t": trade["entry_t"], "exit_t": day, "side": "long", "qty": round(trade["qty"], 6),
            "entry_px": round(trade["entry_px"], 4), "exit_px": round(exit_px, 4), "pnl": round(net, 6),
            "commission": round(trade["entry_fee"] / entry_notional + exit_fee / exit_notional, 6)}
