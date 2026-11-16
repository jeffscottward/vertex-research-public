"""qc-ports: the NautilusTrader runner matches the pure-Python ledger (1e-6 relative).

Needs nautilus-trader==1.227.0 (requirements-nautilus-linux-py312.lock). Without
it the tests skip, unless VERTEX_REQUIRE_NAUTILUS=1 (the Nautilus CI run), where
a missing engine is a failure. Synthetic books always run; the real-data case
runs only where the qc-ports data folder exists (it is not in the repo).
"""
import dataclasses
import os
import random

import pytest

from strategies.qc_ports import nautilus_runner
from strategies.qc_ports.book import SignalEvent, build_book
from strategies.qc_ports.data import data_root, load_market
from strategies.qc_ports.ledger import run_ledger
from tests.qc_ports_synthetic import market
from tests.test_qc_ports_ledger import D, hand_book

REL_TOL = 1e-6

pytestmark = pytest.mark.filterwarnings("ignore:The 'generic' unit for NumPy timedelta:DeprecationWarning")


def _installed() -> bool:
    if os.environ.get("VERTEX_REQUIRE_NAUTILUS") == "1":
        nautilus_runner.require()
        return True
    try:
        nautilus_runner.require()
    except nautilus_runner.NautilusUnavailable:
        return False
    return True


needs_nautilus = pytest.mark.skipif(not _installed(), reason="nautilus-trader 1.227.0 not installed")


def _rel(left: float, right: float) -> float:
    return 0.0 if left == right else abs(left - right) / max(abs(left), abs(right), 1e-12)


def assert_parity(trades, dates=None, capital=100_000.0):
    ledger = run_ledger(trades, capital, dates)
    engine = nautilus_runner.run_nautilus(trades, capital, dates)
    assert engine.engine == nautilus_runner.ENGINE_ID
    assert engine.dates == ledger.dates
    assert engine.open_positions == ledger.open_positions
    assert engine.skipped == ledger.skipped
    assert max(_rel(a, b) for a, b in zip(ledger.equity, engine.equity, strict=True)) <= REL_TOL
    assert len(engine.trades) == len(ledger.trades)
    for want, got in zip(ledger.trades, engine.trades, strict=True):
        assert {k: v for k, v in got.items() if k not in ("pnl", "returnOnRisk")} == {
            k: v for k, v in want.items() if k not in ("pnl", "returnOnRisk")}
        assert _rel(want["pnl"], got["pnl"]) <= REL_TOL
    return ledger, engine


@needs_nautilus
def test_hand_book_matches_ledger_and_hand_values():
    ledger, engine = assert_parity(hand_book(), dates=D)
    assert engine.equity == pytest.approx((99_962.0, 100_912.0, 101_766.0, 100_989.12, 99_819.12, 99_819.12),
                                          rel=0, abs=1e-6)
    assert [(t["id"], t["contracts"]) for t in engine.trades] == [(1, 19), (3, 39)]


def _walk(seed: int, size: int, start: float) -> list[float]:
    rng = random.Random(seed)
    closes = [start]
    for _ in range(size - 1):
        closes.append(round(closes[-1] * (1 + rng.gauss(0.0003, 0.012)), 2))
    return closes


@needs_nautilus
@pytest.mark.parametrize(("structure", "extra"), [
    ("callDebitVertical", {"profitTakePct": 50, "exitDte": 7}),
    ("putDebitVertical", {"longDelta": 0.4}),
    ("putCreditVertical", {"profitTakePct": 50, "exitDte": 21}),
    ("callCreditVertical", {"shortDelta": 0.2, "exitDte": 0}),
])
def test_synthetic_books_match(structure, extra):
    size = 320
    markets = {"SPY": market(_walk(7, size, 450.0)), "QQQ": market(_walk(11, size, 380.0), symbol="QQQ",
                                                                   iv=24.0, rate=0.045)}
    rng = random.Random(3)
    events = []
    for symbol in markets:
        index = 0
        while index < size - 2:
            exit_index = index + rng.randint(3, 40) if rng.random() < 0.5 else None
            events.append(SignalEvent(symbol, index, exit_index))
            index += rng.randint(4, 25)
    options = {"structure": structure, "dte": {"target": 45, "min": 21}, "widthSigma": 0.5, "maxLossPct": 2,
               **extra}
    book = build_book(events, options, markets)
    assert len(book.trades) > 20
    ledger, _ = assert_parity(book.trades, dates=markets["SPY"].dates)
    assert max(ledger.open_positions) > 2  # overlapping trades on two symbols
    assert {t["exitReason"] for t in ledger.trades} >= {"signal"}


