"""gs-quant 2.2.4 integration: indicator parity, the analytics adapter, the offline guard and engine parity.

These tests need gs-quant==2.2.4 (lock: requirements-gsquant-linux-py312.lock).
Without it they skip, unless VERTEX_REQUIRE_GSQUANT=1 (set by
scripts/ci/research-python.sh for the gs-quant run), where a missing package is
a failure. Every test runs with network sockets blocked and without a
GsSession: no Marquee, broker, model or network call. Synthetic data only.
"""
from __future__ import annotations

import csv
import json
import math
import os
import random
import socket
from datetime import date, timedelta
from pathlib import Path

import pytest

import indicators
from analytics import __main__ as cli
from analytics import gs_quant_backend
from analytics.gs_quant_backend import GsQuantAnalytics, GsQuantSessionActive
from analytics.report import CORE7, build_report, load_core7, render_html


def _installed() -> bool:
    if os.environ.get("VERTEX_REQUIRE_GSQUANT") == "1":
        gs_quant_backend.require()  # the gs-quant CI run fails here instead of skipping
        return True
    try:
        gs_quant_backend.require()
    except gs_quant_backend.GsQuantUnavailable:
        return False
    return True


pytestmark = [
    pytest.mark.skipif(not _installed(), reason="gs-quant==2.2.4 not installed"),
    # gs-quant and pandas emit deprecation and syntax warnings inside their own code; not ours.
    pytest.mark.filterwarnings("ignore::DeprecationWarning"),
    pytest.mark.filterwarnings("ignore::FutureWarning"),
    pytest.mark.filterwarnings("ignore::SyntaxWarning"),
]

REFERENCE = json.loads((Path(__file__).parent / "fixtures" / "indicator-reference.json").read_text())


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    def refuse(*_args, **_kwargs):
        raise AssertionError("network access attempted")

    monkeypatch.setattr(socket.socket, "connect", refuse)
    monkeypatch.setattr(socket.socket, "connect_ex", refuse)
    monkeypatch.setattr(socket, "create_connection", refuse)
    monkeypatch.setattr(socket, "getaddrinfo", refuse)


def closes(n: int = 800, seed: int = 3, step: float = 0.02) -> list[float]:
    rng = random.Random(seed)
    out = [100.0]
    for _ in range(n - 1):
        out.append(out[-1] * (1 + rng.uniform(-step, step)))
    return out


def business_days(n: int, start: date = date(2020, 1, 1)) -> list[str]:
    out, day = [], start
    while len(out) < n:
        if day.weekday() < 5:
            out.append(day.isoformat())
        day += timedelta(days=1)
    return out


def gs_series(values: list[float]):
    import pandas as pd

    return pd.Series(values, index=pd.DatetimeIndex(business_days(len(values))), dtype=float)


def worst_relative(ours, theirs, start: int = 0) -> float:
    """Largest relative difference on dates where both define a value (gs-quant results may be shorter)."""
    theirs = theirs.reindex(gs_series(list(range(1, len(ours) + 1))).index)
    worst, compared = 0.0, 0
    for index in range(start, len(ours)):
        left, right = ours[index], float(theirs.iloc[index])
        if left is None or math.isnan(right):
            continue
        worst = max(worst, abs(left - right) / max(1.0, abs(right)))
        compared += 1
    assert compared > 0
    return worst


# --- Indicator parity: Vertex indicators against gs_quant.timeseries -----------------------------


@pytest.mark.parametrize("data", [REFERENCE["bars"]["close"], closes()], ids=["ta-lib-fixture", "synthetic-800"])
def test_exact_conventions_match_gs_quant(data):
    from gs_quant.timeseries import econometrics, statistics, technicals
    from gs_quant.timeseries.helper import Window

    x = gs_series(data)
    for period in (5, 20):
        assert worst_relative(indicators.sma(data, period), technicals.moving_average(x, Window(period, 0))) < 1e-12
        assert worst_relative(indicators.zscore(data, period), statistics.zscores(x, Window(period, 0))) < 1e-9
        assert worst_relative(indicators.realized_volatility(data, period),
                              econometrics.volatility(x, Window(period, 0))) < 1e-9
    # gs-quant Bollinger Bands use the sample deviation (ddof 1); TA-Lib and Vertex use the population one.
    bands = indicators.bollinger_bands(data, 20, 2 * math.sqrt(20 / 19))
    theirs = technicals.bollinger_bands(x, Window(20, 0), 2)
    assert worst_relative(bands.lower, theirs.iloc[:, 0]) < 1e-12
    assert worst_relative(bands.upper, theirs.iloc[:, 1]) < 1e-12


