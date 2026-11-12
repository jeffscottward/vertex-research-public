"""Run plan of the leveraged-ETF short-window study (research only; it never places orders).

The unit of a verdict is a FORM ROW = signal x regime x window x form (2 x 2 x 2 x 5 = 40 rows), all
pairs pooled into one book of 100,000 USD. Each row is also booked per pair in its own book of
100,000 USD (ledger only, for the reader, not for a verdict).

Steps (research/backtests/leveraged-etf/run.py runs them in a process pool):
1. `load_pair_signals`: per pair, the S1 and S2 signals from the first day every input of the pair
   exists (forms.first_day; a signal needs the previous close, so the first signal day is after it),
   and the direction the `calm` regime allows after each daily close.
2. `taken_signals`: per signal, regime and window, the signals to trade (signals.take).
3. `run_row`: prices the taken signals in one form and books them: the pooled book in the ledger and
   in NautilusTrader (parity or an error), and one ledger book per pair.
4. `metrics.row_stats` per booked result with n_trials = 40 and the variance of the per-day Sharpes of
   the 40 pooled rows; `metrics.verdicts`.
5. `document`: the results document (JSON-ready).
"""
from __future__ import annotations

import time
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import date, timedelta

from strategies.imom import data as idata

from . import forms, metrics, prices, signals
from .pairs import PAIRS, Pair, signed_leverage

__all__ = ["CAPITAL", "EQUITY_ROW", "N_TRIALS", "S2_FROM", "SCHEMA", "PairSignals", "document", "load_pair_signals",
           "row_keys", "row_start", "run_row", "session_days", "taken_signals", "tracking_errors"]

SCHEMA = "leveraged-etf-short-window-v1"
CAPITAL = 100_000.0
N_TRIALS = len(signals.SIGNALS) * len(signals.REGIMES) * len(signals.WINDOWS) * len(forms.FORM_KEYS)
# The Dukascopy 1-minute index bars start in 2018; the rule warms up on its own first candles.
S2_FROM = "2018-01-01"
# The row whose monthly equity curve the study document shows (fixed before the first run).
EQUITY_ROW = metrics.row_key(signals.S1, "all", "24h", "lev-option")


@dataclass(frozen=True)
class PairSignals:
    """The signals of one pair. `inputs_from` = forms.first_day; `start` = per signal the first day a
    signal can be used; `signals` = per signal and regime the signals after `inputs_from`; `dropped` =
    S2 rule entries on a day without a U session."""

    underlying: str
    inputs_from: str
    last_day: str
    start: Mapping[str, str]
    signals: Mapping[str, Mapping[str, tuple[signals.Signal, ...]]]
    dropped: int


def row_keys() -> list[str]:
    """The 40 form row keys in report order."""
    return [metrics.row_key(signal, regime, window, form) for signal in signals.SIGNALS for regime in signals.REGIMES
            for window in signals.WINDOWS for form in forms.FORM_KEYS]


def _next_day(day: str) -> str:
    return (date.fromisoformat(day) + timedelta(days=1)).isoformat()


def load_pair_signals(pair: Pair, data: forms.PairData, vix: Mapping[str, float], vix3m: Mapping[str, float], *,
                      ibkr_root=None, volspike_root=None) -> PairSignals:
    """Reads U's 5-minute IBKR bars and the 1-minute Dukascopy bars of the pair's index and builds the
    signals of the pair (see signals.py)."""
    from strategies.volspike import data as vdata
    from strategies.volspike import rules

    market = data.market
    first, last = forms.first_day(data), market.dates[-1]
    bars = idata.load_bars(pair.underlying, ibkr_root, source=idata.IBKR)
    index_bars = vdata.load_market(signals.source_market(pair.underlying), volspike_root)
    s2, dropped = signals.volume_spike_breakout(pair.underlying, index_bars.minutes, bars, rules.ny_ms(S2_FROM),
                                                rules.ny_ms(_next_day(last)))
    found = {signals.S1: signals.session_open_momentum(pair.underlying, bars), signals.S2: s2}
    allowed = signals.calm_days(market.dates, market.close, vix, vix3m)
    out: dict[str, dict[str, tuple[signals.Signal, ...]]] = {}
    for name, items in found.items():
        usable = [item for item in items if first < item.day <= last]
        out[name] = {regime: tuple(signals.in_regime(usable, regime, market.dates, allowed))
                     for regime in signals.REGIMES}
    start = {signals.S1: first, signals.S2: max(first, S2_FROM)}
    return PairSignals(pair.underlying, first, last, start, out, dropped)


def taken_signals(found: Mapping[str, PairSignals], signal: str, regime: str, window: str,
                  dates: Mapping[str, Sequence[str]]) -> tuple[list[signals.Signal], dict[str, int]]:
    """The signals of every pair that a row trades, in entry order, and the counts of signals.take."""
    pooled = [item for pair in found.values() for item in pair.signals[signal][regime]]
    return signals.take(pooled, window, dates)


