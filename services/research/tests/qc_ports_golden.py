"""Golden fixture of the qc-ports options runner for the TypeScript port (research only).

Builds synthetic markets (no files, no network), prices signal events for each of the four
vertical structures with book.build_book, runs ledger.run_ledger and metrics.summarize, and
writes the inputs and outputs to tests/fixtures/qc_ports/options_golden.json. The TypeScript
port (packages/api/src/options-engine) replays the inputs and must reproduce the outputs;
tests/test_qc_ports_golden.py fails when this file and the fixture drift apart.

Coverage of the fixture: SPY, QQQ, IWM, GLD (positive skew, missing bars including a 3rd
Friday), SLV (spot below $25, half-dollar strikes) and USO (IV index gaps); exits by expiry,
stale-iv, exitDte, profitTake, signal and end of data; skips "no bar to enter and exit",
"no IV", "no rate", "exitDte at entry", "no strikes", "no premium" and ledger "size"; ledgers on
the run days and on the mark days, at two capitals; summaries with 1 and 32 trials, with and
without a trial variance.

Regenerate (then format the JSON with biome, as the other fixtures):
    cd services/research && python -m tests.qc_ports_golden
    bunx --bun --no-install biome format --write services/research/tests/fixtures/qc_ports/options_golden.json
"""
from __future__ import annotations

import json
import random
from dataclasses import asdict
from datetime import date, timedelta
from pathlib import Path

from strategies.qc_ports.book import PricedTrade, build_book
from strategies.qc_ports.calendar import is_nyse_holiday
from strategies.qc_ports.data import Market
from strategies.qc_ports.ledger import LedgerResult, run_ledger
from strategies.qc_ports.metrics import summarize

__all__ = ["FIXTURE", "PORTFOLIO_DEFINITIONS", "PORTFOLIO_FIXTURE", "build", "main", "portfolio_build", "store_rows"]

FIXTURE = Path(__file__).resolve().parents[1] / "tests" / "fixtures" / "qc_ports" / "options_golden.json"
START = "2023-11-01"
BARS = 290
# (capital, run days): "run" = every bar date of the market set, "marks" = the trades' mark dates only.
LEDGERS = ((100_000.0, "run"), (100_000.0, "marks"), (3_000.0, "run"))
TRIAL_VARIANCE = 0.0004
# symbol: (first close, daily vol, IV index start, IV index floor)
SYMBOLS = {
    "SPY": (450.0, 0.010, 16.0, 11.0),
    "QQQ": (380.0, 0.013, 21.0, 14.0),
    "IWM": (190.0, 0.015, 24.0, 16.0),
    "GLD": (185.0, 0.008, 15.0, 10.0),
    "SLV": (22.0, 0.018, 30.0, 20.0),
    "USO": (70.0, 0.020, 38.0, 25.0),
}


def trading_days(start: str, count: int) -> list[str]:
    day = date.fromisoformat(start)
    out: list[str] = []
    while len(out) < count:
        if day.weekday() < 5 and not is_nyse_holiday(day):
            out.append(day.isoformat())
        day += timedelta(days=1)
    return out


def _walk(rng: random.Random, start: float, vol: float, count: int) -> list[float]:
    values, value = [], start
    for _ in range(count):
        values.append(round(value, 2))
        value *= 1 + rng.gauss(0.0003, vol)
    return values


def _iv_walk(rng: random.Random, start: float, floor: float, count: int) -> list[float]:
    values, value = [], start
    for _ in range(count):
        values.append(round(value, 2))
        value = max(floor, value + rng.gauss(0, 0.6) + 0.05 * (start - value))
    return values


def _market(symbol: str, dates: list[str], close: list[float], iv: list[float | None],
            rate: list[float | None]) -> Market:
    return Market(symbol, tuple(dates), tuple(close), tuple(iv), tuple(rate))


