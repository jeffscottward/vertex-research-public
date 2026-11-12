"""Triple RSI (QuantifiedStrategies): rules, booking, options form and study (research only).

Spec: docs/specs/strategies/triple-rsi.md. Nothing here places, routes or simulates broker orders;
NautilusTrader runs in-process backtests only.

Modules:
- rules: the RSI variants, the entry and exit bars of the rule and the trades of one execution mode.
- shares: the share ledger (100% of equity, costs per side) and its NautilusTrader booking.
- dsl: the rule as a Vertex strategy DSL definition (version 1).
- options_form: the Vertex options form on the qc-ports option book.
- metrics: trade and equity measures, walk-forward, Monte Carlo, deflated Sharpe and the gates.
- study: the run plan of the study and its document (research_studies kind "strategy-backtest").
- report: the dark HTML report.
"""