@needs_nautilus
@pytest.mark.parametrize("structure", ["callCalendar", "putCalendar"])
def test_synthetic_calendar_books_match(structure):
    """Two-expiry trades (book.CALENDARS) are one instrument per spread like a vertical: both engines agree."""
    size = 320
    spy = market(_walk(5, size, 450.0), rate=0.03)
    spy = dataclasses.replace(spy, iv_term=(("VIX3M", tuple(24.0 + (index % 7) for index in range(size))),
                                            ("VIX6M", tuple(25.0 + (index % 5) for index in range(size)))))
    rng = random.Random(9)
    events, index = [], 0
    while index < size - 2:
        exit_index = index + rng.randint(3, 30) if rng.random() < 0.5 else None
        events.append(SignalEvent("SPY", index, exit_index))
        index += rng.randint(2, 9)
    options = {"structure": structure, "dte": {"target": 30, "min": 21}, "farDte": {"target": 60, "min": 45},
               "maxLossPct": 2, "profitTakePct": 25}
    book = build_book(events, options, {"SPY": spy})
    assert len(book.trades) > 20 and all(trade.far_expiry for trade in book.trades)
    ledger, _ = assert_parity(book.trades, dates=spy.dates)
    assert max(ledger.open_positions) > 2
    assert {t["exitReason"] for t in ledger.trades} >= {"signal", "expiry"}


@needs_nautilus
@pytest.mark.parametrize("minutes", [1, 30])
def test_a_run_on_bar_times_matches_the_ledger(minutes):
    """1-minute bars are the closest bar times there are: the clock prints of a bar come before the next bar."""
    from tests.qc_ports_synthetic import intraday_market

    size = 390  # one session of 1-minute bars, 30 sessions of 30-minute bars
    markets = {"SPY": intraday_market(_walk(7, size, 450.0), minutes),
               "QQQ": intraday_market(_walk(11, size, 380.0), minutes, symbol="QQQ", iv=24.0, rate=0.045)}
    rng = random.Random(3)
    # One spread closes on the bar on which another opens: the exit is booked before the entry is sized.
    events = [SignalEvent("SPY", 0, 6), SignalEvent("QQQ", 6, 30)]
    for symbol in markets:
        index = 40
        while index < size - 2:
            exit_index = index + rng.randint(3, 40) if rng.random() < 0.5 else None
            events.append(SignalEvent(symbol, index, exit_index))
            index += rng.randint(4, 25)
    options = {"structure": "callDebitVertical", "dte": {"target": 45, "min": 21}, "widthSigma": 0.5, "maxLossPct": 2}
    book = build_book(events, options, markets)
    assert len(book.trades) > 20
    assert book.trades[0].exit_date == book.trades[1].entry_date == markets["SPY"].dates[7]
    ledger, _ = assert_parity(book.trades, dates=markets["SPY"].dates)
    assert ledger.dates[0] == ("2024-01-02T09:31" if minutes == 1 else "2024-01-02T10:00")
    assert max(ledger.open_positions) > 2  # overlapping trades that open and close inside a session
    assert {t["exitReason"] for t in ledger.trades} >= {"signal"}


@needs_nautilus
@pytest.mark.skipif(not (data_root() / "SPY.csv").exists(), reason="qc-ports data folder not present")
def test_real_spy_monthly_call_debit_matches():
    from strategies.qc_ports.__main__ import SMOKE_OPTIONS, monthly_events

    spy = load_market("SPY")
    book = build_book(monthly_events("SPY", spy.dates, "2007-01-01"), SMOKE_OPTIONS, {"SPY": spy})
    dates = tuple(day for day in spy.dates if day >= "2007-01-01")
    ledger, _ = assert_parity(book.trades, dates=dates)
    assert len(ledger.trades) > 200


# --------------------------------------------------------------------------- worker path (options definitions)

def _worker_rows(size=90):
    from tests.qc_ports_synthetic import VIX_FOR_20, trading_days

    dates = list(trading_days("2024-01-02", size))
    closes = [100.0 + 0.2 * k for k in range(size)]
    return {
        "SPY": {"dates": dates, **{key: list(closes) for key in ("open", "high", "low", "close", "adjClose")}},
        "VIX": {"dates": dates, "close": [VIX_FOR_20] * size},
        "IRX": {"dates": dates, "close": [4.0] * size},
    }


