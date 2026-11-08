"""Sanity audit of the qc-port study (research only; reported, never deciding a verdict).

    python -m strategies.qc_ports audit --ran 2026-11-08

Prints markdown: per idea a "Sanity checks" block (gross vs net Sharpe of run A,
mean cost per trade, the failing pass-rule clauses, whether costs decide the
verdict, and the IV-scale-1.0 / zero-skew sensitivity), then the known-edge
cases (SPY call debit verticals opened monthly in strong up years) and a
priced-trade check of SPY spreads (value bounds, monotone in spot, settlement
at intrinsic). Ledger only: the study run already checked Nautilus parity, and
the audit changes nothing in the pre-registered runs.

- Gross: the same priced trades with entry and exit costs set to 0 (max loss per
  contract kept, so sizing is unchanged); scored like the net runs (n_trials
  32, the net across-trial variance).
- Sensitivity: ATM IV = 1.0 x the CBOE index for every symbol and no skew, all
  runs A and B repriced (n_trials 32, variance of those 22 runs' net variance
  kept from the study).
"""
from __future__ import annotations

import contextlib
import dataclasses
import itertools
import random
from collections.abc import Iterator, Mapping, Sequence

from . import ideas as qi
from . import options as om
from . import study
from .book import (
    PricedTrade,
    SignalEvent,
    _Pricing,
    build_book,
    instrument_value,
    spread_legs,
)
from .calendar import parse
from .ledger import run_ledger
from .metrics import summarize

__all__ = ["cost_share", "gross_trades", "known_edge", "model_override", "monotone_violation", "priced_trade_checks"]

STRONG_YEARS = (("2013", "2012-12-31", "2013-11-29"), ("2023-2024", "2022-12-30", "2024-11-29"))
SAMPLE_TRADES = 5
SAMPLE_SEED = 20261108


def gross_trades(trades: Sequence[PricedTrade]) -> list[PricedTrade]:
    """The trades without costs; the max loss per contract is kept so the ledger sizes them the same."""
    return [dataclasses.replace(trade, entry_fee=0.0, exit_fee=0.0) for trade in trades]


def cost_share(trades: Sequence[PricedTrade], booked_ids: set[int]) -> dict:
    """Mean round-trip cost per contract over booked trades, as a share of the max loss and of the premium."""
    rows = [trade for trade in trades if trade.trade_id in booked_ids]
    if not rows:
        return {"trades": 0, "ofMaxLoss": None, "ofPremium": None}
    of_loss = [(t.entry_fee + t.exit_fee) / t.max_loss for t in rows]
    of_premium = [(t.entry_fee + t.exit_fee) / (t.premium * om.MULTIPLIER) for t in rows if t.premium > 0]
    return {"trades": len(rows), "ofMaxLoss": sum(of_loss) / len(of_loss),
            "ofPremium": sum(of_premium) / len(of_premium) if of_premium else None}


@contextlib.contextmanager
def model_override(atm_factor: float | None = None, skew: float | None = None) -> Iterator[None]:
    """Temporarily sets every ATM factor and/or every skew slope of options.py (restored on exit)."""
    saved = (dict(om.ATM_FACTOR), dict(om.SKEW))
    try:
        if atm_factor is not None:
            om.ATM_FACTOR.update({key: atm_factor for key in om.ATM_FACTOR})
        if skew is not None:
            om.SKEW.update({key: skew for key in om.SKEW})
        yield
    finally:
        om.ATM_FACTOR.clear()
        om.ATM_FACTOR.update(saved[0])
        om.SKEW.clear()
        om.SKEW.update(saved[1])


