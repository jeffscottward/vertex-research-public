"""Stopping-premium backtests of our exit rules (Kaminski and Lo 2014, tests A-H). Research only.

The plan is the "Backtest plan" of the report `stoploss-kaminski-lo` (card stoploss-stopping-premium-backtests).
Every test runs the same entries with the exit rule and without it and reports the stopping premium after
costs (`premium.py`). Nothing here reads an account, places an order or changes a live rule.
"""