def _worker_spec(rows, **rule_extra):
    from strategies.qc_ports import ideas as qi

    made = qi.definition("always", qi.MONTHLY_CALL, book=qi.portfolio(["SPY"], "roll"))
    dates = rows["SPY"]["dates"]
    return {"symbol": "SPY", "timeframe": "1d", "from": dates[0], "to": dates[-1], "initialCapital": 100000,
            "costBps": 0, "stopLossPct": 0, "takeProfitPct": 0, "rule": {"kind": "dsl", "definition": made, **rule_extra}}


@needs_nautilus
def test_run_spec_json_books_the_options_run_in_both_ledgers():
    from strategies.qc_ports import portfolio as pf

    rows = _worker_rows()
    out = pf.run_spec_json(_worker_spec(rows), rows)
    assert out["kind"] == "options" and out["capital"] == 100000.0
    assert out["dates"] == rows["SPY"]["dates"] and len(out["equity"]) == len(out["dates"])
    assert out["trades"] and out["metrics"]["trades"] == len(out["trades"])
    assert out["nautilusGap"] is not None and out["nautilusGap"] <= REL_TOL
    # Each trade carries its max loss per contract, so the API recomputes maxOpenRisk.
    assert all(trade["maxLoss"] > 0 for trade in out["trades"])
    spans = [(t["entryDate"], t["exitDate"], t["contracts"] * t["maxLoss"]) for t in out["trades"]]
    risk = max((sum(a for e, x, a in spans if e <= day < x) / equity
                for day, equity in zip(out["dates"], out["equity"])), default=0.0)
    assert risk == pytest.approx(out["metrics"]["maxOpenRisk"], rel=1e-12)
    import json

    json.dumps(out, allow_nan=False)
    with pytest.raises(ValueError, match="options block"):
        pf.run_spec_json({**_worker_spec(rows), "rule": {"kind": "smaCross", "fast": 5, "slow": 20}}, rows)


@needs_nautilus
def test_batch_cli_routes_options_cases_to_the_options_runner(tmp_path):
    import json
    import subprocess
    import sys
    from pathlib import Path

    rows = _worker_rows()
    bars = {"t": [0.0, 86_400_000.0], "o": [1.0, 1.0], "h": [1.0, 1.0], "l": [1.0, 1.0], "c": [1.0, 1.0]}
    request = {"bars": bars, "series": rows, "cases": [
        {"id": "opt", "spec": _worker_spec(rows)},
        {"id": "no-rows", "spec": _worker_spec(rows)},
    ]}
    research = Path(__file__).resolve().parents[1]
    done = subprocess.run([sys.executable, "-m", "nautilus_backtest", "batch", "-", "-"], cwd=research,
                          input=json.dumps(request), capture_output=True, text=True, timeout=600, check=False)
    assert done.returncode == 0, done.stderr
    results = {item["id"]: item for item in json.loads(done.stdout)["results"]}
    assert results["opt"]["result"]["kind"] == "options"
    missing = subprocess.run([sys.executable, "-m", "nautilus_backtest", "batch", "-", "-"], cwd=research,
                             input=json.dumps({**request, "series": None}), capture_output=True, text=True,
                             timeout=600)
    assert "needs the daily series rows" in json.loads(missing.stdout)["results"][0]["error"]


@needs_nautilus
def test_batch_cli_passes_series_rows_to_equity_definitions_that_read_series():
    import json
    import subprocess
    import sys
    from datetime import date
    from pathlib import Path

    rows = _worker_rows()
    dates = rows["SPY"]["dates"]
    closes = rows["SPY"]["close"]
    epoch = date(1970, 1, 1)
    t = [float((date.fromisoformat(day) - epoch).days * 86_400_000) for day in dates]
    bars = {"t": t, "o": closes, "h": closes, "l": closes, "c": closes}
    gated = {"name": "vix gate", "version": 1,
             "entry": {"all": [{"left": {"type": "price", "field": "close"}, "op": ">",
                                "right": {"type": "const", "value": 0}}]},
             "filters": [{"type": "series", "series": "$iv", "condition": {
                 "left": {"type": "price", "field": "close"}, "op": "<", "right": {"type": "const", "value": 30}}}]}
    spec = {"symbol": "SPY", "timeframe": "1d", "from": dates[0], "to": dates[-1], "initialCapital": 10000,
            "costBps": 0, "stopLossPct": 0, "takeProfitPct": 0, "rule": {"kind": "dsl", "definition": gated}}
    research = Path(__file__).resolve().parents[1]

    def batch(series):
        done = subprocess.run([sys.executable, "-m", "nautilus_backtest", "batch", "-", "-"], cwd=research,
                              input=json.dumps({"bars": bars, "series": series, "cases": [{"id": "eq", "spec": spec}]}),
                              capture_output=True, text=True, timeout=600)
        assert done.returncode == 0, done.stderr
        return json.loads(done.stdout)["results"][0]

    assert len(batch(rows)["result"]["equity"]) == len(dates)
    assert "STRATEGY_SERIES_FILTERS_UNSUPPORTED" in batch(None)["error"]


