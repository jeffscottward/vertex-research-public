"""QuantConnect idea ports: defined-risk option verticals on daily signals (research only).

data (public CSVs) -> book (signal events + DSL `options` block -> priced
spreads with daily marks) -> ledger (pure-Python reference) or nautilus_runner
(NautilusTrader, parity with the ledger) -> metrics. Model assumptions are in
options.py and book.py. ideas.py holds the 11 pre-registered ports as DSL
definitions and runs, study.py runs them (one study document per idea) and
audit.py prints the sanity checks. No orders leave the process.
"""
from . import book, calendar, data, ledger, metrics, options

__all__ = ["book", "calendar", "data", "ledger", "metrics", "options"]