def test_recursive_indicators_converge_to_gs_quant():
    """gs-quant seeds SMMA, RSI and MACD at the first bar; Vertex seeds with a full SMA (TA-Lib).

    The recursions forget the seed, so the values agree after a warm-up of many periods.
    gs-quant ``macd(x, 12, 26, 9)`` is the 9-period EMA of the MACD line (Vertex ``signal``);
    ``macd(x, 12, 26, 1)`` is the MACD line itself.
    """
    from gs_quant.timeseries import technicals
    from gs_quant.timeseries.helper import Window

    data = closes()
    x = gs_series(data)
    ours = indicators.macd(data, 12, 26, 9)
    assert worst_relative(indicators.smma(data, 14), technicals.smoothed_moving_average(x, Window(14, 0)), 300) < 1e-9
    assert worst_relative(indicators.rsi(data, 14), technicals.relative_strength_index(x, Window(14, 0)), 300) < 1e-8
    assert worst_relative(ours.macd, technicals.macd(x, 12, 26, 1), 400) < 1e-9
    assert worst_relative(ours.signal, technicals.macd(x, 12, 26, 9), 400) < 1e-9
    # Before the warm-up the seeds differ: this is a convention difference, not an error.
    assert worst_relative(indicators.rsi(data, 14), technicals.relative_strength_index(x, Window(14, 0)), 14) > 1e-3


# --- The analytics adapter -------------------------------------------------------------------------


def test_adapter_matches_vertex_kernels_and_masks_partial_windows():
    data, days = closes(400), business_days(400)
    gs = GsQuantAnalytics()
    assert gs.engine_id == "gs-quant-2.2.4"
    vol = gs.realized_volatility(days, data, 20)
    z = gs.zscore(days, data, 20)
    assert vol[:20] == [None] * 20 and z[:19] == [None] * 19
    for left, right in ((vol, indicators.realized_volatility(data, 20)), (z, indicators.zscore(data, 20))):
        for a, b in zip(left, right, strict=True):
            assert (a is None) == (b is None)
            if a is not None:
                assert math.isclose(a, b, rel_tol=1e-9, abs_tol=1e-12)


def test_adapter_beta_correlation_and_drawdown_against_brute_force():
    days = business_days(300)
    bench = closes(300, seed=5)
    # The asset is 1.5 times the benchmark return plus noise; the benchmark misses every 10th day.
    rng = random.Random(9)
    asset = [100.0]
    for index in range(1, 300):
        asset.append(asset[-1] * (1 + 1.5 * (bench[index] / bench[index - 1] - 1) + rng.uniform(-0.002, 0.002)))
    bench_days = [day for index, day in enumerate(days) if index % 10]
    bench_values = [value for index, value in enumerate(bench) if index % 10]
    gs = GsQuantAnalytics()
    beta = gs.beta(days, asset, bench_days, bench_values, 60)
    corr = gs.correlation(days, asset, bench_days, bench_values, 60)
    assert all(beta[index] is None for index in range(0, 300, 10))  # no benchmark on those days
    common = [index for index in range(300) if index % 10]
    position = {index: k for k, index in enumerate(common)}
    assert all(beta[index] is None and corr[index] is None for index in common[:60])
    for index in common[60:]:
        k = position[index]
        window = common[k - 59 : k + 1]
        ra = [asset[i] / asset[common[position[i] - 1]] - 1 for i in window]
        rb = [bench[i] / bench[common[position[i] - 1]] - 1 for i in window]
        ma, mb = sum(ra) / 60, sum(rb) / 60
        cov = sum((a - ma) * (b - mb) for a, b in zip(ra, rb)) / 59
        var_a = sum((a - ma) ** 2 for a in ra) / 59
        var_b = sum((b - mb) ** 2 for b in rb) / 59
        assert math.isclose(beta[index], cov / var_b, rel_tol=1e-8)
        assert math.isclose(corr[index], cov / math.sqrt(var_a * var_b), rel_tol=1e-8)
    assert 1.3 < beta[-1] < 1.7 and corr[-1] > 0.9

    drawdown = gs.max_drawdown(days, asset, None)
    peak, worst = asset[0], 0.0
    for index, value in enumerate(asset):
        peak = max(peak, value)
        worst = min(worst, value / peak - 1)
        assert math.isclose(drawdown[index], worst, abs_tol=1e-12)
    window = gs.max_drawdown(days, asset, 20)
    assert window[:19] == [None] * 19
    # gs-quant convention: lowest close / (highest close of the 20 bars up to it) - 1 over the last 20 bars.
    falls = [asset[i] / max(asset[max(0, i - 19) : i + 1]) - 1 for i in range(300)]
    for index in range(19, 300):
        assert math.isclose(window[index], min(falls[index - 19 : index + 1]), abs_tol=1e-12)