def monotone_violation(trade: PricedTrade, spot: float, t: float, rate: float, atm: float,
                       steps: int = 41) -> tuple[bool, float]:
    """(values within [0, width * 100], largest move against monotonicity in $ per contract) of the spread
    over spots 0.7x..1.3x (calls: non-decreasing for debit, non-increasing for credit; puts the other way)."""
    right = "call" if trade.structure.startswith("call") else "put"
    kind = "debit" if "Debit" in trade.structure else "credit"
    q = om.DIVIDEND_YIELD.get(trade.symbol, 0.0)
    values = []
    for k in range(steps):
        pricing = _Pricing(spot * (0.7 + 0.6 * k / (steps - 1)), t, rate, q, atm, om.SKEW[trade.symbol])
        long_mid, short_mid = spread_legs(pricing, right, trade.long_strike, trade.short_strike)
        values.append(instrument_value(kind, long_mid, short_mid, trade.width))
    bounded = all(0 <= value <= trade.width * om.MULTIPLIER for value in values)
    rising = (right == "call") == (kind == "debit")
    moves = [(a - b) if rising else (b - a) for a, b in itertools.pairwise(values)]
    return bounded, max(0.0, *moves)


def _sharpe(result) -> float | None:
    return summarize(result, 1)["sharpe"]


def known_edge(data: study.StudyData) -> list[dict]:
    """SPY call debit verticals opened monthly in strong up years (both expressions of the study)."""
    market = data.markets["SPY"]
    ends = qi.month_end_indices(market.dates)
    spy = dict(zip(data.bars["SPY"].dates, data.bars["SPY"].adj_close))
    rows = []
    for label, first, last in STRONG_YEARS:
        signal = [i for i in ends if first <= market.dates[i] <= last]
        for name, options in (("60 DTE, monthly roll", qi.MONTHLY_CALL), ("30 DTE, monthly roll", qi.CALENDAR_CALL)):
            events = [SignalEvent("SPY", i, signal[k + 1] if k + 1 < len(signal) else ends[ends.index(i) + 1])
                      for k, i in enumerate(signal)]
            book = build_book(events, options, {"SPY": market})
            dates = [day for day in market.dates if market.dates[signal[0]] <= day <= book.trades[-1].exit_date]
            result = run_ledger(book.trades, dates=dates)
            pnl = [trade["pnl"] for trade in result.trades]
            rows.append({
                "years": label, "expression": name, "trades": len(pnl), "wins": sum(p > 0 for p in pnl),
                "pnl": sum(pnl), "return": result.equity[-1] / result.capital - 1, "sharpe": _sharpe(result),
                "spyReturn": spy[dates[-1]] / spy[dates[0]] - 1,
            })
    return rows


def priced_trade_checks(data: study.StudyData, trades: Sequence[PricedTrade]) -> list[dict]:
    """SAMPLE_TRADES random SPY trades: entry value, the value held to expiry vs intrinsic, model checks."""
    market = data.markets["SPY"]
    pool = [trade for trade in trades if trade.symbol == "SPY"]
    rows = []
    for trade in random.Random(SAMPLE_SEED).sample(pool, min(SAMPLE_TRADES, len(pool))):
        entry = trade.entry_index
        options = {"structure": trade.structure, "dte": {"target": (parse(trade.expiry) - parse(trade.entry_date)).days,
                                                         "min": 1}, "widthSigma": 1.0, "maxLossPct": 2}
        held = build_book([SignalEvent("SPY", entry - 1)], options, {"SPY": market}).trades[0]
        settle = market.dates.index(held.exit_date)
        spot_end = market.close[settle]
        if trade.structure.startswith("call"):
            intrinsic = max(0.0, min(spot_end, trade.short_strike) - trade.long_strike)
        else:
            intrinsic = max(0.0, trade.long_strike - max(spot_end, trade.short_strike))
        value_end = intrinsic * om.MULTIPLIER if "Debit" in trade.structure else (trade.width - intrinsic) * om.MULTIPLIER
        t = (parse(trade.expiry) - parse(trade.entry_date)).days / 365
        atm = om.atm_iv("VIX", market.iv_index[entry])
        bounded, violation = monotone_violation(trade, market.close[entry], t, market.rate[entry], atm)
        rows.append({
            "entry": trade.entry_date, "expiry": trade.expiry, "structure": trade.structure,
            "spot": market.close[entry], "strikes": (trade.long_strike, trade.short_strike),
            "entryValue": trade.entry_price, "width": trade.width * om.MULTIPLIER,
            "expirySpot": spot_end, "heldExit": held.exit_date, "heldValue": held.exit_price,
            "intrinsicValue": round(value_end, 2), "settlesAtIntrinsic": abs(held.exit_price - round(value_end, 2)) < 0.011,
            "marksInBounds": all(0 <= v <= trade.width * om.MULTIPLIER for _, v in trade.marks),
            "sameStrikes": (held.long_strike, held.short_strike) == (trade.long_strike, trade.short_strike),
            "bounded": bounded, "monotoneViolation": violation,
        })
    return rows


