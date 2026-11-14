"""Options forms of the five QuantJourney strategies that trade intraday bars (research only).

Upstream (`~/Github/tools/quantjourney-bt/strategies/`, read on 2026-11-12 at commit 4f403d85):

| Key | File | Bars | Rule |
| --- | --- | --- | --- |
| qj/O15 | example_orders_15_intraday_5m_bracket_reversion.py | 5 minutes | Flat and RSI(14) below 30: buy at market with a bracket, take profit at 1.006 and stop at 0.996 times the close of the signal bar |
| qj/O16 | example_orders_16_intraday_30m_stop_breakout.py | 30 minutes | Flat: buy stop at 1.001 times the highest high of the 12 bars before, valid 3 bars, a new one on every flat bar; sell at market on the 8th bar after the bar of the last stop order |
| qj/W07 | example_weights_07_intraday_rsi_15m.py | 15 minutes | Long from RSI(14) below 35 until RSI(14) above 55 |
| qj/W08 | example_weights_08_intraday_1m_ema_scalp.py | 1 minute | Long while EMA(9) is above EMA(21) |
| qj/W09 | example_weights_09_intraday_1h_sma_trend.py | 1 hour | Long while SMA(10) is above SMA(30) |

All five trade SPY, QQQ and IWM upstream and keep a position over night (no rule closes at the end
of a session). The form keeps the stance: +1 while the rule holds shares, 0 while it is flat. The
option book then holds the monthly call spread of the daily forms (forms.LONG_SHORT), opened at the
close of the bar after the stance starts and closed at the close of the bar after it ends
(forms.py), on bars of the rule's own length (intraday.py).

The two order strategies run in the order machine of forms_orders.py (`SPECS`), with the fills of
the upstream engine: a market order fills at the next open, the bracket orders rest from the bar
after the entry fill, and a bar that reaches the stop and the take profit fills the stop. The three
weights strategies trade on every signal change, so their stance is the signal of the bar.

What the form does not keep: order sizes and weights (also the 25% and 34% caps), slippage and
commission of the shares, and for W08 two of the three symbols: the data set has 1-minute bars of
SPY only (`ONE_MINUTE`).

Every form has a `source`: the minute bars its bars are made from. The always-on baselines
(`BASELINES`) hold the same symbols on the same days on hourly bars. An always-on spread does not
depend on the bar length: the next one opens when the last one closed.
"""
from __future__ import annotations

from collections.abc import Callable, Sequence
from dataclasses import dataclass

from .data import Bars
from .forms import Form, Inputs, always_on, ema, rsi, sma
from .forms_orders import MARKET, STOP, Spec, run

__all__ = ["BASELINES", "ETF3", "FIVE_MINUTE", "FORMS", "ONE_MINUTE", "SOURCE_MINUTES", "SOURCE_SYMBOLS", "SPECS",
           "IntradayForm", "ema_trend", "rsi_band", "sma_trend", "study_forms"]

ETF3 = ("SPY", "QQQ", "IWM")
# The minute bars of the data set: 5-minute bars of the three ETFs, and 1-minute bars of SPY.
FIVE_MINUTE, ONE_MINUTE = "5m", "1m"
SOURCE_MINUTES = {FIVE_MINUTE: 5, ONE_MINUTE: 1}
SOURCE_SYMBOLS = {FIVE_MINUTE: ETF3, ONE_MINUTE: ("SPY",)}
HOUR = 60

SPECS: dict[str, Spec] = {
    "qj/O15": Spec("rsi", MARKET, ("enter", "bracket"), level=30, bracket=(1.006, 0.996)),
    "qj/O16": Spec("breakout", STOP, ("time_exit", "enter"), stop_pct=1.001, valid=3, hold=8, lookback=12, high=True,
                   first_bar=12, stack=True, hold_from="order"),
}


@dataclass(frozen=True)
class IntradayForm:
    """A form on intraday bars. `minutes`: the length of the bars its rule reads and the option book
    prices. `source`: the minute bars they are made from (`SOURCE_MINUTES`)."""

    form: Form
    minutes: int
    source: str


Stance = dict[str, list[int]]


def _orders(key: str) -> Callable[[Inputs], Stance]:
    def rule(inputs: Inputs) -> Stance:
        return {symbol: run(bars, SPECS[key]) for symbol, bars in inputs.bars.items()}

    return rule


def _per_symbol(sides: Callable[[Bars], list[int]]) -> Callable[[Inputs], Stance]:
    def rule(inputs: Inputs) -> Stance:
        return {symbol: sides(bars) for symbol, bars in inputs.bars.items()}

    return rule


