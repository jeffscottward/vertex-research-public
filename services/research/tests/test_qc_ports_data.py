"""qc-ports data loading on small CSV fixtures written to a temp dir (no network, no real data)."""
import pytest

from strategies.qc_ports import data


def _write(root, name, text):
    (root / name).write_text(text)


@pytest.fixture
def root(tmp_path):
    _write(tmp_path, "SPY.csv", "date,open,high,low,close,adj_close\n"
           "2024-01-02,100,101,99,100.5,99.0\n2024-01-03,100,101,99,,99\n2024-01-04,101,102,100,101.5,\n"
           "2024-01-05,101,102,100,102,101\n2024-01-08,101,102,100,103,102\n")
    _write(tmp_path, "VIX.csv", "date,close\n2024-01-02,13.0\n2024-01-04,14.0\n")
    _write(tmp_path, "IRX.csv", "date,close\n2024-01-01,5.0\n2024-01-05,4.0\n2024-01-08,nan\n")
    _write(tmp_path, "TNX.csv", "date,close\n2024-01-02,4.0\n2024-01-03,0\n1871-02-01,3.0\n")
    _write(tmp_path, "SHILLER.csv", "month,price,earnings\n2023-07,4000,200\n2023-09,0,1\n2023-08,x,1\n")
    return tmp_path


def test_load_bars_drops_rows_with_a_missing_column(root):
    bars = data.load_bars("SPY", root)
    # 2024-01-03 has no close and 2024-01-04 no adj_close: both rows are dropped, never filled.
    assert bars.dates == ("2024-01-02", "2024-01-05", "2024-01-08")
    assert len(bars) == 3
    assert bars.adj_close == (99.0, 101.0, 102.0)
    assert bars.open[0] == 100.0


def test_load_bars_requires_increasing_dates(tmp_path):
    _write(tmp_path, "QQQ.csv", "date,open,high,low,close,adj_close\n2024-01-03,1,1,1,1,1\n2024-01-02,1,1,1,1,1\n")
    with pytest.raises(ValueError, match="increasing"):
        data.load_bars("QQQ", tmp_path)


def test_series_and_derived_ratio(root):
    assert data.load_series("IRX", root) == {"2024-01-01": 5.0, "2024-01-05": 4.0}
    # Jan 2024 uses the Shiller month 6 months back (2023-07): 100 * 200 / 4000 / 4.0 = 1.25
    assert data.load_series("EY_TNX_RATIO", root) == {"2024-01-02": 1.25}
    assert data.load_shiller(root) == {"2023-07": (4000.0, 200.0)}
    context = data.load_context(("VIX", "IRX"), root)
    assert set(context) == {"VIX", "IRX"}
    with pytest.raises(ValueError, match="Unknown series"):
        data.load_context(("FOO",), root)


def test_align_carries_at_most_max_fill_days():
    dates = [f"2024-01-{day:02d}" for day in range(1, 11)]
    series = {"2024-01-02": 1.0, "2024-01-09": 2.0, "2023-12-29": 0.5}
    assert data.align(series, dates, max_fill=5) == [0.5, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, None, 2.0, 2.0]
    assert data.align(series, dates, max_fill=0) == [0.5, 1.0, None, None, None, None, None, None, 2.0, None]
    assert data.align({}, dates) == [None] * 10
    with pytest.raises(ValueError):
        data.align(series, dates, max_fill=-1)


def test_load_market(root, monkeypatch):
    monkeypatch.setenv(data.DATA_ENV, str(root))
    market = data.load_market("SPY")
    assert market.dates == ("2024-01-02", "2024-01-05", "2024-01-08")
    assert market.iv_index == (13.0, 14.0, 14.0)
    assert market.rate == (0.05, 0.04, 0.04)
    assert len(market) == 3
    assert data.data_root() == root
    monkeypatch.delenv(data.DATA_ENV)
    assert data.data_root() == data.DEFAULT_ROOT
    with pytest.raises(ValueError, match="No IV index"):
        data.load_market("TLT", root)


def test_market_validation():
    with pytest.raises(ValueError, match="same length"):
        data.Market("SPY", ("2024-01-02",), (1.0, 2.0), (None,), (None,))
    with pytest.raises(ValueError, match="increasing"):
        data.Market("SPY", ("2024-01-03", "2024-01-02"), (1.0, 2.0), (None, None), (None, None))


@pytest.mark.parametrize("column, value", [
    ("close", float("nan")), ("close", 0.0), ("iv_index", float("inf")), ("iv_index", -1.0),
    ("rate", float("nan")), ("rate", -0.01),
])
def test_market_refuses_bad_values(column, value):
    good = {"close": (100.0, 101.0), "iv_index": (20.0, None), "rate": (0.05, None)}
    data.Market("SPY", ("2024-01-02", "2024-01-03"), **good)
    bad = {**good, column: (value, good[column][1])}
    with pytest.raises(ValueError):
        data.Market("SPY", ("2024-01-02", "2024-01-03"), **bad)
