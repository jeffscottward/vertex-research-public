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
SPOT, ATM_IV = 100.0, 0.20
SIGMA = SPOT * ATM_IV * math.sqrt(36 / 365)


def rows(slope: float, pct: float, strikes=range(80, 121), stamp: datetime = NOW - timedelta(minutes=16)) -> list:
    """Quotes on a linear smile IV = ATM * (1 + slope * x) with half-spread `pct` percent of the mid."""
    out = []
    for strike in strikes:
        x = math.log(strike / SPOT) / (ATM_IV * math.sqrt(36 / 365))
        mid = 5.0
        out.append(SimpleNamespace(strike=float(strike), bid=mid * (1 - pct / 100), ask=mid * (1 + pct / 100),
                                   impliedVolatility=ATM_IV * (1 + slope * x), lastTradeDate=stamp))
    return out


class Frame:
    """The three DataFrame calls the collector makes, over a list of rows."""

    def __init__(self, data: list) -> None:
        self.data = data

    def __getitem__(self, column: str):
        values = [getattr(row, column) for row in self.data]
        return SimpleNamespace(dropna=lambda: SimpleNamespace(tolist=lambda: [value for value in values if value is not None]))

    def itertuples(self):
        return iter(self.data)

    def to_csv(self, path: Path, index: bool) -> None:
        Path(path).write_text("strike,bid,ask\n" + "".join(f"{row.strike},{row.bid},{row.ask}\n" for row in self.data))


class Ticker:
    def __init__(self, symbol: str, stamp: datetime, fail: bool = False,
                 listed: tuple = ("2026-11-20", EXPIRY, "2026-12-24", "2027-03-19")) -> None:
        self.symbol, self.stamp, self.fail, self.listed = symbol, stamp, fail, listed
        self.fast_info = {"last_price": SPOT}

    @property
    def options(self):
        if self.fail:
            raise RuntimeError("throttled")
        return self.listed

    def option_chain(self, expiry: str):
        return SimpleNamespace(calls=Frame(rows(-0.1, 0.5, stamp=self.stamp)), puts=Frame(rows(-0.2, 1.5, stamp=self.stamp)))


def test_measure_recovers_the_half_spread_and_the_wing_slopes() -> None:
    item = snapshot.measure(rows(-0.1, 0.5), rows(-0.2, 1.5), SPOT, EXPIRY, TODAY)
    assert item["dte"] == 36 and item["atmIv"] == pytest.approx(ATM_IV)
    assert item["callSlope"] == pytest.approx(-0.1) and item["putSlope"] == pytest.approx(-0.2)
    assert item["halfSpreadPct"]["atmCall"] == pytest.approx(0.5)
    assert item["halfSpreadPct"]["oneSigmaCall"] == pytest.approx(0.5)
    assert item["halfSpreadPct"]["put25Delta"] == pytest.approx(1.5)
    assert item["halfSpreadPct"]["putFurtherOut"] == pytest.approx(1.5)
    # The one-sigma call is the strike nearest to spot + sigma: about 106.
    assert item["ivRatioOneSigmaCall"] == pytest.approx(1 - 0.1 * math.log(106 / SPOT) / (ATM_IV * math.sqrt(36 / 365)))
    assert item["usableQuotes"] == {"calls": 41, "puts": 41}


def test_measure_ignores_quotes_without_a_bid_or_with_a_crossed_market() -> None:
    dead = [SimpleNamespace(strike=100.0, bid=0.0, ask=1.0, impliedVolatility=0.2),
            SimpleNamespace(strike=101.0, bid=2.0, ask=2.0, impliedVolatility=0.2),
            SimpleNamespace(strike=102.0, bid=1.0, ask=1.2, impliedVolatility=float("nan"))]
    assert snapshot.measure(dead, rows(-0.2, 1.5), SPOT, EXPIRY, TODAY) is None
    item = snapshot.measure(rows(-0.1, 0.5) + dead, rows(-0.2, 1.5), SPOT, EXPIRY, TODAY)
    assert item["usableQuotes"]["calls"] == 41


def test_monthly_expiries_keeps_third_fridays_30_to_75_days_out() -> None:
    listed = ("2026-11-20", "2026-12-11", "2026-12-18", "2026-12-24", "2027-01-15", "2027-02-19")
    assert snapshot.monthly_expiries(listed, TODAY) == ["2026-12-18", "2027-01-15"]


@pytest.mark.parametrize("age_minutes, live", [(0, True), (16, True), (45, True), (46, False), (150, False), (-1, False)])
def test_market_trades_needs_a_recent_option_trade(age_minutes: int, live: bool) -> None:
    assert snapshot.market_trades(NOW - timedelta(minutes=age_minutes), NOW) is live
    assert snapshot.market_trades(None, NOW) is False


