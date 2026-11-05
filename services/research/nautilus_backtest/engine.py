"""NautilusTrader backtest engine for Vertex strategies (research only).

The engine runs the compiled signals of a fixed rule or a strategy DSL
definition (signals.py) in a NautilusTrader BacktestEngine and returns the
result shape of the TypeScript engine (packages/api/src/instant-backtest-engine.ts
`InstantRunResult`): unit equity per bar, trades and statistics. Nautilus
matches every order and keeps the cash and position ledger; this module only
decides when to send orders and converts the ledger to unit equity.

Pin: nautilus-trader==1.227.0, shared with Quant Lab (quantlab/nautilus_engine.py).
Lock: services/research/requirements-nautilus-linux-py312.lock.

Model (the same rules as the TypeScript engine):
- One simulated venue "VTX", CASH account in USD with the run capital, netting,
  one CFD instrument with 9-decimal prices and quantities (fractional units).
- Each bar i is fed as three one-minute LAST bars, 1 ns apart, starting at the
  bar time: the open print (open = high = low = close = open), the path from the
  open to the low (open, open, low, low) and the path from the low to the high
  and the close (low, high, low, close). The low comes before the high.
- Stop first: the TS engine exits at the stop whenever a bar reaches the stop,
  also when the bar opens beyond the target. So the target order rests during a
  bar only when that bar's low stays above the stop; the strategy reads the
  coming bar's low for this execution rule only (signals never read it).
- Signals use data up to the close of bar i. An entry or a signal exit is a
  market order at the open print of bar i + 1. Resting orders are cancelled at
  the close where an exit is decided, so the exit fills as a signal exit.
- On an entry fill the strategy places a reduce-only stop-market order at the
  stop level and, under the stop-first rule, a reduce-only market-if-touched
  order at the target level. Nautilus fills a level touched inside the bar at
  the level and a level gapped through at the open. When one fills, the other
  is cancelled.
- An open position closes with a market order at the last close (reason "end").
- Costs: Nautilus fills at the reference price. The fee model charges the flat
  `costBps` leg plus, with a cost profile, half the spread, the slippage, the
  commission and the fees (backtest-costs.ts) as commission in USD. The trade
  record reports the cost-adjusted fill price, as the TS engine does.
- Unit equity = account balance + position * close, divided by the capital.
- No orders leave the process: there is no live client, broker or network.
"""
from __future__ import annotations

import importlib
import itertools
import math
from dataclasses import dataclass, field

from quantlab.nautilus_engine import NAUTILUS_VERSION, NautilusUnavailable, require

from .bars import Bars, InputError
from .costs import affordable_units, average_true_range, fill_costs
from .signals import Compiled, RunOptions, plan_run

__all__ = ["ENGINE_ID", "NautilusUnavailable", "RunResult", "require", "run_signal_backtest", "run_spec", "summarize"]

ENGINE_ID = f"nautilus-trader-{NAUTILUS_VERSION}"
# Bump when the order or fill model of this module changes.
MODEL_VERSION = 1
DEFAULT_CAPITAL = 1_000_000.0
PRECISION = 9
YEAR_MS = 365.25 * 24 * 60 * 60 * 1000
BPS = 10_000
PERCENT = 100
OPEN, LOW_PATH, CLOSE = 0, 1, 2
# Nautilus registers cash borrowing per venue for the whole process, so each run gets a new venue.
_RUN_COUNTER = itertools.count(1)