def _gated_batch(rows):
    from datetime import date

    dates = rows["SPY"]["dates"]
    closes = rows["SPY"]["close"]
    epoch = date(1970, 1, 1)
    t = [float((date.fromisoformat(day) - epoch).days * 86_400_000) for day in dates]
    bars = {"t": t, "o": closes, "h": closes, "l": closes, "c": closes}
    gated = {"name": "vix gate", "version": 1,
             "entry": {"all": [{"left": {"type": "price", "field": "close"}, "op": ">",
                                "right": {"type": "const", "value": 0}}]},
             "filters": [{"type": "series", "series": "$iv", "condition": {
                 "left": {"type": "price", "field": "close"}, "op": "<", "right": {"type": "const", "value": 30}}}]}

    def spec(first, end):
        return {"symbol": "SPY", "timeframe": "1d", "from": dates[first], "to": dates[end - 1],
                "initialCapital": 10000, "costBps": 0, "stopLossPct": 0, "takeProfitPct": 0,
                "rule": {"kind": "dsl", "definition": gated}}

    cases = [{"id": "early", "slice": [0, 50], "spec": spec(0, 50)},
             {"id": "late", "slice": [20, 90], "spec": spec(20, 90)}]
    return bars, cases


def _cut(rows, last):
    keep = {series_id: sum(1 for day in row["dates"] if day <= last) for series_id, row in rows.items()}
    return {series_id: {key: list(values)[:keep[series_id]] for key, values in row.items()}
            for series_id, row in rows.items()}


def test_batch_cases_read_the_series_rows_up_to_their_own_last_bar(monkeypatch):
    """A case of a multi-case batch gets the context of the rows cut at its last bar: the same as
    the run alone with its claim rows (cut at its `to`), whatever later rows the batch holds."""
    import nautilus_backtest.__main__ as cli
    from nautilus_backtest.bars import Bars

    seen = {}

    class Result:
        def __init__(self, value):
            self.value = value

        def to_json(self):
            return self.value

    def fake_run_spec(bars, spec):
        context = spec["context"]
        return Result({"bars": len(bars.c), "last": {key: max(values) for key, values in context.items()},
                       "size": {key: len(values) for key, values in context.items()}})

    monkeypatch.setattr(cli, "run_spec", fake_run_spec)
    rows = _worker_rows()
    bars, cases = _gated_batch(rows)
    shared = Bars.from_columns(bars)
    batched = {case["id"]: cli._batch_case(shared, case, rows)["result"] for case in cases}
    for case in cases:
        first, end = case["slice"]
        alone_bars = Bars.from_columns({key: values[first:end] for key, values in bars.items()})
        alone = cli._batch_case(alone_bars, {"id": case["id"], "spec": case["spec"]},
                                _cut(rows, case["spec"]["to"]))["result"]
        seen[case["id"]] = alone
        assert batched[case["id"]] == alone
    assert seen["early"]["last"]["VIX"] == cases[0]["spec"]["to"] < rows["VIX"]["dates"][-1]
    assert seen["late"]["last"]["VIX"] == cases[1]["spec"]["to"]

    # `to` after the last bar (a holiday at the end of the range): a series row between the last
    # bar and `to` is read, as the claim rows (cut at `to`) hold it; nothing after `to` is.
    dates = rows["SPY"]["dates"]
    after = {**cases[0], "spec": {**cases[0]["spec"], "to": dates[51]}}
    result = cli._batch_case(shared, after, rows)["result"]
    assert result["last"]["VIX"] == dates[51] and result["size"]["VIX"] == 52
    assert result == cli._batch_case(shared, after, _cut(rows, dates[51]))["result"]
    # A spec without `to` reads up to its last bar.
    bare = {**cases[0], "spec": {key: value for key, value in cases[0]["spec"].items() if key != "to"}}
    assert cli._batch_case(shared, bare, rows)["result"]["last"]["VIX"] == dates[49]


