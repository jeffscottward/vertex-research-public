"""Plumbing check for the NautilusTrader 1.227.0 backtest engine on the rig.

Runs the bundled EMACross example on 1,000 synthetic daily bars for one equity.
This only proves that the engine, venue, fill and portfolio code run. The P&L has no meaning.
"""
from decimal import Decimal
import random

import pandas as pd

from nautilus_trader.backtest.engine import BacktestEngine, BacktestEngineConfig
from nautilus_trader.examples.strategies.ema_cross import EMACross, EMACrossConfig
from nautilus_trader.model.currencies import USD
from nautilus_trader.model.data import Bar, BarType
from nautilus_trader.model.enums import AccountType, OmsType
from nautilus_trader.model.identifiers import Venue
from nautilus_trader.model.objects import Money, Price, Quantity
from nautilus_trader.test_kit.providers import TestInstrumentProvider

venue = Venue("XNAS")
inst = TestInstrumentProvider.equity("AAPL", "XNAS")
engine = BacktestEngine(BacktestEngineConfig())
engine.add_venue(venue=venue, oms_type=OmsType.NETTING, account_type=AccountType.CASH,
                 base_currency=USD, starting_balances=[Money(1_000_000, USD)])
engine.add_instrument(inst)

bar_type = BarType.from_str(f"{inst.id}-1-DAY-LAST-EXTERNAL")
rng = random.Random(7)
px = 100.0
bars = []
for ts in pd.bdate_range("2020-01-01", periods=1000, tz="UTC"):
    o = px
    px = max(1.0, px * (1 + rng.gauss(0.0003, 0.015)))
    hi, lo = max(o, px) * 1.004, min(o, px) * 0.996
    t = ts.value + 20 * 3600 * 10**9
    bars.append(Bar(bar_type, Price(o, 2), Price(hi, 2), Price(lo, 2), Price(px, 2),
                    Quantity.from_int(1_000_000), t, t))
engine.add_data(bars)
engine.add_strategy(EMACross(EMACrossConfig(instrument_id=inst.id, bar_type=bar_type,
                                            trade_size=Decimal(100), fast_ema_period=10,
                                            slow_ema_period=40)))
engine.run()
fills = engine.trader.generate_order_fills_report()
positions = engine.trader.generate_positions_report()
print(f"bars={len(bars)} fills={len(fills)} positions={len(positions)}")
print(engine.trader.generate_account_report(venue).tail(1).to_string())
engine.dispose()