def main_markets() -> dict[str, Market]:
    """Six symbols over the same 290 trading days (GLD with bars missing), with IV and rate gaps."""
    rng = random.Random(20241108)
    days = trading_days(START, BARS)
    rates = [round(0.0525 - 0.00001 * index, 6) for index in range(BARS)]
    markets = {}
    for symbol, (first, vol, iv_start, iv_floor) in SYMBOLS.items():
        close = _walk(rng, first, vol, BARS)
        iv: list[float | None] = list(_iv_walk(rng, iv_start, iv_floor, BARS))
        rate: list[float | None] = list(rates)
        dates = list(days)
        if symbol == "SPY":
            rate[40] = rate[41] = None  # rate carried while a trade is open (stale_days)
            rate[100] = None  # entry bar without a rate
        if symbol == "IWM":
            iv[60] = None  # entry bar without an IV
            iv[130] = None  # open trades close with "stale-iv"
        if symbol == "USO":
            for index in (25, 26, 27, 150, 151, 220):
                iv[index] = None
        if symbol == "GLD":
            # Every 9th bar and the 3rd Friday of January 2024 missing: last marks carry and the
            # January expiry moves to the Thursday.
            keep = [index for index, day in enumerate(dates) if index % 9 != 4 and day != "2024-01-19"]
            dates, close = [dates[i] for i in keep], [close[i] for i in keep]
            iv, rate = [iv[i] for i in keep], [rate[i] for i in keep]
        markets[symbol] = _market(symbol, dates, close, iv, rate)
    return markets


def edge_markets() -> dict[str, Market]:
    """A $3 USO at a 150 IV index (put credit far leg below 0) and a $0.30 GLD at a 5 IV index."""
    days = trading_days(START, 60)
    return {
        "USO": _market("USO", days, [3.0 + 0.01 * (i % 5) for i in range(60)], [150.0] * 60, [0.04] * 60),
        "GLD": _market("GLD", days, [0.3] * 60, [5.0] * 60, [0.04] * 60),
    }


def _events(markets: dict[str, Market], step: int, hold: int, offset: int) -> list[tuple[str, int, int | None]]:
    """Every `step` bars per symbol: alternately an exit signal `hold` bars later and no exit signal."""
    events: list[tuple[str, int, int | None]] = []
    for number, (symbol, market) in enumerate(markets.items()):
        last = len(market) - 1
        for count, entry in enumerate(range(offset + number, last - 1, step)):
            exit_index = entry + hold if count % 2 == 0 and entry + hold <= last else None
            events.append((symbol, entry, exit_index))
        events.append((symbol, last - 2, None))  # enters on the last-but-one bar, exits at the end
        events.append((symbol, last - 1, None))  # no bar to enter and exit
    events += [("SPY", 99, None), ("IWM", 59, 70), ("IWM", 125, None), ("USO", 20, None), ("USO", 145, 160)]
    return events


CASES = [
    ("call-debit-profit-take", "main", {"structure": "callDebitVertical", "dte": {"target": 30, "min": 20},
                                        "widthSigma": 0.5, "maxLossPct": 2, "profitTakePct": 50}, (31, 9, 0)),
    ("put-debit-exit-dte", "main", {"structure": "putDebitVertical", "dte": {"target": 14, "min": 7},
                                    "widthSigma": 1.0, "maxLossPct": 1.5, "longDelta": 0.4, "exitDte": 10},
     (23, 6, 3)),
    ("put-credit-profit-take", "main", {"structure": "putCreditVertical", "dte": {"target": 45, "min": 21},
                                        "widthSigma": 0.75, "maxLossPct": 2, "shortDelta": 0.2,
                                        "profitTakePct": 60}, (29, 12, 5)),
    ("call-credit-hold", "main", {"structure": "callCreditVertical", "dte": {"target": 60, "min": 40},
                                  "widthSigma": 0.3, "maxLossPct": 1, "shortDelta": 0.3}, (37, 30, 7)),
    ("put-credit-no-strikes", "edge", {"structure": "putCreditVertical", "dte": {"target": 365, "min": 300},
                                       "widthSigma": 3, "maxLossPct": 2}, None),
    ("call-credit-no-premium", "edge", {"structure": "callCreditVertical", "dte": {"target": 30, "min": 20},
                                        "widthSigma": 0.5, "maxLossPct": 2}, None),
]


def _trade(trade: PricedTrade) -> dict:
    out = {_camel(key): value for key, value in asdict(trade).items()}
    out["marks"] = [list(mark) for mark in trade.marks]
    # Calendar-only field (book.CALENDARS); the DSL and the TypeScript port price verticals only.
    if out["farExpiry"] is None:
        del out["farExpiry"]
    return out


def _camel(name: str) -> str:
    head, *rest = name.split("_")
    return head + "".join(part.title() for part in rest)


def _ledger(result: LedgerResult) -> dict:
    """The ledger result without its dates (the run days or the mark days, rebuilt by the reader)."""
    return {"days": len(result.dates), "equity": list(result.equity), "openPositions": list(result.open_positions),
            "trades": list(result.trades), "skipped": list(result.skipped), "capital": result.capital,
            "engine": result.engine}