@needs_nautilus
def test_batch_cli_multi_case_with_series_equals_each_run_alone():
    import json
    import subprocess
    import sys
    from pathlib import Path

    rows = _worker_rows()
    bars, cases = _gated_batch(rows)
    research = Path(__file__).resolve().parents[1]

    def batch(request):
        done = subprocess.run([sys.executable, "-m", "nautilus_backtest", "batch", "-", "-"], cwd=research,
                              input=json.dumps(request), capture_output=True, text=True, timeout=600, check=False)
        assert done.returncode == 0, done.stderr
        return {entry["id"]: entry["result"] for entry in json.loads(done.stdout)["results"]}

    together = batch({"bars": bars, "series": rows, "cases": cases})
    for case in cases:
        first, end = case["slice"]
        alone = batch({"bars": {key: values[first:end] for key, values in bars.items()},
                       "series": _cut(rows, case["spec"]["to"]), "cases": [{"id": case["id"], "spec": case["spec"]}]})
        assert together[case["id"]] == alone[case["id"]]


def test_trades_share_an_instrument_only_when_one_ends_before_the_next_starts():
    from types import SimpleNamespace

    def trade(trade_id, entry, exit_):
        return SimpleNamespace(trade_id=trade_id, entry_date=entry, exit_date=exit_,
                               marks=((entry, 1.0), (exit_, 1.0)))

    trades = [trade(1, "2024-01-02T10:00", "2024-01-02T11:00"),
              trade(2, "2024-01-02T11:00", "2024-01-02T12:00"),  # opens on the bar the first one closes
              trade(3, "2024-01-02T11:30", "2024-01-02T13:00"),  # after the first one: its instrument again
              trade(4, "2024-01-02T11:30", "2024-01-02T14:00")]  # overlaps the second and the third one
    assert nautilus_runner.instrument_slots(trades) == {1: 0, 2: 1, 3: 0, 4: 2}
    assert nautilus_runner.instrument_slots([]) == {}


# --------------------------------------------------------------------------- worker path: request fault or engine fault

_BARS = {"t": [0.0, 86_400_000.0], "o": [1.0, 1.0], "h": [1.0, 1.0], "l": [1.0, 1.0], "c": [1.0, 1.0]}
_CALENDAR = {"structure": "callCalendar", "dte": {"target": 30, "min": 21}, "farDte": {"target": 60, "min": 45},
             "maxLossPct": 2}
_CAP_TEXT = "maxLossPct 50 refused: the cap is 2% of equity per trade"


def _route_rows():
    """_worker_rows (each column its own list) plus a second ETF (QQQ with its IV index) and the SPY IV term series."""
    rows = {series_id: {key: list(values) for key, values in row.items()} for series_id, row in _worker_rows().items()}
    rows["QQQ"] = {key: list(values) for key, values in rows["SPY"].items()}
    for series_id in ("VXN", "VIX3M", "VIX6M"):
        rows[series_id] = {key: list(values) for key, values in rows["VIX"].items()}
    return rows


def _options(spec):
    return spec["rule"]["definition"]["options"]


def _trade(symbol):
    def change(spec, rows):
        spec["symbol"] = symbol
        spec["rule"]["definition"]["portfolio"]["symbols"] = [symbol]
    return change


def _calendar(**fields):
    def change(spec, rows):
        spec["rule"]["definition"]["options"] = {**_CALENDAR, **fields}
    return change


def _both(*changes):
    def change(spec, rows):
        for one in changes:
            one(spec, rows)
    return change


def _drop_spy_day(spec, rows):
    for key in rows["SPY"]:
        del rows["SPY"][key][40]


def _no_portfolio(spec, rows):
    spec["symbol"] = None
    del spec["rule"]["definition"]["portfolio"]