def row_start(found: Mapping[str, PairSignals], signal: str) -> str:
    """The first day of a pooled book: the earliest start of the signal over the pairs."""
    return min(pair.start[signal] for pair in found.values())


def session_days(data: Mapping[str, forms.PairData], start: str) -> list[str]:
    """Every daily bar date of the pairs from `start` on (the calendar of a book)."""
    return sorted({day for item in data.values() for day in item.market.dates if day >= start})


def run_row(key: str, taken: Sequence[signals.Signal], data: Mapping[str, forms.PairData],
            starts: Mapping[str, str], capital: float = CAPITAL, *, nautilus: bool = True) -> dict:
    """Prices `taken` in the form of row `key` and books it: pooled (ledger, and NautilusTrader with
    parity when `nautilus`) and per pair (ledger). `starts` = first book day per underlying. The fund
    cost model must be registered (forms.fund_models)."""
    began = time.monotonic()
    _, _, window, form = metrics.split_key(key)
    trades, reasons = forms.price_trades(taken, window, form, data)
    days = session_days(data, min(starts.values()))
    pooled = forms.book(trades, days, capital, nautilus=nautilus and bool(trades))
    per_pair = {}
    for underlying, item in data.items():
        own = [trade for trade in trades if trade.signal.underlying == underlying]
        booked = forms.book(own, [day for day in item.market.dates if day >= starts[underlying]], capital,
                            nautilus=False)
        per_pair[underlying] = {"daily": booked["daily"], "returns": booked["returns"], "priced": len(own)}
    return {"key": key, "priced": len(trades), "notPriced": reasons, "daily": pooled["daily"],
            "returns": pooled["returns"], "gap": pooled["gap"], "engine": pooled["engine"], "perPair": per_pair,
            "staleDays": sum(trade.stale_days for trade in trades), "seconds": time.monotonic() - began}


def tracking_errors(data: Mapping[str, forms.PairData]) -> list[dict]:
    """Per fund: the error of the synthetic price formula at the close (prices.tracking_error)."""
    out = []
    for item in data.values():
        for fund in (item.long_fund, item.inverse_fund):
            row = prices.tracking_error(fund, signed_leverage(fund.symbol), item.market.dates, item.market.close,
                                        item.u_splits)
            if row is not None:
                out.append({"underlying": item.pair.underlying, **row})
    return out


def document(*, rows: Sequence[Mapping], found: Mapping[str, PairSignals], data: Mapping[str, forms.PairData],
             dropped_pairs: Sequence[Mapping], variance: float | None, engine: str, nautilus: bool, capital: float,
             gate: Mapping, lower_bar: Mapping, iv_ratio: Mapping | None, provenance: Mapping,
             wall_seconds: float) -> dict:
    """The results document. `rows`: per form row a mapping with key, signals, taken, skipped, priced,
    notPriced, stats, verdict, nautilusGap, monthly and perPair."""
    pairs_out = []
    for pair in PAIRS:
        if pair.underlying not in found:
            continue
        item = found[pair.underlying]
        pairs_out.append({
            "underlying": pair.underlying, "longFund": pair.long_fund, "inverseFund": pair.inverse_fund,
            "leverage": pair.leverage, "ivIndex": pair.iv_index, "inputsFrom": item.inputs_from, "lastDay": item.last_day,
            "start": dict(item.start), "s2SignalsWithoutSession": item.dropped,
            "signals": {name: {regime: len(found_) for regime, found_ in regimes.items()}
                        for name, regimes in item.signals.items()},
            "firstSignal": {name: (regimes["all"][0].day if regimes["all"] else None)
                            for name, regimes in item.signals.items()}})
    keys = [row["key"] for row in rows]
    return {
        "schema": SCHEMA, "generatedFor": max(item.last_day for item in found.values()),
        "complete": sorted(keys) == sorted(row_keys()) and not dropped_pairs, "capital": capital,
        "engine": engine, "nautilusParity": nautilus, "parityTolerance": forms.PARITY_REL_TOL,
        "gate": dict(gate), "lowerBar": dict(lower_bar),
        "trials": {"count": N_TRIALS, "dailySharpeVariance": variance, "rowsInVariance": len(keys)},
        "pairs": pairs_out, "droppedPairs": list(dropped_pairs), "trackingError": tracking_errors(data),
        "ivRatio": iv_ratio, "equityRow": EQUITY_ROW, "rows": list(rows),
        "passGate": [row["key"] for row in rows if row["verdict"]["passes"]],
        "passLowerBar": [row["key"] for row in rows if row["verdict"]["lowerBar"]["pass"]],
        "leverageHelps": [row["key"] for row in rows
                          if row["verdict"]["leverageHelps"] and row["verdict"]["leverageHelps"]["helps"]],
        "provenance": dict(provenance), "wallSeconds": wall_seconds,
    }
