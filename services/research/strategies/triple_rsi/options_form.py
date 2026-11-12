"""The Vertex options form of Triple RSI on the qc-ports option book (research only).

The form keeps the rule's stance: +1 from the entry signal bar until the bar before the exit signal bar (spec
classification 12). `qc_ports.forms.form_book` turns it into call debit verticals: a stance at bar i opens the
spread at the close of bar i+1, the spread closes at the close of the bar after the stance ends, and the owner
exit rule (`allocation.owner_exit`: a loser is cut 3 days before expiry) applies to every spread. Each spread risks
`maxLossPct` (2, the cap) of equity. Prices come from the qc-ports Black-Scholes model on the symbol's IV index
(`qc_ports.options`); there is no option chain history.

Variants (`FORMS`): the 30-day vertical (the form that decides), the 60-day monthly vertical, the owner exit rule
alone (`entry_only`: the RSI exit closes nothing), and "signal close": the stance one bar earlier, so the spread
opens at the close of the signal bar and closes at the close of the exit bar (the as-stated execution, a benchmark:
its stance at bar i reads the close of bar i+1, a deliberate exception to the qc_ports.forms rule that a stance never
reads a later bar; it trades at the close it computes the signal from, as the as-stated share rule does).

`book_options` books the priced trades in the qc-ports ledger and in NautilusTrader (`qc_ports.nautilus_runner`)
and refuses a relative equity gap above `qc_ports.portfolio.PARITY_REL_TOL`.
"""
from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass

from strategies.qc_ports import forms as fm
from strategies.qc_ports import portfolio as pf
from strategies.qc_ports.ideas import CALENDAR_CALL, MONTHLY_CALL
from strategies.qc_ports.ledger import LedgerResult, run_ledger
from strategies.qc_ports.nautilus_runner import run_nautilus

from .rules import STATED, Params, signal_bars, signal_trades

__all__ = ["CALL_30", "CALL_60", "FORMS", "OptionsVariant", "baseline_form", "book_options", "form_of", "priced",
           "run_days", "stance", "trade_rows"]

# Call debit vertical, 30 days to expiry (21 minimum), long leg 0.5 delta, 1 sigma wide, 2% of equity at risk.
CALL_30 = dict(CALENDAR_CALL)
CALL_60 = dict(MONTHLY_CALL)


@dataclass(frozen=True)
class OptionsVariant:
    key: str
    label: str
    structure: Mapping
    entry_only: bool = False
    signal_close: bool = False


FORMS = (
    OptionsVariant("call30", "Call debit vertical, 30 days, book rule (decides)", CALL_30),
    OptionsVariant("call60", "Call debit vertical, 60 days, book rule", CALL_60),
    OptionsVariant("call30-owner-exit", "Call debit vertical, 30 days, owner exit rule only", CALL_30, entry_only=True),
    OptionsVariant("call30-signal-close", "Call debit vertical, 30 days, at the signal close", CALL_30,
                   signal_close=True),
)


def stance(close: Sequence[float], params: Params = STATED, first: int = 0, *, signal_close: bool = False) -> list[int]:
    """+1 on the bars [entry, exit) of every round trip from bar `first`, else 0; one bar earlier with
    `signal_close`."""
    entries, exits = signal_bars(close, params)
    sides = [0] * len(close)
    for trade in signal_trades(entries, exits, first):
        end = len(close) if trade.exit is None else trade.exit
        for index in range(trade.entry, end):
            sides[index] = 1
    if signal_close:
        sides = [*sides[1:], 0]
    return sides


def form_of(symbol: str, variant: OptionsVariant, params: Params = STATED, first: int = 0) -> fm.Form:
    def rule(inputs: fm.Inputs) -> dict[str, list[int]]:
        return {name: stance(bars.close, params, first, signal_close=variant.signal_close)
                for name, bars in inputs.bars.items()}

    return fm.Form(key=f"triple-rsi-{variant.key}-{symbol.lower()}", slug="triple-rsi", name="Triple RSI",
                   sleeve="dip", symbols=(symbol,), rule=rule, baseline=f"always-on-{variant.key}-{symbol.lower()}",
                   keeps="Long while the rule is long; the share weight is replaced by 2% of equity at risk.",
                   structures={1: (dict(variant.structure),)}, entry_only=variant.entry_only)


def baseline_form(symbol: str, variant: OptionsVariant, delay: int = 0) -> fm.Form:
    """The always-on form of the same structure (check G7), started `delay` bars after the first IV value."""
    rule = fm.always_on if delay == 0 else fm.always_on_after(delay)
    return fm.Form(key=f"always-on-{variant.key}-{symbol.lower()}-{delay}", slug="always-on", name="Always on",
                   sleeve="baseline", symbols=(symbol,), rule=rule, baseline=None, keeps="Long every bar.",
                   structures={1: (dict(variant.structure),)}, entry_only=variant.entry_only)


def priced(form: fm.Form, dataset: pf.Dataset, symbol: str, start: str) -> fm.FormBook:
    market = pf.market_of(dataset, symbol)
    inputs = fm.Inputs({symbol: dataset.bars[symbol]}, {symbol: market.iv_index})
    return fm.form_book(form, inputs, {symbol: market}, start=start)


def run_days(dataset: pf.Dataset, symbol: str, start: str) -> list[str]:
    """The run days: the symbol's bar dates from `start` and from its first IV index value."""
    market = pf.market_of(dataset, symbol)
    first_iv = next((day for day, value in zip(market.dates, market.iv_index) if value is not None), "9999-12-31")
    return [day for day in market.dates if day >= max(start, first_iv)]


def book_options(trades, capital: float, dates: Sequence[str], *, nautilus: bool = True
                 ) -> tuple[LedgerResult, float | None, str]:
    """(ledger result, relative equity gap to NautilusTrader or None, engine name)."""
    ledger = run_ledger(trades, capital, dates=dates)
    if not nautilus:
        return ledger, None, ledger.engine
    other = run_nautilus(trades, capital, dates=dates)
    gap = max((abs(a - b) / max(abs(a), abs(b)) for a, b in zip(ledger.equity, other.equity, strict=True)),
              default=0.0)
    same = [(t["id"], t["contracts"]) for t in ledger.trades] == [(t["id"], t["contracts"]) for t in other.trades]
    if gap > pf.PARITY_REL_TOL or not same:
        raise RuntimeError(f"triple-rsi options: ledger and NautilusTrader disagree (gap {gap:.3g}, trades match {same})")
    return ledger, gap, other.engine


def trade_rows(result: LedgerResult) -> list[dict]:
    """The options trades with the keys of metrics.trade_stats: `return` = return on risk, `holdDays` in run days."""
    index = {day: number for number, day in enumerate(result.dates)}
    return [{**trade, "return": trade["returnOnRisk"], "holdDays": index[trade["exitDate"]] - index[trade["entryDate"]]}
            for trade in result.trades]