def _market_json(market: Market) -> dict:
    return {"symbol": market.symbol, "dates": list(market.dates), "close": list(market.close),
            "ivIndex": list(market.iv_index), "rate": list(market.rate)}


def build() -> dict:
    market_sets = {"main": main_markets(), "edge": edge_markets()}
    run_days = {name: sorted({day for market in markets.values() for day in market.dates})
                for name, markets in market_sets.items()}
    cases = []
    for name, set_name, options, schedule in CASES:
        markets = market_sets[set_name]
        events = _events(markets, *schedule) if schedule else [(symbol, 0, None) for symbol in markets]
        book = build_book(events, options, markets)
        ledgers = []
        for capital, dates in LEDGERS:
            if dates == "marks" and not book.trades:
                continue
            result = run_ledger(book.trades, capital, run_days[set_name] if dates == "run" else None)
            summaries = [{"nTrials": n_trials, "trialVariance": variance, "stats": summarize(result, n_trials, variance)}
                         for n_trials, variance in ((1, None), (32, None), (32, TRIAL_VARIANCE))]
            ledgers.append({"capital": capital, "dates": dates, "result": _ledger(result), "summaries": summaries})
        cases.append({
            "name": name, "marketSet": set_name, "options": options, "events": [list(event) for event in events],
            "book": {"trades": [_trade(trade) for trade in book.trades],
                     "skipped": [{"symbol": skip.event.symbol, "entryIndex": skip.event.entry_index,
                                  "exitIndex": skip.event.exit_index, "reason": skip.reason} for skip in book.skipped]},
            "ledgers": ledgers,
        })
    return {
        "about": "qc-ports options runner golden fixture; regenerate with python -m tests.qc_ports_golden",
        "marketSets": {name: {symbol: _market_json(market) for symbol, market in markets.items()}
                       for name, markets in market_sets.items()},
        "runDays": run_days,
        "cases": cases,
    }


# --------------------------------------------------------------------------- whole definitions

PORTFOLIO_DEFINITIONS = FIXTURE.with_name("portfolio_definitions.json")
PORTFOLIO_FIXTURE = FIXTURE.with_name("portfolio_golden.json")
STORE_START = "2019-07-01"
STORE_BARS = 840
# ETF: (first close, daily vol, yearly dividend yield, IV index, IV start, IV floor, future id)
STORE_ETFS = {
    "SPY": (300.0, 0.011, 0.015, "VIX", 15.0, 10.0, "ES=F"),
    "QQQ": (190.0, 0.014, 0.006, "VXN", 20.0, 13.0, "NQ=F"),
    "DIA": (270.0, 0.010, 0.018, "VXD", 15.0, 10.0, "YM=F"),
    "IWM": (155.0, 0.015, 0.012, "RVX", 22.0, 15.0, "RTY=F"),
    "GLD": (135.0, 0.009, 0.0, "GVZ", 14.0, 10.0, "GC=F"),
    "SLV": (14.5, 0.018, 0.0, "VXSLV", 28.0, 18.0, "SI=F"),
    "USO": (12.0, 0.022, 0.0, "OVX", 35.0, 22.0, "CL=F"),
}