_NAUTILUS_NAMES = {
    "BacktestEngine": ("nautilus_trader.backtest.engine", "BacktestEngine"),
    "BacktestEngineConfig": ("nautilus_trader.backtest.engine", "BacktestEngineConfig"),
    "FeeModel": ("nautilus_trader.backtest.models", "FeeModel"),
    "SimulationModule": ("nautilus_trader.backtest.modules", "SimulationModule"),
    "SimulationModuleConfig": ("nautilus_trader.backtest.config", "SimulationModuleConfig"),
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


@dataclass(frozen=True)
class RunResult:
    """Same fields as the TS `InstantRunResult`; trades and stats use the TS JSON keys."""

    equity: tuple[float, ...]
    trades: tuple[dict, ...]
    stats: dict
    engine: str = ENGINE_ID
    capital: float = DEFAULT_CAPITAL

    def to_json(self) -> dict:
        return {"engine": self.engine, "modelVersion": MODEL_VERSION, "capital": self.capital,
                "equity": list(self.equity), "trades": list(self.trades), "stats": self.stats}


def _nautilus() -> dict:
    require()
    return {name: getattr(importlib.import_module(module), attr) for name, (module, attr) in _NAUTILUS_NAMES.items()}


# ---------------------------------------------------------------- statistics (port of summarize)

def _drawdown(series) -> float:
    peak = series[0]
    worst = 0.0
    for value in series:
        if value > peak:
            peak = value
        drawdown = value / peak - 1
        if drawdown < worst:
            worst = drawdown
    return worst


def _ratio_stats(equity, years: float) -> dict:
    periods = len(equity) - 1
    total = 0.0
    downside_squares = 0.0
    for index in range(1, periods + 1):
        change = equity[index] / equity[index - 1] - 1
        total += change
        if change < 0:
            downside_squares += change * change
    mean = total / periods
    squares = 0.0
    for index in range(1, periods + 1):
        change = equity[index] / equity[index - 1] - 1
        squares += (change - mean) * (change - mean)
    annualizer = math.sqrt(periods / years) if years > 0 else 0.0
    deviation = math.sqrt(squares / (periods - 1)) if periods > 1 else 0.0
    downside = math.sqrt(downside_squares / periods)
    return {
        "sharpe": (mean / deviation) * annualizer if deviation > 0 and annualizer > 0 else None,
        "sortino": (mean / downside) * annualizer if downside > 0 and annualizer > 0 else None,
    }


def summarize(bars: Bars, equity, trades, bars_in_position: int) -> dict:
    """Port of the TS `summarize`: rf 0, annualized by the observed bars per year."""
    size = len(equity)
    first, last = equity[0], equity[size - 1]
    years = (bars.t[size - 1] - bars.t[0]) / YEAR_MS
    gross_win = gross_loss = 0.0
    wins = 0
    for trade in trades:
        if trade["pnl"] > 0:
            wins += 1
            gross_win += trade["pnl"]
        else:
            gross_loss -= trade["pnl"]
    try:
        growth = (last / first) ** (1 / years) - 1 if years > 0 else math.nan
    except OverflowError:
        growth = math.nan
    return {
        "bars": size,
        "cagr": growth if isinstance(growth, float) and math.isfinite(growth) else None,
        "maxDrawdown": _drawdown(equity),
        "totalReturn": last / first - 1,
        **_ratio_stats(equity, years),
        "buyHoldMaxDrawdown": _drawdown(bars.c),
        "buyHoldReturn": bars.c[size - 1] / bars.c[0] - 1,
        "exposure": bars_in_position / size,
        "profitFactor": gross_win / gross_loss if gross_loss > 0 else None,
        "trades": len(trades),
        "winRate": wins / len(trades) if trades else None,
    }


# ---------------------------------------------------------------- run

@dataclass
class _Open:
    """The open position, in unit equity (capital 1) like the TS PositionState."""

    entry_cash: float
    entry_index: int
    entry_price: float
    spent: float
    units: float
    qty: float
    legs: dict | None
    stop: float
    target: float


@dataclass
class _State:
    index: int = -1
    pending: int = 0
    pending_stop: float = math.nan
    pending_target: float = math.nan
    # Client order id of the resting target order (see _plan_target)
    target_order: object | None = None
    position: _Open | None = None
    exit_reason: str = ""
    trades: list = field(default_factory=list)
    equity: list = field(default_factory=list)
    bars_in_position: int = 0
    # client order id -> planned entry: spent (unit equity) and bar index
    entries: dict = field(default_factory=dict)
    # client order id -> charges of the fill in money: price (cost-adjusted), spread, slippage, commission, fees, bps
    charges: dict = field(default_factory=dict)


def _distance_at(series, index: int) -> float:
    value = math.nan if series is None else series[index]
    return value if value > 0 else math.nan


def _check_options(bars: Bars, compiled: Compiled, options: RunOptions) -> None:
    if len(compiled.signals) != len(bars):
        raise InputError("Signals must match the bar count")

    def percent(name: str, value: float, top: float) -> None:
        if not (math.isfinite(value) and 0 <= value <= top):
            raise InputError(f"{name} must be from 0 to {top:g}")

    percent("stopLossPct", options.stop_loss_pct, 99)
    percent("takeProfitPct", options.take_profit_pct, 10_000)
    percent("costBps", options.cost_bps, 500)
    if options.costs is not None:
        capital = options.costs["capital"]
        if not (math.isfinite(capital) and capital > 0):
            raise InputError("capital must be above 0")
    if options.risk_pct is not None and not (math.isfinite(options.risk_pct) and 0 < options.risk_pct <= 100):
        raise InputError("riskPct must be above 0 and at most 100")
    if options.max_hold_bars is not None and not (isinstance(options.max_hold_bars, int) and options.max_hold_bars >= 1):
        raise InputError("maxHoldBars must be a whole number of at least 1")
    if bars.t[0] < 0:
        raise InputError("the Nautilus engine needs bars after 1970 (UNIX nanoseconds)")


def run_signal_backtest(bars: Bars, compiled: Compiled, options: RunOptions, *,
                        capital: float | None = None) -> RunResult:
    """Runs precomputed signals in a Nautilus BacktestEngine. Same contract as TS runSignalBacktest."""
    size = len(bars)
    if size < 2:
        raise InputError("At least 2 bars needed")
    _check_options(bars, compiled, options)
    nt = _nautilus()
    USD, Money, Price, Quantity, OrderSide = nt["USD"], nt["Money"], nt["Price"], nt["Quantity"], nt["OrderSide"]
    profile = None if options.costs is None else options.costs["profile"]
    capital = float(options.costs["capital"]) if options.costs is not None else float(capital or DEFAULT_CAPITAL)
    cost = options.cost_bps / BPS
    stop_factor = 1 - options.stop_loss_pct / PERCENT if options.stop_loss_pct > 0 else 0.0
    target_factor = 1 + options.take_profit_pct / PERCENT if options.take_profit_pct > 0 else 0.0
    slip = None if profile is None else profile["slippage"]
    atr = (average_true_range(bars.h, bars.l, bars.c, slip["period"])
           if slip is not None and slip["kind"] == "atr" else None)

    def atr_before(index: int) -> float:
        return math.nan if atr is None or index == 0 else atr[index - 1]

    venue = nt["Venue"](f"VTX{next(_RUN_COUNTER)}")
    symbol = nt["Symbol"]("VTX")
    instrument_id = nt["InstrumentId"](symbol, venue)
    tick = Price(10 ** -PRECISION, PRECISION)
    instrument = nt["Cfd"](instrument_id, symbol, nt["AssetClass"].EQUITY, USD, PRECISION, PRECISION, tick,
                           Quantity(10 ** -PRECISION, PRECISION), 0, 0)
    bar_type = nt["BarType"].from_str(f"{instrument_id}-1-MINUTE-LAST-EXTERNAL")
    volume = Quantity(10 ** 9, PRECISION)
    part_of: dict[int, tuple[int, int]] = {}
    feed = []
    for i in range(size):
        o, h, low, c = bars.o[i], bars.h[i], bars.l[i], bars.c[i]
        base = int(round(bars.t[i])) * 1_000_000
        for part, (po, ph, pl, pc) in enumerate(((o, o, o, o), (o, o, low, low), (low, h, low, c))):
            ts = base + part
            prices = [Price(round(value, PRECISION), PRECISION) for value in (po, ph, pl, pc)]
            feed.append(nt["NBar"](bar_type, *prices, volume, ts, ts))
            part_of[ts] = (i, part)
    if len(part_of) != 3 * size:
        raise InputError("Bar times must be strictly increasing")

    state = _State()

    class BarClock(nt["SimulationModule"]):
        """Tracks the bar index before the exchange matches orders on that bar."""

        def pre_process(self, data):
            state.index = part_of[data.ts_init][0]

        def process(self, ts_now):
            pass

        def log_diagnostics(self, logger):
            pass

        def reset(self):
            pass

    class VertexFees(nt["FeeModel"]):
        """Charges the TS cost legs as commission; records the cost-adjusted fill per order."""

        def get_commission(self, order, fill_qty, fill_px, instrument):
            qty, ref = float(fill_qty), float(fill_px)
            index = state.index
            buy = order.side == OrderSide.BUY
            side = "buy" if buy else "sell"
            if profile is None:
                fill = {"price": ref, "spread": 0.0, "slippage": 0.0, "commission": 0.0, "fees": 0.0}
            else:
                legs = fill_costs(profile, side, qty, ref, atr_before(index))
                fill = {"price": legs.price, "spread": legs.spread, "slippage": legs.slippage,
                        "commission": legs.commission, "fees": legs.fees}
            if buy:
                fill["bps"] = state.entries[order.client_order_id]["spent"] * cost * capital
            else:
                fill["bps"] = qty * fill["price"] * cost
            state.charges[order.client_order_id] = fill
            # The adverse price move is paid as part of the charge; Nautilus fills at the reference price.
            move = abs(fill["price"] - ref) * qty
            total = move + fill["commission"] + fill["fees"] + fill["bps"]
            return Money(total, USD)

    class VertexStrategy(nt["Strategy"]):
        def on_start(self):
            self.subscribe_bars(bar_type)

        def _cash(self) -> float:
            return float(self.portfolio.account(venue).balance_total(USD)) / capital

        def _net(self) -> float:
            return float(self.portfolio.net_position(instrument_id))

        def on_bar(self, nbar):
            index, part = part_of[nbar.ts_init]
            if part == OPEN:
                if state.pending == 1:
                    self._enter(index, float(nbar.open))
                elif state.pending == -1:
                    self._exit("signal")
                state.pending = 0
            elif part == CLOSE:
                self._close(index, float(nbar.close))
                if index + 1 < size and state.pending != -1:
                    self._plan_target(index + 1)

        def _plan_target(self, index: int):
            """Lets the target rest during bar `index` only when that bar does not reach the stop.

            This reads the low of the coming bar. It applies the TS rule that a bar reaching the
            stop exits at the stop, also when it opens beyond the target; signals never read it.
            """
            position = state.position
            if position is None or math.isnan(position.target):
                return
            stop_hit = not math.isnan(position.stop) and bars.l[index] <= position.stop
            order = None if state.target_order is None else self.cache.order(state.target_order)
            live = order is not None and order.is_open
            if stop_hit and live:
                self.cancel_order(order)
                state.target_order = None
            elif not stop_hit and not live:
                order = self.order_factory.market_if_touched(
                    instrument_id, OrderSide.SELL, Quantity(position.qty, PRECISION),
                    Price(round(position.target, PRECISION), PRECISION), reduce_only=True, tags=["target"])
                state.target_order = order.client_order_id
                self.submit_order(order)

        def _levels(self, entry_price: float) -> tuple[float, float]:
            if compiled.stop_distance is None:
                stop = entry_price * stop_factor if stop_factor > 0 else math.nan
            else:
                stop = entry_price - state.pending_stop
            if compiled.target_distance is None:
                target = entry_price * target_factor if target_factor > 0 else math.nan
            else:
                target = entry_price + state.pending_target
            return stop, target

        def _spend_for(self, cash: float, open_price: float, stop: float) -> float:
            if options.risk_pct is None:
                return cash
            per_unit = open_price - stop
            if not per_unit > 0:
                return 0.0
            risk_units = cash * options.risk_pct / PERCENT / per_unit
            return min(cash, risk_units * open_price / (1 - cost))

        def _enter(self, index: int, open_price: float):
            if ((compiled.stop_distance is not None and math.isnan(state.pending_stop))
                    or (compiled.target_distance is not None and math.isnan(state.pending_target))):
                return
            cash = self._cash()
            if profile is None:
                stop, _ = self._levels(open_price)
                spent = self._spend_for(cash, open_price, stop)
                if spent <= 0:
                    return
                units = spent * (1 - cost) / open_price
            else:
                quote = fill_costs(profile, "buy", 0, open_price, atr_before(index))
                stop, _ = self._levels(quote.price)
                spent = self._spend_for(cash, quote.price, stop)
                units = affordable_units(profile, spent * (1 - cost), quote.price, capital)
                if not units > 0:
                    return
            qty = math.floor(units * capital * 10 ** PRECISION) / 10 ** PRECISION
            if qty <= 0:
                return
            order = self.order_factory.market(instrument_id, OrderSide.BUY, Quantity(qty, PRECISION))
            state.entries[order.client_order_id] = {"spent": spent, "index": index, "cash": cash, "units": units}
            self.submit_order(order)

        def _exit(self, reason: str):
            net = self._net()
            if net <= 0:
                return
            self.cancel_all_orders(instrument_id)
            state.exit_reason = reason
            self.submit_order(self.order_factory.market(instrument_id, OrderSide.SELL, Quantity(net, PRECISION),
                                                        reduce_only=True))

        def _close(self, index: int, close: float):
            position = state.position
            if index < size - 1:
                signal = compiled.signals[index]
                if signal == 1 and position is None:
                    state.pending = 1
                    state.pending_stop = _distance_at(compiled.stop_distance, index)
                    state.pending_target = _distance_at(compiled.target_distance, index)
                if position is not None and (
                        signal == -1
                        or (compiled.exits is not None and compiled.exits[index] == 1)
                        or (options.max_hold_bars is not None
                            and index - position.entry_index + 1 >= options.max_hold_bars)):
                    state.pending = -1
                    # Cancel the resting levels now, so the exit at the next open is a signal exit.
                    self.cancel_all_orders(instrument_id)
            if position is not None:
                state.bars_in_position += 1
            state.equity.append(self._cash() + self._net() * close / capital)
            if index == size - 1 and position is not None:
                self._exit("end")

        def on_order_filled(self, event):
            charges = state.charges.pop(event.client_order_id)
            qty = float(event.last_qty)
            if event.order_side == OrderSide.BUY:
                plan = state.entries.pop(event.client_order_id)
                units = qty / capital
                stop, target = self._levels(charges["price"])
                legs = None if profile is None else {
                    "bps": charges["bps"] / capital, "commission": charges["commission"] / capital,
                    "fees": charges["fees"] / capital, "slippage": charges["slippage"] / capital,
                    "spread": charges["spread"] / capital}
                state.position = _Open(entry_cash=plan["cash"], entry_index=plan["index"],
                                       entry_price=charges["price"], spent=plan["spent"], units=units, qty=qty,
                                       legs=legs, stop=stop, target=target)
                if not math.isnan(stop):
                    self.submit_order(self.order_factory.stop_market(
                        instrument_id, OrderSide.SELL, event.last_qty, Price(round(stop, PRECISION), PRECISION),
                        reduce_only=True, tags=["stop"]))
                self._plan_target(plan["index"])
                return
            self._record_exit(event, charges, qty)

        def _record_exit(self, event, charges, qty):
            position = state.position
            if position is None:
                raise RuntimeError("nautilus backtest: sell fill without an open position")
            order = self.cache.order(event.client_order_id)
            tags = order.tags or []
            reason = "stop" if "stop" in tags else "target" if "target" in tags else state.exit_reason
            self.cancel_all_orders(instrument_id)
            proceeds = (qty * charges["price"] * (1 - cost) - charges["commission"] - charges["fees"]) / capital
            cash = self._cash()
            trade = {
                "entryIndex": position.entry_index,
                "entryPrice": position.entry_price,
                "exitIndex": state.index,
                "exitPrice": charges["price"],
                "exitReason": reason,
                "netReturn": proceeds / position.spent - 1,
                "pnl": cash - position.entry_cash,
                "units": position.units,
            }
            if position.legs is not None:
                legs = {
                    "bps": position.legs["bps"] + charges["bps"] / capital,
                    "commission": position.legs["commission"] + charges["commission"] / capital,
                    "fees": position.legs["fees"] + charges["fees"] / capital,
                    "slippage": position.legs["slippage"] + charges["slippage"] / capital,
                    "spread": position.legs["spread"] + charges["spread"] / capital,
                }
                total = legs["commission"] + legs["fees"] + legs["spread"] + legs["slippage"] + legs["bps"]
                trade["costs"] = {**legs, "total": total}
                trade["grossPnl"] = trade["pnl"] + total
            state.trades.append(trade)
            state.position = None

    engine = nt["BacktestEngine"](nt["BacktestEngineConfig"](
        logging=nt["LoggingConfig"](log_level="ERROR", bypass_logging=True)))
    strategy = VertexStrategy(nt["StrategyConfig"](strategy_id="VERTEX-001"))
    try:
        engine.add_venue(venue, nt["OmsType"].NETTING, nt["AccountType"].CASH, [Money(capital, USD)],
                         base_currency=USD, modules=[BarClock(nt["SimulationModuleConfig"]())],
                         fee_model=VertexFees(), bar_execution=True, allow_cash_borrowing=True)
        engine.add_instrument(instrument)
        engine.add_data(feed)
        engine.add_strategy(strategy)
        engine.run()
        final_cash = float(engine.portfolio.account(venue).balance_total(USD)) / capital
        final_net = float(engine.portfolio.net_position(instrument_id))
    finally:
        engine.dispose()
    if len(state.equity) != size:
        raise RuntimeError(f"nautilus backtest marked {len(state.equity)} of {size} bars")
    if state.position is not None or final_net != 0:
        raise RuntimeError("nautilus backtest ended with an open position")
    equity = list(state.equity)
    equity[size - 1] = final_cash
    trades = tuple(state.trades)
    return RunResult(tuple(equity), trades, summarize(bars, equity, trades, state.bars_in_position),
                     capital=capital)


def run_spec(bars: Bars, spec: dict) -> RunResult:
    """Compiles a run spec (signals.plan_run) and runs it. `initialCapital` sets the capital without a cost profile."""
    compiled, options = plan_run(bars, spec)
    return run_signal_backtest(bars, compiled, options, capital=spec.get("initialCapital"))
