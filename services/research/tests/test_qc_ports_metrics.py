"""qc-ports metrics: drawdown, worst month and a deflated Sharpe that never takes a negative square root."""
import math

import pytest

from backtesting.optimizer import deflated_sharpe_ratio
from strategies.qc_ports import metrics
from strategies.qc_ports.ledger import LedgerResult


def _result(equity, dates=None):
    dates = dates or [f"2024-01-{day:02d}" for day in range(2, 2 + len(equity))]
    return LedgerResult(tuple(dates), tuple(float(v) for v in equity), (1,) * len(equity), (), (), capital=100.0)


def test_max_drawdown_and_worst_month():
    assert metrics.max_drawdown([100, 120, 90, 130, 117]) == pytest.approx(-0.25)
    assert metrics.max_drawdown([100, 101]) == 0.0
    dates = ["2024-01-30", "2024-01-31", "2024-02-28", "2024-02-29", "2024-03-01"]
    assert metrics.worst_month(dates, [101, 110, 90, 99, 100], 100.0) == ("2024-02", pytest.approx(-0.1))


def test_negative_radicand_gives_no_deflated_sharpe():
    # 1 - skew * SR + (kurt - 1) / 4 * SR^2 = 1 - 10 * 0.5 + 0.5 * 0.25 < 0
    out = metrics._deflated(0.5, 32, 0.01, 100, 10.0, 3.0)
    assert out["deflatedSharpe"] is None and out["expectedMaxSharpe"] is None
    assert metrics._deflated(0.5, 1, None, 100, 10.0, 3.0)["deflatedSharpe"] is None


def test_bad_trial_variance_gives_no_deflated_sharpe():
    assert metrics._deflated(0.05, 32, -1e-6, 100, 0.0, 3.0)["deflatedSharpe"] is None
    assert metrics._deflated(0.05, 32, math.nan, 100, 0.0, 3.0)["deflatedSharpe"] is None
    assert metrics._deflated(0.05, 32, None, 1, 0.0, 3.0)["deflatedSharpe"] is None


def test_deflated_sharpe_matches_the_optimizer():
    out = metrics._deflated(0.05, 32, 0.0002, 1000, -0.5, 6.0)
    expected = deflated_sharpe_ratio(0.05, 32, 0.0002, 1000, -0.5, 6.0)
    assert out["deflatedSharpe"] == pytest.approx(expected.probability)
    assert out["expectedMaxSharpe"] == pytest.approx(expected.expected_max_sharpe)


def test_summarize_flat_and_volatile_runs():
    flat = metrics.summarize(_result([100.0] * 5), 32, 0.0002)
    assert flat["sharpe"] is None and flat["deflatedSharpe"] is None and flat["maxDrawdown"] == 0.0
    spiky = metrics.summarize(_result([100.0, 100.0, 100.0, 100.0, 300.0]), 32, 0.0002)
    assert spiky["sharpe"] is not None
    assert spiky["deflatedSharpe"] is None or 0.0 <= spiky["deflatedSharpe"] <= 1.0
    with pytest.raises(ValueError):
        metrics.summarize(_result([100.0] * 5), 0)