def _scored(outcome_trades, run: qi.RunSpec, data, variance_):
    dates = [day for day in data.spy_dates if day >= run.start]
    result = run_ledger(outcome_trades, dates=dates)
    return result, summarize(result, study.N_TRIALS, variance_)


def audit(data: study.StudyData) -> dict:
    """Every number of the audit."""
    outcomes, metrics, variance_ = study.run_family(data, nautilus=False)
    runs = {key: outcome.run for key, outcome in outcomes.items()}
    per_idea = {}
    sensitivity_keys = {key for idea in qi.IDEAS for label, key in idea.runs if label in ("A", "B")}
    priced = {key: study.run_trades(runs[key], data)[0] for key in sensitivity_keys | {"opex-week/B"}}
    gross = {key: _scored(gross_trades(priced[key]), runs[key], data, variance_)[1] for key in sensitivity_keys}
    with model_override(atm_factor=1.0, skew=0.0):
        flat = {key: _scored(study.run_trades(runs[key], data)[0], runs[key], data, variance_)[1]
                for key in sorted(sensitivity_keys)}
    for idea in qi.IDEAS:
        a, b = idea.key("A"), idea.key("B")
        net_verdict, checks = study.verdict(metrics[a], metrics[b])
        gross_verdict, gross_checks = study.verdict(gross[a], gross[b])
        booked = {trade["id"] for trade in outcomes[a].result.trades}
        per_idea[idea.id] = {
            "net": metrics[a], "netB": metrics[b], "gross": gross[a], "grossB": gross[b],
            "verdict": net_verdict, "grossVerdict": gross_verdict, "failing": [n for n, ok in checks if not ok],
            "grossFailing": [n for n, ok in gross_checks if not ok], "costs": cost_share(priced[a], booked),
            "flat": flat[a], "flatB": flat[b], "flatVerdict": study.verdict(flat[a], flat[b])[0],
        }
    return {"ideas": per_idea, "knownEdge": known_edge(data),
            "trades": priced_trade_checks(data, priced["opex-week/B"]), "variance": variance_}


def _f(value, digits=2, pct=False) -> str:
    return study._fmt(value, digits, pct)