def test_adapter_exponential_volatility_matches_gs_quant_daily():
    from gs_quant.timeseries import technicals

    data, days = closes(300), business_days(300)
    ours = GsQuantAnalytics().exponential_volatility(days, data, 0.94)
    theirs = technicals.exponential_volatility(gs_series(data), 0.94)
    assert ours[:2] == [None, None]
    assert worst_relative(ours, theirs, 2) < 1e-12


def test_adapter_short_and_flat_series():
    gs = GsQuantAnalytics()
    for n in range(0, 21):
        days, data = business_days(n), closes(n) if n else []
        assert gs.realized_volatility(days, data, 20) == [None] * n
        assert gs.zscore(days, data, 21) == [None] * n
        assert gs.max_drawdown(days, data, 21) == [None] * n
        assert gs.beta(days, data, days, data, 20) == [None] * n
        if n < 3:
            assert gs.exponential_volatility(days, data, 0.94) == [None] * n
    # A flat window after a volatile stretch: gs-quant returns rounding noise; the adapter returns None.
    data = closes(80, step=0.2)[:40] + [123.456] * 40
    z = gs.zscore(business_days(80), data, 20)
    assert all(value is None for value in z[59:]) and all(value is not None for value in z[19:40])
    # Weekly spacing: the factor is fixed at 252 per bar, so no inference error.
    weekly = [(date(2020, 1, 3) + timedelta(days=7 * i)).isoformat() for i in range(30)]
    assert gs.realized_volatility(weekly, closes(30), 10)[-1] > 0


@pytest.mark.parametrize(
    ("call", "message"),
    [
        (lambda gs: gs.realized_volatility(["2020-01-02", "2020-01-01"], [1.0, 2.0], 2), "strictly increasing"),
        (lambda gs: gs.realized_volatility(["2020-01-01", "2020-01-02"], [1.0, -2.0], 2), "positive"),
        (lambda gs: gs.zscore(["2020-01-01"], [1.0, 2.0], 2), "one value per date"),
        (lambda gs: gs.zscore(["2020-01-01", "2020-01-02"], [1.0, 2.0], 1), "window"),
        (lambda gs: gs.exponential_volatility(["2020-01-01", "2020-01-02"], [1.0, 2.0], 1.0), "beta"),
    ],
)
def test_adapter_rejects_bad_input(call, message):
    with pytest.raises(ValueError, match=message):
        call(GsQuantAnalytics())


def test_adapter_refuses_to_run_with_a_marquee_session():
    import contextvars

    from gs_quant.session import GsSession

    def with_session():
        # A placeholder object stands in for a session; nothing connects. The copied
        # context keeps the setting out of every other test.
        GsSession.current = object()
        assert GsSession.current_is_set
        with pytest.raises(GsQuantSessionActive):
            GsQuantAnalytics().zscore(business_days(5), [1.0, 2.0, 3.0, 4.0, 5.0], 2)

    contextvars.copy_context().run(with_session)
    assert not GsSession.current_is_set


