"""research/backtests/option-chain: the daily chain snapshot and the calibration report (fakes only, no network)."""

import importlib.util
import json
import math
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace

import pytest

DIRECTORY = Path(__file__).resolve().parents[3] / "research" / "backtests" / "option-chain"


def _load(name: str):
    spec = importlib.util.spec_from_file_location(f"option_chain_{name}", DIRECTORY / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


snapshot = _load("snapshot")
calibrate = _load("calibrate")

NOW = datetime(2026, 11, 12, 20, 30, tzinfo=UTC)  # Thursday 15:30 New York
TODAY = date(2026, 11, 12)
EXPIRY = "2026-12-18"  # third Friday, 36 days out
T = 36 / 365
SPOT, FORWARD, ATM_IV = 100.0, 100.4, 0.20
DISCOUNT = math.exp(-snapshot.RATE * T)
FRESH = NOW - timedelta(minutes=16)
CALL_SLOPE, PUT_SLOPE = -0.1, -0.2


def moneyness(strike: float) -> float:
    return math.log(strike / SPOT) / (ATM_IV * math.sqrt(T))


def smile(strike: float) -> float:
    """IV by strike: a line per wing in standardized moneyness, and a jump beyond 1.5 on both sides."""
    x = moneyness(strike)
    jump = 0.3 if abs(x) > 1.5 else 0.0
    return ATM_IV * (1 + (CALL_SLOPE if x > 0 else PUT_SLOPE) * x + jump)


def pct_of(strike: float) -> float:
    """Half-spread in percent of the mid: different at every strike, so each reference leg has its own value."""
    return 0.5 + 0.1 * abs(strike - 100)


def rows(call: bool, strikes=range(80, 121), stamp: datetime | None = FRESH, live: bool = True) -> list:
    """Quotes of one side priced on the smile with the forward FORWARD; `live` False gives a zero bid."""
    out = []
    for strike in strikes:
        price = DISCOUNT * snapshot.black(FORWARD, float(strike), T, smile(strike), call)
        pct = pct_of(strike) / 100
        out.append(SimpleNamespace(strike=float(strike), bid=price * (1 - pct) if live else 0.0, ask=price * (1 + pct),
                                   lastTradeDate=stamp))
    return out


class Frame:
    """The DataFrame calls the collector makes, over a list of rows."""

    def __init__(self, data: list) -> None:
        self.data = data

    def __len__(self) -> int:
        return len(self.data)

    def __getitem__(self, column: str):
        values = [getattr(row, column) for row in self.data]
        return SimpleNamespace(dropna=lambda: SimpleNamespace(tolist=lambda: [value for value in values if value is not None]))

    def itertuples(self):
        return iter(self.data)

    def to_csv(self, path: Path, index: bool) -> None:
        Path(path).write_text("strike,bid,ask\n" + "".join(f"{row.strike!r},{row.bid!r},{row.ask!r}\n" for row in self.data))


def spot_of(symbol: str) -> float:
    return SPOT + 0.1 * snapshot.SYMBOLS.index(symbol)  # a different spot per symbol


class Ticker:
    def __init__(self, symbol: str, stamp: datetime | None = FRESH, failures: int = 0, live: bool = True,
                 listed: tuple = ("2026-11-20", EXPIRY, "2026-12-24", "2027-03-19"), chain=None, spot="own") -> None:
        self.symbol, self.stamp, self.failures, self.live, self.listed, self.chain = symbol, stamp, failures, live, listed, chain
        self.fast_info = {"last_price": spot_of(symbol) if spot == "own" else spot}

    @property
    def options(self):
        if self.failures:
            self.failures -= 1
            raise RuntimeError("throttled")
        return self.listed

    def option_chain(self, expiry: str):
        if self.chain is not None:
            return self.chain
        return SimpleNamespace(calls=Frame(rows(True, stamp=self.stamp, live=self.live)),
                               puts=Frame(rows(False, stamp=self.stamp, live=self.live)))


def run(tmp_path: Path, special: dict | None = None, now: datetime = NOW) -> tuple[int, list[str]]:
    """One collect run; `special` maps a symbol to its Ticker arguments."""
    lines: list[str] = []
    code = snapshot.collect(lambda symbol: Ticker(symbol, **(special or {}).get(symbol, {})), now, tmp_path, "fake",
                            log=lambda *parts: lines.append(" ".join(map(str, parts))))
    return code, lines


def summary_of(tmp_path: Path) -> dict:
    return json.loads((tmp_path / "2026-11-12" / "203000Z" / "summary.json").read_text())


@pytest.fixture(autouse=True)
def no_sleep(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(snapshot.clock, "sleep", lambda seconds: None)


def test_measure_recovers_the_forward_the_wing_slopes_and_the_leg_spreads() -> None:
    """The rows have no implied-volatility column: the measure computes it from the mids."""
    item = snapshot.measure(rows(True), rows(False), SPOT, EXPIRY, TODAY)
    assert item["dte"] == 36 and item["spot"] == SPOT
    assert item["forward"] == pytest.approx(FORWARD) and item["atmIv"] == pytest.approx(ATM_IV)
    # The wings differ, and the jump beyond 1.5 standard deviations must stay outside both fits.
    assert item["callSlope"] == pytest.approx(CALL_SLOPE) and item["putSlope"] == pytest.approx(PUT_SLOPE)
    # sigma = 100 * 0.20 * sqrt(36 / 365) = 6.28: the legs sit at spot, +1, -0.67 and -1.17 sigma.
    assert item["strike"] == {"atmCall": 100.0, "oneSigmaCall": 106.0, "put25Delta": 96.0, "putFurtherOut": 93.0}
    assert item["halfSpreadPct"] == pytest.approx({"atmCall": 0.5, "oneSigmaCall": 1.1, "put25Delta": 0.9, "putFurtherOut": 1.2})
    assert item["mid"]["atmCall"] == pytest.approx(DISCOUNT * snapshot.black(FORWARD, 100.0, T, ATM_IV, True))
    assert item["ivRatioOneSigmaCall"] == pytest.approx(1 + CALL_SLOPE * moneyness(106))
    assert item["usableQuotes"] == {"calls": 41, "puts": 41}


def test_measure_ignores_dead_quotes_and_needs_quotes_near_the_money() -> None:
    dead = [SimpleNamespace(strike=100.5, bid=0.0, ask=1.0), SimpleNamespace(strike=101.5, bid=2.0, ask=2.0),
            SimpleNamespace(strike=102.5, bid=float("nan"), ask=1.2)]
    item = snapshot.measure(rows(True) + dead, rows(False), SPOT, EXPIRY, TODAY)
    assert item["usableQuotes"]["calls"] == 41 and item["callSlope"] == pytest.approx(CALL_SLOPE)
    assert snapshot.measure(dead, rows(False), SPOT, EXPIRY, TODAY) is None
    assert snapshot.measure(rows(True, live=False), rows(False), SPOT, EXPIRY, TODAY) is None
    # Two strikes on both sides near the money are not enough for the forward.
    assert snapshot.measure(rows(True, strikes=(99, 101)), rows(False, strikes=(99, 101)), SPOT, EXPIRY, TODAY) is None
    # Three strikes with both quotes give the forward, but the nearest call must be within 2% of spot.
    puts = rows(False, strikes=[*range(80, 121), 101.9, 102.2, 102.5, 102.8])
    assert snapshot.measure(rows(True, strikes=(101.9, 102.5, 102.8, 104, 106, 108)), puts, SPOT, EXPIRY, TODAY) is not None
    assert snapshot.measure(rows(True, strikes=(102.2, 102.5, 102.8, 104, 106, 108)), puts, SPOT, EXPIRY, TODAY) is None
    assert snapshot.measure(rows(True), rows(False), SPOT, EXPIRY, date(2026, 12, 18)) is None  # expiry day
    assert snapshot.measure(rows(True), rows(False), float("nan"), EXPIRY, TODAY) is None


def test_the_forward_comes_from_the_strikes_near_the_money_only() -> None:
    """Away from the money the early-exercise value of an American put breaks the parity; it must not move the forward."""
    puts = rows(False)
    for row in puts:
        if abs(row.strike / SPOT - 1) > 0.03:
            row.bid, row.ask = row.bid + 0.5, row.ask + 0.5
    assert snapshot.parity_forward(rows(True), puts, SPOT, DISCOUNT) == pytest.approx(FORWARD)
    assert snapshot.parity_forward(rows(True, strikes=(99, 101)), puts, SPOT, DISCOUNT) is None
    assert snapshot.parity_forward(rows(True, strikes=(99, 100, 101)), puts, SPOT, DISCOUNT) == pytest.approx(FORWARD)
    # Two bad quotes among the three nearest strikes do not move the median of the five nearest.
    puts = rows(False)
    for row in puts:
        if row.strike in (100.0, 101.0):
            row.bid, row.ask = row.bid + 0.5, row.ask + 0.5
    assert snapshot.parity_forward(rows(True), puts, SPOT, DISCOUNT) == pytest.approx(FORWARD)


def flat_quotes(call: bool, strikes, forward: float) -> list:
    return [SimpleNamespace(strike=float(strike), bid=0.99 * price, ask=1.01 * price)
            for strike in strikes for price in [DISCOUNT * snapshot.black(forward, float(strike), T, 0.4, call)]]


@pytest.mark.parametrize("spot, forward", [(46.5, 46.7), (46.0, 46.2), (20.0, 20.1), (20.5, None)])
def test_the_forward_of_a_low_priced_etf_with_one_dollar_strikes(spot: float, forward: float | None) -> None:
    """Five nearest strikes within 6% of spot: at 46.5 that is 44 to 49 (a 3% window had two), at 20 it is 19 to 21,
    and at 20.5 only 20 and 21 are left, which is not enough."""
    calls, puts = (flat_quotes(side, range(10, 60), forward or 20.6) for side in (True, False))
    assert snapshot.parity_forward(calls, puts, spot, DISCOUNT) == (None if forward is None else pytest.approx(forward))


def test_slope_is_the_least_squares_line_through_the_money() -> None:
    # ATM IV 0.2 and t 0.25 give x = ln(K / 100) / 0.1. Points (x, IV / ATM): (0.5, 0.9), (1, 0.95), (1.5, 0.7).
    vols = {100 * math.exp(0.1 * x): 0.2 * y for x, y in ((0.5, 0.9), (1.0, 0.95), (1.5, 0.7), (2.0, 5.0), (-1.0, 3.0), (0.0, 9.0))}
    assert snapshot.slope(vols, 100.0, 0.2, 0.25, 0.0, 1.5) == pytest.approx(-0.55 / 3.5)
    assert snapshot.slope({100 * math.exp(0.05): 0.18, 100 * math.exp(0.1): 0.19}, 100.0, 0.2, 0.25, 0.0, 1.5) is None


def test_black_is_the_black_76_price() -> None:
    assert snapshot.black(100.0, 100.0, 1.0, 0.2, True) == pytest.approx(7.9656, abs=1e-4)
    assert snapshot.black(100.0, 100.0, 1.0, 0.2, False) == pytest.approx(7.9656, abs=1e-4)
    assert snapshot.black(100.0, 110.0, 0.25, 0.3, True) == pytest.approx(2.5002, abs=1e-4)
    assert snapshot.black(100.0, 90.0, 0.5, 0.3, True) - snapshot.black(100.0, 90.0, 0.5, 0.3, False) == pytest.approx(10.0)


def test_implied_vol_inverts_the_black_price() -> None:
    for call, strike, vol in ((True, 106.0, 0.17), (False, 93.0, 0.31), (True, 95.0, 0.2), (False, 100.0, 0.9)):
        price = snapshot.black(FORWARD, strike, T, vol, call)
        assert snapshot.implied_vol(price, FORWARD, strike, T, call) == pytest.approx(vol)
    assert snapshot.implied_vol(4.0, 100.0, 95.0, T, True) is None  # below the value of exercise (5)
    assert snapshot.implied_vol(0.0, 100.0, 120.0, T, True) is None
    for vol, inside in ((0.004, False), (0.006, True), (4.9, True), (5.1, False)):  # 0.5% to 500%
        found = snapshot.implied_vol(snapshot.black(FORWARD, 100.0, T, vol, True), FORWARD, 100.0, T, True)
        assert (found == pytest.approx(vol)) if inside else (found is None)


def test_monthly_expiries_keeps_third_fridays_30_to_75_days_out() -> None:
    listed = ("2026-11-20", "2026-12-11", "2026-12-17", "2026-12-18", "2026-12-24", "2027-01-15", "2027-01-22", "2027-02-19")
    assert snapshot.monthly_expiries(listed, TODAY) == ["2026-12-18", "2027-01-15"]
    assert snapshot.monthly_expiries(listed, date(2026, 11, 18)) == ["2026-12-18", "2027-01-15"]  # 30 days
    assert snapshot.monthly_expiries(listed, date(2026, 11, 19)) == ["2027-01-15"]  # 29 days
    assert snapshot.monthly_expiries(listed, date(2026, 11, 1)) == ["2026-12-18", "2027-01-15"]  # 75 days
    assert snapshot.monthly_expiries(listed, date(2026, 10, 31)) == ["2026-12-18"]  # 76 days
    # The third Friday is the 15th to the 21st: January 2027 has Fridays on 15 and 22, August 2026 on 14 and 21.
    assert snapshot.monthly_expiries(("2026-08-14", "2026-08-21", "2026-08-28"), date(2026, 7, 10)) == ["2026-08-21"]


def test_monthly_expiries_takes_the_thursday_when_the_third_friday_is_a_holiday() -> None:
    # NYSE is closed on Friday 2027-06-18, so the June monthly expires on Thursday 06-17.
    listed = ("2027-06-11", "2027-06-17", "2027-06-25", "2027-06-10")
    assert snapshot.monthly_expiries(listed, date(2027, 5, 10)) == ["2027-06-17"]


@pytest.mark.parametrize("when, live", [
    (datetime(2026, 11, 12, 14, 44, tzinfo=UTC), False),   # 09:44 New York (EST)
    (datetime(2026, 11, 12, 14, 45, tzinfo=UTC), True),
    (datetime(2026, 11, 12, 20, 59, tzinfo=UTC), True),    # 15:59
    (datetime(2026, 11, 12, 21, 0, tzinfo=UTC), False),    # 16:00
    (datetime(2026, 11, 14, 17, 30, tzinfo=UTC), False),   # Saturday 12:30
    (datetime(2026, 7, 8, 13, 45, tzinfo=UTC), True),      # 09:45 New York (EDT)
    (datetime(2026, 7, 8, 20, 0, tzinfo=UTC), False),      # 16:00 New York (EDT)
])
def test_in_session_is_a_weekday_between_0945_and_1600_new_york(when: datetime, live: bool) -> None:
    assert snapshot.in_session(when) is live


def test_collect_writes_one_run_directory_with_all_symbols(tmp_path: Path) -> None:
    code, lines = run(tmp_path)
    directory = tmp_path / "2026-11-12" / "203000Z"
    summary = summary_of(tmp_path)
    assert code == 0 and summary["complete"] is True and summary["errors"] == {}
    assert (summary["schema"], summary["day"], summary["source"]) == (2, "2026-11-12", "fake")
    assert summary["fetchedAt"] == "2026-11-12T20:30:00+00:00" and summary["probeLastTrade"] == "2026-11-12T20:14:00+00:00"
    assert list(summary["symbols"]) == list(snapshot.SYMBOLS)
    assert summary["spots"] == {symbol: spot_of(symbol) for symbol in snapshot.SYMBOLS}
    for symbol, items in summary["symbols"].items():
        assert [(item["expiry"], item["spot"]) for item in items] == [(EXPIRY, spot_of(symbol))]
    assert sorted(path.name for path in directory.iterdir()) == sorted(
        [f"{symbol}-{EXPIRY}-{side}.csv" for symbol in snapshot.SYMBOLS for side in ("calls", "puts")] + ["summary.json"])
    assert lines[-1].startswith("wrote ") and lines[-1].endswith("(complete: True)")


def test_collect_names_the_run_directory_by_the_utc_time(tmp_path: Path) -> None:
    early = datetime(2026, 11, 12, 14, 50, tzinfo=UTC)
    assert run(tmp_path, {symbol: {"stamp": early} for symbol in snapshot.SYMBOLS}, now=early)[0] == 0
    assert [path.name for path in (tmp_path / "2026-11-12").iterdir()] == ["145000Z"]


@pytest.mark.parametrize("now, stamp, reason", [
    (NOW, NOW - timedelta(minutes=46), "skipped: no SPY option trade in the last 45 minutes"),  # half day, holiday
    (NOW, NOW - timedelta(days=1), "skipped: no SPY option trade in the last 45 minutes"),
    (NOW + timedelta(minutes=50), NOW + timedelta(minutes=30), "skipped: Thu 16:20 New York is outside 09:45 to 16:00"),
    (NOW + timedelta(days=2), NOW + timedelta(days=2), "skipped: Sat 15:30 New York is outside 09:45 to 16:00"),
])
def test_collect_writes_nothing_when_the_market_is_closed(tmp_path: Path, now: datetime, stamp: datetime, reason: str) -> None:
    code, lines = run(tmp_path, {"SPY": {"stamp": stamp}}, now=now)
    assert code == 0 and list(tmp_path.iterdir()) == [] and len(lines) == 1 and lines[0].startswith(reason)


def test_collect_accepts_a_trade_45_minutes_old(tmp_path: Path) -> None:
    assert run(tmp_path, {"SPY": {"stamp": NOW - timedelta(minutes=45)}})[0] == 0
    assert summary_of(tmp_path)["probeLastTrade"] == "2026-11-12T19:45:00+00:00"


def test_collect_does_not_ask_yahoo_outside_the_session(tmp_path: Path) -> None:
    def no_ticker(symbol: str):
        raise AssertionError("no fetch outside the session")

    assert snapshot.collect(no_ticker, NOW + timedelta(hours=1), tmp_path, "fake", log=lambda *parts: None) == 0


EMPTY = SimpleNamespace(calls=Frame([]), puts=Frame([]))
NO_PUTS = SimpleNamespace(calls=Frame(rows(True)), puts=Frame([]))
NO_CALLS = SimpleNamespace(calls=Frame([]), puts=Frame(rows(False)))
MISSING = SimpleNamespace(calls=None, puts=None)


@pytest.mark.parametrize("probe, message", [
    ({"listed": ()}, "no monthly expiry"), ({"chain": EMPTY}, "empty chain"), ({"chain": MISSING}, "empty chain"),
    ({"chain": NO_PUTS}, "empty chain"), ({"chain": NO_CALLS}, "empty chain"),
    ({"stamp": None}, "no trade time"), ({"failures": 3}, "throttled"),
])
def test_a_failed_reply_for_the_probe_is_an_error_not_a_closed_market(tmp_path: Path, probe: dict, message: str) -> None:
    with pytest.raises(RuntimeError, match=message):
        run(tmp_path, {"SPY": probe})
    assert list(tmp_path.iterdir()) == []


def test_collect_tries_a_failed_reply_again(tmp_path: Path) -> None:
    code, _ = run(tmp_path, {"SPY": {"failures": 2}, "GLD": {"failures": 2}})
    assert code == 0 and summary_of(tmp_path)["complete"] is True


def test_collect_tries_a_failed_spot_price_again(tmp_path: Path) -> None:
    class Flaky(dict):
        calls = 0

        def __getitem__(self, key: str):
            Flaky.calls += 1
            if Flaky.calls < 3:
                raise ConnectionError("reset")
            return super().__getitem__(key)

    def ticker_for(symbol: str) -> Ticker:
        ticker = Ticker(symbol)
        if symbol == "QQQ":
            ticker.fast_info = Flaky(ticker.fast_info)
        return ticker

    assert snapshot.collect(ticker_for, NOW, tmp_path, "fake", log=lambda *parts: None) == 0
    assert Flaky.calls == 3 and summary_of(tmp_path)["spots"]["QQQ"] == spot_of("QQQ")


def test_a_killed_run_keeps_the_symbols_it_has_and_is_incomplete(tmp_path: Path) -> None:
    def ticker_for(symbol: str) -> Ticker:
        if symbol == "GLD":
            raise KeyboardInterrupt
        return Ticker(symbol)

    with pytest.raises(KeyboardInterrupt):
        snapshot.collect(ticker_for, NOW, tmp_path, "fake", log=lambda *parts: None)
    summary = summary_of(tmp_path)
    assert summary["complete"] is False and list(summary["symbols"]) == ["SPY", "QQQ", "DIA", "IWM"]
    assert list(summary["spots"]) == ["SPY", "QQQ", "DIA", "IWM"] and summary["errors"] == {}


@pytest.mark.parametrize("broken, error, csv_files", [
    ({"failures": 3}, "RuntimeError: throttled", 0),
    ({"listed": ()}, "RuntimeError: Yahoo listed no monthly expiry", 0),
    ({"chain": MISSING}, f"RuntimeError: Yahoo sent an empty chain for {EXPIRY}", 0),
    ({"live": False}, "1 of 1 expiries without usable quotes", 2),
    ({"spot": None}, "TypeError: float() argument must be a string or a real number, not 'NoneType'", 2),
])
def test_collect_keeps_the_other_symbols_when_one_fails(tmp_path: Path, broken: dict, error: str, csv_files: int) -> None:
    code, lines = run(tmp_path, {"GLD": broken})
    summary = summary_of(tmp_path)
    assert code == 1 and summary["complete"] is False and summary["errors"] == {"GLD": error}
    assert summary["symbols"]["GLD"] == [] and all(len(summary["symbols"][symbol]) == 1 for symbol in snapshot.SYMBOLS if symbol != "GLD")
    assert len(list((tmp_path / "2026-11-12" / "203000Z").glob("GLD-*.csv"))) == csv_files  # the raw quotes survive
    assert lines[-1].endswith("(complete: False)")


def test_collect_is_incomplete_when_one_expiry_of_a_symbol_has_no_quotes(tmp_path: Path) -> None:
    class HalfDead(Ticker):
        def option_chain(self, expiry: str):
            self.live = expiry == EXPIRY
            return super().option_chain(expiry)

    listed = (EXPIRY, "2027-01-15")
    code = snapshot.collect(lambda symbol: (HalfDead if symbol == "USO" else Ticker)(symbol, listed=listed), NOW, tmp_path, "fake",
                            log=lambda *parts: None)
    summary = summary_of(tmp_path)
    assert code == 1 and summary["errors"] == {"USO": "1 of 2 expiries without usable quotes"}
    assert [item["expiry"] for item in summary["symbols"]["USO"]] == [EXPIRY] and len(summary["symbols"]["SPY"]) == 2


def test_remeasure_computes_the_summary_again_from_the_csv_files(tmp_path: Path) -> None:
    run(tmp_path, {"GLD": {"live": False}})
    directory = tmp_path / "2026-11-12" / "203000Z"
    first = summary_of(tmp_path)
    # A summary of the first schema: no spots table, the spot only inside the items, other numbers.
    old = {key: value for key, value in first.items() if key not in ("spots", "errors")} | {"schema": 1}
    old["symbols"] = {symbol: [item | {"callSlope": 9.0}] for symbol, items in first["symbols"].items() for item in items}
    old["symbols"]["GLD"] = []
    (directory / "summary.json").write_text(json.dumps(old))
    assert snapshot.remeasure(directory, log=lambda *parts: None) == 1
    again = summary_of(tmp_path)
    assert again["remeasured"] is True and again["schema"] == 2 and again["fetchedAt"] == first["fetchedAt"]
    assert again["errors"] == {"GLD": "no spot price stored"}
    assert again["symbols"] == first["symbols"]
    assert not (directory / "summary.json.part").exists()


def test_remeasure_keeps_the_reason_of_a_symbol_it_cannot_measure(tmp_path: Path) -> None:
    run(tmp_path, {"GLD": {"live": False}, "SLV": {"failures": 3}, "USO": {"spot": None}})
    directory = tmp_path / "2026-11-12" / "203000Z"
    first = summary_of(tmp_path)
    assert snapshot.remeasure(directory, log=lambda *parts: None) == 1
    again = summary_of(tmp_path)
    # GLD has quotes without a bid and a spot in the spots table; SLV has no chain; USO has a chain but no spot.
    assert again["errors"] == {"GLD": "1 of 1 expiries without usable quotes", "SLV": "RuntimeError: throttled",
                               "USO": first["errors"]["USO"]}
    assert again["symbols"] == first["symbols"] and again["spots"] == first["spots"]
    for path in directory.glob("IWM-*.csv"):
        path.unlink()
    snapshot.remeasure(directory, log=lambda *parts: None)
    assert summary_of(tmp_path)["errors"]["IWM"] == "no chain stored" and summary_of(tmp_path)["symbols"]["IWM"] == []


def test_remeasure_needs_the_summary_of_the_run(tmp_path: Path) -> None:
    lines: list[str] = []
    assert snapshot.remeasure(tmp_path, log=lines.append) == 1
    assert lines == [f"{tmp_path} has no summary.json, so no spot prices: the run cannot be measured again"]


MODEL = {"halfSpread": {"SPY": 0.01, "USO": 0.04}, "slope": {"SPY": -0.30, "USO": -0.10}}


def _item(half_spread_pct: float, call_slope: float | None, put_slope: float | None) -> dict:
    return {"halfSpreadPct": {"atmCall": half_spread_pct, "oneSigmaCall": half_spread_pct, "put25Delta": None},
            "callSlope": call_slope, "putSlope": put_slope}


def _store(root: Path, runs: dict[str, dict[str, list[dict]]]) -> Path:
    """runs: '<day>/<run>' -> symbol -> items."""
    for key, symbols in runs.items():
        path = root / key
        path.mkdir(parents=True)
        (path / "summary.json").write_text(json.dumps({"schema": 2, "day": key.split("/")[0], "symbols": symbols}))
    return root


def test_the_report_reads_the_schema_the_snapshot_writes() -> None:
    assert calibrate.SNAPSHOT_SCHEMA == snapshot.SCHEMA


def test_day_value_is_the_mean_over_legs_and_expiries() -> None:
    value = calibrate.day_value([_item(0.4, -0.10, -0.20), _item(0.4, -0.10, -0.20), _item(1.0, -0.16, -0.35)])
    assert value == pytest.approx({"halfSpread": 0.006, "callSlope": -0.12, "putSlope": -0.25})
    assert calibrate.day_value([]) is None
    assert calibrate.day_value([_item(0.4, None, -0.20)]) is None


def test_calibrate_proposes_the_median_over_the_days(tmp_path: Path) -> None:
    days = {f"2026-11-{day:02d}/203000Z": {"SPY": [_item(spread, -0.10, -0.20)], "USO": [_item(5.0, 0.07, 0.0)]}
            for day, spread in ((11, 0.3), (12, 0.4), (13, 0.9))}
    report = calibrate.calibrate(_store(tmp_path, days), MODEL, min_days=3)
    assert report["ready"] is True and report["daysMin"] == 3 and report["skipped"] == []
    assert report["proposed"] == {"halfSpread": {"SPY": 0.004, "USO": 0.05}, "callSlope": {"SPY": -0.1, "USO": 0.07},
                                  "putSlope": {"SPY": -0.2, "USO": 0.0}}
    spy = report["symbols"]["SPY"]
    assert spy["halfSpread"] == pytest.approx({"median": 0.004, "p25": 0.0035, "p75": 0.0065})
    assert (spy["days"], spy["firstDay"], spy["lastDay"]) == (3, "2026-11-11", "2026-11-13")
    assert spy["model"] == {"halfSpread": 0.01, "slope": -0.30}
    assert "| SPY | 3 | 1.00 | 0.40 (0.35 to 0.65) | -0.30 |" in calibrate.table(report)
    assert calibrate.table(report).endswith("ready: 3 of 3 days (the symbol with the fewest days)")


def test_calibrate_is_not_ready_before_every_symbol_has_the_days(tmp_path: Path) -> None:
    days = {"2026-11-11/203000Z": {"SPY": [_item(0.3, -0.10, -0.20)], "USO": [_item(5.0, 0.07, 0.0)]},
            "2026-11-12/203000Z": {"SPY": [_item(0.5, -0.10, -0.20)], "USO": []}}
    report = calibrate.calibrate(_store(tmp_path, days), MODEL, min_days=2)
    assert report["ready"] is False and (report["daysMin"], report["daysMax"]) == (1, 2)
    assert "not ready: 1 of 2 days" in calibrate.table(report)
    empty = calibrate.calibrate(tmp_path / "missing", MODEL)
    assert empty["ready"] is False and empty["proposed"] == {"halfSpread": {}, "callSlope": {}, "putSlope": {}}
    assert "| SPY | 0 | 1.00 | no data |" in calibrate.table(empty)


def test_a_day_counts_once_with_its_latest_run_that_has_quotes(tmp_path: Path) -> None:
    days = {"2026-11-11/173000Z": {"SPY": [_item(0.2, -0.10, -0.20)], "USO": [_item(4.0, 0.07, 0.0)]},
            "2026-11-11/203000Z": {"SPY": [_item(0.6, -0.10, -0.20)], "USO": []}}
    report = calibrate.calibrate(_store(tmp_path, days), MODEL, min_days=1)
    assert report["symbols"]["SPY"]["days"] == 1 and report["proposed"]["halfSpread"] == {"SPY": 0.006, "USO": 0.04}


def test_calibrate_leaves_out_damaged_runs_and_runs_of_another_schema(tmp_path: Path) -> None:
    good = {"SPY": [_item(0.3, -0.10, -0.20)], "USO": [_item(5.0, 0.07, 0.0)]}
    store = _store(tmp_path, {f"2026-11-{day}/203000Z": good for day in (11, 12, 13, 16, 17)})
    (store / "2026-11-12/203000Z/summary.json").write_text('{"schema": 2, "day": "2026-11-12", "symb')  # cut off
    (store / "2026-11-13/203000Z/summary.json").write_text(json.dumps({"schema": 1, "day": "2026-11-13", "symbols": good}))
    (store / "2026-11-16/203000Z/summary.json").write_text(json.dumps({"schema": 2, "day": "2026-11-16"}))
    (store / "2026-11-17/203000Z/summary.json").write_text("[]")
    (store / "2026-11-18/203000Z").mkdir(parents=True)  # a run killed before its first symbol: no summary
    (store / "2026-11-19/203000Z/summary.json").mkdir(parents=True)  # not readable as a file
    _store(store, {"2026-11-20/203000Z": good})
    (store / "2026-11-20/203000Z/summary.json").write_text(json.dumps({"schema": 2, "day": 20261120, "symbols": good}))
    _store(store, {"2026-11-23/203000Z": good})
    (store / "2026-11-23/203000Z/summary.json").write_text(json.dumps({"schema": 2, "day": "yesterday", "symbols": good}))
    report = calibrate.calibrate(store, MODEL, min_days=1)
    assert report["symbols"]["SPY"]["days"] == 1 and report["ready"] is True
    reasons = [entry.split("/203000Z/summary.json: ")[1] for entry in report["skipped"]]
    assert [reason.split(":")[0] for reason in reasons] == ["JSONDecodeError", "ValueError", "KeyError", "TypeError",
                                                            "IsADirectoryError", "TypeError", "ValueError"]
    assert reasons[1] == "ValueError: schema 1, not 2" and report["skipped"][0].startswith(str(store / "2026-11-12"))
    assert calibrate.table(report).count("\nleft out: ") == 7


def test_current_model_reads_the_constants_of_the_option_model() -> None:
    model = calibrate.current_model()
    assert set(model["halfSpread"]) == set(model["slope"]) == set(snapshot.SYMBOLS)