def rsi_band(bars: Bars, *, length: int = 14, below: float = 35, above: float = 55) -> list[int]:
    """W07: long from an RSI below `below` until an RSI above `above`; flat while the RSI has no value."""
    held = False
    out = []
    for value in rsi(bars.close, length):
        if value is None:
            held = False
        elif not held and value < below:
            held = True
        elif held and value > above:
            held = False
        out.append(int(held))
    return out


def _above(fast: Sequence[float | None], slow: Sequence[float | None]) -> list[int]:
    return [int(quick is not None and base is not None and quick > base) for quick, base in zip(fast, slow)]


def ema_trend(bars: Bars, *, fast: int = 9, slow: int = 21) -> list[int]:
    """W08: long while EMA `fast` of the close is above EMA `slow`; flat until both have a value."""
    return _above(ema(bars.close, fast), ema(bars.close, slow))


def sma_trend(bars: Bars, *, fast: int = 10, slow: int = 30) -> list[int]:
    """W09: long while SMA `fast` of the close is above SMA `slow`; flat until both have a value."""
    return _above(sma(bars.close, fast), sma(bars.close, slow))


BASE_ETF3, BASE_SPY = "base/intraday3", "base/intraday-spy"
DROPS = "Drops the size, the costs of the shares and their fill inside the bar: the spread trades one bar later."


def _qj(code: str, slug: str, name: str, sleeve: str, minutes: int, rule: Callable[[Inputs], Stance], keeps: str,
        source: str = FIVE_MINUTE) -> IntradayForm:
    baseline = BASE_ETF3 if source == FIVE_MINUTE else BASE_SPY
    return IntradayForm(Form(f"qj/{code}", f"quantjourney-{slug}", f"QuantJourney {code}: {name}", sleeve,
                             SOURCE_SYMBOLS[source], rule, baseline, f"{keeps} {DROPS}"), minutes, source)


FORMS: tuple[IntradayForm, ...] = (
    _qj("O15", "o15-intraday-5m-bracket-reversion", "Intraday 5m Bracket Reversion", "mean reversion", 5,
        _orders("qj/O15"),
        "Keeps the entry on 5-minute bars (RSI(14) below 30) and the bracket exit at +0.6% and -0.4% of the "
        "signal close."),
    _qj("O16", "o16-intraday-30m-stop-breakout", "Intraday 30m Stop Breakout", "trend", 30, _orders("qj/O16"),
        "Keeps the buy stop 0.1% over the highest high of the 12 bars before (30-minute bars, valid 3 bars) and "
        "the market exit on the 8th bar."),
    _qj("W07", "w07-intraday-rsi-15m", "Intraday RSI 15m", "mean reversion", 15, _per_symbol(rsi_band),
        "Keeps the signal of each 15-minute bar: long from RSI(14) below 35 until RSI(14) above 55."),
    _qj("W08", "w08-intraday-1m-ema-scalp", "Intraday EMA Scalp 1m", "trend", 1, _per_symbol(ema_trend),
        "Keeps the signal of each 1-minute bar on SPY: long while EMA(9) is above EMA(21). Drops QQQ and IWM "
        "(no 1-minute bars in the data set).", ONE_MINUTE),
    _qj("W09", "w09-intraday-1h-sma-trend", "Intraday SMA Trend 1h", "trend", HOUR, _per_symbol(sma_trend),
        "Keeps the signal of each hourly bar: long while SMA(10) is above SMA(30)."),
)


def _baseline(key: str, source: str) -> IntradayForm:
    symbols = SOURCE_SYMBOLS[source]
    return IntradayForm(Form(key, key, f"Always on ({len(symbols)} symbols, hourly bars)", "baseline", symbols,
                             always_on, None, "Holds the call spread on every symbol at all times."), HOUR, source)


BASELINES: tuple[IntradayForm, ...] = (_baseline(BASE_ETF3, FIVE_MINUTE), _baseline(BASE_SPY, ONE_MINUTE))


def study_forms() -> tuple[IntradayForm, ...]:
    """Every form the intraday study runs: the baselines, then the five strategy forms. A form and its
    baseline have the same symbols and the same source, so they trade the same days."""
    by_key = {item.form.key: item for item in BASELINES}
    for item in FORMS:
        baseline = by_key.get(item.form.baseline)
        if baseline is None:
            raise ValueError(f"{item.form.key}: no baseline {item.form.baseline}")
        if (baseline.form.symbols, baseline.source) != (item.form.symbols, item.source):
            raise ValueError(f"{item.form.key}: its symbols or its source are not those of {item.form.baseline}")
        if item.minutes % SOURCE_MINUTES[item.source]:
            raise ValueError(f"{item.form.key}: {item.minutes}-minute bars cannot be made from {item.source} bars")
    return (*BASELINES, *FORMS)
