"""Academy modelled options backtest on NautilusTrader (research only; switch plan step 6).

model.py: options math and the 19 structures (port of packages/academy/src). simulator.py: the
backtest rules and the float-ledger run. engine.py: the same rules with NautilusTrader as the
ledger (OptionContract instruments fed with the modelled Black-Scholes quotes).
"""