# One request per `raise InputError` statement of the options runner that a batch case can reach.
REQUEST_FAULTS = [
    ("portfolio._rows_view length", lambda s, r: r["VIX"]["close"].pop(), "VIX: close and dates differ in length"),
    ("portfolio._rows_view order", lambda s, r: r["SPY"]["dates"].__setitem__(10, r["SPY"]["dates"][9]),
     "SPY: dates must be strictly increasing"),
    ("portfolio.dataset_from_rows", _both(_trade("QQQ"), lambda s, r: r.pop("SPY")), "The market calendar needs SPY bars"),
    ("portfolio._portfolio", _no_portfolio, "A definition without a portfolio block needs the run symbol"),
    ("book._int_in", lambda s, r: _options(s).__setitem__("dte", {"target": 60.5, "min": 45}),
     "target must be an integer in 7..400"),
    ("book._num_in type", lambda s, r: _options(s).__setitem__("widthSigma", "wide"), "widthSigma must be a number"),
    ("book._num_in range", lambda s, r: _options(s).__setitem__("longDelta", 5), "longDelta must be in [0.05, 0.95]"),
    ("book.parse_options field", lambda s, r: _options(s).__setitem__("extra", 1), "Unknown options field: extra"),
    ("book.parse_options structure", lambda s, r: _options(s).__setitem__("structure", "straddle"),
     "structure must be one of callDebitVertical, putDebitVertical, putCreditVertical, callCreditVertical"),
    ("book.parse_options dte", lambda s, r: _options(s).__setitem__("dte", 30), "dte must be {target, min}"),
    ("book.parse_options cap", lambda s, r: _options(s).__setitem__("maxLossPct", 50), _CAP_TEXT),
    ("book._dte", _calendar(farDte=90), "farDte must be {target, min}"),
    ("book.parse_calendar field", _calendar(extra=1), "Unknown calendar field: extra"),
    ("book.parse_calendar cap", _calendar(maxLossPct=50), _CAP_TEXT),
    ("book.parse_calendar far", _calendar(farDte={"target": 30, "min": 21}), "farDte.target must be above dte.target"),
    ("portfolio._refuse_market_values iv index", lambda s, r: r["VIX"]["close"].__setitem__(20, 0),
     "Market IV index values must be None or finite and above 0"),
    ("portfolio._refuse_market_values rate", lambda s, r: r["IRX"]["close"].__setitem__(20, -1.0),
     "Market rates must be None or finite and not negative"),
    ("portfolio._refuse_market_values iv term", lambda s, r: r["VIX3M"]["close"].__setitem__(20, 0),
     "Market IV term VIX3M values must be None or finite and above 0"),
    ("ledger.timeline forms", _both(_trade("QQQ"), lambda s, r: r["SPY"]["dates"].__setitem__(5, r["SPY"]["dates"][5] + "T16:00")),
     "The run days must be all days or all bar times"),
    ("ledger.timeline marks", _both(_trade("QQQ"), _drop_spy_day), "Mark dates outside the run dates: 2024-02-29"),
    ("ledger.run_ledger", lambda s, r: s.__setitem__("initialCapital", -5), "capital must be above 0"),
    ("metrics.summarize", lambda s, r: s.__setitem__("from", r["SPY"]["dates"][-1]), "Need at least two run days"),
    ("nautilus_runner.run_nautilus", lambda s, r: s.__setitem__("from", "2030-01-01"), "Nothing to run: no dates"),
]


def _options_case(change=None):
    """(spec, rows) of a valid options case, after `change`, as the JSON of a request holds them."""
    import json

    rows = _route_rows()
    spec = _worker_spec(rows)
    if change is not None:
        change(spec, rows)
    request = json.loads(json.dumps({"spec": spec, "rows": rows}))
    return request["spec"], request["rows"]


def _batch_entry(change=None):
    from nautilus_backtest import __main__ as cli
    from nautilus_backtest.bars import Bars

    spec, rows = _options_case(change)
    return cli._batch_case(Bars.from_columns(_BARS), {"id": "case", "spec": spec}, rows)


@needs_nautilus
@pytest.mark.parametrize(("change", "text"), [pytest.param(change, text, id=name) for name, change, text in REQUEST_FAULTS])
def test_an_options_request_fault_is_the_input_error_of_the_case(change, text):
    entry = _batch_entry(change)
    assert entry.get("error") == text and "crash" not in entry and "result" not in entry


def test_a_rows_fault_of_an_equity_case_that_reads_series_is_its_input_error():
    """The equity route reads the rows with the same function as the options runner (portfolio._rows_view)."""
    from nautilus_backtest import __main__ as cli
    from nautilus_backtest.bars import Bars

    rows = _route_rows()
    bars, cases = _gated_batch(rows)
    rows["VIX"]["close"].pop()
    entry = cli._batch_case(Bars.from_columns(bars), {"id": "case", "spec": cases[1]["spec"]}, rows)
    assert entry.get("error") == "VIX: close and dates differ in length" and "crash" not in entry