def test_collect_writes_one_run_directory_with_all_symbols(tmp_path: Path) -> None:
    lines: list[str] = []
    code = snapshot.collect(lambda symbol: Ticker(symbol, NOW - timedelta(minutes=16)), NOW, tmp_path, "fake",
                            log=lambda *parts: lines.append(" ".join(map(str, parts))))
    run = tmp_path / "2026-11-12" / "203000Z"
    summary = json.loads((run / "summary.json").read_text())
    assert code == 0 and summary["complete"] is True and summary["day"] == "2026-11-12" and summary["schema"] == 1
    assert summary["fetchedAt"] == "2026-11-12T20:30:00+00:00" and summary["probeLastTrade"] == "2026-11-12T20:14:00+00:00"
    assert list(summary["symbols"]) == list(snapshot.SYMBOLS)
    assert all(len(items) == 1 and items[0]["expiry"] == EXPIRY for items in summary["symbols"].values())
    assert sorted(path.name for path in run.glob("SPY-*.csv")) == [f"SPY-{EXPIRY}-calls.csv", f"SPY-{EXPIRY}-puts.csv"]
    assert len(list(run.glob("*.csv"))) == 14 and lines[-1].startswith("wrote ")


def test_collect_uses_the_new_york_day_for_the_directory(tmp_path: Path) -> None:
    late = datetime(2026, 11, 13, 0, 30, tzinfo=UTC)  # still Thursday evening in New York
    snapshot.collect(lambda symbol: Ticker(symbol, late - timedelta(minutes=1)), late, tmp_path, "fake", log=lambda *parts: None)
    assert [path.name for path in tmp_path.iterdir()] == ["2026-11-12"]


@pytest.mark.parametrize("stamp", [NOW - timedelta(hours=3), NOW - timedelta(days=1), None])
def test_collect_writes_nothing_when_the_market_is_closed(tmp_path: Path, stamp: datetime | None) -> None:
    lines: list[str] = []
    code = snapshot.collect(lambda symbol: Ticker(symbol, stamp), NOW, tmp_path, "fake", log=lambda *parts: lines.append(str(parts[0])))
    assert code == 0 and list(tmp_path.iterdir()) == [] and lines[0].startswith("skipped: ")


def test_collect_keeps_the_other_symbols_when_one_fails(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(snapshot.time, "sleep", lambda seconds: None)
    code = snapshot.collect(lambda symbol: Ticker(symbol, NOW - timedelta(minutes=16), fail=symbol == "USO"), NOW, tmp_path,
                            "fake", log=lambda *parts: None)
    summary = json.loads((tmp_path / "2026-11-12" / "203000Z" / "summary.json").read_text())
    assert code == 1 and summary["complete"] is False
    assert summary["symbols"]["USO"] == [] and len(summary["symbols"]["SLV"]) == 1



def test_collect_fails_when_yahoo_lists_no_expiry(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """An empty reply for the probe is a failure (exit by exception), never a silent "market closed"."""
    monkeypatch.setattr(snapshot.time, "sleep", lambda seconds: None)
    with pytest.raises(RuntimeError, match="no monthly expiry"):
        snapshot.collect(lambda symbol: Ticker(symbol, NOW, listed=()), NOW, tmp_path, "fake", log=lambda *parts: None)
    assert list(tmp_path.iterdir()) == []
    fresh = NOW - timedelta(minutes=16)
    code = snapshot.collect(lambda symbol: Ticker(symbol, fresh, listed=() if symbol == "GLD" else ("2026-12-18",)), NOW,
                            tmp_path, "fake", log=lambda *parts: None)
    summary = json.loads((tmp_path / "2026-11-12" / "203000Z" / "summary.json").read_text())
    assert code == 1 and summary["symbols"]["GLD"] == [] and len(summary["symbols"]["SPY"]) == 1

MODEL = {"halfSpread": {"SPY": 0.01, "USO": 0.04}, "slope": {"SPY": -0.30, "USO": -0.10}}


def _item(half_spread_pct: float, call_slope: float | None, put_slope: float | None) -> dict:
    return {"halfSpreadPct": {"atmCall": half_spread_pct, "oneSigmaCall": half_spread_pct, "put25Delta": None},
            "callSlope": call_slope, "putSlope": put_slope}


def _store(root: Path, runs: dict[str, dict[str, list[dict]]]) -> Path:
    """runs: '<day>/<run>' -> symbol -> items."""
    for key, symbols in runs.items():
        path = root / key
        path.mkdir(parents=True)
        (path / "summary.json").write_text(json.dumps({"day": key.split("/")[0], "symbols": symbols}))
    return root


def test_day_value_is_the_mean_over_legs_and_expiries() -> None:
    value = calibrate.day_value([_item(0.4, -0.10, -0.20), _item(0.8, -0.14, -0.30)])
    assert value == pytest.approx({"halfSpread": 0.006, "callSlope": -0.12, "putSlope": -0.25})
    assert calibrate.day_value([]) is None
    assert calibrate.day_value([_item(0.4, None, -0.20)]) is None


def test_calibrate_proposes_the_median_over_the_days(tmp_path: Path) -> None:
    days = {f"2026-11-{day:02d}/203000Z": {"SPY": [_item(spread, -0.10, -0.20)], "USO": [_item(5.0, 0.07, 0.0)]}
            for day, spread in ((11, 0.3), (12, 0.4), (13, 0.9))}
    report = calibrate.calibrate(_store(tmp_path, days), MODEL, min_days=3)
    assert report["ready"] is True and report["daysMin"] == 3
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


def test_current_model_reads_the_constants_of_the_option_model() -> None:
    model = calibrate.current_model()
    assert set(model["halfSpread"]) == set(model["slope"]) == set(snapshot.SYMBOLS)