def store_rows() -> dict:
    """Synthetic series-store rows (id -> dates and columns) over 840 trading days from 2019-07-01.

    Edge cases: GLD misses every 13th bar (marks carry on the SPY calendar); QQQ has null closes and
    DIA a null open (those bars drop); the SLV IV index starts in March 2020 (the member joins
    late) and the USO IV index has gaps longer than the 5-bar carry (stale-iv); one IRX gap.
    """
    rng = random.Random(20241109)
    days = trading_days(STORE_START, STORE_BARS)
    rows: dict[str, dict] = {}
    for symbol, (first, vol, dividend, iv_id, iv_start, iv_floor, future_id) in STORE_ETFS.items():
        close = _walk(rng, first, vol, STORE_BARS)
        growth = [round((1 + dividend / 252) ** index, 6) for index in range(STORE_BARS)]
        adj = [round(value * factor, 2) for value, factor in zip(close, growth)]
        dates = list(days)
        # open = high = low = close keeps the fixture small (the definitions read closes only).
        columns = {"open": list(close), "high": list(close), "low": list(close), "close": list(close), "adjClose": adj}
        if symbol == "GLD":
            keep = [index for index in range(STORE_BARS) if index % 13 != 6]
            dates = [days[i] for i in keep]
            columns = {key: [values[i] for i in keep] for key, values in columns.items()}
        if symbol == "QQQ":
            for index in (300, 301, 702):
                columns["close"][index] = None
        if symbol == "DIA":
            columns["open"][450] = None
        rows[symbol] = {"dates": dates, **columns}
        basis = [round(value * (1 + rng.gauss(0, 0.002)) * (1.001 - 0.0000005 * index), 2)
                 for index, value in enumerate(close)]
        rows[future_id] = {"dates": list(days), "close": basis}
        iv = _iv_walk(rng, iv_start, iv_floor, STORE_BARS)
        iv_dates = list(days)
        if symbol == "SLV":
            iv_dates, iv = iv_dates[170:], iv[170:]
            iv_dates, iv = iv_dates[:300] + iv_dates[308:], iv[:300] + iv[308:]
        if symbol == "USO":
            gaps = set(range(400, 409)) | set(range(700, 707))
            iv_dates = [day for index, day in enumerate(days) if index not in gaps]
            iv = [value for index, value in enumerate(iv) if index not in gaps]
        rows[iv_id] = {"dates": iv_dates, "close": iv}
    vix = rows["VIX"]["close"]
    rows["VIX3M"] = {"dates": list(days), "close": [round(value * (1.08 + rng.gauss(0, 0.05)), 2) for value in vix]}
    irx = [round(max(0.05, 1.8 + 1.2 * ((index / 300) % 3 - 1) + rng.gauss(0, 0.05)), 3) for index in range(STORE_BARS)]
    rows["IRX"] = {"dates": days[:500] + days[507:], "close": irx[:500] + irx[507:]}
    tnx = [round(2.0 + 0.8 * ((index / 400) % 2 - 0.5) + rng.gauss(0, 0.03), 3) for index in range(STORE_BARS)]
    rows["EY_TNX_RATIO"] = {"dates": list(days), "close": [round(4.5 / value, 4) for value in tnx]}
    return rows


# PricedTrade fields that the ledger trade records do not repeat (the marks are checked by the equity).
PRICED_ONLY = ("tradeId", "width", "entryIndex", "exitIndex", "entryFee", "exitFee", "maxLoss", "maxLossPct",
               "premium", "staleDays")


def _priced(trade: PricedTrade) -> dict:
    out = _trade(trade)
    return {key: out[key] for key in PRICED_ONLY}


def _table(items) -> dict:
    """Dicts with the same keys as {columns, rows} (one short line per item in the formatted JSON)."""
    columns = list(items[0]) if items else []
    return {"columns": columns, "rows": [[item[key] for key in columns] for item in items]}


def portfolio_build() -> dict:
    """Runs every definition of portfolio_definitions.json with portfolio.run_definition on store_rows()."""
    from strategies.qc_ports.portfolio import dataset_from_rows, run_definition, run_metrics

    rows = store_rows()
    data = dataset_from_rows(rows)
    inputs = json.loads(PORTFOLIO_DEFINITIONS.read_text(encoding="utf-8"))
    cases = []
    for case in inputs["cases"]:
        outcome = run_definition(case["definition"], data, start=case["start"], end=case.get("end"),
                                 capital=float(case.get("capital", 100_000)), symbol=case.get("symbol"))
        result = outcome.result
        cases.append({
            "name": case["name"],
            "result": {"days": len(result.dates), "first": result.dates[0], "equity": list(result.equity),
                       "openPositions": list(result.open_positions), "trades": _table(result.trades),
                       "skipped": list(result.skipped), "capital": result.capital, "engine": result.engine},
            "priced": _table([_priced(trade) for trade in outcome.priced]),
            "bookSkipped": outcome.book_skipped,
            "signals": dict(outcome.signals),
            "metrics": [run_metrics(outcome), run_metrics(outcome, 32, TRIAL_VARIANCE)],
        })
    calendar = rows["SPY"]["dates"]
    # "calendar" stands for the SPY dates and "close" for the row's close column.
    compact = {series_id: {key: "calendar" if key == "dates" and values == calendar
                           else "close" if key != "close" and values == row["close"] else values
                           for key, values in row.items()}
               for series_id, row in rows.items()}
    return {
        "about": "qc-ports portfolio runner golden fixture; regenerate with python -m tests.qc_ports_golden",
        "calendar": calendar,
        "rows": compact,
        "cases": cases,
    }


def main() -> None:
    FIXTURE.parent.mkdir(parents=True, exist_ok=True)
    FIXTURE.write_text(json.dumps(build(), indent=1, allow_nan=False) + "\n", encoding="utf-8")
    PORTFOLIO_FIXTURE.write_text(json.dumps(portfolio_build(), allow_nan=False) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