# Every `raise InputError` of strategies/qc_ports: file -> function -> number of statements. A new one is
# a decision: only a condition that the request content decides is an input error; a check of the
# engine stays ValueError or RuntimeError, so that its fault is a case crash. data.py has none on
# purpose: scripts/market-series/parity.py loads it from its file, without the nautilus_backtest package.
INPUT_ERROR_RAISES = {
    "book.py": {"_anchor_strike": 1, "_atm_iv": 1, "_dte": 1, "_int_in": 1, "_num_in": 2, "parse_calendar": 3,
                "parse_options": 4},
    "ledger.py": {"run_ledger": 1, "timeline": 2},
    "metrics.py": {"summarize": 1},
    "nautilus_runner.py": {"run_nautilus": 1},
    "portfolio.py": {"_portfolio": 1, "_refuse_market_values": 3, "_rows_view": 2, "dataset_from_rows": 1},
}


def _input_error_raises(source: str) -> dict[str, int]:
    """Function name -> number of statements that raise InputError (`<module>` outside a function).
    Refuses a use of the name that is not such a statement (a raised variable, a subclass) and an alias."""
    import ast

    found: dict[str, int] = {}
    tree = ast.parse(source)
    uses = sum(1 for node in ast.walk(tree)
               if (isinstance(node, ast.Name) and node.id == "InputError")
               or (isinstance(node, ast.Attribute) and node.attr == "InputError"))
    aliases = [alias for node in ast.walk(tree) if isinstance(node, (ast.Import, ast.ImportFrom))
               for alias in node.names if alias.name.split(".")[-1] == "InputError" and alias.asname]

    def visit(node, owner):
        for child in ast.iter_child_nodes(node):
            if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)):
                visit(child, child.name if owner == "<module>" else owner)
                continue
            if isinstance(child, ast.Raise) and child.exc is not None:
                raised = child.exc.func if isinstance(child.exc, ast.Call) else child.exc
                name = raised.attr if isinstance(raised, ast.Attribute) else getattr(raised, "id", None)
                if name == "InputError":
                    found[owner] = found.get(owner, 0) + 1
            visit(child, owner)

    visit(tree, "<module>")
    assert not aliases, "InputError must keep its name"
    assert uses == sum(found.values()), "InputError is used outside a raise statement"
    return found


def test_only_the_listed_statements_of_the_options_runner_raise_input_error():
    from pathlib import Path

    folder = Path(__file__).resolve().parents[1] / "strategies" / "qc_ports"
    found = {path.name: _input_error_raises(path.read_text()) for path in sorted(folder.glob("*.py"))}
    assert {name: raises for name, raises in found.items() if raises} == INPUT_ERROR_RAISES
    assert sum(sum(raises.values()) for raises in INPUT_ERROR_RAISES.values()) == 25
    sample = "def outer():\n    def inner():\n        raise bars.InputError('x')\n    raise InputError\nraise InputError('y')\n"
    assert _input_error_raises(sample) == {"outer": 2, "<module>": 1}
    for hidden in ("from bars import InputError as Refusal\n", "def f():\n    error = InputError('x')\n    raise error\n",
                   "class Other(InputError):\n    pass\n"):
        with pytest.raises(AssertionError):
            _input_error_raises(hidden)


def _raises(error):
    def fail(*args, **kwargs):
        raise error
    return fail


def _recurse(*args, **kwargs):
    return _recurse(*args, **kwargs)


def _shifted_equity(trades, capital, dates):
    """A NautilusTrader result whose equity is 1% above the ledger's: the parity check of the run fails."""
    result = run_ledger(trades, capital, dates=dates)
    return dataclasses.replace(result, equity=tuple(value * 1.01 for value in result.equity))


# (module of strategies.qc_ports, name, replacement, start of the crash text)
ENGINE_FAULTS = [
    ("nautilus_runner", "run_nautilus", _raises(RuntimeError("qc-ports nautilus: 2 orders not fully filled")),
     "RuntimeError: qc-ports nautilus: 2 orders not fully filled"),
    ("nautilus_runner", "run_nautilus", _shifted_equity, "RuntimeError: Ledger and Nautilus disagree (gap "),
    ("portfolio", "run_ledger", _recurse, "RecursionError: maximum recursion depth exceeded"),
    ("portfolio", "run_ledger", _raises(NotImplementedError("no such fill model")), "NotImplementedError: no such fill model"),
    ("portfolio", "summarize", _raises(ValueError("math domain error")), "ValueError: math domain error"),
]