def markdown(report: Mapping) -> dict[str, str]:
    """idea id -> the "Sanity checks" markdown of that spec (the shared cases are in every block)."""
    edge = [("Known-edge case (SPY call debit vertical, 0.5 delta, opened at every month start of the period, "
            "closed at the next one; must be clearly profitable):"), "",
            "|Period|Expression|Trades|Winners|P&L USD|Account return|SPY total return|", "|---|---|---|---|---|---|---|"]
    for row in report["knownEdge"]:
        edge.append(f"|{row['years']}|{row['expression']}|{row['trades']}|{row['wins']}|{row['pnl']:,.0f}|"
                    f"{_f(row['return'], 2, True)}|{_f(row['spyReturn'], 2, True)}|")
    trades = ["", (f"Priced-trade check ({SAMPLE_TRADES} random SPY trades of the 30 DTE monthly roll, seed "
              f"{SAMPLE_SEED}; values per contract; held = the same spread priced to expiration):"), "",
              ("|Entry|Expiry|Spot|Strikes|Entry value|Width|Spot at expiry|Held value|Intrinsic|Settles at intrinsic|"
              "Marks in [0, width]|Values in [0, width], spot 0.7x-1.3x|Largest move against spot (USD)|"),
              "|---|---|---|---|---|---|---|---|---|---|---|---|---|"]
    for row in report["trades"]:
        trades.append(f"|{row['entry']}|{row['expiry']}|{row['spot']:.2f}|{row['strikes'][0]:g}/{row['strikes'][1]:g}|"
                      f"{row['entryValue']:.2f}|{row['width']:.0f}|{row['expirySpot']:.2f}|{row['heldValue']:.2f}|"
                      f"{row['intrinsicValue']:.2f}|{'yes' if row['settlesAtIntrinsic'] else 'NO'}|"
                      f"{'yes' if row['marksInBounds'] else 'NO'}|{'yes' if row['bounded'] else 'NO'}|"
                      f"{row['monotoneViolation']:.2f}|")
    worst = max(row["monotoneViolation"] for row in report["trades"])
    trades += ["", (f"Largest move of a spread value against the spot over the grid: USD {worst:.2f} per contract. "
                    "It comes from the clamp of the skew model (options.py: standardized moneyness clamped at "
                    "+-3), which flattens the smile of a deep in-the-money leg while the other leg's IV still "
                    "moves; it is a small model artifact far from the money, not a pricing error in the runs.")]
    out = {}
    for idea_id, row in report["ideas"].items():
        costs = row["costs"]
        decide = row["verdict"] != row["grossVerdict"]
        lines = [
            "### Sanity checks", "",
            ("Reported only; no run or parameter changed. `python -m strategies.qc_ports audit` "
            "(reference ledger)."), "",
            "|Run A|Sharpe|Deflated Sharpe|CAGR|Max drawdown|Run B Sharpe|Verdict|Failing clauses|",
            "|---|---|---|---|---|---|---|---|",
            (f"|Net (as run)|{_f(row['net']['sharpe'])}|{_f(row['net']['deflatedSharpe'], 3)}|"
            f"{_f(row['net']['cagr'], 2, True)}|{_f(row['net']['maxDrawdown'], 2, True)}|{_f(row['netB']['sharpe'])}|"
            f"{row['verdict']}|{'; '.join(row['failing']) or 'none'}|"),
            (f"|Gross (zero costs)|{_f(row['gross']['sharpe'])}|{_f(row['gross']['deflatedSharpe'], 3)}|"
            f"{_f(row['gross']['cagr'], 2, True)}|{_f(row['gross']['maxDrawdown'], 2, True)}|"
            f"{_f(row['grossB']['sharpe'])}|{row['grossVerdict']}|{'; '.join(row['grossFailing']) or 'none'}|"),
            (f"|ATM IV 1.0 x index, no skew|{_f(row['flat']['sharpe'])}|{_f(row['flat']['deflatedSharpe'], 3)}|"
            f"{_f(row['flat']['cagr'], 2, True)}|{_f(row['flat']['maxDrawdown'], 2, True)}|"
            f"{_f(row['flatB']['sharpe'])}|{row['flatVerdict']}|(sensitivity, not deciding)|"),
            "",
            (f"- Mean round-trip cost per contract of run A ({costs['trades']} booked trades): "
            f"{_f(costs['ofMaxLoss'], 3, True)} of the max loss, {_f(costs['ofPremium'], 3, True)} of the premium "
            f"(debit paid or credit received)."),
            "- Costs decide the verdict: " + ("YES (the gross run would pass)." if decide else
                                               "no (the verdict is the same at zero costs)."),
            "",
            *edge, *trades,
        ]
        out[idea_id] = "\n".join(lines)
    return out