def test_report_cli_end_to_end(tmp_path):
    data_dir = tmp_path / "daily"
    data_dir.mkdir()
    days = business_days(320)
    for seed, (_, future, twin) in enumerate(CORE7):
        for offset, symbol in enumerate((future, twin)):
            with (data_dir / f"{symbol}.csv").open("w", newline="") as handle:
                writer = csv.writer(handle)
                writer.writerow(["date", "open", "high", "low", "close", "adj_close", "volume"])
                for day, value in zip(days, closes(320, seed=seed * 2 + offset)):
                    writer.writerow([day, value, value, value, value, value, 1000])
    out, js = tmp_path / "core7.html", tmp_path / "core7.json"
    assert cli.main(["report", "--data", str(data_dir), "--out", str(out), "--json", str(js)]) == 0
    report = json.loads(js.read_text())
    assert report["engine"] == "gs-quant-2.2.4" and report["missing"] == []
    for market in report["markets"]:
        for kind in ("future", "etf"):
            row = market[kind]
            assert row["vol20"] > 0 and row["vol60"] > 0 and row["ewvol"] > 0 and row["ddall"] <= 0
    assert report["markets"][0]["future"]["beta60"] is None  # ES=F is the futures benchmark
    assert report["markets"][1]["future"]["beta60"] is not None
    page = out.read_text()
    assert all(symbol in page for _, future, twin in CORE7 for symbol in (future, twin))
    assert "<script" not in page and "http" not in page.split("</title>")[1]
    assert build_report(load_core7(data_dir), GsQuantAnalytics())["markets"] == report["markets"]
    assert render_html(report) == page


# --- Backtest engine parity: gs-quant PredefinedAssetEngine against the Quant Lab engine ------------


def test_predefined_asset_engine_matches_quant_lab_engine():
    """Same SMA timing decisions, all-in at the next close, no costs, no cash interest.

    The gs-quant engine runs offline on supplied prices. It gives the same equity
    curve and trade count as quantlab.engine.simulate, so it adds no new
    behavior for daily single-instrument timing; see docs/vertex-rebuild/gs-quant.md.
    """
    import pandas as pd
    from gs_quant.backtests.core import ValuationFixingType
    from gs_quant.backtests.data_sources import DataManager
    from gs_quant.backtests.order import OrderMarketOnClose
    from gs_quant.backtests.predefined_asset_engine import PredefinedAssetEngine
    from gs_quant.backtests.strategy import Strategy
    from gs_quant.backtests.triggers import OrdersGeneratorTrigger
    from gs_quant.data.core import DataFrequency
    from gs_quant.instrument import EqStock
    from quantlab import data, engine

    prices = closes(600, seed=11, step=0.015)
    days = business_days(600, date(2001, 1, 2))
    bars = [data.Bar(day, price, price, price) for day, price in zip(days, prices)]
    dates = [date.fromisoformat(day) for day in days]
    decisions = engine.signals(bars, "price_above_sma", 50, "days")
    asset = EqStock("QLAB", name="QLAB")

    class Timing(OrdersGeneratorTrigger):
        def __init__(self):
            super().__init__()
            self.units = 0.0

        def get_trigger_times(self):
            return [pd.Timestamp("16:00").time()]

        def generate_orders(self, state, backtest=None):
            day = state.date()
            index = dates.index(day)
            if index == 0 or decisions[index - 1] is None:
                return []
            want = bool(decisions[index - 1])
            if want and self.units == 0:
                units = backtest.holdings[backtest.cash_asset] / prices[index]
            elif not want and self.units > 0:
                units = -self.units
            else:
                return []
            self.units += units
            return [OrderMarketOnClose(asset, units, state, day, "timing")]

    manager = DataManager()
    manager.add_data_source(pd.Series(prices, index=dates), DataFrequency.DAILY, asset, ValuationFixingType.PRICE)
    result = PredefinedAssetEngine(data_mgr=manager).run_backtest(Strategy(None, triggers=[Timing()]),
                                                                  start=dates[0], end=dates[-1])
    run = engine.simulate(bars, [0.0] * len(bars), signal_type="price_above_sma", lookback=50, unit="days",
                          rebalance="daily", execution="next_close", weight=1.0, costs=engine.Costs(0, 0, 0))
    equity = 100.0
    for day, daily in zip(dates, run.returns):
        equity *= 1 + daily
        assert math.isclose(result.performance[day], equity, rel_tol=1e-12)
    assert len(result.trade_ledger()) == len(run.trades) > 5