@needs_nautilus
@pytest.mark.parametrize(("module", "name", "replacement", "text"), ENGINE_FAULTS,
                         ids=["orders-not-filled", "parity-gap", "recursion", "not-implemented", "library-value-error"])
def test_an_engine_fault_of_an_options_case_is_a_crash(monkeypatch, module, name, replacement, text):
    import importlib

    monkeypatch.setattr(importlib.import_module(f"strategies.qc_ports.{module}"), name, replacement)
    entry = _batch_entry()
    assert entry.get("crash", "").startswith(text) and "error" not in entry and "result" not in entry


@needs_nautilus
def test_batch_keeps_the_other_cases_when_an_options_case_crashes(monkeypatch, tmp_path):
    import json

    from nautilus_backtest import __main__ as cli

    real = nautilus_runner.run_nautilus
    calls = []

    def second_call_fails(trades, capital, dates):
        calls.append(1)
        if len(calls) == 2:
            raise RuntimeError("qc-ports nautilus: 2 orders not fully filled")
        return real(trades, capital, dates=dates)

    monkeypatch.setattr(nautilus_runner, "run_nautilus", second_call_fails)
    good, rows = _options_case()
    refused, _ = _options_case(lambda s, r: _options(s).__setitem__("maxLossPct", 50))
    request = {"bars": _BARS, "series": rows, "cases": [
        {"id": "runs", "spec": good}, {"id": "refused", "spec": refused}, {"id": "crashes", "spec": good}]}
    source, target = tmp_path / "in.json", tmp_path / "out.json"
    source.write_text(json.dumps(request))
    assert cli.main(["batch", str(source), str(target)]) == cli.CRASH_STATUS
    entries = json.loads(target.read_text())["results"]
    assert [entry["id"] for entry in entries] == ["runs", "refused", "crashes"]
    assert entries[0]["result"]["kind"] == "options"
    assert entries[1]["error"] == _CAP_TEXT
    assert entries[2]["crash"] == "RuntimeError: qc-ports nautilus: 2 orders not fully filled"
    assert all(len({"result", "error", "crash"} & set(entry)) == 1 for entry in entries)


@needs_nautilus
def test_missing_nautilus_on_the_options_route_ends_with_status_3(monkeypatch, tmp_path, capsys):
    import json

    from nautilus_backtest import __main__ as cli

    missing = nautilus_runner.NautilusUnavailable("nautilus-trader==1.227.0 is not installed")
    monkeypatch.setattr(nautilus_runner, "run_nautilus", _raises(missing))
    spec, rows = _options_case()
    batch, run, target = tmp_path / "batch.json", tmp_path / "run.json", tmp_path / "out.json"
    batch.write_text(json.dumps({"bars": _BARS, "series": rows, "cases": [{"id": "case", "spec": spec}]}))
    run.write_text(json.dumps({"bars": _BARS, "series": rows, "spec": spec}))
    assert cli.main(["batch", str(batch), str(target)]) == 3
    assert not target.exists()
    assert cli.main(["run", str(run)]) == 3
    captured = capsys.readouterr()
    assert captured.out == "" and captured.err.count("nautilus-trader==1.227.0 is not installed") == 2


@needs_nautilus
def test_run_gives_status_2_for_an_options_request_fault(tmp_path, capsys):
    import json

    from nautilus_backtest import __main__ as cli

    spec, rows = _options_case(lambda s, r: _options(s).__setitem__("maxLossPct", 50))
    source = tmp_path / "run.json"
    source.write_text(json.dumps({"bars": _BARS, "series": rows, "spec": spec}))
    assert cli.main(["run", str(source)]) == 2
    assert json.loads(capsys.readouterr().out) == {"error": _CAP_TEXT}


@needs_nautilus
def test_run_does_not_answer_an_engine_fault_of_an_options_case_as_an_input_error(monkeypatch, tmp_path, capsys):
    """`run` has no crash entry: the exception leaves `main` (a traceback and exit status 1 in the command)."""
    import json

    from nautilus_backtest import __main__ as cli

    monkeypatch.setattr(nautilus_runner, "run_nautilus",
                        _raises(RuntimeError("qc-ports nautilus: 2 orders not fully filled")))
    spec, rows = _options_case()
    source = tmp_path / "run.json"
    source.write_text(json.dumps({"bars": _BARS, "series": rows, "spec": spec}))
    with pytest.raises(RuntimeError, match="2 orders not fully filled"):
        cli.main(["run", str(source)])
    assert capsys.readouterr().out == ""
